#!/usr/bin/env node
// PostToolUse hook for Edit/Write/MultiEdit: runs the project's onEdit rules. Never blocks.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anyGlob, findRepoRoot, loadConfig, normalizePath, relativeTo, shellQuote, toAbsolute } from '../scripts/lib/config.mjs';
import { isMain, readHookInput, tail } from '../scripts/lib/hook.mjs';

const DEBOUNCE_MS = 20000;
const RUN_TIMEOUT_MS = 300000;

const hash = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

function stateFile(sessionId, env) {
  const dir = env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'dev-kit');
  return path.join(dir, `post-edit-${hash(sessionId ?? 'none')}.json`);
}

function loadState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
  } catch {
    // Debounce is best effort.
  }
}

function defaultRun(command, cwd) {
  const r = spawnSync(command, { shell: true, cwd, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error) return { ok: false, output: `${output}\n${r.error.message}` };
  return { ok: r.status === 0, output };
}

/**
 * Runs the onEdit rules for one edit. Returns the additionalContext text, or null.
 * opts: { config, env, now, run(command, cwd) -> {ok, output} }
 * Debounce key: session + rule, plus the file when the rule uses {files} (so every edited file is formatted).
 */
export function handleEdit(input, opts = {}) {
  const env = opts.env ?? process.env;
  const file = input?.tool_input?.file_path;
  if (!file) return null;
  const cwd = input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
  const config = opts.config ?? loadConfig(cwd);
  const root = normalizePath(config.repoRoot ?? findRepoRoot(cwd) ?? cwd);
  const abs = toAbsolute(file, cwd);
  const rel = relativeTo(abs, root) || abs;
  const run = opts.run ?? defaultRun;
  const now = opts.now ?? Date.now();
  const sfile = stateFile(input.session_id, env);
  const state = loadState(sfile);
  const notes = [];
  (config.onEdit ?? []).forEach((rule, idx) => {
    if (!anyGlob(rule.match, abs, { root })) return;
    const usesFiles = (rule.run ?? []).some((c) => c.includes('{files}'));
    const key = `${idx}:${hash(JSON.stringify(rule))}${usesFiles ? `:${rel}` : ''}`;
    if (state[key] && now - state[key] < DEBOUNCE_MS) return;
    state[key] = now;
    saveState(sfile, state);
    const failures = [];
    for (const command of rule.run ?? []) {
      const cmd = command.replaceAll('{files}', shellQuote(rel));
      const r = run(cmd, root);
      if (!r.ok) {
        failures.push(`\`${cmd}\` failed:\n${tail(r.output, 30)}`);
        break;
      }
    }
    if (rule.remind) notes.push(rule.remind);
    notes.push(...failures);
  });
  return notes.length ? notes.join('\n\n') : null;
}

if (isMain(import.meta.url)) {
  try {
    const text = handleEdit(readHookInput());
    if (text) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }));
    }
  } catch {
    // Never block.
  }
  process.exit(0);
}
