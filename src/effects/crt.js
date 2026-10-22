// 7. CRT: barrel distortion with corner falloff, output-pixel-locked scanlines, RGB aperture-grille mask (moire-free via
// fwidth), thresholded bloom, per-channel beam bleed + misconvergence, phosphor persistence (feedback), rolling bar,
// vignette and a faint glass reflection.
import { defineEffect, P } from './util.js';

const BASE = `
uniform float uP_curve, uP_bleed, uP_conv;
void main() {
  vec2 u = vLocal * 2.0 - 1.0;
  float r2 = dot(u * vec2(0.9, 1.0), u * vec2(0.9, 1.0));
  u *= 1.0 + uP_curve * (0.12 * r2 + 0.06 * r2 * r2);
  vec2 uv = u * 0.5 + 0.5;
  float inside = smoothstep(0.0, 0.012, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));   // soft corner falloff
  vec2 px = 1.0 / uSceneSize;
  vec2 conv = (uv - 0.5) * 0.004 * uP_conv;
  vec2 bl = vec2(px.x * (1.0 + 2.0 * uP_bleed), 0.0);
  float r = 0.25 * vid(sceneUV(uv + conv - bl)).r + 0.5 * vid(sceneUV(uv + conv)).r + 0.25 * vid(sceneUV(uv + conv + bl)).r;
  float g = 0.25 * vid(sceneUV(uv - bl)).g + 0.5 * vid(sceneUV(uv)).g + 0.25 * vid(sceneUV(uv + bl)).g;
  float b = 0.25 * vid(sceneUV(uv - conv - bl)).b + 0.5 * vid(sceneUV(uv - conv)).b + 0.25 * vid(sceneUV(uv - conv + bl)).b;
  fragColor = vec4(vec3(r, g, b) * inside, 1.0);
}`;
const BRIGHT = `
uniform sampler2D uSrc; uniform float uTh;
void main() { vec3 c = texture(uSrc, vLocal).rgb; fragColor = vec4(max(c - uTh, 0.0) * 1.6, 1.0); }`;
const BLUR = `
uniform sampler2D uSrc; uniform vec2 uDir;
void main() {
  vec3 s = texture(uSrc, vLocal).rgb * 0.227027;
  s += (texture(uSrc, vLocal + uDir * 1.3846).rgb + texture(uSrc, vLocal - uDir * 1.3846).rgb) * 0.316216;
  s += (texture(uSrc, vLocal + uDir * 3.2308).rgb + texture(uSrc, vLocal - uDir * 3.2308).rgb) * 0.070270;
  fragColor = vec4(s, 1.0);
}`;
const PERSIST = `
uniform sampler2D uSrc, uPrev; uniform float uDecay;
void main() { fragColor = vec4(max(texture(uSrc, vLocal).rgb, texture(uPrev, vLocal).rgb * uDecay), 1.0); }`;
const FINAL = `
uniform sampler2D uPhos, uBloom;
uniform float uP_scan, uP_mask, uP_bloom, uP_curve, uP_pitch, uP_flicker;
void main() {
  vec2 u = vLocal * 2.0 - 1.0;
  float r2 = dot(u * vec2(0.9, 1.0), u * vec2(0.9, 1.0));
  vec3 c = texture(uPhos, vLocal).rgb + texture(uBloom, vLocal).rgb * uP_bloom;
  vec2 px = vLocal * uRectPx;                                            // scene pixels: scanlines & mask are locked to them
  float y = px.y / uP_pitch;
  float scan = 0.5 + 0.5 * cos(6.2831853 * y);
  float aaS = clamp(1.0 - 2.0 * fwidth(y), 0.0, 1.0);
  c *= mix(1.0, mix(1.0 - uP_scan, 1.0, pow(scan, 0.7)) * (1.0 + 0.35 * uP_scan), aaS);
  float xm = px.x / 3.0;                                                 // one RGB triad per 3 px
  vec3 m = vec3(0.5 + 0.5 * cos(6.2831853 * xm), 0.5 + 0.5 * cos(6.2831853 * (xm - 1.0 / 3.0)), 0.5 + 0.5 * cos(6.2831853 * (xm - 2.0 / 3.0)));
  m = pow(m, vec3(1.6)) * 1.9;
  float aaM = clamp(1.0 - 1.2 * fwidth(xm) * 3.0, 0.0, 1.0);
  c *= mix(vec3(1.0), mix(vec3(1.0), m, uP_mask), aaM);
  float bar = pow(0.5 + 0.5 * sin(6.2831853 * (vLocal.y * 0.8 - uTime * 0.09)), 10.0);
  c *= 1.0 + 0.10 * bar * uP_flicker + 0.012 * uP_flicker * sin(uTime * 61.0);
  c *= 1.0 - 0.45 * pow(clamp(r2 * 0.55, 0.0, 1.0), 1.4);               // vignette
  c += vec3(0.7, 0.8, 1.0) * smoothstep(0.9, 0.0, length(vLocal - vec2(0.18, 0.86))) * 0.05;  // glass reflection
  fragColor = vec4(c, 1.0);
}`;

export default defineEffect({
  name: 'CRT',
  cost: 2.2,
  params: {
    curve: P(0, 2, 1.0, 0.05, 'barrel curvature'),
    scan: P(0, 1, 0.55, 0.01, 'scanline depth'),
    pitch: P(2, 8, 3.0, 0.1, 'scanline pitch (px)'),
    mask: P(0, 1, 0.7, 0.01, 'shadow mask'),
    bloom: P(0, 2, 0.8, 0.05, 'bloom'),
    bleed: P(0, 3, 1.0, 0.05, 'beam bleed'),
    conv: P(0, 3, 1.0, 0.05, 'misconvergence'),
    persist: P(0, 0.95, 0.85, 0.01, 'phosphor persistence'),
    flicker: P(0, 2, 1.0, 0.05, 'rolling bar / flicker'),
  },
  presets: [
    { name: 'Studio monitor', values: {} },
    { name: 'Worn arcade', values: { curve: 1.6, scan: 0.8, mask: 1, bloom: 1.3, bleed: 2, conv: 2, persist: 0.9 } },
    { name: 'Clean trinitron', values: { curve: 0.4, scan: 0.3, pitch: 2, mask: 0.45, bloom: 0.5, conv: 0.4, flicker: 0.3 } },
  ],
  init() {},
  create(ctx, box) {
    const w = box.rt.w, h = box.rt.h, qw = Math.max(8, w >> 2), qh = Math.max(8, h >> 2);
    box.state = { base: ctx.rt(w, h), phos: [ctx.rt(w, h), ctx.rt(w, h)], cur: 0, b1: ctx.rt(qw, qh), b2: ctx.rt(qw, qh), first: true };
  },
  destroy(ctx, box) { const s = box.state; if (s) { ctx.freeRT(s.base); ctx.freeRT(s.phos[0]); ctx.freeRT(s.phos[1]); ctx.freeRT(s.b1); ctx.freeRT(s.b2); box.state = null; } },
  render(ctx, box, t) {
    const gl = ctx.gl, st = box.state;
    gl.disable(gl.BLEND);
    ctx.bind(st.base); const pb = ctx.prog('crt-base', BASE); ctx.common(pb, box, t); ctx.draw();
    // bloom: bright-pass -> separable blur (1/4 res)
    ctx.bind(st.b1); const pbr = ctx.prog('crt-bright', BRIGHT); pbr.use(); pbr.tex(5, st.base.tex, 'uSrc'); pbr.f('uTh', 0.55); ctx.draw();
    const pbl = ctx.prog('crt-blur', BLUR); pbl.use();
    ctx.bind(st.b2); pbl.tex(5, st.b1.tex, 'uSrc'); pbl.f2('uDir', 1 / st.b1.w, 0); ctx.draw();
    ctx.bind(st.b1); pbl.tex(5, st.b2.tex, 'uSrc'); pbl.f2('uDir', 0, 1 / st.b1.h); ctx.draw();
    ctx.bind(st.b2); pbl.tex(5, st.b1.tex, 'uSrc'); pbl.f2('uDir', 2 / st.b1.w, 0); ctx.draw();
    ctx.bind(st.b1); pbl.tex(5, st.b2.tex, 'uSrc'); pbl.f2('uDir', 0, 2 / st.b1.h); ctx.draw();
    // phosphor persistence: decay is per 1/60 s so it is refresh-rate independent
    const next = 1 - st.cur;
    ctx.bind(st.phos[next]); const pp = ctx.prog('crt-persist', PERSIST); pp.use();
    pp.tex(5, st.base.tex, 'uSrc'); pp.tex(6, st.phos[st.cur].tex, 'uPrev');
    pp.f('uDecay', st.first ? 0 : Math.pow(box.params.persist, Math.min(ctx.dt, 0.1) * 60)); ctx.draw();
    st.cur = next; st.first = false;
    ctx.bind(box.rt);
    const pf = ctx.prog('crt-final', FINAL); ctx.common(pf, box, t);
    pf.tex(5, st.phos[st.cur].tex, 'uPhos'); pf.tex(6, st.b1.tex, 'uBloom'); ctx.draw();
  },
});
