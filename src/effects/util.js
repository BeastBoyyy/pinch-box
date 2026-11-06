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

/** person mask (1 = person). segAt reads a mip level: LOD 0 is the edge, high LODs are a soft body-shaped height field. personEdge snaps the
 *  low-res mask to edges in the video (joint bilateral upsampling) so hair and fingers do not get a blocky halo. */
export const SEG_GLSL = `
uniform sampler2D uSeg; uniform vec2 uSegSize;
float segAt(vec2 s, float lod) { return textureLod(uSeg, vec2(1.0 - s.x, s.y), lod).r; }
float personEdge(vec2 s) {
  vec2 pc = s * uSegSize, c0 = floor(pc - 0.5);
  float lc = luma(vidLod(s, 1.0)), acc = 0.0, ws = 0.0;
  for (int j = 0; j < 3; j++) for (int i = 0; i < 3; i++) {
    vec2 tc = c0 + vec2(float(i), float(j)) + 0.5, ts = tc / uSegSize, o = tc - pc;
    float dl = luma(vidLod(ts, 1.5)) - lc;
    float w = exp(-dot(o, o) * 0.9) * exp(-dl * dl / 0.02) + 1e-4;
    acc += w * segAt(ts, 0.0); ws += w;
  }
  return smoothstep(0.38, 0.62, acc / ws);
}
`;
