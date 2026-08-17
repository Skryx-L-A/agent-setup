/* ============================================================================
   scrub-welt — scroll-scrubbed segment chain with pluggable drivers
   ----------------------------------------------------------------------------
   FORK NOTICE
     Derived from `scrub-engine.js` of oso95/scroll-world (MIT, commit 71cc36d).
     The upstream licence text is kept verbatim in ./LICENSE-scroll-world, the
     upstream manual in ./ORIGINAL-SKILL.md. Copyright of the original code
     remains with its authors; this fork is distributed under the same MIT terms.

     What is UPSTREAM (unchanged in behaviour, only re-plumbed onto the flat
     segment chain): blob-seeking, seek coalescing, iOS priming, lazy clip
     prefetch, the seam crossfade, the route rail, the copy overlay, safe-area
     handling, the "ignore height-only resizes on touch" rule, the linger easing,
     particles/atmosphere and the whole CSS block.

     What is OURS (marked [WELT] at each site):
       1. A flat `segments` chain replaces `sections` + `connectors`.
       2. Old configs are NORMALISED into that chain, so an untouched
          scroll-world config keeps running (see normaliseSegments).
       3. Three segment kinds — `video` (upstream behaviour), `szene`
          (render(t, ctx), drawn fresh every frame) and `still`.
       4. exportFrame(segmentId, t) -> Promise<Blob> (PNG), callable headless.
       5. A small return API (state/stats/destroy) for build steps and tests.

   USAGE (new form)
     mountScrollWelt(document.getElementById('welt'), {
       brand: { name: 'Pearl & Co.', href: '#top' },
       segments: [
         { kind: 'szene', id: 'farm', scroll: 1.6, linger: 0.45,
           render: farmRender,            // (t, ctx) => void, pure in t
           still: 'assets/farm.webp',     // poster + reduced-motion fallback
           eyebrow: '…', title: '…', body: '…', tags: ['…'], accent: '#8FB98A' },
         { kind: 'video', id: 'farm-zu-laden', scroll: 0.9,
           clip: 'assets/vid/c1.mp4', clipMobile: 'assets/vid/c1-m.mp4' },
         { kind: 'szene', id: 'laden', render: ladenRender, title: '…' },
       ],
     });

   USAGE (old form — still supported, byte-for-byte the same config object)
     mountScrollWelt(el, { sections: [...], connectors: [...] })
     window.mountScrollWorld is aliased to this function, so an existing page
     only has to swap the <script src>.

   SEGMENT KINDS
     video  clip scrubbed by scroll: currentTime = t × duration. Needs a real
            frame handover at both seams (see ORIGINAL-SKILL.md step 5).
     szene  render(t, ctx) into a canvas, every frame fresh. No model, no seam
            problem, and exportFrame can hand any frame to a video build step.
     still  one image; t only drives the copy.

   render(t, ctx) CONTRACT  (reference/api-vertrag.md)
     ctx = { canvas, ctx2d, width, height, dpr, segment, reducedMotion }
     - width/height are LOGICAL (CSS) pixels; the 2d transform is pre-scaled by
       dpr and the surface is cleared before every call, so draw in CSS px.
     - Pure function of t. No Date.now(), no frame counter, no carry-over state:
       scroll is a scrubber, it runs backwards and skips values on a fast flick.
     - t = 0 and t = 1 are the seam frames and must be exactly reproducible.
     - Budget 8 ms. api.stats() reports per-segment render cost; pass
       { debug: true } to get a console warning when a segment blows the budget.
     - reducedMotion: the engine already handles the fallback (poster if the
       segment has a `still`, otherwise a single render at `staticT`, default 0);
       the flag is passed on so a scene can simplify itself further.

   THEME (CSS custom properties; set on the container or :root to override)
     --sw-bg  --sw-ink  --sw-ink-soft  --sw-accent
     --sw-font-display  --sw-font-body

   REQUIREMENTS ON VIDEO ASSETS (unchanged from upstream)
     native-res, crf~20, -g 8, +faststart, no audio (see pipeline.md); a clip's
     endpoints must be the neighbouring segments' ACTUAL frames. For a `szene`
     neighbour that frame costs nothing — exportFrame delivers it exactly.
     Clips are loaded as a Blob (always seekable), so no HTTP byte-range needed.
   ========================================================================== */

/* [WELT] Normalise both config shapes into one flat chain.
   Old shape: dive0, conn0, dive1, conn1, … — exactly the order, the widths and
   the poster/accent inheritance the upstream engine built internally, so a
   scroll-world config produces an identical chain here. */
function normaliseSegments(config) {
  const DIVE_W = config.diveScroll || 1.3;
  const CONN_W = config.connScroll || 0.9;

  if (Array.isArray(config.segments) && config.segments.length) {
    return config.segments.map((s, i) => {
      const kind = s.kind || (s.render ? 'szene' : (s.clip ? 'video' : 'still'));
      return {
        kind: kind,
        id: s.id || (kind + '-' + i),
        label: s.label || '',
        accent: s.accent || '',
        w: s.scroll || DIVE_W,
        linger: s.linger || 0,
        clip: s.clip || null, clipM: s.clipMobile || null,
        still: s.still || null, stillM: s.stillMobile || null,
        render: (kind === 'szene') ? (s.render || null) : null,
        staticT: (s.staticT != null) ? s.staticT : 0,
        copy: pickCopy(s),
        src: s,
      };
    });
  }

  const SECTIONS = config.sections || [];
  const CONNECTORS = config.connectors || [];
  const CONNECTORS_M = config.connectorsMobile || [];
  const N = SECTIONS.length;
  const out = [];
  SECTIONS.forEach((s, i) => {
    out.push({
      kind: 'video',
      id: s.id || ('dive-' + i),
      label: s.label || '',
      accent: s.accent || '',
      w: s.scroll || DIVE_W,
      linger: s.linger || 0,
      clip: s.clip || null, clipM: s.clipMobile || null,
      still: s.still || null, stillM: s.stillMobile || null,
      render: null, staticT: 0,
      copy: pickCopy(s),
      src: s,
    });
    // A connector stays optional: if connectors[i] is falsy the two dives simply
    // crossfade directly, exactly as upstream.
    if (i < N - 1 && CONNECTORS[i]) {
      const next = SECTIONS[i + 1];
      out.push({
        kind: 'video',
        id: (s.id || i) + '--conn',
        label: '', accent: next.accent || '',
        w: CONN_W, linger: 0,
        clip: CONNECTORS[i], clipM: CONNECTORS_M[i] || null,
        still: next.still || null, stillM: next.stillMobile || null,
        render: null, staticT: 0,
        copy: null,
        src: null,
      });
    }
  });
  return out;
}

function pickCopy(s) {
  const has = s.eyebrow || s.title || s.body || (s.tags && s.tags.length) || s.cta;
  if (!has) return null;
  return { eyebrow: s.eyebrow, title: s.title, body: s.body, tags: s.tags, cta: s.cta };
}

function mountScrollWelt(container, config) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Phone detection. `coarse` is captured once (input type doesn't change mid-session);
  // the ≤860px query is read live via isMobile() so a desktop resize/DevTools toggle
  // switches sources and seek behaviour without a reload.
  const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  const smallMQ = window.matchMedia('(max-width: 860px)');
  const isMobile = () => coarse || smallMQ.matches;
  const CROSSFADE = (config.crossfade != null) ? config.crossfade : 0.12;  // seam dissolve width (vh)
  const MAX_DPR = config.maxDPR || 2;
  const DEBUG = !!config.debug;

  const SEGMENTS = normaliseSegments(config);
  const NSEG = SEGMENTS.length;
  if (!NSEG) return null;

  // [WELT] Route rail / nav / copy run over the segments that actually say
  // something — upstream that was "the dives", here it is "has copy or a label".
  // For a normalised old config those are precisely the dives again.
  const STOPS = [];
  SEGMENTS.forEach((s, i) => {
    s.i = i;
    s.isStop = !!(s.copy || s.label);
    if (s.isStop) { s.stopIndex = STOPS.length; STOPS.push(s); }
  });
  if (!STOPS.length) { SEGMENTS[0].isStop = true; SEGMENTS[0].stopIndex = 0; STOPS.push(SEGMENTS[0]); }
  const N = STOPS.length;
  // For a segment without copy: which stop does the route belong to at each end.
  SEGMENTS.forEach((s, i) => {
    let before = 0, after = N - 1;
    for (let k = i; k >= 0; k--) if (SEGMENTS[k].isStop) { before = SEGMENTS[k].stopIndex; break; }
    for (let k = i; k < NSEG; k++) if (SEGMENTS[k].isStop) { after = SEGMENTS[k].stopIndex; break; }
    s.stopBefore = before; s.stopAfter = after;
  });

  injectCSS();
  container.classList.add('sw-root');

  // ---- DOM ----
  const sky = el('div', 'sw-sky');
  if (config.atmosphere !== false) {
    sky.appendChild(el('div', 'sw-sky__grad'));
    sky.appendChild(el('div', 'sw-sky__glow'));
  }
  const particles = el('div', 'sw-particles'); sky.appendChild(particles);

  const scrollbar = el('div', 'sw-scrollbar');
  const scrollbarFill = el('span'); scrollbar.appendChild(scrollbarFill);

  const topbar = el('div', 'sw-topbar');
  if (config.brand) {
    const brand = el('a', 'sw-brand'); brand.href = (config.brand.href || '#');
    brand.appendChild(el('span', 'sw-brand__mark'));
    const nm = el('span', 'sw-brand__name'); nm.textContent = config.brand.name || ''; brand.appendChild(nm);
    topbar.appendChild(brand);
  }
  const nav = el('nav', 'sw-nav'); if (config.nav !== false) topbar.appendChild(nav);
  if (config.cta && config.cta.label) {
    const c = el('a', 'sw-topcta'); c.href = config.cta.href || '#'; c.textContent = config.cta.label;
    topbar.appendChild(c);
  }

  const stage = el('div', 'sw-stage');
  const copylayer = el('div', 'sw-copylayer');
  const route = el('div', 'sw-route');
  const hint = el('div', 'sw-hint');
  const hintText = el('span'); hintText.textContent = config.hint || 'scroll'; hint.appendChild(hintText);
  hint.appendChild(el('i'));
  const track = el('div', 'sw-track');

  [sky, scrollbar, topbar, stage, copylayer, route, hint, track].forEach(n => container.appendChild(n));

  // ---- one scene box per segment ----
  SEGMENTS.forEach(s => {
    const scene = el('div', 'sw-scene');
    scene.style.setProperty('--sw-accent', s.accent || '');
    scene.dataset.swSeg = s.id;
    scene.dataset.swKind = s.kind;

    // The still is the poster for every kind: it backs a video until the first
    // real frame paints, it IS the picture for `still`, and it sits behind the
    // canvas of a `szene` (so a scene that fails to draw shows the poster
    // instead of a hole).
    const img = el('img', 'sw-scene__still'); img.alt = ''; img.decoding = 'async'; img.loading = 'lazy';
    const poster = (isMobile() && s.stillM) ? s.stillM : s.still;
    if (poster) img.src = poster;
    scene.appendChild(img);

    s.el = scene; s.img = img; s.video = null; s.hasClip = false;
    s.clipPromise = null; s.ready = false; s.cur = 0; s.target = 0; s.visible = false;
    s.canvas = null; s.ctx2d = null; s.rctx = null; s.lastDrawn = -1; s.dirty = true;
    s.cssW = 0; s.cssH = 0; s.dpr = 1;
    s.stat = { frames: 0, lastMs: 0, maxMs: 0, sumMs: 0, over: 0, warned: false };

    // [WELT] A szene gets a canvas. Under reduced motion with a poster present
    // we skip the canvas entirely — the poster IS the fallback, at zero cost.
    if (s.kind === 'szene' && s.render && !(reduce && poster)) {
      const cv = el('canvas', 'sw-scene__canvas');
      scene.appendChild(cv);
      s.canvas = cv; s.ctx2d = cv.getContext('2d');
      s.rctx = { canvas: cv, ctx2d: s.ctx2d, width: 0, height: 0, dpr: 1,
                 segment: s.src || s, reducedMotion: reduce };
      // A driver that needs assets (parallax layers, a three.js module) says so
      // by hanging a promise on the render function. Without this the first
      // frame — drawn while the images were still decoding — would stay on
      // screen: t has not moved, so nothing would ask for a redraw.
      const rdy = s.render.ready;
      if (rdy && typeof rdy.then === 'function') rdy.then(mark, mark);
      function mark() { s.dirty = true; }
    }
    stage.appendChild(scene);
  });

  // ---- copy / route / nav, one per stop ----
  const copies = [], dots = [];
  STOPS.forEach((s, i) => {
    const c = el('article', 'sw-copy'); c.style.setProperty('--sw-accent', s.accent || '');
    const cp = s.copy || {};
    c.innerHTML =
      `<span class="sw-copy__num">${pad(i + 1)} / ${pad(N)}</span>` +
      (cp.eyebrow ? `<span class="sw-copy__eyebrow">${esc(cp.eyebrow)}</span>` : '') +
      (cp.title ? `<h2 class="sw-copy__title">${esc(cp.title)}</h2>` : '') +
      (cp.body ? `<p class="sw-copy__body">${esc(cp.body)}</p>` : '') +
      (cp.tags && cp.tags.length ? `<ul class="sw-copy__tags">${cp.tags.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '') +
      (cp.cta ? `<div class="sw-copy__cta">${ctaBtns(cp.cta)}</div>` : '');
    copylayer.appendChild(c); copies.push(c);

    const dot = el('button', 'sw-route__dot'); dot.style.setProperty('--sw-accent', s.accent || '');
    dot.innerHTML = `<span class="sw-route__label">${esc(s.label || (s.copy && s.copy.title) || '')}</span><i></i>`;
    dot.addEventListener('click', () => jumpTo(i)); route.appendChild(dot); dots.push(dot);

    if (config.nav !== false) {
      const b = el('button', 'sw-nav__item'); b.textContent = s.label || (s.copy && s.copy.title) || '';
      b.addEventListener('click', () => jumpTo(i)); nav.appendChild(b);
    }
  });

  // ---- math ----
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
  // Per-segment dwell: monotone remap of scroll→time so the camera settles
  // mid-segment (where the copy peaks) and moves quicker near the seams.
  // L=0 linear, L=1 full mid pause. f(0)=0, f(1)=1 always, so seam frames are
  // untouched.
  const lingerEase = (x, L) => { L = clamp(L); const c = x - 0.5; return (1 - L) * x + L * (4 * c * c * c + 0.5); };
  let vh = window.innerHeight, stageX = 0, totalW = 0, activeIndex = -1, ticking = false;
  let laidOutW = window.innerWidth;   // width the current layout was computed at (see onResize)
  let rafId = 0, dead = false;

  function layout() {
    vh = window.innerHeight;
    laidOutW = window.innerWidth;
    stageX = window.innerWidth > 860 ? 4 : 0;
    let off = 0;
    SEGMENTS.forEach(s => { s.start = off * vh; off += s.w; s.end = off * vh; });
    totalW = off;
    track.style.height = (totalW * vh + vh) + 'px';   // +1vh so the last flight completes
    SEGMENTS.forEach(sizeCanvas);
    read();
  }

  // [WELT] Canvas backing store follows the viewport and the device pixel ratio.
  function sizeCanvas(s) {
    if (!s.canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    if (s.cssW === w && s.cssH === h && s.dpr === dpr) return;
    s.cssW = w; s.cssH = h; s.dpr = dpr;
    s.canvas.width = Math.round(w * dpr);
    s.canvas.height = Math.round(h * dpr);
    s.canvas.style.width = w + 'px';
    s.canvas.style.height = h + 'px';
    s.rctx.width = w; s.rctx.height = h; s.rctx.dpr = dpr;
    s.dirty = true;   // backing store was wiped by the resize
  }

  function jumpTo(i) {
    const seg = STOPS[i];
    window.scrollTo({ top: seg.start + (seg.end - seg.start) * 0.5, behavior: reduce ? 'auto' : 'smooth' });
  }

  // ---- clip loading (upstream, wrapped in a promise so exportFrame can wait) ----
  function loadClip(s, force) {
    // Under prefers-reduced-motion we never load clips for playback — the stills
    // stay up and simply cross-dissolve. `force` is for exportFrame, which is a
    // build-step tool and must be able to reach any frame regardless.
    if (s.kind !== 'video' || !s.clip) return null;
    if (!force && reduce) return null;
    if (s.clipPromise) return s.clipPromise;
    // Upstream retried a failed load on every scroll frame. A transient failure
    // deserves a second try; a 404 does not deserve a hundred. Three attempts,
    // one log line.
    if (force) s.clipTries = 0;   // an explicit export asks again, however often
    s.clipTries = (s.clipTries || 0) + 1;
    if (s.clipTries > 3) return null;
    // Serve the lighter mobile encode on phones when one was provided.
    const url = (isMobile() && s.clipM) ? s.clipM : s.clip;
    s.clipPromise = fetch(url)
      .then(r => r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status + ' for ' + url)))
      .then(blob => new Promise((resolve, reject) => {
        const v = document.createElement('video');
        v.className = 'sw-scene__video';
        v.muted = true; v.playsInline = true; v.preload = 'auto';
        v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
        s.objectURL = URL.createObjectURL(blob);
        v.src = s.objectURL;
        v.addEventListener('loadedmetadata', () => { s.ready = true; read(); resolve(v); });
        v.addEventListener('error', () => reject(new Error('decode failed for ' + url)));
        // Reveal the video (hide the still poster) only once a real frame has
        // painted — on iOS a seeked-but-never-played muted video stays blank, so
        // hiding the still on metadata alone would flash an empty scene.
        v.addEventListener('seeked', () => { s.el.classList.add('has-clip'); }, { once: true });
        v.addEventListener('loadeddata', () => { try { v.pause(); } catch (e) {} if (userReady) primeVideo(v); });
        s.el.appendChild(v); s.video = v; s.hasClip = true;
      }))
      .catch(err => {
        s.clipPromise = null;
        if (s.clipTries >= 3) console.warn('[scrub-welt] clip load failed after ' + s.clipTries + ' tries:', err.message);
        return null;
      });
    return s.clipPromise;
  }

  function read() {
    if (dead) return;
    const y = window.scrollY || window.pageYOffset;
    const fade = CROSSFADE * vh;
    let ci = 0;
    for (let i = 0; i < NSEG; i++) if (y >= SEGMENTS[i].start) ci = i;

    for (let i = 0; i < NSEG; i++) {
      const s = SEGMENTS[i];
      if (y > s.start - 1.6 * vh && y < s.end + 1.6 * vh) loadClip(s);
      const local = clamp((y - s.start) / (s.end - s.start), 0, 1);
      s.target = s.linger ? lingerEase(local, s.linger) : local;
      let outside = 0;
      if (y < s.start) outside = s.start - y; else if (y > s.end) outside = y - s.end;
      const op = smooth(1 - outside / fade);
      s.el.style.opacity = op; s.visible = op > 0.001;
      s.el.style.zIndex = (i === ci) ? '120' : String(100 + Math.round(op * 10));
      // Poster Ken-Burns while a clip is still loading (upstream). A `still`
      // segment holds its frame — per the contract t only moves its copy.
      if (s.kind === 'video' && (!s.hasClip || !s.ready)) {
        const sc = reduce ? 1 : 1.03 + local * 0.14;
        s.img.style.transform = `translateX(${stageX - 2}vw) scale(${sc.toFixed(3)})`;
      }
    }

    for (let i = 0; i < N; i++) {
      const seg = STOPS[i];
      const pr = clamp((y - seg.start) / (seg.end - seg.start), 0, 1);
      const before = y < seg.start, after = y > seg.end;
      let cop;
      if (i === 0) cop = after ? 0 : smooth(1 - pr / 0.62);            // greets on landing
      else if (i === N - 1) cop = before ? 0 : smooth(pr / 0.4);       // holds CTA at the end
      else cop = (before || after) ? 0 : smooth(1 - Math.abs(pr - 0.5) / 0.5);
      const c = copies[i];
      c.style.opacity = cop;
      c.style.transform = reduce ? 'none' : `translateY(${(0.5 - pr) * 4}vh)`;
      c.style.pointerEvents = cop > 0.5 ? 'auto' : 'none';
    }

    const cur = SEGMENTS[ci];
    const near = clamp(cur.isStop ? cur.stopIndex
      : (((y - cur.start) / (cur.end - cur.start)) > 0.5 ? cur.stopAfter : cur.stopBefore), 0, N - 1);
    if (near !== activeIndex) {
      activeIndex = near;
      dots.forEach((d, k) => d.classList.toggle('is-active', k === near));
      nav.querySelectorAll('.sw-nav__item').forEach((n, k) => n.classList.toggle('is-active', k === near));
      container.style.setProperty('--sw-accent', STOPS[near].accent || '');
    }
    scrollbarFill.style.transform = `scaleX(${clamp(y / (totalW * vh))})`;
    hint.style.opacity = clamp(1 - y / (0.5 * vh));
    if (particles) particles.style.transform = `translate3d(0, ${-y * 0.05}px, 0)`;
    ticking = false;
  }

  // [WELT] One szene draw. Cleared, dpr-scaled, timed, guarded — a throwing
  // scene must not kill the rAF loop for the whole page.
  function drawSzene(s, t, force) {
    if (!s.canvas || !s.render) return;
    if (!force && Math.abs(t - s.lastDrawn) < 0.0004) return;
    const c = s.ctx2d;
    c.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    c.clearRect(0, 0, s.cssW, s.cssH);
    const t0 = performance.now();
    try {
      s.render(clamp(t), s.rctx);
    } catch (e) {
      if (!s.stat.warned) { s.stat.warned = true; console.warn('[scrub-welt] render() threw in segment "' + s.id + '":', e); }
    }
    const dt = performance.now() - t0;
    const st = s.stat;
    st.frames++; st.lastMs = dt; st.sumMs += dt;
    if (dt > st.maxMs) st.maxMs = dt;
    if (dt > 8) {
      st.over++;
      if (DEBUG && st.over === 1) console.warn('[scrub-welt] segment "' + s.id + '" render took ' + dt.toFixed(1) + ' ms (budget 8 ms)');
    }
    s.lastDrawn = t; s.dirty = false;
  }

  function raf() {
    if (dead) return;
    const eps = isMobile() ? 0.02 : 0.008;   // coarser seek step on phones = fewer decodes
    for (let i = 0; i < NSEG; i++) {
      const s = SEGMENTS[i];

      if (s.kind === 'szene') {
        if (!s.canvas) continue;
        // Reduced motion: draw the single static frame once, then leave it alone.
        if (reduce) { if (s.dirty) drawSzene(s, clamp(s.staticT), true); continue; }
        if (!s.visible && !s.dirty && Math.abs(s.cur - s.target) < 0.002) continue;
        s.cur += (s.target - s.cur) * 0.18;
        if (Math.abs(s.target - s.cur) < 0.0005) s.cur = s.target;
        drawSzene(s, s.cur, s.dirty);
        continue;
      }

      if (!s.hasClip || !s.ready || !s.video) continue;
      // Never queue a seek while the decoder is still resolving the last one.
      // On phones a fast flick would otherwise pile up seeks and freeze the clip;
      // cur keeps lerping, so we snap to the latest target the moment it's free.
      if (s.video.seeking) continue;
      if (!s.visible && Math.abs(s.cur - s.target) < 0.002) continue;
      s.cur += (s.target - s.cur) * (reduce ? 1 : 0.18);
      const dur = s.video.duration || 1;
      const t = clamp(s.cur, 0, 0.999) * dur;
      if (Math.abs(s.video.currentTime - t) > eps) { try { s.video.currentTime = t; } catch (e) {} }
    }
    rafId = requestAnimationFrame(raf);
  }

  // iOS needs a user gesture before a muted video will decode/paint reliably. On the
  // first touch we prime every loaded clip (muted play→pause) so the first seek is
  // instant instead of showing a blank frame. `userReady` also makes freshly-loaded
  // clips prime themselves (see loadClip).
  let userReady = false;
  function primeVideo(v) {
    if (!isMobile() || !v) return;
    try { const p = v.play(); if (p && p.then) p.then(() => { try { v.pause(); } catch (e) {} }).catch(() => {}); }
    catch (e) {}
  }
  function onFirstGesture() {
    if (userReady) return;
    userReady = true;
    SEGMENTS.forEach(s => primeVideo(s.video));
  }
  window.addEventListener('pointerdown', onFirstGesture, { once: true, passive: true });
  window.addEventListener('touchstart', onFirstGesture, { once: true, passive: true });

  // ======================================================================
  // [WELT] exportFrame — the seam bridge
  // ----------------------------------------------------------------------
  //   exportFrame(segmentId, t, opts?) -> Promise<Blob>   (image/png)
  //   opts = { width, height, dpr, reducedMotion }
  // Headless-callable: it needs no scroll position and no visibility. A build
  // step drives it through Playwright to hand a code scene's t=1 frame to a
  // video model as the next clip's start image, and to pick up a clip's last
  // frame for the following scene's t=0 backdrop.
  // reducedMotion defaults to FALSE here even when the page is in reduced
  // motion: the export is the frame the seam has to match, not the fallback.
  // ======================================================================
  function findSegment(id) {
    for (let i = 0; i < NSEG; i++) if (SEGMENTS[i].id === id) return SEGMENTS[i];
    return null;
  }

  function toBlob(canvas) {
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob returned null')), 'image/png');
      } catch (e) { reject(e); }
    });
  }

  // cover-fit an image/video/canvas source into w×h, like CSS object-fit: cover
  // with object-position: center 42% (the value the stage uses).
  function drawCover(c, src, sw, sh, w, h) {
    if (!sw || !sh) return;
    const scale = Math.max(w / sw, h / sh);
    const dw = sw * scale, dh = sh * scale;
    c.drawImage(src, (w - dw) / 2, (h - dh) * 0.42, dw, dh);
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('image load failed: ' + url));
      im.src = url;
    });
  }

  async function exportFrame(segmentId, t, opts) {
    opts = opts || {};
    const s = findSegment(segmentId);
    if (!s) throw new Error('exportFrame: no segment with id "' + segmentId + '"');
    const w = Math.max(1, Math.round(opts.width || window.innerWidth));
    const h = Math.max(1, Math.round(opts.height || window.innerHeight));
    const dpr = opts.dpr || 1;
    const cv = document.createElement('canvas');
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const tt = clamp(t);

    if (s.kind === 'szene' && s.render) {
      // A driver may need assets (parallax layers, a three.js module). It says so
      // by hanging a promise on the render function.
      if (s.render.ready && typeof s.render.ready.then === 'function') await s.render.ready;
      const rctx = { canvas: cv, ctx2d: c, width: w, height: h, dpr: dpr,
                     segment: s.src || s,
                     reducedMotion: opts.reducedMotion != null ? !!opts.reducedMotion : false };
      s.render(tt, rctx);
      return toBlob(cv);
    }

    if (s.kind === 'video' && s.clip) {
      const v = await loadClip(s, true);
      if (!v) throw new Error('exportFrame: clip could not be loaded for "' + segmentId + '"');
      if (!v.duration || !isFinite(v.duration)) {
        await new Promise(res => v.addEventListener('loadedmetadata', res, { once: true }));
      }
      const want = clamp(tt, 0, 0.999999) * v.duration;
      await new Promise((res, rej) => {
        const to = setTimeout(() => rej(new Error('exportFrame: seek timed out on "' + segmentId + '"')), 8000);
        v.addEventListener('seeked', () => { clearTimeout(to); res(); }, { once: true });
        try { v.currentTime = want; } catch (e) { clearTimeout(to); rej(e); }
      });
      drawCover(c, v, v.videoWidth, v.videoHeight, w, h);
      return toBlob(cv);
    }

    const poster = s.still || s.stillM;
    if (!poster) throw new Error('exportFrame: segment "' + segmentId + '" has nothing to draw');
    const im = await loadImage(poster);
    drawCover(c, im, im.naturalWidth, im.naturalHeight, w, h);
    return toBlob(cv);
  }

  // Convenience for headless callers that cannot carry a Blob across the bridge.
  // Goes through exportFrame, so the Blob path is the one being exercised.
  async function exportFrameDataURL(segmentId, t, opts) {
    const blob = await exportFrame(segmentId, t, opts);
    return await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(fr.error || new Error('FileReader failed'));
      fr.readAsDataURL(blob);
    });
  }

  // ---- lifecycle ----
  // Particles are a per-frame cost we can't afford alongside video scrubbing on a phone.
  seedParticles(particles, reduce || coarse);
  const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(read); } };
  window.addEventListener('scroll', onScroll, { passive: true });
  // Mobile browsers fire `resize` every time the URL bar slides in/out. Re-running
  // layout() there rebuilds the track height and yanks the scroll position, so on
  // touch we ignore height-only changes and only relayout when the width actually
  // changes (rotation still comes through orientationchange). layout() records the
  // width it laid out at.
  function onResize() {
    if (coarse && window.innerWidth === laidOutW) return;
    layout();
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', layout);
  window.addEventListener('load', layout);
  layout();
  rafId = requestAnimationFrame(raf);

  function destroy() {
    dead = true;
    cancelAnimationFrame(rafId);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', layout);
    window.removeEventListener('load', layout);
    SEGMENTS.forEach(s => { if (s.objectURL) URL.revokeObjectURL(s.objectURL); });
    container.innerHTML = '';
    container.classList.remove('sw-root');
    if (window.scrollWelt === api) delete window.scrollWelt;
  }

  const api = {
    version: 1,
    segments: SEGMENTS.map(s => ({ id: s.id, kind: s.kind, scroll: s.w })),
    exportFrame, exportFrameDataURL, jumpTo, destroy,
    reducedMotion: reduce,
    refresh: () => { SEGMENTS.forEach(s => { s.dirty = true; }); layout(); },
    // Verification surface: what is the chain actually doing right now.
    state: () => SEGMENTS.map(s => ({
      id: s.id, kind: s.kind, t: s.cur, target: s.target,
      opacity: parseFloat(s.el.style.opacity) || 0, visible: s.visible,
      hasClip: s.hasClip, ready: s.ready,
      currentTime: s.video ? s.video.currentTime : null,
      duration: s.video ? s.video.duration : null,
      seekableEnd: (s.video && s.video.seekable && s.video.seekable.length) ? s.video.seekable.end(0) : null,
    })),
    stats: () => SEGMENTS.filter(s => s.stat.frames).map(s => ({
      id: s.id, frames: s.stat.frames, lastMs: +s.stat.lastMs.toFixed(3),
      maxMs: +s.stat.maxMs.toFixed(3), avgMs: +(s.stat.sumMs / s.stat.frames).toFixed(3),
      overBudget: s.stat.over,
    })),
  };
  if (typeof window !== 'undefined') window.scrollWelt = api;
  return api;

  // ---- helpers ----
  function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function ctaBtns(cta) {
    let h = '';
    if (cta.primary) h += `<a class="sw-btn sw-btn--primary" href="${esc(cta.primary.href || '#')}">${esc(cta.primary.label)}</a>`;
    if (cta.secondary) h += `<a class="sw-btn sw-btn--ghost" href="${esc(cta.secondary.href || '#')}">${esc(cta.secondary.label)}</a>`;
    return h;
  }
}

function seedParticles(host, reduce) {
  if (!host || reduce) return;
  const kinds = ['dot', 'dot', 'ring'];
  const seeds = [7, 23, 41, 58, 71, 88, 12, 34, 52, 66, 83, 95, 18, 29, 47, 63, 77, 91, 5, 38, 55, 69, 82, 97];
  for (let k = 0; k < 20; k++) {
    const s = document.createElement('span');
    s.className = 'sw-pt sw-pt--' + kinds[k % kinds.length];
    s.style.left = seeds[k % seeds.length] + 'vw';
    s.style.top = ((seeds[(k * 3) % seeds.length] * 1.3) % 100) + 'vh';
    s.style.setProperty('--sw-sc', (0.5 + ((seeds[(k * 5) % seeds.length] % 60) / 60) * 1.1).toFixed(2));
    const dur = 14 + (seeds[(k * 7) % seeds.length] % 22);
    s.style.animationDuration = dur + 's';
    s.style.animationDelay = (-(seeds[(k * 2) % seeds.length] % dur)) + 's';
    host.appendChild(s);
  }
}

function injectCSS() {
  if (document.getElementById('sw-css')) return;
  const css = `
  .sw-root{--sw-bg:#F5EDE0;--sw-ink:#241d2b;--sw-ink-soft:#6a6072;--sw-accent:#8a7bb5;
    --sw-font-display:ui-rounded,"SF Pro Rounded","Segoe UI",system-ui,sans-serif;
    --sw-font-body:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
    color:var(--sw-ink);font-family:var(--sw-font-body);}
  html,body{margin:0;background:var(--sw-bg,#F5EDE0);overflow-x:hidden;}
  .sw-sky{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;background:var(--sw-bg);}
  .sw-sky__grad{position:absolute;inset:-10%;background:linear-gradient(178deg,color-mix(in srgb,var(--sw-accent) 12%,var(--sw-bg)) 0%,var(--sw-bg) 55%,color-mix(in srgb,var(--sw-accent) 6%,var(--sw-bg)) 100%);}
  .sw-sky__glow{position:absolute;inset:0;background:radial-gradient(60% 42% at 74% 16%,color-mix(in srgb,var(--sw-accent) 22%,transparent),transparent 70%),radial-gradient(46% 34% at 50% 50%,color-mix(in srgb,#fff 45%,transparent),transparent 70%);}
  .sw-particles{position:absolute;inset:-6% -2%;will-change:transform;}
  .sw-pt{position:absolute;width:13px;height:13px;transform:scale(var(--sw-sc,1));opacity:0;animation:sw-drift linear infinite;}
  .sw-pt::before{content:"";position:absolute;inset:0;border-radius:50%;}
  .sw-pt--dot::before{background:radial-gradient(circle at 34% 30%,color-mix(in srgb,var(--sw-accent) 60%,#000),#000 82%);}
  .sw-pt--ring::before{background:transparent;border:2px solid color-mix(in srgb,var(--sw-accent) 55%,transparent);}
  @keyframes sw-drift{0%{opacity:0;transform:scale(var(--sw-sc)) translate(0,12vh) rotate(0)}12%{opacity:.5}88%{opacity:.45}100%{opacity:0;transform:scale(var(--sw-sc)) translate(4vw,-22vh) rotate(210deg)}}
  .sw-scrollbar{position:fixed;top:0;left:0;right:0;height:3px;z-index:60;background:color-mix(in srgb,var(--sw-accent) 14%,transparent);}
  .sw-scrollbar span{display:block;height:100%;width:100%;transform-origin:0 50%;transform:scaleX(0);background:var(--sw-accent);}
  .sw-topbar{position:fixed;top:0;left:0;right:0;z-index:50;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:clamp(14px,2.4vw,26px) clamp(18px,5vw,64px);}
  .sw-brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--sw-ink);}
  .sw-brand__mark{width:24px;height:28px;border-radius:7px 7px 10px 10px;background:linear-gradient(160deg,var(--sw-accent),color-mix(in srgb,var(--sw-accent) 60%,#000));box-shadow:0 6px 14px color-mix(in srgb,var(--sw-accent) 40%,transparent);}
  .sw-brand__name{font-family:var(--sw-font-display);font-weight:700;font-size:1.1rem;}
  .sw-nav{display:flex;gap:4px;padding:5px;background:color-mix(in srgb,#fff 55%,transparent);backdrop-filter:blur(10px);border:1px solid color-mix(in srgb,var(--sw-accent) 16%,transparent);border-radius:999px;}
  .sw-nav__item{font:inherit;font-size:.82rem;color:var(--sw-ink-soft);border:0;background:transparent;cursor:pointer;padding:7px 14px;border-radius:999px;transition:color .25s,background .25s;}
  .sw-nav__item:hover{color:var(--sw-ink);} .sw-nav__item.is-active{color:#fff;background:var(--sw-accent);}
  .sw-topcta{text-decoration:none;font-weight:600;font-size:.9rem;color:#fff;background:var(--sw-ink);padding:10px 20px;border-radius:999px;white-space:nowrap;}
  .sw-stage{position:fixed;inset:0;z-index:10;pointer-events:none;}
  .sw-scene{position:absolute;inset:0;opacity:0;overflow:hidden;will-change:opacity;}
  .sw-scene__video,.sw-scene__still{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center 42%;}
  .sw-scene__still{will-change:transform;} .sw-scene.has-clip .sw-scene__still{opacity:0;} .sw-scene__video{z-index:1;}
  /* [WELT] A szene canvas sits above its poster: it covers it when it paints and
     lets it through when a driver bows out (missing three.js, layers still loading). */
  .sw-scene__canvas{position:absolute;inset:0;width:100%;height:100%;z-index:2;}
  .sw-copylayer{position:fixed;inset:0;z-index:20;pointer-events:none;}
  .sw-copylayer::before{content:"";position:absolute;inset:0;width:min(58vw,780px);background:linear-gradient(90deg,var(--sw-bg) 0%,color-mix(in srgb,var(--sw-bg) 82%,transparent) 34%,color-mix(in srgb,var(--sw-bg) 40%,transparent) 62%,transparent 100%);}
  .sw-copy{position:absolute;left:clamp(18px,5vw,64px);top:50%;transform:translateY(-50%);width:min(42vw,460px);opacity:0;will-change:opacity,transform;}
  .sw-copy__num{font-family:ui-monospace,Menlo,monospace;font-size:.74rem;letter-spacing:.12em;color:var(--sw-ink-soft);}
  .sw-copy__eyebrow{display:block;margin-top:18px;font-family:var(--sw-font-display);font-weight:700;font-size:.8rem;letter-spacing:.16em;text-transform:uppercase;color:var(--sw-accent);}
  .sw-copy__title{font-family:var(--sw-font-display);font-weight:700;color:var(--sw-ink);font-size:clamp(2rem,4.4vw,3.5rem);line-height:1.03;margin:12px 0 0;letter-spacing:-.01em;text-shadow:0 2px 20px color-mix(in srgb,var(--sw-bg) 70%,transparent);}
  .sw-copy__body{margin-top:18px;font-size:clamp(1rem,1.25vw,1.14rem);line-height:1.55;color:color-mix(in srgb,var(--sw-ink) 78%,var(--sw-ink-soft));max-width:40ch;text-shadow:0 1px 12px color-mix(in srgb,var(--sw-bg) 90%,transparent);}
  .sw-copy__tags{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:24px 0 0;padding:0;}
  .sw-copy__tags li{font-size:.82rem;font-weight:600;color:color-mix(in srgb,var(--sw-accent) 70%,#000);padding:7px 14px;border-radius:999px;background:color-mix(in srgb,var(--sw-accent) 14%,#fff);border:1px solid color-mix(in srgb,var(--sw-accent) 30%,transparent);}
  .sw-copy__cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px;pointer-events:auto;}
  .sw-btn{text-decoration:none;font-weight:600;font-size:.95rem;padding:13px 24px;border-radius:999px;transition:transform .2s;}
  .sw-btn--primary{color:#fff;background:var(--sw-ink);} .sw-btn--primary:hover{transform:translateY(-2px);}
  .sw-btn--ghost{color:var(--sw-ink);border:1.5px solid color-mix(in srgb,var(--sw-ink) 25%,transparent);} .sw-btn--ghost:hover{transform:translateY(-2px);}
  .sw-route{position:fixed;right:clamp(14px,2.4vw,30px);top:50%;z-index:40;transform:translateY(-50%);display:flex;flex-direction:column;gap:22px;padding:18px 10px;}
  .sw-route::before{content:"";position:absolute;left:50%;top:22px;bottom:22px;width:2px;transform:translateX(-50%);background:var(--sw-accent);opacity:.28;}
  .sw-route__dot{position:relative;border:0;background:transparent;cursor:pointer;width:14px;height:14px;display:grid;place-items:center;}
  .sw-route__dot i{width:9px;height:9px;border-radius:50%;background:color-mix(in srgb,var(--sw-accent) 40%,transparent);transition:transform .3s,background .3s,box-shadow .3s;}
  .sw-route__dot:hover i{transform:scale(1.25);background:var(--sw-accent);}
  .sw-route__dot.is-active i{background:var(--sw-accent);transform:scale(1.4);box-shadow:0 0 0 5px color-mix(in srgb,var(--sw-accent) 22%,transparent);}
  .sw-route__label{position:absolute;right:24px;top:50%;transform:translateY(-50%) translateX(6px);white-space:nowrap;font-size:.78rem;font-weight:600;color:var(--sw-ink);background:color-mix(in srgb,#fff 85%,transparent);backdrop-filter:blur(6px);padding:5px 11px;border-radius:999px;opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;border:1px solid color-mix(in srgb,var(--sw-accent) 14%,transparent);}
  .sw-route__dot:hover .sw-route__label,.sw-route__dot.is-active .sw-route__label{opacity:1;transform:translateY(-50%) translateX(0);}
  .sw-hint{position:fixed;left:50%;bottom:26px;z-index:30;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:10px;font-size:.76rem;letter-spacing:.14em;text-transform:uppercase;color:var(--sw-ink-soft);transition:opacity .3s;}
  .sw-hint i{width:22px;height:34px;border-radius:12px;border:2px solid color-mix(in srgb,var(--sw-ink) 28%,transparent);position:relative;}
  .sw-hint i::after{content:"";position:absolute;left:50%;top:7px;width:4px;height:7px;border-radius:2px;background:var(--sw-accent);transform:translateX(-50%);animation:sw-wheel 1.7s ease-in-out infinite;}
  @keyframes sw-wheel{0%{opacity:0;top:6px}40%{opacity:1}100%{opacity:0;top:17px}}
  .sw-track{position:relative;z-index:1;width:100%;pointer-events:none;}
  @media (max-width:860px){
    .sw-nav{display:none;}
    .sw-copylayer::before{width:100%;height:60%;top:auto;bottom:0;background:linear-gradient(0deg,var(--sw-bg) 8%,color-mix(in srgb,var(--sw-bg) 70%,transparent) 46%,transparent 100%);}
    /* Anchor copy to the bottom, clear of the home indicator / collapsing URL bar.
       dvh + env() are progressive: browsers that lack them keep the vh fallback line. */
    .sw-copy{left:clamp(18px,5vw,64px);right:clamp(18px,5vw,64px);top:auto;bottom:clamp(64px,14vh,120px);transform:none;width:auto;max-width:560px;}
    .sw-copy{bottom:calc(clamp(56px,12dvh,110px) + env(safe-area-inset-bottom));}
    .sw-copy__title{font-size:clamp(1.9rem,7.5vw,2.7rem);}
    .sw-copy__body{max-width:none;font-size:clamp(.98rem,3.6vw,1.1rem);} .sw-scene__video,.sw-scene__still{object-position:center 46%;}
    .sw-hint{bottom:calc(20px + env(safe-area-inset-bottom));}
    .sw-route{gap:16px;right:6px;} .sw-route__label{display:none;}
  }
  /* Portrait phones crop a 16:9 clip hard; keep the framing centred so the focal
     subject (which the camera dives toward) stays in view. */
  @media (max-width:860px) and (orientation:portrait){
    .sw-scene__video,.sw-scene__still{object-position:center 44%;}
  }
  /* Touch: give the route dots a finger-sized hit area without growing the visible dot. */
  @media (hover:none) and (pointer:coarse){
    .sw-route{padding:14px 6px;}
    .sw-route__dot{width:28px;height:28px;}
    .sw-btn{padding:15px 26px;}
  }
  @media (prefers-reduced-motion:reduce){ .sw-hint i::after{animation:none;} .sw-pt{display:none;} }
  `;
  // Wrap in a cascade layer so the page's own theme tokens (unlayered
  // :root / .sw-root { --sw-bg / --sw-ink / --sw-accent … }) always win over
  // these defaults, regardless of injection order. Enables clean dark themes.
  const style = document.createElement('style'); style.id = 'sw-css';
  style.textContent = '@layer sw {\n' + css + '\n}';
  document.head.appendChild(style);
}

// Expose for module + global use. mountScrollWorld is kept as an alias so an
// existing scroll-world page only swaps the <script src> — unless the upstream
// engine is on the page too, in which case we leave its global alone.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { mountScrollWelt, mountScrollWorld: mountScrollWelt, normaliseSegments };
}
if (typeof window !== 'undefined') {
  window.mountScrollWelt = mountScrollWelt;
  if (!window.mountScrollWorld) window.mountScrollWorld = mountScrollWelt;
}
