#!/usr/bin/env node
// Push notifications through ntfy.
// CLI: node notify.mjs --priority max --title "..." --message "..." [--click URL] [--tags a,b]

import { loadConfig } from './lib/config.mjs';
import { isMain } from './lib/hook.mjs';

const PRIORITY = { max: '5', urgent: '5', high: '4', default: '3', low: '2', min: '1' };
const MAX_MESSAGE = 300;

function headerValue(v) {
  const s = String(v).replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  // RFC 2047 encoded word: ntfy decodes it, and fetch rejects non-Latin-1 header values.
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/**
 * Sends a notification. Returns {sent, reason}. Never throws.
 * deps: { config, env, fetchImpl, timeoutMs }
 */
export async function notify({ title, message, priority = 'default', click, tags } = {}, deps = {}) {
  try {
    const env = deps.env ?? process.env;
    const config = deps.config ?? loadConfig(env.CLAUDE_PROJECT_DIR || process.cwd());
    const ntfy = config.notify?.ntfy ?? {};
    const topic = env[ntfy.topicEnv || 'NTFY_TOPIC'];
    if (!ntfy.server || !topic) return { sent: false, reason: 'ntfy server or topic not configured' };
    const token = env[ntfy.tokenEnv || 'NTFY_TOKEN'];
    const server = /^https?:\/\//i.test(ntfy.server) ? ntfy.server : `https://${ntfy.server}`;
    const url = `${server.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`;
    let body = String(message ?? '');
    if (body.length > MAX_MESSAGE) body = `${body.slice(0, MAX_MESSAGE - 3)}...`;
    const headers = { Priority: PRIORITY[priority] ?? '3' };
    if (title) headers.Title = headerValue(title);
    if (tags) headers.Tags = headerValue(Array.isArray(tags) ? tags.join(',') : tags);
    if (click) headers.Click = headerValue(click);
    if (token) headers.Authorization = `Bearer ${token}`;
    const doFetch = deps.fetchImpl ?? globalThis.fetch;
    const res = await doFetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(deps.timeoutMs ?? 5000) });
    return res.ok ? { sent: true } : { sent: false, reason: `ntfy answered ${res.status}` };
  } catch (err) {
    return { sent: false, reason: err?.message ?? String(err) };
  }
}

function parseArgs(argv) {
  const out = {};
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    const m = /^--(priority|title|message|click|tags)$/.exec(a);
    if (m) out[m[1]] = argv[++k];
  }
  return out;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const r = await notify(args);
  if (!r.sent && process.env.DEV_KIT_DEBUG) console.error(`notify: ${r.reason}`);
  process.exit(0);
}
