#!/usr/bin/env node
/* Verification run for the two things a desktop browser session cannot show by
 * itself: the three.js driver against the real library, and the phone-shaped
 * behaviour of the engine under emulation.
 *
 *   python3 demo/tools/serve.py &            # the pages have to be served
 *   node demo/tools/verify-headless.mjs [--base http://127.0.0.1:8731]
 *
 * Every launch uses a fresh user-data-dir, so shader programs are NOT cached
 * from an earlier run. That is the whole point of measuring here rather than in
 * a long-lived browser: a warm program cache hides the first-frame cost.
 *
 * Output is one JSON document on stdout plus a short verdict per check on
 * stderr. Exit code 0 only if every check passed.
 */
import { launch, waitFor } from './cdp.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) =>
  a.startsWith('--') ? [a.slice(2), (all[i + 1] && !all[i + 1].startsWith('--')) ? all[i + 1] : true] : []).filter(Boolean));
const BASE = args.base || 'http://127.0.0.1:8731';

const results = {};
const verdicts = [];
function check(name, pass, detail) {
  verdicts.push({ name, pass: !!pass, detail });
  process.stderr.write((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : '') + '\n');
}

/* ---- helpers that run inside the page ---------------------------------- */

const settle = (y, ticks) => new Promise(res => {
  window.scrollTo(0, y);
  let n = 0;
  const step = () => (++n > (ticks || 50) ? res(window.scrollY) : requestAnimationFrame(step));
  requestAnimationFrame(step);
});

/* ======================================================================== *
 * 1  three.js — against the real library                                    *
 * ======================================================================== */
async function threeChecks() {
  const browser = await launch({ width: 1280, height: 720, gpu: true });
  const { session } = browser;
  const logs = [];
  session.send('Log.enable').catch(() => {});
  try {
    const consoleSpy = `window.__logs = []; (function(){ const w = console.warn, e = console.error;
      console.warn = function(){ window.__logs.push(['warn', Array.from(arguments).join(' ')]); return w.apply(console, arguments); };
      console.error = function(){ window.__logs.push(['error', Array.from(arguments).join(' ')]); return e.apply(console, arguments); }; })();`;
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: consoleSpy });

    await session.goto(BASE + '/demo/index.html');
    await waitFor(() => session.evaluate(() => Boolean(window.welt && window.halleSzene)), 'engine + 3D scene');

    // -- resolved through the importmap, i.e. the import('three') branch
    const res = await session.evaluate(async () => {
      const ok = await window.halleSzene.ready;
      const mod = await import('three');
      // Which GL backend are we measuring on? A software rasterizer turns every
      // three frame into ~16 ms no matter what the code does, so the number is
      // meaningless without this line.
      const probe = document.createElement('canvas').getContext('webgl2');
      const dbg = probe && probe.getExtension('WEBGL_debug_renderer_info');
      return { ready: ok, available: window.halleSzene.available,
               error: window.halleSzene.error ? String(window.halleSzene.error) : null,
               revision: mod.REVISION, sceneChildren: window.halleSzene.scene().children.length,
               glRenderer: dbg ? probe.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown' };
    });
    results.threeResolved = res;
    check('three resolves via importmap and the driver reports ready',
      res.ready === true && res.available === true && !res.error,
      'three r' + res.revision + ', ' + res.sceneChildren + ' Objekte in der Szene');
    const onGPU = !/SwiftShader|Software/i.test(res.glRenderer);
    check('Messung laeuft auf einer echten GPU (sonst ist jede ms-Zahl wertlos)',
      onGPU, res.glRenderer);

    // -- t=0 and t=1 sit exactly on the first and last control point
    const spline = await session.evaluate(() => {
      const cam = window.halleSzene.camera();
      const cv = document.createElement('canvas'); cv.width = 320; cv.height = 180;
      const ctx = { canvas: cv, ctx2d: cv.getContext('2d'), width: 320, height: 180, dpr: 1,
                    segment: { id: 'halle' }, reducedMotion: false };
      const at = t => { window.halleSzene(t, ctx); return [cam.position.x, cam.position.y, cam.position.z]; };
      return { t0: at(0), t1: at(1), mid: at(0.5),
               first: [-0.6, 1.55, 14.0], last: [0.35, 1.55, 0.6] };
    });
    const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
    results.spline = spline;
    check('Spline: t=0 und t=1 exakt auf erstem und letztem Kontrollpunkt',
      same(spline.t0, spline.first) && same(spline.t1, spline.last),
      't0=' + JSON.stringify(spline.t0) + ' t1=' + JSON.stringify(spline.t1));

    // -- exportFrame must not come back black (preserveDrawingBuffer)
    const exp = await session.evaluate(async () => {
      const blob = await window.welt.exportFrame('halle', 0.55, { width: 640, height: 360 });
      const bmp = await createImageBitmap(blob);
      const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
      const c = cv.getContext('2d'); c.drawImage(bmp, 0, 0);
      const d = c.getImageData(0, 0, cv.width, cv.height).data;
      let sum = 0, min = 255, max = 0, opaque = 0;
      for (let i = 0; i < d.length; i += 4) {
        const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
        sum += l; if (l < min) min = l; if (l > max) max = l;
        if (d[i + 3] === 255) opaque++;
      }
      const n = d.length / 4;
      // put it on disk for the record
      await fetch('/demo/verify/export-halle-t055.png', { method: 'PUT', body: blob });
      return { px: [bmp.width, bmp.height], bytes: blob.size, meanLuma: +(sum / n).toFixed(1),
               min, max, opaqueShare: +(opaque / n).toFixed(3) };
    });
    results.exportFrame3D = exp;
    check('exportFrame liefert ein nicht-schwarzes PNG (preserveDrawingBuffer greift)',
      exp.meanLuma > 25 && exp.max > 200 && exp.opaqueShare > 0.99,
      'Mittelhelligkeit ' + exp.meanLuma + ', Spanne ' + exp.min + '–' + exp.max);

    // -- budget, cold profile: the very first frame is the interesting one
    const budget = await session.evaluate(function (settleSrc) {
      const settle = eval('(' + settleSrc + ')');
      return new Promise(res => {
        const vh = innerHeight, start = (1.7 + 1.0 + 1.6) * vh, end = start + 1.6 * vh;
        let i = 0; const N = 140; const frames = []; let last = performance.now();
        const step = () => {
          const now = performance.now(); frames.push(now - last); last = now;
          window.scrollTo(0, start + (end - start) * (i / N));
          if (++i <= N) requestAnimationFrame(step);
          else {
            const f = frames.slice(6).sort((a, b) => a - b);
            const st = window.welt.stats().find(s => s.id === 'halle');
            const tm = window.halleSzene.timings;
            res({ frameMedian: +f[f.length >> 1].toFixed(2), frameP95: +f[Math.floor(f.length * 0.95)].toFixed(2),
                  frameMax: +f[f.length - 1].toFixed(2), framesOver20ms: f.filter(x => x > 20).length,
                  render: st,
                  driver: { precompileMs: +tm.precompileMs.toFixed(1), firstRenderMs: +tm.firstRenderMs.toFixed(1),
                            renders: tm.renders } });
          }
        };
        requestAnimationFrame(step);
      });
    }, settle.toString());
    results.threeBudget = budget;
    // Strictly the render budget from the contract. Frame pacing is judged
    // separately below, because a lone 22 ms frame on a busy machine is a
    // dropped frame, not a driver that is too slow.
    check('3D-Segment haelt das 8-ms-Budget, auch beim allerersten Frame',
      budget.render.maxMs <= 8 && budget.render.overBudget === 0,
      'max ' + budget.render.maxMs + ' ms bei ' + budget.render.frames + ' Aufrufen (Warmlauf ' +
      budget.driver.precompileMs + ' ms vor `ready`, erster echter Frame ' + budget.driver.firstRenderMs +
      ' ms); Bildtakt median ' + budget.frameMedian + ' ms, max ' + budget.frameMax + ' ms');

    // -- the whole five-segment chain, forwards and back, at desktop size
    const whole = await session.evaluate(() => new Promise(res => {
      const total = window.welt.segments.reduce((a, s) => a + s.scroll, 0) * innerHeight;
      const frames = []; let last = performance.now(); let i = 0; const N = 260;
      // A long frame that is NOT a render call has to be explainable. The one
      // known candidate is the clip arriving mid-scroll: fetch, blob, decoder
      // set-up. So note for every frame whether the video was still missing.
      const marks = [];
      const step = () => {
        const now = performance.now(); frames.push(now - last); last = now;
        const st = window.welt.state().find(s => s.kind === 'video');
        marks.push(st ? (st.ready ? 'ready' : (st.hasClip ? 'loading' : 'absent')) : '-');
        const p = i <= N / 2 ? (i / (N / 2)) : (2 - i / (N / 2));
        window.scrollTo(0, total * p);
        if (++i <= N) requestAnimationFrame(step);
        else {
          const body = frames.slice(6);
          const worst = body.indexOf(Math.max(...body)) + 6;
          const f = body.slice().sort((a, b) => a - b);
          const over = body.map((v, k) => [v, k]).filter(([v]) => v > 20);
          res({ frameMedian: +f[f.length >> 1].toFixed(2), frameMax: +f[f.length - 1].toFixed(2),
                framesOver20ms: over.length,
                worstFrame: { index: worst, ms: +frames[worst].toFixed(1), videoState: marks[worst],
                              videoBecameReadyAt: marks.indexOf('ready') },
                overFrames: over.map(([v, k]) => ({ ms: +v.toFixed(1), videoState: marks[k + 6] })),
                stats: window.welt.stats() });
        }
      };
      requestAnimationFrame(step);
    }));
    results.wholeChain = whole;
    // The contract's budget is about render(); a one-off hitch while the clip is
    // being fetched and handed to the decoder is a different animal and is named
    // as such rather than folded into the same number.
    check('ganze Kette vorwaerts und rueckwaerts: jeder render-Aufruf im Budget',
      whole.stats.every(s => s.overBudget === 0),
      whole.stats.map(s => s.id + ' max ' + s.maxMs + ' ms').join(', '));
    // Frame pacing is not the render budget. A single 25 ms frame on a machine
    // that is also running a dev server and another browser is one dropped
    // frame, not a stutter; what would matter is a visible hitch. So: count the
    // mild overruns, fail only on a real one, and say which state the video was
    // in when the worst frame happened (a clip arriving mid-scroll is the one
    // known legitimate cause of a long frame).
    const HITCH = 50;
    const hitches = whole.overFrames.filter(f => f.ms > HITCH && f.videoState === 'ready');
    check('Bildtakt: kein sichtbarer Hänger (> ' + HITCH + ' ms) ausserhalb des Clip-Ladens',
      hitches.length === 0,
      'median ' + whole.frameMedian + ' ms, ' + whole.framesOver20ms + ' Frames ueber 20 ms, ' +
      hitches.length + ' ueber ' + HITCH + ' ms; laengster ' + whole.worstFrame.ms +
      ' ms bei Videozustand "' + whole.worstFrame.videoState + '"');

    // three itself talks (missing WebGL extensions and the like). That is the
    // library's business; what has to stay silent is our own code.
    const pageLogs = await session.evaluate(() => window.__logs || []);
    const ours = pageLogs.filter(l => /^\[(scrub-welt|treiber-)/.test(l[1]));
    const foreign = pageLogs.filter(l => !/^\[(scrub-welt|treiber-)/.test(l[1]));
    results.threePageLogs = { ours, foreign };
    check('Seite mit 3D-Segment: keine Meldung aus Engine oder Treibern',
      ours.length === 0,
      ours.length ? JSON.stringify(ours) : 'keine eigene Meldung' +
        (foreign.length ? '; fremd: ' + foreign.map(f => f[1].slice(0, 60)).join(' | ') : ''));
  } finally {
    await browser.close();
  }
}

/* ======================================================================== *
 * 1b  the fallback: the same chain on a page WITHOUT three                  *
 * ======================================================================== */
async function threeFallbackChecks() {
  const browser = await launch({ width: 1280, height: 720, gpu: true });
  const { session } = browser;
  try {
    await session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__logs = []; (function(){ const w = console.warn, e = console.error;
        console.warn = function(){ window.__logs.push(['warn', Array.from(arguments).join(' ')]); return w.apply(console, arguments); };
        console.error = function(){ window.__logs.push(['error', Array.from(arguments).join(' ')]); return e.apply(console, arguments); }; })();`,
    });
    await session.goto(BASE + '/demo/ohne-three.html');
    await waitFor(() => session.evaluate(() => Boolean(window.welt)), 'engine mount');

    const r = await session.evaluate(function (settleSrc) {
      const settle = eval('(' + settleSrc + ')');
      return (async () => {
        const ok = await window.halleSzene.ready.catch(() => false);
        // scroll into the 3D segment and see what is actually on screen
        await settle((1.7 + 1.0 + 1.6 + 0.8) * innerHeight, 50);
        const el = document.querySelector('[data-sw-seg="halle"]');
        const cv = el.querySelector('canvas');
        const img = el.querySelector('img');
        let painted = null;
        if (cv) {
          const c = cv.getContext('2d');
          const d = c.getImageData(0, 0, cv.width, cv.height).data;
          let opaque = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 4) opaque++;
          painted = +(opaque / (d.length / 4)).toFixed(4);
        }
        return {
          ready: ok, available: window.halleSzene.available,
          error: window.halleSzene.error ? String(window.halleSzene.error) : null,
          hasCanvas: !!cv, canvasOpaqueShare: painted,
          posterSrc: img ? (img.getAttribute('src') || '').split('/').pop() : null,
          posterVisible: img ? img.clientWidth > 0 : false,
          segmentOpacity: +(parseFloat(el.style.opacity) || 0).toFixed(2),
          otherSegmentsAlive: window.welt.state().length,
          logs: window.__logs,
          engineStillRunning: window.welt.stats().some(s => s.frames > 1),
        };
      })();
    }, settle.toString());
    results.threeFallback = r;

    const errs = r.logs.filter(l => l[0] === 'error');
    const mine = r.logs.filter(l => /^\[treiber-three\]/.test(l[1]));
    const otherOurs = r.logs.filter(l => /^\[(scrub-welt|treiber-parallax)/.test(l[1]));
    results.threeFallbackOtherLogs = otherOurs;
    check('ohne three: Treiber faellt aus, ohne die Seite mitzureissen',
      r.available === false && r.ready === false && errs.length === 0 && r.engineStillRunning,
      'Fehler in der Konsole: ' + errs.length + ', Engine laeuft weiter: ' + r.engineStillRunning);
    check('ohne three: genau eine Meldung von treiber-three, und sie sagt was zu tun ist',
      mine.length === 1 && /three\.js not found/.test(mine[0][1]) && /pass it in as/.test(mine[0][1]),
      mine.length ? mine[0][1].slice(0, 100) + '…' : 'keine');
    check('ohne three: Canvas bleibt durchsichtig, das Standbild traegt das Segment',
      r.canvasOpaqueShare === 0 && r.posterVisible && r.posterSrc,
      'Deckung ' + r.canvasOpaqueShare + ', Poster ' + r.posterSrc);
  } finally {
    await browser.close();
  }
}

/* ======================================================================== *
 * 2  phone, emulated                                                        *
 * ======================================================================== */
async function phoneChecks() {
  const browser = await launch({ width: 390, height: 844, gpu: true });
  const { session } = browser;
  try {
    await session.setViewport({ width: 390, height: 844, dpr: 3, mobile: true, touch: true });
    await session.goto(BASE + '/demo/index.html');
    await waitFor(() => session.evaluate(() => Boolean(window.welt)), 'engine mount');

    // -- does the engine see a phone at all?
    const env = await session.evaluate(() => ({
      coarse: matchMedia('(hover: none) and (pointer: coarse)').matches,
      narrow: matchMedia('(max-width: 860px)').matches,
      dpr: devicePixelRatio, vw: innerWidth, vh: innerHeight,
      particles: document.querySelectorAll('.sw-pt').length,
      copyBottom: getComputedStyle(document.querySelector('.sw-copy')).bottom,
      hintBottom: getComputedStyle(document.querySelector('.sw-hint')).bottom,
      navVisible: getComputedStyle(document.querySelector('.sw-nav')).display,
    }));
    results.phoneEnv = env;
    check('Emulation greift: Coarse-Pointer und schmaler Viewport',
      env.coarse && env.narrow, 'dpr ' + env.dpr + ', ' + env.vw + '×' + env.vh);
    check('Partikel sind auf dem Telefon aus', env.particles === 0, env.particles + ' Partikel');
    check('Safe-Area-Abstaende stehen (Copy und Hinweis vom unteren Rand weg)',
      parseFloat(env.copyBottom) > 40 && parseFloat(env.hintBottom) > 10 && env.navVisible === 'none',
      'copy bottom ' + env.copyBottom + ', hint bottom ' + env.hintBottom + ', nav ' + env.navVisible);

    // -- clipMobile preferred where present
    const src = await session.evaluate(function (settleSrc) {
      const settle = eval('(' + settleSrc + ')');
      return (async () => {
        await settle(1.9 * innerHeight, 60);
        const wait = ms => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 40; i++) {
          const v = document.querySelector('[data-sw-seg="hof-zur-werkstatt"] video');
          if (v && v.readyState >= 1) break;
          await wait(150);
        }
        const reqs = performance.getEntriesByType('resource')
          .map(r => r.name).filter(n => /\.mp4$/.test(n)).map(n => n.split('/').pop());
        const st = window.welt.state().find(s => s.id === 'hof-zur-werkstatt');
        return { mp4Requests: reqs, ready: st.ready, duration: st.duration,
                 seekableEnd: st.seekableEnd };
      })();
    }, settle.toString());
    results.phoneClipChoice = src;
    check('mit clipMobile: die Mobilfassung wird geladen, nicht der Desktop-Clip',
      src.mp4Requests.length === 1 && src.mp4Requests[0].endsWith('-m.mp4'),
      JSON.stringify(src.mp4Requests));

    // -- fast flick under CPU throttling: does coalescing hold?
    await session.throttleCPU(6);
    const flick = await session.evaluate(() => new Promise(res => {
      const vh = innerHeight;
      const start = 1.7 * vh, end = start + 1.0 * vh;
      const v = document.querySelector('[data-sw-seg="hof-zur-werkstatt"] video');
      if (!v) return res({ error: 'no video element' });
      let i = 0; const N = 90;
      let busyTicks = 0, ticks = 0, maxOutstanding = 0, outstanding = 0, frozen = 0;
      let lastCT = v.currentTime, sameCT = 0;
      const seen = [];
      v.addEventListener('seeking', () => { outstanding++; if (outstanding > maxOutstanding) maxOutstanding = outstanding; });
      v.addEventListener('seeked', () => { outstanding = Math.max(0, outstanding - 1); });
      const step = () => {
        ticks++;
        if (v.seeking) busyTicks++;
        if (v.currentTime === lastCT) { sameCT++; if (sameCT > 25) frozen++; } else { sameCT = 0; lastCT = v.currentTime; }
        seen.push(+v.currentTime.toFixed(3));
        // a hard flick: three sweeps across the whole video band, both ways
        const p = Math.abs(((i / N) * 6) % 2 - 1);
        window.scrollTo(0, start + (end - start) * p);
        if (++i <= N) requestAnimationFrame(step);
        else {
          // let it settle on the final target
          let k = 0;
          const cool = () => (++k > 90 ? res({
            ticks, busyTicks, maxOutstanding, frozen,
            distinctTimes: new Set(seen).size,
            finalCurrentTime: +v.currentTime.toFixed(3),
            finalTarget: +(window.welt.state().find(s => s.id === 'hof-zur-werkstatt').target * v.duration).toFixed(3),
            duration: +v.duration.toFixed(3),
          }) : requestAnimationFrame(cool));
          requestAnimationFrame(cool);
        }
      };
      requestAnimationFrame(step);
    }));
    await session.throttleCPU(1);
    results.phoneFlick = flick;
    const converged = Math.abs(flick.finalCurrentTime - flick.finalTarget) < 0.12;
    check('schnelles Wischen bei 6x gedrosselter CPU: Clip friert nicht ein',
      flick.frozen === 0 && flick.distinctTimes > 8 && converged,
      flick.busyTicks + ' von ' + flick.ticks + ' rAF-Ticks trafen den Dekoder besetzt (= so viele Seeks waeren ohne Coalescing zusaetzlich in der Warteschlange gelandet); ' +
      flick.distinctTimes + ' verschiedene Zeitpunkte; Ende bei ' + flick.finalCurrentTime + ' s, Ziel ' + flick.finalTarget + ' s');
    check('nie mehr als ein Seek gleichzeitig offen', flick.maxOutstanding <= 1,
      'max ' + flick.maxOutstanding + ' offen');

    // -- height-only resize (the URL bar) must not move the page
    const bar = await session.evaluate(function (settleSrc) {
      const settle = eval('(' + settleSrc + ')');
      return (async () => {
        await settle(2.2 * innerHeight, 40);
        const before = { y: window.scrollY, track: document.querySelector('.sw-track').style.height, vh: innerHeight };
        return before;
      })();
    }, settle.toString());
    await session.setViewport({ width: 390, height: 760, dpr: 3, mobile: true, touch: true });
    await new Promise(r => setTimeout(r, 700));
    const barAfter = await session.evaluate(() => ({
      y: window.scrollY, track: document.querySelector('.sw-track').style.height, vh: innerHeight }));
    results.phoneUrlBar = { before: bar, after: barAfter };
    check('reine Hoehenaenderung (URL-Leiste): kein Sprung, kein Neu-Layout',
      barAfter.y === bar.y && barAfter.track === bar.track && barAfter.vh !== bar.vh,
      'Scroll ' + bar.y + ' -> ' + barAfter.y + ', Bahn ' + bar.track + ' -> ' + barAfter.track +
      ', Viewporthoehe ' + bar.vh + ' -> ' + barAfter.vh);
    await session.setViewport({ width: 390, height: 844, dpr: 3, mobile: true, touch: true });

    // -- a code scene in portrait: does the composition survive 9:16?
    const portrait = await session.evaluate(function (settleSrc) {
      const settle = eval('(' + settleSrc + ')');
      return (async () => {
        const out = {};
        for (const [id, y] of [['hof', 0.85], ['werkstatt', 3.5], ['halle', 5.1]]) {
          await settle(y * innerHeight, 50);
          const el = document.querySelector('[data-sw-seg="' + id + '"]');
          const cv = el.querySelector('canvas');
          if (!cv) { out[id] = { canvas: false }; continue; }
          const c = cv.getContext('2d');
          const d = c.getImageData(0, 0, cv.width, cv.height).data;
          // How much of the canvas is actually covered, and is there anything
          // left of the frame at all (a layer sliding out shows as a bare edge)?
          let opaque = 0, edgeOpaque = 0, edgeN = 0;
          const W = cv.width, H = cv.height;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 8) opaque++;
          for (let yy = 0; yy < H; yy += 4) {
            for (const xx of [0, 1, W - 2, W - 1]) {
              const i = (yy * W + xx) * 4 + 3;
              edgeN++; if (d[i] > 8) edgeOpaque++;
            }
          }
          out[id] = { canvas: true, size: [W, H],
                      coverage: +(opaque / (d.length / 4)).toFixed(4),
                      edgeCoverage: +(edgeOpaque / edgeN).toFixed(4) };
        }
        return out;
      })();
    }, settle.toString());
    results.phonePortraitScenes = portrait;
    const full = Object.values(portrait).every(v => v.canvas && v.coverage > 0.995 && v.edgeCoverage > 0.995);
    check('Code-Szenen fuellen das Hochformat lueckenlos (keine zweite Kette noetig)',
      full, Object.entries(portrait).map(([k, v]) => k + ' ' + (v.coverage ?? '-') + '/' + (v.edgeCoverage ?? '-')).join('  '));

    // screenshots for the eye
    for (const [name, y] of [['telefon-hof', 0.85], ['telefon-werkstatt', 3.5], ['telefon-halle', 5.1], ['telefon-video', 2.2]]) {
      await session.evaluate(function (settleSrc, yy) {
        const settle = eval('(' + settleSrc + ')');
        return settle(yy * innerHeight, 50);
      }, settle.toString(), y);
      const png = await session.screenshot();
      await fetch(BASE + '/demo/verify/' + name + '.png', { method: 'PUT', body: png });
    }
  } finally {
    await browser.close();
  }
}

/* ======================================================================== *
 * 2b  portrait WITHOUT clipMobile — the documented fallback                 *
 * ======================================================================== */
async function phoneNoMobileClipChecks() {
  const browser = await launch({ width: 390, height: 844, gpu: true });
  const { session } = browser;
  try {
    await session.setViewport({ width: 390, height: 844, dpr: 3, mobile: true, touch: true });
    // original.html carries no connectorsMobile and no clipMobile at all.
    await session.goto(BASE + '/demo/original.html');
    await waitFor(() => session.evaluate(() => Boolean(window.welt)), 'engine mount');
    const r = await session.evaluate(function (settleSrc) {
      const settle = eval('(' + settleSrc + ')');
      return (async () => {
        await settle(0.6 * innerHeight, 60);
        const wait = ms => new Promise(res => setTimeout(res, ms));
        for (let i = 0; i < 40; i++) {
          const st = window.welt.state().find(s => s.ready);
          if (st) break;
          await wait(150);
        }
        const reqs = performance.getEntriesByType('resource')
          .map(x => x.name).filter(n => /\.mp4$/.test(n)).map(n => n.split('/').pop());
        const st = window.welt.state().filter(s => s.kind === 'video');
        return { mp4Requests: Array.from(new Set(reqs)), anyReady: st.some(s => s.ready),
                 seekableEnd: (st.find(s => s.ready) || {}).seekableEnd };
      })();
    }, settle.toString());
    results.phoneNoMobileClip = r;
    check('ohne clipMobile: saubere Rueckfall auf den Desktop-Clip',
      r.mp4Requests.length === 1 && !r.mp4Requests[0].endsWith('-m.mp4') && r.anyReady && r.seekableEnd > 0,
      JSON.stringify(r.mp4Requests) + ', seekable bis ' + r.seekableEnd);
  } finally {
    await browser.close();
  }
}

/* ---- run ---------------------------------------------------------------- */
let failed = 0;
try {
  await threeChecks();
  await threeFallbackChecks();
  await phoneChecks();
  await phoneNoMobileClipChecks();
} catch (err) {
  check('Lauf ohne Abbruch', false, err.message);
}
failed = verdicts.filter(v => !v.pass).length;
process.stdout.write(JSON.stringify({ verdicts, results }, null, 2) + '\n');
process.stderr.write('\n' + (verdicts.length - failed) + '/' + verdicts.length + ' Pruefungen bestanden\n');
process.exit(failed ? 1 : 0);
