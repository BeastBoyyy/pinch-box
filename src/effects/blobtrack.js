// 1. Blob tracking: finds what is moving (or bright / dark) in the box and tags each region with a tracked id: thin white rectangles,
// coordinates, lines joining the blobs, optional inverted patches. The mask is read back asynchronously (PBO + fence), so the GPU never stalls.
import { defineEffect, P, HIST_GLSL } from './util.js';
import { findBlobs, BlobTracker } from '../blobs.js';

const MAX = 24;
const ANALYZE = HIST_GLSL + `
uniform float uP_source, uP_threshold;
void main() {
  vec2 s = sceneUV(vLocal);
  float now = sqrt(luma(hist(histLayer(0.0), s))), v;
  if (uP_source < 0.5) v = abs(now - sqrt(luma(hist(histLayer(3.0), s)))) * 5.0;   // motion
  else if (uP_source < 1.5) v = now;                                               // bright
  else v = 1.0 - now;                                                              // dark
  fragColor = vec4(step(uP_threshold, v));
}`;
const FRAG = `
uniform sampler2D uOver; uniform vec4 uRects[${MAX}]; uniform int uN;
uniform float uP_mono, uP_invert;
void main() {
  vec2 s = sceneUV(vLocal);
  vec3 c = vid(s);
  c = mix(c, vec3(luma(c)), uP_mono);
  for (int i = 0; i < ${MAX}; i++) {
    if (i >= uN) break;
    vec4 r = uRects[i];
    if (vLocal.x > r.x && vLocal.y > r.y && vLocal.x < r.z && vLocal.y < r.w) c = mix(c, 1.0 - c, uP_invert);
  }
  vec4 o = texture(uOver, vLocal);
  fragColor = vec4(c * (1.0 - o.a) + o.rgb, 1.0);
}`;

function drawOverlay(st, tracks, bp) {
  const g = st.g, w = st.canvas.width, h = st.canvas.height, font = Math.max(10, Math.round(h / 46));
  g.clearRect(0, 0, w, h);
  g.strokeStyle = g.fillStyle = '#fff'; g.font = `${font}px ui-monospace, Consolas, monospace`; g.textBaseline = 'bottom';
  const live = tracks.filter(t => t.age >= 2).sort((a, b) => a.id - b.id);
  if (bp.links > 0.01 && live.length > 1) {
    g.globalAlpha = 0.55 * bp.links; g.lineWidth = 1; g.beginPath();
    live.forEach((t, i) => { const x = t.cx * w, y = (1 - t.cy) * h; i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
  }
  g.globalAlpha = 1; g.lineWidth = Math.max(1, h / 480);
  for (const t of live) {
    const x = t.x0 * w, y = (1 - t.y1) * h, bw = (t.x1 - t.x0) * w, bh = (t.y1 - t.y0) * h;
    g.strokeRect(x, y, bw, bh);
    g.fillRect(t.cx * w - 1.5, (1 - t.cy) * h - 1.5, 3, 3);
    if (bp.labels > 0.5) g.fillText(`${String(t.id).padStart(3, '0')}  ${t.cx.toFixed(2)} ${t.cy.toFixed(2)}`, x, y - 2);
  }
  st.rects.fill(0); st.n = Math.min(live.length, MAX);
  for (let i = 0; i < st.n; i++) { const t = live[i]; st.rects.set([t.x0, t.y0, t.x1, t.y1], i * 4); }
}

export default defineEffect({
  name: 'Blob tracking',
  cost: 1.2,
  params: {
    source: P(0, 2, 0, 1, 'source: motion / bright / dark'),
    threshold: P(0.02, 0.95, 0.16, 0.01, 'threshold'),
    size: P(4, 200, 14, 1, 'smallest blob (cells)'),
    links: P(0, 1, 0.8, 0.01, 'connecting lines'),
    labels: P(0, 1, 1, 1, 'labels'),
    invert: P(0, 1, 0, 0.01, 'invert inside blobs'),
    mono: P(0, 1, 0.75, 0.01, 'desaturate'),
  },
  presets: [
    { name: 'Motion tags', values: {} },
    { name: 'Inverted patches', values: { invert: 1, mono: 1, links: 0.4, size: 24 } },
    { name: 'Highlight hunter', values: { source: 1, threshold: 0.8, size: 8, mono: 1, links: 1 } },
  ],
  init() {},
  create(ctx, box) {
    const gl = ctx.gl, aw = 160, ah = Math.max(16, Math.min(160, Math.round(aw * box.rect.h * ctx.sceneH / Math.max(1, box.rect.w * ctx.sceneW))));
    const canvas = new OffscreenCanvas(box.rt.w, box.rt.h), tex = gl.createTexture(), pbo = gl.createBuffer();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo); gl.bufferData(gl.PIXEL_PACK_BUFFER, aw * ah * 4, gl.STREAM_READ); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    box.state = { an: ctx.rt(aw, ah, { format: 'rgba8' }), aw, ah, px: new Uint8Array(aw * ah * 4), pbo, sync: null, canvas, g: canvas.getContext('2d'), tex,
      rects: new Float32Array(MAX * 4), n: 0, tracker: box.state?.tracker || new BlobTracker() };
  },
  destroy(ctx, box) {
    const s = box.state, gl = ctx.gl;
    if (s) { ctx.freeRT(s.an); gl.deleteBuffer(s.pbo); gl.deleteTexture(s.tex); if (s.sync) gl.deleteSync(s.sync); box.state = null; }
  },
  render(ctx, box, t) {
    const gl = ctx.gl, st = box.state, bp = box.params;
    if (ctx.newFrame && !st.sync) {
      ctx.bind(st.an);
      const pa = ctx.prog('blob-analyze', ANALYZE); ctx.common(pa, box, t); ctx.histUniforms(pa); ctx.draw();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, st.pbo);
      gl.readPixels(0, 0, st.aw, st.ah, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      st.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
    }
    if (st.sync) {
      const r = gl.clientWaitSync(st.sync, 0, 0);
      if (r === gl.ALREADY_SIGNALED || r === gl.CONDITION_SATISFIED) {
        gl.deleteSync(st.sync); st.sync = null;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, st.pbo); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, st.px); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        drawOverlay(st, st.tracker.update(findBlobs(st.px, st.aw, st.ah, { minArea: bp.size, maxBlobs: MAX })), bp);
        gl.bindTexture(gl.TEXTURE_2D, st.tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, st.canvas);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      }
    }
    ctx.bind(box.rt);
    const p = ctx.prog('blob', FRAG); ctx.common(p, box, t);
    p.tex(5, st.tex, 'uOver'); p.i('uN', st.n);
    gl.uniform4fv(p.loc('uRects'), st.rects);
    ctx.draw();
  },
});
