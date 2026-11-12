#!/usr/bin/env node
// Classifies a diff against the project's risk paths.
// Usage: node risk.mjs [--base <ref>] [--pr <n>] [--json]

import fs from 'node:fs';
import path from 'node:path';
import {
  anyGlob,
  defaultBaseRef,
  defaultExec,
  findRepoRoot,
  gitTry,
  loadConfig,
  normalizePath,
} from './lib/config.mjs';
import { isMain } from './lib/hook.mjs';

const MAX_UNTRACKED_BYTES = 1024 * 1024;

/** Parses a unified diff into Map<file, [{line, text}]> of added lines. */
export function parseAddedLines(diffText) {
  const added = new Map();
  let file = null;
  let line = 0;
  for (const raw of String(diffText ?? '').split(/\r?\n/)) {
    if (raw.startsWith('+++ ')) {
      let p = raw.slice(4).trim();
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (file && !added.has(file)) added.set(file, []);
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('diff --git')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('+')) {
      added.get(file).push({ line, text: raw.slice(1) });
      line++;
    } else if (raw.startsWith(' ')) {
      line++;
    }
  }
  return added;
}

function compilePatterns(list) {
  const out = [];
  for (const p of list ?? []) {
    try {
      out.push({ source: p, re: new RegExp(p) });
    } catch {
      // An invalid pattern in the project config is ignored rather than crashing the check.
    }
  }
  return out;
}

/**
 * Pure classification of a list of files and their added lines.
 * opts: { config, files, added (Map), repoRoot, baseRef, exec }
 * baseRef enables immutableEdited (files matching guard.immutableOnceMerged that exist at baseRef).
 */
export function analyzeFiles({ config, files, added = new Map(), repoRoot, baseRef, exec = defaultExec }) {
  const root = repoRoot ?? config?.repoRoot ?? process.cwd();
  const globOpts = { root };
  const list = [...new Set((files ?? []).map(normalizePath))];
  const riskGlobs = config?.riskPaths?.globs ?? [];
  const patterns = compilePatterns(config?.riskPaths?.contentPatterns);
  const riskFiles = list.filter((f) => anyGlob(riskGlobs, f, globOpts));
  const contentHits = [];
  for (const [file, lines] of added) {
    for (const { line, text } of lines) {
      for (const p of patterns) {
        if (p.re.test(text)) contentHits.push({ file: normalizePath(file), line, pattern: p.source });
      }
    }
  }
  const generatedTouched = list.filter((f) => anyGlob(config?.guard?.generated, f, globOpts));
  const immutable = list.filter((f) => anyGlob(config?.guard?.immutableOnceMerged, f, globOpts));
  const immutableEdited = baseRef
    ? immutable.filter((f) => gitTry(['cat-file', '-e', `${baseRef}:${f}`], { cwd: root, exec }) !== null)
    : [];
  return {
    files: list,
    riskFiles,
    contentHits,
    touchesRisk: riskFiles.length > 0 || contentHits.length > 0,
    generatedTouched,
    immutableEdited,
  };
}

function untrackedAdded(root, files) {
  const added = new Map();
  for (const f of files) {
    try {
      const abs = path.join(root, f);
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX_UNTRACKED_BYTES) continue;
      const text = fs.readFileSync(abs, 'utf8');
      if (text.includes('\0')) continue;
      added.set(f, text.split(/\r?\n/).map((t, k) => ({ line: k + 1, text: t })));
    } catch {
      // unreadable file: skip
    }
  }
  return added;
}

/**
 * Full analysis for the CLI and for guard-bash.
 * opts: { cwd, config, base, pr, repo, prFiles, exec }
 * With pr: files from `gh pr view` (or prFiles when already known), content from `gh pr diff`.
 */
export function analyzeRisk(opts = {}) {
  const exec = opts.exec ?? defaultExec;
  const cwd = opts.cwd ?? process.cwd();
  const config = opts.config ?? loadConfig(cwd);
  const root = config.repoRoot ?? findRepoRoot(cwd) ?? cwd;
  const remote = config.branches?.remote || 'origin';

  if (opts.pr !== undefined && opts.pr !== null) {
    const repoArgs = opts.repo ? ['--repo', opts.repo] : [];
    let files = opts.prFiles;
    let baseRef = opts.baseRefName ? `${remote}/${opts.baseRefName}` : null;
    if (!files) {
      const view = JSON.parse(
        exec('gh', ['pr', 'view', String(opts.pr), '--json', 'files,baseRefName', ...repoArgs], { cwd: root, timeout: 20000 }),
      );
      files = (view.files ?? []).map((f) => f.path);
      baseRef = `${remote}/${view.baseRefName}`;
    }
    let added = new Map();
    try {
      added = parseAddedLines(exec('gh', ['pr', 'diff', String(opts.pr), ...repoArgs], { cwd: root, timeout: 20000 }));
    } catch {
      // Content patterns are skipped when the diff cannot be fetched.
    }
    return { base: baseRef, ...analyzeFiles({ config, files, added, repoRoot: root, baseRef, exec }) };
  }

  const base = opts.base ?? defaultBaseRef(config);
  const mb = gitTry(['merge-base', base, 'HEAD'], { cwd: root, exec });
  if (!mb) throw new Error(`cannot find a merge base between ${base} and HEAD (fetch the remote, or pass --base)`);
  const mergeBase = mb.trim();
  const tracked = (gitTry(['diff', '--name-only', '--no-renames', '-z', mergeBase], { cwd: root, exec }) ?? '')
    .split('\0')
    .filter(Boolean);
  const untracked = (gitTry(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, exec }) ?? '')
    .split('\0')
    .filter(Boolean);
  const diff = gitTry(['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', mergeBase], { cwd: root, exec }) ?? '';
  const added = parseAddedLines(diff);
  for (const [f, lines] of untrackedAdded(root, untracked)) added.set(f, lines);
  return {
    base,
    mergeBase,
    ...analyzeFiles({ config, files: [...tracked, ...untracked], added, repoRoot: root, baseRef: mergeBase, exec }),
  };
}

function parseArgs(argv) {
  const out = { json: false };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--json') out.json = true;
    else if (a === '--base') out.base = argv[++k];
    else if (a === '--pr') out.pr = argv[++k];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (args.help) {
    console.log('Usage: node risk.mjs [--base <ref>] [--pr <n>] [--json]');
    return;
  }
  let result;
  try {
    result = analyzeRisk({ cwd: process.cwd(), base: args.base, pr: args.pr });
  } catch (err) {
    console.error(`risk: ${err.message}`);
    process.exit(2);
  }
  const { files, ...rest } = result;
  if (args.json) {
    console.log(JSON.stringify(rest, null, 2));
    return;
  }
  console.log(`Base: ${result.base} (${files.length} changed files)`);
  console.log(`Touches risk: ${result.touchesRisk ? 'YES' : 'no'}`);
  for (const f of result.riskFiles) console.log(`  risk path: ${f}`);
  for (const h of result.contentHits) console.log(`  content: ${h.file}:${h.line} matches /${h.pattern}/`);
  for (const f of result.generatedTouched) console.log(`  generated file touched: ${f}`);
  for (const f of result.immutableEdited) console.log(`  immutable file edited: ${f}`);
}

if (isMain(import.meta.url)) main();
