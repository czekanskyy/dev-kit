#!/usr/bin/env node
// Notification and StopFailure hook: pushes a phone notification through ntfy.

import path from 'node:path';
import { findRepoRoot, loadConfig } from '../scripts/lib/config.mjs';
import { isMain, readHookInput } from '../scripts/lib/hook.mjs';
import { notify } from '../scripts/notify.mjs';

const URGENT_NOTIFICATIONS = new Set(['permission_prompt', 'agent_needs_input', 'elicitation_dialog']);
const QUIET_NOTIFICATIONS = new Set(['idle_prompt']);
const LIMIT_FAILURES = ['rate_limit', 'billing_error'];

function kindOf(input) {
  const fields = [input.notification_type, input.matcher, input.error_type, input.error, input.reason, input.stop_reason, input.type];
  return fields
    .filter((v) => typeof v === 'string')
    .join(' ')
    .toLowerCase();
}

const SUMMARIES = {
  permission_prompt: 'Permission prompt waiting',
  agent_needs_input: 'Agent needs your decision',
  elicitation_dialog: 'Agent needs your decision',
  idle_prompt: 'Agent is waiting for you',
};

/** The error kind as a bare identifier (never free text from the hook input). */
function failureKind(input) {
  for (const v of [input.matcher, input.error_type, input.error, input.reason, input.stop_reason, input.type]) {
    if (typeof v === 'string' && /^[a-z_]{1,40}$/.test(v)) return v;
  }
  return 'unknown';
}

/**
 * Builds the notification for a hook input, or null when nothing should be sent.
 * Only fixed summaries and the project name are sent: never hook message text, commands, paths or error text.
 */
export function buildNotification(input, project) {
  const event = input?.hook_event_name;
  const kind = kindOf(input ?? {});
  const title = project || 'Claude Code';
  if (event === 'StopFailure') {
    const limit = LIMIT_FAILURES.find((k) => kind.includes(k));
    return {
      priority: 'max',
      title,
      message: limit ? 'Usage limit reached' : `Agent stopped with an error: ${failureKind(input)}`,
      tags: limit ? 'hourglass' : 'warning',
    };
  }
  if (event === 'Notification') {
    const type = [...URGENT_NOTIFICATIONS, ...QUIET_NOTIFICATIONS].find((t) => kind.includes(t));
    if (!type) return null;
    const urgent = URGENT_NOTIFICATIONS.has(type);
    return { priority: urgent ? 'max' : 'low', title, message: SUMMARIES[type], tags: urgent ? 'warning' : 'zzz' };
  }
  return null;
}

if (isMain(import.meta.url)) {
  try {
    const input = readHookInput();
    const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const config = loadConfig(cwd);
    const project = config.project || path.basename(findRepoRoot(cwd) ?? cwd);
    const n = buildNotification(input, project);
    if (n) await notify(n, { config });
  } catch {
    // Notifications are best effort.
  }
  process.exit(0);
}
