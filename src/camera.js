// Camera / video source + a frame pump that carries a capture timestamp per frame.
export class CameraError extends Error {}

export class Camera {
  constructor(video) {
    this.video = video; this.settings = null; this.fps = 0; this._n = 0; this._t0 = 0; this.frameCb = null; this.isFile = false;
    this.trackLabel = '';
  }

  /** src: optional video file URL (?src=…); otherwise the webcam */
  async open(src) {
    const v = this.video;
    v.muted = true; v.playsInline = true; v.autoplay = true;
    if (src) {
      this.isFile = true; v.loop = true; v.src = src;
      await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new CameraError(`Could not load video file "${src}".`)); });
      try { await v.play(); } catch (e) { throw new CameraError('The browser blocked video playback; click the page once and reload.'); }
      this.settings = { width: v.videoWidth, height: v.videoHeight, frameRate: 30, label: 'file: ' + src };
      return this.settings;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new CameraError('This browser has no camera API (needs https:// or http://localhost).');
    let stream;
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60, min: 30 }, facingMode: 'user' } });
      } catch (e) { // some cameras cannot promise 30+ fps: retry without the minimum rather than failing
        if (e && e.name === 'OverconstrainedError') stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } });
        else throw e;
      }
    } catch (e) {
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw new CameraError('Camera permission was denied. Allow camera access for this page and reload.');
      if (e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) throw new CameraError('No camera was found (or none supports 30+ fps). Plug one in, or run with ?src=file.mp4.');
      if (e && e.name === 'NotReadableError') throw new CameraError('The camera is in use by another application. Close it and reload.');
      throw new CameraError('Could not open the camera: ' + (e && e.message || e));
    }
    v.srcObject = stream;
    await new Promise(r => { v.onloadedmetadata = r; });
    await v.play();
    const track = stream.getVideoTracks()[0];
    this.trackLabel = track.label;
    // prefer steady (continuous but not hunting) exposure / white balance / focus where the camera exposes them; ignore failures
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      const adv = {};
      if (caps.exposureMode && caps.exposureMode.includes('continuous')) adv.exposureMode = 'continuous';
      if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes('continuous')) adv.whiteBalanceMode = 'continuous';
      if (caps.focusMode && caps.focusMode.includes('continuous')) adv.focusMode = 'continuous';
      if (Object.keys(adv).length) await track.applyConstraints({ advanced: [adv] });
    } catch (e) { /* optional */ }
    const s = track.getSettings();
    this.settings = { width: s.width || v.videoWidth, height: s.height || v.videoHeight, frameRate: s.frameRate || 30, label: track.label,
      exposureMode: s.exposureMode, whiteBalanceMode: s.whiteBalanceMode, focusMode: s.focusMode };
    return this.settings;
  }

  /** cb(captureTimeMs, videoElement). Uses requestVideoFrameCallback (capture time when the browser provides it). */
  start(cb) {
    const v = this.video;
    this.frameCb = cb;
    const tick = (now, md) => {
      const t = (md && (md.captureTime ?? md.expectedDisplayTime)) || performance.now();
      this._n++;
      if (t - this._t0 >= 1000) { this.fps = this._n * 1000 / (t - this._t0); this._n = 0; this._t0 = t; }
      cb(t, v);
      v.requestVideoFrameCallback(tick);
    };
    if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(tick);
    else { // fallback: poll rAF and fire when the media time advanced
      let last = -1;
      const poll = now => {
        if (v.currentTime !== last && v.readyState >= 2) { last = v.currentTime; tick(now, null); }
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    }
  }
}
