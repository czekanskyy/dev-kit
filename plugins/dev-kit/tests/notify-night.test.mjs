import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { buildNotification, handleHook } from '../hooks/notify-hook.mjs';
import { buildMarker, markerPath, writeMarker } from '../scripts/lib/night.mjs';
import { hashQueue, parseQueue, emptyState, applySet, STATE_FILE } from '../scripts/queue.mjs';
import { configFor, fakeRepo } from './helpers.mjs';

const NOW = Date.parse('2026-01-10T22:00:00Z');
const HOUR = 3600 * 1000;
const QUEUE = '# Night queue\n\n## t1: first task\ntier: T1\nmerge: no\n\n## t2: second task\ntier: T1\nmerge: no\n';

function setup({ sessions = ['s1'], end = NOW + 4 * HOUR, running = 't1', state = true } = {}) {
  const root = fakeRepo('devkit-notify-night-');
  const config = configFor(root);
  fs.mkdirSync(path.join(root, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(root, 'queue', 'night.md'), QUEUE);
  const stateFile = path.join(root, 'queue', STATE_FILE);
  if (state) {
    const tasks = parseQueue(QUEUE).tasks;
    let s = emptyState(tasks, hashQueue(QUEUE));
    if (running) s = applySet(s, tasks, running, 'running', {});
    fs.writeFileSync(stateFile, JSON.stringify(s));
  }
  writeMarker(markerPath(root), { ...buildMarker({ runId: 'run-1', start: NOW - HOUR, end }), sessions });
  return { root, config, stateFile };
}

const statusOf = (stateFile, id) => JSON.parse(fs.readFileSync(stateFile, 'utf8')).tasks[id].status;
const failure = (kind, extra = {}) => ({ hook_event_name: 'StopFailure', error_type: kind, session_id: 's1', ...extra });

async function run(input, env) {
  const sent = [];
  await handleHook({ ...input, cwd: env.root }, {
    config: env.config,
    project: 'demo',
    cwd: env.root,
    notifyFn: async (n) => sent.push(n),
    nightOpts: { now: NOW },
  });
  return sent;
}

describe('notify-hook night branch', () => {
  test('night rate_limit sends high and marks the running task interrupted', async () => {
    const env = setup();
    const sent = await run(failure('rate_limit'), env);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].priority, 'high');
    assert.equal(sent[0].title, 'demo');
    assert.equal(statusOf(env.stateFile, 't1'), 'interrupted');
    assert.equal(statusOf(env.stateFile, 't2'), 'pending');
  });

  test('never sends max in a night session', async () => {
    const env = setup();
    const sent = await run(failure('rate_limit'), env);
    assert.notEqual(sent[0].priority, 'max');
  });

  test('another session gets the byte-identical existing notification and no state change', async () => {
    const env = setup();
    const input = failure('rate_limit', { session_id: 'other' });
    const sent = await run(input, env);
    assert.equal(JSON.stringify(sent), JSON.stringify([buildNotification({ ...input, cwd: env.root }, 'demo')]));
    assert.equal(sent[0].priority, 'max');
    assert.equal(sent[0].message, 'Usage limit reached');
    assert.equal(statusOf(env.stateFile, 't1'), 'running');
  });

  test('no marker at all keeps the existing notification', async () => {
    const env = setup();
    fs.rmSync(markerPath(env.root));
    const input = failure('rate_limit');
    const sent = await run(input, env);
    assert.equal(JSON.stringify(sent), JSON.stringify([buildNotification({ ...input, cwd: env.root }, 'demo')]));
    assert.equal(statusOf(env.stateFile, 't1'), 'running');
  });

  test('expired marker keeps the existing notification', async () => {
    const env = setup({ end: NOW - 2 * HOUR });
    const sent = await run(failure('rate_limit'), env);
    assert.equal(sent[0].priority, 'max');
    assert.equal(statusOf(env.stateFile, 't1'), 'running');
  });

  test('no running task: no state change, the push is still sent as high', async () => {
    const env = setup({ running: null });
    const sent = await run(failure('rate_limit'), env);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].priority, 'high');
    assert.equal(statusOf(env.stateFile, 't1'), 'pending');
  });

  test('missing state file: nothing is created, the push is still sent as high', async () => {
    const env = setup({ state: false });
    const sent = await run(failure('rate_limit'), env);
    assert.equal(sent[0].priority, 'high');
    assert.equal(fs.existsSync(env.stateFile), false);
  });

  test('corrupt state file does not throw and still pushes', async () => {
    const env = setup();
    fs.writeFileSync(env.stateFile, '{not json');
    const sent = await run(failure('rate_limit'), env);
    assert.equal(sent[0].priority, 'high');
  });

  test('other StopFailure kinds in a night session are unchanged', async () => {
    for (const kind of ['authentication_failed', 'billing_error', 'server_error']) {
      const env = setup();
      const input = failure(kind);
      const sent = await run(input, env);
      assert.equal(JSON.stringify(sent), JSON.stringify([buildNotification({ ...input, cwd: env.root }, 'demo')]), kind);
      assert.equal(sent[0].priority, 'max');
      assert.equal(statusOf(env.stateFile, 't1'), 'running', kind);
    }
  });

  test('Notification events in a night session are unchanged', async () => {
    const env = setup();
    const input = { hook_event_name: 'Notification', notification_type: 'permission_prompt', session_id: 's1' };
    const sent = await run(input, env);
    assert.equal(JSON.stringify(sent), JSON.stringify([buildNotification({ ...input, cwd: env.root }, 'demo')]));
  });

  test('a throwing notifier never escapes', async () => {
    const env = setup();
    await handleHook({ ...failure('rate_limit'), cwd: env.root }, {
      config: env.config,
      project: 'demo',
      cwd: env.root,
      notifyFn: async () => {
        throw new Error('offline');
      },
      nightOpts: { now: NOW },
    });
  });
});
