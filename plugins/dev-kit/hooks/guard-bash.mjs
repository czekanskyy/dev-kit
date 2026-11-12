#!/usr/bin/env node
// PreToolUse hook for Bash and PowerShell: refuses or asks about dangerous commands.
// A safety net, not a sandbox: see the README for known limits.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  anyGlob,
  currentBranch,
  defaultExec,
  expandHome,
  findRepoRoot,
  isInside,
  isSecretPath,
  loadConfig,
  normalizePath,
  relativeTo,
  toAbsolute,
} from '../scripts/lib/config.mjs';
import { combineVerdicts, emitPreToolUse, isMain, readHookInput } from '../scripts/lib/hook.mjs';
import { baseName, parseCommandLine, parseOpts } from '../scripts/lib/shell.mjs';
import { analyzeRisk } from '../scripts/risk.mjs';

const CALL_TIMEOUT_MS = 20000;
const TOTAL_BUDGET_MS = 90000;

export const ATTRIBUTION_PATTERNS = [
  /co-authored-by:/i,
  /generated (with|by)\b/i,
  /assisted-by:/i,
  /signed-off-by:.*\b(claude|codex|copilot|gpt|ai)\b/i,
  /\u{1F916}/u,
  /claude code/i,
  /\bcodex\b/i,
  /\bcopilot\b/i,
  /\bcursor ai\b/i,
  /\bas an ai\b/i,
  // "claude" as a word, except in paths such as .claude/settings.json or a/claude/x.
  /(?<![./])\bclaude\b/i,
];

const READERS = new Set([
  'cat', 'less', 'head', 'tail', 'more', 'bat', 'batcat', 'type', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk',
  'gawk', 'cp', 'mv', 'base64', 'xxd', 'strings', 'source', '.', 'tac', 'nl', 'od', 'hexdump',
  'get-content', 'gc', 'select-string', 'sls', 'copy-item', 'copy', 'move-item', 'move',
]);
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'node', 'python', 'python3', 'perl', 'ruby', 'pwsh', 'powershell', 'iex', 'invoke-expression']);
const DOWNLOADERS = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm']);
const DB_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'pgcli', 'mongosh', 'mongo']);
const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn', 'bun']);
const PKG_CHANGE = new Set(['add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade', 'upgrade-interactive', 'link', 'unlink']);
const PKG_VALUE_OPTS = new Set([
  '--store-dir', '--filter', '-F', '-C', '--dir', '--prefix', '--registry', '--workspace', '--cwd', '--loglevel', '--reporter',
  '--cache', '--cache-dir', '--virtual-store-dir', '--modules-dir', '--lockfile-dir', '--network-concurrency', '--child-concurrency',
  '--global-dir', '--config', '--userconfig', '--tag', '--omit', '--include',
]);
const PS_REMOVERS = new Set(['remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOWED_POST_HOSTS = ['github.com', 'api.github.com', 'registry.npmjs.org'];
const SECRET_ENV_RE = /(TOKEN|SECRET|KEY|PASSWORD|PASS|DATABASE_URL|_URL$)/i;
const DB_URL_RE = /\b(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?):\/\/([^\s'"`]*)/gi;
const DESTRUCTIVE_SQL_RE = /\b(DROP\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE)\b/i;
const CLAUDE_CONFIG_GLOBS = ['**/.claude/settings.json', '**/.claude/settings.local.json', '**/.claude/workflow.json', '**/.claude/hooks/**'];
const STATE_CHANGING_GIT = new Set(['push', 'commit', 'merge', 'rebase', 'reset', 'cherry-pick', 'revert', 'am', 'pull', 'update-ref']);
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo', '.cache']);

class BudgetExhausted extends Error {}

// ---------------------------------------------------------------------------
// Context

/**
 * opts: { cwd, config, exec, env, branch (override for tests), tmpDir, homeDir, pluginRoot, budgetMs }
 */
export function makeContext(opts = {}) {
  const cwd = normalizePath(path.resolve(opts.cwd ?? process.cwd()));
  const config = opts.config ?? loadConfig(cwd);
  const exec = opts.exec ?? defaultExec;
  const branchCache = new Map();
  const deadline = Date.now() + (opts.budgetMs ?? TOTAL_BUDGET_MS);
  const ctx = {
    cwd,
    config,
    exec,
    env: opts.env ?? process.env,
    repoRoot: normalizePath(config.repoRoot ?? findRepoRoot(cwd) ?? cwd),
    tmpDir: normalizePath(opts.tmpDir ?? os.tmpdir()),
    homeDir: normalizePath(opts.homeDir ?? os.homedir()),
    pluginRoot: opts.pluginRoot ?? (opts.env ?? process.env).CLAUDE_PLUGIN_ROOT ?? null,
    branchOverride: opts.branch,
    /** Runs an external command inside the shared time budget. Throws BudgetExhausted when it is spent. */
    call(file, args, callOpts = {}) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new BudgetExhausted('time budget for external checks is exhausted');
      return exec(file, args, { ...callOpts, timeout: Math.min(CALL_TIMEOUT_MS, remaining) });
    },
    branchAt(dir) {
      if (ctx.branchOverride !== undefined) return ctx.branchOverride;
      const key = normalizePath(dir);
      if (!branchCache.has(key)) {
        let b = null;
        try {
          b = currentBranch(dir, (f, a, o) => ctx.call(f, a, o));
        } catch {
          b = null;
        }
        branchCache.set(key, b);
      }
      return branchCache.get(key);
    },
  };
  return ctx;
}

function branchesOf(config) {
  const b = config.branches ?? {};
  return { protected: new Set(b.protected ?? []), integration: b.integration ?? null, remote: b.remote || 'origin' };
}

function shortRef(ref) {
  return String(ref ?? '')
    .replace(/^\+/, '')
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '');
}

function sameRepo(dir, ctx) {
  const r = findRepoRoot(dir);
  return r !== null && normalizePath(r).toLowerCase() === ctx.repoRoot.toLowerCase();
}

// ---------------------------------------------------------------------------
// Text checks

/** Returns a description of the first forbidden marker in text, or null. */
export function forbiddenText(text, config) {
  const s = String(text ?? '');
  if (!s) return null;
  for (const re of ATTRIBUTION_PATTERNS) {
    const m = re.exec(s);
    if (m) return `tool attribution "${m[0]}"`;
  }
  for (const p of config?.commit?.forbid ?? []) {
    try {
      const m = new RegExp(p, 'i').exec(s);
      if (m) return `forbidden text "${m[0]}" (commit.forbid)`;
    } catch {
      // invalid regex in config: ignore
    }
  }
  if ((config?.commit?.forbidEmDash ?? true) && s.includes('\u2014')) return 'an em-dash (U+2014)';
  return null;
}

function readMessageFile(file, cwd, cmd) {
  if (file === undefined) return { text: '' };
  if (file === '-') return { text: [cmd.heredoc, cmd.herestring].filter(Boolean).join('\n') };
  try {
    return { text: fs.readFileSync(toAbsolute(file, cwd), 'utf8') };
  } catch {
    return { error: `could not read message file ${file}` };
  }
}

function checkMessage(texts, what, config, out) {
  for (const t of texts) {
    if (t && t.error) {
      out.push({ decision: 'ask', reason: `${what}: ${t.error}, so its text could not be checked for tool attribution.` });
      continue;
    }
    const hit = forbiddenText(typeof t === 'string' ? t : t?.text, config);
    if (hit) {
      out.push({
        decision: 'deny',
        reason: `${what} refused: the text contains ${hit}. Remove every AI or tool attribution (and em-dashes) and write it as the human author would, then run it again.`,
      });
      return;
    }
  }
}

function configBroken(ctx, what, out) {
  if (!ctx.config.configError) return false;
  out.push({
    decision: 'deny',
    reason: `${what} refused: .claude/workflow.json exists but cannot be parsed (${ctx.config.configError}), so the branch rules are unknown. Fix the file first.`,
  });
  return true;
}

// ---------------------------------------------------------------------------
// git

function parseGit(argv) {
  const globals = { C: [], c: [] };
  let k = 1;
  while (k < argv.length) {
    const a = argv[k];
    if (a === '-C') {
      globals.C.push(argv[k + 1] ?? '');
      k += 2;
      continue;
    }
    if (a === '-c' || a === '--config-env') {
      globals.c.push(argv[k + 1] ?? '');
      k += 2;
      continue;
    }
    if (a.startsWith('--config-env=')) {
      globals.c.push(a.slice('--config-env='.length));
      k++;
      continue;
    }
    if (['--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path'].includes(a)) {
      globals.C.push(null);
      k += 2;
      continue;
    }
    if (/^--(git-dir|work-tree)=/.test(a)) globals.C.push(null);
    if (a.startsWith('-')) {
      k++;
      continue;
    }
    break;
  }
  return { sub: argv[k], args: argv.slice(k + 1), globals };
}

function evalGit(cmd, ctx, state, out) {
  const { sub, args, globals } = parseGit(cmd.argv);
  const config = ctx.config;
  const br = branchesOf(config);
  let gitCwd = state.cwd;
  let otherDir = false;
  for (const d of globals.C) {
    if (d === null) otherDir = true;
    else gitCwd = toAbsolute(d, gitCwd);
  }
  const known = !otherDir && !state.branchUnknown && sameRepo(gitCwd, ctx);
  let current = null;
  if (known) current = state.branch !== undefined ? state.branch : ctx.branchAt(gitCwd);
  const isProt = (b) => b != null && br.protected.has(shortRef(b));
  const isInteg = (b) => b != null && br.integration != null && shortRef(b) === br.integration;
  const deny = (reason) => out.push({ decision: 'deny', reason });
  const ask = (reason) => out.push({ decision: 'ask', reason });
  const onProtected = isProt(current);

  for (const c of globals.c) {
    if (/^core\.hookspath\b/i.test(c)) deny('git -c core.hooksPath=... refused: it disables the repository hooks. Run the command without overriding hooks.');
  }
  if (!sub) return;
  if (args.includes('--no-verify')) deny(`git ${sub} --no-verify refused: hooks must run. Fix what the hook reports instead of skipping it.`);
  const abortLike = args.some((a) => ['--abort', '--quit', '--skip', '--continue', '--show-current-patch', '--edit-todo'].includes(a));
  const protMsg = (op) => `git ${op} refused: the current branch "${current}" is protected. Create a task branch (git switch -c <branch>) and open a pull request instead.`;

  const branchDestructive =
    sub === 'branch' && args.some((a) => /^-[a-zA-Z]*[DdfMmCc]/.test(a) || ['--delete', '--force', '--move', '--copy'].includes(a));
  const checkoutForce = (sub === 'checkout' && args.some((a) => /^-[a-zA-Z]*B/.test(a))) || (sub === 'switch' && args.some((a) => /^-[a-zA-Z]*C/.test(a)));
  if (!known && !abortLike && (STATE_CHANGING_GIT.has(sub) || branchDestructive || checkoutForce)) {
    ask(
      state.branchUnknown && !otherDir
        ? `git ${sub} runs after a switch to a previous branch (- or @{-N}) that could not be resolved, so the current branch is unknown. Confirm it is not protected.`
        : `git ${sub} runs in another directory or repository (${gitCwd}), whose current branch cannot be checked. Confirm the target branch is not protected.`,
    );
  }

  switch (sub) {
    case 'push':
      if (configBroken(ctx, 'git push', out)) break;
      evalPush(args, ctx, current, known, gitCwd, out);
      break;
    case 'commit': {
      if (onProtected) deny(protMsg('commit'));
      const o = parseOpts(args, { short: 'mFCct', long: ['message', 'file', 'reuse-message', 'reedit-message', 'template', 'author', 'date', 'fixup', 'squash', 'cleanup', 'trailer', 'pathspec-from-file'] });
      if (o.flags.has('n')) deny('git commit -n (--no-verify) refused: hooks must run. Fix what the hook reports instead.');
      if (['C', 'c', 'reuse-message', 'reedit-message'].some((f) => o.flags.has(f))) {
        ask('git commit -C/-c/--reuse-message reuses an existing message that cannot be checked for tool attribution. Confirm, or pass the message with -m.');
      }
      const texts = [...(o.values.m ?? []), ...(o.values.message ?? [])];
      for (const f of [...(o.values.F ?? []), ...(o.values.file ?? [])]) texts.push(readMessageFile(f, gitCwd, cmd));
      for (const t of o.values.trailer ?? []) texts.push(t);
      if (cmd.heredoc && !texts.length) texts.push(cmd.heredoc);
      checkMessage(texts, 'Commit message', config, out);
      break;
    }
    case 'tag': {
      const o = parseOpts(args, { short: 'mFu', long: ['message', 'file', 'local-user', 'cleanup'] });
      const texts = [...(o.values.m ?? []), ...(o.values.message ?? [])];
      for (const f of [...(o.values.F ?? []), ...(o.values.file ?? [])]) texts.push(readMessageFile(f, gitCwd, cmd));
      checkMessage(texts, 'Tag message', config, out);
      break;
    }
    case 'merge':
    case 'cherry-pick':
    case 'revert':
    case 'am':
      if (onProtected && !abortLike) deny(protMsg(sub));
      if (sub === 'merge') {
        const o = parseOpts(args, { short: 'mFsX', long: ['message', 'file', 'strategy', 'strategy-option', 'into-name'] });
        checkMessage([...(o.values.m ?? []), ...(o.values.message ?? [])], 'Merge message', config, out);
      }
      break;
    case 'pull': {
      if (!onProtected || abortLike) break;
      const o = parseOpts(args, { short: 'sXoj', long: ['strategy', 'strategy-option', 'depth', 'deepen', 'shallow-since', 'shallow-exclude', 'upload-pack', 'jobs', 'recurse-submodules'] });
      // The last of --ff-only / --ff / --no-ff wins in git; any rebase option overrides fast-forward-only.
      let ffMode = null;
      let rebase = false;
      for (const a of args) {
        if (a === '--') break;
        if (a === '--ff-only') ffMode = 'only';
        else if (a === '--ff' || a === '--no-ff') ffMode = a;
        else if (/^--(no-)?rebase(=.*)?$/.test(a) || (/^-[a-zA-Z]+$/.test(a) && a.includes('r'))) rebase = true;
      }
      if (o.pos.length >= 2) deny(`git pull with an explicit refspec on protected branch "${current}" refused. Use git pull --ff-only, or work on a task branch.`);
      else if (rebase) deny(`git pull with a rebase option on protected branch "${current}" refused. Use plain git pull --ff-only.`);
      else if (ffMode !== 'only') deny(`git pull on protected branch "${current}" refused unless --ff-only is the effective fast-forward option: it could create a local merge commit. Use git pull --ff-only.`);
      break;
    }
    case 'rebase': {
      if (abortLike) break;
      if (onProtected) deny(protMsg('rebase'));
      const o = parseOpts(args, { short: 'xsXS', long: ['onto', 'exec', 'strategy', 'strategy-option', 'gpg-sign'] });
      if (isProt(o.pos[1])) deny(`git rebase of protected branch "${o.pos[1]}" refused. Rebase your task branch instead.`);
      break;
    }
    case 'reset': {
      const hard = args.includes('--hard');
      if (onProtected && resetMovesRef(args, gitCwd)) deny(protMsg(`reset ${args.join(' ')}`.trim()));
      else if (hard && isInteg(current)) deny(`git reset --hard on the integration branch "${current}" refused. Work on a task branch.`);
      break;
    }
    case 'branch': {
      const o = parseOpts(args, { short: 'u', long: ['set-upstream-to', 'contains', 'no-contains', 'merged', 'no-merged', 'points-at', 'format', 'sort'] });
      const del = o.flags.has('D') || o.flags.has('d') || o.flags.has('delete');
      const force = o.flags.has('f') || o.flags.has('force') || o.flags.has('D');
      const move = o.flags.has('m') || o.flags.has('M') || o.flags.has('move') || o.flags.has('c') || o.flags.has('C') || o.flags.has('copy');
      if (del || force) {
        // Deleting a finished task branch while sitting on a protected branch is fine; only the
        // protected and integration names themselves are refused below.
        if (onProtected && !del) deny(protMsg('branch -f'));
        const targets = del ? o.pos : o.pos.slice(0, 1);
        for (const t of targets) {
          if (isProt(t) || isInteg(t)) deny(`git branch ${del ? 'delete' : 'force'} of "${t}" refused: it is a protected or integration branch.`);
        }
      }
      if (move) {
        const names = o.pos.length >= 2 ? o.pos.slice(0, 2) : [current, ...o.pos];
        for (const t of names) {
          if (isProt(t) || isInteg(t)) deny(`git branch rename/copy involving "${t}" refused: it is a protected or integration branch.`);
        }
      }
      break;
    }
    case 'update-ref': {
      if (onProtected) deny(protMsg('update-ref'));
      const o = parseOpts(args, { short: 'm', long: ['create-reflog'] });
      for (const r of o.pos) {
        if (/^refs\/heads\//.test(r) && (isProt(r) || isInteg(r))) deny(`git update-ref on "${r}" refused: it is a protected or integration branch.`);
      }
      break;
    }
    case 'checkout':
    case 'switch': {
      const o = parseOpts(args, { short: sub === 'checkout' ? 'bB' : 'cC', long: ['orphan', 'conflict', 'pathspec-from-file'] });
      const forceName = sub === 'checkout' ? o.values.B?.[0] : o.values.C?.[0];
      if (forceName !== undefined) {
        if (onProtected) deny(protMsg(sub === 'checkout' ? 'checkout -B' : 'switch -C'));
        if (isProt(forceName) || isInteg(forceName)) deny(`git ${sub} ${sub === 'checkout' ? '-B' : '-C'} "${forceName}" refused: it would reset a protected or integration branch.`);
      }
      if (otherDir || !sameRepo(gitCwd, ctx)) break;
      // Track the branch this command line switches to, for later commands in the same line.
      const created = (sub === 'checkout' ? o.values.b?.[0] : o.values.c?.[0]) ?? forceName;
      if (created) {
        state.branch = created;
        state.branchUnknown = false;
      } else if (o.pos.length === 1 && !args.includes('--') && !o.flags.has('detach') && !o.flags.has('d')) {
        const target = o.pos[0];
        const prev = target === '-' ? '@{-1}' : /^@\{-\d+\}$/.test(target) ? target : null;
        if (prev) {
          const resolved = resolvePreviousBranch(ctx, gitCwd, prev);
          state.branch = resolved ?? undefined;
          state.branchUnknown = resolved === null;
        } else if (!(sub === 'checkout' && fs.existsSync(toAbsolute(target, gitCwd)))) {
          state.branch = target;
          state.branchUnknown = false;
        }
      }
      break;
    }
    case 'config': {
      const o = parseOpts(args, { short: 'f', long: ['file', 'blob', 'type', 'default', 'comment', 'value'] });
      let pos = o.pos;
      let mode = 'auto';
      if (['get', 'list', 'get-regexp', 'get-urlmatch', 'edit'].includes(pos[0])) mode = 'read';
      else if (['set', 'unset', 'rename-section', 'remove-section'].includes(pos[0])) mode = 'write';
      if (mode !== 'auto') pos = pos.slice(1);
      if (['get', 'get-all', 'get-regexp', 'list', 'l', 'get-urlmatch', 'show-origin'].some((f) => o.flags.has(f)) && mode === 'auto') mode = 'read';
      if (['unset', 'unset-all', 'add', 'replace-all', 'rename-section', 'remove-section'].some((f) => o.flags.has(f))) mode = 'write';
      if (mode === 'auto') mode = pos.length >= 2 ? 'write' : 'read';
      const key = (pos[0] ?? '').toLowerCase();
      if (mode === 'write' && ['user.name', 'user.email', 'core.hookspath'].includes(key)) {
        deny(`git config ${pos[0]} refused: identity and hook settings are managed by the user. Leave them as they are.`);
      }
      break;
    }
    case 'filter-branch':
    case 'filter-repo':
      deny(`git ${sub} refused: rewriting history is for a human to do by hand.`);
      break;
    case 'clean': {
      const o = parseOpts(args, { short: 'e', long: ['exclude'] });
      if (o.flags.has('n') || o.flags.has('dry-run')) break;
      if (o.flags.has('x') || o.flags.has('X')) {
        deny('git clean -x/-X refused: it deletes ignored files such as .env and local databases. Delete the specific build output directories instead.');
      } else if (o.flags.has('f') || o.flags.has('force')) {
        ask('git clean -f deletes untracked files permanently. Confirm, or run git clean -n first to see what would go.');
      }
      break;
    }
    case 'worktree':
      if (args[0] === 'remove' || args[0] === 'prune') ask(`git worktree ${args[0]} deletes a working tree. Confirm it holds nothing uncommitted.`);
      break;
    default:
      break;
  }
}

/** Branch name behind @{-N}, or null when it cannot be resolved (or is a detached commit). */
function resolvePreviousBranch(ctx, cwd, selector) {
  try {
    const out = String(ctx.call('git', ['rev-parse', '--abbrev-ref', selector], { cwd })).trim();
    return out && out !== 'HEAD' ? out : null;
  } catch {
    return null;
  }
}

/** True when `git reset <args>` would move the current branch ref. */
function resetMovesRef(args, cwd) {
  if (args.some((a) => ['--soft', '--mixed', '--hard', '--merge', '--keep'].includes(a))) return true;
  if (args.includes('-p') || args.includes('--patch') || args.includes('--')) return false;
  const pos = args.filter((a) => !a.startsWith('-'));
  if (pos.length !== 1) return false; // nothing (unstage all) or commit + paths: the ref stays
  return !fs.existsSync(toAbsolute(pos[0], cwd));
}

function evalPush(args, ctx, current, known, gitCwd, out) {
  const br = branchesOf(ctx.config);
  const o = parseOpts(args, { short: 'o', long: ['repo', 'receive-pack', 'exec', 'push-option'] });
  const deny = (reason) => out.push({ decision: 'deny', reason });
  const ask = (reason) => out.push({ decision: 'ask', reason });
  const force = o.flags.has('f') || o.flags.has('force') || o.flags.has('force-with-lease');
  const del = o.flags.has('d') || o.flags.has('delete');
  const guarded = br.protected.size > 0 || br.integration !== null;
  const isProt = (b) => b != null && br.protected.has(shortRef(b));
  const isInteg = (b) => b != null && br.integration != null && shortRef(b) === br.integration;

  if ((o.flags.has('all') || o.flags.has('branches') || o.flags.has('mirror')) && guarded) {
    deny('git push --all/--mirror refused: it would push protected or integration branches. Push your task branch by name.');
  }
  // With --repo the remote comes from the option and every positional is a refspec.
  const repoOpt = o.values.repo?.[0];
  const remoteArg = repoOpt === undefined ? o.pos[0] : repoOpt;
  const specs = repoOpt === undefined ? o.pos.slice(1) : o.pos;
  if (remoteArg && remoteArg !== br.remote) ask(`git push to remote "${remoteArg}" (the configured remote is "${br.remote}"). Confirm this remote is intended.`);

  const targets = [];
  if (specs.length === 0 && !o.flags.has('all') && !o.flags.has('mirror') && !o.flags.has('branches') && !o.flags.has('tags')) {
    if (!known) return; // already asked for an unknown directory
    if (isProt(current)) {
      deny(`git push refused: the current branch "${current}" is protected. Push a task branch and open a pull request instead.`);
      return;
    }
    if (isInteg(current)) {
      deny(`git push refused: the current branch "${current}" is the integration branch, which only changes through gh pr merge after the gate. Push a task branch instead.`);
      return;
    }
    if (!guarded) return;
    const dest = resolvePushDestination(ctx, gitCwd, remoteArg);
    if (dest === null) {
      ask('git push without a refspec: its destination branch could not be resolved (no @{push} or @{upstream}). Push with an explicit refspec, e.g. git push -u origin <task-branch>.');
      return;
    }
    targets.push({ dst: dest, plus: false, del: false });
  } else {
    for (const spec of specs) {
      const plus = spec.startsWith('+');
      const s = plus ? spec.slice(1) : spec;
      if (s === ':' || s === '') {
        if (guarded) deny('git push with a matching refspec (":") refused: it pushes every branch with the same name, protected ones included. Push your task branch by name.');
        continue;
      }
      let dst;
      const idx = s.indexOf(':');
      if (del) dst = s;
      else if (idx >= 0) dst = s.slice(idx + 1) || s.slice(0, idx);
      else dst = s === 'HEAD' || s === '@' ? current ?? 'HEAD' : s;
      // Only the destination decides: a tag source pushed onto a branch is still a branch push.
      if (dst.startsWith('refs/tags/')) continue;
      targets.push({ dst: shortRef(dst), plus, del: del || idx === 0 });
    }
  }
  for (const t of targets) {
    if (t.dst.includes('*')) {
      if (guarded) deny(`git push with a wildcard refspec ("${t.dst}") refused: it can reach protected branches. Push your task branch by name.`);
    } else if (isProt(t.dst)) {
      deny(`git push to protected branch "${t.dst}" refused. Push your task branch and open a pull request instead.`);
    } else if (isInteg(t.dst)) {
      deny(`git push to the integration branch "${t.dst}" refused: it only changes through gh pr merge after the gate. Push your task branch and open a pull request.`);
    } else if (force || t.plus || t.del) {
      // force-pushing or deleting a task branch is fine
    }
  }
}

function resolvePushDestination(ctx, cwd, remoteArg) {
  for (const spec of ['@{push}', '@{upstream}']) {
    try {
      const out = String(ctx.call('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', spec], { cwd })).trim();
      if (!out) continue;
      const remote = remoteArg && out.startsWith(`${remoteArg}/`) ? remoteArg : out.split('/')[0];
      return out.slice(remote.length + 1);
    } catch {
      // try the next form
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// gh

function ghJson(ctx, args, cwd) {
  return JSON.parse(ctx.call('gh', args, { cwd }));
}

/** Removes gh's leading global flags (--repo/-R, --hostname, others) so the command group is found. */
export function stripGhGlobals(argv) {
  let repo;
  let k = 1;
  while (k < argv.length && argv[k].startsWith('-')) {
    const a = argv[k];
    if (a === '--repo' || a === '-R') {
      repo = argv[k + 1];
      k += 2;
    } else if (a.startsWith('--repo=')) {
      repo = a.slice('--repo='.length);
      k++;
    } else if (a.startsWith('-R') && a.length > 2) {
      repo = a.slice(2);
      k++;
    } else if (a === '--hostname') {
      k += 2;
    } else {
      k++;
    }
  }
  return { argv: [argv[0], ...argv.slice(k)], repo };
}

function evalGh(cmd, ctx, state, out) {
  const { argv: ghArgv, repo: globalRepo } = stripGhGlobals(cmd.argv);
  const [, group, sub, ...rest] = ghArgv;
  const deny = (reason) => out.push({ decision: 'deny', reason });
  const ask = (reason) => out.push({ decision: 'ask', reason });
  const config = ctx.config;

  if (group === 'pr' && (sub === 'create' || sub === 'edit')) {
    if (sub === 'create' && configBroken(ctx, 'gh pr create', out)) return;
    const o = parseOpts(rest, {
      short: 'tbFBHalmprRTe',
      long: ['title', 'body', 'body-file', 'base', 'head', 'assignee', 'label', 'milestone', 'project', 'reviewer', 'template', 'repo', 'add-label', 'remove-label', 'add-reviewer', 'remove-reviewer', 'add-assignee', 'remove-assignee', 'add-project', 'remove-project', 'recover'],
    });
    const texts = [...(o.values.t ?? []), ...(o.values.title ?? []), ...(o.values.b ?? []), ...(o.values.body ?? [])];
    for (const f of [...(o.values.F ?? []), ...(o.values['body-file'] ?? [])]) texts.push(readMessageFile(f, state.cwd, cmd));
    checkMessage(texts, 'Pull request text', config, out);
    return;
  }
  if (group === 'pr' && sub === 'merge') {
    evalPrMerge(rest, ctx, state, cmd, out, globalRepo);
    return;
  }
  if (group === 'api') {
    const args = ghArgv.slice(2);
    const o = parseOpts(args, { short: 'XfFHpqt', long: ['method', 'raw-field', 'field', 'header', 'preview', 'jq', 'template', 'input', 'cache', 'hostname'] });
    const endpoint = String(o.pos[0] ?? '').replace(/^https:\/\/api\.github\.com\//, '').replace(/^\//, '');
    const hasFields = ['f', 'F', 'raw-field', 'field', 'input'].some((f) => o.flags.has(f));
    const method = String(o.values.X?.[0] ?? o.values.method?.[0] ?? (hasFields ? 'POST' : 'GET')).toUpperCase();
    if (endpoint === 'graphql') {
      const q = [...(o.values.f ?? []), ...(o.values.F ?? []), ...(o.values['raw-field'] ?? []), ...(o.values.field ?? [])].join('\n');
      if (/\bmutation\b/i.test(q)) ask('gh api graphql mutation: it can change repository state. Confirm this change.');
      return;
    }
    if (/^repos\/[^/]+\/[^/]+/.test(endpoint) && WRITE_METHODS.has(method)) {
      const isStatus = method === 'POST' && /^repos\/[^/]+\/[^/]+\/statuses\/[^/]+$/.test(endpoint);
      const isComment =
        (method === 'POST' || method === 'PATCH') &&
        /^repos\/[^/]+\/[^/]+\/(issues|pulls)\/(\d+\/comments|comments\/\d+|comments\/\d+\/replies|\d+\/comments\/\d+\/replies)$/.test(endpoint);
      if (!isStatus && !isComment) {
        deny(`gh api ${method} ${endpoint} refused: repository settings, branches, rulesets, hooks and collaborators are managed by a human. Ask the user to make this change.`);
      }
    } else if (WRITE_METHODS.has(method) && !/^repos\//.test(endpoint)) {
      ask(`gh api ${method} ${endpoint}: a write outside a repository. Confirm this change.`);
    }
    return;
  }
  if (group === 'repo' && ['edit', 'delete', 'rename', 'archive', 'unarchive'].includes(sub)) return deny(`gh repo ${sub} refused: repository settings are managed by a human.`);
  if (group === 'secret') return deny('gh secret refused: secrets are managed by a human. Ask the user to set it.');
  if (group === 'variable' && ['set', 'delete'].includes(sub)) return deny(`gh variable ${sub} refused: repository variables are managed by a human.`);
  if (group === 'auth' && sub === 'token') return deny('gh auth token refused: it prints a credential. gh commands authenticate on their own.');
  if (group === 'auth' && sub === 'status' && rest.some((a) => a === '--show-token' || a === '-t')) {
    deny('gh auth status --show-token refused: it prints a credential. Use gh auth status without it.');
  }
}

function evalPrMerge(args, ctx, state, cmd, out, globalRepo) {
  const deny = (reason) => out.push({ decision: 'deny', reason });
  const ask = (reason) => out.push({ decision: 'ask', reason });
  const config = ctx.config;
  const br = branchesOf(config);
  const o = parseOpts(args, { short: 'tbFAR', long: ['subject', 'body', 'body-file', 'author-email', 'match-head-commit', 'repo'] });
  if (o.flags.has('admin')) return deny('gh pr merge --admin refused: it bypasses branch protection. Get the required checks and reviews green instead.');
  if (o.flags.has('auto')) return deny('gh pr merge --auto refused: the merge must happen now, on the commit the gate checked. Merge explicitly once the gate is green.');
  const texts = [...(o.values.t ?? []), ...(o.values.subject ?? []), ...(o.values.b ?? []), ...(o.values.body ?? [])];
  for (const f of [...(o.values.F ?? []), ...(o.values['body-file'] ?? [])]) texts.push(readMessageFile(f, state.cwd, cmd));
  checkMessage(texts, 'Merge commit text', config, out);
  if (configBroken(ctx, 'gh pr merge', out)) return;

  const repo = o.values.R?.[0] ?? o.values.repo?.[0] ?? globalRepo;
  const repoArgs = repo ? ['--repo', repo] : [];
  const sel = o.pos[0];
  const cwd = state.cwd;
  let pr;
  try {
    pr = ghJson(ctx, ['pr', 'view', ...(sel ? [sel] : []), '--json', 'baseRefName,headRefOid,headRefName,files', ...repoArgs], cwd);
  } catch (err) {
    return deny(`gh pr merge refused: the pull request could not be looked up (${err.message}), so its base and head are unknown. Check gh auth and the PR number, then retry.`);
  }
  const base = pr.baseRefName;
  if (br.protected.has(base)) return deny(`gh pr merge refused: the pull request targets protected branch "${base}". Merging there is for a human.`);
  const sha = pr.headRefOid;
  const short = String(sha).slice(0, 12);
  const mhc = o.values['match-head-commit']?.[0];
  if (!mhc || mhc !== sha) {
    deny(`gh pr merge refused: add --match-head-commit ${sha} so the merge fails if the branch moves after this check.`);
  }
  if (!br.integration || base !== br.integration) return;

  try {
    const nwo = repo ?? ghJson(ctx, ['repo', 'view', '--json', 'nameWithOwner'], cwd).nameWithOwner;
    const statusContext = config.gate?.statusContext || 'local-gate';
    let entry;
    try {
      const status = ghJson(ctx, ['api', `repos/${nwo}/commits/${sha}/status`], cwd);
      entry = (status.statuses ?? []).find((s) => s.context === statusContext);
    } catch (err) {
      return deny(`gh pr merge refused: the "${statusContext}" commit status could not be read (${err.message}).`);
    }
    if (!entry || entry.state !== 'success') {
      deny(`gh pr merge refused: commit status "${statusContext}" on ${short} is ${entry ? entry.state : 'missing'}. Run the gate (node scripts/gate.mjs --post-status) on that exact commit first.`);
    } else {
      const tier = /^(T[0-3])\b/.exec(String(entry.description ?? ''))?.[1];
      if (!tier) ask(`gh pr merge: the gate status on ${short} does not record a tier, so the merge policy is unknown. Confirm the merge.`);
      else {
        const policy = config.tiers?.[tier]?.merge ?? 'orchestrator';
        if (policy === 'ask' || policy === 'human') ask(`gh pr merge: ${tier} changes need the user's approval before merging (tiers.${tier}.merge is "${policy}").`);
      }
    }

    let intSha;
    try {
      intSha = String(ctx.call('gh', ['api', `repos/${nwo}/branches/${br.integration}`, '--jq', '.commit.sha'], { cwd })).trim();
      if (!/^[0-9a-f]{4,64}$/i.test(intSha)) throw new Error(`unexpected answer "${intSha.slice(0, 40)}"`);
    } catch (err) {
      return deny(`gh pr merge refused: the current ${br.integration} commit on the server could not be read (${err.message}).`);
    }
    const fetchMsg = `git fetch and rebase onto ${br.integration}, then rerun the gate`;
    for (const obj of [intSha, sha]) {
      try {
        ctx.call('git', ['cat-file', '-e', `${obj}^{commit}`], { cwd });
      } catch {
        return deny(`gh pr merge refused: commit ${obj.slice(0, 12)} is not in the local repository. ${fetchMsg}.`);
      }
    }
    try {
      ctx.call('git', ['merge-base', '--is-ancestor', intSha, sha], { cwd });
    } catch (err) {
      return deny(
        err && err.status === 1
          ? `gh pr merge refused: the pull request head does not contain the current ${br.integration} (${intSha.slice(0, 12)}). ${fetchMsg}.`
          : `gh pr merge refused: the head could not be compared with ${br.integration} (${err.message}). ${fetchMsg}.`,
      );
    }
  } catch (err) {
    return deny(`gh pr merge refused: a merge check failed (${err.message}).`);
  }

  try {
    const files = (pr.files ?? []).map((f) => f.path);
    const risk = analyzeRisk({ cwd, config, pr: sel ?? pr.headRefName, repo, prFiles: files, baseRefName: base, exec: (f, a, op) => ctx.call(f, a, op) });
    if (risk.touchesRisk === null) ask(`gh pr merge: risk analysis unavailable (${risk.error}). Confirm the merge.`);
    else if (risk.touchesRisk) {
      const list = [...risk.riskFiles, ...risk.contentHits.map((h) => `${h.file}:${h.line}`)].slice(0, 8).join(', ');
      ask(`gh pr merge: this pull request touches risk paths (${list}). The user approves risky merges.`);
    }
  } catch (err) {
    ask(`gh pr merge: risk analysis unavailable (${err.message}). Confirm the merge.`);
  }
}

// ---------------------------------------------------------------------------
// Files, secrets, deletion

function expandArgGlob(arg, cwd) {
  if (!/[*?[]/.test(arg)) return [arg];
  const norm = normalizePath(arg);
  const slash = norm.lastIndexOf('/');
  const dirPart = slash >= 0 ? norm.slice(0, slash) || '/' : '.';
  const pat = slash >= 0 ? norm.slice(slash + 1) : norm;
  if (/[*?[]/.test(dirPart)) return [arg];
  const re = new RegExp(`^${pat.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  try {
    const names = fs.readdirSync(toAbsolute(dirPart, cwd)).filter((n) => re.test(n));
    return [arg, ...names.map((n) => (slash >= 0 ? `${dirPart}/${n}` : n))];
  } catch {
    return [arg];
  }
}

function pathArgs(argv) {
  const out = [];
  let afterDashes = false;
  for (const a of argv.slice(1)) {
    if (!afterDashes && a === '--') {
      afterDashes = true;
      continue;
    }
    if (!afterDashes && a.startsWith('-')) {
      const eq = a.indexOf('=');
      if (a.startsWith('--') && eq > 0) out.push(a.slice(eq + 1));
      continue;
    }
    out.push(a);
  }
  return out;
}

function secretHit(arg, ctx, cwd) {
  if (!arg || /^[a-z]+:\/\//i.test(arg)) return null;
  for (const p of expandArgGlob(expandHome(arg), cwd)) {
    if (isSecretPath(p, ctx.config, { cwd, root: ctx.repoRoot })) return p === expandHome(arg) ? arg : p;
  }
  return null;
}

/** First secret file found under dir (bounded walk), or null. */
export function findSecretUnder(dir, ctx, { maxEntries = 5000, maxDepth = 6 } = {}) {
  const config = ctx.config;
  const opts = { cwd: dir, root: ctx.repoRoot };
  if (isSecretPath(dir, config, opts)) return dir;
  const queue = [[dir, 0]];
  let seen = 0;
  while (queue.length) {
    const [d, depth] = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > maxEntries) return null;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SCAN_SKIP_DIRS.has(e.name) && depth < maxDepth) queue.push([p, depth + 1]);
        if (isSecretPath(path.join(p, 'x'), config, opts)) return p;
      } else if (isSecretPath(p, config, opts)) {
        return p;
      }
    }
  }
  return null;
}

function evalSecrets(cmd, ctx, state, out) {
  const b = baseName(cmd.argv[0]);
  const ps = cmd.dialect === 'powershell';
  const deny = (what) =>
    out.push({
      decision: 'deny',
      reason: `Reading secret file "${what}" refused. Ask the user for the specific non-secret value you need, or read the example file (.env.example) instead.`,
    });
  const ask = (reason) => out.push({ decision: 'ask', reason });
  for (const r of cmd.redirects) {
    if (r.op === '<' || r.op === '<>') {
      const hit = secretHit(r.target, ctx, state.cwd);
      if (hit) deny(hit);
    }
  }
  if (READERS.has(b)) {
    for (const a of pathArgs(cmd.argv)) {
      const hit = secretHit(a, ctx, state.cwd);
      if (hit) {
        deny(hit);
        break;
      }
    }
  }
  // Recursive search that reads hidden or ignored files.
  if (b === 'rg' || b === 'grep' || b === 'egrep' || b === 'fgrep') {
    const args = cmd.argv.slice(1);
    let reads = false;
    if (b === 'rg') {
      const uCount = args.filter((a) => /^-[a-zA-Z]*u/.test(a) && !a.startsWith('--')).reduce((n, a) => n + (a.match(/u/g) ?? []).length, 0);
      reads = args.some((a) => a === '--hidden' || a === '-.' || a.startsWith('--no-ignore')) || uCount >= 2;
    } else {
      reads = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) && !a.startsWith('--')) || args.includes('--recursive') || args.includes('--dereference-recursive');
    }
    if (reads) {
      const dirs = pathArgs(cmd.argv).filter((p) => {
        try {
          return fs.statSync(toAbsolute(expandHome(p), state.cwd)).isDirectory();
        } catch {
          return false;
        }
      });
      const targets = dirs.length ? dirs : ['.'];
      for (const d of targets) {
        const hit = findSecretUnder(toAbsolute(expandHome(d), state.cwd), ctx);
        if (hit) {
          ask(`${b} over "${d}" also reads hidden or ignored files, and that directory holds a secret file (${normalizePath(hit)}). Narrow the search, or confirm.`);
          break;
        }
      }
    }
  }
  const args = cmd.argv.slice(1);
  if (b === 'printenv') {
    if (!args.length) ask('printenv without arguments prints every environment variable, secrets included. Confirm, or print only the variable you need.');
    else if (args.some((a) => SECRET_ENV_RE.test(a))) ask(`printenv ${args.join(' ')}: the variable looks like a secret. Confirm you need its value.`);
  }
  if (b === 'env' && cmd.argv.length === 1) ask('env without a command prints every environment variable, secrets included. Confirm, or print only the variable you need.');
  if ((b === 'export' || b === 'declare' || b === 'typeset') && (args.length === 0 || (args.length === 1 && /^-[px]+$/.test(args[0])))) {
    ask(`${b} ${args.join(' ')} prints every exported variable, secrets included. Confirm.`);
  }
  if (b === 'set' && args.length === 0 && !ps) ask('set without arguments prints every shell variable, secrets included. Confirm.');
  if (['get-childitem', 'gci', 'ls', 'dir'].includes(b) && args.some((a) => /^env:\\?$/i.test(a))) ask(`${b} env: prints every environment variable, secrets included. Confirm.`);
  if (b === 'echo' || b === 'printf' || b === 'print' || b === 'write-output' || b === 'write-host') {
    for (const a of args) {
      for (const m of a.matchAll(/\$(?:env:)?\{?([A-Za-z_][A-Za-z0-9_]*)/gi)) {
        if (SECRET_ENV_RE.test(m[1])) {
          ask(`${b} of $${m[1]}: the variable looks like a secret. Confirm you need its value printed.`);
          break;
        }
      }
    }
  }
}

/** Classifies one recursive-delete target: null (allowed) or {decision, reason}. */
export function classifyRemoval(target, ctx, cwd) {
  const config = ctx.config;
  const removable = new Set((config.guard?.removableDirs ?? []).map((d) => d.toLowerCase()));
  const t = expandHome(target);
  if (t === '' || t === '{}' || /\$/.test(t)) {
    return { decision: 'ask', reason: `Recursive delete of "${target}": the path depends on a variable or placeholder and cannot be checked. Confirm the exact target.` };
  }
  const abs = toAbsolute(t, cwd);
  const lc = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const segs = abs.split('/').filter(Boolean);
  if (abs === '/' || /^[a-z]:\/?$/i.test(abs) || segs.length === 0) return { decision: 'deny', reason: `Recursive delete of the file system root ("${target}") refused.` };
  if (lc(abs) === lc(ctx.homeDir)) return { decision: 'deny', reason: `Recursive delete of the home directory ("${target}") refused.` };
  if (segs.some((s) => s === '.git')) return { decision: 'deny', reason: `Recursive delete inside .git ("${target}") refused: it destroys repository history.` };
  if (isInside(abs, ctx.tmpDir, { strict: true })) return null;
  try {
    const gitFile = path.join(abs, '.git');
    if (fs.existsSync(gitFile) && fs.statSync(gitFile).isFile()) {
      return { decision: 'ask', reason: `Recursive delete of "${target}" removes a git worktree. Prefer git worktree remove; confirm it holds nothing uncommitted.` };
    }
  } catch {
    // ignore
  }
  const root = ctx.repoRoot;
  if (root && lc(abs) === lc(root)) return { decision: 'deny', reason: `Recursive delete of the repository root ("${target}") refused.` };
  if (root && isInside(root, abs)) return { decision: 'deny', reason: `Recursive delete of "${target}" refused: it contains the repository.` };
  if (!root || !isInside(abs, root)) return { decision: 'deny', reason: `Recursive delete of "${target}" refused: it is outside the repository. Delete it yourself if it really should go.` };
  const rel = relativeTo(abs, root).split('/');
  if (rel.some((s) => !/[*?[]/.test(s) && removable.has(s.toLowerCase()))) return null;
  return {
    decision: 'deny',
    reason: `Recursive delete of "${target}" refused: only build output and dependency folders (${[...removable].join(', ')}) may be deleted recursively. Delete individual files, or ask the user.`,
  };
}

const PS_VALUE_PARAMS = ['path', 'literalpath', 'filter', 'include', 'exclude', 'credential', 'stream', 'lp', 'pspath'];
const PS_SWITCH_PARAMS = ['recurse', 'force', 'whatif', 'confirm', 'verbose', 'debug', 'erroraction', 'warningaction'];

/** Resolves a (possibly abbreviated) PowerShell parameter name; null when unknown or ambiguous. */
function psParam(name) {
  const all = [...PS_VALUE_PARAMS, ...PS_SWITCH_PARAMS];
  if (all.includes(name)) return name;
  const c = all.filter((p) => p.startsWith(name));
  return c.length === 1 ? c[0] : null;
}

function psRemovalArgs(args) {
  const targets = [];
  let recursive = false;
  let whatIf = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (/^\/[sS]$/.test(a)) {
      recursive = true;
      continue;
    }
    if (/^\/[qQ]$/.test(a)) continue;
    if (/^-[A-Za-z]/.test(a)) {
      const [nameRaw, inline] = a.slice(1).split(/:(.*)/s);
      const p = psParam(nameRaw.toLowerCase());
      if (p === 'recurse') recursive = true;
      else if (p === 'whatif') whatIf = true;
      else if (p === 'erroraction' || p === 'warningaction') k += inline === undefined ? 1 : 0;
      else if (p && PS_VALUE_PARAMS.includes(p)) {
        const v = inline !== undefined && inline !== '' ? inline : args[++k];
        if (['path', 'literalpath', 'lp', 'pspath'].includes(p)) targets.push(v);
      }
      continue;
    }
    targets.push(a);
  }
  return { recursive, whatIf, targets: targets.filter((t) => t !== undefined).flatMap((t) => String(t).split(',')).map((t) => t.trim()).filter(Boolean) };
}

function evalRemoval(cmd, ctx, state, out) {
  const b = baseName(cmd.argv[0]);
  const ps = cmd.dialect === 'powershell';
  if (PS_REMOVERS.has(b) && (ps || cmd.argv.some((a) => /^\/[sS]$/.test(a))) || (b === 'rm' && ps)) {
    const r = psRemovalArgs(cmd.argv.slice(1));
    if (!r.recursive || r.whatIf) return;
    if (!r.targets.length) out.push({ decision: 'ask', reason: `${cmd.argv[0]} -Recurse without a target path cannot be checked. Confirm what will be deleted.` });
    for (const t of r.targets) {
      const v = classifyRemoval(t, ctx, state.cwd);
      if (v) out.push(v);
    }
    return;
  }
  if (b === 'rm') {
    const o = parseOpts(cmd.argv.slice(1), {});
    const recursive = o.flags.has('r') || o.flags.has('R') || o.flags.has('recursive');
    if (!recursive) return;
    if (!o.pos.length && (cmd.fromXargs || cmd.fromFind)) {
      out.push({ decision: 'ask', reason: 'rm -r with targets coming from xargs cannot be checked. Confirm what will be deleted.' });
      return;
    }
    for (const t of o.pos) {
      const v = classifyRemoval(t, ctx, state.cwd);
      if (v) out.push(v);
    }
    return;
  }
  if (b === 'find' && cmd.argv.includes('-delete')) {
    const starts = [];
    for (const a of cmd.argv.slice(1)) {
      if (a.startsWith('-') || a === '(' || a === '!') break;
      starts.push(a);
    }
    for (const t of starts.length ? starts : ['.']) {
      if (classifyRemoval(t, ctx, state.cwd)) {
        out.push({ decision: 'ask', reason: `find ${t} ... -delete removes files recursively outside a build folder. Confirm the selection.` });
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Databases, docker, infrastructure, network, packages

function hostOfDbUrl(rest) {
  let auth = rest.split(/[/?#]/)[0];
  const at = auth.lastIndexOf('@');
  if (at >= 0) auth = auth.slice(at + 1);
  if (auth.startsWith('[')) return auth.slice(1, auth.indexOf(']') > 0 ? auth.indexOf(']') : undefined);
  return auth.split(',')[0].split(':')[0];
}

function evalData(cmd, ctx, state, out, all) {
  const argv = cmd.argv;
  const b = baseName(argv[0]);
  const deny = (reason) => out.push({ decision: 'deny', reason });
  const ask = (reason) => out.push({ decision: 'ask', reason });
  const local = new Set((ctx.config.guard?.localHosts ?? []).map((h) => h.toLowerCase()));

  const isCompose = b === 'docker' || b === 'podman' ? argv.includes('compose') : b === 'docker-compose' || b === 'podman-compose';
  if (isCompose) {
    const downIdx = argv.indexOf('down');
    if (downIdx >= 0) {
      const after = argv.slice(downIdx + 1);
      if (after.some((a) => a === '--volumes' || (a.startsWith('--volumes=') && a !== '--volumes=false') || /^-[a-zA-Z]*v[a-zA-Z]*$/.test(a))) {
        deny('docker compose down -v refused: it deletes the database volumes. Use docker compose down (without -v) to stop the services.');
      }
    }
  } else if (b === 'docker' || b === 'podman') {
    const [sub, sub2] = argv.slice(1).filter((a) => !a.startsWith('-'));
    if (sub === 'volume' && ['rm', 'remove', 'prune'].includes(sub2)) deny(`docker volume ${sub2} refused: volumes hold local databases. Ask the user to remove it.`);
    if (sub === 'system' && sub2 === 'prune') deny('docker system prune refused: it can delete volumes and images other projects need. Ask the user.');
    if (sub === 'rm' && argv.slice(2).some((a) => a === '--volumes' || /^-[a-zA-Z]*v[a-zA-Z]*$/.test(a))) deny('docker rm -v refused: it deletes the container volumes. Remove the container without -v.');
  }

  for (const a of argv) {
    const m = /migrate:(fresh|reset|down|refresh)/.exec(a);
    if (m) {
      deny(`${m[0]} refused: it destroys or rolls back database data. Write a new forward migration instead, or ask the user to run it.`);
      break;
    }
  }

  if (argv.some((a) => DB_CLIENTS.has(baseName(a))) || b === 'dropdb') {
    if (b === 'dropdb') deny('dropdb refused: it deletes a database. Ask the user.');
    const texts = [...argv, cmd.heredoc ?? '', cmd.herestring ?? ''];
    for (const other of all) if (other !== cmd && other.pipeline === cmd.pipeline) texts.push(other.raw, other.heredoc ?? '');
    const o = parseOpts(argv.slice(1), { short: 'fc', long: ['file', 'command'] });
    for (const f of [...(o.values.f ?? []), ...(o.values.file ?? [])]) {
      try {
        texts.push(fs.readFileSync(toAbsolute(f, state.cwd), 'utf8'));
      } catch {
        // unreadable: ignore
      }
    }
    const hit = texts.map((t) => DESTRUCTIVE_SQL_RE.exec(t)).find(Boolean);
    if (hit) deny(`SQL "${hit[0]}" refused: it destroys data. Write a migration, or ask the user to run it.`);
  }

  for (const s of [...argv, ...Object.values(cmd.envAssignments)]) {
    for (const m of String(s).matchAll(DB_URL_RE)) {
      const host = hostOfDbUrl(m[2]).toLowerCase();
      if (!host) continue;
      if (host.includes('$')) ask(`Database URL with host "${host}": the host is a variable and cannot be checked. Confirm it is a local database.`);
      else if (!local.has(host)) deny(`Connection to database host "${host}" refused: only local databases (${[...local].join(', ')}) are allowed. Production and shared databases are for a human.`);
    }
  }
  const assigned = { ...cmd.envAssignments };
  if (['export', 'declare', 'typeset', 'set', 'setx'].includes(b)) {
    for (const a of argv.slice(1)) {
      const eq = a.indexOf('=');
      if (eq > 0) assigned[a.slice(0, eq)] = a.slice(eq + 1);
    }
  }
  for (const name of ctx.config.guard?.databaseUrlEnv ?? []) {
    const v = assigned[name];
    if (v === undefined || v === '') continue;
    if (!new RegExp(DB_URL_RE.source, 'i').test(v)) ask(`${name} is set to "${v.slice(0, 40)}", which is not a literal connection URL, so its host cannot be checked. Confirm it points at a local database.`);
  }

  if (b === 'ssh') {
    const o = parseOpts(argv.slice(1), { short: 'bcDEeFIiJLlmOopQRSWwB' });
    const host = (o.pos[0] ?? '').replace(/^.*@/, '').toLowerCase();
    if (host && !local.has(host)) deny(`ssh to "${o.pos[0]}" refused: remote servers are managed by a human.`);
  }
  if (b === 'sftp') {
    const o = parseOpts(argv.slice(1), { short: 'BbcDFiJloPRS' });
    if (o.pos.length) deny(`sftp to "${o.pos[0]}" refused: remote servers are managed by a human.`);
  }
  if (b === 'scp' || b === 'rsync') {
    for (const a of argv.slice(1)) {
      if (a.startsWith('-')) continue;
      const m = /^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?([^:/\s]+):/i.exec(a);
      const isDrive = /^[a-zA-Z]:[\\/]?/.test(a) && !/^[a-zA-Z]{2,}/.test(a);
      if ((m && !isDrive) || /^(rsync|scp):\/\//i.test(a)) {
        const host = (m?.[1] ?? '').toLowerCase();
        if (!local.has(host)) {
          deny(`${b} to remote target "${a}" refused: remote servers are managed by a human.`);
          break;
        }
      }
    }
  }
  if (INTERPRETERS.has(b) && cmd.pipeIndex > 0) {
    const feeders = all.filter((o) => o.pipeline === cmd.pipeline && o.pipeIndex < cmd.pipeIndex);
    if (feeders.some((o) => DOWNLOADERS.has(baseName(o.argv[0])))) deny(`Piping a download into ${b} refused: it runs unreviewed code. Download the file, read it, and ask the user.`);
  }
  if ((INTERPRETERS.has(b) || b === 'eval' || b === 'source' || b === '.') && /(\$\(|<\(|`|\()\s*(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b/i.test(cmd.raw)) {
    deny(`Running downloaded code through ${b} refused: it runs unreviewed code. Download the file, read it, and ask the user.`);
  }
  if ((b === 'iex' || b === 'invoke-expression') && /\b(iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget|downloadstring|downloadfile)\b/i.test(cmd.raw)) {
    deny(`${argv[0]} of downloaded content refused: it runs unreviewed code. Download the file, read it, and ask the user.`);
  }
}

function urlHost(u) {
  try {
    const s = /^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `http://${u}`;
    return new URL(s).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function evalNetwork(cmd, ctx, state, out) {
  const argv = cmd.argv;
  const b = baseName(argv[0]);
  const allowed = new Set(ALLOWED_POST_HOSTS);
  const ntfy = ctx.config.notify?.ntfy?.server;
  if (ntfy) {
    const h = urlHost(ntfy);
    if (h) allowed.add(h);
  }
  let writes = false;
  let urls = [];
  const files = [];
  if (b === 'curl') {
    const o = parseOpts(argv.slice(1), {
      short: 'dFTXHouAebcKxmwrEUyYzCDQtP',
      long: ['data', 'data-raw', 'data-binary', 'data-urlencode', 'data-ascii', 'form', 'form-string', 'upload-file', 'json', 'request', 'header', 'output', 'user', 'user-agent', 'referer', 'cookie', 'cookie-jar', 'config', 'proxy', 'max-time', 'write-out', 'range', 'cert', 'url'],
    });
    const method = String(o.values.X?.[0] ?? o.values.request?.[0] ?? '').toUpperCase();
    writes = ['d', 'F', 'T', 'data', 'data-raw', 'data-binary', 'data-urlencode', 'data-ascii', 'form', 'form-string', 'upload-file', 'json'].some((f) => o.flags.has(f)) || WRITE_METHODS.has(method);
    urls = [...o.pos, ...(o.values.url ?? [])];
    for (const k of ['d', 'data', 'data-binary', 'data-urlencode', 'data-ascii', 'json']) {
      for (const v of o.values[k] ?? []) {
        const m = /^(?:[^=@]*=)?@(.+)$/.exec(String(v));
        if (m) files.push(m[1]);
      }
    }
    for (const k of ['F', 'form']) {
      for (const v of o.values[k] ?? []) {
        const m = /^[^=]*=[@<]([^;]+)/.exec(String(v));
        if (m) files.push(m[1]);
      }
    }
    for (const k of ['T', 'upload-file']) files.push(...(o.values[k] ?? []));
  } else if (b === 'wget') {
    const o = parseOpts(argv.slice(1), { short: 'OoaPeUtTwYQi', long: ['post-data', 'post-file', 'body-data', 'body-file', 'method', 'header', 'output-document', 'user-agent'] });
    const method = String(o.values.method?.[0] ?? '').toUpperCase();
    writes = ['post-data', 'post-file', 'body-data', 'body-file'].some((f) => o.flags.has(f)) || WRITE_METHODS.has(method);
    urls = o.pos;
    files.push(...(o.values['post-file'] ?? []), ...(o.values['body-file'] ?? []));
  } else if (DOWNLOADERS.has(b)) {
    const lower = argv.map((a) => a.toLowerCase());
    const mi = lower.indexOf('-method');
    const method = mi >= 0 ? String(argv[mi + 1] ?? '').toUpperCase() : '';
    writes = lower.some((a) => ['-body', '-infile', '-form'].includes(a)) || WRITE_METHODS.has(method);
    const ui = lower.indexOf('-uri');
    urls = ui >= 0 ? [argv[ui + 1]] : argv.slice(1).filter((a) => /^https?:\/\//i.test(a));
    const fi = lower.indexOf('-infile');
    if (fi >= 0) files.push(argv[fi + 1]);
  } else {
    return;
  }
  for (const f of files) {
    const hit = secretHit(f, ctx, state.cwd);
    if (hit) {
      out.push({ decision: 'deny', reason: `${b} would upload secret file "${hit}". Refused regardless of the destination.` });
      return;
    }
  }
  if (!writes) return;
  const hosts = urls.map(urlHost).filter(Boolean);
  if (!hosts.length || hosts.some((h) => !allowed.has(h))) {
    out.push({
      decision: 'ask',
      reason: `${b} sends data to ${hosts.length ? hosts.join(', ') : 'an unknown host'}. Confirm this upload is intended (allowed without asking: ${[...allowed].join(', ')}).`,
    });
  }
}

function evalPackages(cmd, out) {
  const argv = cmd.argv;
  const b = baseName(argv[0]);
  const ask = (reason) => out.push({ decision: 'ask', reason: `${reason} Dependency changes need the user's approval.` });
  if (b === 'npx' || b === 'bunx' || b === 'pnpx') {
    if (b === 'npx' && (argv.includes('--no-install') || argv.includes('--no'))) return;
    ask(`${b} ${argv.slice(1).join(' ')} may download and run a package.`);
    return;
  }
  if (!PACKAGE_MANAGERS.has(b)) return;
  // Split the remaining words into positionals, skipping the values of value-taking options.
  const takesValue = (a) => PKG_VALUE_OPTS.has(a) || (a === '-w' && b === 'npm');
  const positionals = [];
  const words = argv.slice(1);
  for (let k = 0; k < words.length; k++) {
    const a = words[k];
    if (a === '--') break;
    if (a.startsWith('-')) {
      if (!a.includes('=') && takesValue(a)) k++;
      continue;
    }
    positionals.push(a);
  }
  let sub = positionals.shift();
  if (b === 'yarn' && (sub === 'workspace' || sub === 'workspaces')) {
    positionals.shift();
    sub = positionals.shift();
  }
  if (sub === undefined) return;
  const rest = positionals;
  const line = argv.slice(1).join(' ');
  if (sub === 'dlx') return ask(`${b} ${line} downloads and runs a package.`);
  if (sub === 'exec' && b === 'npm' && !argv.includes('--no-install') && !argv.includes('--no')) return ask(`npm ${line} may download and run a package.`);
  if (sub === 'x' && b === 'bun') return ask(`bun ${line} may download and run a package.`);
  if (PKG_CHANGE.has(sub)) return ask(`${b} ${line} changes dependencies.`);
  if (['install', 'i', 'in', 'isntall'].includes(sub) && rest.length) return ask(`${b} ${line} adds packages.`);
  if (sub === 'audit' && rest[0] === 'fix') return ask(`${b} audit fix changes dependency versions.`);
}

function evalClaudeConfig(cmd, ctx, state, out) {
  const b = baseName(cmd.argv[0]);
  const globs = [...CLAUDE_CONFIG_GLOBS];
  if (ctx.pluginRoot) globs.push(`${normalizePath(ctx.pluginRoot)}/**`);
  const hit = (p) => p && anyGlob(globs, toAbsolute(p, state.cwd), { root: ctx.repoRoot });
  const ask = (p) => out.push({ decision: 'ask', reason: `This command writes Claude Code configuration or hooks ("${p}"). Confirm the change, or use the Edit tool so it can be reviewed.` });
  for (const r of cmd.redirects) {
    if (['>', '>>', '>|', '&>', '&>>', '<>'].includes(r.op) && hit(r.target)) return ask(r.target);
  }
  const args = pathArgs(cmd.argv);
  let candidates = [];
  if (['tee', 'cp', 'mv', 'rm', 'truncate', 'ln', 'install', 'chmod', 'touch', 'set-content', 'sc', 'out-file', 'add-content', 'ac', 'copy-item', 'move-item', 'remove-item', 'new-item', 'del'].includes(b)) candidates = args;
  else if ((b === 'sed' || b === 'perl') && cmd.argv.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) candidates = args;
  else if (b === 'dd') candidates = cmd.argv.filter((a) => a.startsWith('of=')).map((a) => a.slice(3));
  for (const p of candidates) if (hit(p)) return ask(p);
}

function evalCustom(cmd, ctx, out) {
  for (const [list, decision] of [
    [ctx.config.guard?.denyCommands, 'deny'],
    [ctx.config.guard?.askCommands, 'ask'],
  ]) {
    for (const p of list ?? []) {
      let re;
      try {
        re = new RegExp(p);
      } catch {
        continue;
      }
      if (re.test(cmd.raw)) {
        out.push({ decision, reason: decision === 'deny' ? `Command matches the project's denyCommands rule /${p}/ and is refused.` : `Command matches the project's askCommands rule /${p}/. Confirm it.` });
      }
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * Evaluates a full command line. Returns null (no objection) or {decision, reason}.
 * ctxOpts.dialect: 'bash' (default) or 'powershell'.
 */
export function evaluateBash(command, ctxOpts = {}) {
  const ctx = ctxOpts.config && ctxOpts.branchAt ? ctxOpts : makeContext(ctxOpts);
  const cmds = parseCommandLine(command, { dialect: ctxOpts.dialect });
  const out = [];
  const state = { cwd: ctx.cwd, branch: undefined };
  if (/\b(iex|invoke-expression)\b/i.test(command) && /\b(irm|iwr|invoke-restmethod|invoke-webrequest|downloadstring|downloadfile)\b/i.test(command)) {
    out.push({ decision: 'deny', reason: 'Invoke-Expression of downloaded content refused: it runs unreviewed code. Download the file, read it, and ask the user.' });
  }
  for (const cmd of cmds) {
    try {
      if (!cmd.argv.length) {
        evalData(cmd, ctx, state, out, cmds);
        continue;
      }
      const b = baseName(cmd.argv[0]);
      if ((b === 'cd' || b === 'pushd' || b === 'set-location' || b === 'sl' || b === 'chdir') && cmd.depth === 0) {
        const target = cmd.argv.slice(1).find((a) => !a.startsWith('-'));
        if (target === undefined) state.cwd = ctx.homeDir;
        else if (target !== '-' && !target.includes('$')) state.cwd = toAbsolute(expandHome(target), state.cwd);
        else state.cwd = '/unknown-directory';
        continue;
      }
      if (b === 'git') evalGit(cmd, ctx, state, out);
      if (b === 'git-filter-repo') out.push({ decision: 'deny', reason: 'git filter-repo refused: rewriting history is for a human to do by hand.' });
      if (b === 'gh') evalGh(cmd, ctx, state, out);
      evalSecrets(cmd, ctx, state, out);
      evalRemoval(cmd, ctx, state, out);
      evalData(cmd, ctx, state, out, cmds);
      evalNetwork(cmd, ctx, state, out);
      evalPackages(cmd, out);
      evalClaudeConfig(cmd, ctx, state, out);
      evalCustom(cmd, ctx, out);
    } catch (err) {
      if (err instanceof BudgetExhausted) {
        out.push({ decision: 'deny', reason: 'The safety checks ran out of time (90 s budget for git/gh lookups). Retry the command on its own.' });
      } else {
        throw err;
      }
    }
  }
  return combineVerdicts(out);
}

const RISKY_UNPARSED = /\bgit\b[\s\S]*\b(push|merge)\b|\bgh\s+pr\s+merge\b|\brm\b|remove-item|\brd\b|\bdel\b/i;

export function runHook(input, opts = {}) {
  if (!input || (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell')) return null;
  const command = String(input.tool_input?.command ?? '');
  if (!command.trim()) return null;
  const dialect = input.tool_name === 'PowerShell' ? 'powershell' : 'bash';
  try {
    return evaluateBash(command, { cwd: input.cwd || process.cwd(), dialect, ...opts });
  } catch (err) {
    if (RISKY_UNPARSED.test(command)) {
      return { decision: 'ask', reason: `The safety hook could not analyse this command (${err?.message ?? err}). It looks like a push, merge or delete, so confirm it by hand.` };
    }
    return null;
  }
}

if (isMain(import.meta.url)) {
  try {
    const v = runHook(readHookInput());
    if (v) emitPreToolUse(v.decision, v.reason);
  } catch {
    // Never block on an internal error.
  }
  process.exit(0);
}

