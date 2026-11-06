// 6. 1-bit dither: two inks and nothing else. Ordered Bayer, noise or line screens on chunky pixels, with outlines kept solid so faces stay readable.
import { defineEffect, P } from './util.js';

const FRAG = `
uniform float uP_pixel, uP_contrast, uP_bright, uP_edges, uP_pattern, uP_palette;
float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }
float L(vec2 s) { return luma(linearToSrgb(vid(s))); }
void main() {
  vec2 cell = floor(vLocal * uRectPx / uP_pixel);
  vec2 s = sceneUV((cell + 0.5) * uP_pixel / uRectPx), e = uP_pixel / uSceneSize;
  float mean = luma(linearToSrgb(vidLod(s, 6.5)));                       // local exposure: bright rooms keep their detail
  float v = (L(s) - mix(0.5, mean, 0.75)) * uP_contrast + 0.5 + uP_bright;
  float th;
  if (uP_pattern < 0.5) th = bayer8(cell);
  else if (uP_pattern < 1.5) th = hash12(cell);
  else th = fract((cell.x + cell.y * 2.0) / 7.0);
  float edge = abs(L(s + vec2(e.x, 0.0)) - L(s - vec2(e.x, 0.0))) + abs(L(s + vec2(0.0, e.y)) - L(s - vec2(0.0, e.y)));
  float on = step(th, v) * (1.0 - step(0.28, edge * uP_edges));
  vec3 ink = vec3(0.0), paper = vec3(1.0);
  if (uP_palette > 2.5) { ink = vec3(0.13, 0.05, 0.28); paper = vec3(1.0, 0.72, 0.30); }       // dusk
  else if (uP_palette > 1.5) { ink = vec3(0.06, 0.22, 0.12); paper = vec3(0.70, 0.80, 0.25); }  // pocket LCD
  else if (uP_palette > 0.5) { ink = vec3(0.0, 0.0, 0.0); paper = vec3(1.0, 0.70, 0.12); }      // amber
  fragColor = vec4(srgbToLinear(mix(ink, paper, on)), 1.0);
}`;

export default defineEffect({
  name: '1-bit dither',
  cost: 0.6,
  params: {
    pixel: P(1, 10, 3, 1, 'pixel size'),
    contrast: P(0.5, 3, 1.35, 0.05, 'contrast'),
    bright: P(-0.4, 0.4, 0.03, 0.01, 'brightness'),
    edges: P(0, 3, 1, 0.05, 'outlines'),
    pattern: P(0, 2, 0, 1, 'pattern: bayer / noise / lines'),
    palette: P(0, 3, 0, 1, 'palette: mono / amber / LCD / dusk'),
  },
  presets: [
    { name: 'Black and white', values: {} },
    { name: 'Pocket LCD', values: { palette: 2, pixel: 4, contrast: 1.6 } },
    { name: 'Noise amber', values: { palette: 1, pattern: 1, pixel: 2, edges: 0.4 } },
  ],
  init() {},
  render(ctx, box, t) {
    const p = ctx.prog('dither', FRAG);
    ctx.common(p, box, t); ctx.draw();
  },
});
