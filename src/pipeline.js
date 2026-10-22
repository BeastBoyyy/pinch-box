// Per-box render targets and state, stack bookkeeping (fade-in/out), and the quality governor glue.
// Boxes come from the gesture engine in video-frame pixels; here they become scene-uv rects with their own RTs.
import { Governor } from './governor.js';
import { applyPreset } from './effects/util.js';

export class Pipeline {
  constructor(renderer, effects, { budgetMs = 13 } = {}) {
    this.r = renderer; this.effects = effects;
    this.list = [];                       // BoxRuntime, in stacking order (the array the renderer iterates)
    this.byId = new Map();
    this.gov = new Governor({ budgetMs });
    this.needsDepth = false;
    this.pendingRealloc = null;
  }

  _rect(g, W, H) { // gesture rect (frame px, y down) -> scene uv rect (y up)
    return { x: g.x0 / W, y: 1 - g.y1 / H, w: (g.x1 - g.x0) / W, h: (g.y1 - g.y0) / H };
  }

  _alloc(box) {
    const r = this.r, [w, h] = r.boxSize(box);
    box.rt = r.rt(w, h, { format: 'rgba16f' });
    box.effect.create?.(r, box);
    box.appliedScale = box.scale;
  }
  _free(box) {
    const r = this.r;
    box.effect.destroy?.(r, box);
    r.freeRT(box.rt); box.rt = null;
  }

  /** a gesture lock event */
  add(gbox, W, H, nowMs) {
    const effect = this.effects[gbox.effectIndex % this.effects.length];
    const box = { id: gbox.id, effect, params: null, preset: 0, rect: this._rect(gbox.rect, W, H), scale: 1, appliedScale: 1,
      rt: null, state: null, lockedAt: nowMs, fade: 1, removing: false, removedAt: 0, cost: 1 };
    box.cost = effect.cost * box.rect.w * box.rect.h; // governor's relative expense estimate
    applyPreset(box, 0);
    this._alloc(box);
    this.list.push(box); this.byId.set(box.id, box);
    this._refreshFlags();
    return box;
  }
  /** invisible one-frame box that forces an effect's shaders to compile and its targets to allocate now, not at the first lock */
  warm(effectIndex, W, H) {
    const effect = this.effects[effectIndex];
    const box = { id: -1 - effectIndex, effect, params: null, preset: 0, rect: { x: 0.01, y: 0.01, w: 0.12, h: 0.12 }, scale: 1, appliedScale: 1,
      rt: null, state: null, lockedAt: 0, fade: 0, removing: false, removedAt: 0, cost: 0, warm: true };
    applyPreset(box, 0);
    this._alloc(box);
    this.list.push(box);
    return box;
  }
  discard(box) {
    const i = this.list.indexOf(box);
    if (i >= 0) this.list.splice(i, 1);
    this._free(box);
  }
  remove(id, nowMs) { const b = this.byId.get(id); if (b && !b.removing) { b.removing = true; b.removedAt = nowMs; } }
  clear(nowMs) { for (const b of this.list) if (!b.removing) { b.removing = true; b.removedAt = nowMs; } }
  last() { for (let i = this.list.length - 1; i >= 0; i--) if (!this.list[i].removing) return this.list[i]; return null; }

  _refreshFlags() { this.needsDepth = this.list.some(b => !b.removing && b.effect.needsDepth); }

  /** scene size changed: rect fractions stay, RTs need new pixel sizes */
  reallocAll() { for (const b of this.list) { if (b.rt) this._free(b); this._alloc(b); } }

  /** call once per display frame with the frame time the governor should judge (ms) */
  update(nowMs, frameMs) {
    // fade-out of removed boxes
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i];
      if (b.removing) {
        b.fade = Math.max(0, 1 - (nowMs - b.removedAt) / 260);
        if (b.fade <= 0) { this._free(b); this.list.splice(i, 1); this.byId.delete(b.id); this._refreshFlags(); }
      }
    }
    this.gov.add(frameMs);
    if (this.gov.update(this.list)) { /* scales changed; applied below */ }
    this.r.passLevel = this.gov.passLevel;
    // apply at most one RT reallocation per frame so a governor step never causes a hitch spike
    for (const b of this.list) {
      if (b.rt && Math.abs(b.scale - b.appliedScale) > 1e-6) { this._free(b); this._alloc(b); break; }
    }
  }
}
