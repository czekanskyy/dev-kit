// Shared fixtures for dev-kit tests. Not a test file itself.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../scripts/lib/config.mjs';

export const PROJECT = {
  project: 'demo',
  branches: { integration: 'dev', protected: ['main', 'test'], remote: 'origin' },
  commands: { lint: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"', build: null, generate: 'pnpm generate:types' },
  gate: {
    steps: [
      'lint',
      'test',
      'build',
      { name: 'e2e', run: 'node -e "1"', minTier: 'T2' },
      { name: 'migrations-check', run: 'node -e "2"', when: ['src/migrations/**'] },
    ],
    statusContext: 'local-gate',
  },
  subprojects: [{ path: 'packages/mobile', gate: [{ name: 'mobile-test', run: 'node -e "3"' }] }],
  guard: {
    generated: ['src/generated/**'],
    immutableOnceMerged: ['src/migrations/**'],
    secrets: ['config/credentials.json'],
    denyCommands: ['\\bterraform\\s+destroy\\b'],
    askCommands: ['\\bkubectl\\b'],
  },
  commit: { forbid: ['\\bWIP\\b'] },
  riskPaths: { globs: ['src/auth/**'], contentPatterns: ['DROP TABLE'] },
  notify: { ntfy: { server: 'https://ntfy.example.test' } },
  onEdit: [{ match: ['src/**/*.ts'], run: ['fmt {files}'], remind: 'Run the type check.' }],
};

/** Creates an empty fake repo (a .git dir) in the temp dir and returns its path. */
export function fakeRepo(prefix = 'devkit-repo-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

export function configFor(root, project = PROJECT) {
  return loadConfig(root, { repoRoot: root, project });
}

/**
 * Mock for the injected exec(file, args, opts). `routes` maps a command prefix
 * ("gh pr view") to a string result, a function(args) or an Error (thrown).
 * Unmatched commands throw with status 128. Calls are recorded in mock.calls.
 */
export function mockExec(routes = {}) {
  const calls = [];
  const fn = (file, args) => {
    const line = [file, ...args].join(' ');
    calls.push(line);
    const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      if (line.startsWith(k)) {
        const r = routes[k];
        if (r instanceof Error) throw r;
        return typeof r === 'function' ? r(args) : r;
      }
    }
    const err = new Error(`unmocked: ${line}`);
    err.status = 128;
    throw err;
  };
  fn.calls = calls;
  return fn;
}

export function exitError(status) {
  const err = new Error(`exit ${status}`);
  err.status = status;
  return err;
}

/** Real git in a temp repo, for risk and gate tests. */
export function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function initRepo(prefix = 'devkit-git-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, 'init', '-q', '-b', 'dev');
  return dir;
}

export function write(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
