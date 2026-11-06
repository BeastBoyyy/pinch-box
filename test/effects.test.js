import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL } from '../src/effects/index.js';

test('ten effects in the agreed order, each with three presets that only set real params', () => {
  assert.deepEqual(ALL.map(e => e.name), ['Blob tracking', 'Thermal vision', 'Night vision', 'Flash light', 'CRT', '1-bit dither', 'Pink phosphor', 'Halftone print', 'Renaissance painting', 'Comic hero']);
  for (const e of ALL) {
    assert.equal(e.presets.length, 3, e.name);
    for (const p of e.presets) for (const k of Object.keys(p.values)) assert.ok(k in e.params, `${e.name}/${p.name}: ${k}`);
    for (const k of e.paramKeys) { const q = e.params[k]; assert.ok(q.min <= q.default && q.default <= q.max, `${e.name}.${k}`); }
  }
});
