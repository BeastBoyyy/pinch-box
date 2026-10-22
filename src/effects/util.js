// Shared effect plumbing + GLSL snippets.
/** Normalise an effect module: params -> keys/defaults, three presets guaranteed. */
export function defineEffect(e) {
  e.paramKeys = Object.keys(e.params);
  e.uNames = e.paramKeys.map(k => 'uP_' + k);   // precomputed: no string building in the render loop
  e.defaults = Object.fromEntries(e.paramKeys.map(k => [k, e.params[k].default]));
  e.cost = e.cost ?? 1;
  if (!e.presets || e.presets.length !== 3) throw new Error(`effect ${e.name} needs exactly 3 presets`);
  return e;
}
/** p(min,max,default,step,label) */
export const P = (min, max, def, step = 0.01, label = '') => ({ min, max, default: def, step, label });

export function applyPreset(box, i) {
  box.preset = i;
  box.params = { ...box.effect.defaults, ...box.effect.presets[i].values };
}

/** history ring access in mirrored scene space; unit 1 is the TEXTURE_2D_ARRAY (see Renderer.histUniforms) */
export const HIST_GLSL = `
uniform sampler2DArray uHist; uniform float uHistHead, uHistCount;
float histLayer(float age) { return mod(uHistHead - floor(age) + 96.0, 96.0); }
vec3 hist(float layer, vec2 s) { return srgbToLinear(texture(uHist, vec3(1.0 - s.x, s.y, layer)).rgb); }
`;

/** smoothed relative depth (1 = near) with joint-bilateral upsampling guided by the video */
export const DEPTH_GLSL = `
uniform sampler2D uDepth; uniform vec2 uDepthSize;
float depthTap(vec2 s) { return texture(uDepth, vec2(1.0 - s.x, s.y)).r; }
float depthBilateral(vec2 s) {
  vec2 pc = s * uDepthSize;
  vec2 c0 = floor(pc - 0.5);
  float lc = luma(vidLod(s, 1.0));
  float acc = 0.0, ws = 0.0;
  for (int j = 0; j < 3; j++) for (int i = 0; i < 3; i++) {
    vec2 tc = (c0 + vec2(float(i), float(j)) + 0.5);
    vec2 ts = tc / uDepthSize;
    vec2 o = tc - pc;
    float wsp = exp(-dot(o, o) * 0.9);
    float dl = luma(vidLod(ts, 1.5)) - lc;
    float wr = exp(-dl * dl / (2.0 * 0.05 * 0.05));
    float w = wsp * wr + 1e-4;
    acc += w * depthTap(ts); ws += w;
  }
  return acc / ws;
}
`;
