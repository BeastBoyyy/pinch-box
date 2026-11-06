// 9. Renaissance painting, inside the box: you are painted into a real ceiling painting (assets/renaissance). Your face stays sharp and is regraded to oil flesh
// tones, your clothes become billowing satin drapery, the painting's own golden light falls on you and wraps round your edges. Gold leaf drifts over the
// surface, fine craquelure and a carved gilt frame finish it. Strokes come from a light Kuwahara pass, eased over time so wet paint does not shimmer.
import { defineEffect, P, SEG_GLSL } from './util.js';

const PAINT = `
uniform sampler2D uPrev; uniform float uP_brush, uK;
void main() {
  vec2 s = sceneUV(vLocal), e = uP_brush / uSceneSize;
  vec3 best = vec3(0.0); float low = 1e9;
  for (int q = 0; q < 4; q++) {
    vec2 dir = vec2(q == 0 || q == 3 ? 1.0 : -1.0, q < 2 ? 1.0 : -1.0);
    vec3 sum = vec3(0.0), sq = vec3(0.0);
    for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
      vec3 c = linearToSrgb(vid(s + vec2(float(i), float(j)) * e * dir));
      sum += c; sq += c * c;
    }
    vec3 mean = sum / 16.0, v = sq / 16.0 - mean * mean;
    float var = dot(v, vec3(0.3, 0.59, 0.11));
    if (var < low) { low = var; best = mean; }
  }
  fragColor = vec4(mix(texture(uPrev, vLocal).rgb, best, uK), 1.0);
}`;

const FRAG = SEG_GLSL + `
uniform sampler2D uPaint, uScene; uniform vec4 uCrop;
uniform float uP_garment, uP_light, uP_crackle, uP_gold, uP_frame, uP_detail;
float asp;
vec3 scene(vec2 l, float lod) { return textureLod(uScene, uCrop.xy + l * uCrop.zw, lod).rgb; }
float cracks(vec2 p) {                        // distance between the two nearest cells: thin lines where the paint has split
  p += 0.35 * vec2(vnoise(p * 1.7), vnoise(p * 1.7 + 9.0));
  vec2 g = floor(p); float a = 9.0, b = 9.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 o = g + vec2(float(i), float(j)); float d = length(o + hash22(o) - p);
    if (d < a) { b = a; a = d; } else if (d < b) b = d;
  }
  return smoothstep(0.07, 0.0, b - a);
}
// satin: a few big soft folds, the way drapery falls, with a gentle sheen on the crests
float folds(vec2 p) {
  vec2 w = vec2(fbm(p * 0.55 + 3.0), fbm(p * 0.55 + 11.0));
  return 0.5 + 0.32 * sin((p.x * 0.9 + p.y * 0.55 + w.x * 3.2) * 1.9) + 0.18 * sin((p.y * 1.1 - p.x * 0.4 + w.y * 2.6) * 3.1);
}
vec3 satin(vec2 l, vec3 pigment, float L) {
  vec2 p = l * vec2(asp, 1.0) * 2.1; float e = 0.03;
  float h = folds(p);
  vec3 n = normalize(vec3(h - folds(p + vec2(e, 0.0)), h - folds(p + vec2(0.0, e)), e * 2.4));
  vec3 ld = normalize(vec3(-0.5, 0.65, 0.58));
  float dif = max(dot(n, ld), 0.0), spec = pow(max(dot(reflect(-ld, n), vec3(0.0, 0.0, 1.0)), 0.0), 7.0);
  vec3 c = mix(pigment * pigment * 0.42, pigment, smoothstep(0.15, 0.95, dif));
  return c + mix(pigment, vec3(1.0, 0.92, 0.78), 0.5) * spec * 0.38 + pigment * (L - 0.2) * 0.25;
}
// oil flesh: soft contrast, shadows glazed with umber, lights kept to a warm ivory (no camera shine)
vec3 oil(vec3 c) {
  float L = luma(c);
  c = mix(c, vec3(L) * vec3(1.05, 0.95, 0.8), 0.18);
  c = min(c, vec3(0.93, 0.86, 0.74));
  return mix(c * vec3(0.74, 0.56, 0.42), c * vec3(1.05, 0.97, 0.85), smoothstep(0.08, 0.62, L));
}
vec3 goldLeaf(vec2 px, vec3 col) {
  vec2 q = px / 84.0 + vec2(uTime * 0.03, -uTime * 0.07);
  vec2 g = floor(q), f = q - g;
  float on = step(0.82, hash12(g));
  vec2 c = f - 0.5 - (hash22(g) - 0.5) * 0.4;
  float rot = hash12(g + 3.0) * 6.28 + uTime * (hash12(g + 5.0) - 0.5) * 0.9, co = cos(rot), si = sin(rot);
  c = vec2(co * c.x - si * c.y, si * c.x + co * c.y);
  float r = length(c * vec2(1.0, 1.5)), a = atan(c.y, c.x);
  float torn = (0.06 + 0.10 * hash12(g + 1.0)) * (0.55 + 0.9 * vnoise(vec2(a * 2.4 + hash12(g) * 40.0, 2.0)) + 0.35 * vnoise(vec2(a * 8.0, 5.0)));
  float flake = smoothstep(torn + 0.008, torn - 0.004, r);
  float glint = 0.55 + 0.45 * sin(uTime * 1.7 + hash12(g + 7.0) * 6.28 + c.x * 18.0);
  vec3 leaf = mix(vec3(0.60, 0.40, 0.12), vec3(1.0, 0.86, 0.46), glint) * (0.78 + 0.42 * vnoise(c * 70.0));
  return mix(col, leaf, flake * on * uP_gold);
}
vec3 frame(vec2 px, float dist, float w) {
  float u = dist / w, along = min(px.x, uRectPx.x - px.x) < min(px.y, uRectPx.y - px.y) ? px.y : px.x;
  float e = 0.6, du = 0.04;
  // moulding profile: outer roll, hollow, carved leaf band, bead lip
  #define PROFILE(v) (0.55 * smoothstep(0.0, 0.2, v) * smoothstep(0.34, 0.2, v) + 0.28 * smoothstep(0.3, 0.42, v) * smoothstep(0.74, 0.62, v) + 0.38 * smoothstep(0.76, 0.84, v) * smoothstep(1.0, 0.92, v))
  #define CARVE(a, v) (0.16 * smoothstep(0.34, 0.44, v) * smoothstep(0.72, 0.62, v) * (sin(a * 0.095) * 0.7 + 0.5 * sin(a * 0.19 + 1.5 * sin(a * 0.048))))
  #define BEAD(a, v) (0.12 * smoothstep(0.78, 0.84, v) * smoothstep(0.98, 0.92, v) * (0.5 + 0.5 * cos(a * 0.42)))
  float h = PROFILE(u) + CARVE(along, u) + BEAD(along, u);
  float ha = PROFILE(u) + CARVE((along + e), u) + BEAD((along + e), u), hv = PROFILE((u + du)) + CARVE(along, (u + du)) + BEAD(along, (u + du));
  vec3 n = normalize(vec3((h - ha) * 3.5, (h - hv) * 1.6, 0.16));
  float lit = max(dot(n, normalize(vec3(-0.45, 0.55, 0.7))), 0.0);
  vec3 c = mix(vec3(0.16, 0.09, 0.03), vec3(0.86, 0.63, 0.25), smoothstep(0.15, 0.95, lit));
  c += vec3(1.0, 0.9, 0.62) * pow(lit, 12.0) * 0.45;
  return c * (0.84 + 0.3 * fbm(px * 0.09));          // worn gilding, red bole showing through
}
void main() {
  vec2 l = vLocal, s = sceneUV(l), px = l * uRectPx;
  asp = uRectPx.x / uRectPx.y;
  vec3 world = scene(l, 0.0), glow = scene(l, 6.0);
  float m = personEdge(s), soft = segAt(s, 2.5);
  // you, sharp: the real picture with crisp detail, a little of the brushed layer laid over it
  vec3 sharp = linearToSrgb(vid(s)), blur = linearToSrgb(vidLod(s, 2.2));
  vec3 real = sharp + (sharp - blur) * uP_detail;
  vec3 stroke = texture(uPaint, l).rgb;
  vec3 flesh = oil(mix(real, stroke, 0.68));
  float L = luma(blur);
  float skin = smoothstep(0.01, 0.09, blur.r - blur.g) * smoothstep(-0.01, 0.06, blur.g - blur.b) * smoothstep(0.12, 0.3, blur.r);
  vec3 below = linearToSrgb(vidLod(s - vec2(0.0, 0.09), 3.5));
  float hair = smoothstep(0.38, 0.2, L) * smoothstep(0.02, 0.07, below.r - below.b) * (1.0 - skin);
  vec3 pigment = uP_garment < 0.5 ? vec3(0.66, 0.07, 0.07) : uP_garment < 1.5 ? vec3(0.09, 0.22, 0.66) : vec3(0.82, 0.58, 0.14);
  vec3 sitter = mix(satin(l, pigment, L), flesh, skin);
  sitter = mix(sitter, oil(real) * 0.9, hair);
  // the painting's own light falls on you from the upper left and wraps round your silhouette
  vec2 e = 7.0 / uSegSize;
  vec2 g = vec2(segAt(s + vec2(e.x, 0.0), 3.0) - segAt(s - vec2(e.x, 0.0), 3.0), segAt(s + vec2(0.0, e.y), 3.0) - segAt(s - vec2(0.0, e.y), 3.0));
  vec3 n = normalize(vec3(-g * 2.4, 1.0));
  float dif = max(dot(n, normalize(vec3(-0.55, 0.5, 0.65))), 0.0), rim = pow(1.0 - n.z, 2.0);
  vec3 tint = mix(vec3(1.0), glow / max(luma(glow), 0.05), 0.35);
  sitter *= tint * mix(1.0, 0.5 + 0.8 * dif, uP_light);
  sitter += glow * vec3(1.0, 0.86, 0.6) * rim * uP_light * 0.4;
  sitter += world * m * (1.0 - soft) * 0.45;
  world *= 1.0 - 0.3 * segAt(s + vec2(-0.012, 0.02), 3.5) * (1.0 - m);        // you cast a soft shadow on the painting
  vec3 col = mix(world, sitter, m);
  col = goldLeaf(px, col);
  // the surface: brush drag, weave, fine cracks, a touch of varnish
  col *= 0.97 + 0.06 * fbm(px * vec2(0.14, 0.05) + 0.5 * fbm(px * 0.03));
  col *= 0.985 + 0.03 * (0.5 + 0.25 * sin(px.x * 2.1) + 0.25 * sin(px.y * 2.1));
  col *= 1.0 - uP_crackle * 0.26 * cracks(px / 12.0);
  col = mix(col, col * vec3(1.0, 0.94, 0.82), 0.5);
  float dist = min(min(px.x, uRectPx.x - px.x), min(px.y, uRectPx.y - px.y)), w = uRectPx.y * 0.062 * uP_frame;
  if (dist < w) col = frame(px, dist, w);
  else col *= 0.62 + 0.38 * smoothstep(0.0, 12.0, dist - w);                  // the frame's shadow
  fragColor = vec4(srgbToLinear(clamp(col, 0.0, 1.0)), 1.0);
}`;

const SCENES = [{ file: 'ceiling.jpg', cy: 0.64 }, { file: 'clouds.jpg', cy: 0.5 }, { file: 'heaven.jpg', cy: 0.62 }];
const loaded = new Map();   // scene index -> { tex, w, h }, shared by all boxes
function sceneTexture(ctx, i) {
  const gl = ctx.gl;
  if (loaded.has(i)) return loaded.get(i);
  const tex = gl.createTexture(), e = { tex, w: 1, h: 1 };
  loaded.set(i, e);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([40, 28, 18, 255]));
  const img = new Image();
  img.onload = () => {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    e.w = img.naturalWidth; e.h = img.naturalHeight;
  };
  img.src = new URL('../../assets/renaissance/' + SCENES[i].file, import.meta.url).href;
  return e;
}

export default defineEffect({
  name: 'Renaissance painting',
  cost: 2.4,
  needsSeg: true,
  params: {
    scene: P(0, 2, 0, 1, 'painting: gilded ceiling / golden clouds / heaven'),
    garment: P(0, 2, 0, 1, 'drapery: crimson / ultramarine / gold'),
    detail: P(0, 2, 0.35, 0.05, 'face detail'),
    brush: P(0.5, 3, 1.2, 0.05, 'brush size'),
    light: P(0, 1, 0.8, 0.01, 'painted light'),
    gold: P(0, 1, 1, 0.01, 'gold leaf'),
    crackle: P(0, 1, 0.5, 0.01, 'craquelure'),
    frame: P(0, 2, 1, 0.05, 'gilt frame'),
  },
  presets: [
    { name: 'Gilded ceiling', values: {} },
    { name: 'Golden clouds', values: { scene: 1, garment: 1 } },
    { name: 'Heaven', values: { scene: 2, garment: 2 } },
  ],
  init() {},
  create(ctx, box) {
    const w = box.rt.w, h = box.rt.h;
    box.state = { paint: [ctx.rt(w, h), ctx.rt(w, h)], cur: 0, first: true };
  },
  destroy(ctx, box) { const s = box.state; if (s) { ctx.freeRT(s.paint[0]); ctx.freeRT(s.paint[1]); box.state = null; } },
  render(ctx, box, t) {
    const st = box.state, next = 1 - st.cur, i = Math.round(box.params.scene), sc = sceneTexture(ctx, i);
    ctx.bind(st.paint[next]);
    const pp = ctx.prog('renaissance-paint', PAINT); ctx.common(pp, box, t);
    pp.tex(5, st.paint[st.cur].tex, 'uPrev');
    pp.f('uK', st.first ? 1 : 1 - Math.exp(-Math.min(ctx.dt, 0.1) * 22));   // refresh-rate independent easing
    ctx.draw();
    st.cur = next; st.first = false;
    ctx.bind(box.rt);
    const p = ctx.prog('renaissance', FRAG); ctx.common(p, box, t); ctx.segUniforms(p);
    p.tex(5, st.paint[st.cur].tex, 'uPaint'); p.tex(6, sc.tex, 'uScene');
    // cover-fit the painting to the box, keeping its focal height
    const boxA = (box.rect.w * ctx.sceneW) / (box.rect.h * ctx.sceneH), imgA = sc.w / sc.h;
    const cw = imgA > boxA ? boxA / imgA : 1, ch = imgA > boxA ? 1 : imgA / boxA, cy = SCENES[i].cy;
    p.f4('uCrop', (1 - cw) / 2, Math.min(1 - ch, Math.max(0, cy - ch / 2)), cw, ch);
    ctx.draw();
  },
});
