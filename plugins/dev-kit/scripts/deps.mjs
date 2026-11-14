#!/usr/bin/env node
// Builds one JSON inventory of outdated and vulnerable dependencies, grouped by family.
// Usage: node deps.mjs [--outdated <file>] [--audit <file>] [--json]
// Without files it runs `commands.outdated` and `commands.audit` from .claude/workflow.json.
// It only reads. It never installs or upgrades anything.
// Exit codes: 0 inventory printed, 2 bad usage or no command configured and no file given.

import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { loadConfig } from './lib/config.mjs';
import { isMain } from './lib/hook.mjs';

const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'info'];

function parseJson(text) {
  const t = String(text ?? '').replace(/^﻿/, '').trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** Accepts the pnpm and npm shapes: an object keyed by name, or an array of rows with a name field. */
export function parseOutdated(text) {
  const data = parseJson(text);
  if (!data || typeof data !== 'object') return [];
  const rows = Array.isArray(data)
    ? data.filter((r) => r && typeof r === 'object' && (r.name ?? r.packageName))
    : Object.entries(data)
        .filter(([, v]) => v && typeof v === 'object')
        .map(([name, v]) => ({ name, ...v }));
  return rows
    .map((r) => ({
      name: String(r.name ?? r.packageName),
      current: r.current ?? null,
      wanted: r.wanted ?? null,
      latest: r.latest ?? null,
      type: r.dependencyType ?? r.type ?? null,
      deprecated: Boolean(r.isDeprecated ?? r.deprecated),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Accepts the pnpm/npm 6 shape (advisories) and the npm 7+ shape (vulnerabilities). */
export function parseAudit(text) {
  const data = parseJson(text);
  if (!data || typeof data !== 'object') return [];
  const out = [];
  if (data.advisories && typeof data.advisories === 'object') {
    for (const a of Object.values(data.advisories)) {
      if (!a || typeof a !== 'object') continue;
      out.push({
        name: String(a.module_name ?? a.name ?? ''),
        severity: String(a.severity ?? 'info').toLowerCase(),
        title: String(a.title ?? ''),
        vulnerable: a.vulnerable_versions ?? null,
        patched: a.patched_versions ?? null,
      });
    }
  }
  if (data.vulnerabilities && typeof data.vulnerabilities === 'object') {
    for (const [name, v] of Object.entries(data.vulnerabilities)) {
      if (!v || typeof v !== 'object') continue;
      const via = Array.isArray(v.via) ? v.via.find((x) => x && typeof x === 'object') : null;
      out.push({
        name,
        severity: String(v.severity ?? 'info').toLowerCase(),
        title: String(via?.title ?? ''),
        vulnerable: v.range ?? null,
        patched: typeof v.fixAvailable === 'object' && v.fixAvailable ? `${v.fixAvailable.name}@${v.fixAvailable.version}` : null,
      });
    }
  }
  return out.filter((a) => a.name).sort((a, b) => a.name.localeCompare(b.name));
}

/** Major, minor or patch step between two versions, "unknown" when either is not plain semver. */
export function bump(from, to) {
  const m = (v) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''));
  const a = m(from);
  const b = m(to);
  if (!a || !b) return 'unknown';
  if (a[1] !== b[1]) return 'major';
  if (a[2] !== b[2]) return 'minor';
  if (a[3] !== b[3]) return 'patch';
  return 'none';
}

function matchesPattern(pattern, name) {
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

/** Family key for a package: first matching named family, else its scope, else its first name segment. */
export function familyOf(name, families = {}) {
  for (const [family, patterns] of Object.entries(families)) {
    if (Array.isArray(patterns) && patterns.some((p) => matchesPattern(p, name))) return family;
  }
  if (name.startsWith('@')) return name.split('/')[0];
  return name.split(/[-_.]/)[0];
}

/** Groups outdated packages and audit advisories into families, security-affected families first. */
export function buildInventory(outdated, advisories, families = {}) {
  const map = new Map();
  const get = (key) => {
    if (!map.has(key)) map.set(key, { family: key, packages: [], advisories: [] });
    return map.get(key);
  };
  for (const p of outdated) {
    get(familyOf(p.name, families)).packages.push({ ...p, bump: bump(p.current, p.latest) });
  }
  for (const a of advisories) get(familyOf(a.name, families)).advisories.push(a);
  const rank = (adv) => Math.min(...adv.map((a) => SEVERITY_ORDER.indexOf(a.severity)).map((i) => (i < 0 ? 4 : i)), 99);
  const list = [...map.values()];
  for (const f of list) f.packages.sort((a, b) => a.name.localeCompare(b.name));
  list.sort((a, b) => rank(a.advisories) - rank(b.advisories) || a.family.localeCompare(b.family));
  return {
    totals: { families: list.length, packages: outdated.length, advisories: advisories.length },
    families: list,
  };
}

function runCommand(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  } catch (err) {
    // pnpm and npm exit non-zero when something is outdated or vulnerable; the JSON is still on stdout.
    if (typeof err.stdout === 'string' && err.stdout.trim()) return err.stdout;
    throw err;
  }
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const outdatedFile = opt('--outdated');
  const auditFile = opt('--audit');
  const config = loadConfig();
  try {
    const outdatedText = outdatedFile
      ? fs.readFileSync(outdatedFile, 'utf8')
      : config.commands?.outdated
        ? runCommand(config.commands.outdated)
        : null;
    if (outdatedText === null) {
      console.error('deps: no commands.outdated configured and no --outdated file given');
      process.exit(2);
    }
    const auditText = auditFile ? fs.readFileSync(auditFile, 'utf8') : config.commands?.audit ? runCommand(config.commands.audit) : '';
    const inventory = buildInventory(parseOutdated(outdatedText), parseAudit(auditText), config.deps?.families ?? {});
    console.log(JSON.stringify(inventory, null, 2));
  } catch (err) {
    console.error(`deps: ${err.message}`);
    process.exit(2);
  }
}

if (isMain(import.meta.url)) main();
