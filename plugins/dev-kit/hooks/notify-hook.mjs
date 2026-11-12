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

/** Builds the notification for a hook input, or null when nothing should be sent. */
export function buildNotification(input, project) {
  const event = input?.hook_event_name;
  const kind = kindOf(input ?? {});
  const name = project || 'Claude Code';
  if (event === 'StopFailure') {
    const limit = LIMIT_FAILURES.find((k) => kind.includes(k));
    return {
      priority: 'max',
      title: `${name}: ${limit ? 'limit reached' : 'session stopped'}`,
      message: limit ? `Usage limit reached (${limit}). Work is paused.` : `The session stopped on an error${kind ? ` (${kind.slice(0, 60)})` : ''}.`,
      tags: limit ? 'hourglass' : 'warning',
    };
  }
  if (event === 'Notification') {
    const type = [...URGENT_NOTIFICATIONS, ...QUIET_NOTIFICATIONS].find((t) => kind.includes(t));
    if (!type) return null;
    const urgent = URGENT_NOTIFICATIONS.has(type);
    const label = { permission_prompt: 'needs permission', agent_needs_input: 'needs input', elicitation_dialog: 'has a question', idle_prompt: 'waiting for you' }[type];
    return {
      priority: urgent ? 'max' : 'low',
      title: `${name}: ${label}`,
      message: String(input.message ?? label),
      tags: urgent ? 'warning' : 'zzz',
    };
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
