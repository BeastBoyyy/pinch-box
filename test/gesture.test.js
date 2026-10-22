import test from 'node:test';
import assert from 'node:assert/strict';
import { GestureEngine, Calibrator } from '../src/gesture.js';

const W = 1280, H = 720, DT = 1000 / 30;
const mkTrack = (r, P, over = {}) => {
  const lm = new Float32Array(63), S = 100;
  const set = (i, x, y) => { lm[i * 3] = x; lm[i * 3 + 1] = y; };
  set(4, P[0] - r * S / 2, P[1]); set(8, P[0] + r * S / 2, P[1]);
  set(0, P[0], P[1] + 120); for (const i of [5, 9, 13, 17]) set(i, P[0], P[1] + 40);
  return { confirmed: true, coasting: false, conf: 0.9, gates: { reason: '' }, pinchRaw: r, lm, S, bank: { vel: () => 0 }, ...over };
};
/** run a stream; spec(i) -> { rL, rR, PL, PR, dropL, dropR } ; returns locks */
const run = (g, n, spec, i0 = 0) => {
  const locks = [];
  for (let i = i0; i < i0 + n; i++) {
    const s = spec(i);
    const fr = { t: 1000 + i * DT, w: W, h: H, L: s.dropL ? null : mkTrack(s.rL, s.PL), R: s.dropR ? null : mkTrack(s.rR, s.PR) };
    for (const e of g.update(fr)) if (e.type === 'lock') locks.push({ ...e, i });
  }
  return locks;
};
const PL = [300, 250], PR = [900, 550];
const open = { rL: 1.2, rR: 1.2, PL, PR };
const closed = { rL: 0.05, rR: 0.05, PL, PR };
const hold = (s, n) => i => s;
/** open for a, then pinch for b (ramped over 6 frames), then open for c */
const pinchSeq = (a, b, c, extra = {}) => i => {
  let r = 1.2;
  if (i >= a && i < a + 6) r = 1.2 - (1.15 * (i - a)) / 5; else if (i >= a + 6 && i < a + 6 + b) r = 0.05;
  else if (i >= a + 6 + b && i < a + 12 + b) r = 0.05 + (1.15 * (i - a - 6 - b)) / 5; 
  return { rL: r, rR: r, PL, PR, ...extra };
};

test('a clean two-hand pinch gives exactly one lock', () => {
  const g = new GestureEngine({ boxMode: 'midpoints' });
  const locks = run(g, 90, pinchSeq(20, 30, 0));
  assert.equal(locks.length, 1);
  assert.equal(g.boxes.length, 1);
});

test('pinch with one hand only gives no lock', () => {
  const g = new GestureEngine({ boxMode: 'midpoints' });
  const seq = pinchSeq(20, 30, 0);
  assert.equal(run(g, 90, i => ({ ...seq(i), rR: 1.2 })).length, 0);
});

test('hand dropout during the pinch gives no lock', () => {
  const g = new GestureEngine({ boxMode: 'midpoints' });
  const seq = pinchSeq(20, 40, 0);
  const locks = run(g, 100, i => ({ ...seq(i), dropR: i >= 22 && i < 36 }));
  assert.equal(locks.length, 0);
});

test('ratio flickering around the threshold gives at most one lock (hysteresis)', () => {
  const g = new GestureEngine({ boxMode: 'midpoints' });
  const locks = run(g, 120, i => { const r = i < 20 ? 1.2 : (i % 4 === 0 ? 0.42 : 0.18); return { rL: r, rR: r, PL, PR }; });
  assert.ok(locks.length <= 1, `${locks.length} locks`);
  const g2 = new GestureEngine({ boxMode: 'midpoints' });
  const l2 = run(g2, 120, i => { const r = i < 20 ? 1.2 : 0.30 + (i % 2 ? 0.06 : -0.06); return { rL: r, rR: r, PL, PR }; });
  assert.ok(l2.length <= 1, `${l2.length} locks`);
});

test('holding the pinch does not repeat; release + re-arm allows the next lock', () => {
  const g = new GestureEngine({ boxMode: 'midpoints' });
  const locks = run(g, 200, pinchSeq(20, 100, 0));
  assert.equal(locks.length, 1, 'held pinch locks once');
  // release (open ~ frames 126..), wait >250 ms, pinch again
  const g2 = new GestureEngine({ boxMode: 'midpoints' });
  const twice = i => i < 100 ? pinchSeq(20, 20, 0)(i) : pinchSeq(100 + 10, 20, 0)(i);
  const locks2 = run(g2, 200, twice);
  assert.equal(locks2.length, 2);
  // re-pinch after only ~130 ms open must not lock; after ~400 ms it must
  const gap = n => run(new GestureEngine({ boxMode: 'midpoints' }), 140, i => { const r = i < 20 ? 1.2 : i < 50 ? 0.05 : i < 50 + n ? 1.2 : 0.05; return { rL: r, rR: r, PL, PR }; }).length;
  assert.equal(gap(4), 1);
  assert.equal(gap(12), 2);
});

test('strict mode: both hands must latch within the window (250 ms) of each other', () => {
  const g = new GestureEngine({ boxMode: 'midpoints', windowMs: 250, rearmMode: 'both' });
  const a = pinchSeq(20, 40, 0), b = pinchSeq(20 + 9, 40, 0); // R 9 frames (300 ms) later
  assert.equal(run(g, 120, i => ({ ...a(i), rR: b(i).rR })).length, 0);
  const g2 = new GestureEngine({ boxMode: 'midpoints', windowMs: 250, rearmMode: 'both' });
  const c = pinchSeq(20 + 3, 40, 0); // 100 ms later: fine
  assert.equal(run(g2, 120, i => ({ ...a(i), rR: c(i).rR })).length, 1);
});

test('look-back: the locked rectangle is the one from before the fingertips moved', () => {
  const g = new GestureEngine({ boxMode: 'midpoints' });
  const PL1 = [PL[0] + 40, PL[1] + 30], PR1 = [PR[0] - 40, PR[1] - 30]; // pinching drags both points inward
  const locks = run(g, 90, i => {
    const s = pinchSeq(20, 30, 0)(i);
    const k = Math.min(1, Math.max(0, (i - 20) / 6)); // positions slide while the pinch closes
    return { ...s, PL: [PL[0] + (PL1[0] - PL[0]) * k, PL[1] + (PL1[1] - PL[1]) * k], PR: [PR[0] + (PR1[0] - PR[0]) * k, PR[1] + (PR1[1] - PR[1]) * k] };
  });
  assert.equal(locks.length, 1);
  const r = locks[0].box.rect;
  assert.ok(Math.abs(r.x0 - PL[0]) < 8 && Math.abs(r.y0 - PL[1]) < 8 && Math.abs(r.x1 - PR[0]) < 8 && Math.abs(r.y1 - PR[1]) < 8, JSON.stringify(r));
});

test('no lock when the box is not formed (too small)', () => {
  const g = new GestureEngine({ boxMode: 'midpoints' });
  const seq = pinchSeq(20, 30, 0);
  assert.equal(run(g, 90, i => ({ ...seq(i), PL: [600, 300], PR: [630, 320] })).length, 0);
});

test('low-confidence or coasting hands never lock', () => {
  const g = new GestureEngine({ boxMode: 'midpoints' });
  const seq = pinchSeq(20, 30, 0);
  const locks = [];
  for (let i = 0; i < 90; i++) {
    const s = seq(i);
    const fr = { t: 1000 + i * DT, w: W, h: H, L: mkTrack(s.rL, PL), R: mkTrack(s.rR, PR, { conf: 0.3 }) };
    for (const e of g.update(fr)) locks.push(e);
  }
  assert.equal(locks.length, 0);
});

test('effect index cycles, stack is capped at 12 and undo steps back', () => {
  const g = new GestureEngine({ boxMode: 'midpoints', effectCount: 4, maxBoxes: 3 });
  let i0 = 0;
  const seen = [];
  for (let k = 0; k < 5; k++) { const base = i0; const l = run(g, 80, i => pinchSeq(15, 15, 0)(i - base), i0); i0 += 80; seen.push(...l.map(e => e.box.effectIndex)); }
  assert.deepEqual(seen, [0, 1, 2, 3, 0]);
  assert.equal(g.boxes.length, 3);
  g.undo(); assert.equal(g.count, 4);
  assert.equal(g.clear().length, 2); assert.equal(g.boxes.length, 0);
});

test('calibration derives thresholds from open and pinched ratios', () => {
  const c = new Calibrator(); c.start(0);
  for (let t = 0; t < 3200; t += 33) c.feed(t, t < 1700 ? 1.1 : 0.1);
  assert.ok(c.result && Math.abs(c.result.rOpen - 1.1) < 1e-9 && Math.abs(c.result.rClosed - 0.1) < 1e-9);
  const g = new GestureEngine({ boxMode: 'midpoints' }); g.setThresholds(c.result);
  assert.ok(Math.abs(g.rOn - 0.35) < 1e-9 && Math.abs(g.rOff - 0.6) < 1e-9);
  const bad = new Calibrator(); bad.start(0);
  for (let t = 0; t < 3200; t += 33) bad.feed(t, 0.5);
  assert.equal(bad.result, null); assert.ok(bad.error);
});

test('hands held level (paper-thin midpoint box) still form a box via the fingertip bounding box', () => {
  const g = new GestureEngine({ boxMode: 'midpoints' });
  const seq = pinchSeq(20, 30, 0);
  // thumb/index tips of each hand differ vertically by 70 px, hands at the same height
  const mk = (r, P) => { const t = mkTrack(r, P); t.lm[13] = P[1] - 35; t.lm[25] = P[1] + 35; return t; };
  const locks = [];
  for (let i = 0; i < 90; i++) { const s = seq(i); for (const e of g.update({ t: 1000 + i * DT, w: W, h: H, L: mk(s.rL, [300, 350]), R: mk(s.rR, [900, 350]) })) if (e.type === 'lock') locks.push(e); }
  assert.equal(locks.length, 1);
});

test('a hand that appears already pinched never latches until it has been seen open', () => {
  const g = new GestureEngine({ boxMode: 'midpoints' });
  assert.equal(run(g, 60, () => ({ rL: 0.05, rR: 0.05, PL, PR })).length, 0);
  assert.ok(/waiting|register/.test(g.blocker) || g.blocker === '', g.blocker);
});

test('blocker explains why a pinch is not locking', () => {
  const g = new GestureEngine({ boxMode: 'midpoints', windowMs: 250 });
  const a = pinchSeq(20, 60, 0), b = pinchSeq(20 + 12, 60, 0); // right hand 400 ms late
  run(g, 60, i => ({ ...a(i), rR: b(i).rR }));
  assert.match(g.blocker, /apart|waiting/);
});

test('holding one pinch and re-pinching the other hand locks again (default re-arm: either hand)', () => {
  const g = new GestureEngine({ boxMode: 'midpoints' });
  const locks = run(g, 220, i => {
    let rL = 1.2, rR = 1.2;
    if (i >= 20) rR = i < 26 ? 1.2 - 1.15 * (i - 20) / 5 : 0.05;                  // right pinches at 20 and never lets go
    if (i >= 20 && i < 26) rL = rR; else if (i >= 26 && i < 60) rL = 0.05;          // left pinches with it -> lock 1
    else if (i >= 60 && i < 75) rL = 1.2;                                            // left opens for 0.5 s
    else if (i >= 75 && i < 140) rL = 0.05;                                          // left re-pinches while right is still held -> lock 2
    else if (i >= 140) rL = 1.2;
    return { rL, rR, PL, PR };
  });
  assert.equal(locks.length, 2);
  const strict = new GestureEngine({ boxMode: 'midpoints', rearmMode: 'both' });
  const l2 = run(strict, 220, i => { let rL = 1.2, rR = 1.2; if (i >= 20) rR = 0.05; if (i >= 26 && i < 60) rL = 0.05; else if (i >= 75 && i < 140) rL = 0.05; return { rL, rR, PL, PR }; });
  assert.equal(l2.length, 1);
});
