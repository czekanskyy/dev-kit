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
    if (now > Math.min(toMs(m.expiry), toMs(m.end) + EXPIRY_GRACE_MS)) return null;
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

const LOCK_STALE_MS = 10 * 1000;
const LOCK_WAIT_MS = 8 * 1000;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs fn while holding an exclusive lock file next to the marker (create-exclusive, 10 s stale timeout,
 * 8 s bounded wait). Not reentrant. Throws when the lock cannot be taken in time.
 */
export function withMarkerLock(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST' && err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
      } catch {
        // gone already, retry
      }
      if (Date.now() > deadline) throw new Error(`the night marker is locked (${lock}); try again`);
      sleep(20);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** Adds a session id to a valid marker. Returns true when it is registered afterwards. */
export function registerSession(file, sessionId, { now = Date.now() } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  if (!readMarker(file, { now })) return false;
  return withMarkerLock(file, () => {
    const m = readMarker(file, { now });
    if (!m) return false;
    if (!m.sessions.includes(sessionId)) writeMarker(file, { ...m, sessions: [...m.sessions, sessionId] });
    return true;
  });
}

/** Fallback (subagents): the directory is in a linked worktree whose .agent-scope names the run id (a `run: <id>` line). */
function worktreeNamesRun(cwd, runId) {
  const root = findRepoRoot(path.resolve(cwd));
  if (!root) return false;
  try {
    if (!fs.statSync(path.join(root, '.git')).isFile()) return false;
    const text = fs.readFileSync(path.join(root, '.agent-scope'), 'utf8');
    const esc = runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^[ \\t]*run:[ \\t]*${esc}[ \\t]*\\r?$`, 'm').test(text);
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

/** Canonical form for comparing paths: no trailing dots, spaces or streams (win32), real parent, case folded. */
function canonicalPath(p) {
  let x = normalizePath(path.resolve(p));
  const win = process.platform === 'win32';
  if (win) {
    // Windows ignores trailing dots and spaces in each component and treats `name:stream` as the file.
    // Long-path (`//?/`) and device (`//./`) prefixes name the same file as the plain form.
    if (/^\/\/[?.]\/UNC\//i.test(x)) x = `//${x.slice(8)}`;
    else if (/^\/\/[?.]\/[a-zA-Z]:(\/|$)/.test(x)) x = x.slice(4);
    const drive = /^[a-zA-Z]:/.test(x) ? x.slice(0, 2) : '';
    x = drive + x.slice(drive.length).replace(/:[^/]*(?=\/|$)/g, '').replace(/[. ]+(?=\/|$)/g, '');
  }
  try {
    // Existing file: expands 8.3 short names and file symlinks.
    x = normalizePath(fs.realpathSync.native(x));
  } catch {
    const dir = path.posix.dirname(x);
    const base = path.posix.basename(x);
    try {
      x = path.posix.join(normalizePath(fs.realpathSync.native(dir)), base);
    } catch {
      // Parent does not exist: compare the lexical path.
    }
  }
  return win || process.platform === 'darwin' ? x.toLowerCase() : x;
}

/** Same path, ignoring slash style, trailing dots/spaces and streams (win32), symlinked parents, and case (win32, darwin). */
export function samePath(a, b) {
  const ca = canonicalPath(a);
  const cb = canonicalPath(b);
  if (ca === cb) return true;
  if (process.platform === 'win32') {
    // Fail closed: a UNC or device path (admin share such as \\host\C$, \\.\) cannot be resolved
    // reliably to a local path, so one whose basename matches the other side counts as the same file.
    const unc = (s) => s.startsWith('//');
    if (unc(ca) !== unc(cb) && path.posix.basename(ca) === path.posix.basename(cb)) return true;
  }
  return false;
}
