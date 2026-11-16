// Helpers shared by hook entry points.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNightSession } from './night.mjs';

/** Reads the hook's JSON input from stdin. Returns {} when stdin is empty. */
export function readHookInput() {
  let text = '';
  try {
    text = fs.readFileSync(0, 'utf8');
  } catch {
    return {};
  }
  text = text.replace(/^﻿/, '').trim();
  return text ? JSON.parse(text) : {};
}

/** True when the module at importMetaUrl is the script node was started with. */
export function isMain(importMetaUrl) {
  if (!process.argv[1]) return false;
  const a = path.resolve(process.argv[1]);
  const b = fileURLToPath(importMetaUrl);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export const NIGHT_DENY_PREFIX = 'Night mode: deferred, needs the developer: ';

/**
 * Night mode: for a registered night session every `ask` becomes a `deny`. Denies are unchanged,
 * nothing becomes allow. Returns null or {decision, reason}. opts: { now, markerFile }.
 */
export function nightVerdict(verdict, input, opts = {}) {
  if (!verdict || (verdict.decision !== 'deny' && verdict.decision !== 'ask')) return null;
  if (verdict.decision === 'ask' && input && isNightSession(input, opts)) {
    return { decision: 'deny', reason: `${NIGHT_DENY_PREFIX}${verdict.reason}` };
  }
  return verdict;
}

/**
 * Prints a PreToolUse decision. Only 'deny' and 'ask' are ever emitted.
 * With the hook input given, an `ask` of a night session is printed as a `deny`.
 */
export function emitPreToolUse(decision, reason, input = null, opts = {}) {
  const v = nightVerdict({ decision, reason }, input, opts);
  if (!v) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: v.decision,
        permissionDecisionReason: v.reason,
      },
    }),
  );
}

/** Picks the strongest verdict: deny > ask > none. Reasons of that class are joined. */
export function combineVerdicts(verdicts) {
  for (const decision of ['deny', 'ask']) {
    const reasons = [...new Set(verdicts.filter((v) => v && v.decision === decision).map((v) => v.reason))];
    if (reasons.length) return { decision, reason: reasons.join('\n') };
  }
  return null;
}

/** Last n lines of a text. */
export function tail(text, n) {
  const lines = String(text ?? '').replace(/\s+$/, '').split(/\r?\n/);
  return lines.slice(-n).join('\n');
}
