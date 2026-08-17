/* Minimal CDP client: launch a Chromium, talk to it, shut it down.
 *
 * No npm dependency — Node's global fetch and WebSocket carry it. Every wait has
 * a deadline, so a hung browser fails loudly instead of parking forever.
 *
 * Each launch gets a FRESH user-data-dir. That matters for measurements: Chrome
 * keeps compiled shader programs in the profile, so a warm profile hides exactly
 * the first-frame cost we want to see.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/* `gpu: true` asks for a browser that can reach the real GPU.
 *
 * This matters for anything WebGL: chrome-headless-shell has no GPU path and
 * falls back to SwiftShader, where a three.js frame costs about 16 ms no matter
 * what the code does. A full Chrome/Chromium in --headless=new mode uses ANGLE
 * on Metal and gives numbers a visitor would actually see. Still no window: new
 * headless mode draws off screen.
 */
export function findChromium(gpu) {
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const full = [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-linux/chrome',
  ];
  const shell = ['chrome-headless-shell-mac-arm64/chrome-headless-shell'];
  const order = gpu ? [full, shell] : [shell, full];
  const dirs = existsSync(cache) ? readdirSync(cache) : [];
  for (const group of order) {
    for (const dir of dirs) {
      for (const rel of group) {
        const p = join(cache, dir, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  for (const p of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                   '/Applications/Chromium.app/Contents/MacOS/Chromium']) {
    if (existsSync(p)) return p;
  }
  throw new Error('no Chromium found (Playwright cache empty and no local Chrome) — nothing is downloaded here');
}

const deadline = (ms, what) => new Promise((_, rej) =>
  setTimeout(() => rej(new Error('timeout after ' + ms + 'ms: ' + what)), ms));

export async function waitFor(fn, what, ms = 15000, every = 150) {
  const until = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { /* not up yet */ }
    if (Date.now() > until) throw new Error('timeout after ' + ms + 'ms waiting for ' + what);
    await new Promise(r => setTimeout(r, every));
  }
}

class Session {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.waiters = new Map();
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        const w = this.waiters.get(msg.method);
        if (w) { this.waiters.delete(msg.method); w(msg.params); }
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return Promise.race([new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })),
                         deadline(60000, method)]);
  }
  once(method, ms = 30000) {
    return Promise.race([new Promise(res => this.waiters.set(method, res)), deadline(ms, method)]);
  }
  /* Evaluate an async function body in the page and return its value. */
  async evaluate(fn, ...args) {
    const expr = `(${fn.toString()})(${args.map(a => JSON.stringify(a)).join(',')})`;
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate failed');
    }
    return r.result.value;
  }
  async goto(url) {
    await this.send('Page.navigate', { url });
    await this.once('Page.loadEventFired');
  }
  /* Viewport, device pixel ratio and — the part that decides
     (hover:none) and (pointer:coarse) — the mobile/touch flags. */
  async setViewport({ width, height, dpr = 1, mobile = false, touch = false }) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: dpr, mobile,
      screenWidth: width, screenHeight: height,
    });
    // maxTouchPoints must stay in 1..16 even when touch is being switched off.
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
    if (touch) await this.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
  }
  throttleCPU(rate) { return this.send('Emulation.setCPUThrottlingRate', { rate }); }
  reducedMotion(on) {
    return this.send('Emulation.setEmulatedMedia', {
      features: on ? [{ name: 'prefers-reduced-motion', value: 'reduce' }] : [] });
  }
  async screenshot() {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(r.data, 'base64');
  }
}

export async function launch({ width = 1280, height = 720, gpu = false, onStderr } = {}) {
  const chromium = findChromium(gpu);
  const profile = mkdtempSync(join(tmpdir(), 'swelt-cdp-'));
  // Port 0 = let Chrome pick a free one and write it into the profile. A fixed
  // port is a trap: if an earlier browser is still holding it, the new one
  // cannot bind, and the client happily attaches to the STALE browser instead.
  // That silently measured the wrong process here once — different GL backend,
  // different page, numbers that looked real and were not.
  const child = spawn(chromium, [
    '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--hide-scrollbars', '--window-size=' + width + ',' + height,
    // Off screen either way; these only decide whether ANGLE reaches the GPU.
    ...(gpu ? ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'] : []),
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  child.stderr.on('data', d => { if (onStderr) onStderr(String(d)); });

  const portFile = join(profile, 'DevToolsActivePort');
  const port = Number(await waitFor(() => {
    const txt = readFileSync(portFile, 'utf8').split('\n')[0].trim();
    return txt || null;
  }, 'DevToolsActivePort'));
  await waitFor(() => fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.ok), 'devtools endpoint');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await Promise.race([new Promise(res => ws.addEventListener('open', res)), deadline(10000, 'websocket open')]);

  const session = new Session(ws);
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.setViewport({ width, height });

  return {
    session,
    port,
    /* Kill the whole process group, not just the parent: a browser leaves
       renderer and GPU children behind, and one survivor still holding a socket
       is what poisoned an earlier measurement run. Verified afterwards, not
       assumed. */
    async close() {
      try { ws.close(); } catch (e) {}
      const group = -child.pid;
      try { process.kill(group, 'SIGTERM'); } catch (e) { try { child.kill('SIGTERM'); } catch (e2) {} }
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 100));
        try { process.kill(child.pid, 0); } catch (e) { break; }   // gone
        if (i === 9) { try { process.kill(group, 'SIGKILL'); } catch (e) {} }
      }
      // The port must be free again, or something survived.
      let stillUp = false;
      try {
        const ctl = AbortSignal.timeout ? AbortSignal.timeout(500) : undefined;
        stillUp = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctl }).then(r => r.ok).catch(() => false);
      } catch (e) { stillUp = false; }
      try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
      if (stillUp) throw new Error('browser on port ' + port + ' survived close()');
    },
  };
}
