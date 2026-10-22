// 12. Posterize + channel split: 4-level quantisation in OKLab with ordered Bayer 8x8 dithering, saturated chroma, RGB
// channels displaced in different directions by an amount driven by motion energy (frame difference), thin glow on the
// brightest level.
import { defineEffect, P, HIST_GLSL } from './util.js';

const FRAG = HIST_GLSL + `
uniform float uP_levels, uP_chroma, uP_split, uP_motion, uP_dither, uP_glow, uP_cq;
float bayer8(vec2 p) {
  ivec2 q = ivec2(mod(floor(p), 8.0));
  int x = q.x, a = q.x ^ q.y;
  int v = ((a & 1) << 5) | ((x & 1) << 4) | ((a & 2) << 2) | ((x & 2) << 1) | ((a & 4) >> 1) | ((x & 4) >> 2);
  return (float(v) + 0.5) / 64.0;
}
vec3 toOK(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  l = pow(max(l, 0.0), 1.0 / 3.0); m = pow(max(m, 0.0), 1.0 / 3.0); s = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3(0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
vec3 fromOK(vec3 c) {
  float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z, m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z, s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return vec3(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
vec3 post(vec2 s, vec2 pxp, out float top) {
  vec3 lab = toOK(vid(s));
  float d = (bayer8(pxp) - 0.5) * uP_dither;
  float n = max(uP_levels, 2.0);
  float lq = floor(clamp(lab.x, 0.0, 1.0) * (n - 1.0) + 0.5 + d) / (n - 1.0);
  top = step(0.999, lq);
  vec2 ab = lab.yz * uP_chroma;
  float cn = max(uP_cq, 2.0);
  ab = floor(ab * (cn * 2.5) + 0.5 + d * 0.25) / (cn * 2.5);
  return max(fromOK(vec3(lq, ab)), 0.0);
}
void main() {
  vec2 s = sceneUV(vLocal);
  vec2 px = vLocal * uRectPx;
  // motion energy from the last two camera frames (blurred over a few taps)
  float e = 0.0;
  for (int i = 0; i < 5; i++) {
    vec2 o = vec2(i == 1 ? 6.0 : (i == 2 ? -6.0 : 0.0), i == 3 ? 6.0 : (i == 4 ? -6.0 : 0.0)) / uSceneSize;
    float pl = uHistCount < 2.0 ? 0.0 : luma(hist(histLayer(1.0), s + o));
    e += abs(luma(hist(histLayer(0.0), s + o)) - (uHistCount < 2.0 ? luma(hist(histLayer(0.0), s + o)) : pl));
  }
  e = clamp(e * 0.2 * 14.0, 0.0, 1.0);
  float amt = uP_split * (0.4 + uP_motion * e) * max(1.0, uRectPx.x / 1280.0);
  vec2 dr = vec2(1.0, 0.25) * amt / uSceneSize, dg = vec2(-0.3, -0.9) * amt * 0.4 / uSceneSize, db = vec2(-1.0, 0.45) * amt / uSceneSize;
  float t0, t1, t2;
  vec3 r = post(s + dr, px, t0), g = post(s + dg, px, t1), b = post(s + db, px, t2);
  vec3 col = vec3(r.r, g.g, b.b);
  // thin glow on the brightest level
  float topAvg = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 0 ? 5.0 : (i == 1 ? -5.0 : 0.0), i == 2 ? 5.0 : (i == 3 ? -5.0 : 0.0)) / uSceneSize;
    float tt; post(s + o, px, tt); topAvg += tt * 0.25;
  }
  col += vec3(0.9, 0.95, 1.0) * topAvg * uP_glow * 0.18;
  fragColor = vec4(col, 1.0);
}`;

export default defineEffect({
  name: 'Posterize + split',
  cost: 1.6,
  needsHistory: true,
  params: {
    levels: P(2, 8, 4, 1, 'luminance levels'),
    chroma: P(0.6, 3, 2.0, 0.05, 'chroma boost'),
    cq: P(2, 6, 4, 1, 'chroma steps'),
    split: P(0, 14, 5, 0.25, 'channel offset (px)'),
    motion: P(0, 6, 3, 0.1, 'motion drive'),
    dither: P(0, 1.5, 0.15, 0.05, 'Bayer dither'),
    glow: P(0, 2, 1.0, 0.05, 'glow'),
  },
  presets: [
    { name: 'Riso four-tone', values: {} },
    { name: 'Hard poster', values: { levels: 3, dither: 0.25, chroma: 2.4, split: 8, cq: 2 } },
    { name: 'Dithered print', values: { levels: 5, dither: 1.2, split: 2.5, chroma: 1.3, motion: 1.5 } },
  ],
  init() {},
  render(ctx, box, t) {
    const p = ctx.prog('poster', FRAG);
    ctx.common(p, box, t); ctx.histUniforms(p);
    ctx.draw();
  },
});
