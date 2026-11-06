// 8. Halftone print: real screen printing. Each ink gets its own rotated dot screen, dot size follows the amount of ink, plates are slightly
// out of register and inks overprint on paper.
import { defineEffect, P } from './util.js';

const FRAG = `
uniform float uP_cell, uP_mode, uP_misreg, uP_paper, uP_contrast;
vec2 ROT(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
vec3 tone(vec2 s) {
  vec3 c = linearToSrgb(vidLod(s, log2(max(uP_cell, 1.0)) - 0.5));
  float sat = 1.5;                                                       // print inks want punchier colour than a webcam gives
  c = mix(vec3(luma(c)), c, sat);
  return clamp((c - 0.5) * uP_contrast + 0.55, 0.0, 1.0);
}
vec4 cmyk(vec3 c) { float k = 1.0 - max(max(c.r, c.g), c.b), d = max(1.0 - k, 1e-3); return vec4((1.0 - c - k) / d, k * k); }
// the dot of one plate at px: sample the picture at the centre of this dot's cell; pick chooses the plate's ink amount
float plate(vec2 px, float ang, int ch, vec2 off) {
  vec2 g = ROT(px + off, ang) / uP_cell, id = floor(g) + 0.5;
  vec2 centre = ROT(id * uP_cell, -ang) - off;
  vec3 c = tone(sceneUV(centre / uRectPx));
  vec4 k = cmyk(c);
  float v = ch == 0 ? k.x : ch == 1 ? k.y : ch == 2 ? k.z : ch == 3 ? k.w : ch == 4 ? 1.0 - luma(c) : 1.0 - c.r * 0.7 - c.g * 0.3;
  v = clamp(v, 0.0, 1.0);
  float r = 0.564 * sqrt(v) + 0.17 * v * v, d = length(g - id), aa = 0.75 / uP_cell;   // area = ink coverage; dots merge in the shadows
  if (v < 0.03) return 0.0;
  return smoothstep(r + aa, r - aa, d);
}
void main() {
  vec2 px = vLocal * uRectPx;
  vec3 paper = srgbToLinear(vec3(0.96, 0.93, 0.85));
  paper *= 1.0 + uP_paper * (0.05 * (fbm(px * vec2(0.35, 0.05)) - 0.5) + 0.03 * (hash12(floor(px)) - 0.5));
  vec3 col = paper;
  vec2 m = vec2(uP_misreg);
  if (uP_mode < 0.5) {
    vec3 C = srgbToLinear(vec3(0.0, 0.62, 0.86)), M = srgbToLinear(vec3(0.90, 0.05, 0.50)), Y = srgbToLinear(vec3(1.0, 0.90, 0.0)), K = srgbToLinear(vec3(0.09, 0.08, 0.09));
    col *= mix(vec3(1.0), C, plate(px, 0.2618, 0, m));
    col *= mix(vec3(1.0), M, plate(px, 1.3090, 1, -m));
    col *= mix(vec3(1.0), Y, plate(px, 0.0, 2, m.yx * vec2(-1.0, 1.0)));
    col *= mix(vec3(1.0), K, plate(px, 0.7854, 3, vec2(0.0)));
  } else if (uP_mode < 1.5) {
    vec3 A = srgbToLinear(vec3(1.0, 0.28, 0.46)), B = srgbToLinear(vec3(0.0, 0.32, 0.72));
    col *= mix(vec3(1.0), A, plate(px, 0.2618, 5, m));
    col *= mix(vec3(1.0), B, plate(px, 1.0472, 4, -m));
  } else {
    col *= mix(vec3(1.0), srgbToLinear(vec3(0.07, 0.07, 0.08)), plate(px, 0.7854, 4, vec2(0.0)));
  }
  fragColor = vec4(col, 1.0);
}`;

export default defineEffect({
  name: 'Halftone print',
  cost: 1.0,
  params: {
    cell: P(3, 24, 8, 0.5, 'dot spacing'),
    mode: P(0, 2, 0, 1, 'inks: CMYK / two colour / black'),
    misreg: P(0, 4, 1, 0.05, 'misregistration'),
    contrast: P(0.5, 2.5, 1.25, 0.05, 'contrast'),
    paper: P(0, 2, 1, 0.05, 'paper grain'),
  },
  presets: [
    { name: 'Comic CMYK', values: {} },
    { name: 'Two-colour print', values: { mode: 1, cell: 7, misreg: 2 } },
    { name: 'Newspaper', values: { mode: 2, cell: 6, misreg: 0, contrast: 1.5 } },
  ],
  init() {},
  render(ctx, box, t) {
    const p = ctx.prog('halftone', FRAG);
    ctx.common(p, box, t); ctx.draw();
  },
});
