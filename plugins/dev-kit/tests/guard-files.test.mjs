import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { evaluateFileTool } from '../hooks/guard-files.mjs';
import { configFor, fakeRepo, mockExec } from './helpers.mjs';

const root = fakeRepo();
fs.mkdirSync(path.join(root, 'src', 'migrations'), { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'migrations', '001_init.ts'), 'export {}\n');
fs.writeFileSync(path.join(root, 'src', 'migrations', '002_local.ts'), 'export {}\n');
const config = configFor(root);
const exec = mockExec({
  'git cat-file -e origin/dev:src/migrations/001_init.ts': '',
});

function run(tool, input, opts = {}) {
  const v = evaluateFileTool({ tool_name: tool, tool_input: input, cwd: root }, { config, exec, env: {}, ...opts });
  return v ? v.decision : 'allow';
}

describe('reads', () => {
  test('Read .env denied', () => assert.equal(run('Read', { file_path: path.join(root, '.env') }), 'deny'));
  test('Read nested .env.local denied', () => assert.equal(run('Read', { file_path: 'apps/web/.env.local' }), 'deny'));
  test('Read .env.example allowed', () => assert.equal(run('Read', { file_path: path.join(root, '.env.example') }), 'allow'));
  test('Read project secret glob denied', () => assert.equal(run('Read', { file_path: 'config/credentials.json' }), 'deny'));
  test('Read key file denied', () => assert.equal(run('Read', { file_path: 'certs/server.key' }), 'deny'));
  test('Read ordinary file allowed', () => assert.equal(run('Read', { file_path: 'src/app.ts' }), 'allow'));
  test('Grep in .env denied', () => assert.equal(run('Grep', { pattern: 'KEY', path: '.env' }), 'deny'));
  test('Grep in src allowed', () => assert.equal(run('Grep', { pattern: 'KEY', path: 'src' }), 'allow'));
  test('Glob for .env files denied', () => assert.equal(run('Glob', { pattern: '**/.env' }), 'deny'));
  test('Glob for ts files allowed', () => assert.equal(run('Glob', { pattern: 'src/**/*.ts' }), 'allow'));
});

describe('edits', () => {
  test('generated file denied with a regenerate hint', () => {
    const v = evaluateFileTool({ tool_name: 'Edit', tool_input: { file_path: 'src/generated/types.ts' }, cwd: root }, { config, exec, env: {} });
    assert.equal(v.decision, 'deny');
    assert.match(v.reason, /pnpm generate:types/);
  });
  test('merged migration edit denied', () => assert.equal(run('Edit', { file_path: 'src/migrations/001_init.ts' }), 'deny'));
  test('unmerged migration edit allowed', () => assert.equal(run('Edit', { file_path: 'src/migrations/002_local.ts' }), 'allow'));
  test('new migration allowed', () => assert.equal(run('Write', { file_path: 'src/migrations/003_new.ts' }), 'allow'));
  test('settings.json asks', () => assert.equal(run('Edit', { file_path: '.claude/settings.json' }), 'ask'));
  test('settings.local.json asks', () => assert.equal(run('Write', { file_path: '.claude/settings.local.json' }), 'ask'));
  test('workflow.json asks', () => assert.equal(run('Edit', { file_path: '.claude/workflow.json' }), 'ask'));
  test('.claude/hooks asks', () => assert.equal(run('Write', { file_path: '.claude/hooks/pre.sh' }), 'ask'));
  test('plugin root asks', () => assert.equal(run('Edit', { file_path: path.join(root, 'plugin', 'hooks', 'x.mjs') }, { pluginRoot: path.join(root, 'plugin') }), 'ask'));
  test('ordinary file allowed', () => assert.equal(run('Edit', { file_path: 'src/app.ts' }), 'allow'));
  test('other tools ignored', () => assert.equal(run('Bash', { command: 'ls' }), 'allow'));
});
