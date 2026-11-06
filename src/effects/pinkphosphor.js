// 7. Pink phosphor: a monochrome tube with a pink coating. Same screen as the CRT effect (scanlines, bloom, persistence), but one phosphor,
// long trails, and edges driven harder so outlines burn brightest.
import { defineEffect, P } from './util.js';
import { phosphorScreen } from './crt.js';

const BASE = `
uniform float uP_curve, uP_contrast, uP_edge, uP_hue;
float L(vec2 s) { return luma(linearToSrgb(vid(s))); }
void main() {
  vec2 u = vLocal * 2.0 - 1.0;
  float r2 = dot(u * vec2(0.9, 1.0), u * vec2(0.9, 1.0));
  u *= 1.0 + uP_curve * (0.12 * r2 + 0.06 * r2 * r2);
  vec2 uv = u * 0.5 + 0.5, s = sceneUV(uv), e = 1.5 / uSceneSize;
  float inside = smoothstep(0.0, 0.012, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
  float mean = luma(linearToSrgb(vidLod(s, 7.0)));
  float v = clamp((L(s) - mix(0.5, mean, 0.8)) * uP_contrast + 0.42, 0.0, 1.0);
  float ed = abs(L(s + vec2(e.x, 0.0)) - L(s - vec2(e.x, 0.0))) + abs(L(s + vec2(0.0, e.y)) - L(s - vec2(0.0, e.y)));
  v = clamp(v * v + ed * uP_edge, 0.0, 1.4);
  vec3 hot = mix(vec3(1.0, 0.08, 0.46), vec3(0.78, 0.10, 1.0), uP_hue);
  vec3 col = mix(vec3(0.012, 0.0, 0.01), hot, smoothstep(0.0, 0.6, v));
  col = mix(col, vec3(1.0, 0.82, 0.92), smoothstep(0.65, 1.2, v));   // the hottest parts of the beam go white-pink
  fragColor = vec4(col * inside, 1.0);
}`;

export default defineEffect({
  name: 'Pink phosphor',
  cost: 2.2,
  params: {
    curve: P(0, 2, 0.9, 0.05, 'barrel curvature'),
    contrast: P(0.5, 3, 1.5, 0.05, 'contrast'),
    edge: P(0, 4, 1.6, 0.05, 'edge burn'),
    hue: P(0, 1, 0, 0.01, 'pink to violet'),
    scan: P(0, 1, 0.6, 0.01, 'scanline depth'),
    pitch: P(2, 8, 3.5, 0.1, 'scanline pitch (px)'),
    mask: P(0, 1, 0.12, 0.01, 'shadow mask'),
    bloom: P(0, 2, 1.25, 0.05, 'bloom'),
    persist: P(0, 0.97, 0.92, 0.01, 'phosphor persistence'),
    flicker: P(0, 2, 0.7, 0.05, 'rolling bar / flicker'),
  },
  presets: [
    { name: 'Hot pink', values: {} },
    { name: 'Long trails', values: { persist: 0.96, edge: 2.6, contrast: 1.2, bloom: 1.6 } },
    { name: 'Violet terminal', values: { hue: 0.8, curve: 0.4, scan: 0.8, pitch: 4, persist: 0.8 } },
  ],
  ...phosphorScreen('pink', BASE),
});
