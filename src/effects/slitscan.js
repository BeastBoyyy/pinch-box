// 2. Slit-scan: every pixel reads a different moment from the 96-frame history ring (two adjacent layers blended).
import { defineEffect, P, HIST_GLSL } from './util.js';

const FRAG = HIST_GLSL + `
uniform float uP_depth, uP_mode, uP_speed, uP_cycles, uP_live, uP_sat;
float tri(float x) { return abs(fract(x) * 2.0 - 1.0); }
void main() {
  vec2 s = sceneUV(vLocal);
  float aspect = uRectPx.x / uRectPx.y;
  float T;
  if (uP_mode < 0.5) T = tri(vLocal.x * uP_cycles + uTime * uP_speed * 0.12);               // scanning wipe
  else if (uP_mode < 1.5) T = tri(length((vLocal - 0.5) * vec2(aspect, 1.0)) * 1.4 * uP_cycles - uTime * uP_speed * 0.12); // radial
  else T = tri(pow(luma(vid(s)), 0.4545) * uP_cycles * 1.5 + uTime * uP_speed * 0.08);     // luminance driven
  float maxAge = max(1.0, min(uP_depth, uHistCount - 1.0));
  float age = T * maxAge;
  float a0 = floor(age), f = age - a0;
  float a1 = min(a0 + 1.0, uHistCount - 1.0);
  vec3 c = mix(hist(histLayer(a0), s), hist(histLayer(a1), s), f);   // blended: no visible frame stepping
  vec3 live = vid(s);
  c = mix(c, live, uP_live);
  float g = luma(c);
  c = mix(vec3(g), c, uP_sat);
  float edge = smoothstep(0.0, 0.03, min(min(vLocal.x, 1.0 - vLocal.x), min(vLocal.y, 1.0 - vLocal.y)));
  fragColor = vec4(c * mix(0.92, 1.0, edge), 1.0);
}`;

export default defineEffect({
  name: 'Slit-scan',
  cost: 1.2,
  needsHistory: true,
  params: {
    depth: P(8, 90, 60, 1, 'history depth (frames)'),
    mode: P(0, 2, 0, 1, 'mode 0 wipe / 1 radial / 2 luma'),
    speed: P(0, 3, 0.6, 0.05, 'animation speed'),
    cycles: P(0.25, 4, 1.0, 0.05, 'cycles'),
    live: P(0, 0.6, 0.0, 0.01, 'live mix'),
    sat: P(0, 2, 1.15, 0.05, 'saturation'),
  },
  presets: [
    { name: 'Scanning wipe', values: {} },
    { name: 'Radial vortex', values: { mode: 1, cycles: 1.4, speed: 0.8 } },
    { name: 'Luminance melt', values: { mode: 2, cycles: 1.0, depth: 80, live: 0.1 } },
  ],
  init() {},
  render(ctx, box, t) {
    const p = ctx.prog('slit', FRAG);
    ctx.common(p, box, t);
    ctx.histUniforms(p);
    ctx.draw();
  },
});
