import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateFileTool } from '../hooks/guard-files.mjs';
import { registerClaim, runHook } from '../hooks/guard-bash.mjs';
import { NIGHT_DENY_PREFIX, emitPreToolUse, nightVerdict } from '../scripts/lib/hook.mjs';
import {
  EXPIRY_GRACE_MS,
  buildMarker,
  isNightSession,
  markerPath,
  readMarker,
  registerSession,
  writeMarker,
} from '../scripts/lib/night.mjs';
import { configFor, fakeRepo, mockExec } from './helpers.mjs';

const NOW = Date.parse('2026-01-10T22:00:00Z');
const HOUR = 3600 * 1000;
const FAKE_TMP = path.join(fakeRepo(), 'x');

function setup() {
  const root = fakeRepo('devkit-night-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const file = markerPath(root);
  return { root, file, config: configFor(root) };
}

function validMarker(sessions = []) {
  return { ...buildMarker({ runId: 'run-1', start: NOW - HOUR, end: NOW + 4 * HOUR, resumable: true, lockPid: 1234 }), sessions };
}

function bashInput(root, command, sessionId = 's1') {
  return { tool_name: 'Bash', tool_input: { command }, cwd: root, session_id: sessionId };
}

function bashVerdict(input, config) {
  return runHook(input, { config, exec: mockExec(), branch: 'feature/x', tmpDir: FAKE_TMP, env: {} });
}

function guard(input, config, nightOpts = {}) {
  const out = nightVerdict(bashVerdict(input, config), input, { now: NOW, ...nightOpts });
  return out ? out.decision : 'allow';
}

function makeWorktree(root, name) {
  const wt = path.join(root, 'wt', name);
  fs.mkdirSync(path.join(wt, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git', 'worktrees', name), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(root, '.git', 'worktrees', name)}\n`);
  return wt;
}

describe('marker library', () => {
  test('marker lives in the git common dir, under dev-kit', () => {
    const { root, file } = setup();
    assert.equal(file.replace(/\\/g, '/'), `${root.replace(/\\/g, '/')}/.git/dev-kit/night.json`);
  });
  test('a worktree resolves to the common dir of the main checkout', () => {
    const { root, file } = setup();
    const wt = makeWorktree(root, 'slot');
    assert.equal(markerPath(wt).replace(/\\/g, '/'), file.replace(/\\/g, '/'));
  });
  test('buildMarker sets expiry to end plus 30 minutes', () => {
    const m = buildMarker({ runId: 'r', start: NOW, end: NOW + HOUR, resumable: false, lockPid: 7 });
    assert.equal(EXPIRY_GRACE_MS, 30 * 60 * 1000);
    assert.equal(Date.parse(m.expiry), NOW + HOUR + EXPIRY_GRACE_MS);
    assert.deepEqual(m.sessions, []);
  });
  test('write then read round trip', () => {
    const { file } = setup();
    writeMarker(file, validMarker(['a']));
    const m = readMarker(file, { now: NOW });
    assert.equal(m.runId, 'run-1');
    assert.deepEqual(m.sessions, ['a']);
  });
  test('missing, malformed and expired markers read as no night', () => {
    const { file } = setup();
    assert.equal(readMarker(file, { now: NOW }), null);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bad = ['', '{', '[]', '{"runId":"r"}', JSON.stringify({ ...validMarker(), sessions: 'x' }), JSON.stringify({ ...validMarker(), expiry: 'soon' })];
    for (const text of bad) {
      fs.writeFileSync(file, text);
      assert.equal(readMarker(file, { now: NOW }), null, text);
    }
    writeMarker(file, validMarker());
    assert.ok(readMarker(file, { now: NOW }));
    assert.equal(readMarker(file, { now: NOW + 4 * HOUR + EXPIRY_GRACE_MS + 1 }), null);
  });
  test('registerSession adds once, and refuses without a valid marker', () => {
    const { file } = setup();
    assert.equal(registerSession(file, 's1', { now: NOW }), false);
    writeMarker(file, validMarker());
    assert.equal(registerSession(file, 's1', { now: NOW }), true);
    assert.equal(registerSession(file, 's1', { now: NOW }), true);
    assert.deepEqual(readMarker(file, { now: NOW }).sessions, ['s1']);
    assert.equal(registerSession(file, '', { now: NOW }), false);
    assert.equal(registerSession(file, 's2', { now: NOW + 9 * HOUR }), false);
  });
});

describe('isNightSession', () => {
  test('true only for a registered id in a valid marker', () => {
    const { root, file } = setup();
    writeMarker(file, validMarker(['s1']));
    assert.equal(isNightSession({ session_id: 's1', cwd: root }, { now: NOW }), true);
    assert.equal(isNightSession({ session_id: 's2', cwd: root }, { now: NOW }), false);
    assert.equal(isNightSession({ cwd: root }, { now: NOW }), false);
    assert.equal(isNightSession({ session_id: 's1', cwd: root }, { now: NOW + 9 * HOUR }), false);
  });
  test('false with no marker and with a malformed marker', () => {
    const { root, file } = setup();
    assert.equal(isNightSession({ session_id: 's1', cwd: root }, { now: NOW }), false);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"sessions":["s1"]');
    assert.equal(isNightSession({ session_id: 's1', cwd: root }, { now: NOW }), false);
  });
  test('fallback: a worktree whose .agent-scope names the run id', () => {
    const { root, file } = setup();
    writeMarker(file, validMarker([]));
    const wt = makeWorktree(root, 'slot');
    const input = { session_id: 'subagent', cwd: path.join(wt, 'sub') };
    assert.equal(isNightSession(input, { now: NOW }), false);
    fs.writeFileSync(path.join(wt, '.agent-scope'), 'slot-1\nrun: other-run\n');
    assert.equal(isNightSession(input, { now: NOW }), false);
    fs.writeFileSync(path.join(wt, '.agent-scope'), 'slot-1\nrun: run-1\n');
    assert.equal(isNightSession(input, { now: NOW }), true);
    assert.equal(isNightSession(input, { now: NOW + 9 * HOUR }), false);
  });
  test('fallback does not apply to the main checkout', () => {
    const { root, file } = setup();
    writeMarker(file, validMarker([]));
    fs.writeFileSync(path.join(root, '.agent-scope'), 'run: run-1\n');
    assert.equal(isNightSession({ session_id: 'x', cwd: root }, { now: NOW }), false);
  });
});

describe('ask becomes deny only for night sessions', () => {
  const ASK = 'npm install left-pad';
  test('registered session: ask becomes deny with the prefix and the original reason', () => {
    const { root, file, config } = setup();
    writeMarker(file, validMarker(['s1']));
    const input = bashInput(root, ASK);
    const orig = bashVerdict(input, config);
    assert.equal(orig.decision, 'ask');
    const out = nightVerdict(orig, input, { now: NOW });
    assert.equal(out.decision, 'deny');
    assert.equal(out.reason, `Night mode: deferred, needs the developer: ${orig.reason}`);
  });
  test('unregistered session stays ask', () => {
    const { root, file, config } = setup();
    writeMarker(file, validMarker(['s1']));
    assert.equal(guard(bashInput(root, ASK, 's2'), config), 'ask');
  });
  test('no marker stays ask', () => {
    const { root, config } = setup();
    assert.equal(guard(bashInput(root, ASK), config), 'ask');
  });
  test('expired marker stays ask', () => {
    const { root, file, config } = setup();
    writeMarker(file, validMarker(['s1']));
    assert.equal(guard(bashInput(root, ASK), config, { now: NOW + 9 * HOUR }), 'ask');
  });
  test('malformed marker stays ask', () => {
    const { root, file, config } = setup();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json');
    assert.equal(guard(bashInput(root, ASK), config), 'ask');
  });
  test('emitPreToolUse writes the converted decision for a night session only', () => {
    const { root, file } = setup();
    writeMarker(file, validMarker(['s1']));
    const real = process.stdout.write;
    const grab = (input) => {
      let text = '';
      process.stdout.write = (s) => ((text += s), true);
      try {
        emitPreToolUse('ask', 'Confirm.', input, { now: NOW });
      } finally {
        process.stdout.write = real;
      }
      return JSON.parse(text).hookSpecificOutput;
    };
    const asNight = grab({ session_id: 's1', cwd: root });
    const other = grab({ session_id: 's9', cwd: root });
    const none = grab(undefined);
    assert.equal(asNight.permissionDecision, 'deny');
    assert.equal(asNight.permissionDecisionReason, 'Night mode: deferred, needs the developer: Confirm.');
    assert.equal(other.permissionDecision, 'ask');
    assert.equal(none.permissionDecision, 'ask');
  });
  test('deny stays deny and allow is never produced', () => {
    const { root, file } = setup();
    writeMarker(file, validMarker(['s1']));
    const input = { session_id: 's1', cwd: root };
    assert.deepEqual(nightVerdict({ decision: 'deny', reason: 'No.' }, input, { now: NOW }), { decision: 'deny', reason: 'No.' });
    assert.equal(nightVerdict(null, input, { now: NOW }), null);
    assert.equal(nightVerdict({ decision: 'allow', reason: 'x' }, input, { now: NOW }), null);
    const real = process.stdout.write;
    let text = '';
    process.stdout.write = (s) => ((text += s), true);
    try {
      emitPreToolUse('allow', 'x', input, { now: NOW });
    } finally {
      process.stdout.write = real;
    }
    assert.equal(text, '');
  });
});

describe('guard suites re-run with a valid marker and a registered session', () => {
  const COMMANDS = [
    ['git push origin main', 'deny'],
    ['git filter-repo --force', 'deny'],
    ['git push origin feature/x', 'allow'],
    ['rm -rf /', 'deny'],
    ['terraform destroy', 'deny'],
    ['git status', 'allow'],
    ['ls -la', 'allow'],
    ['npm install left-pad', 'ask'],
    ['pnpm add zod', 'ask'],
    ['kubectl get pods', 'ask'],
    ['cat .env', 'deny'],
    ['git commit -m "x" -m "Co-Authored-By: Bot <b@example.test>"', 'deny'],
  ];
  const FILES = [
    ['Read', '.env', 'deny'],
    ['Read', 'src/app.ts', 'allow'],
    ['Write', 'src/generated/types.ts', 'deny'],
    ['Edit', '.claude/settings.json', 'ask'],
    ['Edit', 'src/app.ts', 'allow'],
    ['Grep', 'src', 'allow'],
  ];

  test('bash: deny stays deny, ask becomes deny, allow stays allow', () => {
    const { root, file, config } = setup();
    writeMarker(file, validMarker(['s1']));
    for (const [cmd, expected] of COMMANDS) {
      const plain = guard(bashInput(root, cmd, 'other'), config);
      assert.equal(plain, expected, cmd);
      const night = guard(bashInput(root, cmd, 's1'), config);
      assert.equal(night, expected === 'allow' ? 'allow' : 'deny', cmd);
    }
  });

  test('files: deny stays deny, ask becomes deny, allow stays allow', () => {
    const { root, file, config } = setup();
    writeMarker(file, validMarker(['s1']));
    const fileGuard = (tool, p, sid) => {
      const input = { tool_name: tool, tool_input: tool === 'Grep' ? { pattern: 'x', path: p } : { file_path: p }, cwd: root, session_id: sid };
      const v = evaluateFileTool(input, { config, exec: mockExec(), env: {}, now: NOW });
      const out = nightVerdict(v, input, { now: NOW });
      return out ? out.decision : 'allow';
    };
    for (const [tool, p, expected] of FILES) {
      assert.equal(fileGuard(tool, p, 'other'), expected, `${tool} ${p}`);
      assert.equal(fileGuard(tool, p, 's1'), expected === 'allow' ? 'allow' : 'deny', `${tool} ${p}`);
    }
  });
});

describe('queue and marker are not writable by a night session', () => {
  function fileVerdict(root, config, tool, p, sid, now = NOW) {
    const v = evaluateFileTool({ tool_name: tool, tool_input: { file_path: p }, cwd: root, session_id: sid }, { config, exec: mockExec(), env: {}, now });
    return v ? v.decision : 'allow';
  }
  test('Edit and Write on paths.queue and on the marker are denied', () => {
    const { root, file, config } = setup();
    writeMarker(file, validMarker(['s1']));
    for (const tool of ['Edit', 'Write']) {
      assert.equal(fileVerdict(root, config, tool, 'queue/night.md', 's1'), 'deny', `${tool} queue`);
      assert.equal(fileVerdict(root, config, tool, path.join(root, 'queue', 'night.md'), 's1'), 'deny');
      assert.equal(fileVerdict(root, config, tool, file, 's1'), 'deny', `${tool} marker`);
    }
  });
  test('the queue is denied from a worktree too', () => {
    const { root, file, config } = setup();
    writeMarker(file, validMarker(['s1']));
    const wt = makeWorktree(root, 'slot');
    const v = evaluateFileTool(
      { tool_name: 'Write', tool_input: { file_path: path.join(root, 'queue', 'night.md') }, cwd: wt, session_id: 's1' },
      { config: { ...config, repoRoot: wt }, exec: mockExec(), env: {}, now: NOW },
    );
    assert.equal(v?.decision, 'deny');
  });
  test('other files, other sessions, expired and absent markers are untouched', () => {
    const { root, file, config } = setup();
    assert.equal(fileVerdict(root, config, 'Write', 'queue/night.md', 's1'), 'allow');
    writeMarker(file, validMarker(['s1']));
    assert.equal(fileVerdict(root, config, 'Write', 'queue/night-state.json', 's1'), 'allow');
    assert.equal(fileVerdict(root, config, 'Write', 'queue/night.md', 's2'), 'allow');
    assert.equal(fileVerdict(root, config, 'Write', file, 's2'), 'allow');
    assert.equal(fileVerdict(root, config, 'Write', 'queue/night.md', 's1', NOW + 9 * HOUR), 'allow');
  });
  test('Read of the queue stays allowed', () => {
    const { root, file, config } = setup();
    writeMarker(file, validMarker(['s1']));
    assert.equal(fileVerdict(root, config, 'Read', 'queue/night.md', 's1'), 'allow');
  });
});

describe('claim registers the session', () => {
  const CLAIM = 'node /plugin/scripts/night-lock.mjs claim --run run-1';
  test('registers on night-lock.mjs claim', () => {
    const { root, file } = setup();
    writeMarker(file, validMarker());
    assert.equal(registerClaim(bashInput(root, CLAIM, 'sess-a'), { now: NOW }), true);
    assert.deepEqual(readMarker(file, { now: NOW }).sessions, ['sess-a']);
    assert.equal(isNightSession({ session_id: 'sess-a', cwd: root }, { now: NOW }), true);
  });
  test('works for a quoted script path and a PowerShell call', () => {
    const { root, file } = setup();
    writeMarker(file, validMarker());
    const input = { ...bashInput(root, 'node "C:\\kit\\scripts\\night-lock.mjs" claim --run run-1', 'sess-b'), tool_name: 'PowerShell' };
    assert.equal(registerClaim(input, { now: NOW }), true);
  });
  test('does not register other commands, other subcommands, a wrong run id or without a marker', () => {
    const { root, file } = setup();
    assert.equal(registerClaim(bashInput(root, CLAIM, 's'), { now: NOW }), false);
    writeMarker(file, validMarker());
    const others = ['node /p/night-lock.mjs status', 'node /p/night-lock.mjs claim --run other', 'echo night-lock.mjs claim', 'node /p/other.mjs claim', 'git status'];
    for (const cmd of others) {
      assert.equal(registerClaim(bashInput(root, cmd, 's'), { now: NOW }), false, cmd);
    }
    assert.equal(registerClaim({ tool_name: 'Read', tool_input: {}, cwd: root, session_id: 's' }, { now: NOW }), false);
    assert.equal(registerClaim(bashInput(root, CLAIM, ''), { now: NOW }), false);
    assert.deepEqual(readMarker(file, { now: NOW }).sessions, []);
  });
  test('does not register under an expired marker', () => {
    const { root, file } = setup();
    writeMarker(file, validMarker());
    assert.equal(registerClaim(bashInput(root, CLAIM, 's'), { now: NOW + 9 * HOUR }), false);
  });
});

describe('claim registration is narrow (review findings)', () => {
  const claimOk = (cmd, { tool = 'Bash', now = NOW } = {}) => {
    const { root, file } = setup();
    writeMarker(file, validMarker());
    const input = { ...bashInput(root, cmd, 'sess'), tool_name: tool };
    const r = registerClaim(input, { now });
    assert.equal(r, readMarker(file, { now }).sessions.includes('sess'), cmd);
    return r;
  };
  test('requires --run and the marker run id', () => {
    assert.equal(claimOk('node /p/night-lock.mjs claim'), false);
    assert.equal(claimOk('node /p/night-lock.mjs claim --run wrong'), false);
    assert.equal(claimOk('node /p/night-lock.mjs claim --run'), false);
    assert.equal(claimOk('node /p/night-lock.mjs claim --run run-1'), true);
    assert.equal(claimOk('node /p/night-lock.mjs claim --run=run-1'), true);
  });
  test('does not register before the run starts', () => {
    assert.equal(claimOk('node /p/night-lock.mjs claim --run run-1', { now: NOW - 2 * HOUR }), false);
  });
  test('does not register after && or || or in a conditional or after another command', () => {
    for (const cmd of [
      'false && node /p/night-lock.mjs claim --run run-1',
      'false || node /p/night-lock.mjs claim --run run-1',
      'true; node /p/night-lock.mjs claim --run run-1',
      'cd /x && node /p/night-lock.mjs claim --run run-1',
      'if false; then node /p/night-lock.mjs claim --run run-1; fi',
      'echo $(node /p/night-lock.mjs claim --run run-1)',
      'bash -c "node /p/night-lock.mjs claim --run run-1"',
    ]) {
      assert.equal(claimOk(cmd), false, cmd);
    }
  });
  test('claim --help does not register', () => {
    assert.equal(claimOk('node /p/night-lock.mjs claim --help'), false);
    assert.equal(claimOk('node /p/night-lock.mjs claim --run run-1 --help'), false);
  });
  test('node flags before the script are skipped; PowerShell call operator works', () => {
    assert.equal(claimOk('node --no-warnings /p/night-lock.mjs claim --run run-1'), true);
    assert.equal(claimOk('node -r ./x.js /p/night-lock.mjs claim --run run-1'), true);
    assert.equal(claimOk('& node "C:\\kit\\scripts\\night-lock.mjs" claim --run run-1', { tool: 'PowerShell' }), true);
    assert.equal(claimOk('& "node" "C:\\kit\\scripts\\night-lock.mjs" claim --run run-1', { tool: 'PowerShell' }), true);
  });
});

describe('marker validity and fallback (review findings)', () => {
  test('a far-future expiry cannot extend a marker past end plus 30 minutes', () => {
    const { file } = setup();
    const m = { ...validMarker(), start: new Date(NOW - 10 * HOUR).toISOString(), end: new Date(NOW - HOUR).toISOString(), expiry: '2099-01-01T00:00:00Z' };
    writeMarker(file, m);
    assert.equal(readMarker(file, { now: NOW }), null);
    writeMarker(file, { ...m, end: new Date(NOW - 10 * 60 * 1000).toISOString() });
    assert.ok(readMarker(file, { now: NOW }));
  });
  test('.agent-scope fallback needs a run: line, not a bare token', () => {
    const { root, file } = setup();
    writeMarker(file, validMarker([]));
    const wt = makeWorktree(root, 'slot');
    const input = { session_id: 'subagent', cwd: wt };
    for (const text of ['run-1\n', 'note run-1 here\n', 'xrun: run-1\n', 'run: run-1-extra\n']) {
      fs.writeFileSync(path.join(wt, '.agent-scope'), text);
      assert.equal(isNightSession(input, { now: NOW }), false, text);
    }
    fs.writeFileSync(path.join(wt, '.agent-scope'), 'slot\r\n  run: run-1  \r\n');
    assert.equal(isNightSession(input, { now: NOW }), true);
  });
});

describe('queue and marker path matching (review findings)', () => {
  const win = process.platform === 'win32';
  function denied(root, config, p) {
    const v = evaluateFileTool({ tool_name: 'Write', tool_input: { file_path: p }, cwd: root, session_id: 's1' }, { config, exec: mockExec(), env: {}, now: NOW });
    return v?.decision === 'deny';
  }
  test('trailing dot, other case and stream suffix on win32', { skip: win ? false : 'win32 path rules only' }, () => {
    const { root, file, config } = setup();
    writeMarker(file, validMarker(['s1']));
    for (const p of ['queue/night.md.', 'queue/night.md ', 'queue/NIGHT.MD', 'queue\\Night.md', 'queue/night.md::$DATA', 'queue/night.md:stream', 'queue/night.md.::$DATA']) {
      assert.equal(denied(root, config, p), true, p);
    }
    assert.equal(denied(root, config, file.toUpperCase()), true, 'marker upper case');
    assert.equal(denied(root, config, `${file}::$DATA`), true, 'marker stream');
    assert.equal(denied(root, config, 'queue/night.md.bak'), false);
    assert.equal(denied(root, config, 'queue/night.mdx'), false);
  });
  test('long-path, device and UNC admin-share forms on win32', { skip: win ? false : 'win32 path rules only' }, () => {
    const { root, file, config } = setup();
    writeMarker(file, validMarker(['s1']));
    const q = path.join(root, 'queue', 'night.md');
    for (const p of [`\\\\?\\${q}`, `\\\\.\\${q}`, `//?/${q.replace(/\\/g, '/')}`, `\\\\?\\${q}::$DATA`]) {
      assert.equal(denied(root, config, p), true, p);
    }
    assert.equal(denied(root, config, `\\\\?\\${file}`), true, 'marker long path');
    const unc = `\\\\localhost\\${q[0]}$${q.slice(2)}`;
    assert.equal(denied(root, config, unc), true, unc);
    assert.equal(denied(root, config, `\\\\?\\UNC\\localhost\\${q[0]}$${q.slice(2)}`), true, 'long UNC');
    assert.equal(denied(root, config, `\\\\?\\${path.join(root, 'queue', 'other.md')}`), false);
  });
  test('case-insensitive on darwin, exact on linux', { skip: win ? 'covered by the win32 test' : false }, () => {
    const { root, file, config } = setup();
    writeMarker(file, validMarker(['s1']));
    assert.equal(denied(root, config, 'queue/NIGHT.MD'), process.platform === 'darwin');
    assert.equal(denied(root, config, 'queue/night.md'), true);
  });
  test('a path through a symlinked or junctioned parent is the same file', (t) => {
    const { root, file, config } = setup();
    writeMarker(file, validMarker(['s1']));
    fs.mkdirSync(path.join(root, 'queue'), { recursive: true });
    const link = path.join(root, 'alias');
    try {
      fs.symlinkSync(path.join(root, 'queue'), link, win ? 'junction' : 'dir');
    } catch (e) {
      t.skip(`cannot create a link here (${e.code})`);
      return;
    }
    assert.equal(denied(root, config, path.join(link, 'night.md')), true);
    assert.equal(denied(root, config, path.join(link, 'other.md')), false);
  });
  test('a file symlink to the queue or the marker is the same file', (t) => {
    const { root, file, config } = setup();
    writeMarker(file, validMarker(['s1']));
    fs.mkdirSync(path.join(root, 'queue'), { recursive: true });
    fs.writeFileSync(path.join(root, 'queue', 'night.md'), 'q\n');
    const qLink = path.join(root, 'q-alias.md');
    const mLink = path.join(root, 'm-alias.json');
    try {
      fs.symlinkSync(path.join(root, 'queue', 'night.md'), qLink, 'file');
      fs.symlinkSync(file, mLink, 'file');
    } catch (e) {
      t.skip(`cannot create a file symlink here (${e.code})`);
      return;
    }
    assert.equal(denied(root, config, qLink), true, 'queue link');
    assert.equal(denied(root, config, mLink), true, 'marker link');
  });
  test('a Windows 8.3 short name of the marker file is the same file', { skip: win ? false : 'win32 only' }, (t) => {
    const { root, file, config } = setup();
    writeMarker(file, validMarker(['s1']));
    const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${file}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true });
    const short = (r.stdout || '').trim();
    if (!short || path.basename(short).toLowerCase() === path.basename(file).toLowerCase()) {
      t.skip('8.3 short names are not enabled on this volume');
      return;
    }
    assert.equal(denied(root, config, short), true);
  });
});

describe('night helper failures never loosen a verdict', () => {
  test('a throwing night check in guard-files keeps the other verdicts', () => {
    const { root, file, config } = setup();
    writeMarker(file, validMarker(['s1']));
    const broken = new Proxy(config, {
      get: (t, k) => {
        if (k === 'paths') throw new Error('boom');
        return t[k];
      },
    });
    const v = evaluateFileTool({ tool_name: 'Write', tool_input: { file_path: 'src/generated/types.ts' }, cwd: root, session_id: 's1' }, { config: broken, exec: mockExec(), env: {}, now: NOW });
    assert.equal(v?.decision, 'deny');
  });
  test('nightVerdict keeps an ask when the session check throws, and never allows', () => {
    const input = new Proxy(
      {},
      {
        get: () => {
          throw new Error('boom');
        },
      },
    );
    assert.deepEqual(nightVerdict({ decision: 'ask', reason: 'r' }, input), { decision: 'ask', reason: 'r' });
    assert.deepEqual(nightVerdict({ decision: 'deny', reason: 'r' }, input), { decision: 'deny', reason: 'r' });
    assert.equal(nightVerdict({ decision: 'allow', reason: 'r' }, input), null);
  });
});

describe('hook entry points', () => {
  const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
  const live = (sessions) => {
    const root = fakeRepo('devkit-night-spawn-');
    const now = Date.now();
    writeMarker(markerPath(root), { ...buildMarker({ runId: 'run-1', start: now - HOUR, end: now + 4 * HOUR }), sessions });
    return root;
  };
  const spawn = (hook, input) => {
    const r = spawnSync(process.execPath, [path.join(HOOKS, hook)], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: '' } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };
  const bash = (root, sid) => ({ tool_name: 'Bash', tool_input: { command: 'npm install left-pad' }, cwd: root, session_id: sid });
  const edit = (root, sid) => ({ tool_name: 'Edit', tool_input: { file_path: '.claude/settings.json' }, cwd: root, session_id: sid });

  test('guard-bash: registered session gets a deny with the night prefix', () => {
    const out = spawn('guard-bash.mjs', bash(live(['s1']), 's1'));
    assert.equal(out.permissionDecision, 'deny');
    assert.ok(out.permissionDecisionReason.startsWith(NIGHT_DENY_PREFIX));
  });
  test('guard-bash: unregistered session still gets ask', () => {
    assert.equal(spawn('guard-bash.mjs', bash(live(['s1']), 's2')).permissionDecision, 'ask');
  });
  test('guard-files: registered session gets a deny with the night prefix', () => {
    const out = spawn('guard-files.mjs', edit(live(['s1']), 's1'));
    assert.equal(out.permissionDecision, 'deny');
    assert.ok(out.permissionDecisionReason.startsWith(NIGHT_DENY_PREFIX));
  });
  test('guard-files: unregistered session still gets ask', () => {
    assert.equal(spawn('guard-files.mjs', edit(live(['s1']), 's2')).permissionDecision, 'ask');
  });
  test('guard-bash: a claim command registers the session end to end', () => {
    const root = live([]);
    const claim = { tool_name: 'Bash', tool_input: { command: 'node /p/night-lock.mjs claim --run run-1' }, cwd: root, session_id: 'sx' };
    spawn('guard-bash.mjs', claim);
    assert.equal(spawn('guard-bash.mjs', bash(root, 'sx')).permissionDecision, 'deny');
  });
});
