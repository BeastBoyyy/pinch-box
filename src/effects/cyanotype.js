// 11. Cyanotype: tone-curved luminance through a Prussian-blue -> paper-white ramp, paper fibres and grain, slightly uneven
// "brush" edges around the exposed areas, and a faint halation glow.
import { defineEffect, P } from './util.js';

const FRAG = `
uniform float uP_contrast, uP_cut, uP_brush, uP_fibre, uP_halo, uP_invert, uP_warm;
void main() {
  vec2 px = vLocal * uRectPx;
  vec2 s = sceneUV(vLocal);
  // hand-brushed emulsion: slow noise bends the sampling a little and moves the exposure threshold unevenly
  vec2 warp = (vec2(fbm(px * 0.012), fbm(px * 0.012 + 9.7)) - 0.5) * 0.010 * uP_brush;
  float L = pow(max(luma(vid(s + warp)), 0.0), 0.4545);
  if (uP_invert > 0.5) L = 1.0 - L;
  float n = fbm(px * 0.02 + 3.0) - 0.5;
  float x = clamp((L - 0.5) * uP_contrast + 0.5 + n * 0.22 * uP_brush, 0.0, 1.0);
  float t = smoothstep(uP_cut - 0.35, uP_cut + 0.35, x);                // exposure curve
  float edge = smoothstep(0.35, 0.5, t) * (1.0 - smoothstep(0.5, 0.65, t));   // rough rim where exposure transitions
  t = clamp(t + edge * (vnoise(px * 0.35) - 0.5) * 0.5 * uP_brush, 0.0, 1.0);
  vec3 prussian = srgbToLinear(vec3(0.015, 0.075, 0.24));
  vec3 mid      = srgbToLinear(vec3(0.05, 0.28, 0.55));
  vec3 pale     = srgbToLinear(vec3(0.62, 0.80, 0.90));
  vec3 paper    = mix(srgbToLinear(vec3(0.94, 0.96, 0.95)), srgbToLinear(vec3(0.96, 0.93, 0.84)), uP_warm);
  vec3 col = mix(prussian, mid, smoothstep(0.0, 0.45, t));
  col = mix(col, pale, smoothstep(0.35, 0.8, t));
  col = mix(col, paper, smoothstep(0.78, 1.0, t));
  // paper fibres + grain
  float fib = vnoise(px * vec2(0.6, 0.03)) * 0.55 + vnoise(px * vec2(0.025, 0.55)) * 0.45;
  col *= 1.0 + uP_fibre * (0.10 * (fib - 0.5) + 0.05 * (hash12(floor(px)) - 0.5));
  // halation: soft cyan bloom around the bright areas (low mips of the video)
  float hv = pow(max(luma(vidLod(s, 4.5)), 0.0), 0.4545);
  col += vec3(0.04, 0.22, 0.42) * smoothstep(0.55, 1.0, hv) * uP_halo * (1.0 - t * 0.5);
  fragColor = vec4(col, 1.0);
}`;

export default defineEffect({
  name: 'Cyanotype',
  cost: 1.0,
  params: {
    contrast: P(0.6, 3, 1.5, 0.05, 'contrast'),
    cut: P(0.2, 0.8, 0.5, 0.01, 'exposure point'),
    brush: P(0, 2, 1.0, 0.05, 'brush unevenness'),
    fibre: P(0, 2, 1.0, 0.05, 'paper fibres'),
    halo: P(0, 2, 0.8, 0.05, 'halation'),
    warm: P(0, 1, 0.2, 0.01, 'paper warmth'),
    invert: P(0, 1, 0, 1, 'invert'),
  },
  presets: [
    { name: 'Sun print', values: {} },
    { name: 'Deep prussian', values: { cut: 0.62, contrast: 2.2, halo: 1.3, brush: 0.6 } },
    { name: 'Pale wash', values: { cut: 0.38, contrast: 1.1, warm: 0.6, brush: 1.6, fibre: 1.5 } },
  ],
  init() {},
  render(ctx, box, t) {
    const p = ctx.prog('cyano', FRAG);
    ctx.common(p, box, t);
    ctx.draw();
  },
});
