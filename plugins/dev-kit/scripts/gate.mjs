#!/usr/bin/env node
// The local merge gate.
// Usage: node gate.mjs [--tier T0..T3] [--base <ref>] [--post-status] [--only <stepName>] [--dry-run]

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  anyGlob,
  changedFilesSince,
  commandFor,
  currentBranch,
  defaultBaseRef,
  defaultExec,
  findRepoRoot,
  gitTry,
  loadConfig,
  normalizePath,
} from './lib/config.mjs';
import { isMain } from './lib/hook.mjs';

const TIERS = ['T0', 'T1', 'T2', 'T3'];
const TAIL_LINES = 60;

/**
 * Selects the gate steps to run.
 * changedFiles: array of repo-relative paths, or null when unknown (then every `when` step and subproject runs).
 * Returns [{name, run, cwd, env, skip}] where skip is a reason string or null.
 */
export function resolveSteps({ config, repoRoot, changedFiles, tier = 'T3', only }) {
  const tierIdx = TIERS.indexOf(tier);
  if (tierIdx < 0) throw new Error(`unknown tier ${tier} (use T0..T3)`);
  const root = repoRoot ?? config.repoRoot ?? process.cwd();
  const files = changedFiles ? changedFiles.map(normalizePath) : null;
  const steps = [];

  const add = (step, { prefix = '', cwd = root, scope = '' } = {}) => {
    const obj = typeof step === 'string' ? { run: step } : step;
    const name = `${prefix}${obj.name ?? (typeof step === 'string' ? step : obj.run)}`;
    const run = commandFor(obj.run, config);
    let skip = null;
    if (!run) skip = 'no command configured';
    else if (obj.minTier && tierIdx < TIERS.indexOf(obj.minTier)) skip = `needs ${obj.minTier}`;
    else if (obj.when?.length && files && !(obj.alwaysFromTier && tierIdx >= TIERS.indexOf(obj.alwaysFromTier))) {
      const scoped = scope ? files.filter((f) => f.startsWith(`${scope}/`)).map((f) => f.slice(scope.length + 1)) : files;
      if (!scoped.some((f) => anyGlob(obj.when, f, { root: scope ? path.join(root, scope) : root }))) skip = 'diff does not touch its paths';
    }
    if (!skip && only && name !== only && obj.name !== only && obj.run !== only) skip = 'not selected by --only';
    steps.push({ name, run, cwd, env: obj.env ?? {}, skip });
  };

  for (const s of config.gate?.steps ?? []) add(s);
  for (const sp of config.subprojects ?? []) {
    const scope = normalizePath(sp.path).replace(/^\.\//, '').replace(/\/$/, '');
    const touched = !files || files.some((f) => f === scope || f.startsWith(`${scope}/`));
    for (const s of sp.gate ?? []) {
      if (!touched) {
        const obj = typeof s === 'string' ? { run: s } : s;
        steps.push({ name: `${scope}: ${obj.name ?? obj.run}`, run: commandFor(obj.run, config), cwd: path.join(root, scope), env: obj.env ?? {}, skip: `diff does not touch ${scope}/` });
      } else {
        add(s, { prefix: `${scope}: `, cwd: path.join(root, scope), scope });
      }
    }
  }
  return steps;
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export const LOCK_FRESH_MS = 120 * 1000;
export const LOCK_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Machine-wide gate lock path (one gate at a time across all repositories). */
export function gateLockPath() {
  return path.join(os.tmpdir(), 'dev-kit-gate.lock');
}

/**
 * Decides whether an existing lock may be broken.
 * Unreadable or empty locks younger than LOCK_FRESH_MS count as live (the owner may still be writing).
 * A lock is stale when its pid is dead on this host, or when it is older than LOCK_MAX_AGE_MS.
 */
export function lockIsStale(holder, ageMs, { host = os.hostname(), alive = pidAlive } = {}) {
  if (ageMs > LOCK_MAX_AGE_MS) return true;
  if (!holder || !holder.pid) return ageMs > LOCK_FRESH_MS;
  if (holder.host && holder.host !== host) return false;
  return !alive(holder.pid);
}

/**
 * Moves a stale lock aside without ever deleting a replacement owner's lock:
 * the file is renamed only while its content still equals what was judged stale, and if a
 * replacement slipped in between the check and the rename it is put back. Returns true when reclaimed.
 */
export function reclaimStaleLock(lockPath, staleText) {
  let current;
  try {
    current = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return false;
  }
  if (current !== staleText) return false;
  const aside = `${lockPath}.stale-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    fs.renameSync(lockPath, aside);
  } catch {
    return false;
  }
  let moved = null;
  try {
    moved = fs.readFileSync(aside, 'utf8');
  } catch {
    moved = null;
  }
  if (moved !== staleText) {
    // We moved someone else's fresh lock: put it back unless a new lock already exists.
    try {
      fs.linkSync(aside, lockPath);
    } catch {
      // a lock exists again; leave it alone
    }
    try {
      fs.unlinkSync(aside);
    } catch {
      // ignore
    }
    return false;
  }
  try {
    fs.unlinkSync(aside);
  } catch {
    // ignore
  }
  return true;
}

/** Takes the exclusive lock file. Returns a release function, or throws after waitMs. */
export async function acquireLock(lockPath, { waitMs = 60 * 60 * 1000, pollMs = 10000, log = console.log } = {}) {
  const start = Date.now();
  const token = randomBytes(16).toString('hex');
  let announced = false;
  for (;;) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if (fd !== null) {
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString(), token }));
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          if (holder.token === token) fs.unlinkSync(lockPath);
        } catch {
          // gone or unreadable: not ours to remove
        }
      };
      process.on('exit', release);
      return release;
    }
    let holder = null;
    let ageMs = 0;
    let text = null;
    try {
      const st = fs.statSync(lockPath);
      ageMs = Date.now() - st.mtimeMs;
      text = fs.readFileSync(lockPath, 'utf8');
      try {
        holder = text.trim() ? JSON.parse(text) : null;
      } catch {
        holder = null;
      }
      if (holder?.started) ageMs = Math.max(ageMs, Date.now() - Date.parse(holder.started));
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      holder = null;
    }
    if (text !== null && lockIsStale(holder, ageMs)) {
      reclaimStaleLock(lockPath, text);
      continue;
    }
    if (Date.now() - start >= waitMs) throw new Error(`gate lock still held by pid ${holder?.pid ?? 'unknown'} after ${Math.round(waitMs / 60000)} min`);
    if (!announced) {
      log(`waiting for gate lock (held by pid ${holder?.pid ?? 'unknown'} since ${holder?.started ?? 'unknown'})`);
      announced = true;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function runStep(step) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let buf = '';
    const push = (d) => {
      buf += d.toString();
      if (buf.length > 512 * 1024) buf = buf.slice(-256 * 1024);
    };
    let child;
    try {
      child = spawn(step.run, { shell: true, cwd: step.cwd, env: { ...process.env, ...step.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ ok: false, seconds: 0, tail: String(err.message) });
      return;
    }
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (err) => push(`\n${err.message}`));
    child.on('close', (code) => {
      const lines = buf.replace(/\s+$/, '').split(/\r?\n/);
      resolve({ ok: code === 0, seconds: (Date.now() - t0) / 1000, tail: lines.slice(-TAIL_LINES).join('\n') });
    });
  });
}

function parseArgs(argv) {
  const out = { tier: 'T3', postStatus: false, dryRun: false };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--tier') out.tier = String(argv[++k] ?? '').toUpperCase();
    else if (a === '--base') out.base = argv[++k];
    else if (a === '--only') out.only = argv[++k];
    else if (a === '--post-status') out.postStatus = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/** Uncommitted paths (untracked included, gate state excluded), or null when git status fails. */
function dirtyFiles(root, exec) {
  const out = gitTry(['status', '--porcelain=v1', '-uall'], { cwd: root, exec });
  if (out === null) return null;
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => normalizePath(l.slice(3)))
    .filter((f) => !f.startsWith('.claude/state/'));
}

/** Runs the gate. Returns the exit code. deps: { exec, gh (runner for gh calls), log, cwd, lockPath, lockPollMs } */
export async function runGate(args, deps = {}) {
  const exec = deps.exec ?? defaultExec;
  const log = deps.log ?? console.log;
  const cwd = deps.cwd ?? process.cwd();
  const root = findRepoRoot(cwd);
  if (!root) {
    log('gate: not inside a git repository');
    return 1;
  }
  const config = loadConfig(root);
  if (!config.configured) log('gate: note: no .claude/workflow.json, running with dev-kit defaults only');
  const base = args.base ?? defaultBaseRef(config);
  const diff = changedFilesSince(base, { cwd: root, exec });
  if (!diff) log(`gate: cannot diff against ${base}; every conditional step will run`);
  if (args.postStatus && args.only) {
    log('gate: refusing --post-status with --only: a status must cover the whole gate.');
    return 2;
  }
  const steps = resolveSteps({ config, repoRoot: root, changedFiles: diff?.files ?? null, tier: args.tier, only: args.only });
  if (args.only && !steps.some((s) => s.name === args.only || s.name.endsWith(`: ${args.only}`) || s.run === args.only)) {
    log(`gate: unknown step "${args.only}". Steps: ${steps.map((s) => s.name).join(', ') || '(none)'}`);
    return 2;
  }

  if (args.dryRun) {
    log(`gate plan: tier ${args.tier}, base ${base}, ${diff ? diff.files.length : 'unknown'} changed files`);
    for (const s of steps) log(s.skip ? `SKIP ${s.name} (${s.skip})` : `RUN  ${s.name}: ${s.run}`);
    return 0;
  }

  let release = () => {};
  if (config.gate?.exclusive ?? true) {
    try {
      release = await acquireLock(deps.lockPath ?? gateLockPath(), { log, ...(deps.lockPollMs ? { pollMs: deps.lockPollMs } : {}) });
    } catch (err) {
      log(`gate: ${err.message}`);
      return 1;
    }
  }
  try {
    // Waiting for the lock can take long: reload the config, the diff and the step selection.
    const fresh = loadConfig(root);
    const freshBase = args.base ?? defaultBaseRef(fresh);
    const freshDiff = changedFilesSince(freshBase, { cwd: root, exec });
    const freshSteps = resolveSteps({ config: fresh, repoRoot: root, changedFiles: freshDiff?.files ?? null, tier: args.tier, only: args.only });
    if (args.only && !freshSteps.some((s) => s.name === args.only || s.name.endsWith(`: ${args.only}`) || s.run === args.only)) {
      log(`gate: step "${args.only}" no longer exists after reloading the config.`);
      return 2;
    }
    return await runLocked({ args, config: fresh, root, base: freshBase, steps: freshSteps, exec, gh: deps.gh ?? exec, log });
  } finally {
    release();
  }
}

async function runLocked({ args, config, root, base, steps, exec, gh, log }) {
  // Read the tested state only once the lock is held.
  const sha = gitTry(['rev-parse', 'HEAD'], { cwd: root, exec })?.trim() ?? null;
  const branch = currentBranch(root, exec);
  if (args.postStatus) {
    const dirty = dirtyFiles(root, exec);
    if (dirty === null) {
      log('gate: refusing --post-status: git status failed, so the working tree cannot be confirmed clean.');
      return 1;
    }
    if (dirty.length) {
      log(`gate: refusing --post-status: the working tree has uncommitted changes (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', ...' : ''}). Commit them so the tested state equals the commit.`);
      if (dirty.some((f) => f === '.claude/worktrees' || f.startsWith('.claude/worktrees/'))) {
        log('gate: hint: agent worktrees live under .claude/worktrees: add /.claude/worktrees/ to .gitignore.');
      }
      return 1;
    }
    if (!sha) {
      log('gate: refusing --post-status: there is no commit yet.');
      return 1;
    }
    const remotes = gitTry(['branch', '-r', '--contains', sha], { cwd: root, exec });
    if (!remotes || !remotes.trim()) {
      log(`gate: refusing --post-status: commit ${sha.slice(0, 12)} is not on any remote branch. Push the branch first, then rerun the gate.`);
      return 1;
    }
  }

  const results = [];
  let ok = true;
  const t0 = Date.now();
  for (const s of steps) {
    if (s.skip) {
      results.push({ name: s.name, run: s.run, skipped: s.skip });
      continue;
    }
    if (!ok) {
      results.push({ name: s.name, run: s.run, skipped: 'an earlier step failed' });
      continue;
    }
    const r = await runStep(s);
    results.push({ name: s.name, run: s.run, ok: r.ok, seconds: Number(r.seconds.toFixed(1)) });
    if (r.ok) log(`PASS ${s.name} ${r.seconds.toFixed(1)}s`);
    else {
      ok = false;
      log(`FAIL ${s.name} ${r.seconds.toFixed(1)}s`);
      log(r.tail);
    }
  }
  const ran = results.filter((r) => r.ok !== undefined);
  if (!ran.length) log('gate: no steps ran (check gate.steps in .claude/workflow.json)');

  let changed = false;
  let statusFailed = false;
  if (args.postStatus) {
    const sha2 = gitTry(['rev-parse', 'HEAD'], { cwd: root, exec })?.trim() ?? null;
    const dirtyAfter = dirtyFiles(root, exec);
    statusFailed = dirtyAfter === null;
    changed = sha2 !== sha || (dirtyAfter !== null && dirtyAfter.length > 0);
  }

  const result = { sha, branch, tier: args.tier, base, ok, treeChanged: changed, steps: results, seconds: Number(((Date.now() - t0) / 1000).toFixed(1)), finishedAt: new Date().toISOString() };
  if (sha) {
    const dir = path.join(root, '.claude', 'state', 'gate');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${sha}.json`);
      fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
      if (gitTry(['check-ignore', '-q', path.relative(root, file).replace(/\\/g, '/')], { cwd: root, exec }) === null) {
        log('gate: note: .claude/state/ is not gitignored; add it to .gitignore');
      }
    } catch (err) {
      log(`gate: could not write the result file: ${err.message}`);
    }
  }

  if (args.postStatus) {
    if (statusFailed) {
      log('gate: git status failed after the steps, so the tree cannot be confirmed unchanged; no status posted.');
      return 1;
    }
    if (changed) {
      log('gate: tree changed during gate (HEAD moved or files changed); no status posted. Rerun the gate on a stable tree.');
      return 1;
    }
    if (ok && !ran.length) {
      log('gate: refusing to post success: zero steps executed.');
      return 1;
    }
    const context = config.gate?.statusContext || 'local-gate';
    try {
      const nwo = JSON.parse(gh('gh', ['repo', 'view', '--json', 'nameWithOwner'], { cwd: root, timeout: 30000 })).nameWithOwner;
      const description = ok
        ? `${args.tier}: ${ran.length} steps passed locally`
        : `${args.tier}: ${results.find((r) => r.ok === false)?.name ?? 'a step'} failed locally`;
      gh('gh', ['api', '-X', 'POST', `repos/${nwo}/statuses/${sha}`, '-f', `state=${ok ? 'success' : 'failure'}`, '-f', `context=${context}`, '-f', `description=${description}`], { cwd: root, timeout: 30000 });
      log(`gate: posted ${ok ? 'success' : 'failure'} status "${context}" on ${sha.slice(0, 12)} (${description})`);
    } catch (err) {
      log(`gate: could not post the commit status: ${String(err.stderr || err.message).trim()}`);
      return 1;
    }
  }
  log(ok ? `gate: OK (${ran.length} steps)` : 'gate: FAILED');
  return ok ? 0 : 1;
}

if (isMain(import.meta.url)) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (args.help) {
    console.log('Usage: node gate.mjs [--tier T0..T3] [--base <ref>] [--post-status] [--only <stepName>] [--dry-run]');
    process.exit(0);
  }
  try {
    process.exitCode = await runGate(args);
  } catch (err) {
    console.error(`gate: ${err.message}`);
    process.exitCode = 1;
  }
}
