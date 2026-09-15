#!/usr/bin/env node
/* Prueflauf fuer eine FERTIGE Seite, nicht fuer die Engine.
 *
 *   python3 demo/tools/serve.py &
 *   node demo/tools/verify-page.mjs --url http://127.0.0.1:8731/demo/index.html --out demo/verify/seite
 *   node demo/tools/verify-page.mjs --url ... --out … --width 390 --height 844 --mobile
 *   node demo/tools/verify-page.mjs --url ... --out … --reduced-motion
 *
 * Das Verfahren stammt aus `nateherkai/scroll-craft` (MIT), `scripts/shoot.mjs`
 * und `references/verify.md`: die Seite an vielen Scrollpositionen abfahren, an
 * jeder messen was wirklich auf dem Schirm steht, und die Ergebnisse
 * nebeneinanderlegen. Hier ist es auf unsere Engine umgeschrieben — auf
 * `window.scrollWelt.state()` statt auf DOM-Schnueffelei, auf `cdp.mjs` statt
 * auf playwright-core, und um eine Pruefung erweitert, die es dort nicht geben
 * kann: eine Code-Szene zeichnet auf ein Canvas, also wird das Canvas selbst
 * abgetastet.
 *
 * Vier Befunde, die kein statischer Blick auf die Seite liefert:
 *
 *   TOTER SCROLL   zwei benachbarte Positionen, an denen sich nichts geaendert
 *                  hat. Der Leser dreht am Rad und bekommt nichts.
 *   STEHENDER CLIP ein sichtbares Video-Segment, dessen Abspielkopf sich nicht
 *                  bewegt: ein Standbild, das die Seite hochfaehrt.
 *   BLASSE COPY    ein Textblock, der nirgends volle Deckkraft erreicht.
 *   KONTRAST       gemessen auf dem ZUSAMMENGESETZTEN Bild, unter jeder Zeile,
 *                  an dem Frame, an dem die Zeile am schlechtesten steht.
 *
 * Ausgabe: ein PNG je Position, `bericht.json`, eine Kontaktbogen-Kachelung
 * `bogen.png` (braucht ffmpeg), und eine Zusammenfassung auf stderr.
 * Rueckgabecode 0 nur, wenn kein harter Befund uebrig bleibt.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { launch, waitFor } from './cdp.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

const URL = arg('--url', 'http://127.0.0.1:8731/demo/index.html');
const OUT = resolve(arg('--out', 'demo/verify/seite'));
const PER_SEG = parseInt(arg('--per-segment', '6'), 10);
const W = parseInt(arg('--width', '1440'), 10);
const H = parseInt(arg('--height', '900'), 10);
const DPR = parseFloat(arg('--dpr', '1'));
const MOBILE = has('--mobile');
const REDUCED = has('--reduced-motion');
// Die Kreuzblende der Engine (`config.crossfade`, Vorgabe 0.12 vh). Sie steht
// nicht in der oeffentlichen API, also hier als Flagge — beide Seiten jeder
// Naht werden zusaetzlich abgetastet, weil genau dort die Naht sitzt und eine
// gleichmaessige Abtastung mit grosser Wahrscheinlichkeit darueber hinwegsteigt.
const SEAM = parseFloat(arg('--seam', '0.12'));
// Ab hier gilt ein Segment als "der Leser sieht es".
const SICHTBAR = 0.55;
/* Zusaetzliches CSS, nach dem Laden eingespielt. Dafuer gibt es genau einen
 * guten Grund, und er steht in scroll-crafts `references/verify.md`: die
 * Gegenprobe. Wer den Schleier abschaltet und dieselben Kontrastzahlen
 * zurueckbekommt, misst ihn gar nicht mit — dann ist die Messung kaputt, nicht
 * die Seite. Bewegen sich die Zahlen, ist bewiesen, dass der zusammengesetzte
 * Frame gemessen wird und nicht der nackte Film.
 *
 *   --css '.sw-copylayer::before{display:none}'
 */
const EXTRA_CSS = arg('--css', '');

mkdirSync(OUT, { recursive: true });

const browser = await launch({ width: W, height: H, gpu: true });
const { session } = browser;

// Bricht der Lauf von aussen ab — Zeitlimit, Strg-C —, muss der Browser
// trotzdem zugemacht werden. Sonst bleibt sein Wegwerf-Profil liegen: gemessen
// 9,7 MB je abgebrochenem Lauf, und der Prozess selbst kann den Port halten.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    process.stderr.write('\nAbgebrochen (' + signal + ') — Browser wird geschlossen.\n');
    try { await browser.close(); } catch (e) { /* schon weg */ }
    process.exit(130);
  });
}
const konsole = [];
const fehlgeschlagen = [];

// Netzwerkfehler mitlesen. Ein 404 auf einen Clip faellt lautlos auf das Poster
// zurueck: die Seite sieht heil aus und ist es nicht.
session.ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Network.loadingFailed' && !m.params.canceled) {
    fehlgeschlagen.push(m.params.errorText + ' (' + m.params.type + ')');
  }
});
await session.send('Network.enable');

await session.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__logs=[];(function(){const w=console.warn,e=console.error;
    console.warn=function(){window.__logs.push(['warn',Array.from(arguments).join(' ')]);return w.apply(console,arguments);};
    console.error=function(){window.__logs.push(['error',Array.from(arguments).join(' ')]);return e.apply(console,arguments);};})();`,
});

if (REDUCED) await session.reducedMotion(true);
await session.setViewport({ width: W, height: H, dpr: DPR, mobile: MOBILE, touch: MOBILE });
await session.goto(URL);
await waitFor(() => session.evaluate(() => Boolean(window.scrollWelt)), 'mountScrollWelt');
// Schriften abwarten: die Zeilenkaesten, gegen die der Kontrast gemessen wird,
// stehen vor der echten Schrift an der falschen Stelle.
await session.evaluate(() => document.fonts.ready.then(() => true));
if (EXTRA_CSS) {
  await session.evaluate((css) => {
    const s = document.createElement('style');
    s.id = 'sw-extra-css';
    s.textContent = css;
    document.head.appendChild(s);
    return true;
  }, EXTRA_CSS);
  process.stderr.write('Zusaetzliches CSS eingespielt: ' + EXTRA_CSS + '\n');
}
await new Promise((r) => setTimeout(r, 600));

const geo = await session.evaluate((seam, proSeg) => {
  const segs = window.scrollWelt.segments;
  const vh = innerHeight;
  const grenzen = [];
  let off = 0;
  const stellen = [];
  const anteile = Array.from({ length: proSeg }, (_, i) => (proSeg === 1 ? 0.5 : i / (proSeg - 1)));
  segs.forEach((s, i) => {
    const start = off, ende = off + s.scroll;
    // Nicht exakt auf die Endpunkte: dort ist mehrdeutig, in welchem Segment
    // man steht, und beide Nachbarn blenden gerade.
    anteile.forEach((f) => stellen.push(Math.round((start + s.scroll * (0.03 + f * 0.94)) * vh)));
    off = ende;
    if (i < segs.length - 1) {
      grenzen.push(off);
      [-0.6, -0.25, 0.25, 0.6].forEach((k) => stellen.push(Math.round((off + k * seam) * vh)));
    }
  });
  const max = document.body.scrollHeight - vh;
  stellen.push(0, max);
  return {
    vh, max, spurVh: +off.toFixed(2),
    segmente: segs.map((s) => ({ id: s.id, kind: s.kind, vh: s.scroll })),
    stellen: [...new Set(stellen.map((y) => Math.max(0, Math.min(max, y))))].sort((a, b) => a - b),
  };
}, SEAM, Math.max(2, PER_SEG));

process.stderr.write(
  `Seite: ${geo.segmente.length} Segmente ueber ${geo.spurVh} Viewporthoehen ` +
  `(${geo.segmente.map((s) => s.id + ':' + s.kind + '@' + s.vh).join('  ')})\n` +
  `${geo.stellen.length} Scrollpositionen, Viewport ${W}x${H}${REDUCED ? ', reduced motion' : ''}${MOBILE ? ', Telefon' : ''}\n\n`);

/* Auf die ANKUNFT warten, nicht auf das Ende des Seeks. Die Engine faehrt
 * `cur` mit 0.18 je Frame an `target` heran, fuer Video- wie fuer Code-Szenen.
 * Wer mitten in dieser Fahrt fotografiert, bekommt Frames, die kein Leser je
 * zu sehen bekommt, und vergleicht anschliessend Rauschen mit Rauschen. */
async function beruhigt(msMax = 4000) {
  const bis = Date.now() + msMax;
  for (;;) {
    const da = await session.evaluate((reduziert) => {
      const st = window.scrollWelt.state();
      const seekend = [...document.querySelectorAll('.sw-scene__video')].some((v) => v.seeking);
      // Unter reduced motion faehrt nichts heran: eine Code-Szene zeichnet
      // einmal bei `staticT` und bleibt stehen, ein Clip springt ohne Lerp auf
      // sein Ziel. `t` bleibt dort dauerhaft hinter `target` zurueck, und wer
      // darauf wartet, wartet an jeder Position vier Sekunden vergeblich.
      if (reduziert) return !seekend;
      // `still` ausgenommen, aus demselben Grund: ein Standbild hat nichts, was
      // heranfahren koennte. Sein `t` bleibt bei 0, waehrend `target` mit dem
      // Scroll weiterwandert (so steht es im API-Vertrag: bei einem `still`
      // bewegt `t` nur die Copy).
      return !seekend && st.every((s) => s.kind === 'still' || Math.abs(s.t - s.target) < 0.002);
    }, REDUCED);
    if (da) return true;
    if (Date.now() > bis) return false;
    await new Promise((r) => setTimeout(r, 60));
  }
}

const bericht = [];
for (let i = 0; i < geo.stellen.length; i++) {
  const y = geo.stellen[i];
  await session.evaluate((yy) => { window.scrollTo({ top: yy, behavior: 'instant' }); return true; }, y);
  await new Promise((r) => setTimeout(r, 150));
  const still = await beruhigt();

  const zustand = await session.evaluate(() => {
    const zeile = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 46);
    const st = window.scrollWelt.state();
    const segmente = st.map((s) => {
      const el = document.querySelector('[data-sw-seg="' + s.id + '"]');
      const cv = el && el.querySelector('canvas');
      // Eine Code-Szene zeichnet auf ein Canvas. Ob sie sich bewegt, steht in
      // keinem Engine-Wert: ein Treiber, der `t` ignoriert oder auf dem ersten
      // Frame haengengeblieben ist, meldet trotzdem brav einen wandernden `t`.
      // Also das Bild selbst abtasten — ein 8x5-Raster mittlerer Helligkeit
      // reicht, um Bewegung von Stillstand zu unterscheiden.
      let bild = null;
      if (cv && cv.width) {
        const k = document.createElement('canvas'); k.width = 8; k.height = 5;
        const g = k.getContext('2d', { willReadFrequently: true });
        try {
          g.drawImage(cv, 0, 0, 8, 5);
          const d = g.getImageData(0, 0, 8, 5).data;
          const w = [];
          for (let p = 0; p < d.length; p += 4) w.push(Math.round((d[p] + d[p + 1] + d[p + 2]) / 3 * (d[p + 3] / 255)));
          bild = w.join(',');
        } catch (e) { bild = 'fehler:' + e.message; }
      }
      return {
        id: s.id, kind: s.kind, t: +s.t.toFixed(4),
        opacity: +s.opacity.toFixed(3), visible: s.visible,
        hasClip: s.hasClip, ready: s.ready,
        currentTime: s.currentTime == null ? null : +s.currentTime.toFixed(3),
        duration: s.duration == null ? null : +s.duration.toFixed(3),
        bild,
      };
    });
    const copy = [...document.querySelectorAll('.sw-copy')].map((c, k) => ({
      k, o: +(parseFloat(getComputedStyle(c).opacity) || 0).toFixed(3), t: zeile(c),
    })).filter((c) => c.o > 0.02);
    return {
      segmente, copy,
      // Ein gewollter Halt muss ERKLAERT werden, nicht stillschweigend erlaubt.
      // Eine Seite, deren Schluss bewusst steht, setzt `data-sw-verify-hold`
      // auf ein sichtbares Element und nimmt es wieder weg, sobald der Halt
      // vorbei ist. Wer das Attribut dauerhaft setzt, schaltet die Pruefung ab,
      // statt sie zu bestehen — genau die Selbsttaeuschung, gegen die sie da ist.
      halt: !!document.querySelector('[data-sw-verify-hold="true"]'),
      accent: getComputedStyle(document.querySelector('.sw-root')).getPropertyValue('--sw-accent').trim(),
    };
  });

  await session.evaluate(() => { window.scrollTo(0, window.scrollY); return true; });
  const png = await session.screenshot();
  writeFileSync(join(OUT, String(i).padStart(2, '0') + '.png'), png);

  /* Kontrast auf dem zusammengesetzten Bild.
   *
   * Text ausblenden, denselben Frame noch einmal fotografieren, das Bild in die
   * Seite zurueckreichen und unter jeder Zeile den echten Untergrund abtasten.
   * Ueber einem scrubbenden Clip ist das der einzige ehrliche Weg: der Frame
   * unter einer Zeile wechselt beim Scrollen, eine Zeile kann also auf dem
   * Poster 7:1 haben und dreihundert Pixel weiter 1,4:1.
   *
   * ACHTUNG, die Falle aus scroll-craft: `visibility:hidden` versteckt auch die
   * Pseudo-Elemente eines Elements. Unser Schleier ist `.sw-copylayer::before`,
   * die Copy-Bloecke sind KINDER dieser Schicht. Wer `.sw-copylayer` ausblendet,
   * blendet den Schleier mit aus und misst jede Zeile gegen den nackten Film.
   * Ausgeblendet wird darum nur `.sw-copy` selbst, nie die Schicht darum.
   */
  await session.evaluate(() => {
    document.querySelectorAll('body *').forEach((el) => {
      if (getComputedStyle(el).position !== 'fixed') return;
      // Himmel, Buehne und Copy-Schicht SIND der Untergrund. Alles andere, was
      // fest steht, malt davor und ist deshalb nicht der Grund hinter der Zeile.
      if (el.closest('.sw-sky,.sw-stage,.sw-copylayer')) return;
      el.setAttribute('data-sw-shot-fixed', '');
    });
    const s = document.createElement('style');
    s.id = 'sw-shot-hide';
    s.textContent = '.sw-copy,.sw-copy *,[data-sw-shot-fixed]{visibility:hidden!important}';
    document.head.appendChild(s);
    return true;
  });
  const nackt = await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
  const kontrast = await session.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/jpeg;base64,' + b64;
    await img.decode();
    // Nicht dpr annehmen, sondern nachmessen: das Bild kommt in Geraetepixeln.
    const skala = img.width / innerWidth;
    const c = document.createElement('canvas');
    const g = c.getContext('2d', { willReadFrequently: true });
    // Farben NIE aus dem String parsen. `getComputedStyle` liefert fuer alles,
    // was aus `color-mix()` kommt — und unsere Engine benutzt es fuer Tags,
    // Knoepfe und weiche Ink-Toene — die Form `color(srgb 0.29 0.41 0.28)`, also
    // Anteile von 0 bis 1. Eine Zahlensuche mit `[\d.]+` liest daraus 0,29 als
    // Rotwert und macht aus jeder Farbe fast Schwarz: Vordergrund und
    // Hintergrund kommen dann beide bei fast Null heraus und jede Zeile meldet
    // saubere 1:1. Der Browser rechnet die Farbe selbst aus, wenn man sie ihm
    // als `fillStyle` gibt — das ist der verlaessliche Weg.
    const farbe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const alsRGBA = (wert) => {
      farbe.clearRect(0, 0, 1, 1);
      farbe.fillStyle = 'rgba(0,0,0,0)';
      farbe.fillStyle = wert;
      farbe.fillRect(0, 0, 1, 1);
      const d = farbe.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const lum = (r, gr, b) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(gr) + 0.0722 * f(b);
    };
    const quotient = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const aus = [];
    document.querySelectorAll('.sw-copy').forEach((block) => {
      if ((parseFloat(getComputedStyle(block).opacity) || 0) < 0.85) return;
      // Zeilentraeger sind die Elemente mit eigenem Text, nicht die Huellen.
      // So gilt die Messung auch fuer selbst geschriebenes Markup.
      block.querySelectorAll('*').forEach((el) => {
        const eigen = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!eigen) return;
        const cs = getComputedStyle(el);
        const vg = alsRGBA(cs.color);
        if (vg[3] < 0.1) return;
        const fl = lum(vg[0], vg[1], vg[2]);
        const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        // Ein Element mit eigener deckender Flaeche (Knopf, Chip) ist ein
        // gewoehnlicher statischer Fall: gegen die eigene Fuellung messen. Beim
        // Ausblenden verschwindet diese Fuellung mit, sonst meldet jeder
        // ausgefuellte Knopf einen Fehlalarm.
        const hg = alsRGBA(cs.backgroundColor);
        if (hg[3] > 0.5) {
          const q = +quotient(fl, lum(hg[0], hg[1], hg[2])).toFixed(2);
          aus.push({ t: text, richtung: 'eigene-flaeche', schlechtester: q, mittel: q });
          return;
        }
        // NICHT den Elementkasten abtasten, sondern die ZEILENKAESTEN.
        // Eine Ueberschrift auf Blockebene ist so breit wie ihre Spalte, ihre
        // Buchstaben sind es nicht: bei einer 460 px breiten Spalte und einer
        // 120 px langen Zeile liegen drei Viertel des gemessenen Kastens
        // rechts neben dem Text. Ein dunkler Fleck dort zieht den Wert nach
        // unten, obwohl unter keinem Buchstaben etwas Dunkles liegt. Ein Range
        // ueber den Textinhalt liefert je gerenderter Zeile einen Kasten, der
        // die Glyphen wirklich umschliesst — und nebenbei die Zeilentreue, die
        // eine Messung pro Element nur naeherungsweise hat.
        const bereich = document.createRange();
        bereich.selectNodeContents(el);
        const kaesten = [...bereich.getClientRects()].filter((r) => r.width > 4 && r.height > 4);
        bereich.detach && bereich.detach();
        kaesten.forEach((r, zi) => {
          // Auf den Viewport beschneiden: was ueber dem Rand liegt, steht vor
          // nichts, was der Leser sieht.
          const l = Math.max(0, r.left), o = Math.max(0, r.top);
          const re = Math.min(innerWidth, r.right), u = Math.min(innerHeight, r.bottom);
          if (re - l < 6 || u - o < 6) return;
          const sx = l * skala, sy = o * skala;
          const sw = Math.min((re - l) * skala, img.width - sx), sh = Math.min((u - o) * skala, img.height - sy);
          if (sw < 2 || sh < 2) return;
          c.width = 32; c.height = 16;
          g.drawImage(img, sx, sy, sw, sh, 0, 0, 32, 16);
          const d = g.getImageData(0, 0, 32, 16).data;
          let hell = 0, dunkel = 1, summe = 0, n = 0;
          for (let k = 0; k < d.length; k += 4) {
            const L = lum(d[k], d[k + 1], d[k + 2]);
            if (L > hell) hell = L;
            if (L < dunkel) dunkel = L;
            summe += L; n++;
          }
          // Die Richtung je Zeile bestimmen. Helle Schrift auf dunklem Grund
          // scheitert am HELLSTEN Fleck darunter, dunkle Schrift auf hellem
          // Grund am DUNKELSTEN. Immer gegen den hellsten zu messen ist die
          // nachsichtigste Lesart und meldet eine hellgrundige Seite sauber,
          // waehrend ihre Schrift durchfaellt.
          const mittel = summe / n;
          const dunkelSchrift = fl < mittel;
          aus.push({
            t: text + (kaesten.length > 1 ? ' [Zeile ' + (zi + 1) + ']' : ''),
            richtung: dunkelSchrift ? 'dunkel-auf-hell' : 'hell-auf-dunkel',
            schlechtester: +quotient(fl, dunkelSchrift ? dunkel : hell).toFixed(2),
            mittel: +quotient(fl, mittel).toFixed(2),
          });
        });
      });
    });
    return aus;
  }, nackt.data);
  await session.evaluate(() => {
    const s = document.getElementById('sw-shot-hide');
    if (s) s.remove();
    document.querySelectorAll('[data-sw-shot-fixed]').forEach((el) => el.removeAttribute('data-sw-shot-fixed'));
    return true;
  });

  bericht.push({ i, y, prozent: +(geo.max ? (y / geo.max) * 100 : 0).toFixed(0), still, kontrast, ...zustand });
  const sichtbar = zustand.segmente.filter((s) => s.opacity > 0.002);
  process.stderr.write(
    `  ${String(i).padStart(2, '0')}.png  y=${String(y).padStart(5)}  beruhigt=${still ? 'ja' : 'NEIN'}  ` +
    `copy=${zustand.copy.length}  ` +
    sichtbar.map((s) => `${s.id}@${s.opacity.toFixed(2)}${s.kind === 'video' ? (s.ready ? ':' + s.currentTime + 's' : ':Poster') : ':t' + s.t.toFixed(2)}`).join(' ') + '\n');
}

const logs = await session.evaluate(() => window.__logs || []);
await browser.close();

/* ---- Auswertung -------------------------------------------------------- */

const befunde = [];
const sage = (s) => process.stderr.write(s + '\n');
sage('');

// TOTER SCROLL. Drei Dinge koennen die Bewegung tragen: der Film laeuft weiter,
// eine Szene zeichnet ein neues Bild, eine Naht blendet, ein Textfenster oeffnet
// oder schliesst. Toter Scroll heisst: alles vier steht gleichzeitig still.
// Unter reduced motion nicht: dort steht jedes Segment absichtlich auf einem
// Standbild, und jede Meldung darueber wuerde nur den echten Befund zudecken.
const signatur = (s) => JSON.stringify([
  s.segmente.map((g) => [g.opacity, g.t, g.currentTime, g.bild]),
  s.copy.map((c) => c.k + ':' + c.o),
]);
if (!REDUCED) {
  const tot = [];
  for (let i = 1; i < bericht.length; i++) {
    const a = bericht[i - 1], b = bericht[i];
    // Zwei Positionen dicht beieinander SOLLEN gleich aussehen. Nur eine Luecke
    // melden, in der ein Leser tatsaechlich nichts geschehen sieht.
    if (b.y - a.y < geo.vh * 0.25) continue;
    if (a.halt && b.halt) continue;   // erklaerter Halt, siehe `data-sw-verify-hold`
    if (signatur(a) === signatur(b)) tot.push(`${a.prozent}% -> ${b.prozent}% (y ${a.y}-${b.y})`);
  }
  if (tot.length) { befunde.push('toter Scroll'); sage('TOTER SCROLL zwischen: ' + tot.join(', ')); }
  else sage('kein toter Scroll');
} else {
  sage('Prueflauf auf toten Scroll ausgelassen: unter reduced motion steht jedes Segment absichtlich still');
}

// STEHENDER CLIP. Das Segment ist sichtbar, der Leser scrollt, der Abspielkopf
// bewegt sich nicht: ein Standbild, das die Seite hochfaehrt. Unter reduced
// motion wird kein Clip geholt, dort ist das der gewollte Zustand.
if (!REDUCED) {
  const stehend = [];
  const poster = new Set();
  geo.segmente.forEach((seg, c) => {
    if (seg.kind !== 'video') return;
    let lauf = null;
    const schliessen = () => {
      if (lauf && lauf.bis - lauf.von >= geo.vh * 0.2) stehend.push({ id: seg.id, ...lauf });
      lauf = null;
    };
    for (let i = 1; i < bericht.length; i++) {
      const a = bericht[i - 1].segmente[c], b = bericht[i].segmente[c];
      if (!a || !b) { schliessen(); continue; }
      if (b.opacity >= SICHTBAR && b.hasClip && !b.ready) poster.add(seg.id);
      const gesehen = a.opacity >= SICHTBAR && b.opacity >= SICHTBAR;
      const fest = a.currentTime != null && b.currentTime != null && Math.abs(b.currentTime - a.currentTime) < 0.012;
      if (gesehen && fest && b.ready) {
        if (!lauf) lauf = { von: bericht[i - 1].y, bis: bericht[i].y, sek: b.currentTime };
        else lauf.bis = bericht[i].y;
      } else schliessen();
    }
    schliessen();
  });
  if (stehend.length) {
    befunde.push('stehender Clip');
    sage('STEHENDER CLIP (Standbild, waehrend die Seite faehrt):\n  ' + stehend.map((f) =>
      `${f.id}: ${f.bis - f.von} px (${((f.bis - f.von) / geo.vh).toFixed(2)} Viewporthoehen) fest bei ${f.sek}s`).join('\n  '));
  }
  if (poster.size) {
    befunde.push('Segment auf dem Poster');
    sage('SEGMENT HAENGT AUF DEM POSTER (Clip hat nie gemalt):\n  ' + [...poster].join(', '));
  }
  if (!stehend.length && !poster.size) {
    const n = geo.segmente.filter((s) => s.kind === 'video').length;
    sage(n ? `alle ${n} Video-Segmente bewegen sich, solange sie zu sehen sind` : 'keine Video-Segmente auf dieser Seite');
  }
}

// SEGMENTE, DIE NIE GANZ DA SIND. Ein Segment, dessen Deckkraft nirgends 1
// erreicht, zeigt dem Leser eine Dauerblende zwischen zwei Nachbarn und nie
// sich selbst: seine Spanne ist kuerzer als die Kreuzblende an seinen Enden.
const spitze = {};
bericht.forEach((s) => s.segmente.forEach((g) => { spitze[g.id] = Math.max(spitze[g.id] || 0, g.opacity); }));
const blass = Object.entries(spitze).filter(([, o]) => o < 0.99);
if (blass.length) {
  befunde.push('Segment nie voll deckend');
  sage('SEGMENTE, DIE NIE VOLLE DECKKRAFT ERREICHEN:\n  ' + blass.map(([k, o]) => `${o.toFixed(2)} ${k}`).join('\n  '));
}

// BLASSE COPY. Ein Textblock, der nirgends ankommt, ist kein sichtbarer Fehler:
// er IST da, er wird nur nie ganz.
const copySpitze = {};
bericht.forEach((s) => s.copy.forEach((c) => { copySpitze[c.k + ' "' + c.t + '"'] = Math.max(copySpitze[c.k + ' "' + c.t + '"'] || 0, c.o); }));
const schwach = Object.entries(copySpitze).filter(([, o]) => o < 0.8);
if (schwach.length) {
  befunde.push('Copy erreicht nie volle Deckkraft');
  sage('COPY, DIE NIE VOLL WIRD:\n  ' + schwach.map(([t, o]) => `${o.toFixed(2)} ${t}`).join('\n  '));
}

// KONTRAST, je Zeile an ihrem schlechtesten Frame.
const schlecht = {};
bericht.forEach((s) => (s.kontrast || []).forEach((c) => {
  if (!schlecht[c.t] || c.schlechtester < schlecht[c.t].schlechtester) schlecht[c.t] = c;
}));
const durchgefallen = Object.values(schlecht).filter((c) => c.schlechtester < 3);
const knapp = Object.values(schlecht).filter((c) => c.schlechtester >= 3 && c.schlechtester < 4.5);
if (durchgefallen.length) {
  befunde.push('Kontrast unter 3:1');
  sage('KONTRAST DURCHGEFALLEN (schlechtester Frame unter 3:1):\n  ' + durchgefallen.map((c) =>
    `${c.schlechtester}:1 (Mittel ${c.mittel}, ${c.richtung}) "${c.t}"`).join('\n  '));
}
if (knapp.length) {
  sage('KONTRAST KNAPP (3:1 bis 4,5:1 — fuer grosse Displaytype in Ordnung, fuer Fliesstext nicht):\n  ' + knapp.map((c) =>
    `${c.schlechtester}:1 (${c.richtung}) "${c.t}"`).join('\n  '));
}
if (!durchgefallen.length && !knapp.length && Object.keys(schlecht).length) {
  sage(`Kontrast: alle ${Object.keys(schlecht).length} gemessenen Zeilen halten 4,5:1 an ihrem schlechtesten Frame`);
}

const eigene = logs.filter((l) => /^\[(scrub-welt|treiber-)/.test(l[1]));
if (eigene.length) { befunde.push('Meldung aus der Engine'); sage('KONSOLE (Engine/Treiber):\n  ' + eigene.map((l) => l.join(' ')).join('\n  ')); }
if (fehlgeschlagen.length) { befunde.push('fehlgeschlagene Anfrage'); sage('FEHLGESCHLAGENE ANFRAGEN:\n  ' + [...new Set(fehlgeschlagen)].join('\n  ')); }
const unruhig = bericht.filter((b) => !b.still).length;
if (unruhig) sage(`HINWEIS: ${unruhig} von ${bericht.length} Positionen waren nach 4 s noch nicht beruhigt — die Zahlen dort sind Zwischenstaende.`);

writeFileSync(join(OUT, 'bericht.json'), JSON.stringify({ url: URL, viewport: [W, H], dpr: DPR, reduced: REDUCED, mobile: MOBILE, geo, bericht, logs, fehlgeschlagen }, null, 2));

/* Kontaktbogen. Der Sinn des zusammenhaengenden Fotografierens ist, die Frames
 * nebeneinander zu sehen — ein Ordner mit dreissig PNG wird so nie angesehen.
 * Und er traegt genau die Befunde, die keine Messung liefert: ob die Komposition
 * etwas taugt, ob die Bewegung gleichmaessig laeuft, ob die Seite etwas sagt. */
const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg'].find((p) => p);
const spalten = Math.min(5, bericht.length);
const zeilen = Math.ceil(bericht.length / spalten);
const r = spawnSync(ffmpeg, ['-y', '-v', 'error', '-i', join(OUT, '%02d.png'),
  '-vf', `scale=520:-1,tile=${spalten}x${zeilen}`, '-frames:v', '1', join(OUT, 'bogen.png')]);
sage(r.status === 0 ? `\nKontaktbogen: ${join(OUT, 'bogen.png')} — ansehen, die Messung ersetzt ihn nicht`
  : '\nKontaktbogen ausgelassen (ffmpeg fehlt oder ist ohne scale/tile gebaut)');
sage(`Bilder und bericht.json in ${OUT}`);

if (befunde.length) { sage('\nOffene Befunde: ' + befunde.join(', ')); process.exit(1); }
sage('\nkein harter Befund');
