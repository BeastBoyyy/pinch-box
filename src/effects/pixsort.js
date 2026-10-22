// 4. Pixel sorting: a true sort. Span mask from a luminance window; odd-even transposition passes in ping-pong
// fragment shaders sort each span by luminance (or hue) along rows or columns. Unsorted pixels stay as video.
import { defineEffect, P } from './util.js';

const SEED = `
uniform float uP_lo, uP_hi;
void main() {
  vec3 c = vid(sceneUV(vLocal));
  float lp = pow(max(luma(c), 0.0), 0.4545);
  fragColor = vec4(c, step(uP_lo, lp) * step(lp, uP_hi));
}`;

const PASS = `
uniform sampler2D uState; uniform vec2 uSize, uDir; uniform float uParity, uKey, uInvert;
float key(vec3 c) {
  if (uKey < 0.5) return luma(c);
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b), d = mx - mn + 1e-5, h;
  if (mx == c.r) h = mod((c.g - c.b) / d, 6.0); else if (mx == c.g) h = (c.b - c.r) / d + 2.0; else h = (c.r - c.g) / d + 4.0;
  return h / 6.0 + 0.001 * luma(c);
}
void main() {
  vec2 p = floor(gl_FragCoord.xy);
  float i = dot(p, uDir), n = dot(uSize, uDir);
  bool left = mod(i - uParity, 2.0) < 0.5;                  // pairs (i, i+1) for i = parity (mod 2)
  float j = left ? i + 1.0 : i - 1.0;
  vec4 self = texelFetch(uState, ivec2(p), 0);
  if (j < 0.0 || j >= n) { fragColor = self; return; }
  vec4 other = texelFetch(uState, ivec2(p + (left ? uDir : -uDir)), 0);
  if (self.a < 0.5 || other.a < 0.5) { fragColor = self; return; }   // only pixels inside a span take part
  float ks = key(self.rgb), ko = key(other.rgb);
  bool take = left ? (ko < ks) : (ks < ko);                 // left slot keeps the smaller key
  if (uInvert > 0.5) take = left ? (ko > ks) : (ks > ko);
  fragColor = take ? other : self;
}`;

const OUT = `
uniform sampler2D uState; uniform float uP_contrast;
void main() {
  vec3 c = texture(uState, vLocal).rgb;
  c = (c - 0.18) * uP_contrast + 0.18;
  fragColor = vec4(max(c, 0.0), 1.0);
}`;

export default defineEffect({
  name: 'Pixel sort',
  cost: 2.5,
  params: {
    lo: P(0, 1, 0.16, 0.01, 'span window low'),
    hi: P(0, 1, 0.88, 0.01, 'span window high'),
    dir: P(0, 1, 0, 1, 'direction 0 rows / 1 columns'),
    key: P(0, 1, 0, 1, 'key 0 luma / 1 hue'),
    invert: P(0, 1, 0, 1, 'invert order'),
    passes: P(4, 64, 32, 1, 'passes per frame'),
    maxPasses: P(32, 400, 220, 1, 'total passes per camera frame'),
    contrast: P(0.6, 1.6, 1.08, 0.02, 'contrast'),
  },
  presets: [
    { name: 'Row melt', values: {} },
    { name: 'Column drip', values: { dir: 1, lo: 0.1, hi: 0.7, passes: 40 } },
    { name: 'Hue sort', values: { key: 1, lo: 0.08, hi: 0.95, passes: 24, invert: 1 } },
  ],
  init() {},
  create(ctx, box) {
    const w = Math.min(box.rt.w, 720), h = Math.max(8, Math.round(w * box.rt.h / box.rt.w));
    box.state = { a: ctx.rt(w, h, { filter: 'nearest' }), b: ctx.rt(w, h, { filter: 'nearest' }), passes: 0, parity: 0, t0: -1, seeded: false, tmpSize: [w, h] };
  },
  destroy(ctx, box) { if (box.state) { ctx.freeRT(box.state.a); ctx.freeRT(box.state.b); box.state = null; } },
  render(ctx, box, t) {
    const gl = ctx.gl, st = box.state;
    if (st.t0 < 0) st.t0 = t;
    // 1. reseed from the new camera frame (and mask it)
    if (!st.seeded || ctx.newFrame) {
      ctx.bind(st.a);
      const p = ctx.prog('pixsort-seed', SEED); ctx.common(p, box, t); ctx.draw();
      st.passes = 0; st.seeded = true;
    }
    // 2. odd-even transposition passes; more per frame as the effect "melts in" after the lock
    const ramp = Math.min(1, (t - st.t0) / 1.2);
    const n = Math.ceil((2 + (box.params.passes - 2) * ramp) * ctx.passLevel);
    const dx = box.params.dir > 0.5 ? 0 : 1, dy = 1 - dx;
    const pp = ctx.prog('pixsort-pass', PASS);
    pp.use();
    pp.f2('uSize', st.a.w, st.a.h); pp.f2('uDir', dx, dy); pp.f('uKey', box.params.key); pp.f('uInvert', box.params.invert);
    gl.disable(gl.BLEND);
    for (let k = 0; k < n && st.passes < box.params.maxPasses; k++) {
      ctx.bind(st.b);
      pp.tex(5, st.a.tex, 'uState'); pp.f('uParity', st.parity);
      ctx.draw();
      const tmp = st.a; st.a = st.b; st.b = tmp;
      st.parity ^= 1; st.passes++;
    }
    // 3. present
    ctx.bind(box.rt);
    const po = ctx.prog('pixsort-out', OUT); ctx.common(po, box, t); po.tex(5, st.a.tex, 'uState'); ctx.draw();
  },
});
