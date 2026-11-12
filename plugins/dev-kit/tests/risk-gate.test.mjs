import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LOCK_FRESH_MS, LOCK_MAX_AGE_MS, acquireLock, gateLockPath, lockIsStale, resolveSteps, runGate } from '../scripts/gate.mjs';
import { analyzeFiles, analyzeRisk, parseAddedLines } from '../scripts/risk.mjs';
import { PROJECT, configFor, exitError, git, initRepo, mockExec, write } from './helpers.mjs';

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

describe('parseAddedLines', () => {
  test('collects added lines with numbers', () => {
    const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n ctx\n-old\n+new1\n+new2\n';
    assert.deepEqual(parseAddedLines(diff).get('x'), [
      { line: 2, text: 'new1' },
      { line: 3, text: 'new2' },
    ]);
  });
});

describe('risk on a real git repo', () => {
  const root = initRepo();
  write(root, '.claude/workflow.json', JSON.stringify(PROJECT));
  write(root, 'src/app.ts', 'export const a = 1;\n');
  write(root, 'src/migrations/001_init.sql', 'create table a (id int);\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'branch', 'base');
  git(root, 'switch', '-q', '-c', 'feature/x');
  write(root, 'src/auth/session.ts', 'export const s = 1;\n');
  write(root, 'src/migrations/001_init.sql', 'create table a (id int);\nDROP TABLE old;\n');
  write(root, 'src/generated/types.ts', 'export type X = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'change');
  write(root, 'src/app.ts', 'export const a = 2;\n'); // uncommitted change counts too

  test('detects risk paths, content, generated and immutable files', () => {
    const r = analyzeRisk({ cwd: root, base: 'base' });
    assert.equal(r.touchesRisk, true);
    assert.deepEqual(r.riskFiles, ['src/auth/session.ts']);
    assert.deepEqual(r.contentHits, [{ file: 'src/migrations/001_init.sql', line: 2, pattern: 'DROP TABLE' }]);
    assert.deepEqual(r.generatedTouched, ['src/generated/types.ts']);
    assert.deepEqual(r.immutableEdited, ['src/migrations/001_init.sql']);
    assert.ok(r.files.includes('src/app.ts'));
  });
  test('CLI --json works', () => {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'risk.mjs'), '--base', 'base', '--json'], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).touchesRisk, true);
  });
  test('clean diff is not risky', () => {
    const r = analyzeFiles({ config: configFor(root), files: ['README.md'], repoRoot: root });
    assert.equal(r.touchesRisk, false);
  });
  test('unknown base returns touchesRisk null with an error', () => {
    const r = analyzeRisk({ cwd: root, base: 'nope/nope' });
    assert.equal(r.touchesRisk, null);
    assert.match(r.error, /merge base/);
  });
  test('PR mode: a failed diff returns touchesRisk null', () => {
    const exec = mockExec({ 'gh pr diff': exitError(1) });
    const r = analyzeRisk({ cwd: root, config: configFor(root), pr: 5, prFiles: ['src/app.ts'], baseRefName: 'dev', exec });
    assert.equal(r.touchesRisk, null);
    assert.match(r.error, /gh pr diff/);
  });
  test('PR mode: a failed view returns touchesRisk null', () => {
    const r = analyzeRisk({ cwd: root, config: configFor(root), pr: 5, exec: mockExec({}) });
    assert.equal(r.touchesRisk, null);
  });
  test('CLI exits 2 when the analysis is unavailable', () => {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'risk.mjs'), '--base', 'nope/nope'], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 2);
  });
});

describe('gate step selection', () => {
  const config = configFor(os.tmpdir());
  const names = (steps) => steps.filter((s) => !s.skip).map((s) => s.name);
  test('full tier runs everything that applies', () => {
    const steps = resolveSteps({ config, changedFiles: ['src/migrations/002.sql', 'packages/mobile/app.ts'], tier: 'T3' });
    assert.deepEqual(names(steps), ['lint', 'test', 'e2e', 'migrations-check', 'packages/mobile: mobile-test']);
    assert.equal(steps.find((s) => s.name === 'build').skip, 'no command configured');
  });
  test('minTier and when are respected', () => {
    const steps = resolveSteps({ config, changedFiles: ['src/app.ts'], tier: 'T1' });
    assert.deepEqual(names(steps), ['lint', 'test']);
  });
  test('unknown diff runs every conditional step', () => {
    assert.deepEqual(names(resolveSteps({ config, changedFiles: null, tier: 'T3' })), ['lint', 'test', 'e2e', 'migrations-check', 'packages/mobile: mobile-test']);
  });
  test('--only selects one step', () => assert.deepEqual(names(resolveSteps({ config, changedFiles: [], tier: 'T3', only: 'test' })), ['test']));
  test('bad tier throws', () => assert.throws(() => resolveSteps({ config, changedFiles: [], tier: 'T9' })));
});

describe('gate CLI', () => {
  const root = initRepo();
  write(root, '.claude/workflow.json', JSON.stringify(PROJECT));
  write(root, '.gitignore', '.claude/state/\n');
  write(root, 'src/app.ts', '1\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'branch', 'base');
  write(root, 'src/migrations/002.sql', 'select 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'add migration');

  const gate = (...args) => spawnSync(process.execPath, [path.join(SCRIPTS, 'gate.mjs'), '--base', 'base', ...args], { cwd: root, encoding: 'utf8' });

  test('--dry-run prints the plan', () => {
    const r = gate('--dry-run', '--tier', 'T1');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /RUN {2}lint/);
    assert.match(r.stdout, /RUN {2}migrations-check/);
    assert.match(r.stdout, /SKIP e2e \(needs T2\)/);
    assert.match(r.stdout, /SKIP packages\/mobile: mobile-test/);
  });
  test('runs the steps and writes the result file', () => {
    const r = gate('--tier', 'T2');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS lint \d+\.\ds/);
    const sha = git(root, 'rev-parse', 'HEAD').trim();
    const result = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'state', 'gate', `${sha}.json`), 'utf8'));
    assert.equal(result.ok, true);
    assert.equal(result.sha, sha);
    assert.doesNotMatch(r.stdout, /not gitignored/);
  });
  test('--post-status refuses a dirty tree', () => {
    write(root, 'src/app.ts', '2\n');
    const r = gate('--post-status');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /uncommitted changes/);
    git(root, 'checkout', '--', 'src/app.ts');
  });
  test('--post-status refuses a commit that is not pushed', () => {
    const r = gate('--post-status');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /not on any remote branch/);
  });
  test('--post-status with --only is refused', () => {
    const r = gate('--post-status', '--only', 'lint');
    assert.equal(r.status, 2);
    assert.match(r.stdout, /--only/);
  });
  test('an unknown --only name is rejected', () => {
    const r = gate('--only', 'nope', '--dry-run');
    assert.equal(r.status, 2);
    assert.match(r.stdout, /unknown step "nope"/);
  });
  test('a known --only name runs just that step', () => {
    const r = gate('--only', 'lint');
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /PASS lint/);
    assert.doesNotMatch(r.stdout, /PASS test/);
  });
});

describe('gate --post-status', () => {
  // A repo with a bare remote, so `git branch -r --contains` finds the pushed commit.
  function pushedRepo(project) {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-remote-'));
    git(remote, 'init', '-q', '--bare');
    const root = initRepo();
    write(root, '.claude/workflow.json', JSON.stringify(project));
    write(root, '.gitignore', '.claude/state/\n');
    write(root, 'src/app.ts', '1\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', '-q', '-u', 'origin', 'dev');
    return root;
  }
  const base = { ...PROJECT, subprojects: [], gate: { steps: ['lint', 'test'], statusContext: 'local-gate' } };
  const lockPath = path.join(os.tmpdir(), `devkit-gate-test-${process.pid}.lock`);
  const ghMock = () => {
    const calls = [];
    const fn = (file, args) => {
      calls.push(args);
      return args[0] === 'repo' ? JSON.stringify({ nameWithOwner: 'acme/app' }) : '{}';
    };
    fn.calls = calls;
    return fn;
  };

  test('posts the tier in the status description', async () => {
    const root = pushedRepo(base);
    const gh = ghMock();
    const logs = [];
    const code = await runGate({ tier: 'T2', postStatus: true, base: 'origin/dev' }, { cwd: root, gh, log: (m) => logs.push(m), lockPath });
    assert.equal(code, 0, logs.join('\n'));
    const post = gh.calls.find((a) => a[0] === 'api');
    assert.ok(post.includes('state=success'));
    assert.ok(post.includes('description=T2: 2 steps passed locally'));
    const sha = git(root, 'rev-parse', 'HEAD').trim();
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.claude', 'state', 'gate', `${sha}.json`), 'utf8')).tier, 'T2');
  });
  test('refuses to post success when zero steps ran', async () => {
    const root = pushedRepo({ ...base, gate: { steps: [] } });
    const gh = ghMock();
    const logs = [];
    const code = await runGate({ tier: 'T2', postStatus: true, base: 'origin/dev' }, { cwd: root, gh, log: (m) => logs.push(m), lockPath });
    assert.equal(code, 1);
    assert.match(logs.join('\n'), /zero steps executed/);
    assert.equal(gh.calls.length, 0);
  });
  test('posts nothing when the tree changes during the gate', async () => {
    const root = pushedRepo({ ...base, gate: { steps: [{ name: 'dirty', run: 'node -e "require(\'fs\').writeFileSync(\'src/new.ts\', \'x\')"' }] } });
    const gh = ghMock();
    const logs = [];
    const code = await runGate({ tier: 'T2', postStatus: true, base: 'origin/dev' }, { cwd: root, gh, log: (m) => logs.push(m), lockPath });
    assert.equal(code, 1);
    assert.match(logs.join('\n'), /tree changed during gate/);
    assert.equal(gh.calls.length, 0);
  });
});

describe('gate lock', () => {
  test('a stale lock from a dead pid is taken over', async () => {
    const lock = path.join(os.tmpdir(), `devkit-lock-test-${process.pid}.lock`);
    fs.writeFileSync(lock, JSON.stringify({ pid: 999999999, host: os.hostname() }));
    const release = await acquireLock(lock, { pollMs: 10, waitMs: 1000, log: () => {} });
    const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.match(owner.token, /^[0-9a-f]{32}$/);
    assert.ok(owner.started && owner.host);
    release();
    assert.equal(fs.existsSync(lock), false);
  });
  test('release leaves a lock that another owner took over', async () => {
    const lock = path.join(os.tmpdir(), `devkit-lock-test3-${process.pid}.lock`);
    const release = await acquireLock(lock, { pollMs: 10, waitMs: 1000, log: () => {} });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'someone-else' }));
    release();
    assert.equal(fs.existsSync(lock), true);
    fs.unlinkSync(lock);
  });
  test('an empty fresh lock counts as live', async () => {
    const lock = path.join(os.tmpdir(), `devkit-lock-test4-${process.pid}.lock`);
    fs.writeFileSync(lock, '');
    await assert.rejects(acquireLock(lock, { pollMs: 10, waitMs: 50, log: () => {} }), /still held/);
    fs.unlinkSync(lock);
  });
  test('staleness rules', () => {
    const alive = () => true;
    const dead = () => false;
    assert.equal(lockIsStale(null, 1000, { alive }), false);
    assert.equal(lockIsStale(null, LOCK_FRESH_MS + 1, { alive }), true);
    assert.equal(lockIsStale({ pid: 5, host: 'here' }, 1000, { host: 'here', alive: dead }), true);
    assert.equal(lockIsStale({ pid: 5, host: 'here' }, 1000, { host: 'here', alive }), false);
    assert.equal(lockIsStale({ pid: 5, host: 'other' }, 1000, { host: 'here', alive: dead }), false);
    assert.equal(lockIsStale({ pid: 5, host: 'here' }, LOCK_MAX_AGE_MS + 1, { host: 'here', alive }), true);
  });
  test('the lock is machine-wide', () => assert.equal(path.basename(gateLockPath()), 'dev-kit-gate.lock'));
  test('a live lock makes the caller wait and then time out', async () => {
    const lock = path.join(os.tmpdir(), `devkit-lock-test2-${process.pid}.lock`);
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname() }));
    const logs = [];
    await assert.rejects(acquireLock(lock, { pollMs: 10, waitMs: 50, log: (m) => logs.push(m) }), /still held/);
    assert.match(logs[0], /waiting for gate lock/);
    fs.unlinkSync(lock);
  });
});
