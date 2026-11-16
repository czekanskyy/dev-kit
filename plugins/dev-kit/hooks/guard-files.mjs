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
import { isNightSession, markerPath, samePath } from '../scripts/lib/night.mjs';

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

const SCOPE_NAME = /^(?:[a-z]:)?\.agent-scope[. ]*(:.*)?$/i;
const DRIVE_RELATIVE = /^[a-z]:(?![\\/])/i;

/** True when a path argument names a `.agent-scope` file (trailing dots/spaces and streams ignored, simple globs too). */
export function namesAgentScope(arg, cwd) {
  const s = String(arg ?? '');
  if (!s) return false;
  const last = normalizePath(s).split('/').pop() ?? '';
  if (SCOPE_NAME.test(last)) return true;
  if (/[*?[]/.test(last)) {
    try {
      const dir = path.dirname(toAbsolute(s, cwd || process.cwd()));
      return globMatch(s, toAbsolute('.agent-scope', dir), { root: cwd || dir });
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * The root of the session's own working tree when its `.agent-scope` already carries a `run:` line
 * (that file must stay as it is), else null. Only the own file is protected: a registered
 * orchestrator creates scope files in other worktrees, and creating one where none exists is fine.
 */
export function protectedScopeRoot(input) {
  try {
    const root = findRepoRoot(path.resolve(input?.cwd || process.cwd()));
    if (!root) return null;
    const text = fs.readFileSync(path.join(root, '.agent-scope'), 'utf8');
    return /^[ \t]*run:/m.test(text) ? root : null;
  } catch {
    return null;
  }
}

export function scopeProtected(input) {
  return protectedScopeRoot(input) !== null;
}

/** True when `arg` names the `.agent-scope` at `scopeRoot` (the session's own), resolved against `cwd`. */
export function namesOwnAgentScope(arg, cwd, scopeRoot) {
  if (!scopeRoot || !namesAgentScope(arg, cwd)) return false;
  try {
    const s = String(arg).replace(DRIVE_RELATIVE, '');
    const dir = path.dirname(toAbsolute(s, cwd || process.cwd()));
    return samePath(dir, scopeRoot);
  } catch {
    return true;
  }
}

export const SCOPE_DENY_REASON =
  'Night mode: .agent-scope ties this worktree to the night run and is not edited, deleted or overwritten by a run. Leave it as it is and note the task in the run report.';

/** Night mode: a night session may not write the queue or the marker. Returns a deny verdict or null. */
function nightWriteDeny(input, abs, target, { config, root, now }) {
  const nightOpts = now === undefined ? {} : { now };
  const marker = markerPath(input.cwd || process.cwd());
  const queueRel = config.paths?.queue || 'queue/night.md';
  const roots = new Set([root]);
  if (marker) roots.add(normalizePath(path.dirname(path.dirname(path.dirname(marker)))));
  const isMarker = Boolean(marker) && samePath(abs, marker);
  const isQueue = [...roots].some((r) => samePath(abs, toAbsolute(queueRel, r)));
  if (!isMarker && !isQueue) return null;
  if (!isNightSession(input, nightOpts)) return null;
  return {
    decision: 'deny',
    reason: `Night mode: "${target}" is ${isMarker ? 'the night marker' : 'the night queue'}, which a run never writes. Defer the task and note it in the run report.`,
  };
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

  if (namesOwnAgentScope(target, cwd, protectedScopeRoot(input))) {
    out.push({ decision: 'deny', reason: SCOPE_DENY_REASON });
  }

  try {
    const night = nightWriteDeny(input, abs, target, { config, root, now: opts.now });
    if (night) out.push(night);
  } catch {
    // A failing night helper must not discard the other verdicts.
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
    const input = readHookInput();
    const v = evaluateFileTool(input);
    if (v) emitPreToolUse(v.decision, v.reason, input);
  } catch {
    // Never block on an internal error.
  }
  process.exit(0);
}
