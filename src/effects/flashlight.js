// 4. Flash light: the box goes dark and your hands are the torches. Each tracked hand throws a beam from the index fingertip the way the finger
// points, with a real torch profile (hot core, soft ring, faint spill), dust in the beam and surfaces that catch the light. With no hands it wanders.
import { defineEffect, P } from './util.js';

const FRAG = `
uniform vec4 uA0, uA1; uniform float uN;
uniform float uP_power, uP_size, uP_throw, uP_ambient, uP_dust, uP_warm;
float asp;
vec2 sp(vec2 s) { return s * vec2(asp, 1.0); }
float pool(vec2 p, vec2 c, vec2 d) {
  vec2 v = p - c;
  float r = length(vec2(dot(v, d) / 1.3, dot(v, vec2(-d.y, d.x)))) / uP_size;
  return exp(-r * r * 2.0) * 0.75 + exp(-r * r * 12.0) * 0.9 + smoothstep(1.08, 0.9, r) * 0.28 + exp(-r * 1.5) * 0.05;
}
float cone(vec2 p, vec2 h, vec2 d, vec2 s) {
  vec2 v = p - h;
  float u = dot(v, d), w = abs(dot(v, vec2(-d.y, d.x))), reach = max(uP_throw, 0.05);
  float edge = 0.012 + u / reach * uP_size * 0.85;
  float dust = 0.5 + fbm(s * 22.0 + vec2(uTime * 0.25, -uTime * 0.16));
  return smoothstep(edge, edge * 0.25, w) * smoothstep(0.0, 0.03, u) * smoothstep(reach * 1.4, 0.0, u) * dust;
}
void main() {
  vec2 s = sceneUV(vLocal);
  asp = uSceneSize.x / uSceneSize.y;
  vec2 p = sp(s);
  float light = 0.0, vol = 0.0; vec2 focus = vec2(0.0); float fw = 0.0;
  for (int i = 0; i < 2; i++) {
    if (float(i) >= max(uN, 1.0)) break;
    vec4 a = i == 0 ? uA0 : uA1;
    vec2 h = sp(a.xy), d = normalize(a.zw * vec2(asp, 1.0)), c = h + d * uP_throw;
    float l = pool(p, c, d);
    light += l; vol += cone(p, h, d, s); focus += c * l; fw += l;
  }
  focus /= max(fw, 1e-3);
  vec3 c = vid(s);
  // surfaces: the luminance relief catches the light from the direction of the beam
  vec2 e = 2.0 / uSceneSize;
  vec2 g = vec2(luma(vid(s + vec2(e.x, 0.0))) - luma(vid(s - vec2(e.x, 0.0))), luma(vid(s + vec2(0.0, e.y))) - luma(vid(s - vec2(0.0, e.y))));
  vec3 n = normalize(vec3(-g * 7.0, 1.0)), ld = normalize(vec3(focus - p, 0.35));
  float spec = pow(max(dot(reflect(-ld, n), vec3(0.0, 0.0, 1.0)), 0.0), 18.0);
  vec3 tint = mix(vec3(0.92, 0.97, 1.0), vec3(1.0, 0.86, 0.62), uP_warm);
  vec3 col = c * light * uP_power * tint * (0.65 + 0.5 * max(dot(n, ld), 0.0));
  col += tint * spec * light * 0.25;
  col += c * vec3(0.5, 0.65, 1.0) * uP_ambient;                                     // moonlight in the dark
  col += tint * vol * uP_dust * 0.10;
  col += (hash12(floor(vLocal * uRectPx) + fract(uTime) * 61.0) - 0.5) * 0.008;
  fragColor = vec4(max(col, 0.0), 1.0);
}`;

export default defineEffect({
  name: 'Flash light',
  cost: 1.0,
  params: {
    power: P(0.5, 5, 2.2, 0.05, 'power'),
    size: P(0.08, 0.6, 0.24, 0.01, 'beam size'),
    throw: P(0.02, 0.6, 0.2, 0.01, 'throw distance'),
    ambient: P(0, 0.3, 0.035, 0.005, 'ambient light'),
    dust: P(0, 3, 1, 0.05, 'dust in the beam'),
    warm: P(0, 1, 0.45, 0.01, 'warmth'),
  },
  presets: [
    { name: 'Torch', values: {} },
    { name: 'Searchlight', values: { size: 0.14, power: 3.6, throw: 0.38, dust: 2.2, warm: 0, ambient: 0.015 } },
    { name: 'Candle', values: { size: 0.4, power: 1.5, throw: 0.05, warm: 1, dust: 0.2, ambient: 0.01 } },
  ],
  init() {},
  render(ctx, box, t) {
    const p = ctx.prog('flashlight', FRAG), a = ctx.aim.p, r = box.rect;
    ctx.common(p, box, t);
    if (ctx.aim.n) { p.f4('uA0', a[0], a[1], a[2], a[3]); p.f4('uA1', a[4], a[5], a[6], a[7]); }
    else p.f4('uA0', r.x + r.w * (0.5 + 0.28 * Math.sin(t * 0.7)), r.y + r.h * (0.45 + 0.22 * Math.sin(t * 0.53 + 1)), 0.2, 1);
    p.f('uN', ctx.aim.n);
    ctx.draw();
  },
});
