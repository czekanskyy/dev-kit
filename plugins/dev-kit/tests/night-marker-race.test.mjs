import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeRepo } from './helpers.mjs';
import { buildMarker, markerPath, readMarker, writeMarker } from '../scripts/lib/night.mjs';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const HOUR = 3600 * 1000;

/** Runs a module driver in its own process; resolves { code, stdout }. */
function runDriver(source, cwd, arg) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, arg], { cwd });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', (code) => resolve({ code, stdout: stdout.trim() }));
  });
}

const url = (f) => JSON.stringify(`file:///${path.join(LIB, f).replace(/\\/g, '/')}`);

describe('marker read-modify-write is atomic', () => {
  test('parallel session registrations all land in sessions', async () => {
    const root = fakeRepo('devkit-race-');
    const file = markerPath(root);
    const now = Date.now();
    writeMarker(file, buildMarker({ runId: 'r1', start: now - HOUR, end: now + HOUR }));
    const src = `import { registerSession } from ${url('lib/night.mjs')};
      console.log(registerSession(${JSON.stringify(file)}, 's-' + process.argv.at(-1)));`;
    const ids = Array.from({ length: 12 }, (_, i) => String(i));
    const res = await Promise.all(ids.map((i) => runDriver(src, root, i)));
    assert.ok(res.every((r) => r.code === 0 && r.stdout === 'true'), JSON.stringify(res));
    const m = readMarker(file);
    assert.deepEqual([...m.sessions].sort(), ids.map((i) => `s-${i}`).sort());
  });

  test('parallel acquire: exactly one wins, the others see the existing run', async () => {
    const root = fakeRepo('devkit-race-');
    const src = `import { acquire } from ${url('night-lock.mjs')};
      try { const m = acquire({ for: 1 }, { spawner: () => 4242 }); console.log('won ' + m.runId); }
      catch (e) { console.log('lost ' + e.code); process.exitCode = 1; }`;
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => runDriver(src, root, String(i))));
    const won = res.filter((r) => r.stdout.startsWith('won'));
    assert.equal(won.length, 1, JSON.stringify(res));
    assert.equal(res.filter((r) => r.stdout === 'lost 1').length, 7, JSON.stringify(res));
    assert.equal(readMarker(markerPath(root)).runId, won[0].stdout.slice(4));
  });
});
