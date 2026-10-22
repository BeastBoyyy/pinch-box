// Synthetic 21-landmark hand (MediaPipe topology) with constant bone lengths and a controllable
// thumb-index opening. Used by tests, the replay generator and the ?fake=1 mode. Pure, no DOM.

const REACH = {
  thumb: [0.45, 0.33, 0.28],
  index: [0.42, 0.24, 0.20],
  middle: [0.46, 0.28, 0.21],
  ring: [0.42, 0.26, 0.20],
  pinky: [0.33, 0.19, 0.17],
};
const BASE = { // finger MCP positions in units of S (wrist = origin, x right, y down)
  thumbCMC: [-0.35, -0.12], index: [-0.28, -0.95], middle: [0, -1.0], ring: [0.27, -0.93], pinky: [0.52, -0.82],
};
const PINCH_POINT = [-0.5, -1.05];
const THUMB_OPEN_TIP = [-1.15, -0.6];

/** forward kinematics of a planar chain from angles (global bone directions) */
function chain(base, lens, angs) {
  const pts = [base.slice()];
  for (let i = 0; i < lens.length; i++) {
    const p = pts[i];
    pts.push([p[0] + Math.cos(angs[i]) * lens[i], p[1] + Math.sin(angs[i]) * lens[i]]);
  }
  return pts;
}
/** CCD inverse kinematics; returns joint positions reaching (or nearest to) `target` */
function ccd(base, lens, angs0, target, iters = 40) {
  const angs = angs0.slice();
  for (let it = 0; it < iters; it++) {
    for (let j = lens.length - 1; j >= 0; j--) {
      const pts = chain(base, lens, angs);
      const jp = pts[j], tip = pts[lens.length];
      const a1 = Math.atan2(tip[1] - jp[1], tip[0] - jp[0]);
      const a2 = Math.atan2(target[1] - jp[1], target[0] - jp[0]);
      for (let k = j; k < lens.length; k++) angs[k] += a2 - a1;
    }
  }
  return chain(base, lens, angs);
}
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/**
 * @param o     0 = thumb and index tips touching, 1 = wide open "L"
 * @param flip  mirror the hand horizontally (use for the hand on the other side)
 * @returns hand in units of S: Float32Array(63) [x,y,z]*21 with wrist at origin
 */
export function handLocal(o, flip = false) {
  const up = -Math.PI / 2;
  const idxOpen = chain(BASE.index, REACH.index, [up, up, up]);
  const idxTarget = lerp(PINCH_POINT, idxOpen[3], Math.min(1, Math.max(0, o)));
  const idx = ccd(BASE.index, REACH.index, [up, up, up], idxTarget);
  const thTarget = lerp(PINCH_POINT, THUMB_OPEN_TIP, Math.min(1, Math.max(0, o)));
  const th = ccd(BASE.thumbCMC, REACH.thumb, [-2.2, -2.0, -1.9], thTarget);
  const curl = { middle: -0.1, ring: -0.2, pinky: -0.3 };
  const pts = new Array(21);
  pts[0] = [0, 0];
  for (let i = 0; i < 4; i++) pts[1 + i] = th[i];
  for (let i = 0; i < 4; i++) pts[5 + i] = idx[i];
  const others = [['middle', 9], ['ring', 13], ['pinky', 17]];
  for (const [name, at] of others) {
    const c = chain(BASE[name], REACH[name], [up, up + curl[name] * 0.4, up + curl[name]]);
    for (let i = 0; i < 4; i++) pts[at + i] = c[i];
  }
  const out = new Float32Array(63);
  for (let i = 0; i < 21; i++) {
    out[i * 3] = flip ? -pts[i][0] : pts[i][0];
    out[i * 3 + 1] = pts[i][1];
    out[i * 3 + 2] = -0.02 * (i % 4); // slight depth ramp so z is non-degenerate
  }
  return out;
}

const SWORLD = 0.095; // metres, wrist -> middle MCP

/**
 * Hand in frame pixels, as MediaPipe would report it for the UNMIRRORED camera image.
 * cx,cy: wrist position (px). S: hand scale in px. rot: in-plane rotation (rad).
 * Returns { lm: Float32Array(63) normalized, world: Float32Array(63) metres, px: Float32Array(63) }.
 */
export function synthHand({ cx, cy, S, o, rot = 0, flip = false, W = 1280, H = 720 }) {
  const loc = handLocal(o, flip);
  const px = new Float32Array(63), lm = new Float32Array(63), world = new Float32Array(63);
  const c = Math.cos(rot), s = Math.sin(rot);
  for (let i = 0; i < 21; i++) {
    const x = loc[i * 3], y = loc[i * 3 + 1], z = loc[i * 3 + 2];
    const rx = x * c - y * s, ry = x * s + y * c;
    px[i * 3] = cx + rx * S; px[i * 3 + 1] = cy + ry * S; px[i * 3 + 2] = z * S;
    lm[i * 3] = px[i * 3] / W; lm[i * 3 + 1] = px[i * 3 + 1] / H; lm[i * 3 + 2] = z * S / W;
    world[i * 3] = rx * SWORLD; world[i * 3 + 1] = ry * SWORLD; world[i * 3 + 2] = z * SWORLD;
  }
  return { lm, world, px };
}

/** deterministic gaussian noise source */
export function makeRng(seed = 12345) {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const g = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
  return { u, g };
}
