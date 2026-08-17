/* ============================================================================
   treiber-parallax — 2.5D camera flight from flat layers, zero dependencies
   ----------------------------------------------------------------------------
   Part of the scroll-welt fork of oso95/scroll-world (MIT — see
   ./LICENSE-scroll-world). This file is new, not upstream code.

   WHAT IT IS
     The cheap route to real camera movement without a video model: a handful of
     PNG/WebP layers with a depth value, moved and scaled apart by a camera path
     that is a pure function of t. Nearer layers travel further and grow faster
     than distant ones — that difference IS the depth cue.

   USAGE
     const farm = createParallaxSzene({
       background: '#EAD9BF',
       layers: [
         { src: 'assets/layers/sky.png',    depth: 0.00 },
         { src: 'assets/layers/hills.png',  depth: 0.35 },
         { src: 'assets/layers/barn.png',   depth: 0.65 },
         { src: 'assets/layers/grass.png',  depth: 1.00 },
       ],
       camera: { pan: { from: [0, 0], to: [0.10, -0.04] },
                 zoom: { from: 1.00, to: 1.34 },
                 parallax: 0.6, ease: 'smooth' },
       haze: { color: '#EAD9BF', strength: 0.45 },
       vignette: 0.3,
       overscan: 1.18,   // margin so a panning layer never shows its edge
     });

     mountScrollWelt(el, { segments: [ { kind:'szene', id:'farm', render: farm } ] });

   The returned function is `render(t, ctx)` per reference/api-vertrag.md, plus:
     render.ready   Promise, resolves when every layer has decoded. The engine
                    awaits it in exportFrame so a seam frame is never exported
                    half-loaded.
     render.layers  the layer records (with .img once decoded)
     render.state(t) the camera state at t, for debugging and for lining up a
                    following clip's motion with where the scene left off.

   CONVENTIONS
     depth      0 = far backdrop (barely moves), 1 = foreground (moves fully).
     pan        fractions of the canvas width/height. Positive x pans the CAMERA
                right, so the layers slide left.
     zoom       1 = fit-cover, >1 pushes in.
     parallax   how hard depth separates the layers. 0 = everything moves as one
                flat postcard, 0.6 = a far layer moves at 40% of a near one.
     Per-layer  x/y (extra offset in canvas fractions), scale, opacity, blend,
                fixed:true (ignores the camera entirely — for a vignette plate or
                a lens dirt overlay).

   PURITY
     Nothing but t decides the output. The only mutable state is the decoded
     image cache and a cached vignette gradient (keyed by size), neither of which
     changes what a given t looks like.

   COST
     Per frame: one fillRect for the background, one drawImage (+ one haze
     fillRect) per layer, one gradient fill if a vignette is on. A five-layer
     scene at 1440×900 stays far inside the 8 ms budget; the layer images are
     decoded once up front, not per frame.
   ========================================================================== */

(function (root) {
'use strict';

function createParallaxSzene(opts) {
  opts = opts || {};
  const cameraLandscape = opts.camera || {};
  // A second camera for tall canvases. Measured, not guessed: cover-fitting a
  // 16:9 layer set into a 9:16 phone canvas throws away about 70% of the width,
  // and a camera tuned for landscape then pushes the subject clean out of frame
  // — the barn of the demo scene ends up behind the right edge. The layers are
  // fine; the camera is what has to change. This is the hook the contract means
  // when it says a code scene can align its composition to the aspect ratio
  // instead of demanding a second set of files.
  const cameraPortrait = opts.cameraPortrait || null;
  const portraitBelow = (opts.portraitBelowAspect != null) ? opts.portraitBelowAspect : 0.95;
  const background = opts.background || null;
  const haze = opts.haze || null;
  const vignette = (opts.vignette != null) ? opts.vignette : 0;
  // Every layer is drawn this much larger than cover-fit. The margin is what
  // keeps a panning camera from sliding a layer's edge into frame; it has to be
  // at least the largest pan amount plus a little. 1 = no margin.
  const overscan = opts.overscan || 1;
  // Where the cover-crop sits when the canvas aspect differs from the layers'.
  // The defaults mirror the engine's CSS (object-position: center 42%), so a
  // scene and the video clip next to it crop identically — otherwise the seam
  // would jump vertically on any viewport that is not the layers' aspect.
  const anchorX = (opts.anchorX != null) ? opts.anchorX : 0.5;
  const anchorY = (opts.anchorY != null) ? opts.anchorY : 0.42;

  const layers = (opts.layers || []).map((l, i) => ({
    src: l.src,
    depth: (l.depth != null) ? l.depth : (i / Math.max(1, (opts.layers.length - 1))),
    x: l.x || 0, y: l.y || 0,
    scale: l.scale || 1,
    opacity: (l.opacity != null) ? l.opacity : 1,
    blend: l.blend || null,
    fixed: !!l.fixed,
    img: null, ok: false,
  }));
  // Far first: atmospheric haze is applied on top of everything drawn so far,
  // so the draw order has to run back to front.
  layers.sort((a, b) => a.depth - b.depth);

  const ready = Promise.all(layers.map(loadLayer)).then(warmLayers).then(() => layers);
  ready.catch(() => {});   // a missing layer must not turn into an unhandled rejection

  let gradCache = null, gradKey = '';

  // Resolve the camera for the shape of canvas we are actually drawing into.
  // Anything the portrait block leaves out falls back to the landscape camera,
  // so a scene can override only the zoom, or only the pan.
  function cameraFor(W, H) {
    const cam = (cameraPortrait && (W / H) < portraitBelow)
      ? Object.assign({}, cameraLandscape, cameraPortrait)
      : cameraLandscape;
    return {
      pan: cam.pan || { from: [0, 0], to: [0, 0] },
      zoom: cam.zoom || { from: 1, to: 1 },
      parallax: (cam.parallax != null) ? cam.parallax : 0.6,
      roll: cam.roll || null,
      ease: pickEase(cam.ease),
      anchorX: (cam.anchorX != null) ? cam.anchorX : anchorX,
      anchorY: (cam.anchorY != null) ? cam.anchorY : anchorY,
      overscan: cam.overscan || overscan,
    };
  }

  function render(t, ctx) {
    const c = ctx.ctx2d, W = ctx.width, H = ctx.height;
    const cam = cameraFor(W, H);
    const pan = cam.pan, zoom = cam.zoom, parallax = cam.parallax, roll = cam.roll;
    const anchorX = cam.anchorX, anchorY = cam.anchorY, overscan = cam.overscan;
    const e = cam.ease(clamp01(t));
    const px = lerp(pan.from[0], pan.to[0], e);
    const py = lerp(pan.from[1], pan.to[1], e);
    const z = lerp(zoom.from, zoom.to, e);
    const rot = roll ? lerp(roll.from, roll.to, e) * Math.PI / 180 : 0;

    if (background) { c.fillStyle = background; c.fillRect(0, 0, W, H); }

    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      if (L.ok) {
        // A near layer (depth 1) takes the full camera move, a far one (depth 0)
        // takes (1 - parallax) of it. Same factor drives the push-in, so the
        // whole frame stays coherent instead of shearing apart.
        const f = L.fixed ? 0 : (1 - parallax) + parallax * L.depth;
        const lz = L.fixed ? 1 : (1 + (z - 1) * f);
        const ox = L.fixed ? 0 : -px * W * f;
        const oy = L.fixed ? 0 : -py * H * f;

        const iw = L.img.naturalWidth || L.img.width;
        const ih = L.img.naturalHeight || L.img.height;
        const cover = Math.max(W / iw, H / ih) * lz * L.scale * (L.fixed ? 1 : overscan);
        const dw = iw * cover, dh = ih * cover;
        const dx = (W - dw) * anchorX + ox + L.x * W;
        const dy = (H - dh) * anchorY + oy + L.y * H;

        c.save();
        if (L.opacity !== 1) c.globalAlpha = L.opacity;
        if (L.blend) c.globalCompositeOperation = L.blend;
        if (rot && !L.fixed) { c.translate(W / 2, H / 2); c.rotate(rot * L.depth); c.translate(-W / 2, -H / 2); }
        c.drawImage(L.img, dx, dy, dw, dh);
        c.restore();
      }
      // Atmospheric perspective: wash everything up to and including this layer
      // toward the haze colour, strongest for the most distant plate.
      if (haze && !L.fixed && haze.strength) {
        const a = haze.strength * (1 - L.depth);
        if (a > 0.001) {
          c.save();
          c.globalAlpha = Math.min(1, a);
          c.fillStyle = haze.color || '#ffffff';
          c.fillRect(0, 0, W, H);
          c.restore();
        }
      }
    }

    if (vignette > 0) {
      const key = W + 'x' + H;
      if (key !== gradKey) {
        const g = c.createRadialGradient(W / 2, H * 0.48, Math.min(W, H) * 0.28,
                                         W / 2, H * 0.48, Math.max(W, H) * 0.72);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(0,0,0,1)');
        gradCache = g; gradKey = key;
      }
      c.save();
      c.globalAlpha = vignette;
      c.fillStyle = gradCache;
      c.fillRect(0, 0, W, H);
      c.restore();
    }

    if (opts.overlay) opts.overlay(e, ctx, { px, py, z });
  }

  render.ready = ready;
  render.layers = layers;
  // Camera state at t, for debugging and for lining a following clip's motion up
  // with where the scene left off. Takes the canvas shape, because since the
  // portrait camera exists there is no single answer without it.
  render.state = (t, W, H) => {
    const cam = cameraFor(W || 16, H || 9);
    const e = cam.ease(clamp01(t));
    return { e, portrait: cam !== cameraLandscape && !!cameraPortrait,
             panX: lerp(cam.pan.from[0], cam.pan.to[0], e),
             panY: lerp(cam.pan.from[1], cam.pan.to[1], e),
             zoom: lerp(cam.zoom.from, cam.zoom.to, e) };
  };
  return render;

  // Draw every layer once, off screen, at roughly the size it will really be
  // drawn at. Measured on this machine: the first scaled draw of a 2560×1440
  // layer costs ~7 ms, every later one ~0.5 ms — the browser builds its scaled
  // sampling state on first use, and warming at a token 64 px does NOT stand in
  // for it (measured: 6 ms still). Unwarmed, that cost lands on the first rAF
  // frame and blows the 8 ms budget once per scene. Here it lands in `ready`,
  // where nothing is waiting on a frame. Opt out with { warm: false }.
  function warmLayers() {
    if (opts.warm === false || typeof document === 'undefined') return;
    const vw = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 1280;
    const vh = (typeof window !== 'undefined' && window.innerHeight) ? window.innerHeight : 720;
    const cam = cameraFor(vw, vh);
    const zmax = Math.max(cam.zoom.from, cam.zoom.to) * cam.overscan;
    const w = Math.round(Math.min(2600, Math.max(640, vw * zmax)));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = Math.round(w * (vh / vw));
    const c = cv.getContext('2d');
    for (let i = 0; i < layers.length; i++) {
      if (!layers[i].ok) continue;
      try { c.drawImage(layers[i].img, 0, 0, cv.width, cv.height); } catch (e) {}
    }
    // Force the flush here rather than letting it surface inside a frame.
    try { c.getImageData(0, 0, 1, 1); } catch (e) {}
  }

  function loadLayer(L) {
    return new Promise(resolve => {
      if (!L.src) { resolve(L); return; }
      if (typeof L.src !== 'string') {   // already an Image/Canvas/ImageBitmap
        L.img = L.src; L.ok = true; resolve(L); return;
      }
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.decoding = 'async';
      const fail = () => {
        console.warn('[treiber-parallax] layer failed to load: ' + L.src);
        resolve(L);   // keep the scene alive with the layers that did load
      };
      // `load` only says the bytes arrived; the raster decode is deferred to the
      // first drawImage, which is what made the very first frame cost ~18 ms
      // instead of the 0.2 ms every later frame costs. decode() moves that work
      // in front of `ready`, where nobody is waiting on a frame.
      const done = () => { L.img = im; L.ok = true; resolve(L); };
      im.onload = () => {
        if (im.decode) im.decode().then(done, done);
        else done();
      };
      im.onerror = fail;
      im.src = L.src;
    });
  }
}

function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
function lerp(a, b, t) { return a + (b - a) * t; }
function pickEase(e) {
  if (typeof e === 'function') return e;
  if (e === 'linear' || e == null) return x => x;
  if (e === 'smooth') return x => x * x * (3 - 2 * x);
  if (e === 'in') return x => x * x;
  if (e === 'out') return x => 1 - (1 - x) * (1 - x);
  return x => x;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createParallaxSzene };
if (root) root.createParallaxSzene = createParallaxSzene;

}(typeof window !== 'undefined' ? window : null));
