// V6 -- das Programm fotografiert sein eigenes Fenster.
//
// Ueber webContents.capturePage(). Das verlangt weder Bedienungshilfen- noch
// Aufnahme-Recht, nimmt niemandem den Fokus und funktioniert bei einem Fenster,
// das mit show:false nie auf dem Bildschirm war. Genau dieser Punkt hat die
// Wahl des Stapels entschieden: der gemessene Gegenkandidat lieferte bei einem
// verdeckten Fenster schweigend ein veraltetes Bild.
import { BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface ShotResult {
  path: string;
  bytes: number;
  width: number;
  height: number;
  /** Bildpunkte je CSS-Pixel im geschriebenen PNG. */
  scaleFactor: number;
}

function timestampName(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `shot-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}.png`;
}

export async function captureWindow(win: BrowserWindow, shotDir: string, requested?: string): Promise<ShotResult> {
  // Zwei Bildwechsel abwarten, damit das Bild den Stand NACH der letzten
  // Aenderung zeigt und nicht den davor. Ein Foto, das schweigend das Falsche
  // zeigt, ist schlechter als gar keins, weil man ihm glaubt.
  await win.webContents.executeJavaScript(
    'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
  );

  const image = await win.webContents.capturePage();
  // toPNG() schreibt ohne Angabe mit Faktor 1 und rechnet ein Retina-Bild damit
  // auf die halbe Kantenlaenge herunter. Auf einem halbierten Beleg fallen
  // Verschiebungen um wenige Bildpunkte und duenne Kanten unter die
  // Messschwelle -- deshalb wird der eigene Faktor des Bildes mitgegeben.
  const faktor = Math.max(1, ...image.getScaleFactors());
  const png = image.toPNG({ scaleFactor: faktor });
  const size = image.getSize();

  const target = requested
    ? (isAbsolute(requested) ? requested : join(shotDir, requested))
    : join(shotDir, timestampName());
  mkdirSync(shotDir, { recursive: true });
  writeFileSync(target, png);

  return { path: target, bytes: png.length, width: size.width, height: size.height, scaleFactor: faktor };
}
