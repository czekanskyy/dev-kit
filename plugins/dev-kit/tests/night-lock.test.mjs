import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeRepo } from './helpers.mjs';
import { buildMarker, markerPath, readMarker, writeMarker } from '../scripts/lib/night.mjs';
import { acquire, claim, keepawake, lockPlan, release, spawnDetached, status } from '../scripts/night-lock.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'night-lock.mjs');
const HOUR = 3600 * 1000;
const NOW = Date.parse('2030-01-01T10:00:00.000Z');

/** Fake process table: a spawner that hands out pids, plus matching isAlive and kill. */
function fakeProcs() {
  const alive = new Set();
  const plans = [];
  const killed = [];
  let next = 4000;
  return {
    plans,
    killed,
    alive,
    spawner: (plan) => {
      plans.push(plan);
      alive.add(++next);
      return next;
    },
    isAlive: (pid) => alive.has(pid),
    kill: (pid) => {
      killed.push(pid);
      alive.delete(pid);
    },
  };
}

function setup(extra = {}) {
  const root = fakeRepo('devkit-lock-');
  const procs = fakeProcs();
  const ctx = { cwd: root, now: NOW, platform: 'linux', maxRunHours: 12, ...procs, ...extra };
  return { root, procs, ctx, file: markerPath(root) };
}

describe('acquire', () => {
  test('writes the marker and the status reports the lock alive', () => {
    const { ctx, file, procs } = setup();
    const m = acquire({ for: 2, resumable: true }, ctx);
    const onDisk = readMarker(file, { now: NOW });
    assert.equal(onDisk.runId, m.runId);
    assert.equal(onDisk.start, new Date(NOW).toISOString());
    assert.equal(onDisk.end, new Date(NOW + 2 * HOUR).toISOString());
    assert.equal(onDisk.expiry, new Date(NOW + 2 * HOUR + 30 * 60 * 1000).toISOString());
    assert.equal(onDisk.resumable, true);
    assert.deepEqual(onDisk.sessions, []);
    assert.equal(onDisk.lockPid, 4001);
    const s = status(ctx);
    assert.equal(s.valid, true);
    assert.equal(s.runId, m.runId);
    assert.equal(s.lockAlive, true);
    assert.equal(procs.plans.length, 1);
  });

  test('--until HH:MM and ISO times, --start', () => {
    const { ctx } = setup();
    const iso = new Date(NOW + 3 * HOUR).toISOString();
    assert.equal(acquire({ until: iso }, ctx).end, iso);
    release(ctx);
    const m = acquire({ for: 1, start: new Date(NOW + HOUR).toISOString() }, ctx);
    assert.equal(m.start, new Date(NOW + HOUR).toISOString());
    assert.equal(m.end, new Date(NOW + 2 * HOUR).toISOString());
    release(ctx);
    const d = new Date(NOW + 2 * HOUR);
    const hhmm = acquire({ until: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }, ctx);
    assert.equal(Date.parse(hhmm.end), d.getTime());
    release(ctx);
    assert.throws(() => acquire({ until: '25:00' }, ctx), /valid time/);
  });

  test('refuses a box longer than maxRunHours', () => {
    const { ctx, file } = setup();
    assert.throws(() => acquire({ for: 13 }, ctx), /longer than/);
    assert.throws(() => acquire({ until: new Date(NOW + 20 * HOUR).toISOString() }, ctx), /longer than/);
    assert.equal(fs.existsSync(file), false);
    assert.equal(acquire({ for: 12 }, ctx).runId.length > 0, true);
  });

  test('refuses an end in the past, no arguments and conflicting arguments', () => {
    const { ctx, file } = setup();
    assert.throws(() => acquire({ until: new Date(NOW - HOUR).toISOString() }, ctx), /past/);
    assert.throws(() => acquire({}, ctx), /--until|--for/);
    assert.throws(() => acquire({ until: '23:00', for: 2 }, ctx), /either/);
    assert.throws(() => acquire({ for: 0 }, ctx), /positive/);
    assert.throws(() => acquire({ until: 'nonsense' }, ctx), /time/);
    assert.equal(fs.existsSync(file), false);
  });

  test('refuses a second marker while one is valid, allows it once expired', () => {
    const { ctx } = setup();
    const first = acquire({ for: 1 }, ctx);
    assert.throws(() => acquire({ for: 1 }, ctx), /already/);
    assert.equal(status(ctx).runId, first.runId);
    const later = { ...ctx, now: NOW + 3 * HOUR };
    assert.notEqual(acquire({ for: 1 }, later).runId, first.runId);
  });

  test('run ids are unique, even within one millisecond', () => {
    const { ctx } = setup();
    const ids = new Set();
    for (let i = 0; i < 20; i++) {
      ids.add(acquire({ for: 1 }, ctx).runId);
      release(ctx);
    }
    assert.equal(ids.size, 20);
  });

  test('a failed spawn still arms the run, with a null lock pid', () => {
    const { ctx, file } = setup({ spawner: () => null });
    acquire({ for: 1 }, ctx);
    assert.equal(readMarker(file, { now: NOW }).lockPid, null);
    assert.equal(status(ctx).lockAlive, false);
  });
});

describe('claim', () => {
  test('prints the run id inside the window', () => {
    const { ctx } = setup();
    const m = acquire({ for: 2 }, ctx);
    assert.equal(claim({ run: m.runId }, { ...ctx, now: NOW + HOUR }), m.runId);
  });

  test('fails without a marker, with another run id, before start and after end', () => {
    const { ctx } = setup();
    assert.throws(() => claim({ run: 'x' }, ctx), /no valid/i);
    const m = acquire({ for: 1, start: new Date(NOW + HOUR).toISOString() }, ctx);
    assert.throws(() => claim({ run: m.runId }, ctx), /not started|before/i);
    assert.throws(() => claim({ run: 'other' }, { ...ctx, now: NOW + 2 * HOUR - 1000 }), /run id/i);
    assert.throws(() => claim({}, { ...ctx, now: NOW + 2 * HOUR - 1000 }), /--run/);
    assert.throws(() => claim({ run: m.runId }, { ...ctx, now: NOW + 2 * HOUR + 1000 }), /ended|after/i);
    assert.equal(claim({ run: m.runId }, { ...ctx, now: NOW + 2 * HOUR - 1000 }), m.runId);
  });

  test('does not register a session itself', () => {
    const { ctx, file } = setup();
    const m = acquire({ for: 1 }, ctx);
    claim({ run: m.runId }, ctx);
    assert.deepEqual(readMarker(file, { now: NOW }).sessions, []);
  });
});

describe('keepawake and release', () => {
  test('keepawake restarts a dead child and leaves the marker byte-identical', () => {
    const { ctx, file, procs } = setup();
    const m = acquire({ for: 2 }, ctx);
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(keepawake(ctx).restarted, false);
    procs.alive.clear();
    assert.equal(status(ctx).lockAlive, false);
    const later = { ...ctx, now: NOW + HOUR };
    const r = keepawake(later);
    assert.equal(r.restarted, true);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(status(later).lockAlive, true);
    assert.equal(procs.plans.length, 2);
    assert.ok(procs.plans[1].seconds <= procs.plans[0].seconds - 3600 + 1);
    assert.equal(status(later).runId, m.runId);
  });

  test('keepawake without a valid marker fails', () => {
    const { ctx } = setup();
    assert.throws(() => keepawake(ctx), /no valid/i);
  });

  test('release kills the lock child (also a restarted one) and removes the marker', () => {
    const { ctx, file, procs } = setup();
    acquire({ for: 2 }, ctx);
    procs.alive.clear();
    keepawake(ctx);
    assert.equal(procs.alive.size, 1);
    const r = release(ctx);
    assert.equal(r.released, true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(procs.alive.size, 0);
    assert.ok(procs.killed.length >= 1);
    assert.equal(status(ctx).valid, false);
    assert.equal(release(ctx).released, false);
  });
});

describe('platform branches', () => {
  const END = NOW + HOUR;
  test('windows: hidden powershell with an encoded SetThreadExecutionState script', () => {
    const p = lockPlan('win32', END, NOW);
    assert.match(p.command, /powershell/i);
    assert.ok(p.args.includes('-EncodedCommand'));
    const script = Buffer.from(p.args[p.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    assert.match(script, /SetThreadExecutionState/);
    assert.match(script, new RegExp(String(END)));
  });
  test('macos: caffeinate with a duration', () => {
    const p = lockPlan('darwin', NOW + 90 * 1000, NOW);
    assert.equal(p.command, 'caffeinate');
    assert.equal(p.args[p.args.indexOf('-t') + 1], '90');
  });
  test('linux: systemd-inhibit around sleep', () => {
    const p = lockPlan('linux', NOW + 90 * 1000, NOW);
    assert.equal(p.command, 'systemd-inhibit');
    assert.deepEqual(p.args.slice(-2), ['sleep', '90']);
  });
  test('acquire passes the platform plan to the spawner', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const { ctx, procs } = setup({ platform });
      acquire({ for: 1 }, ctx);
      assert.equal(procs.plans[0].platform, platform);
    }
  });
});

describe('real process', () => {
  const pidAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test('a 2 second box leaves no process and no marker', async (t) => {
    const probe = process.platform === 'darwin' ? 'caffeinate' : process.platform === 'linux' ? 'systemd-inhibit' : null;
    if (probe && spawnSync(probe, ['--version'], { stdio: 'ignore' }).error) return t.skip(`${probe} not available`);
    const root = fakeRepo('devkit-lock-real-');
    const ctx = { cwd: root, graceMs: 0, maxRunHours: 12, spawner: spawnDetached };
    const t0 = Date.now();
    const m = acquire({ for: 2 / 3600 }, ctx);
    const pid = m.lockPid;
    try {
      assert.ok(Number.isInteger(pid));
      const early = status(ctx);
      // On a loaded machine the 2 second box can run out before this check; only assert while it is open.
      if (Date.now() - t0 < 1500) assert.equal(early.lockAlive, true);
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline && pidAlive(pid)) await new Promise((r) => setTimeout(r, 250));
      assert.equal(pidAlive(pid), false, 'lock child ended itself');
      const s = status(ctx);
      assert.equal(s.valid, false);
      assert.equal(fs.existsSync(markerPath(root)), false, 'expired marker removed');
    } finally {
      if (pidAlive(pid)) process.kill(pid);
    }
  });
});

describe('cli', () => {
  const run = (cwd, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });

  test('claim fails closed (exit 1, no run id printed) when the marker lock cannot be taken', () => {
    const root = fakeRepo('devkit-lock-cli-');
    const now = Date.now();
    const file = markerPath(root);
    writeMarker(file, buildMarker({ runId: 'r1', start: now - 1000, end: now + 3600000 }));
    fs.writeFileSync(`${file}.lock`, `${process.pid}\n`); // held by a live owner (this test process)
    const r = spawnSync(process.execPath, [SCRIPT, 'claim', '--run', 'r1'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, DEVKIT_NIGHT_LOCK_WAIT_MS: '300' },
    });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stdout.trim(), '');
    assert.match(r.stderr, /locked/i);
  });

  test('claim exits 1 with a message when there is no marker', () => {
    const root = fakeRepo('devkit-lock-cli-');
    const r = run(root, 'claim', '--run', 'abc');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no valid/i);
  });

  test('status prints JSON, bad usage exits 2', () => {
    const root = fakeRepo('devkit-lock-cli-');
    const r = run(root, 'status');
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).valid, false);
    assert.equal(run(root, 'bogus').status, 2);
    assert.equal(run(root, 'acquire').status, 2);
  });

  test('acquire refuses a box longer than the maximum', () => {
    const root = fakeRepo('devkit-lock-cli-');
    const r = run(root, 'acquire', '--for', '13');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /longer than/);
  });
});
