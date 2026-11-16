// Night mode marker: <git-common-dir>/dev-kit/night.json, shared by all worktrees, never tracked.
// Fields: runId, start, end, expiry (end + 30 minutes), resumable, sessions (registered session ids), lockPid.
// An expired or malformed marker means "no night". Night mode only ever makes the guard stricter.

import fs from 'node:fs';
import path from 'node:path';
import { findRepoRoot, normalizePath } from './config.mjs';

export const EXPIRY_GRACE_MS = 30 * 60 * 1000;

const toMs = (v) => (typeof v === 'number' ? v : Date.parse(v));

/** Shared git dir for a directory (main checkout or any linked worktree), read from the files, or null. */
export function commonGitDir(cwd) {
  const root = findRepoRoot(path.resolve(cwd || process.cwd()));
  if (!root) return null;
  const dotGit = path.join(root, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    const gitDir = path.resolve(root, m[1]);
    try {
      const rel = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
      if (rel) return path.resolve(gitDir, rel);
    } catch {
      // No commondir file: fall back to the .git/worktrees/<name> layout.
    }
    const parent = path.dirname(gitDir);
    return path.basename(parent) === 'worktrees' ? path.dirname(parent) : gitDir;
  } catch {
    return null;
  }
}

/** Path of the marker file for a directory, or null outside a repository. */
export function markerPath(cwd) {
  const dir = commonGitDir(cwd);
  return dir ? path.join(dir, 'dev-kit', 'night.json') : null;
}

/** Builds a marker. start and end are ms or ISO strings; expiry is end plus 30 minutes. */
export function buildMarker({ runId, start, end, resumable = false, sessions = [], lockPid = null }) {
  const endMs = toMs(end);
  return {
    runId,
    start: new Date(toMs(start)).toISOString(),
    end: new Date(endMs).toISOString(),
    expiry: new Date(endMs + EXPIRY_GRACE_MS).toISOString(),
    resumable: Boolean(resumable),
    sessions: [...sessions],
    lockPid,
  };
}

/** True for a well-formed marker (shape only, not expiry). */
export function isWellFormed(m) {
  return (
    m !== null &&
    typeof m === 'object' &&
    !Array.isArray(m) &&
    typeof m.runId === 'string' &&
    m.runId !== '' &&
    Number.isFinite(toMs(m.start)) &&
    Number.isFinite(toMs(m.end)) &&
    Number.isFinite(toMs(m.expiry)) &&
    Array.isArray(m.sessions) &&
    m.sessions.every((s) => typeof s === 'string')
  );
}

/** Reads the marker. Returns null when missing, malformed or expired (opts.now in ms for tests). */
export function readMarker(file, { now = Date.now() } = {}) {
  if (!file) return null;
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (!isWellFormed(m)) return null;
    if (now > toMs(m.expiry)) return null;
    return m;
  } catch {
    return null;
  }
}

/** Writes the marker atomically, creating its directory. */
export function writeMarker(file, marker) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Adds a session id to a valid marker. Returns true when it is registered afterwards. */
export function registerSession(file, sessionId, { now = Date.now() } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const m = readMarker(file, { now });
  if (!m) return false;
  if (!m.sessions.includes(sessionId)) writeMarker(file, { ...m, sessions: [...m.sessions, sessionId] });
  return true;
}

/** Fallback (subagents): the directory is in a linked worktree whose .agent-scope names the run id. */
function worktreeNamesRun(cwd, runId) {
  const root = findRepoRoot(path.resolve(cwd));
  if (!root) return false;
  try {
    if (!fs.statSync(path.join(root, '.git')).isFile()) return false;
    const text = fs.readFileSync(path.join(root, '.agent-scope'), 'utf8');
    const esc = runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9._-])${esc}($|[^A-Za-z0-9._-])`).test(text);
  } catch {
    return false;
  }
}

/**
 * True only for a hook input whose session_id is registered in a valid marker, or (fallback)
 * whose working directory is a worktree naming the run id. Never throws.
 */
export function isNightSession(input, { now = Date.now(), markerFile } = {}) {
  try {
    const cwd = input?.cwd || process.cwd();
    const m = readMarker(markerFile ?? markerPath(cwd), { now });
    if (!m) return false;
    if (typeof input?.session_id === 'string' && input.session_id && m.sessions.includes(input.session_id)) return true;
    return worktreeNamesRun(cwd, m.runId);
  } catch {
    return false;
  }
}

/** Same path, ignoring slash style (and case on Windows). */
export function samePath(a, b) {
  const x = normalizePath(path.resolve(a));
  const y = normalizePath(path.resolve(b));
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}
