// Shared configuration and path helpers for dev-kit hooks and scripts.
// Zero dependencies: Node >= 20 built-ins only.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULTS_FILE = path.join(PLUGIN_ROOT, 'defaults.json');
export const SCHEMA_FILE = path.join(PLUGIN_ROOT, 'schema', 'workflow.schema.json');
export const PROJECT_CONFIG = path.join('.claude', 'workflow.json');

// Arrays at these key paths are concatenated (defaults + project); all other arrays are replaced.
export const CONCAT_KEYS = new Set(['guard.secrets', 'guard.denyCommands', 'guard.askCommands', 'commit.forbid']);

const IS_WIN = process.platform === 'win32';

/** Default external command runner. Tests inject their own with the same signature. */
export function defaultExec(file, args, opts = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

/** Walks up from cwd to the first directory holding a .git dir or file (worktrees use a file). */
export function findRepoRoot(cwd = process.cwd()) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge with the dev-kit array rules (see CONCAT_KEYS). */
export function mergeConfig(base, over, keyPath = '') {
  if (over === undefined) return base === undefined ? undefined : structuredClone(base);
  if (Array.isArray(over)) {
    if (CONCAT_KEYS.has(keyPath) && Array.isArray(base)) return [...structuredClone(base), ...structuredClone(over)];
    return structuredClone(over);
  }
  if (isPlainObject(over) && isPlainObject(base)) {
    const out = structuredClone(base);
    for (const key of Object.keys(over)) {
      out[key] = mergeConfig(base[key], over[key], keyPath ? `${keyPath}.${key}` : key);
    }
    return out;
  }
  return structuredClone(over);
}

/**
 * Loads defaults.json merged with <repo>/.claude/workflow.json.
 * Returns the merged object with `configured` (project file found and parsed) plus
 * non-enumerable `repoRoot`, `configFile` and `configError`.
 * opts: { defaults, project, repoRoot } for tests.
 */
export function loadConfig(cwd = process.cwd(), opts = {}) {
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd) ?? path.resolve(cwd);
  const defaults = opts.defaults ?? readJson(DEFAULTS_FILE);
  const configFile = path.join(repoRoot, PROJECT_CONFIG);
  let project = opts.project;
  let configured = false;
  let configError = null;
  if (project === undefined) {
    project = null;
    if (fs.existsSync(configFile)) {
      try {
        project = readJson(configFile);
        configured = true;
      } catch (err) {
        configError = `cannot parse ${configFile}: ${err.message}`;
      }
    }
  } else {
    configured = project !== null;
  }
  const merged = mergeConfig(defaults, project ?? {});
  merged.configured = configured;
  Object.defineProperty(merged, 'repoRoot', { value: repoRoot, enumerable: false });
  Object.defineProperty(merged, 'configFile', { value: configFile, enumerable: false });
  Object.defineProperty(merged, 'configError', { value: configError, enumerable: false });
  return merged;
}

/** Resolves a gate/stop step: a key of `commands` maps to its value (may be null), anything else is a shell command. */
export function commandFor(name, config) {
  if (name === undefined || name === null) return null;
  const commands = config?.commands ?? {};
  if (typeof name === 'string' && Object.prototype.hasOwnProperty.call(commands, name)) return commands[name];
  return name;
}

/** Value at a dotted key path, or undefined. */
export function getPath(obj, keyPath) {
  if (!keyPath) return obj;
  let cur = obj;
  for (const part of keyPath.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Paths and globs

export function homeDir() {
  return os.homedir();
}

export function expandHome(p) {
  const s = String(p);
  if (s === '~') return homeDir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(homeDir(), s.slice(2));
  const m = /^\$(?:HOME|\{HOME\})(?=[\\/]|$)/.exec(s);
  if (m) return homeDir() + s.slice(m[0].length);
  return s;
}

/**
 * Forward slashes, no duplicate or trailing slash; on Windows lower-case drive and map /c/x to c:/x.
 * A UNC prefix (\\server\share or //server/share) keeps its leading double slash.
 */
export function normalizePath(p) {
  let s = String(p).replace(/\\/g, '/');
  const unc = /^\/\/[^/]/.test(s);
  if (unc) return `/${`/${s.slice(2)}`.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1')}`;
  if (IS_WIN) {
    const m = /^\/([a-zA-Z])(\/|$)/.exec(s);
    if (m) s = `${m[1]}:/${s.slice(3)}`;
    if (/^\/tmp(\/|$)/.test(s)) s = normalizePath(os.tmpdir()) + s.slice(4);
    if (/^[a-zA-Z]:/.test(s)) s = s[0].toLowerCase() + s.slice(1);
  }
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/') && !/^[a-z]:\/$/i.test(s)) s = s.slice(0, -1);
  return s;
}

export function isAbsolutePath(p) {
  const s = normalizePath(p);
  return s.startsWith('/') || /^[a-z]:\//i.test(s) || /^[a-z]:$/i.test(s);
}

/** Absolute, normalized path; relative paths resolve against base. */
export function toAbsolute(p, base = process.cwd()) {
  const s = normalizePath(expandHome(p));
  if (isAbsolutePath(s)) return normalizePath(path.resolve(s));
  return normalizePath(path.resolve(normalizePath(base), s));
}

function samePath(a, b) {
  return IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** True when child equals parent or lies inside it (both absolute). */
export function isInside(child, parent, { strict = false } = {}) {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (samePath(c, p)) return !strict;
  const prefix = p.endsWith('/') ? p : `${p}/`;
  return IS_WIN ? c.toLowerCase().startsWith(prefix.toLowerCase()) : c.startsWith(prefix);
}

export function relativeTo(abs, root) {
  const a = normalizePath(abs);
  const r = normalizePath(root);
  if (samePath(a, r)) return '';
  return a.slice(r.length + (r.endsWith('/') ? 0 : 1));
}

function escapeRe(c) {
  return /[.*+?^${}()|[\]\\/]/.test(c) ? `\\${c}` : c;
}

/** Translates a glob to a regex source. Supports **, *, ?, {a,b} and backslash escapes. */
export function globToRegExpSource(pattern) {
  const p = String(pattern);
  let re = '';
  let depth = 0;
  for (let i = 0; i < p.length; ) {
    const c = p[i];
    if (c === '*') {
      let j = i;
      while (p[j] === '*') j++;
      if (j - i >= 2) {
        const atStart = i === 0 || p[i - 1] === '/';
        if (atStart && p[j] === '/') {
          re += '(?:.*/)?';
          i = j + 1;
        } else {
          re += '.*';
          i = j;
        }
      } else {
        re += '[^/]*';
        i = j;
      }
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (c === '{') {
      depth++;
      re += '(?:';
      i++;
      continue;
    }
    if (c === '}' && depth > 0) {
      depth--;
      re += ')';
      i++;
      continue;
    }
    if (c === ',' && depth > 0) {
      re += '|';
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < p.length) {
      re += escapeRe(p[i + 1]);
      i += 2;
      continue;
    }
    re += escapeRe(c);
    i++;
  }
  while (depth-- > 0) re += ')';
  return re;
}

const reCache = new Map();
function compileGlob(pattern, nocase) {
  const key = `${nocase ? 'i' : 's'}:${pattern}`;
  let re = reCache.get(key);
  if (!re) {
    re = new RegExp(`^${globToRegExpSource(pattern)}$`, nocase ? 'i' : '');
    reCache.set(key, re);
  }
  return re;
}

/**
 * Matches a path against a glob.
 * - `~` in the pattern expands to the home dir; such patterns match absolute paths.
 * - Relative patterns match the path relative to opts.root (default: cwd).
 *   Patterns starting with `**` also match absolute paths outside the root.
 *   Patterns without a slash also match the basename (gitignore-like).
 * - Case-insensitive on Windows unless opts.nocase is set.
 */
export function globMatch(pattern, filePath, opts = {}) {
  if (!pattern || filePath === undefined || filePath === null || filePath === '') return false;
  const nocase = opts.nocase ?? IS_WIN;
  const root = normalizePath(path.resolve(opts.root ?? process.cwd()));
  const pat = normalizePath(expandHome(String(pattern)));
  const abs = toAbsolute(filePath, root);
  const re = compileGlob(pat, nocase);
  if (isAbsolutePath(pat)) return re.test(abs);
  const candidates = [];
  if (isInside(abs, root)) candidates.push(relativeTo(abs, root));
  if (pat.startsWith('**')) candidates.push(abs);
  if (!pat.includes('/')) candidates.push(abs.slice(abs.lastIndexOf('/') + 1));
  return candidates.some((c) => re.test(c));
}

export function anyGlob(patterns, filePath, opts = {}) {
  return (patterns ?? []).some((g) => globMatch(g, filePath, opts));
}

/** True when the path matches guard.secrets and no guard.allowRead exception. */
export function isSecretPath(filePath, config, { cwd = process.cwd(), root } = {}) {
  const guard = config?.guard ?? {};
  const abs = toAbsolute(filePath, cwd);
  const opts = { root: root ?? config?.repoRoot ?? cwd };
  if (!anyGlob(guard.secrets, abs, opts)) return false;
  return !anyGlob(guard.allowRead, abs, opts);
}

// ---------------------------------------------------------------------------
// Git

/** Runs git with no shell and returns stdout without the trailing newline. Throws on failure. */
export function gitRun(args, { cwd = process.cwd(), exec = defaultExec, timeout = 30000 } = {}) {
  return String(exec('git', args, { cwd, timeout })).replace(/\r?\n$/, '');
}

/** Like gitRun but returns null on failure. */
export function gitTry(args, opts = {}) {
  try {
    return gitRun(args, opts);
  } catch {
    return null;
  }
}

/** Current branch name, or null (detached HEAD, not a repo, git missing). */
export function currentBranch(cwd = process.cwd(), exec = defaultExec) {
  const out = gitTry(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd, exec });
  return out ? out.trim() || null : null;
}

export function defaultBaseRef(config) {
  const b = config?.branches ?? {};
  const remote = b.remote || 'origin';
  const target = b.integration || (b.protected ?? [])[0] || 'main';
  return `${remote}/${target}`;
}

/** Files changed since the merge base with `base` (committed and uncommitted, untracked included), or null. */
export function changedFilesSince(base, { cwd, exec = defaultExec } = {}) {
  const mb = gitTry(['merge-base', base, 'HEAD'], { cwd, exec });
  if (!mb) return null;
  const tracked = gitTry(['diff', '--name-only', '--no-renames', '-z', mb.trim()], { cwd, exec }) ?? '';
  const untracked = gitTry(['ls-files', '--others', '--exclude-standard', '-z'], { cwd, exec }) ?? '';
  const files = new Set([...tracked.split('\0'), ...untracked.split('\0')].filter(Boolean));
  return { mergeBase: mb.trim(), files: [...files].map(normalizePath) };
}

/** Quote a path for a shell command line (works for sh and cmd for ordinary names). */
export function shellQuote(s) {
  return `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
}
