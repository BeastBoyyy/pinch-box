// Debug overlay + metrics + messages. Updated on a 4 Hz timer, never inside the render loop.
const $ = (tag, cls, parent, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; if (parent) parent.appendChild(e); return e; };
const f1 = x => (Number.isFinite(x) ? x.toFixed(1) : '–');
const f2 = x => (Number.isFinite(x) ? x.toFixed(2) : '–');

export function loadTuning() { try { return JSON.parse(localStorage.getItem('pinchbox.tuning') || 'null'); } catch (e) { return null; } }
export function saveTuning(t) { try { localStorage.setItem('pinchbox.tuning', JSON.stringify(t)); } catch (e) { /* private mode */ } }

export class Hud {
  constructor(root) {
    this.root = root;
    this.line = $('div', 'hud-line', root);
    this.msg = $('div', 'hud-msg', root); this.msg.hidden = true;
    this.help = $('div', 'hud-help', root,
      'Both hands up, thumb + index open  ·  pinch both to lock  ·  U undo  ·  Esc clear  ·  C calibrate  ·  D debug  ·  R record  ·  S skeleton  ·  Space pause');
    this.debug = $('div', 'hud-debug', root); this.debug.hidden = true;
    this.fallbackBanner = null;
    this.msgTimer = 0;
    setTimeout(() => { this.help.classList.add('fade'); }, 9000);
    this.getState = () => ({});
    this.sections = {};
    this.timer = setInterval(() => this.update(), 250);
  }

  message(text, kind = 'info', ms = 0) {
    this.msg.textContent = text; this.msg.className = 'hud-msg ' + kind; this.msg.hidden = !text;
    clearTimeout(this.msgTimer);
    if (ms) this.msgTimer = setTimeout(() => { this.msg.hidden = true; }, ms);
  }
  /** unrecoverable: replace the whole UI with a plain message */
  fatal(text) { this.message(text, 'error'); this.msg.classList.add('fatal'); }

  toggleDebug() { this.debug.hidden = !this.debug.hidden; if (!this.debug.hidden && !this.built) this._build(); return !this.debug.hidden; }
  get debugOn() { return !this.debug.hidden; }

  // ---- debug panel -----------------------------------------------------------------------------
  _slider(parent, label, min, max, step, value, onChange) {
    const row = $('label', 'row', parent); $('span', 'lab', row, label);
    const input = $('input', '', row); input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = value;
    const num = $('span', 'num', row, (+value).toFixed(step < 0.01 ? 3 : 2));
    input.oninput = () => { num.textContent = (+input.value).toFixed(step < 0.01 ? 3 : 2); onChange(+input.value); };
    return { input, num };
  }
  _build() {
    this.built = true;
    const d = this.debug;
    this.live = $('pre', 'live', d);
    const tune = $('details', '', d); tune.open = true; $('summary', '', tune, 'Filter tuning (saved to localStorage)');
    this.tuneBox = $('div', '', tune);
    this.effectBox = $('details', '', d); this.effectBox.open = true; $('summary', '', this.effectBox, 'Last box effect');
    this.effectBody = $('div', '', this.effectBox);
    this.buildTuning?.(this.tuneBox);
  }
  /** called by main to supply the tuning UI builder: fn(container, helpers) */
  setTuningBuilder(fn) { this.buildTuning = fn; if (this.built) fn(this.tuneBox); }
  slider(parent, ...a) { return this._slider(parent, ...a); }

  showEffectParams(box, onChange, presetCb) {
    if (!this.built) return;
    const body = this.effectBody; body.textContent = '';
    if (!box) { body.textContent = 'no box yet'; return; }
    $('div', 'sub', body, `${box.effect.name}  (box ${box.id}, scale ${f2(box.scale)})`);
    const pr = $('div', 'presets', body);
    box.effect.presets.forEach((p, i) => { const b = $('button', box.preset === i ? 'on' : '', pr, p.name); b.onclick = () => { presetCb(i); }; });
    for (const k of box.effect.paramKeys) {
      const p = box.effect.params[k];
      this._slider(body, p.label || k, p.min, p.max, p.step, box.params[k], v => onChange(k, v));
    }
  }

  update() {
    const s = this.getState();
    this.line.textContent = `capture ${f1(s.captureFps)} fps · inference ${f1(s.inferMs)} ms (${s.delegate || '…'}) · latency ${f1(s.latencyMs)} ms · render ${f1(s.renderFps)} fps` + (s.refreshHz ? ` (display ${Math.round(s.refreshHz)} Hz)` : '') +
      (s.gpuMs ? ` · gpu ${f1(s.gpuMs)} ms` : '') + ` · boxes ${s.boxes ?? 0}` + (s.paused ? ' · TRACKING PAUSED' : '') + (s.recording ? ' · ● REC ' + s.recording : '') +
      (s.blocker ? ' · ' + s.blocker : '') + (s.depthMode ? ` · depth: ${s.depthMode === 'approx' ? 'approximate' : 'model'}` : '');
    if (this.debug.hidden || !this.built) return;
    const lines = [];
    lines.push(`camera  ${s.cam || ''}`);
    lines.push(`render  ${s.scene || ''}   governor p95 ${f1(s.p95)} ms / budget ${f1(s.budget)} ms   pass level ${f2(s.passLevel)}`);
    lines.push(s.blocker ? `NOT LOCKING: ${s.blocker}` : 'lock ready');
    lines.push(`FSM  ${s.fsm}   armed ${s.armed ? 'yes' : 'no'}   thresholds ON ${f2(s.rOn)}  OFF ${f2(s.rOff)}${s.calibrated ? '  (calibrated)' : ''}`);
    for (const h of s.hands || []) {
      lines.push(`${h.slot} #${h.id}${h.confirmed ? '' : ' (unconfirmed)'}  conf ${f2(h.conf)}  S ${f1(h.S)} px  gate ${h.gate || 'ok'}${h.coasting ? '  COASTING' : ''}`);
      lines.push(`   pinch r raw ${f2(h.rRaw)}  filtered ${f2(h.r)}  ${bar(h.r, s.rOn, s.rOff)}  ${h.on ? 'PINCH' : '     '}`);
    }
    if (!(s.hands || []).length) lines.push('no hands');
    lines.push(`tracker  spawns ${s.st.spawns} confirms ${s.st.confirms} drops ${s.st.drops} ignored ${s.st.ignored}  gates ${JSON.stringify(s.st.gate)}`);
    if (s.boxList) for (const b of s.boxList) lines.push(`box ${b.id}  ${b.name}  scale ${f2(b.scale)}`);
    this.live.textContent = lines.join('\n');
  }
}
const bar = (r, on, off) => {
  const n = 30, max = 1.6; let o = '';
  const at = v => Math.max(0, Math.min(n - 1, Math.round(v / max * n)));
  for (let i = 0; i < n; i++) o += i === at(r) ? '█' : i === at(on) ? '|' : i === at(off) ? '¦' : '·';
  return o;
};
