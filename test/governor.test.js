import test from 'node:test';
import assert from 'node:assert/strict';
import { Governor, depthInterval, refreshPeriod } from '../src/governor.js';

const feed = (g, boxes, ms, n) => { for (let i = 0; i < n; i++) { g.add(ms); g.update(boxes); } };

test('over budget: the most expensive box is reduced first, then pass level; never below the floor', () => {
  const g = new Governor({ budgetMs: 13, window: 30, cooldown: 5 });
  const boxes = [{ scale: 1, cost: 1 }, { scale: 1, cost: 5 }];
  feed(g, boxes, 20, 16);
  assert.ok(boxes[1].scale < 1 && boxes[0].scale === 1, JSON.stringify(boxes));
  feed(g, boxes, 20, 2000);
  assert.ok(boxes.every(b => Math.abs(b.scale - g.minScale) < 1e-6));
  assert.equal(g.passLevel, g.minPass);
});

test('under budget: recovery is slow and goes pass level first, then smallest box', () => {
  const g = new Governor({ budgetMs: 13, window: 30, cooldown: 5, recover: 60 });
  const boxes = [{ scale: 0.5, cost: 1 }];
  g.passLevel = 0.5;
  feed(g, boxes, 5, 80); assert.equal(g.passLevel, 0.75);
  feed(g, boxes, 5, 400); assert.equal(g.passLevel, 1); assert.ok(boxes[0].scale > 0.5);
});

test('within budget nothing changes', () => {
  const g = new Governor({ budgetMs: 13, window: 30, cooldown: 5, recover: 1e9 });
  const boxes = [{ scale: 1, cost: 3 }];
  feed(g, boxes, 11, 500); assert.equal(boxes[0].scale, 1); assert.equal(g.passLevel, 1);
});

test('depth backs off as hand-tracking inference slows, and pauses under pressure', () => {
  assert.equal(depthInterval(10), 100);
  assert.ok(depthInterval(26) > 100 && depthInterval(26) < 500);
  assert.equal(depthInterval(40), Infinity);
  assert.equal(depthInterval(NaN), Infinity);
});

test('refresh period snaps to a standard rate and is not fooled by overload', () => {
  const near = (a, b) => Math.abs(a - b) < 0.3;
  assert.ok(near(refreshPeriod(Array(90).fill(16.7)), 16.67));
  assert.ok(near(refreshPeriod(Array(90).fill(6.9)), 6.94));      // 144 Hz
  assert.ok(near(refreshPeriod(Array(90).fill(8.4)), 8.33));      // 120 Hz
  assert.ok(near(refreshPeriod(Array(90).fill(46)), 16.67));      // overloaded: still assume 60 Hz, never 22 Hz
});
