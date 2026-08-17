/* ============================================================================
   treiber-three — optional Three.js driver: the camera rides a spline
   ----------------------------------------------------------------------------
   Part of the scroll-welt fork of oso95/scroll-world (MIT — see
   ./LICENSE-scroll-world). This file is new, not upstream code.

   WHEN TO USE IT
     Only when the project already ships three.js. A real 3D scene has no seam
     problem at all — the camera simply keeps flying — but it is the heaviest of
     the drivers and it drags a dependency into a page that otherwise has none.
     For flat art, treiber-parallax is the cheaper answer.

   USAGE
     const halle = createThreeSzene({
       // three is resolved in this order: opts.three -> window.THREE ->
       // dynamic import('three'). Nothing found = the segment falls back to its
       // still, with one clear console message. The page keeps running.
       spline: [[0,1.6,8], [2,1.8,4], [1,1.4,0], [-2,1.6,-5]],   // camera path
       lookAt: [[0,1,0], [0,1,-2], [0,1,-6]],                    // optional, own spline
       fov: 42, background: 0xEAD9BF,
       build: (three, scene, api) => {
         scene.add(new three.AmbientLight(0xffffff, 0.8));
         const m = new three.Mesh(new three.BoxGeometry(1,1,1),
                                  new three.MeshStandardMaterial({ color: 0x8FB98A }));
         scene.add(m);
       },
     });

     mountScrollWelt(el, { segments: [ { kind:'szene', id:'halle', render: halle,
                                         still: 'assets/halle.webp' } ] });

   HOW IT MEETS THE render(t, ctx) CONTRACT
     three renders into its own WebGL canvas; this driver blits that canvas into
     the 2d context the engine hands over. One extra full-frame copy per frame,
     in exchange for keeping the whole engine (including exportFrame, the seam
     bridge and the reduced-motion fallback) working unchanged.

   FAILURE BEHAVIOUR ("sauber ausfallen")
     No three, or a build callback that throws:
       - one console.warn naming the segment and what to do about it,
       - render.available === false, render.error holds the reason,
       - the canvas is left transparent so the segment's `still` shows through;
         if the segment has no still, a discreet notice is drawn instead so the
         page is not silently blank (override with { notice: false | true }).
     Nothing throws out of render(), so a missing dependency can never take the
     rAF loop of the whole page with it.

   PURITY
     Pure in t: the camera position, the look-at target and anything the caller
     animates in `update(t, …)` are read straight from t. Do not animate inside
     build() with a clock — scroll runs backwards.
   ========================================================================== */

(function (root) {
'use strict';

function createThreeSzene(opts) {
  opts = opts || {};
  const notice = (opts.notice != null) ? opts.notice : 'auto';
  const spline = opts.spline || [[0, 0, 6], [0, 0, 0]];
  const lookAtSpline = normaliseLookAt(opts.lookAt);
  const tension = (opts.tension != null) ? opts.tension : 0.5;

  let three = null, renderer = null, scene = null, camera = null;
  let state = 'loading';        // loading | ready | failed
  let error = null;
  let warned = false;
  let lastW = 0, lastH = 0, lastDpr = 0;
  // What the warm-up cost and what the first real frame still cost afterwards.
  // Kept because those two numbers are the whole argument for precompiling.
  const timings = { precompileMs: 0, firstRenderMs: 0, renders: 0 };

  const ready = resolveThree(opts.three)
    .then(async mod => {
      three = mod;
      buildScene();
      await precompile();
      state = 'ready';
      return true;
    })
    .catch(err => {
      state = 'failed';
      error = err;
      return false;
    });

  function buildScene() {
    renderer = new three.WebGLRenderer({
      antialias: opts.antialias !== false,
      alpha: opts.alpha === true,
      preserveDrawingBuffer: true,   // exportFrame reads the buffer back
    });
    renderer.setPixelRatio(1);       // the engine already works in device pixels
    scene = new three.Scene();
    if (opts.background != null && !opts.alpha) scene.background = new three.Color(opts.background);
    camera = new three.PerspectiveCamera(opts.fov || 45, 16 / 9, opts.near || 0.05, opts.far || 400);
    scene.add(camera);
    if (typeof opts.build === 'function') {
      opts.build(three, scene, { camera, renderer });
    }
  }

  // three compiles a shader program per material the first time it draws it.
  // Measured with a cold program cache: that lands as a single ~167 ms frame,
  // twenty times the whole frame budget, right when the segment first appears.
  // compileAsync does the same work before `ready` resolves, where no frame is
  // waiting; the throwaway render and the gl.finish() force the remaining lazy
  // uploads to happen there too instead of in the first real frame.
  async function precompile() {
    if (opts.precompile === false) return;
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    try {
      const w = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 1280;
      const h = (typeof window !== 'undefined' && window.innerHeight) ? window.innerHeight : 720;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      lastW = w; lastH = h; lastDpr = 1;
      const p = sampleSpline(spline, 0, tension);
      camera.position.set(p[0], p[1], p[2]);
      if (renderer.compileAsync) await renderer.compileAsync(scene, camera);
      else if (renderer.compile) renderer.compile(scene, camera);
      renderer.render(scene, camera);
      const gl = renderer.getContext && renderer.getContext();
      if (gl && gl.finish) gl.finish();
    } catch (e) {
      // A failed warm-up is not a failed scene: the first frame just pays for it.
      console.warn('[treiber-three] precompile skipped:', e && e.message ? e.message : e);
    }
    timings.precompileMs = ((typeof performance !== 'undefined') ? performance.now() : 0) - t0;
  }

  function render(t, ctx) {
    const c = ctx.ctx2d, W = ctx.width, H = ctx.height, dpr = ctx.dpr || 1;

    if (state !== 'ready') {
      if (state === 'failed') drawFallback(c, W, H, ctx);
      return;                       // loading: leave the poster visible
    }

    const tStart = performance.now();
    try {
      const pw = Math.max(1, Math.round(W * dpr)), ph = Math.max(1, Math.round(H * dpr));
      if (pw !== lastW || ph !== lastH || dpr !== lastDpr) {
        renderer.setSize(pw, ph, false);
        camera.aspect = pw / ph;
        camera.updateProjectionMatrix();
        lastW = pw; lastH = ph; lastDpr = dpr;
      }

      const tt = clamp01(t);
      const p = sampleSpline(spline, tt, tension);
      camera.position.set(p[0], p[1], p[2]);
      if (lookAtSpline) {
        const l = sampleSpline(lookAtSpline, tt, tension);
        camera.lookAt(l[0], l[1], l[2]);
      }
      if (typeof opts.update === 'function') opts.update(tt, { three, scene, camera, renderer, ctx });

      renderer.render(scene, camera);
      // Blit the WebGL frame into the engine's 2d surface. drawImage takes the
      // canvas at its pixel size; the 2d context is pre-scaled by dpr, so the
      // destination rectangle is given in CSS pixels.
      c.drawImage(renderer.domElement, 0, 0, W, H);
    } catch (e) {
      state = 'failed'; error = e;
      drawFallback(c, W, H, ctx);
    }
    if (timings.renders++ === 0) timings.firstRenderMs = performance.now() - tStart;
  }

  function drawFallback(c, W, H, ctx) {
    if (!warned) {
      warned = true;
      const seg = (ctx && ctx.segment && ctx.segment.id) ? ctx.segment.id : '?';
      console.warn('[treiber-three] segment "' + seg + '": ' + (error && error.message ? error.message : error) +
        ' — the segment falls back to its still. Load three.js (window.THREE), install the ' +
        '`three` package, or pass it in as { three }.');
    }
    const hasStill = !!(ctx && ctx.segment && (ctx.segment.still || ctx.segment.stillMobile));
    const show = (notice === true) || (notice === 'auto' && !hasStill);
    if (!show) return;              // transparent canvas: the poster shows through
    c.save();
    c.fillStyle = 'rgba(0,0,0,0.06)';
    c.fillRect(0, 0, W, H);
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.font = '600 15px ui-monospace, Menlo, monospace';
    c.textAlign = 'center';
    c.fillText('three.js not available — 3D segment skipped', W / 2, H / 2);
    c.restore();
  }

  render.ready = ready;
  render.state = () => state;
  render.timings = timings;
  Object.defineProperty(render, 'available', { get: () => state === 'ready' });
  Object.defineProperty(render, 'error', { get: () => error });
  render.scene = () => scene;
  render.camera = () => camera;
  render.dispose = () => {
    try { if (renderer) renderer.dispose(); } catch (e) {}
    renderer = null; scene = null; camera = null; state = 'failed';
    error = error || new Error('disposed');
  };
  return render;
}

// three is optional by design: nothing here throws if it is absent, the promise
// simply rejects and the driver switches to its fallback.
function resolveThree(explicit) {
  if (explicit) return Promise.resolve(explicit);
  if (typeof window !== 'undefined' && window.THREE) return Promise.resolve(window.THREE);
  // Dynamic import works from a classic script; a bare specifier only resolves
  // when the page has an import map or a bundler. Both failure modes land in
  // the same catch.
  try {
    return import('three')
      .then(m => m.default || m)
      .catch(() => Promise.reject(new Error('three.js not found (no window.THREE, no resolvable "three" module)')));
  } catch (e) {
    return Promise.reject(new Error('three.js not found and dynamic import is unavailable here'));
  }
}

function normaliseLookAt(la) {
  if (!la) return null;
  if (Array.isArray(la) && la.length && Array.isArray(la[0])) return la;   // already a spline
  if (Array.isArray(la) && la.length === 3) return [la, la];               // a fixed point
  return null;
}

// Catmull-Rom through the control points, clamped at both ends so t=0 and t=1
// land exactly on the first and last point — the seam frames have to be exact.
function sampleSpline(pts, t, tension) {
  const n = pts.length;
  if (n === 0) return [0, 0, 0];
  if (n === 1) return pts[0].slice();
  if (n === 2) return [lerp(pts[0][0], pts[1][0], t), lerp(pts[0][1], pts[1][1], t), lerp(pts[0][2], pts[1][2], t)];
  const seg = Math.min(n - 2, Math.floor(t * (n - 1)));
  const local = t * (n - 1) - seg;
  const p0 = pts[Math.max(0, seg - 1)], p1 = pts[seg], p2 = pts[seg + 1], p3 = pts[Math.min(n - 1, seg + 2)];
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) out[i] = catmull(p0[i], p1[i], p2[i], p3[i], local, tension);
  return out;
}

function catmull(p0, p1, p2, p3, t, s) {
  const t2 = t * t, t3 = t2 * t;
  const m1 = s * (p2 - p0), m2 = s * (p3 - p1);
  return (2 * t3 - 3 * t2 + 1) * p1 + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2 + (t3 - t2) * m2;
}

function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
function lerp(a, b, t) { return a + (b - a) * t; }

if (typeof module !== 'undefined' && module.exports) module.exports = { createThreeSzene };
if (root) root.createThreeSzene = createThreeSzene;

}(typeof window !== 'undefined' ? window : null));
