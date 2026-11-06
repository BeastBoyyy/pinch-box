// 10. Comic hero: an original character, inside the box only. Your clothes become a cel-shaded suit with energy lines, your skin goes flat and inked, and
// the room behind you turns into a printed comic panel: speed-line burst, dots, a misregistered ghost. Backgrounds and energy animate "on twos" like hand-drawn film.
import { defineEffect, P, SEG_GLSL } from './util.js';

const FRAG = SEG_GLSL + `
uniform vec4 uA0, uA1; uniform float uN;
uniform float uP_suit, uP_dots, uP_lines, uP_ink, uP_bolts, uP_misprint;
float Lm(vec2 s) { return luma(linearToSrgb(vidLod(s, 0.7))); }
float inkAt(vec2 s) {
  vec2 e = 1.6 / uSceneSize;
  float gx = Lm(s + vec2(e.x, 0.0)) - Lm(s - vec2(e.x, 0.0)), gy = Lm(s + vec2(0.0, e.y)) - Lm(s - vec2(0.0, e.y));
  return smoothstep(0.10, 0.24, length(vec2(gx, gy)) * uP_ink);
}
float dots(vec2 px, float tone, float cell) {
  vec2 g = mat2(0.7071, -0.7071, 0.7071, 0.7071) * px / cell;
  return smoothstep(0.08, -0.08, length(fract(g) - 0.5) - sqrt(clamp(tone, 0.0, 1.0)) * 0.68);
}
float arc(vec2 p, vec2 h, float seed, float hold) {
  vec2 v = p - h; float r = length(v), a = atan(v.y, v.x);
  float want = 0.035 + 0.05 * vnoise(vec2(a * 3.0 + seed, hold * 13.0)) + 0.02 * vnoise(vec2(a * 11.0, hold * 29.0 + seed));
  return exp(-pow((r - want) / 0.0035, 2.0)) * smoothstep(0.35, 0.6, vnoise(vec2(a * 1.7 - seed, hold * 7.0)));
}
void main() {
  vec2 s = sceneUV(vLocal), px = vLocal * uRectPx;
  float hold = floor(uTime * 12.0) / 12.0, asp = uRectPx.x / uRectPx.y;
  vec3 base = vec3(0.13, 0.12, 0.42), mid = vec3(0.24, 0.27, 0.78), lite = vec3(0.55, 0.66, 1.0), glow = vec3(1.0, 0.86, 0.10), ghost = vec3(0.10, 0.85, 0.80), bgA = vec3(1.0, 0.86, 0.22), bgB = vec3(0.98, 0.42, 0.20);
  if (uP_suit > 1.5) { base = vec3(0.86, 0.36, 0.08); mid = vec3(0.98, 0.62, 0.12); lite = vec3(1.0, 0.94, 0.80); glow = vec3(1.0, 1.0, 0.92); ghost = vec3(0.30, 0.20, 0.95); bgA = vec3(0.45, 0.82, 1.0); bgB = vec3(0.16, 0.34, 0.86); }
  else if (uP_suit > 0.5) { base = vec3(0.02, 0.34, 0.38); mid = vec3(0.05, 0.62, 0.60); lite = vec3(0.62, 0.96, 0.86); glow = vec3(1.0, 0.45, 0.42); ghost = vec3(1.0, 0.82, 0.15); bgA = vec3(1.0, 0.76, 0.70); bgB = vec3(0.70, 0.26, 0.62); }
  // the panel behind you: a burst of speed lines over the dotted room
  vec2 c = (vLocal - vec2(0.5, 0.48)) * vec2(asp, 1.0);
  float r = length(c), ang = atan(c.y, c.x), Lv = Lm(s);
  float k = floor(ang * 26.0 / 3.14159), ray = step(0.45, hash12(vec2(k, hold * 3.0))) * smoothstep(0.12, 0.5, r) * smoothstep(0.28, 0.5, fract(ang * 26.0 / 3.14159));
  vec3 bg = mix(bgA, bgB, smoothstep(0.1, 0.9, r));
  bg = mix(bg, vec3(1.0), ray * uP_lines * 0.8);
  bg *= 1.0 - 0.85 * uP_dots * dots(px, (1.0 - Lv) * 0.72, 7.0);
  bg = mix(bg, vec3(0.03, 0.03, 0.07), inkAt(s) * 0.7);
  // a misregistered print of your outline behind you
  vec2 off = vec2(0.012, -0.010) * uP_misprint * vec2(1.0, asp);
  bg = mix(bg, ghost, smoothstep(0.4, 0.6, segAt(s + off, 0.0)) * 0.85);
  // you: flat inked skin, cel-shaded suit with energy lines
  vec3 v = linearToSrgb(vidLod(s, 1.0));
  float skin = smoothstep(0.01, 0.09, v.r - v.g) * smoothstep(-0.01, 0.06, v.g - v.b) * smoothstep(0.12, 0.3, v.r);
  float tone = (Lv - 0.5) * 1.4 + 0.5;
  vec3 suit = tone < 0.34 ? base : tone < 0.68 ? mid : lite;
  suit *= 1.0 - 0.6 * uP_dots * dots(px, smoothstep(0.42, 0.1, tone) * 0.55, 5.0);
  float ridge = 1.0 - abs(fbm(s * vec2(7.0, 5.0) + vec2(hold * 0.6, -hold * 0.9)) * 2.0 - 1.0);
  suit = mix(suit, glow, smoothstep(0.955, 0.985, ridge));
  vec3 flesh = floor(v * 4.0 + 0.5) / 4.0;
  flesh = mix(flesh, flesh * vec3(0.55, 0.42, 0.62), smoothstep(0.45, 0.25, tone));
  vec3 hero = mix(suit, flesh, skin);
  hero = mix(hero, vec3(0.02, 0.02, 0.06), inkAt(s));
  float m = personEdge(s), outline = smoothstep(0.08, 0.3, abs(segAt(s, 0.0) - segAt(s, 2.0)));
  vec3 col = mix(bg, hero, m);
  col = mix(col, vec3(0.02, 0.02, 0.06), outline * uP_ink * 0.9);
  // energy arcs crackle round your fingertips
  vec2 p = s * vec2(uSceneSize.x / uSceneSize.y, 1.0), sc = vec2(uSceneSize.x / uSceneSize.y, 1.0);
  float e = 0.0;
  if (uN > 0.5) e += arc(p, uA0.xy * sc, 1.0, hold) + arc(p, uA0.xy * sc, 4.0, hold + 0.3);
  if (uN > 1.5) e += arc(p, uA1.xy * sc, 2.0, hold) + arc(p, uA1.xy * sc, 7.0, hold + 0.6);
  col = mix(col, mix(glow, vec3(1.0), 0.4), clamp(e * uP_bolts, 0.0, 1.0));
  fragColor = vec4(srgbToLinear(clamp(col, 0.0, 1.0)), 1.0);
}`;

export default defineEffect({
  name: 'Comic hero',
  cost: 1.6,
  needsSeg: true,
  params: {
    suit: P(0, 2, 0, 1, 'suit: volt / tide / solar'),
    dots: P(0, 1, 0.8, 0.01, 'print dots'),
    lines: P(0, 1, 0.8, 0.01, 'speed lines'),
    ink: P(0.3, 2, 1, 0.05, 'ink lines'),
    bolts: P(0, 2, 1, 0.05, 'fingertip energy'),
    misprint: P(0, 2, 1, 0.05, 'print misregistration'),
  },
  presets: [
    { name: 'Volt', values: {} },
    { name: 'Tide', values: { suit: 1 } },
    { name: 'Solar', values: { suit: 2, misprint: 1.4 } },
  ],
  init() {},
  render(ctx, box, t) {
    const p = ctx.prog('comichero', FRAG), a = ctx.aim.p;
    ctx.common(p, box, t); ctx.segUniforms(p);
    p.f4('uA0', a[0], a[1], a[2], a[3]); p.f4('uA1', a[4], a[5], a[6], a[7]); p.f('uN', ctx.aim.n);
    ctx.draw();
  },
});
