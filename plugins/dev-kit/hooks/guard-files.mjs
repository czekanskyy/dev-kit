#!/usr/bin/env node
// PreToolUse hook for file tools: secrets, generated files, merged migrations, Claude config.

import fs from 'node:fs';
import path from 'node:path';
import {
  anyGlob,
  defaultExec,
  findRepoRoot,
  globMatch,
  isInside,
  isSecretPath,
  loadConfig,
  normalizePath,
  relativeTo,
  toAbsolute,
} from '../scripts/lib/config.mjs';
import { combineVerdicts, emitPreToolUse, isMain, readHookInput } from '../scripts/lib/hook.mjs';

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const CLAUDE_CONFIG_GLOBS = ['.claude/settings.json', '.claude/settings.local.json', '.claude/workflow.json', '.claude/hooks/**'];

const SECRET_SAMPLES = ['.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519', 'server.pem', 'server.key'];

/** True when a search glob could select a secret file: tested against sample secret names. */
export function globCanMatchSecret(glob, dir, config, root) {
  const names = [...SECRET_SAMPLES];
  for (const g of config.guard?.secrets ?? []) {
    const last = String(g).split('/').pop();
    if (last && !/[*?{[]/.test(last)) names.push(last);
  }
  const paths = names.flatMap((n) => [`${dir}/${n}`, `${dir}/sub/${n}`]);
  // Concrete examples of the configured secret globs themselves, e.g. config/credentials.json.
  for (const g of config.guard?.secrets ?? []) {
    if (String(g).startsWith('~')) continue;
    const concrete = String(g)
      .replace(/\*\*\//g, '')
      .replace(/\{([^,}]*)[^}]*\}/g, '$1')
      .replace(/[*?]/g, 'x');
    paths.push(`${root}/${concrete}`);
  }
  for (const p of paths) {
    if (globMatch(glob, p, { root: dir }) && isSecretPath(p, config, { cwd: dir, root })) return true;
  }
  return false;
}

function regenerateHint(config) {
  const keys = Object.keys(config.commands ?? {}).filter((k) => /gen|codegen|types/i.test(k) && config.commands[k]);
  if (keys.length) return keys.map((k) => `\`${config.commands[k]}\` (commands.${k})`).join(' or ');
  return "the project's generator command";
}

/**
 * Evaluates one file tool call. opts: { config, exec, env, pluginRoot }.
 * Returns null or {decision, reason}.
 */
export function evaluateFileTool(input, opts = {}) {
  const tool = input?.tool_name;
  if (!READ_TOOLS.has(tool) && !EDIT_TOOLS.has(tool)) return null;
  const ti = input.tool_input ?? {};
  const cwd = normalizePath(path.resolve(input.cwd || process.cwd()));
  const config = opts.config ?? loadConfig(cwd);
  const exec = opts.exec ?? defaultExec;
  const env = opts.env ?? process.env;
  const root = normalizePath(config.repoRoot ?? findRepoRoot(cwd) ?? cwd);
  const out = [];

  if (READ_TOOLS.has(tool)) {
    const candidates = [];
    if (ti.file_path) candidates.push(ti.file_path);
    if (ti.path) candidates.push(ti.path);
    const basePath = ti.path ? toAbsolute(ti.path, cwd) : cwd;
    if (tool === 'Glob' && ti.pattern) candidates.push(`${basePath}/${ti.pattern}`);
    if (tool === 'Grep' && ti.glob) candidates.push(`${basePath}/${ti.glob}`);
    for (const c of candidates) {
      if (isSecretPath(c, config, { cwd, root })) {
        out.push({
          decision: 'deny',
          reason: `${tool} of secret file "${c}" refused. Ask the user for the specific non-secret value you need, or read the example file (.env.example) instead.`,
        });
        break;
      }
    }
    if (tool === 'Grep' && !out.length) {
      let isDir = false;
      try {
        isDir = fs.statSync(basePath).isDirectory();
      } catch {
        isDir = false;
      }
      if (isDir && (ti.hidden === true || (ti.glob && globCanMatchSecret(ti.glob, basePath, config, root)))) {
        out.push({
          decision: 'ask',
          reason: `Grep over the directory "${ti.path ?? '.'}" ${ti.hidden === true ? 'includes hidden files' : `with glob "${ti.glob}"`}, which can reach secret files such as .env. Narrow the search, or confirm.`,
        });
      }
    }
    return combineVerdicts(out);
  }

  const target = ti.file_path ?? ti.notebook_path;
  if (!target) return null;
  const abs = toAbsolute(target, cwd);
  const globOpts = { root };
  const guard = config.guard ?? {};

  if (anyGlob(guard.generated, abs, globOpts)) {
    out.push({
      decision: 'deny',
      reason: `"${target}" is a generated file and is never edited by hand. Change its source and regenerate with ${regenerateHint(config)}.`,
    });
  }

  if (tool !== 'NotebookEdit' && anyGlob(guard.immutableOnceMerged, abs, globOpts) && fs.existsSync(abs) && isInside(abs, root)) {
    const br = config.branches ?? {};
    const remote = br.remote || 'origin';
    const refs = [br.integration, ...(br.protected ?? [])].filter(Boolean).map((b) => `${remote}/${b}`);
    const rel = relativeTo(abs, root);
    for (const ref of refs) {
      let exists = false;
      try {
        exec('git', ['cat-file', '-e', `${ref}:${rel}`], { cwd: root, timeout: 10000 });
        exists = true;
      } catch {
        exists = false;
      }
      if (exists) {
        out.push({
          decision: 'deny',
          reason: `"${rel}" is already merged on ${ref} and must not change. Add a new migration instead.`,
        });
        break;
      }
    }
  }

  const pluginRoot = opts.pluginRoot ?? env.CLAUDE_PLUGIN_ROOT;
  const isClaudeConfig =
    anyGlob(CLAUDE_CONFIG_GLOBS, abs, globOpts) ||
    anyGlob(CLAUDE_CONFIG_GLOBS.map((g) => `**/${g}`), abs, globOpts) ||
    (pluginRoot && isInside(abs, toAbsolute(pluginRoot, cwd)));
  if (isClaudeConfig) {
    out.push({
      decision: 'ask',
      reason: `"${target}" is Claude Code configuration, a hook or part of the dev-kit plugin. Confirm this change.`,
    });
  }
  return combineVerdicts(out);
}

if (isMain(import.meta.url)) {
  try {
    const v = evaluateFileTool(readHookInput());
    if (v) emitPreToolUse(v.decision, v.reason);
  } catch {
    // Never block on an internal error.
  }
  process.exit(0);
}
