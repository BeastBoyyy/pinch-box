// Pinch detection + box state machine. Pure logic: fed HandTracker frames, emits events.
import { OneEuroFilter } from './filters.js';

export const GESTURE_DEFAULTS = {
  boxMode: 'bbox4',            // 'bbox4': edges touch the four actual fingertips (thumb+index of both hands)  |  'midpoints': corners at each hand's thumb/index midpoint
  minBoxFrac: 0.08,            // min box side as a fraction of the frame's short side
  rOn: 0.30, rOff: 0.55,       // pinch ratio thresholds without calibration
  onFrames: 2, offFrames: 2,   // hysteresis debounce (frames); a clearly closed pinch needs only fastFrames
  fastFrames: 1, fastRatio: 0.75, // raw ratio below fastRatio*ON latches on the FIRST frame: locks feel instant
  windowMs: 1e9,               // max gap between the two hands' pinch latches. Unlimited: real users hold one pinch while re-pinching the other (set 150 for strict simultaneous mode)
  rearmMode: 'either',         // 'either': one hand open for rearmMs re-arms (hold one pinch, re-pinch the other)  |  'both': both hands must open
  rearmMs: 250,                // both hands OFF this long before another lock is possible
  refractoryMs: 400,
  lookBackMs: 200,             // lock the rectangle from this long before the closing motion was first detected (120 left bbox4 boxes ~10 px collapsed)
  ringMs: 500,
  minConf: 0.55,
  maxBoxes: 12,
  effectCount: 12,
  decision: { minCutoff: 1.2, beta: 0.3, dCutoff: 1.0 }, // decision path: separate from the display path
  maxScaleRatio: 1.7,          // the two hands' scales must agree (a much smaller hand is someone else, far behind)
  closeRate: 2.5,              // pinch ratio falling faster than this (per second) counts as the closing motion starting
  lookGain: 1.0,               // display extrapolation: fraction of (tip velocity x time-to-now) added; 0 = none
  maxLook: 0.12,               // clamp on that time, seconds
  velDeadzone: 60,             // px/s: slower fingertip drift is not extrapolated (it would only add jitter to a still hand)
  maxSpeed: 2500,              // px/s cap on how fast the shown fingertips may catch up (a detection gap + fast hand = big jump; glide it)
  followOmega: 40, glideOmega: 14, // display follow rate (rad/s): the shown fingertips chase their targets with velocity feed-forward
};

const newHand = cfg => ({ filt: new OneEuroFilter(cfg.decision), r: NaN, rRaw: NaN, on: false, onStreak: 0, offStreak: 0,
  candT: 0, closeT: 0, below: false, sawOpen: false, frozen: null, prevRq: 9, prevT: 0, holdUntil: 0, latchT: -1e9, latchedNow: false, usable: false, present: false });

export class GestureEngine {
  constructor(cfg = {}) {
    this.cfg = { ...GESTURE_DEFAULTS, ...cfg };
    this.hand = { L: newHand(this.cfg), R: newHand(this.cfg) };
    this.ring = [];           // {t, rect, formed}
    this.boxes = [];          // {id, rect:{x0,y0,x1,y1}, effectIndex, lockedAtMs}
    this.count = 0;           // locks minus undos: drives effectIndex
    this.nextId = 1;
    this.armed = true;
    this.offSince = null;
    this.lastLockT = -1e9;
    this.live = { x0: 0, y0: 0, x1: 0, y1: 0, formed: false, held: false, visible: false, pulse: 0 };
    this.last = null; this.blocker = ''; this.holdChangeT = -1e9; this._d = new Float64Array(8); this._dInit = false;
    this._sa = [0, 0]; this._sb = [0, 0];
    this.state = 'IDLE';
    this.setThresholds(null);
  }

  /** cal = { rOpen, rClosed } from the calibrator, or null for defaults */
  setThresholds(cal) {
    const c = this.cfg;
    if (cal && cal.rOpen - cal.rClosed >= 0.25) {
      this.rOn = cal.rClosed + 0.25 * (cal.rOpen - cal.rClosed);
      this.rOff = cal.rClosed + 0.5 * (cal.rOpen - cal.rClosed);
    } else { this.rOn = c.rOn; this.rOff = c.rOff; }
  }
  setDecisionParams(p) { this.cfg.decision = { ...p }; for (const h of Object.values(this.hand)) { h.filt.minCutoff = p.minCutoff; h.filt.beta = p.beta; h.filt.dCutoff = p.dCutoff; } }

  _pinch(slot, tr, t) {
    const h = this.hand[slot], c = this.cfg;
    h.latchedNow = false;
    h.present = !!(tr && tr.confirmed);
    if (!h.present) { // hand gone: pinch state resets, a dropped hand can never complete a lock
      h.on = false; h.onStreak = 0; h.offStreak = 0; h.usable = false; h.below = false; h.sawOpen = false; h.frozen = null; h.prevT = 0; h.holdUntil = 0; h.filt.reset(); h.r = NaN; return;
    }
    h.usable = !tr.coasting && tr.conf >= c.minConf && tr.gates.reason === '' && Number.isFinite(tr.pinchRaw);
    if (!h.usable) return; // no new evidence this frame
    h.rRaw = tr.pinchRaw;
    h.r = h.filt.filter(tr.pinchRaw, t / 1000);
    // closing uses the faster of the smoothed and raw ratio, so the smoothing lag never delays a pinch
    const rq = Math.min(h.r, h.rRaw);
    // closeT: when the closing motion was first detected = the ratio fell below OFF, OR it is dropping fast (real pinches fall
    // ~0.1 per frame; waiting for OFF costs ~3 frames and 60 px of fingertip travel before the box could be frozen)
    const dtc = h.prevT ? (t - h.prevT) / 1000 : 0;
    const fast = dtc > 0 && dtc < 0.2 && (h.prevRq - rq) / dtc > c.closeRate && rq < 1.3;
    if (fast) h.holdUntil = t + 150;
    if (rq < this.rOff || fast) {
      if (!h.below) {
        h.below = true; h.closeT = fast && rq >= this.rOff ? h.prevT : t;
        // anti-collapse, per hand: this hand's fingertips stay where they were just before the closing motion until it opens again
        const e = this._lookBack(h.closeT - c.lookBackMs);
        const tp = (e && e[slot === 'L' ? 'tl' : 'tr']) || this._tips(tr);
        h.frozen = [tp[0] - tp[4], tp[1] - tp[5], tp[2] - tp[4], tp[3] - tp[5]]; this.holdChangeT = t;   // offsets of the tips from the palm centre
      }
    } else if (t >= h.holdUntil) h.below = false;
    h.prevRq = rq; h.prevT = t;
    if (!h.below && !h.on && h.onStreak === 0 && h.frozen) { h.frozen = null; this.holdChangeT = t; }
    if (h.r >= this.rOff) h.sawOpen = true;   // a pinch only counts as a pinch if this hand was seen OPEN first (a hand that re-appears already pinched is not a gesture)
    if (!h.on) {
      if (rq < this.rOn && h.sawOpen) {
        if (++h.onStreak === 1) h.candT = t;
        const need = h.rRaw < this.rOn * c.fastRatio ? c.fastFrames : c.onFrames;   // firm pinch: one frame is enough
        if (h.onStreak >= need) { h.on = true; h.latchT = t; h.latchedNow = true; h.offStreak = 0; } }
      else h.onStreak = 0;
    } else if (h.r > this.rOff) { if (++h.offStreak >= c.offFrames) { h.on = false; h.onStreak = 0; } }
    else h.offStreak = 0;
  }

  /** thumb-tip x,y and index-tip x,y of a track: the light tip filter's output (falls back to the skeleton for plain test tracks) */
  _tips(tr) { return tr.tips || [tr.lm[12], tr.lm[13], tr.lm[24], tr.lm[25], this._palm(tr, 0), this._palm(tr, 1)]; }
  _palm(tr, a) { const lm = tr.lm; return (lm[a] + lm[15 + a] + lm[27 + a] + lm[39 + a] + lm[51 + a]) / 5; }
  /** fingertips as shown: a frozen hand = its CURRENT palm + the tip offsets it had before it closed (follows the hand, ignores the pinch collapse) */
  _shown(tr, fr) {
    const t = this._tips(tr);
    return fr ? [t[4] + fr[0], t[5] + fr[1], t[4] + fr[2], t[5] + fr[3]] : t;
  }

  _point(tr, out) { // P = midpoint(thumb tip 4, index tip 8); blended with the palm if the tips look implausible
    const lm = tr.lm, tp = this._tips(tr);
    let x = (tp[0] + tp[2]) / 2, y = (tp[1] + tp[3]) / 2;
    const px = (lm[0] + lm[15] + lm[27] + lm[39] + lm[51]) / 5; // palm centre
    const py = (lm[1] + lm[16] + lm[28] + lm[40] + lm[52]) / 5;
    if (Math.hypot(x - px, y - py) > 2.2 * tr.S || tr.coasting) { x = (x + px) / 2; y = (y + py) / 2; }
    out[0] = x; out[1] = y;
  }

  /** useFrozen: use each hand's frozen (pre-pinch) fingertips where it has them - the DISPLAY rectangle; false = live tips - the ring / lock rectangle */
  _rect(frame, useFrozen = false) {
    const { L, R } = frame, c = this.cfg;
    if (!L || !R || !L.confirmed || !R.confirmed) return null;
    let x0, y0, x1, y1;
    const tl = this._shown(L, useFrozen && this.hand.L.frozen), tr_ = this._shown(R, useFrozen && this.hand.R.frozen);
    if (c.boxMode === 'bbox4') {
      const xs = [tl[0], tl[2], tr_[0], tr_[2]], ys = [tl[1], tl[3], tr_[1], tr_[3]];
      x0 = Math.min(...xs); x1 = Math.max(...xs); y0 = Math.min(...ys); y1 = Math.max(...ys);
    } else {
      const a = [(tl[0] + tl[2]) / 2, (tl[1] + tl[3]) / 2], b = [(tr_[0] + tr_[2]) / 2, (tr_[1] + tr_[3]) / 2];
      x0 = Math.min(a[0], b[0]); x1 = Math.max(a[0], b[0]); y0 = Math.min(a[1], b[1]); y1 = Math.max(a[1], b[1]);
    }
    const min = c.minBoxFrac * Math.min(frame.w, frame.h);
    const ratio = L.S / R.S, okRatio = ratio <= c.maxScaleRatio && ratio >= 1 / c.maxScaleRatio;
    let formed = x1 - x0 >= min && y1 - y0 >= min && okRatio, fallback = false;
    if (!formed && c.boxMode === 'midpoints' && okRatio) {
      // hands held level make the midpoint rectangle paper-thin; the bounding box of all four fingertips still has height
      const xs = [tl[0], tl[2], tr_[0], tr_[2]], ys = [tl[1], tl[3], tr_[1], tr_[3]];
      const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
      if (bx1 - bx0 >= min && by1 - by0 >= min) { x0 = bx0; x1 = bx1; y0 = by0; y1 = by1; formed = true; fallback = true; }
    }
    return { x0, y0, x1, y1, formed, fallback, tooThin: !(x1 - x0 >= min && y1 - y0 >= min), badRatio: !okRatio };
  }

  _lookBack(tsel) {
    const r = this.ring;
    if (!r.length) return null;
    let pick = null;
    for (let i = r.length - 1; i >= 0; i--) if (r[i].t <= tsel) { pick = r[i]; break; }
    return pick || r[0];
  }

  /** @param frame HandTracker.update() result */
  update(frame) {
    const c = this.cfg, t = frame.t;
    this.last = frame;
    this._pinch('L', frame.L, t); this._pinch('R', frame.R, t);
    const events = [];

    const rect = this._rect(frame);
    if (rect) {
      // the look-back ring only ever holds rectangles made by the CURRENT pair of tracks
      const last = this.ring[this.ring.length - 1];
      if (last && (last.idL !== frame.L.id || last.idR !== frame.R.id)) this.ring.length = 0;
      this.ring.push({ t, rect, formed: rect.formed, idL: frame.L.id, idR: frame.R.id, tl: this._tips(frame.L).slice(), tr: this._tips(frame.R).slice() });
    }
    while (this.ring.length && t - this.ring[0].t > c.ringMs) this.ring.shift();
    const hl = this.hand.L, hr = this.hand.R;

    // display rectangle: each closing/pinched hand keeps its fingertips where they were before it closed (no collapse), the other hand stays live
    const lv = this.live, show = this._rect(frame, true);
    lv.visible = !!show; lv.formed = !!(show && show.formed); lv.held = false;
    if (show) { lv.x0 = show.x0; lv.y0 = show.y0; lv.x1 = show.x1; lv.y1 = show.y1; }

    // arming
    const opened = c.rearmMode === 'both' ? (!hl.on && !hr.on) : (!hl.on || !hr.on);
    if (opened) { if (this.offSince === null) this.offSince = t; if (t - this.offSince >= c.rearmMs) this.armed = true; }
    else this.offSince = null;

    // lock = both hands latched ON within windowMs, armed, both hands good, box formed, outside refractory
    this.state = !this.armed ? 'LOCKED_WAIT' : (hl.on || hr.on || hl.onStreak || hr.onStreak) ? 'PINCHING' : rect ? (rect.formed ? 'BOX' : 'SMALL') : 'IDLE';
    this.blocker = this._why(frame, rect, t);
    if (this.armed && hl.on && hr.on && hl.usable && hr.usable
        && Math.abs(hl.latchT - hr.latchT) <= c.windowMs && t - Math.max(hl.latchT, hr.latchT) <= c.windowMs
        && t - this.lastLockT >= c.refractoryMs && rect && rect.formed) {
      const lb = this._lookBack(this._refClose(t) - c.lookBackMs);
      if (lb && lb.formed) {
        const box = { id: this.nextId++, rect: { x0: lb.rect.x0, y0: lb.rect.y0, x1: lb.rect.x1, y1: lb.rect.y1 },
          effectIndex: this.count % c.effectCount, lockedAtMs: t };
        this.count++;
        this.boxes.push(box); events.push({ type: 'lock', box });
        while (this.boxes.length > c.maxBoxes) events.push({ type: 'remove', box: this.boxes.shift() });
        this.armed = false; this.lastLockT = t; this.state = 'LOCKED_WAIT';
      }
    }
    return events;
  }

  /** when the closing motion of the pinch(es) that make up this lock began: earliest of the hands that closed together, ignoring a hand that has been held pinched for a while */
  _refClose(t) {
    const a = this.hand.L, b = this.hand.R;
    const ta = a.on || a.onStreak ? a.closeT || t : -1, tb = b.on || b.onStreak ? b.closeT || t : -1;
    const late = Math.max(ta, tb);
    if (late < 0) return t;
    let ref = late;
    if (ta >= 0 && late - ta <= 300) ref = Math.min(ref, ta);
    if (tb >= 0 && late - tb <= 300) ref = Math.min(ref, tb);
    return ref;
  }
  /** human-readable reason a lock is not happening right now ('' when idle or when nothing blocks it) */
  _why(frame, rect, t) {
    const c = this.cfg, hl = this.hand.L, hr = this.hand.R;
    if (!(hl.on || hr.on || hl.onStreak || hr.onStreak)) return '';
    if (!frame.L || !frame.R || !hl.present || !hr.present) return 'need both hands confirmed (' + (hl.present ? 'L ok' : 'L missing') + ', ' + (hr.present ? 'R ok' : 'R missing') + ')';
    if (!hl.on || !hr.on) return `waiting for the ${!hl.on && !hr.on ? 'both pinches' : !hl.on ? 'LEFT pinch' : 'RIGHT pinch'} to register (L r=${(hl.r ?? NaN).toFixed(2)}, R r=${(hr.r ?? NaN).toFixed(2)}, need < ${this.rOn.toFixed(2)} for ${c.onFrames} frames)`;
    if (!this.armed) return `not armed: open ${c.rearmMode === 'both' ? 'both hands' : 'one hand'} for 0.25 s first`;
    const gap = Math.abs(hl.latchT - hr.latchT);
    if (gap > c.windowMs) return `pinches ${Math.round(gap)} ms apart (limit ${c.windowMs}): release and pinch both together`;
    if (!hl.usable || !hr.usable) { const tr = !hl.usable ? frame.L : frame.R; return `${!hl.usable ? 'LEFT' : 'RIGHT'} hand not trusted (conf ${tr.conf.toFixed(2)} < ${c.minConf}${tr.coasting ? ', coasting' : ''}${tr.gates.reason ? ', gate: ' + tr.gates.reason : ''})`; }
    if (!rect) return 'no box';
    if (rect.badRatio) return 'hands look very different in size (one is probably not yours / too far away)';
    if (rect.tooThin) return 'box too small: spread your hands further apart';
    if (t - this.lastLockT < c.refractoryMs) return 'just locked';
    return this.armed ? 'no formed box before the pinch (hold the box steady, then pinch)' : '';
  }
  undo() { const b = this.boxes.pop(); if (b) this.count = Math.max(0, this.count - 1); return b || null; }
  clear() { const b = this.boxes; this.boxes = []; this.count = 0; return b; }

  /**
   * Live (unlocked) box extrapolated to `tNow` by the measured pipeline latency using filtered fingertip velocity.
   * Returns the reused object this.live updated in place, plus .ex0..ey1 extrapolated corners.
   */
  /**
   * Live (unlocked) box at display time (call every display frame). The SHOWN fingertips are a small dynamical system that
   * chases their target with velocity feed-forward: target = filtered tip + velocity * time since its measurement (capture time
   * of the frame being shown + time since it arrived, so the box sits on the hand in the picture), feed-forward = tip velocity.
   * Position is continuous at display rate (no 30 Hz steps), has no lag at constant velocity, and a still hand does not move
   * (slow velocities are dead-zoned). A hand that is closing keeps its pre-pinch fingertips (frozen) and the edges glide.
   * Returns the reused object this.live with .x0e..y1e.
   */
  displayTarget(tPredMs, dt = 1 / 60) {
    const lv = this.live, f = this.last, c = this.cfg, d = this._d;
    lv.x0e = lv.x0; lv.y0e = lv.y0; lv.x1e = lv.x1; lv.y1e = lv.y1;
    if (!f || !f.L || !f.R || !lv.formed || !f.L.tips || !f.R.tips) { this._dInit = false; return lv; }
    const horizon = Math.min(c.maxLook, Math.max(0, (tPredMs - f.t) / 1000)) * c.lookGain;
    const omega = tPredMs - this.holdChangeT < 180 ? c.glideOmega : c.followOmega;
    const k = Math.min(1, omega * Math.min(dt, 0.1)), step = Math.min(dt, 0.1), dz = c.velDeadzone;
    for (let h = 0; h < 2; h++) {
      const tr = h ? f.R : f.L, fr = this.hand[h ? 'R' : 'L'].frozen;
      for (let j = 0; j < 2; j++) {                                   // j: 0 thumb tip, 1 index tip
        // a frozen hand moves with its palm (offset kept), a live one follows its own fingertip
        const vi = fr ? 4 : j * 2, vx = tr.tipVel[vi], vy = tr.tipVel[vi + 1], sp = Math.hypot(vx, vy);
        const g = Math.min(1, Math.max(0, (sp - dz) / dz));          // soft dead-zone on drift
        for (let a = 0; a < 2; a++) {
          const i = h * 4 + j * 2 + a, v = (a ? vy : vx) * g;
          const base = fr ? tr.tips[4 + a] + fr[j * 2 + a] : tr.tips[j * 2 + a];
          const tgt = base + v * horizon;
          if (!this._dInit) d[i] = tgt;
          else { const m = c.maxSpeed * step, dx = v * step + (tgt - d[i]) * k; d[i] += dx > m ? m : dx < -m ? -m : dx; }
        }
      }
    }
    this._dInit = true;
    if (c.boxMode === 'bbox4') {
      lv.x0e = Math.min(d[0], d[2], d[4], d[6]); lv.x1e = Math.max(d[0], d[2], d[4], d[6]);
      lv.y0e = Math.min(d[1], d[3], d[5], d[7]); lv.y1e = Math.max(d[1], d[3], d[5], d[7]);
    } else {
      const px = (d[0] + d[2]) / 2, py = (d[1] + d[3]) / 2, qx = (d[4] + d[6]) / 2, qy = (d[5] + d[7]) / 2;
      lv.x0e = Math.min(px, qx); lv.x1e = Math.max(px, qx); lv.y0e = Math.min(py, qy); lv.y1e = Math.max(py, qy);
    }
    return lv;
  }
}

/** 3 s calibration: open hand for 1.5 s, then a firm pinch for 1.5 s. Feed raw pinch ratios with timestamps. */
export class Calibrator {
  constructor() { this.t0 = null; this.open = []; this.closed = []; this.done = false; this.result = null; this.error = ''; }
  start(t) { this.t0 = t; this.open = []; this.closed = []; this.done = false; this.result = null; this.error = ''; }
  get active() { return this.t0 !== null && !this.done; }
  /** 'open' | 'pinch' | 'done' | 'idle' */
  phase(t) { if (this.t0 === null) return 'idle'; const s = (t - this.t0) / 1000; return this.done || s >= 3 ? 'done' : s < 1.5 ? 'open' : 'pinch'; }
  feed(t, ratio) {
    if (!this.active) return;
    const s = (t - this.t0) / 1000;
    if (s >= 3.0) { this._finish(); return; }          // time alone ends the capture (any call, finite ratio or not)
    if (!Number.isFinite(ratio)) return;
    if (s >= 0.5 && s < 1.5) this.open.push(ratio);
    else if (s >= 2.0 && s < 3.0) this.closed.push(ratio);
  }
  _finish() {
    this.done = true;
    const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    if (this.open.length < 8 || this.closed.length < 8) { this.error = 'not enough hand data - keep one hand in view'; return; }
    const ro = med(this.open), rc = med(this.closed);
    if (ro - rc < 0.25) { this.error = 'open and pinched look too similar - open wider, pinch firmer'; return; }
    this.result = { rOpen: ro, rClosed: rc };
  }
}
