#!/usr/bin/env node
// Night queue: parses and validates the planned queue, picks the next runnable task,
// records task state, decides on usage and summarizes a run. Zero dependencies.
//
// Usage:
//   node queue.mjs validate
//   node queue.mjs next
//   node queue.mjs route <id> [--risk yes|no]
//   node queue.mjs set <id> <status> [--pr <url>] [--reason <text>] [--category <name>]
//                                    [--branch <name>] [--risk yes|no] [--notified]
//   node queue.mjs usage --window <pct> --weekly <pct>
//   node queue.mjs summary
// Exit codes: 0 ok, 1 validation or state failure, 2 bad usage or unreadable input,
//             3 usage reading unreadable (prints "unreadable"; start no new task).
// The queue file (paths.queue) is only ever read here. Run state lives in night-state.json
// next to it and carries no consent field.

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { isMain } from './lib/hook.mjs';

export const TIERS = ['T0', 'T1', 'T2', 'T3'];
export const STATUSES = ['pending', 'running', 'merged', 'open', 'waiting', 'deferred', 'interrupted'];
export const STATE_FILE = 'night-state.json';

const DEFAULT_LIMITS = { lowerEffortAt: 75, warnAt: 90, stopAt: 95, nightWindowPauseAt: 90 };
const KEYS = ['tier', 'spec', 'brief', 'specTier', 'decisions', 'dependsOn', 'merge', 'base', 'hotfix'];
const KEY_LINE = new RegExp(`^\\s*(?:[-*]\\s+)?\`?(${KEYS.join('|')})\`?\\s*:\\s*(.*)$`);
const HEADING = /^##\s+([^:\s][^:]*?)\s*:\s*(.*?)\s*$/;

// Allowed moves. A repeat of the same status is always allowed (it only updates fields).
const TRANSITIONS = {
  pending: ['running', 'deferred'],
  running: ['merged', 'open', 'waiting', 'deferred', 'interrupted'],
  interrupted: ['running', 'deferred'],
  merged: [],
  open: [],
  waiting: [],
  deferred: [],
};

function clean(v) {
  return String(v ?? '')
    .trim()
    .replace(/^`+|`+$/g, '')
    .trim();
}

function isNone(v) {
  return v === '' || /^none$/i.test(v);
}

// ---------------------------------------------------------------------------
// Queue file

/** Parses the queue markdown into { header, tasks }. Unknown lines are ignored. */
export function parseQueue(text) {
  const tasks = [];
  const headerLines = [];
  let cur = null;
  for (const raw of String(text ?? '').replace(/^﻿/, '').split(/\r?\n/)) {
    const h = HEADING.exec(raw);
    if (h) {
      cur = { id: clean(h[1]), title: h[2], fields: {} };
      tasks.push(cur);
      continue;
    }
    if (!cur) {
      if (raw.trim()) headerLines.push(raw.trim());
      continue;
    }
    const k = KEY_LINE.exec(raw);
    if (k && !(k[1] in cur.fields)) cur.fields[k[1]] = clean(k[2]);
  }
  return {
    header: headerLines.join('\n'),
    tasks: tasks.map((t) => {
      const f = t.fields;
      const dep = f.dependsOn ?? 'none';
      return {
        id: t.id,
        title: t.title,
        tier: f.tier ?? '',
        spec: f.spec ?? null,
        brief: f.brief ?? null,
        specTier: f.specTier ?? 'none',
        decisions: f.decisions ?? 'none',
        dependsOn: isNone(dep)
          ? []
          : dep
              .split(/[,\s]+/)
              .map(clean)
              .filter(Boolean),
        merge: f.merge ?? null,
        base: f.base ?? null,
        hotfix: f.hotfix ?? null,
      };
    }),
  };
}

function specPath(value) {
  let v = String(value);
  const link = /\]\(([^)]*)\)/.exec(v);
  if (link) v = link[1];
  return clean(v).split('#')[0];
}

/**
 * Checks the queue against the rules of the night-mode spec. Returns [{ id, rule, message }].
 * opts: { text, config, repoRoot }
 */
export function validateQueue({ text, config = {}, repoRoot = process.cwd() }) {
  const { tasks } = parseQueue(text);
  const failures = [];
  const fail = (id, rule, message) => failures.push({ id, rule, message });
  if (tasks.length === 0) fail('queue', 'empty-queue', 'no "## <id>: <title>" task headings found');
  const integration = config.branches?.integration;
  const seen = new Map();
  tasks.forEach((t, index) => {
    if (seen.has(t.id)) fail(t.id, 'duplicate-id', `id used by tasks ${seen.get(t.id) + 1} and ${index + 1}`);
    else seen.set(t.id, index);
  });
  tasks.forEach((t, index) => {
    if (!TIERS.includes(t.tier)) fail(t.id, 'unknown-tier', `tier "${t.tier}" is not one of ${TIERS.join(', ')}`);
    const needsSpec = t.tier === 'T2' || t.tier === 'T3';
    if (needsSpec && !t.spec) fail(t.id, 'spec-required', `${t.tier} needs a spec link`);
    if (t.spec) {
      const rel = specPath(t.spec);
      const abs = path.resolve(repoRoot, rel);
      let body = null;
      try {
        if (rel && fs.statSync(abs).isFile()) body = fs.readFileSync(abs, 'utf8');
      } catch {
        // missing or unreadable
      }
      if (body === null) fail(t.id, 'spec-missing', `spec file not found: ${rel || t.spec}`);
      else {
        if (!/Status:\s*accepted/i.test(body)) fail(t.id, 'spec-not-accepted', `${rel} is not marked "Status: accepted"`);
        if (body.split(/\r?\n/).some((l) => l.trimStart().startsWith('|') && /needs decision/i.test(l))) {
          fail(t.id, 'spec-needs-decision', `${rel} still holds a "Needs decision" row`);
        }
      }
    }
    if (t.merge !== 'yes' && t.merge !== 'no') fail(t.id, 'merge-missing', 'merge must be "yes" or "no"');
    for (const d of t.dependsOn) {
      const at = seen.get(d);
      if (at === undefined) fail(t.id, 'dependency-unknown', `depends on unknown task "${d}"`);
      else if (at >= index) fail(t.id, 'dependency-later', `depends on "${d}", which does not come earlier in the queue`);
    }
    if (t.hotfix !== null && !/^(no|false|none|)$/i.test(t.hotfix)) fail(t.id, 'hotfix', 'hotfix tasks are not allowed in a night queue');
    if (t.base !== null && integration && t.base !== integration) {
      fail(t.id, 'base-not-integration', `base "${t.base}" is not the integration branch "${integration}"`);
    }
  });
  return failures;
}

// ---------------------------------------------------------------------------
// State

export function emptyState(tasks) {
  return syncState({ version: 1, run: { status: 'running', heartbeat: null, usage: [], unreadableReason: null }, tasks: {} }, tasks);
}

/** Adds a pending entry for every queue task that has none. Mutates and returns the state. */
function syncState(state, tasks) {
  state.tasks ??= {};
  state.run ??= { status: 'running', heartbeat: null, usage: [], unreadableReason: null };
  for (const t of tasks) {
    state.tasks[t.id] ??= {
      status: 'pending',
      branch: null,
      pr: null,
      notified: false,
      category: null,
      reason: null,
      risk: null,
      startedAt: null,
      finishedAt: null,
      updatedAt: null,
    };
  }
  return state;
}

/**
 * Returns a new state with task `id` moved to `status`. Never touches the queue or any consent.
 * opts: { pr, reason, category, branch, risk (boolean), notified, now }
 */
export function applySet(state, tasks, id, status, opts = {}) {
  if (!STATUSES.includes(status)) throw new Error(`unknown status "${status}" (use ${STATUSES.join(', ')})`);
  if (!tasks.some((t) => t.id === id)) throw new Error(`unknown task "${id}"`);
  const next = syncState(structuredClone(state), tasks);
  const entry = next.tasks[id];
  const from = entry.status;
  if (from !== status && !TRANSITIONS[from].includes(status)) {
    throw new Error(`task ${id}: moving from ${from} to ${status} is not allowed (${from} allows ${TRANSITIONS[from].join(', ') || 'nothing'})`);
  }
  if (status === 'deferred' && !(opts.reason ?? entry.reason)) throw new Error(`task ${id}: deferred needs a reason (--reason)`);
  if (opts.notified && entry.notified) throw new Error(`task ${id}: already notified, send no second notification`);
  const now = opts.now ?? new Date().toISOString();
  entry.status = status;
  if (opts.pr !== undefined) entry.pr = opts.pr;
  if (opts.reason !== undefined) entry.reason = opts.reason;
  if (opts.category !== undefined) entry.category = opts.category;
  if (opts.branch !== undefined) entry.branch = opts.branch;
  if (opts.risk !== undefined) entry.risk = opts.risk;
  if (opts.notified) entry.notified = true;
  if (status === 'running' && !entry.startedAt) entry.startedAt = now;
  if (['merged', 'open', 'waiting', 'deferred'].includes(status)) entry.finishedAt = now;
  entry.updatedAt = now;
  next.run.heartbeat = now;
  return next;
}

// ---------------------------------------------------------------------------
// Routing and next

/**
 * Merge route of a finished task: 'waiting' (a human yes is needed), 'merge' or 'open'.
 * A T3 spec or a risk path is waiting at every merge level; under merge "none" never 'merge'.
 * ctx: { risk } true, false, or undefined when unknown (unknown never merges).
 */
export function routeFor(task, config = {}, { risk } = {}) {
  if (task.tier === 'T3' || task.specTier === 'T3' || risk === true) return 'waiting';
  const level = config.night?.merge ?? 'none';
  if (level === 'lowRisk' && (task.tier === 'T0' || task.tier === 'T1') && task.merge === 'yes' && risk === false) return 'merge';
  return 'open';
}

/**
 * Next runnable task in queue order. Pending and interrupted tasks are runnable; a pending task is
 * deferred ("depends on <id>") while any dependency is not merged. Returns
 * { task, route, deferred: [{ id, reason }], reason }. Nothing else starts while a task is running.
 */
export function nextTask({ tasks, state, config = {} }) {
  const status = Object.fromEntries(tasks.map((t) => [t.id, state?.tasks?.[t.id]?.status ?? 'pending']));
  const running = tasks.find((t) => status[t.id] === 'running');
  if (running) return { task: null, route: null, deferred: [], reason: `running ${running.id}: one task at a time` };
  const deferred = [];
  for (const t of tasks) {
    const st = status[t.id];
    if (st !== 'pending' && st !== 'interrupted') continue;
    const unmet = st === 'pending' ? t.dependsOn.find((d) => status[d] !== 'merged') : undefined;
    if (unmet !== undefined) {
      deferred.push({ id: t.id, reason: `depends on ${unmet}` });
      status[t.id] = 'deferred';
      continue;
    }
    const risk = state?.tasks?.[t.id]?.risk;
    return { task: t, route: routeFor(t, config, { risk: typeof risk === 'boolean' ? risk : undefined }), deferred, reason: null };
  }
  return { task: null, route: null, deferred, reason: 'no runnable task' };
}

// ---------------------------------------------------------------------------
// Usage

function pct(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/**
 * continue | lowerEffort | onlyLow | pause | stop | unreadable.
 * Weekly drives stopAt, warnAt and lowerEffortAt; the 5 hour window drives nightWindowPauseAt.
 */
export function decideUsage(reading, limits = DEFAULT_LIMITS) {
  const l = { ...DEFAULT_LIMITS, ...limits };
  const weekly = pct(reading?.weekly);
  const window = pct(reading?.window);
  if (weekly === null || window === null) return 'unreadable';
  if (weekly >= l.stopAt) return 'stop';
  if (window >= l.nightWindowPauseAt) return 'pause';
  if (weekly >= l.warnAt) return 'onlyLow';
  if (weekly >= l.lowerEffortAt) return 'lowerEffort';
  return 'continue';
}

// ---------------------------------------------------------------------------
// Summary

export function summarize({ tasks, state, config }) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const rows = tasks.map((t) => {
    const e = state?.tasks?.[t.id] ?? {};
    const status = e.status ?? 'pending';
    counts[status]++;
    return {
      id: t.id,
      title: t.title,
      tier: t.tier,
      specTier: t.specTier,
      spec: t.spec,
      merge: t.merge,
      dependsOn: t.dependsOn,
      status,
      route: config ? routeFor(t, config, { risk: typeof e.risk === 'boolean' ? e.risk : undefined }) : undefined,
      branch: e.branch ?? null,
      pr: e.pr ?? null,
      notified: e.notified ?? false,
      risk: e.risk ?? null,
      category: e.category ?? null,
      reason: e.reason ?? null,
      startedAt: e.startedAt ?? null,
      finishedAt: e.finishedAt ?? null,
    };
  });
  return {
    run: state?.run ?? null,
    counts,
    tasks: rows,
    notStarted: rows.filter((r) => r.status === 'pending').map((r) => r.id),
  };
}

// ---------------------------------------------------------------------------
// CLI

function loadContext(cwd) {
  const config = loadConfig(cwd);
  const root = config.repoRoot;
  const queueFile = path.resolve(root, config.paths?.queue ?? 'queue/night.md');
  const stateFile = path.join(path.dirname(queueFile), STATE_FILE);
  return { config, root, queueFile, stateFile };
}

function readQueueTasks(ctx) {
  let text;
  try {
    text = fs.readFileSync(ctx.queueFile, 'utf8');
  } catch (err) {
    throw new CliError(`cannot read the queue ${ctx.queueFile}: ${err.message}`, 2);
  }
  return parseQueue(text).tasks;
}

function readState(ctx, tasks) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(ctx.stateFile, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState(tasks);
    throw new CliError(`cannot read ${ctx.stateFile}: ${err.message}`, 2);
  }
  return syncState(state, tasks);
}

function writeState(ctx, state) {
  fs.mkdirSync(path.dirname(ctx.stateFile), { recursive: true });
  const tmp = `${ctx.stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, ctx.stateFile);
}

class CliError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

const FLAGS = {
  set: { value: ['--pr', '--reason', '--category', '--branch', '--risk'], bool: ['--notified'] },
  usage: { value: ['--window', '--weekly'], bool: [] },
  route: { value: ['--risk'], bool: [] },
  validate: { value: [], bool: [] },
  next: { value: [], bool: [] },
  summary: { value: [], bool: [] },
};

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') return { help: true };
  const spec = FLAGS[cmd];
  if (!spec) throw new CliError(`unknown command: ${cmd}`);
  const out = { cmd, positional: [], flags: {} };
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k];
    if (spec.bool.includes(a)) out.flags[a.slice(2)] = true;
    else if (spec.value.includes(a)) {
      if (k + 1 >= rest.length) throw new CliError(`${a} needs a value`);
      out.flags[a.slice(2)] = rest[++k];
    } else if (a.startsWith('--')) throw new CliError(`unknown argument: ${a}`);
    else out.positional.push(a);
  }
  return out;
}

function riskFlag(v) {
  if (v === undefined) return undefined;
  if (v === 'yes' || v === 'true') return true;
  if (v === 'no' || v === 'false') return false;
  throw new CliError(`--risk must be yes or no, got "${v}"`);
}

const HELP = `Usage: node queue.mjs validate | next | route <id> [--risk yes|no] | summary
       node queue.mjs set <id> <status> [--pr <url>] [--reason <text>] [--category <name>] [--branch <name>] [--risk yes|no] [--notified]
       node queue.mjs usage --window <pct> --weekly <pct>`;

function run(argv, cwd) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const ctx = loadContext(cwd);
  const { cmd, positional, flags } = args;

  if (cmd === 'validate') {
    let text;
    try {
      text = fs.readFileSync(ctx.queueFile, 'utf8');
    } catch (err) {
      console.error(`queue: cannot read ${ctx.queueFile}: ${err.message}`);
      return 1;
    }
    const failures = validateQueue({ text, config: ctx.config, repoRoot: ctx.root });
    for (const f of failures) console.error(`${f.id}: ${f.rule}: ${f.message}`);
    if (failures.length) return 1;
    console.log(`queue ok: ${parseQueue(text).tasks.length} tasks`);
    return 0;
  }

  if (cmd === 'usage') {
    const reading = { window: flags.window, weekly: flags.weekly };
    const decision = decideUsage(reading, ctx.config.limits);
    let tasks = [];
    try {
      tasks = readQueueTasks(ctx);
    } catch {
      // usage can be recorded without a readable queue
    }
    const state = readState(ctx, tasks);
    const now = new Date().toISOString();
    state.run.usage.push({ at: now, window: pct(flags.window), weekly: pct(flags.weekly), decision });
    state.run.heartbeat = now;
    state.run.unreadableReason =
      decision === 'unreadable' ? `usage unreadable at ${now}: window=${flags.window ?? 'missing'} weekly=${flags.weekly ?? 'missing'}` : null;
    writeState(ctx, state);
    console.log(decision);
    return decision === 'unreadable' ? 3 : 0;
  }

  const tasks = readQueueTasks(ctx);
  const state = readState(ctx, tasks);

  if (cmd === 'next') {
    const result = nextTask({ tasks, state, config: ctx.config });
    let saved = state;
    for (const d of result.deferred) saved = applySet(saved, tasks, d.id, 'deferred', { reason: d.reason, category: 'dependency' });
    if (result.deferred.length) writeState(ctx, saved);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (cmd === 'route') {
    const [id] = positional;
    const t = tasks.find((x) => x.id === id);
    if (!t) throw new CliError(`unknown task "${id}"`, 1);
    const stored = state.tasks[id].risk;
    const risk = riskFlag(flags.risk) ?? (typeof stored === 'boolean' ? stored : undefined);
    console.log(routeFor(t, ctx.config, { risk }));
    return 0;
  }

  if (cmd === 'set') {
    const [id, status] = positional;
    if (!id || !status || positional.length > 2) throw new CliError('set needs <id> <status>');
    let next;
    try {
      next = applySet(state, tasks, id, status, {
        pr: flags.pr,
        reason: flags.reason,
        category: flags.category,
        branch: flags.branch,
        risk: riskFlag(flags.risk),
        notified: flags.notified === true,
      });
    } catch (err) {
      throw new CliError(err.message, 1);
    }
    writeState(ctx, next);
    console.log(`${id}: ${status}`);
    return 0;
  }

  if (cmd === 'summary') {
    console.log(JSON.stringify(summarize({ tasks, state, config: ctx.config }), null, 2));
    return 0;
  }
  return 2;
}

function main() {
  try {
    process.exitCode = run(process.argv.slice(2), process.cwd());
  } catch (err) {
    console.error(`queue: ${err.message}`);
    process.exitCode = err instanceof CliError ? err.code : 2;
  }
}

if (isMain(import.meta.url)) main();
