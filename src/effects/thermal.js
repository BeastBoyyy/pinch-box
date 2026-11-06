// 2. Thermal vision: a heat estimate, not a recolouring. The segmentation mask makes the person the hot object against a cold room, skin
// runs hotter than clothes, heat bleeds a little past the body, and the picture has the coarse pixels and column noise of a real microbolometer.
import { defineEffect, P, SEG_GLSL } from './util.js';

const FRAG = SEG_GLSL + `
uniform float uP_palette, uP_pixel, uP_contrast, uP_level, uP_noise, uP_hud;
vec3 ramp(float h, vec3 a, vec3 b, vec3 c, vec3 d, vec3 e) {
  h = clamp(h, 0.0, 1.0) * 4.0;
  vec3 r = h < 1.0 ? mix(a, b, h) : h < 2.0 ? mix(b, c, h - 1.0) : h < 3.0 ? mix(c, d, h - 2.0) : mix(d, e, h - 3.0);
  return srgbToLinear(r);
}
vec3 palette(float h) {
  if (uP_palette < 0.5) return ramp(h, vec3(0.02, 0.0, 0.10), vec3(0.36, 0.0, 0.55), vec3(0.86, 0.13, 0.28), vec3(1.0, 0.62, 0.0), vec3(1.0, 0.98, 0.80));   // ironbow
  if (uP_palette < 1.5) return ramp(h, vec3(0.0, 0.0, 0.35), vec3(0.0, 0.75, 0.85), vec3(0.15, 0.9, 0.2), vec3(1.0, 0.85, 0.0), vec3(1.0, 0.1, 0.05));      // rainbow
  return vec3(pow(clamp(h, 0.0, 1.0), 2.0));                                                                                                                // white hot
}
void main() {
  vec2 px = vLocal * uRectPx;
  vec2 q = (floor(px / uP_pixel) + 0.5) * uP_pixel / uRectPx, s = sceneUV(q);
  vec3 c = linearToSrgb(vidLod(s, 1.5));
  float L = luma(c);
  float skin = smoothstep(0.02, 0.12, c.r - c.g) * smoothstep(0.0, 0.08, c.g - c.b) * smoothstep(0.15, 0.4, c.r);
  float person = smoothstep(0.35, 0.65, segAt(s, 1.0)), glow = segAt(s, 3.5);
  float room = 0.13 + 0.20 * L + 0.07 * (fbm(s * 5.0) - 0.5) + 0.55 * smoothstep(0.93, 1.0, L);   // cold walls, lamps stay hot
  float body = mix(0.60, 0.90, skin) + 0.10 * (L - 0.5);
  float heat = mix(room, body, person) + 0.10 * glow * (1.0 - person);
  heat = max(heat, 0.82 * skin * (1.0 - person));                                                // skin the mask missed (hands at the edge)
  heat = (heat - 0.5 - uP_level) * uP_contrast + 0.5;
  vec2 cell = floor(px / uP_pixel);
  heat += uP_noise * (0.022 * (hash12(cell + fract(uTime) * 57.0) - 0.5) + 0.012 * (hash12(vec2(cell.x, 3.0)) - 0.5));
  vec3 col = palette(heat);
  if (uP_hud > 0.5) {
    vec2 e = 1.0 / uRectPx;
    if (vLocal.x > 0.955 && vLocal.x < 0.975 && vLocal.y > 0.12 && vLocal.y < 0.88) col = palette((vLocal.y - 0.12) / 0.76);      // scale bar
    vec2 d = abs(px - 0.5 * uRectPx);
    float cross = step(min(d.x, d.y), 1.0) * step(max(d.x, d.y), 16.0) * step(5.0, max(d.x, d.y));
    col = mix(col, vec3(1.0), cross * 0.9);
  }
  fragColor = vec4(col, 1.0);
}`;

export default defineEffect({
  name: 'Thermal vision',
  cost: 1.0,
  needsSeg: true,
  params: {
    palette: P(0, 2, 0, 1, 'palette: ironbow / rainbow / white hot'),
    pixel: P(1, 10, 3, 1, 'sensor pixel size'),
    contrast: P(0.5, 2.5, 1.2, 0.05, 'contrast'),
    level: P(-0.3, 0.3, 0, 0.01, 'level'),
    noise: P(0, 3, 1, 0.05, 'sensor noise'),
    hud: P(0, 1, 1, 1, 'crosshair + scale'),
  },
  presets: [
    { name: 'Ironbow', values: {} },
    { name: 'Rainbow', values: { palette: 1, contrast: 1.4 } },
    { name: 'White hot', values: { palette: 2, contrast: 1.5, pixel: 2 } },
  ],
  init() {},
  render(ctx, box, t) {
    const p = ctx.prog('thermal', FRAG);
    ctx.common(p, box, t); ctx.segUniforms(p); ctx.draw();
  },
});
