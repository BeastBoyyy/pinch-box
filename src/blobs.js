// Blob detection + identity for the blob tracking effect. Pure logic: no DOM / WebGL.

/**
 * Connected components of a small mask. mask: RGBA bytes as read back from WebGL (R channel, row 0 = bottom).
 * Returns blobs largest first, in 0..1 box coordinates (y up): {x0, y0, x1, y1, cx, cy, area}.
 */
export function findBlobs(mask, w, h, { threshold = 128, minArea = 10, maxBlobs = 24 } = {}) {
  const seen = new Uint8Array(w * h), stack = new Int32Array(w * h), out = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || mask[start * 4] < threshold) continue;
    let top = 0, area = 0, sx = 0, sy = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack[top++] = start; seen[start] = 1;
    while (top) {
      const i = stack[--top], x = i % w, y = (i / w) | 0;
      area++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const n of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (n >= 0 && !seen[n] && mask[n * 4] >= threshold) { seen[n] = 1; stack[top++] = n; }
      }
    }
    if (area >= minArea) out.push({ x0: x0 / w, y0: y0 / h, x1: (x1 + 1) / w, y1: (y1 + 1) / h, cx: (sx / area + 0.5) / w, cy: (sy / area + 0.5) / h, area });
  }
  return out.sort((a, b) => b.area - a.area).slice(0, maxBlobs);
}

/** Keeps blob identities across frames: nearest-centroid matching, smoothed rectangles, a short memory so boxes do not blink. */
export class BlobTracker {
  constructor({ ttl = 6, radius = 0.14, smooth = 0.55 } = {}) { this.ttl = ttl; this.radius = radius; this.smooth = smooth; this.tracks = []; this.nextId = 1; }
  update(blobs) {
    const used = new Set(), k = this.smooth;
    for (const tr of this.tracks) {
      let best = -1, bd = this.radius;
      blobs.forEach((b, i) => { if (used.has(i)) return; const d = Math.hypot(b.cx - tr.cx, b.cy - tr.cy); if (d < bd) { bd = d; best = i; } });
      if (best < 0) { tr.miss++; continue; }
      used.add(best);
      const b = blobs[best];
      for (const f of ['x0', 'y0', 'x1', 'y1', 'cx', 'cy']) tr[f] += k * (b[f] - tr[f]);
      tr.area = b.area; tr.miss = 0; tr.age++;
    }
    this.tracks = this.tracks.filter(t => t.miss <= this.ttl);
    blobs.forEach((b, i) => { if (!used.has(i)) this.tracks.push({ ...b, id: this.nextId++, age: 1, miss: 0 }); });
    return this.tracks;
  }
}
