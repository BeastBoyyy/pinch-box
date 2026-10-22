// Pinch-Box desktop shell: a Chromium window around the same web app, served from a private localhost server.
// Plug and run: models, MediaPipe, the depth model and every shader are bundled, nothing is downloaded.
//   --selftest[=seconds] --selftest-out=file.json   headless-ish self check (used by the build to verify GPU / refresh rate)
//   --live   (with --selftest) use the real/fake camera + hand tracker instead of the synthetic demo
//   --demo                                          start in demo mode (synthetic hands, no camera needed)
import { app, BrowserWindow, session, Menu, screen, dialog } from 'electron';
import { writeFileSync } from 'node:fs';
import { start } from '../tools/serve.js';

// ---- GPU: use the fastest adapter, never the software renderer, and never throttle ------------------------------------
app.commandLine.appendSwitch('force_high_performance_gpu');   // hybrid laptops: pick the discrete GPU (hand model 2-3x faster)
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('use-angle', 'd3d11');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
// NOTE: no 'disable-frame-rate-limit' / 'disable-gpu-vsync': frames stay locked to the display's refresh rate (60/75/120/144/165...),
// which is what makes it smooth. The app measures the refresh rate itself and sizes its quality budget to it.

const arg = k => { const a = process.argv.find(x => x === k || x.startsWith(k + '=')); return a === undefined ? null : (a.includes('=') ? a.split('=')[1] : true); };
const selftest = arg('--selftest'), selftestOut = arg('--selftest-out');
let server = null, win = null;

if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(async () => {
    try { server = await start(0, app.getAppPath()); }
    catch (e) { dialog.showErrorBox('Pinch-Box', 'Could not start the internal server: ' + e.message); return app.quit(); }
    const origin = `http://127.0.0.1:${server.address().port}`;

    // camera permission only for our own private origin; everything else denied
    const mine = u => typeof u === 'string' && u.startsWith(origin);
    const allowed = new Set(['media', 'fullscreen', 'clipboard-sanitized-write']);
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => cb(allowed.has(perm) && mine(details?.requestingUrl || wc?.getURL())));
    session.defaultSession.setPermissionCheckHandler((wc, perm, requestingOrigin, details) => allowed.has(perm) && (mine(requestingOrigin) || mine(details?.requestingUrl) || mine(wc?.getURL())));

    Menu.setApplicationMenu(null);
    win = new BrowserWindow({
      width: 1280, height: 760, minWidth: 640, minHeight: 400, backgroundColor: '#000000', title: 'Pinch-Box', show: false,
      autoHideMenuBar: true, icon: undefined,
      webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    });
    win.once('ready-to-show', () => win.show());
    win.webContents.on('before-input-event', (e, input) => {   // F11 fullscreen, Ctrl+R reload, Ctrl+Shift+I devtools
      if (input.type !== 'keyDown') return;
      if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
      else if (input.control && input.key.toLowerCase() === 'r') { win.webContents.reloadIgnoringCache(); e.preventDefault(); }
      else if (input.control && input.shift && input.key.toLowerCase() === 'i') { win.webContents.toggleDevTools(); e.preventDefault(); }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin)) e.preventDefault(); });
    win.on('closed', () => { win = null; });

    const q = selftest ? (arg('--live') ? '?debug=1' : '?fake=1&src=fixtures/sample.mp4&debug=1') : (arg('--demo') ? '?fake=1' : '');
    await win.loadURL(origin + '/index.html' + q);

    if (selftest) {
      const secs = Number(selftest === true ? 12 : selftest) || 12;
      setTimeout(async () => {
        try {
          const info = await win.webContents.executeJavaScript(`(() => {
            const a = window.__pinchbox, gl = document.createElement('canvas').getContext('webgl2'), e = gl && gl.getExtension('WEBGL_debug_renderer_info');
            return { gpu: e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a', renderFps: a.renderer.stats.renderFps, refreshHz: a.S.refreshHz, gpuMs: a.renderer.stats.gpuMs,
              floatTargets: a.renderer.caps.floatRT, timerQuery: !!a.renderer.timerExt, scene: a.renderer.sceneW + 'x' + a.renderer.sceneH, boxes: a.gesture.boxes.length,
              hud: document.querySelector('.hud-line').textContent, webgpu: !!navigator.gpu, ua: navigator.userAgent };
          })()`);
          const d = screen.getPrimaryDisplay();
          const out = { ...info, osDisplayHz: d.displayFrequency, scale: d.scaleFactor, size: d.size, electron: process.versions.electron, chrome: process.versions.chrome,
            gpuFeatures: app.getGPUFeatureStatus() };
          if (selftestOut) writeFileSync(selftestOut, JSON.stringify(out, null, 1)); else console.log(JSON.stringify(out, null, 1));
        } catch (e) { if (selftestOut) writeFileSync(selftestOut, JSON.stringify({ error: String(e) })); }
        app.quit();
      }, secs * 1000);
    }
  });

  app.on('window-all-closed', () => { if (server) server.close(); app.quit(); });
}
