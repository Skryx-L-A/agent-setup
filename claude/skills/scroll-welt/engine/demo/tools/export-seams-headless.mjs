#!/usr/bin/env node
/* Headless seam export — the build step the API contract asks for.
 *
 *   node demo/tools/export-seams-headless.mjs [--url …] [--port 9222]
 *                                             [--size 1280x720]
 *                                             [--frames "hof@1:hof-t1.png,…"]
 *
 * Opens the page in a headless Chromium and calls exportFrame() for each seam.
 * The PNGs travel back over the dev server's PUT route, so nothing has to
 * squeeze a megabyte-sized data URL through the wire. Chromium comes from the
 * Playwright cache or a local Chrome; nothing is downloaded.
 */
import { launch, waitFor } from './cdp.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) =>
  a.startsWith('--') ? [a.slice(2), (all[i + 1] && !all[i + 1].startsWith('--')) ? all[i + 1] : true] : []).filter(Boolean));
const PAGE_URL = args.url || 'http://127.0.0.1:8731/demo/index.html';
const PORT = Number(args.port || 9222);
const [W, H] = String(args.size || '1280x720').split('x').map(Number);

// --frames "hof@1:hof-t1.png,werkstatt@0:werkstatt-t0.png" overrides the demo's
// own seam list; the file name defaults to <id>-t<t>.png.
const FRAMES = args.frames
  ? String(args.frames).split(',').map(spec => {
      const [left, name] = spec.split(':');
      const [id, t] = left.split('@');
      return [id, Number(t), name || `${id}-t${t}.png`];
    })
  : [
      ['hof', 0, 'hof-t0.png'],
      ['hof', 1, 'hof-t1.png'],
      ['werkstatt', 0, 'werkstatt-t0.png'],
      ['werkstatt', 1, 'werkstatt-t1.png'],
    ];

const browser = await launch({ width: W, height: H });
let code = 1;
try {
  const { session } = browser;
  await session.goto(PAGE_URL);
  await waitFor(() => session.evaluate(() => Boolean(window.welt && window.welt.segments.length)), 'engine mount');

  const report = await session.evaluate(async (frames, w, h) => {
    const out = [];
    for (const [id, t, name] of frames) {
      const blob = await window.welt.exportFrame(id, t, { width: w, height: h });
      const res = await fetch('/demo/assets/seams/' + name, { method: 'PUT', body: blob });
      out.push({ name, id, t, type: blob.type, bytes: blob.size, put: res.status });
    }
    return out;
  }, FRAMES, W, H);

  for (const f of report) {
    console.log(`seam ${f.name.padEnd(22)} ${f.id}@t=${f.t}  ${f.type}  ${f.bytes} bytes  PUT ${f.put}`);
    if (f.put !== 201) throw new Error('PUT failed for ' + f.name);
  }
  code = 0;
} catch (err) {
  console.error('export failed:', err.message);
} finally {
  await browser.close();
}
process.exit(code);
