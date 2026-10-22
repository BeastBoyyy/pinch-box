// 5. Frosted glass: dual-Kawase blur of the BACKDROP (everything beneath, including earlier boxes), noise-displaced
// for an uneven pane, with grain, Fresnel-style rim, a diagonal specular streak and chromatic dispersion at the edges.
import { defineEffect, P } from './util.js';

const DOWN = `
uniform sampler2D uSrc; uniform vec4 uSrcRect; uniform vec2 uTexel; uniform float uOff;
vec3 sm(vec2 uv) { return texture(uSrc, clamp(uv, uSrcRect.xy, uSrcRect.xy + uSrcRect.zw)).rgb; }
void main() {
  vec2 uv = uSrcRect.xy + vLocal * uSrcRect.zw, o = uTexel * uOff;
  vec3 c = sm(uv) * 4.0 + sm(uv + vec2(-o.x, -o.y)) + sm(uv + vec2(o.x, -o.y)) + sm(uv + vec2(-o.x, o.y)) + sm(uv + vec2(o.x, o.y));
  fragColor = vec4(c / 8.0, 1.0);
}`;
const UP = `
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uOff;
vec3 sm(vec2 uv) { return texture(uSrc, uv).rgb; }
void main() {
  vec2 uv = vLocal, o = uTexel * uOff;
  vec3 c = sm(uv + vec2(-2.0 * o.x, 0.0)) + 2.0 * sm(uv + vec2(-o.x, o.y)) + sm(uv + vec2(0.0, 2.0 * o.y)) + 2.0 * sm(uv + vec2(o.x, o.y))
         + sm(uv + vec2(2.0 * o.x, 0.0)) + 2.0 * sm(uv + vec2(o.x, -o.y)) + sm(uv + vec2(0.0, -2.0 * o.y)) + 2.0 * sm(uv + vec2(-o.x, -o.y));
  fragColor = vec4(c / 12.0, 1.0);
}`;
const GLASS = `
uniform sampler2D uBlur;
uniform float uP_distort, uP_disp, uP_grain, uP_rim, uP_streak, uP_tint;
void main() {
  vec2 px = vLocal * uRectPx;
  vec2 n = vec2(vnoise(px * 0.011 + vec2(0.0, uTime * 0.03)), vnoise(px * 0.011 + vec2(41.0, -uTime * 0.025))) - 0.5;
  n += (vec2(vnoise(px * 0.09), vnoise(px * 0.09 + 7.0)) - 0.5) * 0.25;           // fine frost micro-relief
  vec2 uv = clamp(vLocal + n * uP_distort * 0.05, 0.002, 0.998);
  vec2 dpx = min(vLocal, 1.0 - vLocal) * uRectPx;
  float edgeD = min(dpx.x, dpx.y);
  float rim = 1.0 - smoothstep(0.0, 30.0, edgeD);
  vec2 dir = normalize(vLocal - 0.5 + 1e-4);
  vec2 off = dir * rim * uP_disp * 0.008;                                           // chromatic dispersion near the edges
  vec3 c = vec3(texture(uBlur, uv + off).r, texture(uBlur, uv).g, texture(uBlur, uv - off).b);
  c = c * 1.06 + 0.02;
  c = mix(c, vec3(0.80, 0.88, 0.98) * (0.35 + 0.65 * luma(c)), uP_tint);            // cool frost tint
  float g = hash12(floor(px) + floor(uTime * 24.0) * 3.7) - 0.5;
  c *= 1.0 + g * 0.05 * uP_grain;
  c += vec3(0.9, 0.95, 1.0) * rim * rim * 0.22 * uP_rim;                            // Fresnel-ish brighter rim
  float u = dot(vLocal - 0.5, normalize(vec2(1.0, 0.6)));
  float cx = sin(uTime * 0.22) * 0.32;
  float streak = smoothstep(0.07, 0.0, abs(u - cx)) * 0.10 + smoothstep(0.25, 0.0, abs(u - cx - 0.12)) * 0.035;
  c += vec3(1.0) * streak * uP_streak * (1.0 - 0.6 * rim);
  c += vec3(0.8, 0.9, 1.0) * smoothstep(1.2, 0.0, length(vLocal - vec2(0.0, 1.0))) * 0.035 * uP_streak; // soft sheen
  fragColor = vec4(c, 1.0);
}`;

export default defineEffect({
  name: 'Frosted glass',
  cost: 1.6,
  needsBackdrop: true,
  params: {
    radius: P(10, 60, 20, 1, 'blur radius (px)'),
    distort: P(0, 2, 0.5, 0.05, 'pane unevenness'),
    disp: P(0, 3, 1.0, 0.05, 'edge dispersion'),
    grain: P(0, 2, 1.0, 0.05, 'grain'),
    rim: P(0, 2, 1.0, 0.05, 'rim light'),
    streak: P(0, 2, 1.0, 0.05, 'specular streak'),
    tint: P(0, 0.6, 0.12, 0.01, 'frost tint'),
  },
  presets: [
    { name: 'Clear pane', values: {} },
    { name: 'Heavy frost', values: { radius: 40, distort: 1.2, tint: 0.3, grain: 1.4 } },
    { name: 'Light etched', values: { radius: 12, distort: 0.25, disp: 1.8, streak: 1.6, tint: 0.05 } },
  ],
  init() {},
  create(ctx, box) {
    const w = box.rt.w, h = box.rt.h, d = [], u = [];
    for (let i = 0; i < 4; i++) d.push(ctx.rt(Math.max(4, w >> (i + 1)), Math.max(4, h >> (i + 1))));
    for (let i = 2; i >= 0; i--) u[i] = ctx.rt(d[i].w, d[i].h);
    box.state = { d, u };
  },
  destroy(ctx, box) { if (box.state) { box.state.d.forEach(r => ctx.freeRT(r)); box.state.u.forEach(r => ctx.freeRT(r)); box.state = null; } },
  render(ctx, box, t) {
    const st = box.state, gl = ctx.gl;
    const off = box.params.radius / 24 * (0.6 + 0.4 * ctx.passLevel);
    const pd = ctx.prog('frost-down', DOWN), pu = ctx.prog('frost-up', UP);
    gl.disable(gl.BLEND);
    // level 0 reads the backdrop (scene resolution) through the box's scene-uv rect
    ctx.bind(st.d[0]); pd.use(); pd.tex(5, ctx.tex.backdrop, 'uSrc');
    pd.f4('uSrcRect', box.rect.x, box.rect.y, box.rect.w, box.rect.h); pd.f2('uTexel', 1 / ctx.sceneW, 1 / ctx.sceneH); pd.f('uOff', off); ctx.draw();
    for (let i = 1; i < 4; i++) {
      ctx.bind(st.d[i]); pd.tex(5, st.d[i - 1].tex, 'uSrc');
      pd.f4('uSrcRect', 0, 0, 1, 1); pd.f2('uTexel', 1 / st.d[i - 1].w, 1 / st.d[i - 1].h); pd.f('uOff', off); ctx.draw();
    }
    pu.use(); pu.f('uOff', off);
    let src = st.d[3];
    for (let i = 2; i >= 0; i--) {
      ctx.bind(st.u[i]); pu.tex(5, src.tex, 'uSrc'); pu.f2('uTexel', 1 / src.w, 1 / src.h); ctx.draw();
      src = st.u[i];
    }
    ctx.bind(box.rt);
    const pg = ctx.prog('frost-glass', GLASS); ctx.common(pg, box, t); pg.tex(5, st.u[0].tex, 'uBlur'); ctx.draw();
  },
});
