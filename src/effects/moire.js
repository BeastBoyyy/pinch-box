// 3. Moire: two rotating line gratings + a dot grating, phase-modulated by video luminance, analytically anti-aliased (fwidth).
import { defineEffect, P } from './util.js';

const FRAG = `
uniform float uP_freq, uP_angle, uP_delta, uP_wob, uP_follow, uP_dots, uP_contrast, uP_warm;
float grating(vec2 p, float ang, float freq, float phase) {
  vec2 d = vec2(cos(ang), sin(ang));
  float x = dot(p, d) * freq + phase;
  float amp = 1.0 - smoothstep(0.22, 0.5, fwidth(x));        // fade to the mean before the pattern can alias (Nyquist at 0.5)
  return smoothstep(0.2, 0.8, 0.5 + 0.5 * cos(6.2831853 * x) * amp);
}
void main() {
  vec2 s = sceneUV(vLocal);
  vec2 p = vLocal * uRectPx;                                  // full-resolution pixels regardless of quality scale
  vec3 v = vidLod(s, 1.2);
  float L = pow(max(luma(v), 0.0), 0.4545);
  float a = radians(uP_angle);
  float da = radians(uP_delta) * (1.0 + 0.6 * sin(uTime * 0.21 * uP_wob + 1.0)) + 0.012 * sin(uTime * 0.37 * uP_wob);
  float g1 = grating(p, a, uP_freq, L * uP_follow);
  float g2 = grating(p, a + da, uP_freq * 1.003, -L * uP_follow * 0.8 + uTime * 0.05 * uP_wob);
  // dot grating
  vec2 r = vec2(cos(a + 0.9), sin(a + 0.9)), q = vec2(-r.y, r.x);
  float xd = dot(p, r) * uP_freq * 0.9 + L * uP_follow * 0.4, yd = dot(p, q) * uP_freq * 0.9;
  float ampd = 1.0 - smoothstep(0.22, 0.5, max(fwidth(xd), fwidth(yd)));
  float dg = smoothstep(0.25, 0.75, 0.5 + 0.5 * cos(6.2831853 * xd) * cos(6.2831853 * yd) * ampd);
  float m = g1 * g2;
  m = mix(m, m * dg, uP_dots);
  float lum = clamp(m * 2.4 * (0.35 + 1.1 * L) * uP_contrast, 0.0, 1.0);
  lum = lum * lum * (3.0 - 2.0 * lum);
  vec3 dark = srgbToLinear(vec3(0.02, 0.03, 0.10));
  vec3 mid  = srgbToLinear(vec3(0.16, 0.30, 0.45));
  vec3 lite = mix(srgbToLinear(vec3(0.93, 0.89, 0.80)), srgbToLinear(vec3(0.97, 0.80, 0.55)), uP_warm);
  vec3 col = mix(mix(dark, mid, smoothstep(0.0, 0.5, lum)), lite, smoothstep(0.45, 1.0, lum));
  fragColor = vec4(col, 1.0);
}`;

export default defineEffect({
  name: 'Moire',
  cost: 1.0,
  params: {
    freq: P(0.1, 0.45, 0.2, 0.005, 'line frequency (1/px)'),
    angle: P(0, 180, 18, 1, 'angle'),
    delta: P(0.2, 8, 2.2, 0.1, 'beat angle'),
    wob: P(0, 3, 1.0, 0.05, 'drift speed'),
    follow: P(0, 8, 3.2, 0.1, 'luminance follow'),
    dots: P(0, 1, 0.45, 0.05, 'dot grating'),
    contrast: P(0.4, 2, 1.1, 0.05, 'contrast'),
    warm: P(0, 1, 0.3, 0.05, 'warm highlights'),
  },
  presets: [
    { name: 'Navy and cream', values: {} },
    { name: 'Fine interference', values: { freq: 0.36, delta: 1.1, dots: 0.15, follow: 4.5 } },
    { name: 'Coarse op-art', values: { freq: 0.12, delta: 4.5, dots: 0.8, follow: 2, warm: 0.8 } },
  ],
  init() {},
  render(ctx, box, t) {
    const p = ctx.prog('moire', FRAG);
    ctx.common(p, box, t);
    ctx.draw();
  },
});
