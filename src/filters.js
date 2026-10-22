// Pure signal filters: One-Euro (Casiez et al. 2012), a bank of them for landmarks, and a
// critically-damped spring for render-time interpolation. No DOM / WebGL.

const TWO_PI = Math.PI * 2;
const smoothingAlpha = (cutoff, dt) => 1 / (1 + 1 / (TWO_PI * cutoff) / dt);

export class OneEuroFilter {
  constructor({ minCutoff = 1.0, beta = 0.0, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }
  reset() {
    this.t = null;
    this.xHat = 0;
    this.dxHat = 0;
    this.xPrev = 0;
  }
  /** value, tsSeconds -> filtered value. Non-increasing timestamps return the last output unchanged. */
  filter(x, ts) {
    if (this.t === null) {
      this.t = ts; this.xHat = x; this.xPrev = x; this.dxHat = 0;
      return x;
    }
    const dt = ts - this.t;
    if (!(dt > 1e-6)) return this.xHat;
    this.t = ts;
    const dx = (x - this.xPrev) / dt;
    this.dxHat += smoothingAlpha(this.dCutoff, dt) * (dx - this.dxHat);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxHat);
    this.xHat += smoothingAlpha(cutoff, dt) * (x - this.xHat);
    this.xPrev = x; // derivative is taken on the raw signal (reference implementation)
    return this.xHat;
  }
}

/** n points x dims coordinates, one One-Euro each. Reads `src`, writes `out` (both flat, stride = dims). */
export class LandmarkFilterBank {
  constructor(n, dims, params) {
    this.n = n; this.dims = dims;
    this.f = Array.from({ length: n * dims }, () => new OneEuroFilter(params));
  }
  setParams(p) { for (const f of this.f) { f.minCutoff = p.minCutoff; f.beta = p.beta; f.dCutoff = p.dCutoff; } }
  reset() { for (const f of this.f) f.reset(); }
  filter(src, ts, out) {
    for (let i = 0; i < this.f.length; i++) out[i] = this.f[i].filter(src[i], ts);
    return out;
  }
  /** filtered derivative (units/s) of coordinate `d` of point `i` */
  vel(i, d) { return this.f[i * this.dims + d].dxHat; }
}

/** Exact critically-damped spring step (Game Programming Gems 4). Mutates and returns [x, v] via obj. */
export function springStep(s, target, omega, dt) {
  const d = s.x - target;
  const e = Math.exp(-omega * dt);
  const tmp = (s.v + omega * d) * dt;
  s.x = target + (d + tmp) * e;
  s.v = (s.v - omega * tmp) * e;
  return s.x;
}

/** A rectangle {x,y,w,h} whose four numbers glide with critically-damped springs; read every display frame. */
export class RectSpring {
  constructor(omega = 45) {
    this.omega = omega;
    this.s = [0, 1, 2, 3].map(() => ({ x: 0, v: 0 }));
    this.init = false;
  }
  snap(r) { this.s[0].x = r.x; this.s[1].x = r.y; this.s[2].x = r.w; this.s[3].x = r.h; for (const s of this.s) s.v = 0; this.init = true; }
  step(r, dt) {
    if (!this.init) this.snap(r);
    dt = Math.min(Math.max(dt, 0), 0.1);
    springStep(this.s[0], r.x, this.omega, dt);
    springStep(this.s[1], r.y, this.omega, dt);
    springStep(this.s[2], r.w, this.omega, dt);
    springStep(this.s[3], r.h, this.omega, dt);
  }
  get x() { return this.s[0].x; }
  get y() { return this.s[1].x; }
  get w() { return this.s[2].x; }
  get h() { return this.s[3].x; }
}
