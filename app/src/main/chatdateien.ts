// DIE DATEILISTE HINTER DEM `@` IM EINGABEFELD DER CHAT-SITZUNG (Punkt 3).
//
// WARUM git UND NICHT EIN EIGENER FILTER. Der Auftrag verlangt „rekursiv,
// gitignore-bewusst". Eine eigene Auswertung von .gitignore waere die dritte
// Fassung dieser Regel im Umlauf (git selbst, die Editoren, wir) -- und die
// erste, die niemand pflegt: negierte Muster, verschachtelte .gitignore-Dateien,
// globale Ausschluesse und `.git/info/exclude` gehoeren alle dazu, und wer
// eines davon vergisst, bietet Dateien an, die im Projekt niemand sehen will.
// `git ls-files --cached --others --exclude-standard` beantwortet genau diese
// Frage, und zwar mit der Regel, die im Ordner wirklich gilt.
//
// OHNE git (kein Repo, kein git im PATH, Zeitgrenze, zu viel Ausgabe) bleibt der
// eigene Weg -- und er ist SCHWAECHER, das wird jetzt gesagt statt verschwiegen
// (Reviewbefund 10, 12.08.). Bis heute meldete `projektDateien` beide Wege
// gleich, und der Bericht nannte die Liste vorbehaltlos „gitignore-bewusst";
// in einem grossen Repo waren dann Dateien darin, die git ausschliesst. Der
// Rueckfall liest jetzt wenigstens die `.gitignore` DER WURZEL mit -- nicht die
// in Unterordnern, keine Negationen -- und die Antwort sagt, welcher Weg
// gegangen wurde, damit die Liste im Fenster es beschriften kann.
//
// UND ER BLOCKIERT NICHT MEHR. Der Aufruf lief als `spawnSync` im
// Hauptprozess, beim ersten `@` also bis zu fuenf Sekunden Stillstand des
// ganzen Fensters. Jetzt laeuft er als `spawn` mit einem Versprechen.
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Ein Vorschlag der `@`-Liste. */
export interface Dateivorschlag {
  /** Der Pfad RELATIV zum Projektordner -- das, was ins Feld geschrieben wird. */
  pfad: string;
  /** Ordner oder Datei? Ein Ordner bekommt in der Liste seinen Schraegstrich. */
  ordner: boolean;
}

/** Woher die Liste kommt -- die Antwort auf „wie verlaesslich ist sie?". */
export type Dateiquelle = 'git' | 'dateisystem';

/** Was `projektDateien` liefert: die Liste UND ihre Herkunft. */
export interface Dateiliste {
  quelle: Dateiquelle;
  dateien: Dateivorschlag[];
}

/**
 * Ordner, die der Rueckfallweg nie betritt. Sie sind in jedem Projekt gross,
 * und in keinem ist eine Datei daraus gemeint, wenn jemand `@` tippt.
 */
const AUSGELASSEN = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build',
  '.next', '.cache', 'target', '.gradle', '.idea', '.DS_Store',
]);

/**
 * Wieviele Eintraege hoechstens gesammelt werden. Die Liste im Fenster zeigt
 * ohnehin nur die ersten paar; alles darueber hinaus kostet nur Zeit und
 * Speicher. Ein grosses Repo (dieses hier: rund 1400 Dateien) bleibt weit
 * darunter.
 */
export const HOECHSTZAHL = 4000;

/**
 * DIE `.gitignore` DER WURZEL, so weit sie sich ohne git ehrlich lesen laesst
 * (Reviewbefund 10).
 *
 * WAS SIE KANN: die gewoehnlichen Muster -- `build/`, `*.log`, `/dist`,
 * `geheim`. WAS SIE NICHT KANN und auch nicht vorgibt zu koennen: Negationen
 * (`!wichtig.log`), `.gitignore`-Dateien in Unterordnern, globale
 * Ausschluesse, `.git/info/exclude`. Eine Negation laesst diese Funktion
 * deshalb LIEGEN, statt sie halb umzusetzen: eine halb verstandene Ausnahme
 * blendet eine Datei aus, die dastehen sollte, und das faellt niemandem auf.
 *
 * Rein und getrennt geprueft: Muster hinein, Pruefer heraus.
 */
export function gitignoreRegeln(inhalt: string): (pfad: string, ordner: boolean) => boolean {
  const regeln: { re: RegExp; nurOrdner: boolean; verankert: boolean }[] = [];
  for (const roh of inhalt.split('\n')) {
    let zeile = roh.trim();
    if (!zeile || zeile.startsWith('#') || zeile.startsWith('!')) continue;
    const nurOrdner = zeile.endsWith('/');
    if (nurOrdner) zeile = zeile.slice(0, -1);
    const verankert = zeile.startsWith('/') || zeile.slice(0, -1).includes('/');
    if (zeile.startsWith('/')) zeile = zeile.slice(1);
    if (!zeile) continue;
    // Glob in Regex: `*` trifft alles ausser dem Schraegstrich, `?` ein
    // Zeichen. Alles andere wird woertlich genommen.
    const muster = zeile
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]');
    regeln.push({ re: new RegExp(`^${muster}$`), nurOrdner, verankert });
  }
  return (pfad, ordner) => {
    const teile = pfad.split('/');
    for (const r of regeln) {
      if (r.verankert) {
        // Verankert heisst: ab der Wurzel, und alles DARUNTER faellt mit.
        const eigen = r.re.test(pfad);
        const darunter = teile.some((_, i) => i > 0 && r.re.test(teile.slice(0, i).join('/')));
        if ((eigen && (!r.nurOrdner || ordner)) || darunter) return true;
        continue;
      }
      // Unverankert heisst: an jeder Stelle des Pfades.
      for (const [i, t] of teile.entries()) {
        if (!r.re.test(t)) continue;
        const istOrdnerteil = i < teile.length - 1 || ordner;
        if (!r.nurOrdner || istOrdnerteil) return true;
      }
    }
    return false;
  };
}

/**
 * Der git-Weg, ASYNCHRON. Leere Liste heisst: kein Repo, kein git, Zeitgrenze,
 * zu viel Ausgabe -- oder wirklich leer. Welcher Fall vorlag, sagt `ok`.
 */
function ausGit(ordner: string, gitBin: string): Promise<{ ok: boolean; zeilen: string[] }> {
  return new Promise((fertig) => {
    let raus = '';
    let zuviel = false;
    let erledigt = false;
    const schluss = (ok: boolean) => {
      if (erledigt) return;
      erledigt = true;
      clearTimeout(uhr);
      fertig({
        ok,
        zeilen: ok ? raus.split('\n').map((z) => z.trim()).filter(Boolean) : [],
      });
    };
    let kind: ReturnType<typeof spawn>;
    try {
      kind = spawn(gitBin, ['-C', ordner, 'ls-files', '--cached', '--others', '--exclude-standard'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      fertig({ ok: false, zeilen: [] });
      return;
    }
    const uhr = setTimeout(() => {
      kind.kill('SIGKILL');
      schluss(false);
    }, 5000);
    kind.stdout?.setEncoding('utf8');
    kind.stdout?.on('data', (s: string) => {
      if (zuviel) return;
      raus += s;
      // Acht Megabyte sind rund 130.000 Pfade -- weit ueber allem, was die
      // Liste je zeigt. Wer darueber liegt, bekommt den Rueckfallweg samt
      // seiner Beschriftung, statt dass hier still Speicher volllaeuft.
      if (raus.length > 8 * 1024 * 1024) {
        zuviel = true;
        kind.kill('SIGKILL');
        schluss(false);
      }
    });
    kind.on('error', () => schluss(false));
    kind.on('close', (code) => schluss(code === 0));
  });
}

/** Der Rueckfallweg: selbst laufen, mit Deckel, Ausschlussliste und Wurzel-.gitignore. */
function ausDateisystem(wurzel: string): string[] {
  let ignoriert: (pfad: string, ordner: boolean) => boolean = () => false;
  try {
    ignoriert = gitignoreRegeln(readFileSync(join(wurzel, '.gitignore'), 'utf8'));
  } catch {
    // Keine .gitignore -- dann gilt nur die Ausschlussliste oben.
  }
  const raus: string[] = [];
  const warten: string[] = [wurzel];
  while (warten.length && raus.length < HOECHSTZAHL) {
    const hier = warten.shift() as string;
    let eintraege: string[];
    try {
      eintraege = readdirSync(hier);
    } catch {
      // Nicht lesbar -- dann eben nicht. Ein Ordner ohne Rechte darf die
      // ganze Liste nicht kosten.
      continue;
    }
    for (const name of eintraege) {
      if (AUSGELASSEN.has(name)) continue;
      const voll = join(hier, name);
      let istOrdner = false;
      try {
        istOrdner = statSync(voll).isDirectory();
      } catch {
        continue;
      }
      const rel = relative(wurzel, voll);
      if (ignoriert(rel.split(sep).join('/'), istOrdner)) continue;
      if (istOrdner) {
        raus.push(`${rel}${sep}`);
        warten.push(voll);
      } else {
        raus.push(rel);
      }
      if (raus.length >= HOECHSTZAHL) break;
    }
  }
  return raus;
}

/**
 * Die Dateien und Ordner eines Projektordners, so wie die `@`-Liste sie
 * anbietet. Die Ordner ergeben sich aus den Pfaden selbst -- `git ls-files`
 * nennt nur Dateien, aber wer `@app/` tippen will, braucht den Ordner in der
 * Liste.
 *
 * ASYNCHRON, damit der erste `@` das Fenster nicht anhaelt (Reviewbefund 10).
 */
export async function projektDateien(ordner: string, gitBin = 'git'): Promise<Dateiliste> {
  if (!ordner) return { quelle: 'git', dateien: [] };
  const g = await ausGit(ordner, gitBin);
  if (!g.ok) {
    return {
      quelle: 'dateisystem',
      dateien: ausDateisystem(ordner)
        .slice(0, HOECHSTZAHL)
        .map((p) => ({ pfad: p.endsWith(sep) ? p.slice(0, -1) : p, ordner: p.endsWith(sep) })),
    };
  }
  const ordnerNamen = new Set<string>();
  for (const d of g.zeilen) {
    const teile = d.split('/');
    for (let i = 1; i < teile.length; i += 1) ordnerNamen.add(teile.slice(0, i).join('/'));
  }
  const raus: Dateivorschlag[] = [];
  for (const o of ordnerNamen) raus.push({ pfad: o, ordner: true });
  for (const d of g.zeilen) raus.push({ pfad: d, ordner: false });
  // Ordner zuerst, dann alphabetisch: wer `@` tippt, meint meistens einen Ort,
  // und ein Ort ist schneller gefunden als eine von tausend Dateien.
  raus.sort((a, b) => {
    if (a.ordner !== b.ordner) return a.ordner ? -1 : 1;
    return a.pfad.localeCompare(b.pfad);
  });
  return { quelle: 'git', dateien: raus.slice(0, HOECHSTZAHL) };
}
