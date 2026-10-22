// Hand validation layer: treats MediaPipe output as noisy evidence.
// Identity by continuity (not handedness label), confirmation + coasting, geometry gates,
// hand-scale-normalised features, display-path smoothing. Pure logic: no DOM / WebGL.
import { LandmarkFilterBank, OneEuroFilter } from './filters.js';

export const DEFAULTS = {
  mirror: true,               // inference runs on the unmirrored frame; x is mirrored here (screen space)
  maxHands: 2,
  confirmFrames: 4,           // consecutive detections before a track may drive anything
  coastFrames: 6,             // frames a lost track coasts before it is dropped
  coastDecay: 0.85,
  coastMaxSpeed: 4,           // clamp on coasting speed, in hand scales per second
  minScore: 0.5,              // minimum handedness score to spawn a track
  sMinFrac: 0.025, sMaxFrac: 0.45,   // plausible hand scale S as a fraction of the frame short side
  sWorldMin: 0.05, sWorldMax: 0.16,  // plausible wrist->middle-MCP length in metres (world landmarks)
  maxScaleStep: 0.25,         // max |dS/S| between consecutive accepted frames
  maxJump: 0.6,               // max landmark move per frame, in units of S, unless it persists
  boneSoft: [0.5, 1.7],       // per-bone length / (S * nominal) soft limits
  boneHard: [0.25, 2.4],      // any bone outside this rejects the frame
  boneSoftMax: 2,             // more than this many soft violations rejects the frame
  matchBase: 1.8, matchPerMiss: 0.6, // match radius in units of S: base + perMiss * missedFrames
  evictRatio: 1.4,            // an unmatched hand this much larger than the smallest track replaces it when slots are full
  crossFrames: 5,             // frames of reversed x-order needed before L/R slots swap
  roi: { x0: -0.15, y0: -0.15, x1: 1.15, y1: 1.3 }, // wrist must lie inside (normalised, screen space); wrists are often just off-frame
  display: { minCutoff: 0.8, beta: 0.025, dCutoff: 1.0 }, // display-path One-Euro for the skeleton/palm (px units)
  // the four box-making fingertip coordinates get their own, much lighter filter: measured on a real recording this is within
  // ~0.3 px of the raw jitter floor but has a quarter of the lag of the skeleton filter (box feels attached, not floaty)
  tip: { minCutoff: 3.0, beta: 0.3, dCutoff: 1.0, velAlpha: 0.3 },
  refine: null,               // phase-2 hook: (handCrop, landmarks) => landmarks
};

// bones as [from, to, nominal length / S]; nominal values from an average adult hand
const BONES = [
  [1, 2, 0.45], [2, 3, 0.33], [3, 4, 0.28],
  [5, 6, 0.42], [6, 7, 0.24], [7, 8, 0.20],
  [9, 10, 0.46], [10, 11, 0.28], [11, 12, 0.21],
  [13, 14, 0.42], [14, 15, 0.26], [15, 16, 0.20],
  [17, 18, 0.33], [18, 19, 0.19], [19, 20, 0.17],
  [0, 1, 0.37], [0, 5, 0.99], [0, 17, 0.97],
];

/** Phase-2 refiner hook (RTMPose-m fingertip refinement). Stub: returns its input. */
export function refine(handCrop, landmarks) { return landmarks; }

/** mean of all 21 landmarks: far more stable than the wrist when the wrist is off-frame or occluded */
const centroid = a => { let x = 0, y = 0; for (let i = 0; i < 21; i++) { x += a[i * 3]; y += a[i * 3 + 1]; } return [x / 21, y / 21]; };
const d2 = (a, i, b, j) => Math.hypot(a[i * 3] - b[j * 3], a[i * 3 + 1] - b[j * 3 + 1]);
const d3 = (a, i, j) => Math.hypot(a[i * 3] - a[j * 3], a[i * 3 + 1] - a[j * 3 + 1], a[i * 3 + 2] - a[j * 3 + 2]);

/**
 * Pinch ratio = thumb-tip <-> index-tip distance / hand scale. Takes the SMALLER of the image-space and world-space values:
 * on real recordings MediaPipe's world landmarks put the thumb and index tips of a visibly closed pinch 6-7 cm apart in depth
 * for some hands (ratio stuck at ~0.7) while the image-space distance was 0.1-0.17; the opposite disagreement (world small,
 * image large) never occurred. Image space alone is safe; world space only adds recall for foreshortened hands.
 */
export function pinchRatio(world, px) {
  const si = Math.hypot(px[0] - px[27], px[1] - px[28]);
  const ri = si > 1e-6 ? Math.hypot(px[12] - px[24], px[13] - px[25]) / si : NaN;
  let rw = NaN;
  if (world) { const sw = d3(world, 0, 9); if (sw > 1e-6) rw = d3(world, 4, 8) / sw; }
  if (Number.isNaN(ri)) return rw;
  return Number.isNaN(rw) ? ri : Math.min(ri, rw);
}

export class HandTracker {
  constructor(cfg = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.tracks = [];
    this.nextId = 1;
    this.crossCount = 0;
    this.lastT = null;
    this.stats = { frames: 0, spawns: 0, confirms: 0, drops: 0, droppedConfirmed: 0, slotSwaps: 0, ignored: 0,
      gate: { scale: 0, bone: 0, jump: 0, roi: 0, nan: 0 } };
  }
  setDisplayParams(p) { this.cfg.display = { ...p }; for (const t of this.tracks) t.bank.setParams(p); }
  setTipParams(p) { this.cfg.tip = { ...this.cfg.tip, ...p }; for (const t of this.tracks) for (const f of t.tipF) { f.minCutoff = this.cfg.tip.minCutoff; f.beta = this.cfg.tip.beta; f.dCutoff = this.cfg.tip.dCutoff; } }

  /** Convert one MediaPipe hand (normalised, unmirrored) to screen-space pixels + metric world. */
  _prepare(h, w, hh) {
    const c = this.cfg, n = h.lm.length;
    const px = new Float32Array(63), world = h.world && h.world.length >= 63 ? new Float32Array(63) : null;
    if (n < 63) return { valid: false, reason: 'nan' };
    for (let i = 0; i < 21; i++) {
      const x = h.lm[i * 3], y = h.lm[i * 3 + 1], z = h.lm[i * 3 + 2];
      if (!Number.isFinite(x + y + z)) return { valid: false, reason: 'nan' };
      px[i * 3] = (c.mirror ? 1 - x : x) * w; px[i * 3 + 1] = y * hh; px[i * 3 + 2] = z * w;
      if (world) { world[i * 3] = c.mirror ? -h.world[i * 3] : h.world[i * 3]; world[i * 3 + 1] = h.world[i * 3 + 1]; world[i * 3 + 2] = h.world[i * 3 + 2]; }
    }
    return { valid: true, px, world, S: d2(px, 0, px, 9), Sw: world ? d3(world, 0, 9) : 0, score: h.score ?? 1 };
  }

  /** Absolute plausibility (no history needed): scale, bones, ROI. Returns '' if fine else the failing gate. */
  _absolute(d, w, h) {
    const c = this.cfg, short = Math.min(w, h);
    if (d.S < c.sMinFrac * short || d.S > c.sMaxFrac * short) return 'scale';
    if (d.world && (d.Sw < c.sWorldMin || d.Sw > c.sWorldMax)) return 'scale';
    const wx = d.px[0] / w, wy = d.px[1] / h;
    if (wx < c.roi.x0 || wx > c.roi.x1 || wy < c.roi.y0 || wy > c.roi.y1) return 'roi';
    const src = d.world || d.px, S = d.world ? d.Sw : d.S;
    let soft = 0;
    for (const [a, b, nom] of BONES) {
      const r = (d.world ? d3(src, a, b) : Math.hypot(src[a * 3] - src[b * 3], src[a * 3 + 1] - src[b * 3 + 1])) / (S * nom);
      if (r < c.boneHard[0] || r > c.boneHard[1]) return 'bone';
      if (r < c.boneSoft[0] || r > c.boneSoft[1]) soft++;
    }
    return soft > c.boneSoftMax ? 'bone' : '';
  }

  /** max landmark displacement (px) between pose a and pose b shifted by (sx, sy); caller divides by S */
  _maxJump(a, b, sx = 0, sy = 0) {
    let m = 0;
    for (let i = 0; i < 21; i++) m = Math.max(m, Math.hypot(a[i * 3] - b[i * 3] - sx, a[i * 3 + 1] - b[i * 3 + 1] - sy));
    return m;
  }

  _newTrack(d, t) {
    const c = this.cfg;
    const tr = {
      id: this.nextId++, slot: null, age: 0, total: 0, miss: 0, confirmed: false, coasting: false,
      raw: d.px, world: d.world, S: d.S, Sw: d.Sw,
      lm: new Float32Array(d.px), bank: new LandmarkFilterBank(21, 3, c.display),
      tipF: [0, 1, 2, 3, 4, 5].map(() => new OneEuroFilter(c.tip)), tips: [0, 0, 0, 0, 0, 0], tipVel: [0, 0, 0, 0, 0, 0], tipT: 0,   // [x4 y4 x8 y8 palmX palmY]
      scoreEma: d.score, rejectEma: 0, pinchRaw: NaN, vx: 0, vy: 0, rv: [0, 0], lastT: t, pending: null,
      conf: 0, gates: { reason: '' }, born: t,
    };
    this.stats.spawns++;
    return tr;
  }

  _accept(tr, d, t) {
    // raw centroid velocity (px/s): fast but steady motion is predictable and must not trip the jump gate
    const dtA = (t - tr.lastT) / 1000, c = centroid(d.px);
    if (dtA > 1e-3 && dtA < 0.2 && tr.c) { tr.rv[0] += 0.6 * ((c[0] - tr.c[0]) / dtA - tr.rv[0]); tr.rv[1] += 0.6 * ((c[1] - tr.c[1]) / dtA - tr.rv[1]); }
    tr.c = c;
    tr.raw = d.px; tr.world = d.world; tr.S = d.S; tr.Sw = d.Sw;
    tr.bank.filter(d.px, t / 1000, tr.lm);
    // fingertips: x4 y4 x8 y8 through the light tip filter; velocity from successive filtered values
    const va = this.cfg.tip.velAlpha, ts = t / 1000;
    let pcx = 0, pcy = 0;
    for (const j of [0, 5, 9, 13, 17]) { pcx += d.px[j * 3]; pcy += d.px[j * 3 + 1]; }   // palm centre: unaffected by the pinch itself
    for (let i = 0; i < 6; i++) {
      const z = i < 2 ? d.px[12 + i] : i < 4 ? d.px[22 + i] : i === 4 ? pcx / 5 : pcy / 5, prev = tr.tips[i], f = tr.tipF[i].filter(z, ts);
      if (tr.tipT > 0 && ts > tr.tipT) tr.tipVel[i] += va * ((f - prev) / (ts - tr.tipT) - tr.tipVel[i]);
      else if (tr.tipT === 0) tr.tipVel[i] = 0;
      tr.tips[i] = f;
    }
    tr.tipT = ts;
    tr.pinchRaw = pinchRatio(d.world, d.px);
    tr.vx = (tr.bank.vel(0, 0) + tr.bank.vel(9, 0)) / 2;
    tr.vy = (tr.bank.vel(0, 1) + tr.bank.vel(9, 1)) / 2;
    tr.scoreEma += 0.5 * (d.score - tr.scoreEma);
    tr.rejectEma *= 0.8;
    tr.miss = 0; tr.coasting = false; tr.pending = null; tr.gates.reason = '';
    tr.age++; tr.total++;
    tr.lastT = t;
  }

  _coast(tr, t, dt) {
    const c = this.cfg;
    tr.miss++; tr.age = 0; tr.coasting = true;
    const vmax = c.coastMaxSpeed * tr.S;
    let vx = tr.vx, vy = tr.vy; const sp = Math.hypot(vx, vy);
    if (sp > vmax) { vx *= vmax / sp; vy *= vmax / sp; }
    const k = Math.pow(c.coastDecay, tr.miss);
    const dx = vx * dt * k, dy = vy * dt * k;
    for (let i = 0; i < 21; i++) { tr.lm[i * 3] += dx; tr.lm[i * 3 + 1] += dy; tr.raw[i * 3] += dx; tr.raw[i * 3 + 1] += dy; }
    // fingertips coast with the same decaying velocity; a stale velocity must never keep extrapolating a lost hand
    for (let i = 0; i < 6; i++) { tr.tips[i] += (i & 1 ? dy : dx); tr.tipVel[i] *= c.coastDecay; }
    tr.vx = vx * c.coastDecay; tr.vy = vy * c.coastDecay; tr.rv[0] *= c.coastDecay; tr.rv[1] *= c.coastDecay;
    tr.lastT = t;
  }

  _confidence(tr) {
    const ageF = Math.min(1, 0.4 + 0.6 * tr.total / 10);
    tr.conf = tr.scoreEma * ageF * (1 - 0.5 * Math.min(1, tr.rejectEma)) * (tr.coasting ? 0.4 : 1);
  }

  /**
   * @param result { t: ms, w, h, hands: [{lm: Float32Array(63), world?: Float32Array(63), score, label?}] }
   * @returns frame { t, w, h, tracks, L, R, events }
   */
  update(result, crops) {
    const c = this.cfg, { t, w, h } = result;
    const events = [];
    const dt = this.lastT === null ? 0 : Math.max(0, (t - this.lastT) / 1000);
    this.lastT = t; this.stats.frames++;

    // 1. prepare + absolute gates
    const dets = [];
    (result.hands || []).forEach((hd, i) => {
      const d = this._prepare(hd, w, h);
      if (!d.valid) { this.stats.gate.nan++; return; }
      if (c.refine) d.px = c.refine(crops ? crops[i] : null, d.px) || d.px;
      d.reason = this._absolute(d, w, h);
      if (d.reason) this.stats.gate[d.reason]++;
      dets.push(d);
    });

    // 2. match detections to tracks by centroid distance (greedy; <=2 hands so this is exact enough)
    const pairs = [];
    for (const d of dets) d.c = centroid(d.px);
    for (const tr of this.tracks) tr.c = centroid(tr.raw);
    this.tracks.forEach((tr, ti) => dets.forEach((d, di) => {
      const cost = Math.hypot(d.c[0] - tr.c[0], d.c[1] - tr.c[1]) / tr.S;
      const ratio = d.S / tr.S;
      if (cost < c.matchBase + c.matchPerMiss * tr.miss && ratio > 0.5 && ratio < 2) pairs.push({ ti, di, cost });
    }));
    pairs.sort((a, b) => a.cost - b.cost);
    const trUsed = new Set(), dUsed = new Set(), match = new Map();
    for (const p of pairs) if (!trUsed.has(p.ti) && !dUsed.has(p.di)) { trUsed.add(p.ti); dUsed.add(p.di); match.set(p.ti, dets[p.di]); }

    // 3. update matched / unmatched tracks
    const keep = [];
    this.tracks.forEach((tr, ti) => {
      const d = match.get(ti);
      let accepted = false;
      if (d) {
        let reason = d.reason;
        if (!reason) {
          const scaleStep = Math.abs(d.S / tr.S - 1);
          const dtP = Math.min(0.2, Math.max(0, (t - tr.lastT) / 1000));
          let sx = tr.rv[0] * dtP, sy = tr.rv[1] * dtP; const sm = Math.hypot(sx, sy), lim = 1.2 * tr.S;
          if (sm > lim) { sx *= lim / sm; sy *= lim / sm; }
          const jump = this._maxJump(d.px, tr.raw, sx, sy) / tr.S;
          // candidates that cannot drive anything yet are only held to the match radius; gates guard confirmed tracks
          if (tr.confirmed && (scaleStep > c.maxScaleStep || jump > c.maxJump)) {
            // glitch unless it persists: a pending candidate that the new frame agrees with is accepted
            const consistent = tr.pending && this._maxJump(d.px, tr.pending.px) / tr.S < c.maxJump
              && Math.abs(d.S / tr.pending.S - 1) < c.maxScaleStep;
            if (consistent) { this._accept(tr, d, t); accepted = true; }
            else { reason = scaleStep > c.maxScaleStep ? 'scale' : 'jump'; tr.pending = { px: d.px, S: d.S }; this.stats.gate[reason]++; }
          } else { this._accept(tr, d, t); accepted = true; }
        }
        if (!accepted) { // rejected frame: hold the last good pose
          tr.gates.reason = reason; tr.miss++; tr.age = 0; tr.coasting = false;
          for (let i = 0; i < 6; i++) tr.tipVel[i] *= 0.6;   // held pose: stop extrapolating while the data is untrusted
          tr.rejectEma = Math.min(1.5, tr.rejectEma + 0.35);
          tr.lastT = t;
        }
      } else {
        this._coast(tr, t, dt);
      }
      if (accepted && !tr.confirmed && tr.age >= c.confirmFrames) { tr.confirmed = true; this.stats.confirms++; events.push({ type: 'confirm', id: tr.id }); }
      const lost = tr.miss > c.coastFrames || (!tr.confirmed && tr.miss > 0);
      if (lost) { this.stats.drops++; if (tr.confirmed) this.stats.droppedConfirmed++; events.push({ type: 'drop', id: tr.id, confirmed: tr.confirmed }); }
      else { this._confidence(tr); keep.push(tr); }
    });
    this.tracks = keep;

    // 4. spawn tracks for unmatched, valid detections (never more than maxHands)
    dets.forEach((d, di) => {
      if (dUsed.has(di)) return;
      if (d.reason || d.score < c.minScore) return;
      if (this.tracks.length >= c.maxHands) {
        // slots full: a clearly larger (nearer) hand evicts the smallest track - background hands are small
        const small = this.tracks.reduce((a, b) => (a.S <= b.S ? a : b));
        if (d.S < c.evictRatio * small.S) { this.stats.ignored++; return; }
        this.tracks.splice(this.tracks.indexOf(small), 1);
        this.stats.drops++; if (small.confirmed) this.stats.droppedConfirmed++;
        events.push({ type: 'drop', id: small.id, confirmed: small.confirmed, evicted: true });
      }
      const tr = this._newTrack(d, t);
      this._accept(tr, d, t); tr.age = 1; tr.total = 1;
      this.tracks.push(tr);
      events.push({ type: 'spawn', id: tr.id });
    });
    for (const tr of this.tracks) this._confidence(tr);

    this._assignSlots(w, events);
    const L = this.tracks.find(x => x.slot === 'L') || null, R = this.tracks.find(x => x.slot === 'R') || null;
    return { t, w, h, tracks: this.tracks, L, R, events };
  }

  /** LEFT/RIGHT by screen x of the wrists; sticky until the order has been reversed for crossFrames frames */
  _assignSlots(w, events) {
    const live = this.tracks;
    if (live.length === 2) {
      const [a, b] = live[0].raw[0] <= live[1].raw[0] ? [live[0], live[1]] : [live[1], live[0]];
      if (!a.slot || !b.slot || a.slot === b.slot) { a.slot = 'L'; b.slot = 'R'; this.crossCount = 0; }
      else if (a.slot === 'R') {
        if (++this.crossCount >= this.cfg.crossFrames) { a.slot = 'L'; b.slot = 'R'; this.crossCount = 0; this.stats.slotSwaps++; events.push({ type: 'swap' }); }
      } else this.crossCount = 0;
    } else if (live.length === 1 && !live[0].slot) {
      live[0].slot = live[0].raw[0] < w / 2 ? 'L' : 'R';
    }
  }
}
