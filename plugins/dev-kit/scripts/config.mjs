#!/usr/bin/env node
// Prints the merged dev-kit config, one value, or validates the project file.
// Usage: node config.mjs [key.path] | node config.mjs --validate
// Exit codes: 0 configured, 3 no .claude/workflow.json (defaults printed with "configured": false),
//             1 key not found or validation problems, 2 bad usage or unreadable config.

import { SCHEMA_FILE, getPath, loadConfig, readJson } from './lib/config.mjs';
import { isMain } from './lib/hook.mjs';

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeOk(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

/** A small JSON Schema subset validator: type, enum, required, properties, patternProperties, additionalProperties, items, oneOf, $ref, minimum. */
export function validateAgainst(value, schema, rootSchema, at = '') {
  const where = at || '(root)';
  if (!schema || schema === true) return [];
  if (schema.$ref) {
    const ref = schema.$ref.replace(/^#\//, '').split('/');
    let target = rootSchema;
    for (const r of ref) target = target?.[r];
    return validateAgainst(value, target, rootSchema, at);
  }
  if (schema.oneOf) {
    const ok = schema.oneOf.filter((s) => validateAgainst(value, s, rootSchema, at).length === 0);
    return ok.length ? [] : [`${where}: does not match any allowed form`];
  }
  const problems = [];
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(value, t))) return [`${where}: expected ${types.join(' or ')}, got ${typeOf(value)}`];
  }
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${where}: must be one of ${schema.enum.join(', ')}`);
  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) problems.push(`${where}: must be >= ${schema.minimum}`);
  if (typeOf(value) === 'object') {
    for (const req of schema.required ?? []) {
      if (!(req in value)) problems.push(`${at ? `${at}.` : ''}${req}: required key is missing`);
    }
    for (const [k, v] of Object.entries(value)) {
      const child = at ? `${at}.${k}` : k;
      if (schema.properties && k in schema.properties) {
        problems.push(...validateAgainst(v, schema.properties[k], rootSchema, child));
        continue;
      }
      const pat = Object.entries(schema.patternProperties ?? {}).find(([p]) => new RegExp(p).test(k));
      if (pat) {
        problems.push(...validateAgainst(v, pat[1], rootSchema, child));
        continue;
      }
      if (schema.additionalProperties === false) problems.push(`${child}: unknown key`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        problems.push(...validateAgainst(v, schema.additionalProperties, rootSchema, child));
      }
    }
  }
  if (typeOf(value) === 'array' && schema.items) {
    value.forEach((v, k) => problems.push(...validateAgainst(v, schema.items, rootSchema, `${at}[${k}]`)));
  }
  return problems;
}

export function validateProject(project, schema = readJson(SCHEMA_FILE)) {
  return validateAgainst(project, schema, schema);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node config.mjs [key.path] | node config.mjs --validate');
    return 0;
  }
  const config = loadConfig(process.cwd());
  if (config.configError) {
    console.error(config.configError);
    return 2;
  }
  if (args.includes('--validate')) {
    if (!config.configured) {
      console.error(`No project config at ${config.configFile}. Create it (see the dev-kit setup skill).`);
      return 3;
    }
    const problems = validateProject(readJson(config.configFile));
    if (!problems.length) {
      console.log(`${config.configFile}: OK`);
      return 0;
    }
    for (const p of problems) console.log(p);
    return 1;
  }
  const key = args.find((a) => !a.startsWith('--'));
  const value = key ? getPath(config, key) : config;
  if (value === undefined) {
    console.error(`No value at "${key}"`);
    return config.configured ? 1 : 3;
  }
  console.log(JSON.stringify(value, null, 2));
  return config.configured ? 0 : 3;
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`config: ${err.message}`);
    process.exitCode = 2;
  }
}
