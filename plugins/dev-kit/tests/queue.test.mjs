import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
    write(root, 'queue/night.md', queueText(task('a', 'brief: other night')));
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
