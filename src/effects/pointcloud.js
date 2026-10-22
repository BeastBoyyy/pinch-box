// 9. Point cloud: the depth image unprojected to a 3D point grid, drawn as instanced round additive points from a gently
// orbiting camera (+-12 deg) with parallax from the user's hands/head. Black background, faint ground grid, <= 200k points.
import { defineEffect, P } from './util.js';

const VS = `#version 300 es
precision highp float;
uniform sampler2D uVideo, uDepth;
uniform vec4 uRect; uniform vec2 uGrid, uRectPx;
uniform mat4 uVP;
uniform float uPointSize, uDepthScale, uColor;
out vec3 vCol; out float vFade;
void main() {
  int gw = int(uGrid.x);
  vec2 local = (vec2(float(gl_InstanceID % gw), float(gl_InstanceID / gw)) + 0.5) / uGrid;
  vec2 mu = vec2(1.0 - (uRect.x + local.x * uRect.z), uRect.y + local.y * uRect.w);
  float d = textureLod(uDepth, mu, 0.0).r;
  vec3 vc = textureLod(uVideo, mu, 1.0).rgb;
  float L = dot(vc, vec3(0.2126, 0.7152, 0.0722));
  vec3 pos = vec3((local.x - 0.5) * (uRectPx.x / uRectPx.y), local.y - 0.5, (d - 0.45) * uDepthScale);
  vec4 cp = uVP * vec4(pos, 1.0);
  gl_Position = cp;
  gl_PointSize = max(1.0, uPointSize / cp.w);
  vFade = clamp(0.25 + 1.0 * d, 0.0, 1.0);
  vec3 deep = vec3(0.01, 0.10, 0.34), cy = vec3(0.20, 0.72, 1.0), hi = vec3(0.70, 0.95, 1.0);
  vec3 ramp = mix(deep, mix(cy, hi, smoothstep(0.55, 1.0, d)), smoothstep(0.05, 0.8, d));
  vCol = mix(ramp * (0.75 + 1.0 * pow(L, 0.5)), vc * 1.2, uColor);
}`;
const FS = `#version 300 es
precision highp float;
in vec3 vCol; in float vFade; out vec4 o;
void main() {
  float r = length(gl_PointCoord - 0.5);
  if (r > 0.5) discard;
  float a = (1.0 - smoothstep(0.2, 0.5, r)) * vFade;
  o = vec4(vCol * a, a);
}`;
const GVS = `#version 300 es
precision highp float; in vec3 aPos; uniform mat4 uVP; void main() { gl_Position = uVP * vec4(aPos, 1.0); }`;
const GFS = `#version 300 es
precision highp float; out vec4 o; uniform float uA; void main() { o = vec4(vec3(0.10, 0.45, 0.8) * uA, uA); }`;

// scratch matrices: no allocation in the render loop
const V = new Float32Array(16), Pm = new Float32Array(16), M = new Float32Array(16);
function mul(out, a, b) { // out = a * b (column-major)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
}
function viewMatrix(out, yaw, pitch, dist) { // translate(0,0,-dist) * Rx(pitch) * Ry(yaw)
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cx = Math.cos(pitch), sx = Math.sin(pitch);
  out.fill(0);
  out[0] = cy; out[2] = -sy; out[4] = sx * sy; out[5] = cx; out[6] = sx * cy; out[8] = cx * sy; out[9] = -sx; out[10] = cx * cy;
  out[14] = -dist; out[15] = 1;
}
function persp(out, fovy, aspect, n, f) {
  const t = 1 / Math.tan(fovy / 2);
  out.fill(0); out[0] = t / aspect; out[5] = t; out[10] = (f + n) / (n - f); out[11] = -1; out[14] = 2 * f * n / (n - f);
}

export default defineEffect({
  name: 'Point cloud',
  cost: 2.4,
  needsDepth: true,
  params: {
    rows: P(40, 300, 140, 1, 'point rows'),
    size: P(0.5, 4, 1.5, 0.05, 'point size'),
    relief: P(0.2, 1.8, 0.7, 0.02, 'depth relief'),
    orbit: P(0, 1.5, 1.0, 0.05, 'orbit amount'),
    parallax: P(0, 2, 1.0, 0.05, 'hand parallax'),
    colour: P(0, 1, 0.12, 0.01, 'video colour'),
    grid: P(0, 1, 0.5, 0.01, 'ground grid'),
  },
  presets: [
    { name: 'Hologram ribbons', values: {} },
    { name: 'Dense dust', values: { rows: 260, size: 1.1, relief: 1.1, colour: 0.35, grid: 0.3 } },
    { name: 'Sparse constellation', values: { rows: 70, size: 3, relief: 1.3, orbit: 1.4, grid: 0.8 } },
  ],
  init() {},
  create(ctx, box) {
    const gl = ctx.gl;
    const lines = [], n = 16, ext = 1.6;
    for (let i = -n; i <= n; i++) {
      const k = (i / n) * ext;
      lines.push(-ext, -0.62, k, ext, -0.62, k, k, -0.62, -ext, k, -0.62, ext);
    }
    const vao = gl.createVertexArray(), vbo = gl.createBuffer();
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lines), gl.STATIC_DRAW);
    const pg = ctx.progRaw('pc-grid', GFS, GVS), loc = gl.getAttribLocation(pg.p, 'aPos');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(ctx.vao);
    box.state = { vao, vbo, nGrid: lines.length / 3 };
  },
  destroy(ctx, box) { const s = box.state; if (s) { ctx.gl.deleteVertexArray(s.vao); ctx.gl.deleteBuffer(s.vbo); box.state = null; } },
  render(ctx, box, t) {
    const gl = ctx.gl, st = box.state, bp = box.params;
    gl.clearColor(0.002, 0.004, 0.012, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const aspect = box.rt.w / box.rt.h;
    const hx = ctx.hand.x * bp.parallax, hy = ctx.hand.y * bp.parallax;
    const lim = 0.21; // 12 degrees
    const yaw = Math.max(-lim, Math.min(lim, bp.orbit * 0.17 * Math.sin(t * 0.35) + hx * 0.10));
    const pitch = Math.max(-lim * 0.7, Math.min(lim * 0.7, bp.orbit * 0.05 * Math.sin(t * 0.27 + 1) + hy * 0.07 + 0.09));
    viewMatrix(V, yaw, pitch, 1.35 + 0.25 * aspect);
    persp(Pm, 0.72, aspect, 0.05, 20);
    mul(M, Pm, V);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    if (bp.grid > 0.01) {
      const pg = ctx.progRaw('pc-grid', GFS, GVS).use();
      pg.m4('uVP', M); pg.f('uA', 0.28 * bp.grid);
      gl.bindVertexArray(st.vao); gl.drawArrays(gl.LINES, 0, st.nGrid); gl.bindVertexArray(ctx.vao);
    }
    const maxPts = 200000 * box.scale * box.scale * (0.5 + 0.5 * ctx.passLevel);
    const gh = Math.max(8, Math.round(bp.rows * Math.sqrt(box.scale)));
    const gw = Math.max(8, Math.min(Math.round(gh * aspect * 7), Math.floor(maxPts / gh)));
    const p = ctx.progRaw('pc-pts', FS, VS).use();
    p.tex(0, ctx.tex.video, 'uVideo'); ctx.depthUniforms(p);
    p.f4('uRect', box.rect.x, box.rect.y, box.rect.w, box.rect.h);
    p.f2('uGrid', gw, gh); p.f2('uRectPx', box.rect.w * ctx.sceneW, box.rect.h * ctx.sceneH);
    p.m4('uVP', M); p.f('uPointSize', bp.size * box.rt.h / 520); p.f('uDepthScale', bp.relief); p.f('uColor', bp.colour);
    gl.drawArraysInstanced(gl.POINTS, 0, 1, gw * gh);
    gl.disable(gl.BLEND);
  },
});
