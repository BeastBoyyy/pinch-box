// Shared person mask for the thermal and other-world effects. Raw masks from seg.worker.js are smoothed in time (edges stop shimmering)
// into a mipmapped texture, so consumers can read a sharp edge at LOD 0 and a soft, body-shaped height field at higher LODs.
const SMOOTH = `#version 300 es
precision highp float; in vec2 vLocal; out vec4 o;
uniform sampler2D uRaw, uPrev; uniform float uK;
void main() { o = vec4(mix(texture(uPrev, vLocal).r, texture(uRaw, vLocal).r, uK)); }`;

export class SegProvider {
  constructor(r) { this.r = r; this.raw = null; this.w = 0; this.h = 0; this.sm = [null, null]; this.cur = 0; this.first = true; this.size = [1, 1]; }
  /** data: Uint8Array(w*h), row 0 = top, 255 = person */
  setMask(data, w, h) {
    const r = this.r, gl = r.gl;
    if (!this.raw || w !== this.w || h !== this.h) {
      if (this.raw) { gl.deleteTexture(this.raw); r.freeRT(this.sm[0]); r.freeRT(this.sm[1]); }
      this.raw = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.raw);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.sm = [r.rt(w, h, { format: 'r8', mips: true }), r.rt(w, h, { format: 'r8', mips: true })];
      gl.bindTexture(gl.TEXTURE_2D, this.sm[1].tex); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, this.sm[0].tex); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      this.w = w; this.h = h; this.size = [w, h]; this.first = true;
    }
    gl.activeTexture(gl.TEXTURE0 + 5); gl.bindTexture(gl.TEXTURE_2D, this.raw);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, data);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    const next = 1 - this.cur;
    r.bind(this.sm[next]); gl.disable(gl.BLEND);
    const p = r.progRaw('seg-smooth', SMOOTH).use();
    p.tex(5, this.raw, 'uRaw'); p.tex(6, this.sm[this.cur].tex, 'uPrev'); p.f('uK', this.first ? 1 : 0.65);
    r.draw();
    gl.bindTexture(gl.TEXTURE_2D, this.sm[next].tex); gl.generateMipmap(gl.TEXTURE_2D);
    this.cur = next; this.first = false;
    r.tex.seg = this.sm[next].tex;
  }
}
