// Shared relative-depth source for the depth map and point cloud effects (1 = near).
//   model : Depth Anything V2 Small from depth.worker.js (8-15 Hz), then
//   approx: pseudo-depth (luminance + centre prior + hand blobs), clearly labelled in the HUD.
// Either way the raw map is temporally smoothed every DISPLAY frame (EMA in a float texture, motion-aware) so it is
// interpolated up to the refresh rate. Edge-aware upsampling happens in the consumers (DEPTH_GLSL).
import { COMMON } from './gl.js';
import { HIST_GLSL } from './effects/util.js';

const PSEUDO = `#version 300 es
precision highp float; in vec2 vLocal; out vec4 o;
uniform sampler2D uVideo; uniform vec4 uH0, uH1;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main() {
  vec2 s = vec2(1.0 - vLocal.x, vLocal.y);
  float prior = 1.0 - smoothstep(0.0, 0.9, length((s - vec2(0.5, 0.45)) * vec2(1.0, 1.2)));
  vec3 c = textureLod(uVideo, vLocal, 3.0).rgb;
  float L = luma(c), Lb = luma(textureLod(uVideo, vLocal, 7.0).rgb);
  float fg = smoothstep(-0.06, 0.10, Lb - L);                       // darker than its surroundings reads as nearer
  float sat = (max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b));
  float d = 0.36 * prior + 0.34 * fg + 0.22 * smoothstep(0.02, 0.2, sat) + 0.08 * (1.0 - L);
  d += uH0.w * exp(-pow(length(s - uH0.xy) / max(uH0.z, 1e-3), 2.0)) * 0.55;
  d += uH1.w * exp(-pow(length(s - uH1.xy) / max(uH1.z, 1e-3), 2.0)) * 0.55;
  o = vec4(vec3(clamp(d, 0.0, 1.0)), 1.0);
}`;

const SMOOTH = COMMON + HIST_GLSL + `
uniform sampler2D uRaw, uPrevS; uniform float uDt;
void main() {
  vec2 s = vec2(1.0 - vLocal.x, vLocal.y);
  float m = abs(luma(hist(histLayer(0.0), s)) - luma(hist(histLayer(1.0), s)));
  m = clamp(m * 12.0, 0.0, 1.0);                                    // motion-aware: follow fast changes, hold still regions
  float a = 1.0 - exp(-uDt / mix(0.16, 0.03, m));
  fragColor = vec4(mix(texture(uPrevS, vLocal).r, texture(uRaw, vLocal).r, a));
}`;

const W = 320, H = 180;

export class DepthProvider {
  constructor(r) {
    this.r = r; this.mode = 'approx'; this.active = false; this.modelReady = false; this.rawTex = null; this.rawW = 0; this.rawH = 0;
    this.raw = null; this.sm = [null, null]; this.cur = 0; this.first = true; this.lastModel = 0;
    this.blobs = new Float32Array(8);                  // two hand blobs: x, y, radius, strength (mirrored uv, y up)
    this.size = [W, H];
  }
  _ensure() {
    const r = this.r;
    if (this.raw) return;
    this.raw = r.rt(W, H, { format: 'r16f' });
    this.sm = [r.rt(W, H, { format: 'r16f' }), r.rt(W, H, { format: 'r16f' })];
    this.pPseudo = r.progRaw('depth-pseudo', PSEUDO);
    this.pSmooth = r.progRaw('depth-smooth', SMOOTH);
  }
  /** raw model output: Float32Array(w*h), row 0 = top, values 0..1 (1 = near) */
  setModelDepth(data, w, h) {
    const r = this.r, gl = r.gl;
    this._ensure();
    if (!this.rawTex || this.rawW !== w || this.rawH !== h) {
      if (this.rawTex) gl.deleteTexture(this.rawTex);
      this.rawTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.rawTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16F, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.rawW = w; this.rawH = h;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.rawTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.FLOAT, data);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.mode = 'model'; this.lastModel = performance.now();
  }
  update(r, dt, newFrame) {
    const gl = r.gl;
    this._ensure();
    if (this.mode === 'model' && performance.now() - this.lastModel > 2500) this.mode = 'approx'; // worker stalled: fall back
    gl.disable(gl.BLEND);
    if (this.mode === 'approx' && (newFrame || this.first)) {
      r.bind(this.raw);
      const p = this.pPseudo.use(); p.tex(0, r.tex.video, 'uVideo'); p.f4('uH0', this.blobs[0], this.blobs[1], this.blobs[2], this.blobs[3]); p.f4('uH1', this.blobs[4], this.blobs[5], this.blobs[6], this.blobs[7]);
      r.draw();
    }
    const src = this.mode === 'model' && this.rawTex ? this.rawTex : this.raw.tex;
    const next = 1 - this.cur;
    r.bind(this.sm[next]);
    const p = this.pSmooth.use();
    p.tex(5, src, 'uRaw'); p.tex(6, this.sm[this.cur].tex, 'uPrevS'); p.f('uDt', this.first ? 10 : Math.min(dt, 0.1));
    r.histUniforms(p); r.draw();
    this.cur = next; this.first = false;
    r.tex.depth = this.sm[this.cur].tex;
  }
}
