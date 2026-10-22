import test from 'node:test';
import assert from 'node:assert/strict';
import { HandTracker } from '../src/handTrack.js';
import { detection } from '../src/synthSession.js';
import { makeRng } from '../src/synthHand.js';

const W = 1280, H = 720, S = 100;
const rng = makeRng(7);
const base = { L: { sx: 400, sy: 300, S, o: 1, flip: false }, R: { sx: 880, sy: 520, S, o: 1, flip: true } };
const det = (k, over = {}, label) => detection({ ...base[k], ...over, W, H, noise: 0, world: 0, rng, label: label ?? (k === 'L' ? 'Left' : 'Right'), score: 0.9 });
const fr = (i, hands) => ({ t: 1000 + i * (1000 / 30), w: W, h: H, hands });
const feed = (tr, n, mk, i0 = 0) => { let f; for (let i = 0; i < n; i++) f = tr.update(fr(i0 + i, mk(i0 + i))); return f; };

test('track needs 4 consecutive frames before it is confirmed', () => {
  const tr = new HandTracker();
  const f = [];
  for (let i = 0; i < 5; i++) f.push(tr.update(fr(i, [det('L')])).tracks[0].confirmed);
  assert.deepEqual(f, [false, false, false, true, true]);
});

test('single-frame landmark jump is rejected; the pose is held', () => {
  const tr = new HandTracker();
  feed(tr, 12, () => [det('L')]);
  const before = tr.tracks[0].lm.slice();
  const f = tr.update(fr(12, [det('L', { sx: 400 + 90, sy: 300 + 40 })])); // ~1 S jump
  assert.equal(f.tracks[0].gates.reason, 'jump');
  for (let i = 0; i < 63; i++) assert.ok(Math.abs(f.tracks[0].lm[i] - before[i]) < 1e-3, 'held pose');
  const f2 = tr.update(fr(13, [det('L')])); // back where it was: normal again
  assert.equal(f2.tracks[0].gates.reason, '');
  assert.equal(f2.tracks[0].id, f.tracks[0].id);
});

test('a persistent jump is accepted on the second frame', () => {
  const tr = new HandTracker();
  feed(tr, 12, () => [det('L')]);
  const moved = { sx: 400 + 90, sy: 300 + 40 };
  const a = tr.update(fr(12, [det('L', moved)]));
  assert.equal(a.tracks[0].gates.reason, 'jump');
  const b = tr.update(fr(13, [det('L', moved)]));
  assert.equal(b.tracks[0].gates.reason, '');
  assert.ok(b.tracks[0].raw[0] > 400 + 60, 'raw pose moved');
});

test('handedness label flips never swap track ids or slots', () => {
  const tr = new HandTracker();
  let ids = null;
  for (let i = 0; i < 60; i++) {
    const flip = i % 2 === 0;
    const f = tr.update(fr(i, [det('L', {}, flip ? 'Right' : 'Left'), det('R', {}, flip ? 'Left' : 'Right')]));
    if (i === 10) ids = [f.L.id, f.R.id];
    if (i > 10) assert.deepEqual([f.L.id, f.R.id], ids);
  }
  assert.equal(tr.stats.slotSwaps, 0);
});

test('slots stay sticky through a brief crossing and swap only after crossFrames', () => {
  const tr = new HandTracker();
  feed(tr, 10, () => [det('L'), det('R')]);
  const idL = tr.tracks.find(t => t.slot === 'L').id;
  // hands exchange x for 3 frames (< crossFrames): slots unchanged
  for (let i = 10; i < 13; i++) tr.update(fr(i, [det('L', { sx: 880 }), det('R', { sx: 400 })]));
  assert.equal(tr.tracks.find(t => t.slot === 'L').id, idL);
});

test('a third hand is ignored: at most two tracks', () => {
  const tr = new HandTracker();
  feed(tr, 20, () => [det('L'), det('R'), det('L', { sx: 640, sy: 650, S: 80 })]);
  assert.equal(tr.tracks.length, 2);
  assert.ok(tr.stats.ignored > 0);
});

test('stretched / non-hand geometry never becomes a track', () => {
  const tr = new HandTracker();
  const bad = () => { const d = det('L'); for (let i = 5; i < 21; i++) d.world[i * 3 + 1] *= 1 + 0.9 * (i % 3); return d; };
  feed(tr, 20, () => [bad()]);
  assert.equal(tr.tracks.length, 0);
  assert.ok(tr.stats.gate.bone > 0);
});

test('implausible scale (tiny / huge) is rejected', () => {
  const tr = new HandTracker();
  feed(tr, 10, () => [det('L', { S: 8 })]);
  assert.equal(tr.tracks.length, 0);
  feed(tr, 10, () => [det('L', { S: 600 })], 10);
  assert.equal(tr.tracks.length, 0);
});

test('lost hand coasts up to 6 frames then is dropped; unconfirmed candidates drop at once', () => {
  const tr = new HandTracker();
  feed(tr, 15, () => [det('L')]);
  const alive = [];
  for (let i = 15; i < 24; i++) alive.push(tr.update(fr(i, [])).tracks.length);
  assert.deepEqual(alive, [1, 1, 1, 1, 1, 1, 0, 0, 0]);
  const t2 = new HandTracker();
  feed(t2, 2, () => [det('L')]);
  assert.equal(t2.update(fr(2, [])).tracks.length, 0);
});

test('still-hand fingertip jitter < 0.5 px at 720p and filter lag < 1 frame at normal speed', () => {
  const noisy = r => detection({ ...base.L, W, H, noise: 1.2, world: 0.0015, rng: r, score: 0.9 });
  const tr = new HandTracker(); const r = makeRng(3);
  const xs = [], ys = [];
  for (let i = 0; i < 300; i++) { const f = tr.update(fr(i, [noisy(r)])); if (i > 30) { xs.push(f.tracks[0].lm[24]); ys.push(f.tracks[0].lm[25]); } }
  const sd = a => { const m = a.reduce((p, c) => p + c, 0) / a.length; return Math.sqrt(a.reduce((p, c) => p + (c - m) ** 2, 0) / a.length); };
  assert.ok(sd(xs) < 0.5 && sd(ys) < 0.5, `jitter ${sd(xs).toFixed(3)} ${sd(ys).toFixed(3)}`);
  // steady motion at 240 px/s: filtered fingertip trails the truth by less than one frame of travel (8 px)
  const t2 = new HandTracker(); const r2 = makeRng(4); let lag = 0, cnt = 0;
  for (let i = 0; i < 120; i++) {
    const sx = 200 + 8 * i;
    const f = t2.update(fr(i, [detection({ ...base.L, sx, W, H, noise: 1.2, world: 0.0015, rng: r2, score: 0.9 })]));
    const truth = detection({ ...base.L, sx, W, H, noise: 0, world: 0, rng: r2, score: 0.9 });
    if (i > 60) { lag += Math.abs((1 - truth.lm[24]) * W - f.tracks[0].lm[24]); cnt++; }
  }
  assert.ok(lag / cnt < 8, `mean lag ${(lag / cnt).toFixed(2)} px`);
});
