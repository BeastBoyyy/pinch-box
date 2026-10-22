// WebGL2 renderer: linear-light half-float scene, shared camera texture + 96-frame history ring,
// backdrop copies for stacking, SDF-masked box compositing with lock flourish, overlays, sRGB+dither blit.
// The render loop allocates nothing: all buffers/targets are created up front or on resize/lock.
import { Program, VERT, COMMON, createRT, freeRT } from './gl.js';

export const HIST_LAYERS = 96;
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

const FRAG_COPY = `#version 300 es
precision highp float; in vec2 vLocal; out vec4 o; uniform sampler2D uSrc; uniform float uMirror;
void main() { vec2 uv = vec2(mix(vLocal.x, 1.0 - vLocal.x, uMirror), vLocal.y); o = vec4(texture(uSrc, uv).rgb, 1.0); }`;

// box RT -> scene, with rounded-rect SDF mask, soft shadow, inner highlight and the lock flourish. Premultiplied output.
const FRAG_COMPOSITE = `#version 300 es
precision highp float; in vec2 vLocal; out vec4 o;
uniform sampler2D uBox; uniform vec4 uRect; uniform vec2 uSceneSize;
uniform float uLock, uFade, uRadius, uSettle, uShadow;
float sdRound(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 size = uRect.zw * uSceneSize;
  vec2 c = (uRect.xy + 0.5 * uRect.zw) * uSceneSize;
  vec2 q = p - c;
  vec2 hs = 0.5 * size * uSettle;
  float r = min(uRadius, min(hs.x, hs.y));
  float d = sdRound(q, hs, r);
  float cov = clamp(0.5 - d, 0.0, 1.0);
  vec3 col = texture(uBox, 0.5 + q / (size * uSettle)).rgb;
  // inner highlight hairline
  col += vec3(0.16) * (1.0 - smoothstep(0.0, 1.6, -d)) * step(d, 0.0);
  // lock flourish: border flash + sweep along the edge
  float k = 1.0 - uLock;
  float edge = exp(-pow(d / 4.5, 2.0));
  float ang = atan(q.y / hs.y, q.x / hs.x) / 6.2831853 + 0.5;
  float band = smoothstep(0.16, 0.0, abs(fract(ang - fract(uLock * 1.3) + 0.5) - 0.5));
  col += vec3(1.0) * edge * (pow(k, 1.3) * 1.6 + band * k * 3.0);
  col *= 1.0 + 0.22 * k * k * step(d, 0.0);                  // brief interior flash
  float a = cov * uFade;
  // soft outer shadow (premultiplied black underneath)
  float sh = uShadow * 0.30 * (1.0 - smoothstep(0.0, 22.0, d)) * step(0.0, d) * uFade;
  o = vec4(col * a, a + sh * (1.0 - a));
}`;

const FRAG_OUTLINE = `#version 300 es
precision highp float; in vec2 vLocal; out vec4 o;
uniform vec4 uRect; uniform vec2 uSceneSize; uniform float uAlpha, uPulse, uWidth;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 hs = 0.5 * uRect.zw * uSceneSize, c = (uRect.xy + 0.5 * uRect.zw) * uSceneSize;
  vec2 q = abs(p - c) - hs;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  float line = 1.0 - smoothstep(uWidth * 0.5 - 0.5, uWidth * 0.5 + 0.7, abs(d));
  float glow = exp(-pow(d / 9.0, 2.0)) * 0.10 * uPulse;
  // corner ticks
  vec2 cq = abs(abs(p - c) - hs);
  float tick = (1.0 - smoothstep(2.0, 3.2, max(cq.x, cq.y))) * 0.9;
  float a = clamp((line + glow + tick) * uAlpha, 0.0, 1.0);
  o = vec4(vec3(1.0) * a, a);
}`;

const FRAG_FINAL = `#version 300 es
precision highp float; in vec2 vLocal; out vec4 o; uniform sampler2D uScene; uniform float uFrame; uniform float uExposure;
vec3 toSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec3 c = toSrgb(texture(uScene, vLocal).rgb * uExposure);
  vec2 p = gl_FragCoord.xy;
  float n = ign(p + uFrame * 5.588238) + ign(p.yx + 17.0 + uFrame * 3.1) - 1.0; // triangular-PDF dither, +-1 LSB
  o = vec4(c + n / 255.0, 1.0);
}`;

// history frames are stored sRGB-ENCODED in plain RGBA8 and decoded in hist(): no reliance on sRGB framebuffer copy semantics
const FRAG_HIST = `#version 300 es
precision highp float; in vec2 vLocal; out vec4 o; uniform sampler2D uVideo;
vec3 enc(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() { o = vec4(enc(texture(uVideo, vLocal).rgb), 1.0); }`;

const VERT_PTS = `#version 300 es
precision highp float; in vec2 aPos; uniform float uSize;
void main() { gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0); gl_PointSize = uSize; }`;
const FRAG_FLAT = `#version 300 es
precision highp float; out vec4 o; uniform vec4 uColor; uniform float uShape;   // 0 square, 1 disc, 2 ring
void main() {
  float a = uColor.a;
  if (uShape > 0.5) {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    if (r > 1.0) discard;
    a *= uShape < 1.5 ? smoothstep(1.0, 0.85, r) : smoothstep(1.0, 0.88, r) * smoothstep(0.66, 0.78, r);
  }
  o = vec4(uColor.rgb * a, a);
}`;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = this.gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.notices = [];
    this.caps = { floatRT: !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float') };
    gl.__floatRT = this.caps.floatRT;
    if (!this.caps.floatRT) this.notices.push('Half-float render targets unavailable: using RGBA8 (some effects will band).');
    gl.getExtension('OES_texture_float_linear');
    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.timerPool = []; this.timerActive = null; this.gpuMs = 0;
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    this.programs = new Map();
    this.sceneW = 0; this.sceneH = 0; this.videoW = 0; this.videoH = 0;
    this.scene = null; this.backdrop = null; this.hist = null;
    this.tex = { video: null, history: null, backdrop: null, depth: null, noise: null };
    this.histHead = 0; this.histCount = 0; this.histSize = [2, 2];
    this.newFrame = false; this.frameId = 0; this.time = 0; this.dt = 0.016; this.passLevel = 1;
    this.depth = null;                    // DepthProvider, set by the app
    this.hand = { x: 0, y: 0 };          // head/hand parallax input for the point cloud (-1..1)
    this.settings = { cornerRadius: 3, shadow: 1, exposure: 1, skeleton: false, debug: false };
    this.stats = { renderFps: 0, frameMs: 0, gpuMs: 0 };
    this._fpsN = 0; this._fpsT = 0;
    this.pendingVideo = false;
    // overlay geometry: preallocated so the loop never allocates
    this.lineBuf = new Float32Array(4 * 21 * 2 * 4); this.pointBuf = new Float32Array(2 * 21 * 4);
    this.lineVBO = gl.createBuffer(); this.pointVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVBO); gl.bufferData(gl.ARRAY_BUFFER, this.lineBuf.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointVBO); gl.bufferData(gl.ARRAY_BUFFER, this.pointBuf.byteLength, gl.DYNAMIC_DRAW);
    this.pCopy = new Program(gl, FRAG_COPY, VERT, 'copy');
    this.pComposite = new Program(gl, FRAG_COMPOSITE, VERT, 'composite');
    this.pOutline = new Program(gl, FRAG_OUTLINE, VERT, 'outline');
    this.pFinal = new Program(gl, FRAG_FINAL, VERT, 'final');
    this.pHist = new Program(gl, FRAG_HIST, VERT, 'hist');
    this.pFlat = new Program(gl, FRAG_FLAT, VERT_PTS, 'flat');
    this.flatLoc = gl.getAttribLocation(this.pFlat.p, 'aPos');
    this._makeNoise();
  }

  // ---- context API used by effects -------------------------------------------------------------
  /** compile (once) a fragment shader body; COMMON is prepended */
  prog(key, body) { let p = this.programs.get(key); if (!p) { p = new Program(this.gl, COMMON + body, VERT, key); this.programs.set(key, p); } return p; }
  /** compile a standalone fragment shader (full source, own #version) */
  progRaw(key, src, vert = VERT) { let p = this.programs.get(key); if (!p) { p = new Program(this.gl, src, vert, key); this.programs.set(key, p); } return p; }
  rt(w, h, o) { return createRT(this.gl, w, h, o); }
  freeRT(rt) { freeRT(this.gl, rt); }
  bind(rt) { const gl = this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo); gl.viewport(0, 0, rt.w, rt.h); }
  draw() { this.gl.drawArrays(this.gl.TRIANGLES, 0, 3); }
  /** uniforms every effect shader shares + the box's params */
  common(p, box, t) {
    const gl = this.gl;
    p.use();
    p.tex(0, this.tex.video, 'uVideo');
    p.f4('uRect', box.rect.x, box.rect.y, box.rect.w, box.rect.h);
    p.f2('uRectPx', box.rect.w * this.sceneW, box.rect.h * this.sceneH);
    p.f2('uSceneSize', this.sceneW, this.sceneH);
    p.f('uTime', t); p.f('uScale', box.scale); p.f('uPass', this.passLevel);
    const ks = box.effect.paramKeys, un = box.effect.uNames;
    for (let i = 0; i < ks.length; i++) p.f(un[i], box.params[ks[i]]);
    gl.disable(gl.BLEND);
  }
  /** history ring uniforms (unit 1 holds the TEXTURE_2D_ARRAY) */
  histUniforms(p) {
    p.tex(1, this.tex.history, 'uHist', this.gl.TEXTURE_2D_ARRAY);
    p.f('uHistHead', this.histHead); p.f('uHistCount', this.histCount);
  }
  /** shared smoothed depth (unit 3) + its size; call after ctx.common() */
  depthUniforms(p) { p.tex(3, this.tex.depth, 'uDepth'); p.f2('uDepthSize', this.depth.size[0], this.depth.size[1]); }
  boxSize(box) { return [Math.max(8, Math.round(box.rect.w * this.sceneW * box.scale)), Math.max(8, Math.round(box.rect.h * this.sceneH * box.scale))]; }

  // ---- setup ----------------------------------------------------------------------------------
  _makeNoise() {
    const gl = this.gl, n = 256, d = new Uint8Array(n * n * 4);
    let s = 1234567; for (let i = 0; i < d.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; d[i] = s >>> 24; }
    const t = this.tex.noise = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, d);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  }

  /** (re)size to the video's aspect, letterboxed inside the window; scene targets match the drawing buffer */
  resize(videoW, videoH, cssW, cssH, dpr = 1) {
    const gl = this.gl;
    if (videoW && videoH && (videoW !== this.videoW || videoH !== this.videoH)) this._allocVideo(videoW, videoH);
    const aspect = (this.videoW || 16) / (this.videoH || 9);
    let w = cssW, h = cssW / aspect; if (h > cssH) { h = cssH; w = cssH * aspect; }
    this.canvas.style.width = Math.round(w) + 'px'; this.canvas.style.height = Math.round(h) + 'px';
    let bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    const cap = 2048; if (bw > cap) { bh = Math.round(bh * cap / bw); bw = cap; }
    if (bw === this.sceneW && bh === this.sceneH) return false;
    this.canvas.width = bw; this.canvas.height = bh;
    this.sceneW = bw; this.sceneH = bh;
    freeRT(gl, this.scene); freeRT(gl, this.backdrop);
    this.scene = createRT(gl, bw, bh, { format: 'rgba16f' });
    this.backdrop = createRT(gl, bw, bh, { format: 'rgba16f' });
    this.tex.backdrop = this.backdrop.tex;
    return true; // caller must resize box targets
  }

  _allocVideo(w, h) {
    const gl = this.gl;
    this.videoW = w; this.videoH = h;
    if (this.tex.video) gl.deleteTexture(this.tex.video);
    const t = this.tex.video = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(w, h))) + 1, gl.SRGB8_ALPHA8, w, h); // mipmapped: low LODs feed blur-ish lookups
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // history ring: half resolution, 96 layers, RGBA8 holding sRGB-encoded colour (88 MB at 640x360)
    const hw = Math.max(2, Math.round(w / 2)), hh = Math.max(2, Math.round(h / 2));
    this.histSize = [hw, hh];
    if (this.tex.history) gl.deleteTexture(this.tex.history);
    const hx = this.tex.history = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, hx);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, hw, hh, HIST_LAYERS);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    freeRT(gl, this.hist);
    this.hist = createRT(gl, hw, hh, { format: 'rgba8' });
    this.histHead = 0; this.histCount = 0;
  }

  onCameraFrame() { this.pendingVideo = true; }

  _uploadVideo(video) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex.video);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    // downscale into the history ring (written once per camera frame)
    this.bind(this.hist); gl.disable(gl.BLEND);
    this.pHist.use().tex(0, this.tex.video, 'uVideo'); this.draw();
    this.histHead = (this.histHead + 1) % HIST_LAYERS;
    this.histCount = Math.min(HIST_LAYERS, this.histCount + 1);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.hist.fbo);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex.history);
    gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, this.histHead, 0, 0, this.histSize[0], this.histSize[1]);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    this.newFrame = true;
  }

  // ---- per-frame ------------------------------------------------------------------------------
  /** copy the box's region of the accumulated scene into the backdrop texture (for glass / stacking-aware effects) */
  _copyBackdrop(box) {
    const gl = this.gl;
    const x0 = Math.max(0, Math.floor(box.rect.x * this.sceneW)), y0 = Math.max(0, Math.floor(box.rect.y * this.sceneH));
    const x1 = Math.min(this.sceneW, Math.ceil((box.rect.x + box.rect.w) * this.sceneW)), y1 = Math.min(this.sceneH, Math.ceil((box.rect.y + box.rect.h) * this.sceneH));
    if (x1 <= x0 || y1 <= y0) return;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.scene.fbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.backdrop.fbo);
    gl.blitFramebuffer(x0, y0, x1, y1, x0, y0, x1, y1, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  _composite(box, nowMs) {
    const gl = this.gl, r = box.rect;
    const lock = Math.min(1, (nowMs - box.lockedAt) / 320), e = 1 - Math.pow(1 - Math.min(1, lock * 1.4), 3);
    const settle = 1 + 0.035 * (1 - e) * (1 - e);
    const margin = 28 + 0.04 * Math.max(r.w * this.sceneW, r.h * this.sceneH);
    const x0 = Math.floor(r.x * this.sceneW - margin), y0 = Math.floor(r.y * this.sceneH - margin);
    const w = Math.ceil(r.w * this.sceneW + 2 * margin), h = Math.ceil(r.h * this.sceneH + 2 * margin);
    this.bind(this.scene);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(x0, y0, w, h);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const p = this.pComposite.use();
    p.tex(0, box.rt.tex, 'uBox');
    p.f4('uRect', r.x, r.y, r.w, r.h); p.f2('uSceneSize', this.sceneW, this.sceneH);
    p.f('uLock', lock); p.f('uFade', box.fade); p.f('uRadius', this.settings.cornerRadius); p.f('uSettle', settle); p.f('uShadow', this.settings.shadow);
    this.draw();
    gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND);
  }

  _drawOutline(live) {
    const gl = this.gl;
    const x = live.x0 / this.videoW, w = (live.x1 - live.x0) / this.videoW, h = (live.y1 - live.y0) / this.videoH, y = 1 - live.y1 / this.videoH;
    const margin = 40;
    this.bind(this.scene);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(Math.floor(x * this.sceneW - margin), Math.floor(y * this.sceneH - margin), Math.ceil(w * this.sceneW + 2 * margin), Math.ceil(h * this.sceneH + 2 * margin));
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const p = this.pOutline.use();
    p.f4('uRect', x, y, w, h); p.f2('uSceneSize', this.sceneW, this.sceneH);
    p.f('uAlpha', live.formed ? 0.95 : 0.35); p.f('uPulse', live.pulse); p.f('uWidth', 1.6 * Math.max(1, this.sceneW / 1280));
    this.draw();
    gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND);
  }

  _drawHands(hands) {
    const gl = this.gl, W = this.videoW, H = this.videoH;
    let nl = 0, np = 0;
    const L = this.lineBuf, P = this.pointBuf;
    for (let k = 0; k < hands.count; k++) {
      const lm = hands.lm[k];
      for (let b = 0; b < BONES.length; b++) {
        const a = BONES[b][0], c = BONES[b][1];
        L[nl++] = lm[a * 3] / W; L[nl++] = 1 - lm[a * 3 + 1] / H; L[nl++] = lm[c * 3] / W; L[nl++] = 1 - lm[c * 3 + 1] / H;
      }
      for (let i = 0; i < 21; i++) { P[np++] = lm[i * 3] / W; P[np++] = 1 - lm[i * 3 + 1] / H; }
    }
    if (!nl) return;
    this.bind(this.scene); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const p = this.pFlat.use();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVBO); gl.bufferSubData(gl.ARRAY_BUFFER, 0, L, 0, nl);
    gl.enableVertexAttribArray(this.flatLoc); gl.vertexAttribPointer(this.flatLoc, 2, gl.FLOAT, false, 0, 0);
    p.f('uSize', 1); p.f4('uColor', 0.35, 1.0, 0.8, 0.8); gl.drawArrays(gl.LINES, 0, nl / 2);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointVBO); gl.bufferSubData(gl.ARRAY_BUFFER, 0, P, 0, np);
    gl.vertexAttribPointer(this.flatLoc, 2, gl.FLOAT, false, 0, 0);
    p.f('uSize', 5); p.f4('uColor', 1.0, 1.0, 1.0, 0.9); gl.drawArrays(gl.POINTS, 0, np / 2);
    if (hands.rawCount) { // debug: raw (pre-filter) landmarks in orange
      np = 0;
      for (let k = 0; k < hands.rawCount; k++) { const lm = hands.raw[k]; for (let i = 0; i < 21; i++) { P[np++] = lm[i * 3] / W; P[np++] = 1 - lm[i * 3 + 1] / H; } }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, P, 0, np);
      p.f('uSize', 3); p.f4('uColor', 1.0, 0.55, 0.1, 0.9); gl.drawArrays(gl.POINTS, 0, np / 2);
    }
    gl.disableVertexAttribArray(this.flatLoc);
    gl.disable(gl.BLEND);
  }

  /**
   * Always-on pinch feedback drawn ABOVE every effect box (effects can hide your own fingers):
   * per hand a ring at the thumb/index midpoint that turns green and fills when the pinch is registered, plus fingertip dots.
   * fb: { count, mx[], my[], tx[], ty[], ix[], iy[] (frame px), close[] 0..1, on[] bool }
   */
  _drawFeedback(fb) {
    const gl = this.gl, W = this.videoW, H = this.videoH, k = Math.max(1, this.sceneW / 1280), P = this.pointBuf;
    this.bind(this.scene); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const p = this.pFlat.use();
    gl.enableVertexAttribArray(this.flatLoc); gl.bindBuffer(gl.ARRAY_BUFFER, this.pointVBO);
    for (let h = 0; h < fb.count; h++) {
      const c = fb.close[h], on = fb.on[h];
      // tips
      P[0] = fb.tx[h] / W; P[1] = 1 - fb.ty[h] / H; P[2] = fb.ix[h] / W; P[3] = 1 - fb.iy[h] / H;
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, P, 0, 4); gl.vertexAttribPointer(this.flatLoc, 2, gl.FLOAT, false, 0, 0);
      p.f('uShape', 1); p.f('uSize', 9 * k); p.f4('uColor', 0.0, 0.0, 0.0, 0.45); gl.drawArrays(gl.POINTS, 0, 2);   // dark halo keeps it visible on white effects
      p.f('uSize', 6 * k); p.f4('uColor', 1, 1, 1, 0.95); gl.drawArrays(gl.POINTS, 0, 2);
      // pinch ring at the midpoint
      P[0] = fb.mx[h] / W; P[1] = 1 - fb.my[h] / H;
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, P, 0, 2); gl.vertexAttribPointer(this.flatLoc, 2, gl.FLOAT, false, 0, 0);
      const r = on ? 0.25 : 1 - 0.75 * c * 0.6, g = on ? 1.0 : 1 - 0.1 * c, b = on ? 0.55 : 1 - 0.7 * c * 0.6;
      p.f('uShape', 2); p.f('uSize', (44 - 22 * c) * k); p.f4('uColor', 0, 0, 0, 0.35); gl.drawArrays(gl.POINTS, 0, 1);
      p.f('uSize', (40 - 22 * c) * k); p.f4('uColor', r, g, b, 0.95); gl.drawArrays(gl.POINTS, 0, 1);
      if (on) { p.f('uShape', 1); p.f('uSize', 16 * k); p.f4('uColor', 0.25, 1.0, 0.55, 0.9); gl.drawArrays(gl.POINTS, 0, 1); }
    }
    p.f('uShape', 0);
    gl.disableVertexAttribArray(this.flatLoc); gl.disable(gl.BLEND);
  }

  _gpuBegin() {
    const gl = this.gl, ext = this.timerExt; if (!ext) return;
    // harvest finished queries
    while (this.timerPool.length && this.timerPool[0].ready === undefined) {
      const q = this.timerPool[0];
      if (!gl.getQueryParameter(q.q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) { this.gpuMs = gl.getQueryParameter(q.q, gl.QUERY_RESULT) / 1e6; this.gpuSample = true; }
      gl.deleteQuery(q.q); this.timerPool.shift();
    }
    if (this.timerPool.length < 4) { const q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); this.timerActive = { q }; }
  }
  _gpuEnd() { const gl = this.gl; if (this.timerActive) { gl.endQuery(this.timerExt.TIME_ELAPSED_EXT); this.timerPool.push(this.timerActive); this.timerActive = null; } }

  /**
   * view: { video, boxes:[box], live:{formed,held,x0..y1,pulse,visible}, hands:{count,lm[],rawCount,raw[]}|null, nowMs, effects hook }
   * box: { effect, params, rect:{x,y,w,h} (scene uv), scale, rt, lockedAt, fade }
   */
  frame(view, dt, t) {
    const gl = this.gl;
    this.dt = dt; this.time = t; this.frameId++;
    this.newFrame = false;
    if (this.pendingVideo && view.video && view.video.readyState >= 2) { this.pendingVideo = false; this._uploadVideo(view.video); }
    if (!this.tex.video || !this.scene) return;
    this._gpuBegin();
    if (view.needsDepth && this.depth) this.depth.update(this, dt, this.newFrame);
    // fixed texture units for every effect: 0 video, 1 history array, 2 backdrop, 3 depth, 4 noise
    gl.activeTexture(gl.TEXTURE0 + 2); gl.bindTexture(gl.TEXTURE_2D, this.tex.backdrop);
    if (this.tex.depth) { gl.activeTexture(gl.TEXTURE0 + 3); gl.bindTexture(gl.TEXTURE_2D, this.tex.depth); }
    gl.activeTexture(gl.TEXTURE0 + 4); gl.bindTexture(gl.TEXTURE_2D, this.tex.noise);
    // 1. camera frame fills the scene (mirrored)
    this.bind(this.scene); gl.disable(gl.BLEND);
    this.pCopy.use().tex(0, this.tex.video, 'uSrc'); this.pCopy.f('uMirror', 1); this.draw();
    // 2. locked boxes, in order, each compositing onto everything beneath it
    const boxes = view.boxes;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!b.rt) continue;
      if (b.effect.needsBackdrop) this._copyBackdrop(b);
      this.bind(b.rt);
      b.effect.render(this, b, t);
      this._composite(b, view.nowMs);
    }
    // 3. live outline, 4. skeleton overlay
    if (view.live && view.live.visible) this._drawOutline(view.live);
    if (view.hands && view.hands.count) this._drawHands(view.hands);
    if (view.feedback && view.feedback.count) this._drawFeedback(view.feedback);
    // 5. sRGB + dither to the canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.sceneW, this.sceneH); gl.disable(gl.BLEND);
    const p = this.pFinal.use(); p.tex(0, this.scene.tex, 'uScene'); p.f('uFrame', this.frameId & 1023); p.f('uExposure', this.settings.exposure);
    this.draw();
    this._gpuEnd();
    // fps bookkeeping (plain numbers, no allocation)
    this._fpsN++; this._fpsT += dt;
    if (this._fpsT >= 0.5) { this.stats.renderFps = this._fpsN / this._fpsT; this._fpsN = 0; this._fpsT = 0; }
    this.stats.gpuMs = this.gpuMs;
  }
}
