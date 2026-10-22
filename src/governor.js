// Quality governor: pure logic. Watches frame time (GPU timer when available, else rAF delta) and lowers effect quality
// BEFORE anything else suffers. It only ever touches box resolution scales and the global pass level, never the tracker.
export class Governor {
  constructor({ budgetMs = 13, window = 90, minScale = 0.35, step = 0.15, cooldown = 30, recover = 240, minPass = 0.25 } = {}) {
    Object.assign(this, { budgetMs, window, minScale, step, cooldown, recover, minPass });
    this.samples = new Float32Array(window); this.scratch = new Float32Array(window); this.n = 0; this.i = 0; this.tick = 0; this.lastP = 0;
    this.sinceChange = 0; this.headroom = 0;
    this.passLevel = 1;     // 0..1 multiplier for pass counts (sort passes, blur taps...)
    this.enabled = true;
  }
  add(ms) { this.samples[this.i] = ms; this.i = (this.i + 1) % this.window; if (this.n < this.window) this.n++; this.sinceChange++; }
  p95() {
    if (!this.n) return 0;
    const a = this.scratch.subarray(0, this.n); a.set(this.samples.subarray(0, this.n)); a.sort(); // typed-array sort: numeric, in place, no allocation
    return (this.lastP = a[Math.min(a.length - 1, Math.floor(0.95 * a.length))]);
  }
  /** boxes: [{scale, cost}] (cost = relative expense estimate). Mutates box.scale. Returns true if something changed. */
  update(boxes) {
    if (!this.enabled || this.n < this.window / 2) return false;
    const p = (this.tick++ & 3) === 0 ? this.p95() : this.lastP; // re-estimate every 4th frame
    if (this.sinceChange < (p > 2 * this.budgetMs ? Math.ceil(this.cooldown / 4) : this.cooldown)) return false; // react faster when far over budget
    if (p > this.budgetMs) {
      this.headroom = 0;
      let worst = null;
      for (const b of boxes) if (b.scale - this.minScale > 1e-6 && (!worst || b.cost * b.scale * b.scale > worst.cost * worst.scale * worst.scale)) worst = b;
      if (worst) worst.scale = Math.max(this.minScale, worst.scale - this.step);
      else if (this.passLevel > this.minPass) this.passLevel = Math.max(this.minPass, this.passLevel - 0.25);
      else return false;
      this.sinceChange = 0; return true;
    }
    if (p < this.budgetMs * 0.7 && ++this.headroom >= this.recover) {
      this.headroom = 0;
      if (this.passLevel < 1) this.passLevel = Math.min(1, this.passLevel + 0.25);
      else { let low = null; for (const b of boxes) if (b.scale < 1 - 1e-6 && (!low || b.scale < low.scale)) low = b; if (!low) return false; low.scale = Math.min(1, low.scale + this.step / 2); }
      this.sinceChange = 0; return true;
    }
    if (p >= this.budgetMs * 0.7) this.headroom = 0;
    return false;
  }
}

/**
 * Display refresh period (ms) from observed frame deltas. Under overload every delta is long, so snap to the largest
 * standard refresh period that the FASTEST deltas could still be (never above 60 Hz's 16.7 ms).
 */
export function refreshPeriod(deltasMs) {
  if (!deltasMs.length) return 16.7;
  const s = [...deltasMs].sort((a, b) => a - b), p10 = s[Math.floor(s.length * 0.1)];
  let best = 1000 / 240;
  for (const hz of [60, 75, 90, 100, 120, 144, 165, 240]) if (1000 / hz <= p10 * 1.12 && 1000 / hz > best) best = 1000 / hz;
  return best;
}

/**
 * Milliseconds between depth-model frames given the hand-tracker's inference time. Depth is the lowest priority job:
 * it slows down as inference gets slower and pauses (Infinity) when tracking is under pressure.
 */
export function depthInterval(inferMs, { base = 100, ok = 18, pause = 35 } = {}) {
  if (!(inferMs < pause)) return Infinity;
  return inferMs <= ok ? base : base * (1 + 4 * (inferMs - ok) / (pause - ok));
}
