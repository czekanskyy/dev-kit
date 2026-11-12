#!/usr/bin/env node
// Stop / SubagentStop hook: runs fast checks when the agent stops with uncommitted code changes.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { anyGlob, commandFor, defaultExec, findRepoRoot, gitTry, loadConfig, normalizePath, shellQuote } from '../scripts/lib/config.mjs';
import { isMain, readHookInput, tail } from '../scripts/lib/hook.mjs';

const TOTAL_BUDGET_MS = 600000;

/** Paths from `git status --porcelain=v1 -z -uall` output. */
export function parsePorcelainZ(out) {
  const files = [];
  const entries = String(out ?? '').split('\0');
  for (let k = 0; k < entries.length; k++) {
    const e = entries[k];
    if (!e || e.length < 4) continue;
    const xy = e.slice(0, 2);
    files.push(normalizePath(e.slice(3)));
    if (xy[0] === 'R' || xy[0] === 'C') k++; // the original path follows
  }
  return files;
}

function defaultRun(command, cwd, timeout) {
  const r = spawnSync(command, { shell: true, cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error) return { ok: false, output: `${output}\n${r.error.code === 'ETIMEDOUT' ? 'timed out' : r.error.message}` };
  return { ok: r.status === 0, output };
}

/**
 * Returns null (let the agent stop) or {decision:'block', reason}.
 * opts: { config, exec, run(command, cwd, timeoutMs) -> {ok, output}, now() }
 */
export function checkStop(input, opts = {}) {
  if (!input || input.stop_hook_active) return null;
  if (input.permission_mode === 'plan') return null;
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const config = opts.config ?? loadConfig(cwd);
  const commands = config.stopCheck?.commands ?? [];
  if (!commands.length) return null;
  const root = config.repoRoot ?? findRepoRoot(cwd);
  if (!root) return null;
  const exec = opts.exec ?? defaultExec;
  const status = gitTry(['status', '--porcelain=v1', '-z', '-uall'], { cwd: root, exec });
  if (status === null) return null;
  const globs = config.stopCheck?.codeGlobs?.length ? config.stopCheck.codeGlobs : ['**'];
  const changed = parsePorcelainZ(status).filter((f) => anyGlob(globs, f, { root }));
  if (!changed.length) return null;
  const existing = changed.filter((f) => fs.existsSync(path.join(root, f)));
  const run = opts.run ?? defaultRun;
  const now = opts.now ?? Date.now;
  const deadline = now() + TOTAL_BUDGET_MS;
  for (const step of commands) {
    let cmd = commandFor(step, config);
    if (!cmd) continue;
    if (cmd.includes('{files}')) {
      if (!existing.length) continue;
      cmd = cmd.replaceAll('{files}', existing.map(shellQuote).join(' '));
    }
    const remaining = deadline - now();
    if (remaining <= 0) return { decision: 'block', reason: `Checks failed: ${cmd}\nthe 600 s stop-check budget ran out` };
    const r = run(cmd, root, remaining);
    if (!r.ok) return { decision: 'block', reason: `Checks failed: ${cmd}\n${tail(r.output, 40)}` };
  }
  return null;
}

if (isMain(import.meta.url)) {
  try {
    const v = checkStop(readHookInput());
    if (v) process.stdout.write(JSON.stringify(v));
  } catch {
    // Never block on an internal error.
  }
  process.exit(0);
}
