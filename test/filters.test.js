import test from 'node:test';
import assert from 'node:assert/strict';
import { OneEuroFilter, RectSpring, LandmarkFilterBank } from '../src/filters.js';

const run = (f, sig, dt = 1 / 30) => sig.map((x, i) => f.filter(x, i * dt));

test('constant input converges to the input', () => {
  const out = run(new OneEuroFilter({ minCutoff: 1, beta: 0 }), Array(120).fill(5));
  assert.ok(Math.abs(out.at(-1) - 5) < 1e-9);
});

test('first sample passes through; output tracks a noisy still signal with less variance', () => {
  let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 3.46; // ~unit variance
  const sig = Array.from({ length: 600 }, () => 100 + rnd() * 1.5);
  const out = run(new OneEuroFilter({ minCutoff: 1, beta: 0 }), sig).slice(60);
  const sd = a => { const m = a.reduce((p, c) => p + c, 0) / a.length; return Math.sqrt(a.reduce((p, c) => p + (c - m) ** 2, 0) / a.length); };
  assert.ok(sd(out) < 0.5, `filtered sd ${sd(out)}`);
  assert.ok(sd(out) < sd(sig.slice(60)) * 0.5);
});

test('step response: lag shrinks as beta grows', () => {
  const step = [...Array(30).fill(0), ...Array(30).fill(100)];
  const lagAt = beta => {
    const out = run(new OneEuroFilter({ minCutoff: 1, beta, dCutoff: 1 }), step);
    return 100 - out[36]; // remaining error 6 frames after the step
  };
  const l0 = lagAt(0), l1 = lagAt(0.01), l2 = lagAt(0.1);
  assert.ok(l0 > l1 && l1 > l2, `${l0} ${l1} ${l2}`);
});

test('non-increasing timestamps do not corrupt state', () => {
  const f = new OneEuroFilter({ minCutoff: 1, beta: 0.01 });
  f.filter(10, 1.0); const a = f.filter(11, 1.033);
  assert.equal(f.filter(50, 1.033), a); // same ts
  assert.equal(f.filter(50, 0.5), a);   // going backwards
  const b = f.filter(11, 1.066);
  assert.ok(Number.isFinite(b) && b > 10 && b < 12);
});

test('bank filters flat arrays and exposes velocity', () => {
  const bank = new LandmarkFilterBank(2, 2, { minCutoff: 1, beta: 0, dCutoff: 1 });
  const out = new Float32Array(4);
  for (let i = 0; i < 60; i++) bank.filter([i, 0, 5, 5], i / 30, out);
  assert.ok(bank.vel(0, 0) > 20 && bank.vel(0, 0) < 31, `${bank.vel(0, 0)}`);
  assert.ok(Math.abs(out[2] - 5) < 1e-6);
});

test('RectSpring converges without overshoot (critically damped)', () => {
  const s = new RectSpring(40);
  s.snap({ x: 0, y: 0, w: 10, h: 10 });
  let max = 0;
  for (let i = 0; i < 240; i++) { s.step({ x: 100, y: 0, w: 10, h: 10 }, 1 / 120); max = Math.max(max, s.x); }
  assert.ok(Math.abs(s.x - 100) < 1e-3);
  assert.ok(max <= 100 + 1e-6);
});
