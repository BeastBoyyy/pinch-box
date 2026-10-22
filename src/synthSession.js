// Synthetic two-hand pinch sessions with ground truth, for tests, the replay metrics and ?fake=1.
// Hands are described in SCREEN (mirrored) pixels; the generator emits what MediaPipe would
// report for the unmirrored camera frame (normalised landmarks, metric world landmarks).
import { synthHand, makeRng } from './synthHand.js';

const ease = x => (x <= 0 ? 0 : x >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * x));
const clamp01 = x => Math.min(1, Math.max(0, x));

/** one MediaPipe-style detection from a screen-space hand description */
export function detection({ sx, sy, S, o, rot = 0, flip, W, H, noise, world, rng, label = 'Left', score = 0.9 }) {
  const h = synthHand({ cx: W - sx, cy: sy, S, o, rot: -rot, flip: !flip, W, H }); // unmirror: x -> W-x, chirality flips
  const lm = Array.from(h.lm), wd = Array.from(h.world);
  for (let i = 0; i < 21; i++) {
    lm[i * 3] += (rng.g() * noise) / W; lm[i * 3 + 1] += (rng.g() * noise) / H;
    wd[i * 3] += rng.g() * world; wd[i * 3 + 1] += rng.g() * world; wd[i * 3 + 2] += rng.g() * world;
  }
  return { lm, world: wd, label, score };
}

/** truth rectangle between two hand descriptions: 'bbox4' = bounding box of all four fingertips, 'midpoints' = thumb/index midpoints */
export function rectPx(L, R, mode = 'bbox4') {
  const tip = d => { const h = synthHand({ cx: d.sx, cy: d.sy, S: d.S, o: d.o, rot: d.rot || 0, flip: d.flip }); return [[h.px[12], h.px[13]], [h.px[24], h.px[25]]]; };
  const pts = mode === 'bbox4' ? [...tip(L), ...tip(R)] : [tip(L), tip(R)].map(t => [(t[0][0] + t[1][0]) / 2, (t[0][1] + t[1][1]) / 2]);
  return { x0: Math.min(...pts.map(p => p[0])), y0: Math.min(...pts.map(p => p[1])), x1: Math.max(...pts.map(p => p[0])), y1: Math.max(...pts.map(p => p[1])) };
}
/** screen-space thumb/index midpoint of a hand description, noise-free */
export function midpointPx({ sx, sy, S, o, rot = 0, flip }) {
  const h = synthHand({ cx: sx, cy: sy, S, o, rot, flip });
  return [(h.px[12] + h.px[24]) / 2, (h.px[13] + h.px[25]) / 2];
}

/**
 * kinds: array of 'lock' | 'oneHand' | 'dropout' cycled over `attempts`.
 * glitch: { labelFlip, jumpProb, thirdHand, fakeObject }
 * returns { frames, truth: { locks: [{t0,t1,rect}], noLocks: [{t0,t1,kind}] }, meta }
 */
export function makeSession({ fps = 30, W = 1280, H = 720, seed = 1, noise = 1.2, world = 0.0015, attempts = 20,
  S = 100, kinds = ['lock'], glitch = {}, startMs = 1000, skewMs = 40, boxMode = 'bbox4' } = {}) {
  const rng = makeRng(seed);
  const frames = [], truth = { locks: [], noLocks: [] };
  const dt = 1000 / fps;
  let t = startMs, n = 0;
  const DUR = 4.2; // seconds per attempt

  for (let a = 0; a < attempts; a++) {
    const kind = kinds[a % kinds.length];
    const flipV = rng.u() < 0.5 ? 1 : -1;
    const base = {
      L: { sx: 280 + rng.u() * 120, sy: H / 2 - flipV * (150 + rng.u() * 50) },
      R: { sx: 880 + rng.u() * 120, sy: H / 2 + flipV * (150 + rng.u() * 50) },
    };
    const start = { L: { dx: -60 + rng.u() * 30, dy: 50 }, R: { dx: 60 - rng.u() * 30, dy: -50 } };
    const rot = (rng.u() - 0.5) * 0.3;
    const tp = 1.9 + rng.u() * 0.3;                 // pinch onset (s)
    const skew = { L: 0, R: (rng.u() - 0.5) * 2 * skewMs / 1000 };
    const t0 = t;
    let preRect = null;
    const frameCount = Math.round(DUR * fps);
    for (let f = 0; f < frameCount; f++, n++) {
      const ts = f / fps;
      const hands = [];
      const present = ts > 0.3;
      const spec = {};
      for (const k of ['L', 'R']) {
        const drag = ease((ts - 0.4) / 1.1);
        const tremor = 0.7 * Math.sin(2 * Math.PI * 1.5 * ts + (k === 'L' ? 0 : 1.3));
        const pinches = kind !== 'oneHand' || k === 'L';
        const tpk = tp + skew[k];
        let o = 1;
        if (pinches) o = ts < tpk ? 1 : ts < tpk + 0.25 ? 1 - (ts - tpk) / 0.25 : ts < tpk + 0.7 ? 0 : clamp01((ts - tpk - 0.7) / 0.25);
        spec[k] = { sx: base[k].sx + start[k].dx * (1 - drag) + tremor, sy: base[k].sy + start[k].dy * (1 - drag) + tremor, S, o, rot, flip: k === 'R' };
      }
      if (!preRect && ts >= tp - 0.05) {
        preRect = rectPx(spec.L, spec.R, boxMode);
      }
      const dropped = kind === 'dropout' && k_in(ts, tp + 0.05, tp + 0.05 + 10 / fps);
      for (const k of ['L', 'R']) {
        if (!present) continue;
        if (dropped && k === 'R') continue;
        const flip = glitch.labelFlip ? rng.u() < 0.5 : false;
        const label = (k === 'L') !== flip ? 'Left' : 'Right';
        const d = detection({ ...spec[k], W, H, noise, world, rng, label, score: 0.85 + rng.u() * 0.1 });
        if (glitch.jumpProb && rng.u() < glitch.jumpProb) { // single-frame whole-hand glitch of ~1.1 S
          const ang = rng.u() * Math.PI * 2;
          for (let i = 0; i < 21; i++) { d.lm[i * 3] += Math.cos(ang) * 1.1 * S / W; d.lm[i * 3 + 1] += Math.sin(ang) * 1.1 * S / H; }
        }
        hands.push(d);
      }
      if (present && glitch.thirdHand) { // a third, unrelated hand-like detection far to the side
        hands.push(detection({ sx: W * 0.5, sy: H * 0.85, S: S * 0.5, o: 0.1, W, H, noise, world, rng, flip: false, score: 0.8 }));
      }
      if (present && glitch.fakeObject) { // non-hand: landmark soup with the wrong geometry
        const d = detection({ sx: W * 0.5, sy: H * 0.3, S: S * 1.2, o: 0.5, W, H, noise, world, rng, flip: false, score: 0.7 });
        for (let i = 0; i < 21; i++) { d.lm[i * 3 + 1] += (i % 2 ? 1 : -1) * 0.12 * (i / 21); d.world[i * 3 + 1] *= 1 + 0.9 * (i % 3); }
        hands.push(d);
      }
      frames.push({ t: t + Math.round(ts * 1000) + (rng.u() - 0.5) * 2, w: W, h: H, inferMs: 12 + rng.u() * 4, hands });
    }
    if (kind === 'lock') truth.locks.push({ t0: t0 + tp * 1000, t1: t0 + (tp + 0.9) * 1000, rect: preRect });
    else truth.noLocks.push({ t0: t0 + tp * 1000, t1: t0 + (tp + 0.9) * 1000, kind });
    t += DUR * 1000 + 300;
    // gap between attempts: no hands for ~0.3 s so tracks drop and the FSM re-arms
    for (let g = 0; g < Math.round(0.3 * fps); g++) frames.push({ t: t - 300 + Math.round(g * dt), w: W, h: H, inferMs: 8, hands: [] });
  }
  return { frames, truth, meta: { fps, W, H, seed, noise } };
}
const k_in = (x, a, b) => x >= a && x < b;

/** JSON arrays -> Float32Array, as the worker would deliver them */
export function toFloat(frames) {
  return frames.map(f => ({ ...f, hands: f.hands.map(h => ({ ...h, lm: Float32Array.from(h.lm), world: h.world ? Float32Array.from(h.world) : undefined })) }));
}
