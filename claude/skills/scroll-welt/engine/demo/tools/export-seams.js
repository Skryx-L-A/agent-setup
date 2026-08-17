/* Seam export, run inside the page (Playwright: evaluate this file's body).

   This is the build step the API contract describes: a code scene can hand over
   the exact frame it ends on, so the clip that follows starts on that frame
   instead of on a freshly generated look-alike. Nothing here needs a scroll
   position — exportFrame is pure in (segmentId, t).

   Returns a small report; the PNGs travel over PUT to demo/tools/serve.py. */
async function exportSeams(opts) {
  opts = opts || {};
  const W = opts.width || 1280, H = opts.height || 720;
  const welt = window.welt || window.scrollWelt;
  if (!welt) throw new Error('engine not mounted');

  const wanted = opts.frames || [
    ['hof', 0, 'hof-t0.png'],           // poster for the old-format demo page
    ['hof', 1, 'hof-t1.png'],           // -> first frame of the clip
    ['werkstatt', 0, 'werkstatt-t0.png'], // -> last frame of the clip
    ['werkstatt', 1, 'werkstatt-t1.png'],
  ];

  const report = [];
  for (const [id, t, name] of wanted) {
    const t0 = performance.now();
    const blob = await welt.exportFrame(id, t, { width: W, height: H });
    const ms = performance.now() - t0;
    const res = await fetch('/demo/assets/seams/' + name, { method: 'PUT', body: blob });
    if (!res.ok) throw new Error('PUT failed for ' + name + ': ' + res.status);
    report.push({ id, t, name, type: blob.type, bytes: blob.size, ms: +ms.toFixed(1) });
  }
  return report;
}

if (typeof window !== 'undefined') window.exportSeams = exportSeams;
