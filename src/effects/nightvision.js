// 3. Night vision: an image intensifier. High gain lifts the shadows, noise grows where the signal is weak, highlights bloom, the tube smears
// motion (phosphor lag), and the view sits inside a tube: full frame, one eyepiece or binoculars.
import { defineEffect, P, HIST_GLSL } from './util.js';

const FRAG = HIST_GLSL + `
uniform float uP_gain, uP_grain, uP_bloom, uP_smear, uP_ir, uP_tube, uP_white;
float tube(vec2 p, vec2 c, float r) { return 1.0 - smoothstep(r - 0.03, r + 0.01, length(p - c)); }
void main() {
  vec2 s = sceneUV(vLocal), px = vLocal * uRectPx;
  float aspect = uRectPx.x / uRectPx.y;
  vec2 p = (vLocal - 0.5) * vec2(aspect, 1.0);
  float L = sqrt(luma(vid(s)));
  L = mix(L, sqrt(luma(hist(histLayer(2.0), s))), uP_smear * 0.65);
  float scene = luma(vidLod(s, 8.0));                                                        // automatic gain control
  L = 1.0 - exp(-L * L * uP_gain * 0.1 / (0.04 + scene));
  L += smoothstep(0.75, 1.0, sqrt(luma(vidLod(s, 4.0))) / sqrt(0.2 + scene * 1.6)) * uP_bloom * 0.5;   // highlights flare
  L *= 1.0 - uP_ir * smoothstep(0.15, 0.85, length(p));                                     // the IR illuminator lights the centre
  vec2 cell = floor(px / 1.5);
  float n = hash12(cell + fract(uTime * 7.3) * 113.0) - 0.5;
  L += n * uP_grain * (0.10 + 0.34 * (1.0 - clamp(L, 0.0, 1.0)));                            // noise is worst where the signal is weakest
  L += step(0.9988, hash12(cell * 1.7 + fract(uTime * 3.1) * 71.0)) * uP_grain * 0.8;        // scintillation sparks
  L *= 0.96 + 0.04 * sin(px.x * 2.1) * sin(px.y * 2.1);                                      // fibre-optic plate
  L = clamp(L, 0.0, 1.3);
  vec3 green = mix(vec3(0.005, 0.03, 0.012), vec3(0.28, 1.0, 0.38), L), white = mix(vec3(0.004, 0.012, 0.03), vec3(0.72, 0.9, 1.0), L);
  vec3 col = mix(green, white, uP_white) * (0.75 + 0.5 * L);
  float mask = 1.0;
  if (uP_tube > 1.5) mask = max(tube(p, vec2(-0.25 * min(aspect, 1.8), 0.0), 0.44), tube(p, vec2(0.25 * min(aspect, 1.8), 0.0), 0.44));
  else if (uP_tube > 0.5) mask = tube(p, vec2(0.0), 0.48);
  col *= mask * (1.0 - 0.5 * smoothstep(0.3, 0.8, length(p)));
  fragColor = vec4(col, 1.0);
}`;

export default defineEffect({
  name: 'Night vision',
  cost: 1.0,
  params: {
    gain: P(1, 30, 9, 0.5, 'gain'),
    grain: P(0, 2, 0.8, 0.02, 'noise'),
    bloom: P(0, 2, 0.8, 0.02, 'highlight bloom'),
    smear: P(0, 1, 0.45, 0.01, 'phosphor lag'),
    ir: P(0, 1, 0.45, 0.01, 'IR falloff'),
    tube: P(0, 2, 0, 1, 'view: full / eyepiece / binoculars'),
    white: P(0, 1, 0, 0.01, 'white phosphor'),
  },
  presets: [
    { name: 'Green tube', values: {} },
    { name: 'Binoculars', values: { tube: 2, gain: 12, ir: 0.2 } },
    { name: 'White phosphor', values: { white: 1, grain: 0.55, smear: 0.25 } },
  ],
  init() {},
  render(ctx, box, t) {
    const p = ctx.prog('nightvision', FRAG);
    ctx.common(p, box, t); ctx.histUniforms(p); ctx.draw();
  },
});
