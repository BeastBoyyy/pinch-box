import test from 'node:test';
import assert from 'node:assert/strict';
import { findBlobs, BlobTracker } from '../src/blobs.js';

const W = 40, H = 20;
const mask = rects => {
  const m = new Uint8Array(W * H * 4);
  for (const [x0, y0, x1, y1] of rects) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[(y * W + x) * 4] = 255;
  return m;
};

test('separate regions become separate blobs, largest first, specks ignored', () => {
  const b = findBlobs(mask([[2, 2, 8, 8], [20, 10, 24, 14], [35, 1, 36, 2]]), W, H);
  assert.equal(b.length, 2);
  assert.equal(b[0].area, 36);
  assert.deepEqual([b[0].x0, b[0].x1, b[0].y0, b[0].y1], [2 / W, 8 / W, 2 / H, 8 / H]);
  assert.ok(Math.abs(b[1].cx - 22 / W) < 1e-9 && Math.abs(b[1].cy - 12 / H) < 1e-9);
});

test('a region touching the frame edge does not wrap onto the next row', () => {
  const b = findBlobs(mask([[36, 4, 40, 8], [0, 8, 4, 12]]), W, H);
  assert.equal(b.length, 2);
});

test('a moving blob keeps its id, a brief loss is remembered, a long loss is dropped', () => {
  const t = new BlobTracker({ ttl: 2 }), at = x => [{ x0: x, y0: 0.4, x1: x + 0.1, y1: 0.6, cx: x + 0.05, cy: 0.5, area: 20 }];
  const id = t.update(at(0.2))[0].id;
  assert.equal(t.update(at(0.25))[0].id, id);
  assert.equal(t.update([]).length, 1);
  assert.equal(t.update(at(0.3))[0].id, id);
  t.update([]); t.update([]);
  assert.equal(t.update([]).length, 0);
  assert.notEqual(t.update(at(0.3))[0].id, id);
});
