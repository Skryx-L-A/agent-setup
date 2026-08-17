// Die Ordneransicht (4c.2): ein Baum, der bei der Session anfaengt, in der man
// gerade ist, und `~/Knowledge/90-secrets/` sowie `~/.ssh/` AUSLAESST -- nicht
// nur ihren Inhalt verbirgt. Ein Pfad, der hier nicht drin ist, kann auch bei
// einem Fehler nirgends auftauchen; ein nur verstecktes Kind waere ein
// Versprechen, das ein spaeterer Bug einloesen kann.
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Ein einzelnes Glob-Muster in einen regulaeren Ausdruck uebersetzt.
 * Unterstuetzt genau die Formen, die die Ausschlussliste tatsaechlich
 * braucht: ein fuehrendes `** /` (beliebig viele Pfadstuecke, auch keins),
 * ein abschliessendes `/** ` (dito), und `*` fuer ein einzelnes Pfadstueck.
 * Kein vollstaendiger Glob-Motor -- ein pruefbarer Ausschnitt reicht, weil die
 * Muster aus der Konfiguration kommen und dort einsehbar bleiben (die
 * PRUEFUNG dieser Datei ist die Zusicherung, nicht die Allgemeinheit).
 */
function globZuRegExp(glob: string): RegExp {
  // Funktions-Ersatz statt einer Ersatz-ZEICHENKETTE: sonst deutet
  // String.replace ein '$' im HOME-Pfad selbst als Ersatzmuster (z.B. '$&').
  let g = glob.replace(/^~(?=\/|$)/, () => homedir());
  let rumpf = '';
  if (g.startsWith('**/')) {
    rumpf += '(?:.*/)?';
    g = g.slice(3);
  }
  let schwanz = '';
  if (g.endsWith('/**')) {
    schwanz = '(?:/.*)?';
    g = g.slice(0, -3);
  }
  let mitte = '';
  for (const teil of g) {
    if (teil === '*') mitte += '[^/]*';
    else if ('.+^${}()|[]\\'.includes(teil)) mitte += `\\${teil}`;
    else mitte += teil;
  }
  return new RegExp(`^${rumpf}${mitte}${schwanz}$`);
}

/** Ob ein absoluter Pfad gegen irgendeines der Ausschlussmuster trifft. */
export function isExcluded(absPath: string, globs: string[]): boolean {
  return globs.some((g) => {
    try {
      return globZuRegExp(g).test(absPath);
    } catch {
      // Ein kaputtes Muster darf die Pruefung nicht lautlos ausser Kraft
      // setzen -- im Zweifel gilt der Pfad als AUSGESCHLOSSEN, nicht als frei.
      return true;
    }
  });
}

export interface EintragInfo {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

/**
 * Die Kinder eines Ordners -- ausgeschlossene Pfade fehlen VOLLSTAENDIG, sie
 * stehen nicht einmal geblendet in der Antwort. Ordner zuerst, dann Dateien,
 * je alphabetisch. Ein Lesefehler an einem einzelnen Kind (Rechte, ein
 * verschwundenes Ziel eines Symlinks) faellt das Kind weg, nicht den ganzen
 * Ordner.
 */
export function listDir(absPath: string, excludeGlobs: string[]): EintragInfo[] {
  let namen: string[];
  try {
    namen = readdirSync(absPath);
  } catch {
    return [];
  }
  const raus: EintragInfo[] = [];
  for (const name of namen) {
    const pfad = join(absPath, name);
    if (isExcluded(pfad, excludeGlobs)) continue;
    try {
      const st = statSync(pfad);
      raus.push({ name, path: pfad, isDir: st.isDirectory(), size: st.isFile() ? st.size : 0, mtimeMs: st.mtimeMs });
    } catch {
      // nicht lesbar oder gerade verschwunden -- faellt weg, ohne den Rest zu stoppen
    }
  }
  raus.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return raus;
}
