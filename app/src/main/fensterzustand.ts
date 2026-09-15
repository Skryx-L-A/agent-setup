// Position und Groesse des Hauptfensters ueberleben einen Neustart (Hausregel
// macOS). Eigene, kleine Datei statt eines Zusatzes in uistate.ts: die
// UI-Datei dort gehoert der Bedienung der Oberflaeche (Leistenbreiten,
// Sortierung, gewaehlte Sitzung) -- ein Betriebssystem-Fensterrahmen ist
// etwas anderes, und zwei Bedeutungen in derselben Datei sind genau der
// Fehler, den der Kopf von uistate.ts fuer `chatAnsichtSitzung` schon
// beschreibt. Dieselbe Schreibweise trotzdem: atomar (tmp + rename), still
// bei einem nicht schreibbaren Ziel.
import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, screen } from 'electron';

/**
 * `x`/`y`: die AEUSSERE Fensterposition (wie `getBounds()`). `width`/`height`:
 * die INHALTS-Groesse (wie `getContentSize()`). Diese Mischung ist bewusst --
 * genau die Form, die ein `new BrowserWindow({ x, y, width, height,
 * useContentSize: true })` erwartet (`useContentSize` haengt nur an
 * width/height, nie an x/y). Beide gleich als Aussenmasse zu speichern liesse
 * das Fenster auf einer Plattform mit sichtbarem Rahmen (Windows/Linux) bei
 * jedem Neustart um die Rahmenhoehe wachsen -- auf dem Mac faellt der
 * Unterschied bei `hiddenInset` nicht auf, weil dort Rahmen- und
 * Inhaltsgroesse gleich sind, deshalb waere der Fehler hier leicht uebersehen.
 */
export interface FensterBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function datei(stateDir: string): string {
  return join(stateDir, 'fenster.json');
}

/** Der gemerkte Rahmen, oder `null` -- erster Start, oder die Datei ist kaputt. */
export function fensterzustandLesen(stateDir: string): FensterBounds | null {
  try {
    const roh = JSON.parse(readFileSync(datei(stateDir), 'utf8')) as Partial<FensterBounds>;
    const { x, y, width, height } = roh;
    if ([x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return { x: x as number, y: y as number, width: width as number, height: height as number };
    }
  } catch {
    // Erster Start, oder die Datei ist kaputt -- dann gilt die Pane-Groesse.
  }
  return null;
}

/**
 * Nur gueltig, wenn die MITTE des gemerkten Rahmens auf einem HEUTE
 * angeschlossenen Bildschirm liegt -- sonst haengt das Fenster unsichtbar
 * dort, wo gestern ein zweiter Monitor stand.
 */
export function gemerktesBoundsGueltig(bounds: FensterBounds | null): bounds is FensterBounds {
  if (!bounds) return false;
  if (bounds.width < 200 || bounds.height < 150) return false;
  const mitteX = bounds.x + bounds.width / 2;
  const mitteY = bounds.y + bounds.height / 2;
  return screen.getAllDisplays().some((d) => {
    const { x, y, width, height } = d.workArea;
    return mitteX >= x && mitteX < x + width && mitteY >= y && mitteY < y + height;
  });
}

/**
 * Nach jeder Groessen-/Positionsaenderung geschrieben, aber gebremst: ein
 * Ziehen am Rahmen feuert 'resize' pro Bildpunkt, und eine Schreibrunde je
 * Ereignis waere reines Rauschen. 400 ms nach dem letzten Ereignis reicht --
 * niemand liest die Datei, solange das Fenster laeuft.
 *
 * Waehrend Vollbild oder Zoom (maximiert) wird NICHT gemerkt: der dann
 * gemeldete Rahmen ist der ganze Bildschirm, und das beim naechsten Start als
 * feste Pixelzahl wiederherzustellen saehe wie maximiert aus, waere es aber
 * nicht -- der naechste normale Rahmen (vor dem Zoomen) bleibt stattdessen
 * stehen.
 */
export function fensterzustandVerfolgen(w: BrowserWindow, stateDir: string): void {
  let zeitgeber: ReturnType<typeof setTimeout> | null = null;
  const merken = (): void => {
    if (zeitgeber) clearTimeout(zeitgeber);
    zeitgeber = setTimeout(() => {
      if (w.isDestroyed() || w.isMinimized() || w.isMaximized() || w.isFullScreen()) return;
      const outer = w.getBounds();
      const [breite, hoehe] = w.getContentSize();
      const bounds: FensterBounds = { x: outer.x, y: outer.y, width: breite, height: hoehe };
      try {
        mkdirSync(stateDir, { recursive: true });
        const ziel = datei(stateDir);
        const tmp = `${ziel}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(bounds));
        renameSync(tmp, ziel);
      } catch {
        // Ein nicht schreibbarer Zustand darf das Fenster nicht anhalten.
      }
    }, 400);
  };
  w.on('resize', merken);
  w.on('move', merken);
}
