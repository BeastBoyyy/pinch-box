// 1. Edge sketch: multi-scale Sobel + DoG ink lines on near-white paper, grain, colour fringe on strong edges.
import { defineEffect, P } from './util.js';

const FRAG = `
uniform float uP_lineWeight, uP_threshold, uP_gain, uP_fringe, uP_hatch, uP_grain, uP_tint;
float Ls(vec2 s) { return pow(max(luma(vid(s)), 0.0), 0.4545); }       // perceptual luma
float sobel(vec2 s, float k) {
  vec2 e = k / uSceneSize;
  float tl = Ls(s + vec2(-e.x,  e.y)), t = Ls(s + vec2(0.0,  e.y)), tr = Ls(s + vec2(e.x,  e.y));
  float l  = Ls(s + vec2(-e.x, 0.0)),                                  r  = Ls(s + vec2(e.x, 0.0));
  float bl = Ls(s + vec2(-e.x, -e.y)), b = Ls(s + vec2(0.0, -e.y)), br = Ls(s + vec2(e.x, -e.y));
  float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  float gy = (tl + 2.0 * t + tr) - (bl + 2.0 * b + br);
  return length(vec2(gx, gy));
}
float blur5(vec2 s, float k) {
  vec2 e = k / uSceneSize;
  return 0.2 * (Ls(s) + Ls(s + vec2(e.x, 0.0)) + Ls(s - vec2(e.x, 0.0)) + Ls(s + vec2(0.0, e.y)) + Ls(s - vec2(0.0, e.y)));
}
float ink(vec2 s) {
  float w = uP_lineWeight;
  float m1 = sobel(s, 0.9 * w), m2 = sobel(s, 2.4 * w) * 0.7;
  float dog = abs(blur5(s, 1.4 * w) - blur5(s, 3.6 * w)) * 3.0;
  float m = max(max(m1, m2), dog) * uP_gain * 0.25;
  return smoothstep(uP_threshold, uP_threshold + 0.22, m);
}
void main() {
  vec2 s = sceneUV(vLocal);
  vec2 px = vLocal * uRectPx;
  float l0 = ink(s);
  // colour fringe: the strongest edges split slightly per channel
  vec2 off = vec2(1.6, 0.6) * uP_fringe / uSceneSize;
  float lr = mix(l0, ink(s + off), step(0.01, uP_fringe));
  float lb = mix(l0, ink(s - off), step(0.01, uP_fringe));
  // paper: warm white, fibres + grain
  vec3 paper = srgbToLinear(vec3(0.955, 0.945, 0.915) + uP_tint * vec3(-0.01, 0.0, 0.04));
  float fib = vnoise(px * vec2(0.55, 0.035)) * 0.6 + vnoise(px * vec2(0.03, 0.5)) * 0.4;
  float grain = hash12(floor(px)) - 0.5;
  paper *= 1.0 + uP_grain * (0.05 * (fib - 0.5) + 0.035 * grain);
  // faint hatching in the shadows keeps the face readable
  float tone = 1.0 - Ls(s);
  float stripe = 0.5 + 0.5 * sin((px.x + px.y) * 0.9);
  float hatch = smoothstep(0.50, 0.85, tone) * stripe * uP_hatch * 0.22 + smoothstep(0.2, 0.7, tone) * uP_hatch * 0.07;
  vec3 inkc = srgbToLinear(vec3(0.07, 0.075, 0.10));
  vec3 col = paper * (1.0 - hatch);
  col.r = mix(col.r, inkc.r, lr);
  col.g = mix(col.g, inkc.g, l0);
  col.b = mix(col.b, inkc.b, lb);
  fragColor = vec4(col, 1.0);
}`;

export default defineEffect({
  name: 'Edge sketch',
  cost: 2.0,
  params: {
    lineWeight: P(0.4, 3, 0.8, 0.05, 'line weight'),
    threshold: P(0.0, 0.6, 0.2, 0.01, 'threshold'),
    gain: P(1, 14, 3.2, 0.1, 'gain'),
    fringe: P(0, 3, 1.0, 0.05, 'colour fringe'),
    hatch: P(0, 1.5, 0.45, 0.05, 'hatching'),
    grain: P(0, 2, 1.0, 0.05, 'paper grain'),
    tint: P(0, 1, 0.3, 0.05, 'cool tint'),
  },
  presets: [
    { name: 'Ink on paper', values: {} },
    { name: 'Fine pencil', values: { lineWeight: 0.55, gain: 5.5, threshold: 0.12, hatch: 1.0, fringe: 0.4 } },
    { name: 'Bold marker', values: { lineWeight: 2.0, gain: 3, threshold: 0.2, hatch: 0.2, fringe: 1.6 } },
  ],
  init() {},
  render(ctx, box, t) {
    const p = ctx.prog('edge', FRAG);
    ctx.common(p, box, t);
    ctx.draw();
  },
});
