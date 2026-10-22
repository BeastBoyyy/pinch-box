// Small WebGL2 helpers: programs with cached uniform locations, render targets, shared GLSL.
export const VERT = `#version 300 es
precision highp float;
out vec2 vLocal;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vLocal = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Prepended to every effect fragment shader. Scene uv is GL oriented (origin bottom-left); the camera is mirrored in vid(). */
export const COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
in vec2 vLocal;
out vec4 fragColor;
uniform sampler2D uVideo;      // linear-light camera frame (sRGB8 texture, hardware decoded), UNMIRRORED
uniform vec4 uRect;            // box rect in scene uv (x, y, w, h)
uniform vec2 uRectPx;          // box size in scene pixels at full quality
uniform vec2 uSceneSize;       // scene size in pixels
uniform float uTime;
uniform float uScale;          // quality scale of this box's render target
uniform float uPass;           // governor pass level 0..1
vec2 sceneUV(vec2 l) { return uRect.xy + l * uRect.zw; }
vec3 vid(vec2 s) { return texture(uVideo, vec2(1.0 - s.x, s.y)).rgb; }
vec3 vidLod(vec2 s, float l) { return textureLod(uVideo, vec2(1.0 - s.x, s.y), l).rgb; }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 linearToSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
`;

export class Program {
  constructor(gl, frag, vert = VERT, name = '') {
    this.gl = gl; this.name = name; this.locs = new Map();
    const mk = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s) || '';
        throw new Error(`shader "${name}" compile failed:
${log}`);
      }
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vert)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program "${name}" link failed: ${gl.getProgramInfoLog(p)}`);
    this.p = p;
  }
  use() { this.gl.useProgram(this.p); return this; }
  loc(n) { let l = this.locs.get(n); if (l === undefined) { l = this.gl.getUniformLocation(this.p, n); this.locs.set(n, l); } return l; }
  f(n, v) { const l = this.loc(n); if (l) this.gl.uniform1f(l, v); }
  f2(n, a, b) { const l = this.loc(n); if (l) this.gl.uniform2f(l, a, b); }
  f3(n, a, b, c) { const l = this.loc(n); if (l) this.gl.uniform3f(l, a, b, c); }
  f4(n, a, b, c, d) { const l = this.loc(n); if (l) this.gl.uniform4f(l, a, b, c, d); }
  i(n, v) { const l = this.loc(n); if (l) this.gl.uniform1i(l, v); }
  m4(n, m) { const l = this.loc(n); if (l) this.gl.uniformMatrix4fv(l, false, m); }
  /** bind `texture` to `unit` and point sampler `name` at it */
  tex(unit, texture, name, target = this.gl.TEXTURE_2D) {
    const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(target, texture); this.i(name, unit);
  }
}

const FORMATS = (gl) => ({
  rgba16f: { ifmt: gl.RGBA16F, fmt: gl.RGBA, type: gl.HALF_FLOAT, fb: 'rgba8' },
  rgba8: { ifmt: gl.RGBA8, fmt: gl.RGBA, type: gl.UNSIGNED_BYTE },
  srgb8: { ifmt: gl.SRGB8_ALPHA8, fmt: gl.RGBA, type: gl.UNSIGNED_BYTE },
  r16f: { ifmt: gl.R16F, fmt: gl.RED, type: gl.HALF_FLOAT, fb: 'rgba8' },
  rg16f: { ifmt: gl.RG16F, fmt: gl.RG, type: gl.HALF_FLOAT, fb: 'rgba8' },
  r8: { ifmt: gl.R8, fmt: gl.RED, type: gl.UNSIGNED_BYTE },
});

/** Render target with an FBO. Falls back to RGBA8 if the float format is not renderable. */
export function createRT(gl, w, h, { format = 'rgba16f', filter = 'linear', wrap = 'clamp', mips = false } = {}) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const F = FORMATS(gl);
  let f = F[format];
  if (!gl.__floatRT && f.fb) { format = f.fb; f = F[format]; }
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const levels = mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
  gl.texStorage2D(gl.TEXTURE_2D, levels, f.ifmt, w, h);
  const lin = filter === 'linear';
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_NEAREST : lin ? gl.LINEAR : gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, lin ? gl.LINEAR : gl.NEAREST);
  const W = wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, W); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, W);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE && f.fb) { // last-resort fallback
    gl.deleteFramebuffer(fbo); gl.deleteTexture(tex); gl.__floatRT = false;
    return createRT(gl, w, h, { format: f.fb, filter, wrap, mips });
  }
  return { tex, fbo, w, h, format, levels };
}
export function freeRT(gl, rt) { if (rt) { gl.deleteTexture(rt.tex); gl.deleteFramebuffer(rt.fbo); } }
