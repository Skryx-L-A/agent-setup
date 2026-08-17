// Die Inhaltssuche (4c.1, zweiter Rueckfallweg neben der Aktivitaetsliste):
// wenn der Name weg ist, erinnert man oft, was drinstand. `rg` macht die
// eigentliche Arbeit; diese Datei uebersetzt nur die Ausschlussliste in seine
// Glob-Syntax und raeumt die Ausgabe fuer die Anzeige auf.
//
// Dieselbe Auflage wie beim Baum: eine Suche, die in `~/Knowledge/90-secrets/`
// oder `~/.ssh/` fuendig wird, hebt die Auflage aus 4c.2 auf. Deshalb bekommt
// `rg` die Ausschlussliste als eigene `-g`-Argumente, zusaetzlich zur eigenen
// Pruefung in folder.ts, die dieselbe Konfiguration liest.
import { spawnSync } from 'node:child_process';

const TIMEOUT_MS = 8000;
const MAX_TREFFER = 200;

/**
 * `**\/x` und `**\/x/**` (unsere Ausschlussliste) zu `!x` (rg/gitignore-
 * Syntax, wo ein Muster ohne fuehrenden Schraegstrich ohnehin jede Tiefe
 * matcht). Alles andere bleibt, wie es ist -- rg kennt `*` bereits selbst.
 */
function zuRgGlob(glob: string): string {
  let g = glob;
  if (g.startsWith('**/')) g = g.slice(3);
  if (g.endsWith('/**')) g = g.slice(0, -3);
  return `!${g}`;
}

export interface Treffer {
  pfad: string;
  zeile: number;
  text: string;
}

/**
 * Sucht `query` unter `root`. Liefert null, wenn `rg` fehlt oder abbricht --
 * das ist ein Ausstattungsproblem, kein leeres Ergebnis, und die Anzeige darf
 * beides nicht verwechseln.
 */
export function sucheInhalt(root: string, query: string, excludeGlobs: string[]): Treffer[] | null {
  if (!query.trim()) return [];
  const globArgs = [...new Set(excludeGlobs.map(zuRgGlob))].flatMap((g) => ['-g', g]);
  const r = spawnSync(
    'rg',
    [
      '--line-number', '--no-heading', '--color=never', '--hidden',
      '-g', '!.git',
      ...globArgs,
      '-m', '20', // hoechstens 20 Treffer je Datei, damit eine einzelne Datei die Liste nicht flutet
      '--', query, root,
    ],
    { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
  );
  // rg: 0 = Treffer, 1 = kein Treffer (kein Fehler), 2 = echter Fehler.
  if (r.error || r.status === 2) return null;
  const zeilen = (r.stdout ?? '').split('\n').filter(Boolean);
  const raus: Treffer[] = [];
  for (const zeile of zeilen) {
    const erste = zeile.indexOf(':');
    const zweite = zeile.indexOf(':', erste + 1);
    if (erste < 0 || zweite < 0) continue;
    const pfad = zeile.slice(0, erste);
    const nr = Number(zeile.slice(erste + 1, zweite));
    if (!Number.isFinite(nr)) continue;
    raus.push({ pfad, zeile: nr, text: zeile.slice(zweite + 1).trim().slice(0, 300) });
    if (raus.length >= MAX_TREFFER) break;
  }
  return raus;
}
