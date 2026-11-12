import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateProject } from '../scripts/config.mjs';
import { commandFor, findRepoRoot, globMatch, loadConfig, mergeConfig, normalizePath, readJson, DEFAULTS_FILE } from '../scripts/lib/config.mjs';
import { PROJECT, fakeRepo } from './helpers.mjs';

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

describe('mergeConfig', () => {
  const defaults = readJson(DEFAULTS_FILE);
  const merged = mergeConfig(defaults, {
    guard: { secrets: ['x/**'], removableDirs: ['out'], denyCommands: ['a'], askCommands: ['b'] },
    commit: { forbid: ['c'] },
    pullRequest: { sections: ['Only'] },
    models: { writer: { model: 'sonnet' } },
  });
  test('concatenates guard.secrets', () => {
    assert.ok(merged.guard.secrets.includes('**/.env'));
    assert.equal(merged.guard.secrets.at(-1), 'x/**');
  });
  test('concatenates denyCommands, askCommands, commit.forbid', () => {
    assert.deepEqual(merged.guard.denyCommands, ['a']);
    assert.deepEqual(merged.guard.askCommands, ['b']);
    assert.deepEqual(merged.commit.forbid, ['c']);
  });
  test('replaces other arrays', () => {
    assert.deepEqual(merged.guard.removableDirs, ['out']);
    assert.deepEqual(merged.pullRequest.sections, ['Only']);
  });
  test('deep merges objects and keeps siblings', () => {
    assert.equal(merged.models.writer.model, 'sonnet');
    assert.equal(merged.models.reviewer.model, 'opus');
    assert.equal(merged.commit.forbidEmDash, true);
  });
  test('does not mutate defaults', () => assert.equal(defaults.guard.removableDirs.includes('node_modules'), true));
});

describe('loadConfig', () => {
  test('missing project file gives defaults and configured:false', () => {
    const root = fakeRepo();
    const c = loadConfig(path.join(root));
    assert.equal(c.configured, false);
    assert.equal(c.gate.statusContext, 'local-gate');
    assert.equal(c.branches.protected, undefined);
  });
  test('reads .claude/workflow.json from the repo root', () => {
    const root = fakeRepo();
    fs.mkdirSync(path.join(root, '.claude'));
    fs.mkdirSync(path.join(root, 'sub', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'workflow.json'), JSON.stringify(PROJECT));
    const c = loadConfig(path.join(root, 'sub', 'deep'));
    assert.equal(c.configured, true);
    assert.equal(c.branches.integration, 'dev');
    assert.equal(c.branches.remote, 'origin');
    assert.ok(c.guard.secrets.includes('config/credentials.json'));
    assert.ok(c.guard.secrets.includes('**/.env'));
  });
  test('findRepoRoot accepts a .git file (worktree)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-wt-'));
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /elsewhere\n');
    fs.mkdirSync(path.join(dir, 'a'));
    assert.equal(findRepoRoot(path.join(dir, 'a')), dir);
  });
});

describe('commandFor', () => {
  const c = { commands: { lint: 'pnpm lint', build: null } };
  test('named command', () => assert.equal(commandFor('lint', c), 'pnpm lint'));
  test('null command', () => assert.equal(commandFor('build', c), null));
  test('shell fallback', () => assert.equal(commandFor('pnpm check:docs', c), 'pnpm check:docs'));
});

describe('globMatch', () => {
  const root = path.join(os.tmpdir(), 'devkit-glob-root');
  const m = (p, f) => globMatch(p, f, { root });
  test('** matches any depth', () => {
    assert.ok(m('src/migrations/**', 'src/migrations/2024/001.ts'));
    assert.ok(m('**/.env', '.env'));
    assert.ok(m('**/.env', 'apps/web/.env'));
    assert.ok(!m('**/.env', '.env.example'));
  });
  test('* stays within a segment', () => {
    assert.ok(m('src/*.ts', 'src/a.ts'));
    assert.ok(!m('src/*.ts', 'src/x/a.ts'));
  });
  test('? and braces', () => {
    assert.ok(m('file?.txt', 'file1.txt'));
    assert.ok(m('src/**/*.{ts,tsx}', 'src/a/b.tsx'));
    assert.ok(!m('src/**/*.{ts,tsx}', 'src/a/b.js'));
  });
  test('absolute paths inside the root are made relative', () => {
    assert.ok(m('src/**', path.join(root, 'src', 'a.ts')));
  });
  test('backslashes are normalised', () => assert.ok(m('src/**/*.ts', 'src\\a\\b.ts')));
  test('~ expands to the home dir', () => {
    assert.ok(m('~/.ssh/**', path.join(os.homedir(), '.ssh', 'id_rsa')));
    assert.ok(!m('~/.ssh/**', path.join(root, '.ssh', 'id_rsa')));
  });
  test('slashless patterns match basenames', () => assert.ok(m('*.pem', 'deep/dir/server.pem')));
  test('** patterns match outside the root', () => assert.ok(m('**/*.key', path.join(os.homedir(), 'elsewhere', 'a.key'))));
  if (process.platform === 'win32') {
    test('Windows drive letters are case-insensitive and /c/ paths work', () => {
      assert.equal(normalizePath('C:\\Users\\X'), 'c:/Users/X');
      assert.equal(normalizePath('/c/Users/X'), 'c:/Users/X');
      assert.ok(globMatch('C:/Users/**', 'c:\\users\\x\\a.txt'));
    });
  }
  test('UNC prefixes keep their double slash', () => {
    assert.equal(normalizePath('\\\\server\\share\\dir\\a.txt'), '//server/share/dir/a.txt');
    assert.equal(normalizePath('//server/share//dir/'), '//server/share/dir');
    assert.ok(globMatch('**/.env', '\\\\server\\share\\app\\.env'));
  });
});

describe('validator and CLI', () => {
  test('a valid project passes', () => assert.deepEqual(validateProject(PROJECT), []));
  test('missing required and unknown keys are reported', () => {
    const problems = validateProject({ project: 'x', branches: { integration: 'dev' }, extra: 1, gate: { steps: [{ when: [] }] } });
    assert.ok(problems.some((p) => p.includes('commands: required')));
    assert.ok(problems.some((p) => p.includes('branches.protected: required')));
    assert.ok(problems.some((p) => p.includes('extra: unknown key')));
    assert.ok(problems.some((p) => p.includes('gate.steps[0]')));
  });
  test('CLI exits 3 without a project file and still prints defaults', () => {
    const root = fakeRepo();
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'config.mjs')], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 3);
    assert.equal(JSON.parse(r.stdout).configured, false);
  });
  test('CLI prints one value and exits 0 when configured', () => {
    const root = fakeRepo();
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, '.claude', 'workflow.json'), JSON.stringify(PROJECT));
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'config.mjs'), 'branches.integration'], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout), 'dev');
    const v = spawnSync(process.execPath, [path.join(SCRIPTS, 'config.mjs'), '--validate'], { cwd: root, encoding: 'utf8' });
    assert.equal(v.status, 0, v.stdout + v.stderr);
  });
});
