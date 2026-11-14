import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bump, buildInventory, familyOf, parseAudit, parseOutdated } from '../scripts/deps.mjs';

describe('parseOutdated', () => {
  test('reads the pnpm shape keyed by name', () => {
    const rows = parseOutdated(JSON.stringify({ next: { current: '16.0.0', latest: '16.1.0', wanted: '16.0.2' }, a: { current: '1.0.0', latest: '2.0.0' } }));
    assert.deepEqual(rows.map((r) => r.name), ['a', 'next']);
    assert.equal(rows[1].latest, '16.1.0');
  });
  test('reads an array of rows', () => {
    assert.equal(parseOutdated(JSON.stringify([{ name: 'x', current: '1.0.0', latest: '1.0.1' }]))[0].name, 'x');
  });
  test('malformed or empty input gives no rows', () => {
    assert.deepEqual(parseOutdated('not json'), []);
    assert.deepEqual(parseOutdated(''), []);
    assert.deepEqual(parseOutdated('null'), []);
    assert.deepEqual(parseOutdated('{"a": 1}'), []);
  });
});

describe('parseAudit', () => {
  test('reads advisories', () => {
    const out = parseAudit(JSON.stringify({ advisories: { 1: { module_name: 'foo', severity: 'High', title: 't', vulnerable_versions: '<1.2.0', patched_versions: '>=1.2.0' } } }));
    assert.equal(out[0].name, 'foo');
    assert.equal(out[0].severity, 'high');
  });
  test('reads npm 7 vulnerabilities', () => {
    const out = parseAudit(JSON.stringify({ vulnerabilities: { bar: { severity: 'low', range: '<2', via: [{ title: 'x' }], fixAvailable: { name: 'bar', version: '2.0.0' } } } }));
    assert.equal(out[0].patched, 'bar@2.0.0');
    assert.equal(out[0].title, 'x');
  });
  test('malformed input gives no advisories', () => {
    assert.deepEqual(parseAudit('oops'), []);
    assert.deepEqual(parseAudit('{}'), []);
  });
});

describe('bump and familyOf', () => {
  test('bump classifies the step', () => {
    assert.equal(bump('1.2.3', '2.0.0'), 'major');
    assert.equal(bump('1.2.3', '1.3.0'), 'minor');
    assert.equal(bump('1.2.3', '1.2.4'), 'patch');
    assert.equal(bump('1.2.3', '1.2.3'), 'none');
    assert.equal(bump('1.2.3', 'latest'), 'unknown');
    assert.equal(bump(null, '1.0.0'), 'unknown');
  });
  test('named families win, then scope, then first segment', () => {
    const families = { core: ['next', 'react', 'react-dom', '@payloadcms/*'] };
    assert.equal(familyOf('react-dom', families), 'core');
    assert.equal(familyOf('@payloadcms/next', families), 'core');
    assert.equal(familyOf('@types/node', families), '@types');
    assert.equal(familyOf('eslint-plugin-x', families), 'eslint');
    assert.equal(familyOf('lodash', {}), 'lodash');
  });
});

describe('buildInventory', () => {
  const outdated = [
    { name: 'a-one', current: '1.0.0', latest: '1.0.1' },
    { name: 'a-two', current: '1.0.0', latest: '2.0.0' },
    { name: 'zed', current: '1.0.0', latest: '1.1.0' },
  ];
  test('groups packages and puts security families first', () => {
    const inv = buildInventory(outdated, [{ name: 'zed', severity: 'critical', title: 't' }], {});
    assert.equal(inv.families[0].family, 'zed');
    assert.equal(inv.families[1].packages.length, 2);
    assert.equal(inv.totals.packages, 3);
    assert.equal(inv.families[1].packages[1].bump, 'major');
  });
  test('empty input gives an empty inventory', () => {
    assert.deepEqual(buildInventory([], [], {}).totals, { families: 0, packages: 0, advisories: 0 });
  });
});
