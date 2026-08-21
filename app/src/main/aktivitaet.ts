// Die Aktivitaetsliste (4c.1): nicht "einen Projektordner erkunden", sondern
// zeigen, was Worker und Sessions bereits erzeugt haben -- zeitlich geordnet,
// nach Urheber gruppiert, navigiert nach WER und WANN statt nach einem Namen,
// den man ohnehin vergisst.
//
// Zwei Quellen, beide ohne eigene Buchfuehrung auswertbar:
//   Ergebnisdateien   ~/.pi-workers/results/<worker>/<zeitstempel>.md, je
//                     Worker ALLE Zeitstempel, nicht nur der letzte -- das
//                     unterscheidet diese Liste von results.ts (V2, das den
//                     UEBERGANG leer->gefuellt EINMAL meldet). Die Liste hier
//                     ist der Ort, an dem man ein Ergebnis WIEDERFINDET, nicht
//                     der Melder; beide lesen denselben Ordner, für
//                     verschiedene Fragen.
//   Session-Aenderungen  `git log --name-only` und `git status` im
//                     Projektordner jeder SICHTBAREN Session (dieselbe
//                     Sichtbarkeit wie die Seitenleiste, A12/4c.2 -- eine
//                     geschlossene Session verschwindet aus dieser Liste,
//                     obwohl ihre Ergebnisdateien liegen bleiben) UND im
//                     eigenen Arbeitsbaum jedes Workers (V15, Schritt 9): ein
//                     Worker arbeitet seit dem 04.08. unter
//                     ~/.pi-workers/worktrees/<name> auf dem Zweig
//                     wb/<name> -- ein eigenes Verzeichnis, das der
//                     Session-Ordner NIE mitliest. Ohne diesen zweiten Ort
//                     waere die Arbeit eines Workers in dieser Liste nur als
//                     Ergebnisdatei sichtbar, nie als Diff.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isExcluded } from './folder';

export interface AktivitaetEintrag {
  typ: 'ergebnis' | 'aenderung';
  wer: string;
  wannMs: number;
  pfad: string;
  groesse: number;
  /** Nur bei 'aenderung': die Commit-Botschaft, oder leer bei unversioniert. */
  kommentar: string;
  sessionId: string;
  /** Nur bei 'aenderung': das git-Arbeitsverzeichnis, aus dem der Eintrag stammt (fuer den Diff). */
  dir: string;
  /** Nur bei 'aenderung' aus einem Commit: dessen Hash. Leer bei unversioniert oder bei 'ergebnis'. */
  commitHash: string;
}

const GIT_TIMEOUT_MS = 3000;
const MAX_COMMITS = 30;
/** Dieselbe Grenze wie editor.ts (MAX_FILE_BYTES) -- Monaco liest Text, nicht Streaming. */
const MAX_LESE_BYTES = 5 * 1024 * 1024;

function ergebnisEintraege(resultsDir: string, worker: string, sessionId: string): AktivitaetEintrag[] {
  const ordner = join(resultsDir, worker);
  let namen: string[];
  try {
    namen = readdirSync(ordner);
  } catch {
    return [];
  }
  const raus: AktivitaetEintrag[] = [];
  for (const name of namen) {
    if (name === 'latest.md' || !name.endsWith('.md')) continue;
    // Eine gescheiterte Zustellung ist KEIN Ergebnis (2026-08-20). Die Datei
    // endet auf '.md' und lag deshalb bisher als Ergebniseintrag in der
    // Aktivitaet -- also genau die Verwechslung von "Zustellung gescheitert" und
    // "Arbeit fertig", gegen die pi-worker sie ueberhaupt erst unter eigenem
    // Namen ablegt. `wb-ereignisse` uebergeht sie schon (ergebnis_von() dort);
    // hier fehlte es. Der Fall ist heute zweimal im Betrieb aufgetreten, und
    // beide Male hat der Worker trotzdem gearbeitet.
    if (name.endsWith('.zustellung-fehlgeschlagen.md')) continue;
    const pfad = join(ordner, name);
    try {
      const st = statSync(pfad);
      if (!st.isFile() || st.size === 0) continue;
      raus.push({ typ: 'ergebnis', wer: worker, wannMs: st.mtimeMs, pfad, groesse: st.size, kommentar: '', sessionId, dir: '', commitHash: '' });
    } catch {
      // zwischen readdir und stat verschwunden -- kein Fehler, nur weg
    }
  }
  return raus;
}

function git(dir: string, args: string[]): string | null {
  const r = spawnSync('git', ['--no-optional-locks', '-C', dir, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
  });
  if (r.status !== 0 || r.error) return null;
  return r.stdout ?? '';
}

const EINTRAG_MARKE = '\x1e';
const FELD_MARKE = '\x1f';

/**
 * `dir` ist der Projektordner einer Session oder der Arbeitsbaum eines
 * Workers -- git kennt seine eigenen Interna (`.git/**`) nicht als
 * Ausschluss, deshalb kommt jeder Pfad hier durch DIESELBE Pruefung wie im
 * Baum und in der Suche. Ohne das haette ein unversionierter
 * `90-secrets`-Ordner (git status meldet ihn als `??`) genau die Auflage aus
 * 4c.2 verletzt, die der Baum und die Suche einhalten -- gefunden am eigenen
 * Belegbild, nicht vorher bedacht.
 *
 * `baseRef`, wenn angegeben und in `dir` aufloesbar: der Log wird auf
 * `baseRef..HEAD` beschraenkt -- nur Commits, die es auf `HEAD`, aber nicht
 * auf `baseRef` gibt. Fuer den Arbeitsbaum eines Workers (Zweig `wb/<name>`,
 * abgezweigt von `main`) ist das der Unterschied zwischen "die eigene Arbeit
 * dieses Workers" und "die gesamte geerbte Geschichte von main bis hierher" --
 * ein ungebundener `git log -n 30` in einem frischen Arbeitsbaum ohne eigene
 * Commits zeigt sonst 30 fremde, laengst bestehende Commits von main, faelschlich
 * dem Worker zugeschrieben. Ohne `baseRef` (Session-Ordner) bleibt das alte,
 * ungebundene Verhalten unveraendert: dort gibt es keinen Abzweigpunkt, gegen
 * den sich sinnvoll begrenzen liesse.
 */
function commitEintraege(dir: string, sessionId: string, wer: string, excludeGlobs: string[], baseRef = ''): AktivitaetEintrag[] {
  if (git(dir, ['rev-parse', '--show-toplevel']) === null) return [];
  const range = baseRef && git(dir, ['rev-parse', '--verify', baseRef]) !== null ? `${baseRef}..HEAD` : '';
  const logArgs = range
    ? ['log', range, '-n', String(MAX_COMMITS), '--name-only', `--pretty=format:${EINTRAG_MARKE}%H${FELD_MARKE}%at${FELD_MARKE}%s`]
    : ['log', '-n', String(MAX_COMMITS), '--name-only', `--pretty=format:${EINTRAG_MARKE}%H${FELD_MARKE}%at${FELD_MARKE}%s`];
  const log = git(dir, logArgs);
  const raus: AktivitaetEintrag[] = [];
  if (log) {
    for (const block of log.split(EINTRAG_MARKE)) {
      if (!block.trim()) continue;
      const zeilen = block.split('\n');
      const kopf = zeilen[0].split(FELD_MARKE);
      if (kopf.length < 3) continue;
      const commitHash = kopf[0];
      const wannMs = Number(kopf[1]) * 1000;
      const kommentar = kopf[2];
      for (const datei of zeilen.slice(1)) {
        if (!datei.trim()) continue;
        const pfad = join(dir, datei);
        if (isExcluded(pfad, excludeGlobs)) continue;
        raus.push({ typ: 'aenderung', wer, wannMs, pfad, groesse: 0, kommentar, sessionId, dir, commitHash });
      }
    }
  }

  const status = git(dir, ['status', '--porcelain']);
  if (status) {
    for (const zeile of status.split('\n')) {
      if (!zeile.trim()) continue;
      // Format: 'XY pfad' oder bei Umbenennung 'XY alt -> neu'. Ein
      // unversioniertes VERZEICHNIS traegt einen abschliessenden
      // Schraegstrich -- der muss weg, sonst liefert der letzte Pfadteil
      // (fuer die Anzeige) eine leere Zeichenkette statt des Ordnernamens.
      let rel = zeile.slice(3).replace(/\/$/, '');
      const pfeil = rel.indexOf(' -> ');
      if (pfeil >= 0) rel = rel.slice(pfeil + 4);
      const pfad = join(dir, rel);
      if (isExcluded(pfad, excludeGlobs)) continue;
      let wannMs = Date.now();
      try {
        wannMs = statSync(pfad).mtimeMs;
      } catch {
        // geloescht oder unlesbar -- 'jetzt' ist die ehrlichste verfuegbare Angabe
      }
      raus.push({ typ: 'aenderung', wer, wannMs, pfad, groesse: 0, kommentar: 'geaendert, nicht committet', sessionId, dir, commitHash: '' });
    }
  }
  return raus;
}

export interface AktivitaetSession {
  id: string;
  name: string;
  dir: string;
  workers: { name: string; dir: string }[];
}

/**
 * Beide Quellen zusammengefuehrt, absteigend nach Zeit. `sessions` MUSS schon
 * die sichtbare Menge sein (derselbe Filter wie die Seitenleiste) -- diese
 * Funktion filtert nicht selbst, sie liest nur, was ihr uebergeben wird.
 */
export function leseAktivitaet(
  resultsDir: string,
  sessions: AktivitaetSession[],
  excludeGlobs: string[],
  limit = 200,
): AktivitaetEintrag[] {
  const raus: AktivitaetEintrag[] = [];
  for (const s of sessions) {
    for (const w of s.workers) {
      raus.push(...ergebnisEintraege(resultsDir, w.name, s.id));
      // Nur ein EIGENER Arbeitsbaum bringt etwas Neues -- ein Worker, der
      // (noch, altes Verhalten vor dem 04.08.) direkt im Session-Ordner
      // arbeitet, wuerde sonst dieselben Commits zweimal liefern: einmal hier
      // unter seinem eigenen Namen, einmal unten unter dem Sessionnamen.
      if (w.dir && w.dir !== s.dir) raus.push(...commitEintraege(w.dir, s.id, w.name, excludeGlobs, 'main'));
    }
    if (s.dir) raus.push(...commitEintraege(s.dir, s.id, s.name, excludeGlobs));
  }
  raus.sort((a, b) => b.wannMs - a.wannMs);
  return raus.slice(0, limit);
}

// --- Inhalt, Diff und Auftragskontext eines Eintrags (V15/V18, Schritt 9) --

function leseSicher(pfad: string): string {
  const st = statSync(pfad);
  if (!st.isFile()) throw new Error(`keine Datei: ${pfad}`);
  if (st.size > MAX_LESE_BYTES) {
    throw new Error(`Datei zu gross (${Math.round(st.size / 1024)} KB, Grenze ${Math.round(MAX_LESE_BYTES / 1024)} KB): ${pfad}`);
  }
  const buf = readFileSync(pfad);
  const probe = buf.subarray(0, Math.min(buf.length, 8192));
  if (probe.includes(0)) throw new Error(`keine Textdatei (Binaerinhalt erkannt): ${pfad}`);
  return buf.toString('utf8');
}

/**
 * Der Inhalt eines Eintrags, fuer den ersten Klick ("oeffnet es in der
 * Mitte"). Ungeprueft, WER den Pfad anfragen darf -- das entscheidet der
 * Aufrufer (main.ts), indem er nur Pfade hier hereinreicht, die er selbst
 * gerade in `leseAktivitaet()` gesehen hat.
 */
export function leseInhalt(pfad: string): string {
  return leseSicher(pfad);
}

function relPosix(dir: string, pfad: string): string {
  return relative(dir, pfad).split(sep).join('/');
}

export interface DiffInhalt {
  original: string;
  modified: string;
}

/**
 * Zwei volle Fassungen (nicht ein Patch-Text) fuer den zweiten Klick auf
 * einen 'aenderung'-Eintrag -- Monaco stellt den Vergleich selbst dar
 * (`createDiffEditor`), ein eigener Zeilenvergleich waere doppelte Arbeit.
 *
 * Committet (commitHash gesetzt): `git show <hash>^:datei` gegen
 * `git show <hash>:datei` -- GENAU der Commit, der in dieser Zeile steht,
 * nicht die gesamte Astgeschichte. Schlaegt `<hash>^` fehl (Erstcommit oder
 * die Datei gab es vorher nicht), gilt die alte Fassung als leer -- das ist
 * fuer eine neu angelegte Datei die richtige Aussage.
 * Unversioniert (kein commitHash): `git show HEAD:datei` (leer bei einer
 * neuen, noch nicht versionierten Datei) gegen den aktuellen Inhalt auf der
 * Platte.
 */
export function leseDiffFuerEintrag(e: AktivitaetEintrag): DiffInhalt | null {
  if (e.typ !== 'aenderung' || !e.dir) return null;
  const rel = relPosix(e.dir, e.pfad);
  if (e.commitHash) {
    const original = git(e.dir, ['show', `${e.commitHash}^:${rel}`]) ?? '';
    const modified = git(e.dir, ['show', `${e.commitHash}:${rel}`]) ?? '';
    return { original, modified };
  }
  const original = git(e.dir, ['show', `HEAD:${rel}`]) ?? '';
  let modified = '';
  try {
    modified = leseSicher(e.pfad);
  } catch {
    modified = ''; // geloescht, aber noch als 'geaendert' in git status -- selten, aber kein Fehler
  }
  return { original, modified };
}

export interface AuftragKontext {
  auftrag: string;
  ergebnis: string;
}

/**
 * Auftrag und Ergebnis nebeneinander (V18) -- fuer den zweiten Klick auf
 * einen 'ergebnis'-Eintrag. `shell/pi-worker` legt den Auftragstext seit dem
 * 05.08. unter DEMSELBEN Zeitstempel wie die Ergebnisdatei ab, nur mit der
 * Endung `.auftrag.txt` statt `.md` -- daraus laesst sich die Begleitdatei
 * ableiten, ohne das Auftragsbuch selbst zu parsen. Ein Ergebnis von VOR dem
 * 05.08. hat keine solche Datei; das ist kein Fehler, sondern "nicht
 * aufgezeichnet".
 */
export function leseAuftragFuerErgebnis(ergebnisPfad: string): AuftragKontext {
  const auftragPfad = ergebnisPfad.replace(/\.md$/, '.auftrag.txt');
  let auftrag = '';
  try {
    auftrag = leseSicher(auftragPfad);
  } catch {
    auftrag = '';
  }
  let ergebnis = '';
  try {
    ergebnis = leseSicher(ergebnisPfad);
  } catch {
    ergebnis = '';
  }
  return { auftrag, ergebnis };
}
