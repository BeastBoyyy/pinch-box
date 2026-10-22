// 6. Data-mosh: GPU emulation of P-frame corruption. Block matching (8x8 blocks at 1/4 resolution, +-8 search, SAD on
// luminance) between the last two history frames; each camera frame the PREVIOUS OUTPUT is advected by the block vectors
// instead of showing the new frame. Randomised keyframe resets, macroblock corruption and ringing noise on top.
import { defineEffect, P, HIST_GLSL } from './util.js';

const MV = HIST_GLSL + `
void main() {
  vec2 b = floor(gl_FragCoord.xy);
  vec2 sBase = sceneUV((b * 8.0 + 1.0) * 4.0 / uRectPx);               // first sample of this block (8x8 quarter px, stride 2)
  float curL = histLayer(0.0), prvL = uHistCount < 2.0 ? curL : histLayer(1.0);
  float cur[16];
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) cur[j * 4 + i] = luma(hist(curL, sBase + vec2(float(i), float(j)) * 8.0 / uSceneSize));
  float bestS = 1e9; vec2 best = vec2(0.0);
  for (int dy = -8; dy <= 8; dy++) for (int dx = -8; dx <= 8; dx++) {
    vec2 sh = vec2(float(dx), float(dy)) * 4.0 / uSceneSize;
    float sad = 0.0;
    for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++)
      sad += abs(cur[j * 4 + i] - luma(hist(prvL, sBase + vec2(float(i), float(j)) * 8.0 / uSceneSize + sh)));
    sad += 0.004 * float(abs(dx) + abs(dy));                            // prefer no motion on ties
    if (sad < bestS) { bestS = sad; best = vec2(float(dx), float(dy)); }
  }
  fragColor = vec4(best, bestS, 1.0);
}`;

const ADV = HIST_GLSL + `
uniform sampler2D uPrev, uMV;
uniform float uP_blend, uP_smear, uReset;
void main() {
  vec2 px4 = vLocal * uRectPx / 4.0;
  vec2 b = floor(px4 / 8.0);
  vec4 mvs = texelFetch(uMV, ivec2(b), 0);
  vec2 pull = mvs.xy * 4.0 / uRectPx * uP_smear;
  vec3 cur = vid(sceneUV(vLocal));
  vec3 adv = texture(uPrev, clamp(vLocal + pull, 0.0, 1.0)).rgb;
  float refresh = smoothstep(0.30, 0.8, mvs.z);                        // blocks that could not be matched fall back to the live frame
  vec3 c = mix(adv, cur, clamp(uP_blend + refresh * 0.5, 0.0, 1.0));
  c = mix(c, cur, uReset);                                             // I-frame
  fragColor = vec4(max(c, 0.0), 1.0);
}`;

// display pass: corruption is applied to what is SHOWN, not accumulated in the state, so it flashes and goes instead of shredding the image
const BLIT = HIST_GLSL + `
uniform sampler2D uSrc; uniform float uP_corrupt, uCorrupt, uSeed;
void main() {
  vec3 c = texture(uSrc, vLocal).rgb;
  vec2 px4 = vLocal * uRectPx / 4.0;
  vec2 cb = floor(px4 / 16.0);                                          // 16x16 macroblocks at quarter resolution
  float h = hash12(cb + uSeed * 13.7);
  float hit = step(h, uCorrupt * (0.03 + 0.12 * uP_corrupt));
  vec2 jit = (hash22(cb + uSeed) - 0.5) * 0.12;
  vec3 old = hist(histLayer(2.0 + floor(hash12(cb + 3.1 + uSeed) * 30.0)), clamp(sceneUV(vLocal) + jit, 0.0, 1.0));
  vec3 q = floor(pow(max(old, 0.0), vec3(0.4545)) * 5.0 + 0.5) / 5.0;   // colour-quantised block copy from older history
  c = mix(c, pow(q, vec3(2.2)), hit * 0.9);
  float ring = (hash12(floor(px4 * 2.0) + uSeed) - 0.5) * 0.03 * uP_corrupt * uCorrupt;
  fragColor = vec4(max(c + ring, 0.0), 1.0);
}`;

export default defineEffect({
  name: 'Data-mosh',
  cost: 3.0,
  needsHistory: true,
  params: {
    blend: P(0, 0.4, 0.05, 0.005, 'live bleed-in per frame'),
    smear: P(0.2, 2, 1.0, 0.05, 'vector strength'),
    corrupt: P(0, 2, 1.0, 0.05, 'macroblock corruption'),
    keyMin: P(0.8, 5, 1.5, 0.1, 'keyframe min (s)'),
    keyMax: P(1.5, 8, 4.0, 0.1, 'keyframe max (s)'),
  },
  presets: [
    { name: 'Classic mosh', values: {} },
    { name: 'Long hold', values: { blend: 0.015, keyMin: 3, keyMax: 7, smear: 1.3 } },
    { name: 'Glitch storm', values: { blend: 0.09, corrupt: 2, keyMin: 0.8, keyMax: 1.8 } },
  ],
  init() {},
  create(ctx, box) {
    const gw = Math.max(2, Math.ceil(box.rect.w * ctx.sceneW / 32)), gh = Math.max(2, Math.ceil(box.rect.h * ctx.sceneH / 32));
    box.state = { mv: ctx.rt(gw, gh, { format: 'rgba16f', filter: 'nearest' }),
      out: [ctx.rt(box.rt.w, box.rt.h), ctx.rt(box.rt.w, box.rt.h)], cur: 0, first: true, nextKey: -1, resetUntil: 0, nextCorrupt: 0, corruptUntil: 0, seed: 1 };
  },
  destroy(ctx, box) { const s = box.state; if (s) { ctx.freeRT(s.mv); ctx.freeRT(s.out[0]); ctx.freeRT(s.out[1]); box.state = null; } },
  render(ctx, box, t) {
    const gl = ctx.gl, st = box.state, bp = box.params;
    if (st.nextKey < 0) { st.nextKey = t + bp.keyMin + Math.random() * (bp.keyMax - bp.keyMin); st.nextCorrupt = t + 0.5 + Math.random(); }
    if (ctx.newFrame || st.first) {
      if (t >= st.nextKey) { st.resetUntil = t + 0.14; st.nextKey = t + bp.keyMin + Math.random() * Math.max(0.1, bp.keyMax - bp.keyMin); }
      if (t >= st.nextCorrupt) { st.corruptUntil = t + 0.3 + Math.random() * 0.3; st.seed = Math.floor(Math.random() * 1000); st.nextCorrupt = t + 0.5 + Math.random() * 1.4; }
      gl.disable(gl.BLEND);
      // 1. block matching (only when a new camera frame arrived)
      ctx.bind(st.mv);
      const pm = ctx.prog('mosh-mv', MV); ctx.common(pm, box, t); ctx.histUniforms(pm); ctx.draw();
      // 2. advect the previous output
      const next = 1 - st.cur;
      ctx.bind(st.out[next]);
      const pa = ctx.prog('mosh-adv', ADV); ctx.common(pa, box, t); ctx.histUniforms(pa);
      pa.tex(5, st.out[st.cur].tex, 'uPrev'); pa.tex(6, st.mv.tex, 'uMV');
      pa.f('uReset', st.first || t < st.resetUntil ? 1 : 0);
      ctx.draw();
      st.cur = next; st.first = false;
    }
    ctx.bind(box.rt);
    const pb = ctx.prog('mosh-blit', BLIT); ctx.common(pb, box, t); ctx.histUniforms(pb);
    pb.tex(5, st.out[st.cur].tex, 'uSrc'); pb.f('uCorrupt', t < st.corruptUntil ? 1 : 0); pb.f('uSeed', st.seed); ctx.draw();
  },
});
