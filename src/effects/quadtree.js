// 10. Quadtree pixelation on the GPU: mip levels of the frame (and luma^2) give per-cell mean + variance; each pixel starts
// at a coarse cell and descends while local variance stays above a threshold. Cells are filled with their mean colour and
// get crisp anti-aliased 1 px dark borders. Detail concentrates on the face and hands.
import { defineEffect, P } from './util.js';

const STATS = `
void main() { vec3 c = vid(sceneUV(vLocal)); float l = luma(c); fragColor = vec4(c, l * l); }`;

const SHOW = `
uniform sampler2D uStats; uniform vec2 uStatsSize;
uniform float uP_maxCell, uP_minCell, uP_thresh, uP_line, uP_lineAlpha, uP_sat;
void main() {
  vec2 P = vLocal * uStatsSize;                              // position in stats texels
  float maxL = log2(uP_maxCell), minL = log2(uP_minCell);
  float lvl = maxL; vec3 mean = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float l = maxL - float(i);
    if (l < minL - 0.01) break;
    float cs = exp2(l);
    vec2 cuv = (floor(P / cs) + 0.5) * cs / uStatsSize;      // cell centre: exact texel of mip l, no blending across cells
    vec4 m = textureLod(uStats, cuv, l);
    float sd = sqrt(max(m.a - pow(luma(m.rgb), 2.0), 0.0));
    mean = m.rgb; lvl = l;
    if (sd < uP_thresh * (0.5 + 0.5 * l / maxL)) break;      // flat enough: stop subdividing
  }
  float cs = exp2(lvl);
  vec2 loc = fract(P / cs) * cs;
  float w = max(fwidth(P.x), fwidth(P.y));                   // stats texels per output pixel
  vec2 dEdge = min(loc, cs - loc) / w;                       // distance to the cell border in output pixels
  float d = min(dEdge.x, dEdge.y);
  float line = (1.0 - smoothstep(uP_line - 0.5, uP_line + 0.5, d)) * smoothstep(2.5, 6.0, cs / w); // thin cells keep their fill instead of turning to ink
  float g = luma(mean);
  mean = mix(vec3(g), mean, uP_sat);
  vec3 col = mix(mean, vec3(0.006, 0.006, 0.008), line * uP_lineAlpha);
  fragColor = vec4(col, 1.0);
}`;

export default defineEffect({
  name: 'Quadtree pixelation',
  cost: 1.0,
  params: {
    maxCell: P(16, 128, 64, 1, 'largest cell'),
    minCell: P(2, 16, 8, 1, 'smallest cell'),
    thresh: P(0.01, 0.2, 0.07, 0.002, 'variance threshold'),
    line: P(0.5, 3, 1.0, 0.05, 'border width'),
    lineAlpha: P(0, 1, 0.9, 0.01, 'border strength'),
    sat: P(0, 1.6, 1.0, 0.02, 'saturation'),
  },
  presets: [
    { name: 'Gridded face', values: {} },
    { name: 'Heavy blocks', values: { maxCell: 128, minCell: 8, thresh: 0.09, line: 1.4 } },
    { name: 'Fine mosaic', values: { maxCell: 32, minCell: 4, thresh: 0.03, lineAlpha: 0.55, line: 0.8 } },
  ],
  init() {},
  create(ctx, box) {
    const w = Math.max(64, Math.ceil(box.rt.w / 64) * 64), h = Math.max(64, Math.ceil(box.rt.h / 64) * 64);
    box.state = { stats: ctx.rt(w, h, { mips: true }), first: true };
  },
  destroy(ctx, box) { if (box.state) { ctx.freeRT(box.state.stats); box.state = null; } },
  render(ctx, box, t) {
    const gl = ctx.gl, st = box.state;
    if (ctx.newFrame || st.first) {
      ctx.bind(st.stats);
      const ps = ctx.prog('qt-stats', STATS); ctx.common(ps, box, t);
      if (!st.first) { gl.enable(gl.BLEND); gl.blendColor(0, 0, 0, 0.55); gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA); } // temporal EMA keeps the tree from flickering
      ctx.draw(); gl.disable(gl.BLEND);
      gl.bindTexture(gl.TEXTURE_2D, st.stats.tex); gl.generateMipmap(gl.TEXTURE_2D);
      st.first = false;
    }
    ctx.bind(box.rt);
    const p = ctx.prog('qt-show', SHOW); ctx.common(p, box, t);
    p.tex(5, st.stats.tex, 'uStats'); p.f2('uStatsSize', st.stats.w, st.stats.h);
    ctx.draw();
  },
});
