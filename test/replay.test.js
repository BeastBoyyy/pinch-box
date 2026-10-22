import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../tools/replay.js';
import { makeSession } from '../src/synthSession.js';

test('replay on a clean synthetic session: 20/20 locks, no false locks, no ID switches, sub-pixel jitter', () => {
  const r = analyze(makeSession({ attempts: 20, seed: 11 }));
  assert.equal(r.accuracy.matched, 20, JSON.stringify(r.accuracy));
  assert.equal(r.accuracy.falseLocks, 0);
  assert.equal(r.idSwitches, 0);
  assert.equal(r.slotSwaps, 0);
  assert.ok(r.accuracy.rectErrPx.max < 12, `rect error ${r.accuracy.rectErrPx.max}`);
  assert.ok(r.jitter.segments >= 10 && r.jitter.filteredPx < 0.5, JSON.stringify(r.jitter));
});

test('replay with glitches (label flips, jumps, third hand, fake object, one-hand pinches, dropouts): no false locks', () => {
  const r = analyze(makeSession({ attempts: 30, seed: 5, kinds: ['lock', 'oneHand', 'lock', 'dropout'],
    glitch: { labelFlip: true, jumpProb: 0.02, thirdHand: true, fakeObject: true } }));
  assert.equal(r.accuracy.falseLocks, 0, JSON.stringify(r.accuracy));
  assert.ok(r.accuracy.recall >= 0.95, `recall ${r.accuracy.recall}`);
  assert.equal(r.slotSwaps, 0);
  assert.ok(r.ignoredThirdHands > 0);
});

import { existsSync, readFileSync } from 'node:fs';
test('real MediaPipe landmarks (fixtures/sample-landmarks.json): hands tracked, no phantom locks, no ID/slot swaps', { skip: !existsSync(new URL('../fixtures/sample-landmarks.json', import.meta.url)) }, () => {
  const r = analyze(JSON.parse(readFileSync(new URL('../fixtures/sample-landmarks.json', import.meta.url), 'utf8')));
  assert.equal(r.locks.length, 0, 'clip contains no pinches');
  assert.equal(r.idSwitches, 0);
  assert.equal(r.slotSwaps, 0);
  assert.ok(r.tracksSpawned <= 5, `spawned ${r.tracksSpawned}`);
});
