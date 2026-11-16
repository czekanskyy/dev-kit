import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROJECT, configFor, fakeRepo, write } from './helpers.mjs';
import {
  applySet,
  decideUsage,
  emptyState,
  nextTask,
  parseQueue,
  routeFor,
  summarize,
  heartbeatBlocks,
  stateForQueue,
  validateQueue,
  withSpecTiers,
} from '../scripts/queue.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'queue.mjs');
const LIMITS = { lowerEffortAt: 75, warnAt: 90, stopAt: 95, nightWindowPauseAt: 90 };

const ACCEPTED_SPEC = '# S\n\nTier: T2. Status: accepted (no task started).\n\n## Decisions\n| # | Q | Status | Choice |\n|---|---|---|---|\n| D1 | x | Decided | y |\n';

function repoWith(specs = {}) {
  const root = fakeRepo('devkit-queue-');
  write(root, 'specs/ok.md', ACCEPTED_SPEC);
  for (const [name, text] of Object.entries(specs)) write(root, `specs/${name}.md`, text);
  return root;
}

// Builds one queue block. `extra` is "key: value" lines overriding the defaults; a value of "-" drops the key.
function task(id, extra = '') {
  const base = { tier: 'T1', brief: 'do it', specTier: 'none', decisions: 'none', dependsOn: 'none', merge: 'yes' };
  const over = Object.fromEntries(
    extra
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.split(':')[0].trim(), l.slice(l.indexOf(':') + 1).trim()]),
  );
  const all = { ...base, ...over };
  const body = Object.entries(all)
    .filter(([, v]) => v !== '-')
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');
  return `## ${id}: Title ${id}\n${body}\n`;
}

function queueText(...blocks) {
  return `Planned 2026-11-16, weekly usage 40%\n\n${blocks.join('\n')}`;
}

function rules(text, root) {
  return validateQueue({ text, config: configFor(root), repoRoot: root }).map((f) => `${f.id}:${f.rule}`);
}

function runCli(root, ...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8' });
}

function cliRepo(text = queueText(task('a')), cfg = PROJECT) {
  const root = repoWith();
  write(root, '.claude/workflow.json', JSON.stringify(cfg));
  write(root, 'queue/night.md', text);
  return root;
}

function ageHeartbeat(root, ms = 60 * 60 * 1000) {
  const file = path.join(root, 'queue/night-state.json');
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  st.run.heartbeat.at = new Date(Date.now() - ms).toISOString();
  fs.writeFileSync(file, JSON.stringify(st));
}

function linkedWorktree(root, cfg) {
  const wt = path.join(root, 'wt', 'task-1');
  fs.mkdirSync(wt, { recursive: true });
  fs.mkdirSync(path.join(root, '.git', 'worktrees', 'task-1'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(root, '.git', 'worktrees', 'task-1')}\n`);
  write(wt, '.claude/workflow.json', JSON.stringify(cfg));
  return wt;
}

function readState(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'queue/night-state.json'), 'utf8'));
}

describe('validate rules', () => {
  const root = repoWith({
    draft: '# S\n\nTier: T2. Status: draft\n',
    open: '# S\n\nTier: T2. Status: accepted\n\n| D1 | q | Needs decision | a |\n',
  });

  test('a clean queue has no failures', () => {
    assert.deepEqual(rules(queueText(task('a'), task('b', 'tier: T2\nspec: specs/ok.md#1\nbrief: -\ndependsOn: a')), root), []);
  });

  test('unknown tier', () => {
    assert.deepEqual(rules(queueText(task('a', 'tier: T9')), root), ['a:unknown-tier']);
  });

  test('T2 or T3 without a spec', () => {
    assert.deepEqual(rules(queueText(task('a', 'tier: T2'), task('b', 'tier: T3')), root), ['a:spec-required', 'b:spec-required']);
  });

  test('spec file missing', () => {
    assert.deepEqual(rules(queueText(task('a', 'tier: T2\nspec: specs/nope.md#1\nbrief: -')), root), ['a:spec-missing']);
  });

  test('spec not accepted', () => {
    assert.deepEqual(rules(queueText(task('a', 'tier: T2\nspec: specs/draft.md#1\nbrief: -')), root), ['a:spec-not-accepted']);
  });

  test('spec holding a Needs decision row', () => {
    assert.deepEqual(rules(queueText(task('a', 'tier: T2\nspec: specs/open.md#1\nbrief: -')), root), ['a:spec-needs-decision']);
  });

  test('missing merge field', () => {
    assert.deepEqual(rules(queueText(task('a', 'merge: -')), root), ['a:merge-missing']);
    assert.deepEqual(rules(queueText(task('b', 'merge: maybe')), root), ['b:merge-missing']);
  });

  test('dependency on an unknown task', () => {
    assert.deepEqual(rules(queueText(task('a', 'dependsOn: zz')), root), ['a:dependency-unknown']);
  });

  test('dependency on a later task', () => {
    assert.deepEqual(rules(queueText(task('a', 'dependsOn: b'), task('b')), root), ['a:dependency-later']);
  });

  test('hotfix task', () => {
    assert.deepEqual(rules(queueText(task('a', 'hotfix: yes')), root), ['a:hotfix']);
  });

  test('base other than the integration branch', () => {
    assert.deepEqual(rules(queueText(task('a', 'base: main')), root), ['a:base-not-integration']);
    assert.deepEqual(rules(queueText(task('b', `base: ${PROJECT.branches.integration}`)), root), []);
  });

  test('duplicate id', () => {
    assert.deepEqual(rules(queueText(task('a'), task('a')), root), ['a:duplicate-id']);
  });
});

describe('validate CLI', () => {
  test('exits 1 naming task and rule, 0 when clean', () => {
    const root = repoWith();
    write(root, '.claude/workflow.json', JSON.stringify({ ...PROJECT, night: { merge: 'none' } }));
    write(root, 'queue/night.md', queueText(task('a', 'tier: T9')));
    let r = runCli(root, 'validate');
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /a: unknown-tier/);
    write(root, 'queue/night.md', queueText(task('a')));
    r = runCli(root, 'validate');
    assert.equal(r.status, 0, r.stderr);
  });
});

describe('usage decision', () => {
  const at = (weekly, window = 10) => decideUsage({ weekly, window }, LIMITS);
  test('74 continues', () => assert.equal(at(74), 'continue'));
  test('75 lowers effort', () => assert.equal(at(75), 'lowerEffort'));
  test('89 lowers effort', () => assert.equal(at(89), 'lowerEffort'));
  test('90 only low tiers', () => assert.equal(at(90), 'onlyLow'));
  test('94 only low tiers', () => assert.equal(at(94), 'onlyLow'));
  test('95 stops', () => assert.equal(at(95), 'stop'));
  test('window at the pause mark pauses', () => {
    assert.equal(at(10, 89), 'continue');
    assert.equal(at(10, 90), 'pause');
  });
  test('stop beats pause', () => assert.equal(at(96, 99), 'stop'));
  test('unreadable input', () => {
    for (const bad of [{}, { weekly: 'x', window: 5 }, { weekly: 5 }, { weekly: -1, window: 5 }, { weekly: 5, window: 101 }, null]) {
      assert.equal(decideUsage(bad, LIMITS), 'unreadable');
    }
  });
  test('CLI prints the decision, records it, unreadable exits 3 with a reason in the state', () => {
    const root = repoWith();
    write(root, '.claude/workflow.json', JSON.stringify(PROJECT));
    write(root, 'queue/night.md', queueText(task('a')));
    let r = runCli(root, 'usage', '--window', '10', '--weekly', '75');
    assert.equal(r.stdout.trim(), 'lowerEffort');
    r = runCli(root, 'usage', '--window', 'n/a', '--weekly', '10');
    assert.equal(r.stdout.trim(), 'unreadable');
    assert.equal(r.status, 3);
    assert.ok(readState(root).run.unreadableReason);
  });
});

function parsed(...blocks) {
  return parseQueue(queueText(...blocks)).tasks;
}

describe('state transitions', () => {
  const tasks = parsed(task('a'), task('b'));
  const fresh = () => emptyState(tasks);
  const go = (state, id, status, opts = {}) => applySet(state, tasks, id, status, opts);

  test('all tasks start pending', () => {
    assert.equal(fresh().tasks.a.status, 'pending');
  });
  test('pending to running', () => assert.equal(go(fresh(), 'a', 'running').tasks.a.status, 'running'));
  test('running to merged', () => assert.equal(go(go(fresh(), 'a', 'running'), 'a', 'merged').tasks.a.status, 'merged'));
  test('running to open with a PR', () => {
    const s = go(go(fresh(), 'a', 'running'), 'a', 'open', { pr: 'https://example.test/pr/1' });
    assert.equal(s.tasks.a.status, 'open');
    assert.equal(s.tasks.a.pr, 'https://example.test/pr/1');
  });
  test('running to waiting', () => assert.equal(go(go(fresh(), 'a', 'running'), 'a', 'waiting').tasks.a.status, 'waiting'));
  test('running to deferred keeps the reason', () => {
    const s = go(go(fresh(), 'a', 'running'), 'a', 'deferred', { reason: 'gate: red twice' });
    assert.equal(s.tasks.a.reason, 'gate: red twice');
  });
  test('pending to deferred', () => assert.equal(go(fresh(), 'a', 'deferred', { reason: 'depends on x' }).tasks.a.status, 'deferred'));
  test('deferred needs a reason', () => assert.throws(() => go(fresh(), 'a', 'deferred'), /reason/));
  test('running to interrupted, then running again', () => {
    const s = go(go(fresh(), 'a', 'running'), 'a', 'interrupted');
    assert.equal(s.tasks.a.status, 'interrupted');
    assert.equal(go(s, 'a', 'running').tasks.a.status, 'running');
  });
  test('illegal transitions throw', () => {
    assert.throws(() => go(fresh(), 'a', 'merged'), /pending/);
    assert.throws(() => go(go(fresh(), 'a', 'running'), 'a', 'pending'), /not allowed/);
    assert.throws(() => go(go(go(fresh(), 'a', 'running'), 'a', 'merged'), 'a', 'running'), /merged/);
  });
  test('unknown task and unknown status throw', () => {
    assert.throws(() => go(fresh(), 'zz', 'running'), /unknown task/);
    assert.throws(() => go(fresh(), 'a', 'bogus'), /status/);
  });
  test('input state is not mutated', () => {
    const s = fresh();
    go(s, 'a', 'running');
    assert.equal(s.tasks.a.status, 'pending');
  });
});

describe('notified flag', () => {
  const tasks = parsed(task('a'));
  test('the second notification is blocked', () => {
    let s = applySet(emptyState(tasks), tasks, 'a', 'running');
    s = applySet(s, tasks, 'a', 'waiting', { pr: 'https://example.test/pr/1', notified: true });
    assert.equal(s.tasks.a.notified, true);
    assert.throws(() => applySet(s, tasks, 'a', 'waiting', { notified: true }), /already notified/);
  });
  test('CLI exits 1 on the second --notified', () => {
    const root = repoWith();
    write(root, '.claude/workflow.json', JSON.stringify(PROJECT));
    write(root, 'queue/night.md', queueText(task('a')));
    assert.equal(runCli(root, 'set', 'a', 'running').status, 0);
    assert.equal(runCli(root, 'set', 'a', 'waiting', '--pr', 'https://example.test/pr/1', '--notified').status, 0);
    const second = runCli(root, 'set', 'a', 'waiting', '--notified');
    assert.equal(second.status, 1);
    assert.match(second.stderr, /already notified/);
  });
});

describe('set never changes merge', () => {
  test('the queue file and the state carry no merge change', () => {
    const root = repoWith();
    write(root, '.claude/workflow.json', JSON.stringify(PROJECT));
    const text = queueText(task('a', 'merge: no'));
    write(root, 'queue/night.md', text);
    assert.equal(runCli(root, 'set', 'a', 'running').status, 0);
    assert.equal(runCli(root, 'set', 'a', 'open', '--pr', 'u').status, 0);
    assert.equal(fs.readFileSync(path.join(root, 'queue/night.md'), 'utf8'), text);
    assert.ok(!JSON.stringify(readState(root)).includes('"merge"'));
    assert.notEqual(runCli(root, 'set', 'a', 'open', '--merge', 'yes').status, 0);
  });
});

describe('routes', () => {
  const t = (extra) => parsed(task('a', extra))[0];
  for (const level of ['none', 'lowRisk']) {
    const config = { night: { merge: level }, branches: { integration: 'dev' } };
    test(`T3 spec is waiting at ${level}`, () => {
      assert.equal(routeFor(t('tier: T1\nspecTier: T3'), config, { risk: false }), 'waiting');
      assert.equal(routeFor(t('tier: T3\nspec: specs/ok.md#1\nbrief: -'), config, { risk: false }), 'waiting');
    });
    test(`risk path is waiting at ${level}`, () => {
      assert.equal(routeFor(t('tier: T1'), config, { risk: true }), 'waiting');
    });
  }
  test('none never gives merge', () => {
    const config = { night: { merge: 'none' } };
    for (const tier of ['T0', 'T1', 'T2']) {
      assert.equal(routeFor(t(`tier: ${tier}\nspec: specs/ok.md#1\nbrief: -`), config, { risk: false }), 'open');
    }
    assert.equal(routeFor(t('tier: T1'), {}, { risk: false }), 'open');
  });
  test('lowRisk merges only T0/T1, no risk, merge yes', () => {
    const config = { night: { merge: 'lowRisk' } };
    assert.equal(routeFor(t('tier: T0'), config, { risk: false }), 'merge');
    assert.equal(routeFor(t('tier: T1'), config, { risk: false }), 'merge');
    assert.equal(routeFor(t('tier: T1\nmerge: no'), config, { risk: false }), 'open');
    assert.equal(routeFor(t('tier: T2\nspec: specs/ok.md#1\nbrief: -'), config, { risk: false }), 'open');
    assert.equal(routeFor(t('tier: T1'), config, { risk: undefined }), 'open');
  });
});

describe('next', () => {
  const config = { night: { merge: 'lowRisk' } };
  test('returns the first pending task with its route', () => {
    const tasks = parsed(task('a'), task('b'));
    const r = nextTask({ tasks, state: emptyState(tasks), config });
    assert.equal(r.task.id, 'a');
    assert.equal(r.route, 'open');
    assert.deepEqual(r.deferred, []);
  });
  test('a dependent of a waiting task is deferred while an independent one is returned', () => {
    const tasks = parsed(task('a'), task('b', 'dependsOn: a'), task('c'));
    let s = emptyState(tasks);
    s = applySet(applySet(s, tasks, 'a', 'running'), tasks, 'a', 'waiting');
    const r = nextTask({ tasks, state: s, config });
    assert.equal(r.task.id, 'c');
    assert.deepEqual(r.deferred, [{ id: 'b', reason: 'depends on a' }]);
  });
  test('a dependent of a merged task runs', () => {
    const tasks = parsed(task('a'), task('b', 'dependsOn: a'));
    let s = emptyState(tasks);
    s = applySet(applySet(s, tasks, 'a', 'running'), tasks, 'a', 'merged');
    assert.equal(nextTask({ tasks, state: s, config }).task.id, 'b');
  });
  test('an unmerged dependency defers its dependents, transitively', () => {
    const tasks = parsed(task('a'), task('b', 'dependsOn: a'), task('c', 'dependsOn: b'));
    let s = emptyState(tasks);
    s = applySet(applySet(s, tasks, 'a', 'running'), tasks, 'a', 'open');
    const r = nextTask({ tasks, state: s, config });
    assert.equal(r.task, null);
    assert.deepEqual(r.deferred.map((d) => d.id), ['b', 'c']);
    assert.equal(r.deferred[1].reason, 'depends on b');
  });
  test('an interrupted task is picked up again', () => {
    const tasks = parsed(task('a'), task('b'));
    let s = emptyState(tasks);
    s = applySet(applySet(s, tasks, 'a', 'running'), tasks, 'a', 'interrupted');
    assert.equal(nextTask({ tasks, state: s, config }).task.id, 'a');
  });
  test('a running task means nothing else starts', () => {
    const tasks = parsed(task('a'), task('b'));
    const s = applySet(emptyState(tasks), tasks, 'a', 'running');
    const r = nextTask({ tasks, state: s, config });
    assert.equal(r.task, null);
    assert.match(r.reason, /running a/);
  });
  test('CLI next persists deferrals and prints JSON', () => {
    const root = repoWith();
    write(root, '.claude/workflow.json', JSON.stringify({ ...PROJECT, night: { merge: 'none' } }));
    write(root, 'queue/night.md', queueText(task('a'), task('b', 'dependsOn: a'), task('c')));
    runCli(root, 'set', 'a', 'running');
    runCli(root, 'set', 'a', 'waiting', '--pr', 'u');
    const r = runCli(root, 'next');
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.task.id, 'c');
    assert.equal(out.route, 'open');
    const state = readState(root);
    assert.equal(state.tasks.b.status, 'deferred');
    assert.equal(state.tasks.b.reason, 'depends on a');
  });
});

describe('summary', () => {
  test('counts, per-task rows and not started', () => {
    const tasks = parsed(task('a'), task('b'));
    const s = applySet(applySet(emptyState(tasks), tasks, 'a', 'running'), tasks, 'a', 'waiting', { pr: 'u' });
    const out = summarize({ tasks, state: s });
    assert.equal(out.counts.waiting, 1);
    assert.deepEqual(out.notStarted, ['b']);
    assert.equal(out.tasks[0].pr, 'u');
    assert.equal(out.tasks[0].tier, 'T1');
  });
});

describe('spec header (tier and status)', () => {
  const root = repoWith({
    t3: '# S\n\nTier: T3. Status: accepted\n',
    progress: '# S\n\nTier: T2. Status: in progress (task 1 merged)\n',
    draft: '# S\n\nTier: T2. Status: draft\n',
    bodyOnly: '# S\n\nTier: T2.\n\nLater text says Status: accepted in the body.\n',
    noHeader: '# S\n\nStatus: accepted\n',
  });
  const link = (name) => task('a', `tier: T2\nspec: specs/${name}.md#1\nbrief: -`);

  test('a T1 task linking a T3 spec with no specTier line routes waiting under lowRisk', () => {
    const text = queueText(task('a', 'spec: specs/t3.md#1\nspecTier: -'));
    assert.deepEqual(rules(text, root), []);
    const [t] = withSpecTiers(parseQueue(text).tasks, { paths: { specs: 'specs/' } }, root);
    assert.equal(t.specTier, 'T3');
    assert.equal(routeFor(t, { night: { merge: 'lowRisk' } }, { risk: false }), 'waiting');
  });
  test('CLI next uses the derived tier', () => {
    const r2 = repoWith({ t3: '# S\n\nTier: T3. Status: accepted\n' });
    write(r2, '.claude/workflow.json', JSON.stringify({ ...PROJECT, night: { merge: 'lowRisk' } }));
    write(r2, 'queue/night.md', queueText(task('a', 'spec: specs/t3.md#1\nspecTier: -')));
    assert.equal(JSON.parse(runCli(r2, 'next').stdout).route, 'waiting');
  });
  test('a differing specTier line fails with spec-tier-mismatch, a matching one passes', () => {
    assert.deepEqual(rules(queueText(task('a', 'spec: specs/t3.md#1\nspecTier: T1')), root), ['a:spec-tier-mismatch']);
    assert.deepEqual(rules(queueText(task('a', 'spec: specs/t3.md#1\nspecTier: T3')), root), []);
  });
  test('accepted and in progress pass', () => {
    assert.deepEqual(rules(queueText(link('ok')), root), []);
    assert.deepEqual(rules(queueText(link('progress')), root), []);
  });
  test('draft, status only in the body, and a missing header line fail', () => {
    for (const name of ['draft', 'bodyOnly', 'noHeader']) assert.deepEqual(rules(queueText(link(name)), root), ['a:spec-not-accepted'], name);
  });
  test('a spec outside paths.specs fails', () => {
    write(root, 'docs/elsewhere.md', ACCEPTED_SPEC);
    assert.deepEqual(rules(queueText(task('a', 'tier: T2\nspec: docs/elsewhere.md#1\nbrief: -')), root), ['a:spec-outside-specs']);
    assert.deepEqual(rules(queueText(task('a', 'tier: T2\nspec: specs/../docs/elsewhere.md#1\nbrief: -')), root), ['a:spec-outside-specs']);
  });
});

describe('base without an integration branch', () => {
  test('a base fails when branches.integration is unset', () => {
    const root = repoWith();
    const config = configFor(root, { ...PROJECT, branches: { protected: ['main'], remote: 'origin' } });
    const failures = validateQueue({ text: queueText(task('a', 'base: dev')), config, repoRoot: root });
    assert.deepEqual(failures.map((f) => f.rule), ['base-not-integration']);
  });
});

describe('state belongs to one queue', () => {
  test('a new queue with reused ids gets a fresh state; the same queue keeps its state', () => {
    const root = repoWith();
    write(root, '.claude/workflow.json', JSON.stringify(PROJECT));
    write(root, 'queue/night.md', queueText(task('a')));
    runCli(root, 'set', 'a', 'running');
    runCli(root, 'set', 'a', 'open', '--pr', 'https://example.test/pr/1');
    assert.equal(JSON.parse(runCli(root, 'summary').stdout).tasks[0].pr, 'https://example.test/pr/1');
    ageHeartbeat(root);
    write(root, 'queue/night.md', queueText(task('a', 'brief: other night')));
    assert.equal(runCli(root, 'next').status, 0);
    const out = runCli(root, 'summary').stdout;
    const s = JSON.parse(out);
    assert.equal(s.tasks[0].pr, null);
    assert.equal(s.tasks[0].status, 'pending');
    assert.ok(!out.includes('pr/1'));
  });
  test('stateForQueue keeps a matching state and resets a different one', () => {
    const tasks = parsed(task('a'));
    const s = applySet(emptyState(tasks, 'h1'), tasks, 'a', 'running');
    assert.equal(stateForQueue(s, tasks, 'h1').tasks.a.status, 'running');
    assert.equal(stateForQueue(s, tasks, 'h2').tasks.a.status, 'pending');
  });
});

describe('heartbeat', () => {
  const tasks = parsed(task('a'));
  const AT = '2026-11-16T01:00:00.000Z';
  const at = Date.parse(AT);
  const state = applySet(emptyState(tasks), tasks, 'a', 'running', { now: AT, session: 's1' });
  test('records the time and the session', () => {
    assert.deepEqual(state.run.heartbeat, { at: AT, session: 's1' });
    assert.equal(applySet(emptyState(tasks), tasks, 'a', 'running', { now: AT }).run.heartbeat.session, null);
  });
  test('blocks other sessions for under 15 minutes', () => {
    assert.equal(heartbeatBlocks(state, 's2', at + 14 * 60000 + 59000), true);
    assert.equal(heartbeatBlocks(state, 's2', at + 15 * 60000), false);
  });
  test('own session and no session id do not block; an unknown writer blocks', () => {
    assert.equal(heartbeatBlocks(state, 's1', at + 60000), false);
    assert.equal(heartbeatBlocks(state, undefined, at + 60000), false);
    const anon = applySet(emptyState(tasks), tasks, 'a', 'running', { now: AT });
    assert.equal(heartbeatBlocks(anon, 's1', at + 60000), true);
  });
  test('a writer without --session keeps the previous heartbeat session', () => {
    const next = applySet(state, tasks, 'a', 'waiting', { now: '2026-11-16T01:01:00.000Z' });
    assert.deepEqual(next.run.heartbeat, { at: '2026-11-16T01:01:00.000Z', session: 's1' });
  });
  test('CLI sequence: set --session, usage and next without session, heartbeat check', () => {
    const root = cliRepo();
    assert.equal(runCli(root, 'set', 'a', 'running', '--session', 's1').status, 0);
    assert.equal(runCli(root, 'usage', '--window', '10', '--weekly', '10').status, 0);
    assert.equal(readState(root).run.heartbeat.session, 's1');
    assert.equal(runCli(root, 'heartbeat', '--session', 's1').status, 0);
    const other = runCli(root, 'heartbeat', '--session', 's2');
    assert.equal(other.status, 1);
    assert.match(other.stderr, /heartbeat/);
  });
  test('usage and next accept --session', () => {
    const root = cliRepo();
    assert.equal(runCli(root, 'usage', '--window', '10', '--weekly', '10', '--session', 's9').status, 0);
    assert.equal(readState(root).run.heartbeat.session, 's9');
    assert.equal(runCli(root, 'next', '--session', 's8').status, 0);
    assert.equal(readState(root).run.heartbeat.session, 's8');
  });
  test('heartbeat check: no heartbeat passes, unknown fresh writer blocks, stale heartbeat passes', () => {
    const root = cliRepo();
    assert.equal(runCli(root, 'heartbeat', '--session', 's1').status, 0);
    assert.equal(runCli(root, 'set', 'a', 'running').status, 0);
    assert.equal(readState(root).run.heartbeat.session, 's1');
    assert.equal(runCli(root, 'heartbeat', '--session', 's2').status, 1);
    assert.equal(runCli(root, 'heartbeat', '--session', 's1').status, 0);
    ageHeartbeat(root);
    assert.equal(runCli(root, 'heartbeat', '--session', 's2').status, 0);
    assert.equal(readState(root).run.heartbeat.session, 's2');
  });
  test('CLI set --session stores the session', () => {
    const root = repoWith();
    write(root, '.claude/workflow.json', JSON.stringify(PROJECT));
    write(root, 'queue/night.md', queueText(task('a')));
    assert.equal(runCli(root, 'set', 'a', 'running', '--session', 'abc').status, 0);
    assert.equal(readState(root).run.heartbeat.session, 'abc');
  });
});

describe('files resolve against the main checkout', () => {
  test('a call from a linked worktree uses the queue and state of the main checkout', () => {
    const root = repoWith();
    write(root, '.claude/workflow.json', JSON.stringify(PROJECT));
    write(root, 'queue/night.md', queueText(task('a')));
    const wt = path.join(root, 'wt', 'task-1');
    fs.mkdirSync(wt, { recursive: true });
    fs.mkdirSync(path.join(root, '.git', 'worktrees', 'task-1'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(root, '.git', 'worktrees', 'task-1')}\n`);
    write(wt, '.claude/workflow.json', JSON.stringify(PROJECT));
    const r = runCli(wt, 'set', 'a', 'running');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readState(root).tasks.a.status, 'running');
    assert.ok(!fs.existsSync(path.join(wt, 'queue')));
  });
});

describe('spec tier fails closed', () => {
  const lowRisk = { ...PROJECT, night: { merge: 'lowRisk' } };
  const specsCfg = { paths: { specs: 'specs/' } };
  test('a missing spec at next time routes waiting under lowRisk', () => {
    const root = cliRepo(queueText(task('a', 'spec: specs/gone.md#1\nspecTier: -')), lowRisk);
    assert.equal(JSON.parse(runCli(root, 'next').stdout).route, 'waiting');
    assert.equal(runCli(root, 'route', 'a', '--risk', 'no').stdout.trim(), 'waiting');
    assert.equal(JSON.parse(runCli(root, 'summary').stdout).tasks[0].route, 'waiting');
  });
  test('a spec without a Tier header counts as T3', () => {
    const root = cliRepo(queueText(task('a', 'spec: specs/nohead.md#1\nspecTier: -')), lowRisk);
    write(root, 'specs/nohead.md', '# S\n\nStatus: accepted\n');
    assert.equal(runCli(root, 'route', 'a', '--risk', 'no').stdout.trim(), 'waiting');
  });
  test('a declared T3 is not replaced by a lower header tier', () => {
    const root = repoWith();
    const [t] = withSpecTiers(parseQueue(queueText(task('a', 'spec: specs/ok.md#1\nspecTier: T3'))).tasks, specsCfg, root);
    assert.equal(t.specTier, 'T3');
  });
  test('a higher header tier replaces a lower declared one', () => {
    const root = repoWith({ t3: '# S\n\nTier: T3. Status: accepted\n' });
    const [t] = withSpecTiers(parseQueue(queueText(task('a', 'spec: specs/t3.md#1\nspecTier: T1'))).tasks, specsCfg, root);
    assert.equal(t.specTier, 'T3');
  });
  test('a call from a linked worktree finds a spec that exists only in the main checkout', () => {
    const root = cliRepo(queueText(task('a', 'spec: specs/t3.md#1\nspecTier: -')), lowRisk);
    write(root, 'specs/t3.md', '# S\n\nTier: T3. Status: accepted\n');
    const wt = linkedWorktree(root, lowRisk);
    assert.equal(runCli(wt, 'route', 'a', '--risk', 'no').stdout.trim(), 'waiting');
  });
  test('the main checkout spec is tried first and wins when readable', () => {
    const root = cliRepo(queueText(task('a', 'spec: specs/s.md#1\nspecTier: -')), lowRisk);
    write(root, 'specs/s.md', '# S\n\nTier: T2. Status: accepted\n');
    const wt = linkedWorktree(root, lowRisk);
    write(wt, 'specs/s.md', '# S\n\nTier: T3. Status: accepted\n');
    assert.equal(JSON.parse(runCli(wt, 'summary').stdout).tasks[0].specTier, 'T2');
  });
});

describe('state reset keeps live runs', () => {
  const CHANGED = queueText(task('a', 'brief: really different'));
  test('reformat-only edits keep the state', () => {
    const root = cliRepo();
    runCli(root, 'set', 'a', 'running');
    runCli(root, 'set', 'a', 'open', '--pr', 'u1');
    ageHeartbeat(root);
    const base = queueText(task('a'));
    const variants = [`${base}\n\n`, `﻿${base}`, base.replace(/\n/g, '\r\n')];
    for (const v of variants) {
      write(root, 'queue/night.md', v);
      const out = runCli(root, 'summary');
      assert.equal(out.status, 0, out.stderr);
      assert.equal(JSON.parse(out.stdout).tasks[0].pr, 'u1');
    }
    assert.deepEqual(fs.readdirSync(path.join(root, 'queue')).filter((f) => /^night-state\..+\.json$/.test(f) && f !== 'night-state.json'), []);
  });
  test('a real change with a running task under a fresh heartbeat is refused by a writer', () => {
    const root = cliRepo();
    runCli(root, 'set', 'a', 'running');
    write(root, 'queue/night.md', CHANGED);
    const r = runCli(root, 'next');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /heartbeat/);
    assert.equal(readState(root).tasks.a.status, 'running');
  });
  test('a running task with a stale heartbeat is abandoned: a real change resets', () => {
    const root = cliRepo();
    runCli(root, 'set', 'a', 'running');
    ageHeartbeat(root);
    write(root, 'queue/night.md', CHANGED);
    const r = runCli(root, 'next');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readState(root).tasks.a.status, 'pending');
  });
  test('a real change with a fresh heartbeat is refused', () => {
    const root = cliRepo();
    runCli(root, 'set', 'a', 'running');
    runCli(root, 'set', 'a', 'open', '--pr', 'u');
    write(root, 'queue/night.md', CHANGED);
    const r = runCli(root, 'next');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /heartbeat/);
  });
  test('a real change with no running task archives the old state and resets', () => {
    const root = cliRepo();
    runCli(root, 'set', 'a', 'running');
    runCli(root, 'set', 'a', 'open', '--pr', 'u1');
    ageHeartbeat(root);
    const old = readState(root);
    write(root, 'queue/night.md', CHANGED);
    const r = runCli(root, 'next');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(runCli(root, 'summary').stdout).tasks[0].status, 'pending');
    const archive = path.join(root, 'queue', `night-state.${old.queueHash.slice(0, 8)}.json`);
    assert.ok(fs.existsSync(archive));
    assert.deepEqual(JSON.parse(fs.readFileSync(archive, 'utf8')), old);
  });
});

describe('run status', () => {
  const status = (root) => JSON.parse(runCli(root, 'summary').stdout).run.status;
  const go = (root, to, ...more) => runCli(root, 'run', to, ...more);
  test('summary exposes the run status', () => {
    assert.equal(JSON.parse(runCli(cliRepo(), 'summary').stdout).runStatus, 'running');
  });
  test('running to paused to running, and refreshes the heartbeat with the session', () => {
    const root = cliRepo();
    assert.equal(go(root, 'paused', '--session', 's1').status, 0);
    assert.equal(status(root), 'paused');
    assert.equal(readState(root).run.heartbeat.session, 's1');
    assert.equal(go(root, 'running').status, 0);
    assert.equal(status(root), 'running');
    assert.equal(readState(root).run.heartbeat.session, 's1');
  });
  for (const [from, to] of [['running', 'stopped'], ['running', 'finished'], ['paused', 'stopped'], ['paused', 'finished']]) {
    test(`${from} to ${to}`, () => {
      const root = cliRepo();
      if (from === 'paused') go(root, 'paused');
      assert.equal(go(root, to).status, 0);
      assert.equal(status(root), to);
    });
  }
  for (const end of ['stopped', 'finished']) {
    test(`${end} is terminal`, () => {
      const root = cliRepo();
      go(root, end);
      for (const to of ['running', 'paused']) {
        const r = go(root, to);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /not allowed/);
      }
      assert.equal(status(root), end);
    });
  }
  test('an unknown run status is a usage error', () => {
    assert.equal(go(cliRepo(), 'bogus').status, 2);
  });
});

function runCliAsync(root, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: root });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (status) => resolve({ status, stderr: err }));
  });
}

describe('F1 a second session cannot end a live run', () => {
  test('two simultaneous heartbeat claims: exactly one wins', async () => {
    for (let n = 0; n < 3; n++) {
      const root = cliRepo();
      const rs = await Promise.all([runCliAsync(root, 'heartbeat', '--session', 'A'), runCliAsync(root, 'heartbeat', '--session', 'B')]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [0, 1]);
      assert.ok(['A', 'B'].includes(readState(root).run.heartbeat.session));
    }
  });
  test('heartbeat claims for itself and refreshes its own; a stale lock file does not block', () => {
    const root = cliRepo();
    assert.equal(runCli(root, 'heartbeat', '--session', 'A').status, 0);
    assert.equal(readState(root).run.heartbeat.session, 'A');
    assert.equal(runCli(root, 'heartbeat', '--session', 'A').status, 0);
    const lock = path.join(root, 'queue', 'night-state.lock');
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(lock, old, old);
    assert.equal(runCli(root, 'heartbeat', '--session', 'A').status, 0);
    assert.ok(!fs.existsSync(lock));
  });
  test('set running refuses a task running under another fresh session', () => {
    const root = cliRepo();
    assert.equal(runCli(root, 'set', 'a', 'running', '--session', 'A').status, 0);
    const r = runCli(root, 'set', 'a', 'running', '--session', 'B');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /heartbeat/);
    assert.equal(readState(root).run.heartbeat.session, 'A');
    assert.equal(runCli(root, 'set', 'a', 'running', '--session', 'A').status, 0);
    ageHeartbeat(root);
    assert.equal(runCli(root, 'set', 'a', 'running', '--session', 'B').status, 0);
  });
  test('next reports held:true for a live run of another session, held:false when nothing is runnable', () => {
    const root = cliRepo();
    runCli(root, 'set', 'a', 'running', '--session', 'A');
    const held = JSON.parse(runCli(root, 'next', '--session', 'B').stdout);
    assert.equal(held.task, null);
    assert.equal(held.held, true);
    assert.match(held.reason, /^running a/);
    assert.equal(readState(root).run.heartbeat.session, 'A');
    runCli(root, 'set', 'a', 'open', '--pr', 'u', '--session', 'A');
    const none = JSON.parse(runCli(root, 'next', '--session', 'B').stdout);
    assert.equal(none.held, false);
    assert.equal(none.reason, 'no runnable task');
  });
  test('nextTask pure: held flag', () => {
    const tasks = parseQueue(queueText(task('a'))).tasks;
    const AT = '2026-11-16T01:00:00.000Z';
    const st = applySet(emptyState(tasks), tasks, 'a', 'running', { now: AT, session: 'A' });
    const now = Date.parse(AT) + 60000;
    assert.equal(nextTask({ tasks, state: st, session: 'B', now }).held, true);
    assert.equal(nextTask({ tasks, state: st, session: 'A', now }).held, false);
    assert.equal(nextTask({ tasks, state: st, session: 'B', now: now + 20 * 60000 }).task.id, 'a');
  });
});

describe('F2 abandoned running task', () => {
  test('next converts a stale running task to interrupted and offers it, branch kept', () => {
    const root = cliRepo();
    runCli(root, 'set', 'a', 'running', '--branch', 'night/a', '--session', 'A');
    ageHeartbeat(root);
    const r = JSON.parse(runCli(root, 'next', '--session', 'B').stdout);
    assert.equal(r.task.id, 'a');
    assert.equal(r.held, false);
    assert.equal(readState(root).tasks.a.status, 'interrupted');
    assert.equal(readState(root).tasks.a.branch, 'night/a');
  });
  test('a running task with no heartbeat counts as abandoned', () => {
    const root = cliRepo();
    runCli(root, 'set', 'a', 'running');
    const st = readState(root);
    st.run.heartbeat = null;
    fs.writeFileSync(path.join(root, 'queue/night-state.json'), JSON.stringify(st));
    assert.equal(JSON.parse(runCli(root, 'next').stdout).task.id, 'a');
    assert.equal(readState(root).tasks.a.status, 'interrupted');
  });
  test('run running converts a stale running task', () => {
    const root = cliRepo();
    runCli(root, 'set', 'a', 'running', '--session', 'A');
    ageHeartbeat(root);
    assert.equal(runCli(root, 'run', 'running', '--session', 'B').status, 0);
    assert.equal(readState(root).tasks.a.status, 'interrupted');
  });
  test('run paused sets a running task interrupted', () => {
    const root = cliRepo();
    runCli(root, 'set', 'a', 'running', '--session', 'A');
    assert.equal(runCli(root, 'run', 'paused', '--session', 'A').status, 0);
    assert.equal(readState(root).tasks.a.status, 'interrupted');
    assert.equal(runCli(root, 'run', 'running', '--session', 'A').status, 0);
    assert.equal(JSON.parse(runCli(root, 'next', '--session', 'A').stdout).task.id, 'a');
  });
  test('set interrupted works from running', () => {
    const root = cliRepo();
    runCli(root, 'set', 'a', 'running');
    assert.equal(runCli(root, 'set', 'a', 'interrupted').status, 0);
    assert.equal(readState(root).tasks.a.status, 'interrupted');
  });
});

describe('F3 plan identity', () => {
  test('a new Planned line with identical tasks starts new state; re-saving keeps it', () => {
    const root = cliRepo();
    runCli(root, 'set', 'a', 'running');
    runCli(root, 'set', 'a', 'open', '--pr', 'u1');
    ageHeartbeat(root);
    const base = queueText(task('a'));
    write(root, 'queue/night.md', `${base}\n`);
    runCli(root, 'next');
    assert.equal(readState(root).tasks.a.pr, 'u1');
    write(root, 'queue/night.md', base.replace('2026-11-16', '2026-12-01'));
    assert.equal(runCli(root, 'next').status, 0);
    assert.equal(readState(root).tasks.a.pr, null);
  });
});

describe('F4 read-only commands and busy', () => {
  test('summary and route never archive or reset a changed queue', () => {
    const root = cliRepo();
    runCli(root, 'set', 'a', 'running');
    runCli(root, 'set', 'a', 'open', '--pr', 'u1');
    ageHeartbeat(root);
    write(root, 'queue/night.md', queueText(task('a', 'brief: new')));
    const before = fs.readFileSync(path.join(root, 'queue/night-state.json'), 'utf8');
    const r = runCli(root, 'summary');
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.equal(s.stale, true);
    assert.equal(s.tasks[0].pr, 'u1');
    assert.equal(runCli(root, 'route', 'a').status, 0);
    assert.equal(fs.readFileSync(path.join(root, 'queue/night-state.json'), 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.join(root, 'queue')).sort(), ['night-state.json', 'night.md']);
  });
  test('summary of a matching state has no stale flag and creates no file', () => {
    const root = cliRepo();
    const s = JSON.parse(runCli(root, 'summary').stdout);
    assert.ok(!s.stale);
    assert.ok(!fs.existsSync(path.join(root, 'queue/night-state.json')));
  });
  test('busy: no state is free; fresh running run is busy; terminal is free', () => {
    const root = cliRepo();
    assert.equal(runCli(root, 'busy').status, 0);
    assert.equal(JSON.parse(runCli(root, 'busy').stdout).busy, false);
    runCli(root, 'run', 'running', '--session', 'A');
    const b = runCli(root, 'busy');
    assert.equal(b.status, 1);
    const j = JSON.parse(b.stdout);
    assert.equal(j.busy, true);
    assert.ok(j.reason);
    runCli(root, 'run', 'finished');
    ageHeartbeat(root);
    assert.equal(runCli(root, 'busy').status, 0);
  });
  test('busy: a paused run and an unfinished task of a stale run are busy', () => {
    const root = cliRepo();
    runCli(root, 'run', 'paused');
    ageHeartbeat(root);
    assert.equal(runCli(root, 'busy').status, 1);
    const r2 = cliRepo();
    runCli(r2, 'set', 'a', 'running');
    ageHeartbeat(r2);
    assert.equal(runCli(r2, 'busy').status, 1);
  });
  test('a finished run does not block a new plan within 15 minutes', () => {
    const root = cliRepo();
    runCli(root, 'run', 'finished');
    write(root, 'queue/night.md', queueText(task('a', 'brief: new')));
    assert.equal(runCli(root, 'next').status, 0);
  });
});

describe('F5 brief naming a spec', () => {
  const root = repoWith();
  test('a brief naming a path under specs is rejected when no spec is linked', () => {
    for (const b of ['implement specs/night-mode.md section 3', 'see `specs/x.md`', 'C:\\Dev\\wt\\specs\\night-mode.md', 'C:/Dev/wt/specs/night-mode.md']) {
      assert.deepEqual(rules(queueText(task('a', `brief: ${b}`)), root), ['a:brief-names-spec'], b);
    }
  });
  test('ordinary briefs pass', () => {
    assert.deepEqual(rules(queueText(task('a', 'brief: fix the respecs/ typo in docs')), root), []);
    assert.deepEqual(rules(queueText(task('a', 'brief: tidy the inspector view')), root), []);
  });
});

describe('F9 run finished and stopped', () => {
  for (const to of ['finished', 'stopped']) {
    test(`${to} prints the final status and interrupts a running task, even after the queue changed`, () => {
      const root = cliRepo();
      runCli(root, 'set', 'a', 'running', '--session', 'A');
      write(root, 'queue/night.md', queueText(task('a', 'brief: edited')));
      const r = runCli(root, 'run', to, '--session', 'A');
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`^run: ${to}`));
      assert.equal(readState(root).run.status, to);
      assert.equal(readState(root).tasks.a.status, 'interrupted');
    });
  }
});

describe('F13 warn flag', () => {
  test('first warn is already:false, later already:true, summary shows it', () => {
    const root = cliRepo();
    assert.deepEqual(JSON.parse(runCli(root, 'warn', '--session', 'A').stdout), { already: false });
    assert.deepEqual(JSON.parse(runCli(root, 'warn', '--session', 'A').stdout), { already: true });
    assert.equal(JSON.parse(runCli(root, 'summary').stdout).warned, true);
    assert.equal(readState(root).run.warned, true);
  });
  test('summary shows warned false by default', () => {
    assert.equal(JSON.parse(runCli(cliRepo(), 'summary').stdout).warned, false);
  });
});

describe('R5 ownership, recovery, terminal runs, plan identity', () => {
  test('a late run finished by the old session is refused while another live session holds the run', () => {
    const root = cliRepo();
    assert.equal(runCli(root, 'set', 'a', 'running', '--session', 'A').status, 0);
    ageHeartbeat(root);
    assert.equal(runCli(root, 'heartbeat', '--session', 'B').status, 0);
    assert.equal(runCli(root, 'run', 'running', '--session', 'B').status, 0);
    for (const to of ['finished', 'stopped', 'paused']) {
      const r = runCli(root, 'run', to, '--session', 'A');
      assert.equal(r.status, 1, to);
      assert.match(r.stderr, /session B/);
    }
    assert.equal(runCli(root, 'set', 'a', 'open', '--pr', 'u', '--session', 'A').status, 1);
    assert.equal(runCli(root, 'warn', '--session', 'A').status, 1);
    assert.equal(runCli(root, 'usage', '--window', '1', '--weekly', '1', '--session', 'A').status, 1);
    const st = readState(root);
    assert.equal(st.run.status, 'running');
    assert.equal(st.run.heartbeat.session, 'B');
    assert.equal(runCli(root, 'run', 'finished', '--session', 'B').status, 0);
  });
  test('mutations without --session and with a stale holder still work', () => {
    const root = cliRepo();
    runCli(root, 'set', 'a', 'running', '--session', 'A');
    assert.equal(runCli(root, 'warn').status, 0);
    ageHeartbeat(root);
    assert.equal(runCli(root, 'run', 'paused', '--session', 'B').status, 0);
  });
  test('crash and resume: the dead session task is interrupted and offered to the replacement', () => {
    const root = cliRepo();
    runCli(root, 'set', 'a', 'running', '--branch', 'night/a', '--session', 'A');
    ageHeartbeat(root);
    assert.equal(runCli(root, 'heartbeat', '--session', 'B').status, 0);
    assert.equal(readState(root).tasks.a.status, 'interrupted');
    assert.equal(runCli(root, 'run', 'running', '--session', 'B').status, 0);
    const r = JSON.parse(runCli(root, 'next', '--session', 'B').stdout);
    assert.equal(r.task.id, 'a');
    assert.equal(readState(root).tasks.a.branch, 'night/a');
  });
  test('crash and resume through usage also interrupts the dead running task', () => {
    const root = cliRepo();
    runCli(root, 'set', 'a', 'running', '--session', 'A');
    ageHeartbeat(root);
    runCli(root, 'usage', '--window', '1', '--weekly', '1', '--session', 'B');
    assert.equal(readState(root).tasks.a.status, 'interrupted');
  });
  test('a finished or stopped run does not block a heartbeat by another session', () => {
    for (const to of ['finished', 'stopped']) {
      const root = cliRepo();
      runCli(root, 'run', to, '--session', 'A');
      assert.equal(runCli(root, 'heartbeat', '--session', 'B').status, 0, to);
      assert.equal(readState(root).run.heartbeat.session, 'B');
    }
  });
  test('plan: a fresh plan after a finished run starts fresh; a live run refuses it', () => {
    const root = cliRepo();
    runCli(root, 'run', 'running', '--session', 'A');
    const live = runCli(root, 'plan');
    assert.equal(live.status, 1);
    assert.match(live.stderr, /live|heartbeat/);
    runCli(root, 'run', 'finished', '--session', 'A');
    assert.equal(runCli(root, 'run', 'running', '--session', 'B').status, 1);
    const p = runCli(root, 'plan');
    assert.equal(p.status, 0, p.stderr);
    assert.equal(runCli(root, 'run', 'running', '--session', 'B').status, 0);
    assert.equal(readState(root).run.status, 'running');
    assert.ok(readState(root).planId);
    assert.ok(fs.readdirSync(path.join(root, 'queue')).some((f) => /^night-state\..+\.json$/.test(f)));
  });
  test('plan with no stored state is a no-op that succeeds', () => {
    assert.equal(runCli(cliRepo(), 'plan').status, 0);
  });
});
