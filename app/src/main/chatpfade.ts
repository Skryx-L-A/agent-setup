// DIE HAUPTPROZESS-HAELFTE DER ANKLICKBAREN PFADE (Auftrag chatdatei, 05.09.2026).
//
// Der Renderer schickt je Nachricht EINE Liste von Kandidaten (chat/pfadlinks.ts,
// `pfadKandidaten`); hier wird mit `fs.stat` nachgesehen, welche davon es gibt --
// gegen das Arbeitsverzeichnis der Sitzung und gegen `~`. Was nicht existiert,
// bleibt Text; der Renderer erfaehrt es gar nicht erst.
//
// Und der Klick: der Hauptprozess entscheidet, WAS ein Pfad ist (Text, Binaer,
// Ordner) und liest den Text selbst. Gelesen wird nur, was dieser Prozess vorher
// selbst als Treffer gemeldet hat (`gemerkt`) -- der Renderer bestimmt nicht,
// welche Datei gelesen wird, dieselbe Regel wie bei Aktivitaet und Ergebnissen
// in main.ts.
import { readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { kandidatZerlegen, type PfadTreffer } from '../chat/pfadlinks';

/** Der `stat`-Ausschnitt, den die Aufloesung braucht -- austauschbar fuer die reine Pruefung. */
export type StatFn = (abs: string) => { isDirectory(): boolean; isFile(): boolean; size: number } | null;

function statOderNull(abs: string): ReturnType<StatFn> {
  try {
    return statSync(abs);
  } catch {
    return null;
  }
}

/** Die Tilde: `~` und `~/x`, nichts anderes (kein `~name`). */
function tildeAufloesen(pfad: string, home: string): string {
  if (pfad === '~') return home;
  if (pfad.startsWith('~/')) return join(home, pfad.slice(2));
  return pfad;
}

/**
 * Welche Kandidaten es gibt, und wo. Ein relativer Pfad wird ZUERST gegen das
 * Arbeitsverzeichnis der Sitzung gesucht, DANN gegen `~` -- der Auftrag nennt
 * beide, und in dieser Reihenfolge: `shell/tests/run-all.sh` meint das Projekt,
 * `.pi-workers/results` meint das Heim.
 *
 * Rein bis auf `stat`, das hereingereicht werden kann.
 */
export function pfadeAufloesen(
  kandidaten: string[],
  cwd: string,
  home: string,
  stat: StatFn = statOderNull,
): PfadTreffer[] {
  const raus: PfadTreffer[] = [];
  for (const wortlaut of kandidaten) {
    if (typeof wortlaut !== 'string' || !wortlaut || wortlaut.length > 1024) continue;
    const k = kandidatZerlegen(wortlaut);
    const roh = tildeAufloesen(k.pfad, home);
    const versuche = isAbsolute(roh)
      ? [roh]
      : [cwd ? resolve(cwd, roh) : '', home ? resolve(home, roh) : ''].filter(Boolean);
    for (const abs of versuche) {
      const st = stat(abs);
      if (!st) continue;
      if (!st.isDirectory() && !st.isFile()) continue;
      raus.push({
        kandidat: wortlaut,
        abs,
        art: st.isDirectory() ? 'ordner' : 'datei',
        zeile: k.zeile,
        spalte: k.spalte,
      });
      break;
    }
  }
  return raus;
}

/** Dateien ueber dieser Groesse gehen an das System, nicht in den Editor -- dieselbe Grenze wie main/editor.ts. */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;

/**
 * Endungen, die ohne Blick in die Datei binaer sind. Die Liste ist eine
 * Abkuerzung, keine Wahrheit: was nicht darin steht, wird an den ersten acht
 * Kilobyte geprueft (Nullbyte = binaer), genau wie `readFileSafe`.
 */
const BINAER_ENDUNGEN = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.heic', '.ico', '.icns',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.dmg', '.pkg',
  '.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.mp4', '.mov', '.mkv', '.avi', '.webm',
  '.ttf', '.otf', '.woff', '.woff2', '.sqlite', '.db', '.o', '.a', '.so', '.dylib', '.node',
  '.app', '.exe', '.dll', '.class', '.jar', '.wasm', '.pyc', '.docx', '.xlsx', '.pptx', '.numbers', '.pages', '.key',
]);

/** Was ein Klick oeffnen soll -- die Antwort an den Renderer. */
export type Oeffnung =
  | { art: 'ordner'; abs: string }
  | { art: 'extern'; abs: string }
  | { art: 'text'; abs: string; name: string; content: string };

/**
 * Sagt, wie `abs` geoeffnet wird, und liest eine Textdatei gleich mit. Wirft,
 * wenn der Pfad nicht (mehr) existiert. `extern` heisst: der Aufrufer gibt
 * den Pfad an `shell.openPath`; hier wird nichts gestartet, damit die Funktion
 * ohne Electron pruefbar bleibt.
 */
export function oeffnungBestimmen(abs: string): Oeffnung {
  const st = statSync(abs);
  if (st.isDirectory()) return { art: 'ordner', abs };
  if (!st.isFile()) throw new Error(`weder Datei noch Ordner: ${abs}`);
  if (BINAER_ENDUNGEN.has(extname(abs).toLowerCase())) return { art: 'extern', abs };
  if (st.size > MAX_TEXT_BYTES) return { art: 'extern', abs };
  const buf = readFileSync(abs);
  const probe = buf.subarray(0, Math.min(buf.length, 8192));
  if (probe.includes(0)) return { art: 'extern', abs };
  return { art: 'text', abs, name: basename(abs), content: buf.toString('utf8') };
}
