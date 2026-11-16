#!/usr/bin/env node
// Night lock: arms a time-boxed run (marker plus sleep lock), validates a claim, reports status,
// restarts a dead sleep lock and releases the run. Zero dependencies.
//
// Usage:
//   node night-lock.mjs acquire (--until <HH:MM | ISO time> | --for <hours>) [--start <time>] [--resumable]
//   node night-lock.mjs claim --run <id>
//   node night-lock.mjs status
//   node night-lock.mjs keepawake
//   node night-lock.mjs release
// Exit codes: 0 ok, 1 refused or no valid marker, 2 bad usage.
// The marker (see lib/night.mjs) is written only by acquire and removed only by release (or when found
// expired). `claim` only validates: the guard hook registers the session when it sees this exact command.
// A restarted lock child is recorded in a sidecar file next to the marker, so keepawake never rewrites it.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { isMain } from './lib/hook.mjs';
import { EXPIRY_GRACE_MS, buildMarker, isWellFormed, markerPath, readMarker, writeMarker } from './lib/night.mjs';

const HOUR_MS = 3600 * 1000;
const DEFAULT_MAX_RUN_HOURS = 12;
const SIDECAR = 'night-lock.pid';

export class LockError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Time and ids

/** Resolves HH:MM (local time, next occurrence after `from`) or an ISO time to ms. */
export function parseTime(spec, from) {
  const s = String(spec ?? '').trim();
  const hm = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (hm) {
    const h = Number(hm[1]);
    const m = Number(hm[2]);
    if (h > 23 || m > 59) throw new LockError(`not a valid time: ${s}`, 2);
    const d = new Date(from);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const ms = Date.parse(s);
  if (!s || Number.isNaN(ms)) throw new LockError(`not a valid time: ${s || '(empty)'}; use HH:MM or an ISO time`, 2);
  return ms;
}

/** Unique run id: UTC timestamp plus a random suffix. */
export function newRunId(now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Sleep lock

/** Command that holds the machine awake until `expiryMs`, per platform. */
export function lockPlan(platform, expiryMs, nowMs = Date.now()) {
  const seconds = Math.max(1, Math.ceil((expiryMs - nowMs) / 1000));
  if (platform === 'win32') {
    const script = [
      "Add-Type -Namespace Kit -Name Power -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags);'",
      '[void][Kit.Power]::SetThreadExecutionState([uint32]2147483649)', // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
      `while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt ${Math.floor(expiryMs)}) { Start-Sleep -Seconds 1 }`,
      '[void][Kit.Power]::SetThreadExecutionState([uint32]2147483648)',
    ].join('; ');
    return {
      platform,
      seconds,
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    };
  }
  if (platform === 'darwin') {
    return { platform, seconds, command: 'caffeinate', args: ['-i', '-t', String(seconds)] };
  }
  return {
    platform,
    seconds,
    command: 'systemd-inhibit',
    args: ['--what=sleep:idle', '--who=dev-kit', '--why=night run', '--mode=block', 'sleep', String(seconds)],
  };
}

/** Default spawner: a detached, windowless child that outlives this process. Returns its pid or null. */
export function spawnDetached(plan) {
  try {
    if (plan.platform === 'win32') {
      // A console-less (detached) PowerShell exits at once and a plain child dies with its parent, so a
      // short-lived launcher starts the lock with Start-Process, hidden, and prints its pid.
      const quoted = plan.args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
      const launcher = `(Start-Process -FilePath ${plan.command} -WindowStyle Hidden -PassThru -ArgumentList ${quoted}).Id`;
      const r = spawnSync(plan.command, ['-NoProfile', '-NonInteractive', '-Command', launcher], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      const pid = Number(String(r.stdout ?? '').trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    }
    const child = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return Number.isInteger(child.pid) ? child.pid : null;
  } catch {
    return null;
  }
}

function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function defaultKill(pid) {
  try {
    process.kill(pid);
  } catch {
    // Already gone.
  }
}

// ---------------------------------------------------------------------------
// Context and files

function resolveCtx(ctx = {}) {
  const cwd = ctx.cwd ?? process.cwd();
  const file = markerPath(cwd);
  if (!file) throw new LockError('not inside a git repository', 1);
  return {
    cwd,
    file,
    sidecar: path.join(path.dirname(file), SIDECAR),
    now: ctx.now ?? Date.now(),
    platform: ctx.platform ?? process.platform,
    graceMs: ctx.graceMs ?? EXPIRY_GRACE_MS,
    spawner: ctx.spawner ?? spawnDetached,
    isAlive: ctx.isAlive ?? defaultIsAlive,
    kill: ctx.kill ?? defaultKill,
    maxRunHours: ctx.maxRunHours,
  };
}

function maxRunHours(c) {
  if (c.maxRunHours !== undefined) return c.maxRunHours;
  try {
    const v = loadConfig(c.cwd).night?.maxRunHours;
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_RUN_HOURS;
  } catch {
    return DEFAULT_MAX_RUN_HOURS;
  }
}

function readSidecarPid(c) {
  try {
    const n = Number(fs.readFileSync(c.sidecar, 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** The lock pid in force: a restarted child (sidecar) wins over the one recorded at acquire. */
function currentLockPid(c, marker) {
  return readSidecarPid(c) ?? (Number.isInteger(marker?.lockPid) ? marker.lockPid : null);
}

function removeFiles(c) {
  for (const f of [c.file, c.sidecar]) fs.rmSync(f, { force: true });
}

/** Removes a well-formed marker that has expired (the lock child ended itself by then). */
function dropExpired(c) {
  try {
    const raw = JSON.parse(fs.readFileSync(c.file, 'utf8').replace(/^﻿/, ''));
    if (isWellFormed(raw) && !readMarker(c.file, { now: c.now })) {
      removeFiles(c);
    }
  } catch {
    // Missing or malformed: nothing to remove here.
  }
}

function requireMarker(c) {
  const m = readMarker(c.file, { now: c.now });
  if (!m) throw new LockError('no valid night marker (none armed, or it has expired)', 1);
  return m;
}

function start(c, expiryMs) {
  const plan = lockPlan(c.platform, expiryMs, c.now);
  try {
    const pid = c.spawner(plan);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Subcommands

export function acquire(args, ctx) {
  const c = resolveCtx(ctx);
  dropExpired(c);
  const hasUntil = args.until !== undefined;
  const hasFor = args.for !== undefined;
  if (!hasUntil && !hasFor) throw new LockError('acquire needs --until <HH:MM | ISO time> or --for <hours>', 2);
  if (hasUntil && hasFor) throw new LockError('use either --until or --for, not both', 2);

  const startMs = args.start !== undefined ? parseTime(args.start, c.now) : c.now;
  let endMs;
  if (hasFor) {
    const hours = Number(args.for);
    if (!Number.isFinite(hours) || hours <= 0) throw new LockError('--for needs a positive number of hours', 2);
    endMs = startMs + hours * HOUR_MS;
  } else {
    endMs = parseTime(args.until, Math.max(startMs, c.now));
  }
  if (endMs <= c.now) throw new LockError('the end time is in the past', 1);
  if (endMs <= startMs) throw new LockError('the end time is not after the start time', 1);
  const max = maxRunHours(c);
  if (endMs - startMs > max * HOUR_MS + 1) {
    throw new LockError(`the time box is longer than night.maxRunHours (${max} hours)`, 1);
  }
  if (readMarker(c.file, { now: c.now })) throw new LockError('a night marker is already valid; release it first', 1);

  const runId = newRunId(c.now);
  const base = buildMarker({ runId, start: startMs, end: endMs, resumable: Boolean(args.resumable) });
  const marker = { ...base, expiry: new Date(endMs + c.graceMs).toISOString() };
  marker.lockPid = start(c, Date.parse(marker.expiry));
  fs.rmSync(c.sidecar, { force: true });
  try {
    writeMarker(c.file, marker);
  } catch (err) {
    if (marker.lockPid) c.kill(marker.lockPid);
    throw new LockError(`cannot write the marker: ${err.message}`, 1);
  }
  return marker;
}

/** Validates marker, run id and time window; returns the run id. The guard hook registers the session. */
export function claim(args, ctx) {
  const c = resolveCtx(ctx);
  if (!args.run) throw new LockError('claim needs --run <id>', 2);
  const m = requireMarker(c);
  if (args.run !== m.runId) throw new LockError('run id does not match the armed night marker', 1);
  if (c.now < Date.parse(m.start)) throw new LockError(`the run has not started yet (starts ${m.start})`, 1);
  if (c.now > Date.parse(m.end)) throw new LockError(`the run has ended (ended ${m.end})`, 1);
  return m.runId;
}

export function status(ctx) {
  const c = resolveCtx(ctx);
  dropExpired(c);
  const m = readMarker(c.file, { now: c.now });
  if (!m) return { valid: false };
  const pid = currentLockPid(c, m);
  return {
    valid: true,
    runId: m.runId,
    start: m.start,
    end: m.end,
    expiry: m.expiry,
    resumable: m.resumable === true,
    started: c.now >= Date.parse(m.start),
    ended: c.now > Date.parse(m.end),
    lockPid: pid,
    lockAlive: pid !== null && c.isAlive(pid),
  };
}

/** Restarts a dead lock child until the marker's expiry. Never rewrites the marker. */
export function keepawake(ctx) {
  const c = resolveCtx(ctx);
  const m = requireMarker(c);
  const pid = currentLockPid(c, m);
  if (pid !== null && c.isAlive(pid)) return { restarted: false, lockPid: pid };
  const fresh = start(c, Date.parse(m.expiry));
  if (fresh === null) throw new LockError('could not start the sleep lock', 1);
  fs.writeFileSync(c.sidecar, `${fresh}\n`);
  return { restarted: true, lockPid: fresh };
}

export function release(ctx) {
  const c = resolveCtx(ctx);
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(c.file, 'utf8').replace(/^﻿/, ''));
  } catch {
    // No marker, or unreadable: still clean the sidecar below.
  }
  const pids = new Set([readSidecarPid(c), Number.isInteger(raw?.lockPid) ? raw.lockPid : null].filter((p) => p !== null));
  let killed = 0;
  for (const pid of pids) {
    if (c.isAlive(pid)) {
      c.kill(pid);
      killed += 1;
    }
  }
  const existed = fs.existsSync(c.file);
  removeFiles(c);
  return { released: existed, killed };
}

// ---------------------------------------------------------------------------
// CLI

const VALUE_FLAGS = new Set(['until', 'for', 'start', 'run']);
const BOOL_FLAGS = new Set(['resumable']);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) throw new LockError(`unexpected argument: ${argv[i]}`, 2);
    const [, key, inline] = m;
    if (BOOL_FLAGS.has(key) && inline === undefined) out[key] = true;
    else if (VALUE_FLAGS.has(key)) {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new LockError(`--${key} needs a value`, 2);
      out[key] = v;
    } else throw new LockError(`unknown option: --${key}`, 2);
  }
  return out;
}

export function run(argv, ctx = {}) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  switch (cmd) {
    case 'acquire': {
      const m = acquire(args, ctx);
      console.log(JSON.stringify({ runId: m.runId, start: m.start, end: m.end, expiry: m.expiry, resumable: m.resumable, lockPid: m.lockPid }, null, 2));
      if (m.lockPid === null) console.error('night-lock: warning: the sleep lock could not be started');
      return 0;
    }
    case 'claim':
      console.log(claim(args, ctx));
      return 0;
    case 'status':
      console.log(JSON.stringify(status(ctx), null, 2));
      return 0;
    case 'keepawake':
      console.log(JSON.stringify(keepawake(ctx)));
      return 0;
    case 'release':
      console.log(JSON.stringify(release(ctx)));
      return 0;
    default:
      throw new LockError('usage: night-lock.mjs acquire|claim|status|keepawake|release', 2);
  }
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    console.error(`night-lock: ${err.message}`);
    process.exitCode = err instanceof LockError ? err.code : 2;
  }
}
