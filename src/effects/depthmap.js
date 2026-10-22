// 8. Depth map: perceptual colour map (Turbo / Viridis / Inferno) of the shared relative depth, joint-bilateral upsampled
// along the user's silhouette, anti-aliased isolines every N levels, atmospheric fog (far = darker).
import { defineEffect, P, DEPTH_GLSL } from './util.js';

const FRAG = DEPTH_GLSL + `
uniform float uP_palette, uP_levels, uP_lines, uP_fog, uP_detail, uP_gamma;
vec3 turbo(float x) {
  x = clamp(x, 0.0, 1.0);
  const vec4 kR4 = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234), kG4 = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333), kB4 = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
  const vec2 kR2 = vec2(-152.94239396, 59.28637943), kG2 = vec2(4.27729857, 2.82956604), kB2 = vec2(-89.90310912, 27.34824973);
  vec4 v4 = vec4(1.0, x, x * x, x * x * x); vec2 v2 = v4.zw * v4.z;
  return clamp(vec3(dot(v4, kR4) + dot(v2, kR2), dot(v4, kG4) + dot(v2, kG2), dot(v4, kB4) + dot(v2, kB2)), 0.0, 1.0);
}
vec3 viridis(float t) {
  t = clamp(t, 0.0, 1.0);
  const vec3 c0 = vec3(0.2777273272234177, 0.005407344544966578, 0.3340998053353061), c1 = vec3(0.1050930431085774, 1.404613529898575, 1.384590162594685), c2 = vec3(-0.3308618287255563, 0.214847559468213, 0.09509516302823659);
  const vec3 c3 = vec3(-4.634230498983486, -5.799100973351585, -19.33244095627987), c4 = vec3(6.228269936347081, 14.17993336680509, 56.69055260068105), c5 = vec3(4.776384997670288, -13.74514537774601, -65.35303263337234), c6 = vec3(-5.435455855934631, 4.645852612178535, 26.3124352495832);
  return clamp(c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6))))), 0.0, 1.0);
}
vec3 inferno(float t) {
  t = clamp(t, 0.0, 1.0);
  const vec3 c0 = vec3(0.0002189403691192265, 0.001651004631001012, -0.01948089843709184), c1 = vec3(0.1065134194856116, 0.5639564367884091, 3.932712388889277), c2 = vec3(11.60249308247187, -3.972853965665698, -15.9423941062914);
  const vec3 c3 = vec3(-41.70399613139459, 17.43639888205313, 44.35414519872813), c4 = vec3(77.162935699427, -33.40235894210092, -81.80730925738993), c5 = vec3(-71.31942824499214, 32.62606426397723, 73.20951985803202), c6 = vec3(25.13112622477341, -12.24266895238567, -23.07032500287172);
  return clamp(c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6))))), 0.0, 1.0);
}
void main() {
  vec2 s = sceneUV(vLocal);
  float d = depthBilateral(s);
  float dd = pow(clamp(d, 0.0, 1.0), uP_gamma);
  vec3 c = uP_palette < 0.5 ? turbo(dd) : (uP_palette < 1.5 ? viridis(dd) : inferno(dd));
  c = srgbToLinear(c);
  // keep the subject readable: modulate by the video's own shading
  float L = luma(vid(s));
  c *= mix(1.0, 0.45 + 1.1 * pow(L, 0.6), uP_detail);
  // anti-aliased isolines
  float q = d * uP_levels;
  float li = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), 1e-4);
  float line = (1.0 - smoothstep(0.6, 1.6, li)) * uP_lines;
  c = mix(c, vec3(0.01, 0.012, 0.02) + 0.0 * c, line * 0.75);
  // atmospheric fog: far = darker
  c *= mix(1.0, mix(0.12, 1.0, smoothstep(0.0, 0.55, d)), uP_fog);
  fragColor = vec4(c, 1.0);
}`;

export default defineEffect({
  name: 'Depth map',
  cost: 1.8,
  needsDepth: true,
  params: {
    palette: P(0, 2, 0, 1, 'palette 0 Turbo / 1 Viridis / 2 Inferno'),
    levels: P(4, 60, 18, 1, 'isoline count'),
    lines: P(0, 1, 0.8, 0.01, 'isoline strength'),
    fog: P(0, 1, 0.6, 0.01, 'fog'),
    detail: P(0, 1, 0.55, 0.01, 'video shading'),
    gamma: P(0.5, 2, 1.0, 0.01, 'depth gamma'),
  },
  presets: [
    { name: 'Turbo contours', values: {} },
    { name: 'Viridis smooth', values: { palette: 1, lines: 0.25, levels: 30, fog: 0.4, detail: 0.7 } },
    { name: 'Inferno survey', values: { palette: 2, levels: 10, lines: 1, fog: 0.8, detail: 0.35 } },
  ],
  init() {},
  render(ctx, box, t) {
    const p = ctx.prog('depthmap', FRAG);
    ctx.common(p, box, t); ctx.depthUniforms(p);
    ctx.draw();
  },
});
