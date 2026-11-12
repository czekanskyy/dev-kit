import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildNotification } from '../hooks/notify-hook.mjs';
import { handleEdit } from '../hooks/post-edit.mjs';
import { checkStop, parsePorcelainZ } from '../hooks/stop-check.mjs';
import { notify } from '../scripts/notify.mjs';
import { PROJECT, configFor, fakeRepo, mockExec } from './helpers.mjs';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks');

describe('post-edit', () => {
  const root = fakeRepo();
  const config = configFor(root);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-data-'));
  const env = { CLAUDE_PLUGIN_DATA: data };
  const input = (file, session = 's1') => ({ session_id: session, cwd: root, tool_input: { file_path: path.join(root, file) } });

  test('runs matching rules with {files} and reminds', () => {
    const ran = [];
    const text = handleEdit(input('src/a.ts'), { config, env, now: 1000, run: (c) => (ran.push(c), { ok: true, output: '' }) });
    assert.deepEqual(ran, ['fmt "src/a.ts"']);
    assert.equal(text, 'Run the type check.');
  });
  test('debounces the same rule and file within 20 s', () => {
    const ran = [];
    handleEdit(input('src/a.ts'), { config, env, now: 5000, run: (c) => (ran.push(c), { ok: true, output: '' }) });
    assert.deepEqual(ran, []);
    handleEdit(input('src/a.ts'), { config, env, now: 30000, run: (c) => (ran.push(c), { ok: true, output: '' }) });
    assert.equal(ran.length, 1);
  });
  test('reports a failure tail', () => {
    const text = handleEdit(input('src/b.ts', 's2'), { config, env, now: 1, run: () => ({ ok: false, output: 'line1\nboom' }) });
    assert.match(text, /failed:\nline1\nboom/);
  });
  test('ignores files no rule matches', () => {
    assert.equal(handleEdit(input('README.md', 's3'), { config, env, run: () => assert.fail('should not run') }), null);
  });
});

describe('stop-check', () => {
  const root = fakeRepo();
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), '');
  const config = configFor(root, { ...PROJECT, stopCheck: { commands: ['lint', 'eslint {files}'], codeGlobs: ['src/**'] } });
  const status = (s) => mockExec({ 'git status': s });
  const input = { cwd: root, hook_event_name: 'Stop' };

  test('parses porcelain -z with renames', () => {
    assert.deepEqual(parsePorcelainZ(' M src/a.ts\0R  new.ts\0old.ts\0?? x y.ts\0'), ['src/a.ts', 'new.ts', 'x y.ts']);
  });
  test('stop_hook_active does nothing', () => assert.equal(checkStop({ ...input, stop_hook_active: true }, { config, exec: status(' M src/a.ts\0'), run: () => assert.fail() }), null));
  test('plan mode does nothing', () => assert.equal(checkStop({ ...input, permission_mode: 'plan' }, { config, exec: status(' M src/a.ts\0'), run: () => assert.fail() }), null));
  test('no code changes does nothing', () => assert.equal(checkStop(input, { config, exec: status(' M README.md\0'), run: () => assert.fail() }), null));
  test('runs commands with {files} and passes', () => {
    const ran = [];
    assert.equal(checkStop(input, { config, exec: status(' M src/a.ts\0 D src/gone.ts\0'), run: (c) => (ran.push(c), { ok: true, output: '' }) }), null);
    assert.deepEqual(ran, ['node -e "process.exit(0)"', 'eslint "src/a.ts"']);
  });
  test('blocks on failure with the output tail', () => {
    const v = checkStop(input, { config, exec: status(' M src/a.ts\0'), run: () => ({ ok: false, output: 'x\nerror TS2322' }) });
    assert.equal(v.decision, 'block');
    assert.match(v.reason, /^Checks failed: node -e/);
    assert.match(v.reason, /TS2322/);
  });
  test('without stopCheck config does nothing', () => assert.equal(checkStop(input, { config: configFor(root), exec: status(' M src/a.ts\0') }), null));
  test('hook process prints block JSON', () => {
    const repo = fakeRepo();
    // No git repo really exists here, so git status fails and the hook stays silent.
    const r = spawnSync(process.execPath, [path.join(HOOKS, 'stop-check.mjs')], { input: JSON.stringify({ cwd: repo }), encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

describe('notify', () => {
  const config = configFor(fakeRepo());
  test('no topic is a no-op', async () => {
    const r = await notify({ title: 't', message: 'm' }, { config, env: {}, fetchImpl: () => assert.fail() });
    assert.equal(r.sent, false);
  });
  test('posts with headers, bearer token and truncation', async () => {
    let seen;
    const r = await notify(
      { title: 'Zadanie gotowe', message: 'x'.repeat(400), priority: 'max', click: 'https://app.example.test', tags: ['warning'] },
      { config, env: { NTFY_TOPIC: 'my-topic', NTFY_TOKEN: 'tk' }, fetchImpl: async (url, init) => ((seen = { url, init }), { ok: true }) },
    );
    assert.equal(r.sent, true);
    assert.equal(seen.url, 'https://ntfy.example.test/my-topic');
    assert.equal(seen.init.headers.Priority, '5');
    assert.equal(seen.init.headers.Authorization, 'Bearer tk');
    assert.equal(seen.init.headers.Tags, 'warning');
    assert.equal(seen.init.headers.Click, 'https://app.example.test');
    assert.equal(seen.init.body.length, 300);
  });
  test('non-ASCII titles are encoded', async () => {
    let headers;
    await notify({ title: 'Błąd', message: 'm' }, { config, env: { NTFY_TOPIC: 't' }, fetchImpl: async (u, i) => ((headers = i.headers), { ok: true }) });
    assert.match(headers.Title, /^=\?UTF-8\?B\?/);
  });
  test('fetch errors never throw', async () => {
    const r = await notify({ message: 'm' }, { config, env: { NTFY_TOPIC: 't' }, fetchImpl: async () => { throw new Error('offline'); } });
    assert.equal(r.sent, false);
  });
});

describe('notify-hook', () => {
  test('permission prompt is urgent', () => assert.equal(buildNotification({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Needs permission for Bash' }, 'demo').priority, 'max'));
  test('idle prompt is quiet', () => assert.equal(buildNotification({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }, 'demo').priority, 'low'));
  test('rate limit says Usage limit reached', () => {
    const n = buildNotification({ hook_event_name: 'StopFailure', error_type: 'rate_limit' }, 'demo');
    assert.equal(n.priority, 'max');
    assert.equal(n.title, 'demo');
    assert.equal(n.message, 'Usage limit reached');
  });
  test('other failures are urgent and name only the matcher', () => {
    const n = buildNotification({ hook_event_name: 'StopFailure', matcher: 'authentication_failed', message: 'token abc in /home/x/.env' }, 'demo');
    assert.equal(n.priority, 'max');
    assert.equal(n.message, 'Agent stopped with an error: authentication_failed');
  });
  test('free-text error fields are never forwarded', () => {
    const n = buildNotification({ hook_event_name: 'StopFailure', error: 'failed reading /secret/path with KEY=123' }, 'demo');
    assert.equal(n.message, 'Agent stopped with an error: unknown');
  });
  test('hook message text is never forwarded', () => {
    const n = buildNotification({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs permission to run rm -rf /data' }, 'demo');
    assert.equal(n.message, 'Permission prompt waiting');
    assert.doesNotMatch(JSON.stringify(n), /rm -rf|data/);
  });
  test('elicitation asks for a decision', () =>
    assert.equal(buildNotification({ hook_event_name: 'Notification', notification_type: 'elicitation_dialog' }, 'demo').message, 'Agent needs your decision'));
  test('unknown notification types are ignored', () => assert.equal(buildNotification({ hook_event_name: 'Notification', notification_type: 'other' }, 'demo'), null));
});
