/* Demo scenes for the mixed chain. Kept in their own file so the page and the
   build step (tools/export-seams.js, run through Playwright) describe the very
   same cameras — a seam frame is only worth anything if it comes from the scene
   that actually ships.

   Both cameras are plain parallax rigs: layers with a depth, a pan and a
   push-in. Nothing here is random or time-dependent, so t alone decides the
   frame. */

const L = 'assets/layers/';

/* Scene 1 — the yard. The camera drifts right and pushes toward the barn, so
   t = 1 sits on the barn: that frame is what the following clip starts from. */
const hofSzene = createParallaxSzene({
  background: '#F5EDE0',
  overscan: 1.2,
  layers: [
    { src: L + 'farm-1-sky.png',   depth: 0.00 },
    { src: L + 'farm-2-hills.png', depth: 0.30 },
    { src: L + 'farm-3-hof.png',   depth: 0.62 },
    { src: L + 'farm-4-gras.png',  depth: 1.00 },
  ],
  camera: {
    pan:  { from: [-0.035, 0.012], to: [0.052, -0.030] },
    zoom: { from: 1.00, to: 1.30 },
    parallax: 0.62,
    ease: 'smooth',
  },
  // Portrait sees roughly a third of the width, so the landscape camera would
  // push the barn out past the right edge — measured, not feared. The camera
  // moves, the layers do not: no second set of files. It starts further right,
  // where the barn is, travels less and pushes in less, and sits a little lower
  // so the fence and the meadow still carry the bottom of the frame.
  // Note the size of these pan numbers: `pan` counts in CANVAS widths, and a
  // portrait canvas is about a fifth as wide as the layer field, so a portrait
  // camera needs values several times larger than the landscape one to travel
  // the same distance across the picture.
  cameraPortrait: {
    pan:  { from: [0.34, 0.030], to: [0.45, -0.010] },
    zoom: { from: 1.00, to: 1.16 },
    parallax: 0.5,
    anchorY: 0.52,
    overscan: 1.32,
  },
  haze: { color: '#EFE3CC', strength: 0.34 },
  vignette: 0.22,
});

/* Scene 2 — the workshop. Starts wide (that frame closes the clip) and pushes
   in on the bench. Pans the other way so the cut reads as a turn, not a jump. */
const werkstattSzene = createParallaxSzene({
  background: '#EADCC4',
  overscan: 1.2,
  layers: [
    { src: L + 'werkstatt-1-wand.png',  depth: 0.00 },
    { src: L + 'werkstatt-2-regal.png', depth: 0.34 },
    { src: L + 'werkstatt-3-bank.png',  depth: 0.68 },
    { src: L + 'werkstatt-4-vorn.png',  depth: 1.00 },
  ],
  camera: {
    pan:  { from: [0.030, -0.014], to: [-0.040, 0.026] },
    zoom: { from: 1.02, to: 1.28 },
    parallax: 0.58,
    ease: 'smooth',
  },
  // In portrait the bench and the shelf wall are the subject, and they sit low
  // in the layers. Pulled back to 1.0 so the whole bench fits across the narrow
  // frame, and anchored low so we look at the workbench instead of the ceiling.
  cameraPortrait: {
    pan:  { from: [-0.020, 0.010], to: [-0.055, 0.034] },
    zoom: { from: 1.00, to: 1.14 },
    parallax: 0.46,
    anchorY: 0.62,
    overscan: 1.28,
  },
  haze: { color: '#F0E4CE', strength: 0.22 },
  vignette: 0.26,
});

/* The chain itself: szene -> video -> szene -> still.
   The video segment is the placeholder clip built by tools/build-clip.sh; its
   first frame IS exportFrame('hof', 1) and its last frame IS
   exportFrame('werkstatt', 0), so both seams are locked to real rendered
   frames, exactly as the original engine demands of a connector. */
const DEMO_SEGMENTS = [
  {
    kind: 'szene', id: 'hof', label: 'Der Hof',
    scroll: 1.7, linger: 0.42,
    render: hofSzene,
    accent: '#6D9668',
    eyebrow: 'Wo es anfaengt',
    title: 'Auf dem Hof.',
    body: 'Der Scroll bewegt hier keine Videodatei, sondern eine Kamera durch vier gezeichnete Ebenen. Jeder Frame entsteht frisch, auch rueckwaerts.',
    tags: ['Treiber: szene', '4 Ebenen', 'kein Modell'],
  },
  {
    kind: 'video', id: 'hof-zur-werkstatt',
    scroll: 1.0,
    clip: 'assets/vid/hof-zur-werkstatt.mp4',
    // Served instead of `clip` on a coarse-pointer or narrow viewport. Here it
    // is only the lighter GOP-4 encode of the same footage, not a native 9:16
    // render — the contract calls a centre crop of the 16:9 file the stopgap,
    // and this demo has no second camera to render a portrait clip from.
    clipMobile: 'assets/vid/hof-zur-werkstatt-m.mp4',
    still: 'assets/seams/hof-t1.png',
    accent: '#A87C56',
  },
  {
    kind: 'szene', id: 'werkstatt', label: 'Die Werkstatt',
    scroll: 1.6, linger: 0.4,
    render: werkstattSzene,
    // Poster and reduced-motion fallback in one, as in the contract's example:
    // with a still present the engine skips the canvas entirely under reduced
    // motion. 'hof' deliberately has none, so it takes the other route — one
    // render at staticT. Both branches are in this one page on purpose.
    still: 'assets/seams/werkstatt-t0.png',
    accent: '#A87C56',
    eyebrow: 'Wo es entsteht',
    title: 'In der Werkstatt.',
    body: 'Das Videosegment davor beginnt exakt auf dem Frame, auf dem der Hof endet, und endet exakt auf diesem hier. Die Naht ist gebaut, nicht geraten.',
    tags: ['Treiber: video', 'Naht gelockt', 'Blob-Seeking'],
  },
  {
    kind: 'still', id: 'produkt', label: 'Das Produkt',
    scroll: 1.2,
    still: 'assets/produkt-still.png',
    accent: '#3C6440',
    eyebrow: 'Und am Ende',
    title: 'Eine Flasche.',
    body: 'Ein Standbild-Segment bewegt nur die Copy. Es kostet nichts und beendet die Kette ruhig.',
    cta: { primary: { label: 'Treiber ansehen', href: '#top' },
           secondary: { label: 'Alte Konfiguration', href: 'original.html' } },
  },
];

if (typeof window !== 'undefined') {
  window.DEMO_SEGMENTS = DEMO_SEGMENTS;
  window.demoScenes = { hof: hofSzene, werkstatt: werkstattSzene };
}
