// Der Zustand eines Workers kommt aus Dateien und aus Prozesseigenschaften --
// NIE aus `capture-pane` (V1). Diese Datei ist die eine Stelle, an der jede
// Zahl ihre Quelle bekommt, und jede Wahl steht hier mit ihrem Grund.
//
// Warum ueberhaupt: Der Kontext-Guard liest die Auslastung aus der Statuszeile
// des Panes. Am 04.08. um 10:19 meldete er fuer einen Pane "BLIND — weder
// Transcript noch Statuszeile lesbar", weil drei Worker nebeneinander den Pane
// unter 80 Spalten gedrueckt hatten. Ein Zustand, der von der Fensterbreite
// abhaengt, ist kein Zustand. Das Programm legt die Panes selbst an und kennt
// Name, Modell, Verzeichnis, Aufgabe und Ergebnispfad jedes Workers -- es muss
// nichts vom Bildschirm ablesen.
//
// DIE VIER QUELLEN, je Angabe genau eine:
//
//   Kontextauslastung  Das Transcript der Sitzung,
//                      ~/.claude/projects/<projektschluessel>/<sessionId>.jsonl.
//                      Die sessionId steht in der Zustandsdatei der Session
//                      (Feld `claudeSessionId` je Worker), also gibt es hier
//                      KEIN Raten: der Guard muss den Prozessbaum durchsuchen
//                      und gibt auf, sobald mehrere Sitzungen in einem Ordner
//                      liegen -- wir wissen es einfach.
//   Lebendigkeit       Ob ein tmux-Pane mit `@wb_worker=<name>` existiert.
//                      Steht in sessions.ts, nicht hier.
//   Fortschritt        Das WACHSTUM des Transcripts (mtime). Ausdruecklich
//                      NICHT die CPU-Zeit: `regeln/worker-panes.md` haelt den
//                      gemessenen Fall fest, in dem ein Scan in 82 Minuten
//                      1,3 Sekunden CPU verbrauchte, waehrend er durchgehend
//                      arbeitete -- ein Client, der auf eine Antwort wartet,
//                      rechnet nicht. Das Transcript dagegen waechst mit jeder
//                      Nachricht und jedem Werkzeugergebnis.
//   Blockiert          Nur aus den Antragsdateien (offener `wb-request`).
//                      Eine Berechtigungsfrage der CLI ist von hier aus NICHT
//                      sicher von "haengt" zu unterscheiden -- sie steht
//                      ausschliesslich im Pane-Text, und den lesen wir nach
//                      V1 nicht. Deshalb wird sie hier NICHT geraten; Schritt 5
//                      (Freigabe-Ansicht) bringt die verlaessliche Quelle.
//
// FUENFTE QUELLE, fuer jeden Worker, dessen Harness NICHT Claude ist
// (2026-08-11): die Kontextauslastung kam bis heute nur fuer Claude-Worker an
// -- jeder andere Harness (codex, aider, crush, gptme, copilot, cline,
// openhands, ...) blieb bei contextPercent -1, weil oben nur das
// Claude-Transcript gelesen wird. Gelesen wird sie ueber denselben Leser wie
// in der Kontextwache (`shell/wb-session-load`, ein Skript, zwei Aufrufer):
// der session-Block des Harness in der Modell-Registry (Feld `harnesses[].
// session`) nennt Ort, Format und Hoechstalter der Sitzungsdatei, und dieses
// eine Skript weiss, wie man je Format liest. KEIN zweiter Parser in
// TypeScript -- genau die Doppelung (ein Leser in bash/Python, ein zweiter in
// TypeScript), die diese Werkbank am 06.08. teuer bezahlt hat. Warum jedes
// Format so und nicht anders gelesen wird, steht bei `shell/wb-session-load`
// und in `shell/context-guard` direkt vor `session_load()`.
import { statSync, openSync, readSync, closeSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * `haengt`-Schwelle in Sekunden: so lange darf im Transcript nichts passieren,
 * bevor ein Worker als haengend gilt -- und auch dann nur, wenn kein
 * Kindprozess juenger ist als diese Stille (siehe `stillstand`).
 *
 * GEMESSEN am 05.08., vorher geraten. Ausgewertet wurden 11.070 Abstaende
 * zwischen aufeinanderfolgenden Transcript-Zeilen aus 17 Sitzungen von
 * Workern, die durchgearbeitet und ein Ergebnis abgeliefert haben --
 * `shell/messungen/transcript-luecken.py` fuehrt die Messung erneut. Ein
 * arbeitender Worker schweigt im Mittel unter einer Sekunde; die Verteilung
 * hat aber einen langen Rand, und fuer eine Schwelle zaehlt der Rand:
 *
 *     p50 0,9 s   p90 11,6 s   p95 22,7 s   p99 90,8 s   p99,9 522 s
 *
 * Wieviele arbeitende Sitzungen faelschlich als haengend gemeldet wuerden:
 *
 *     300 s   8 von 17 Sitzungen, 29 Faelle
 *     450 s   6 von 17 Sitzungen, 18 Faelle
 *     600 s   4 von 17 Sitzungen,  8 Faelle
 *     900 s   3 von 17 Sitzungen,  7 Faelle
 *
 * Gewaehlt sind 600: der Wert liegt ueber dem 99,9-Prozent-Rand von 522 s und
 * halbiert die betroffenen Sitzungen gegenueber 300, ohne einen wirklich
 * steckengebliebenen Worker eine Viertelstunde lang zu verschweigen. Die acht
 * verbleibenden Faelle sind lange Wartezeiten auf Fremdlaeufe -- Bauschritte,
 * Testsuiten --, und genau die faengt die zweite Bedingung ab: ein
 * Kindprozess, der juenger ist als die Stille, verhindert die Meldung.
 */
export const STALL_SECONDS_DEFAULT = 600;

/**
 * Der Projektschluessel, unter dem Claude Code die Transcripte eines
 * Verzeichnisses ablegt: jedes Zeichen ausser Buchstaben und Ziffern wird zum
 * Bindestrich. Gemessen an den vorhandenen Ordnern -- `/Users/x/.pi-workers/…`
 * wird zu `-Users-x--pi-workers-…`, der Punkt also wie der Schraegstrich.
 * (Der Kontext-Guard ersetzt nur den Schraegstrich und findet das Transcript
 * eines Worktrees deshalb nicht; hier ist es korrigiert.)
 */
export function projektSchluessel(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Das Kontextfenster eines Modells kommt aus der MODELL-REGISTRY und nirgends
 * sonst her -- derselben Datei, aus der `wb-state models get <id> --field
 * contextWindow` antwortet. Eine Zahl, die an mehreren Stellen behauptet wird,
 * ist keine Quelle, sondern ein Widerspruch in Wartestellung; `wb-consistency`
 * prueft im Haus genau darauf.
 *
 * Steht dort nichts, wird hier NICHT geraten: 0 heisst "unbekannt", und die
 * Anzeige zeigt dann die belegten Tokens statt einer erfundenen Prozentzahl.
 * Ein fehlender Eintrag soll sichtbar werden, nicht durch eine dritte Kopie
 * ueberdeckt.
 */
const registry = new Map<string, { mtimeMs: number; fenster: Map<string, number> }>();

function registryLesen(pfad: string): Map<string, number> {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(pfad).mtimeMs;
  } catch {
    return new Map();
  }
  const alt = registry.get(pfad);
  if (alt && alt.mtimeMs === mtimeMs) return alt.fenster;
  const fenster = new Map<string, number>();
  try {
    const roh = JSON.parse(readFileSync(pfad, 'utf8')) as unknown;
    const liste = (Array.isArray(roh) ? roh : ((roh as { models?: unknown[] })?.models ?? [])) as Record<string, unknown>[];
    for (const m of liste) {
      const w = Number(m.contextWindow);
      if (!Number.isFinite(w) || w <= 0) continue;
      // Ueber die Kennung UND den Kurznamen: in der Zustandsdatei steht mal
      // `claude-opus-5:xhigh`, mal der Alias `opus5`.
      for (const k of [m.id, m.alias, m.modelRef]) if (k) fenster.set(String(k), w);
    }
  } catch {
    // Eine unlesbare Registry heisst "unbekannt", nicht "nimm irgendetwas an".
  }
  registry.set(pfad, { mtimeMs, fenster });
  return fenster;
}

export function kontextFenster(model: string, modelsFile: string): number {
  // `claude-opus-5:xhigh` -> `claude-opus-5`; der Effort gehoert nicht dazu.
  //
  // UND `claude-opus-5[1m]` -> `claude-opus-5` (Reviewbefund 11, 12.08.). Die
  // eckige Klammer nennt die FENSTER-VARIANTE, und genau in dieser Form meldet
  // der Harness sein Standardmodell: `resolvedModel: "claude-opus-5[1m]"` steht
  // so in der gemessenen Modellliste des Handschlags. Die Registry fuehrt die
  // Kennung ohne Klammer, also fand eine Chat-Sitzung ohne `--model` ihr
  // Kontextfenster nicht, und der Balken fehlte kommentarlos.
  //
  // Abgeschnitten wird nur die KENNUNG, nicht die Zahl dahinter: welches
  // Fenster `[1m]` wirklich bedeutet, steht in der Registry und wird hier nicht
  // erfunden. Fuehrt sie einen eigenen Eintrag mit Klammer, gewinnt der --
  // deshalb wird zuerst die volle Kennung gefragt.
  const roh = model.split(':')[0].trim();
  const fenster = registryLesen(modelsFile);
  return fenster.get(roh) ?? fenster.get(roh.replace(/\[[^\]]*\]$/, '')) ?? 0;
}

/**
 * Der `session`-Block eines Harness aus der Modell-Registry -- dieselbe Datei,
 * derselbe Mtime-Merker wie bei `registryLesen` oben. Nur Eintraege mit
 * `via: "sessionFile"` UND einem Ort sind ueberhaupt lesbar; alles andere
 * (leer, `http-sse`, `acp`) hat hier nichts zu suchen -- `wb-session-load`
 * kennt ohnehin nur sieben Formate und liefert fuer den Rest nichts, aber ein
 * Aufruf, der von vornherein zwecklos ist, bleibt besser aus.
 */
export interface HarnessSessionSpec {
  via: string;
  ort: string;
  format: string;
  maxAgeSec: number | null;
}

const harnessRegistry = new Map<string, { mtimeMs: number; sess: Map<string, HarnessSessionSpec> }>();

function harnessRegistryLesen(pfad: string): Map<string, HarnessSessionSpec> {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(pfad).mtimeMs;
  } catch {
    return new Map();
  }
  const alt = harnessRegistry.get(pfad);
  if (alt && alt.mtimeMs === mtimeMs) return alt.sess;
  const sess = new Map<string, HarnessSessionSpec>();
  try {
    const roh = JSON.parse(readFileSync(pfad, 'utf8')) as { harnesses?: unknown[] };
    const liste = Array.isArray(roh.harnesses) ? (roh.harnesses as Record<string, unknown>[]) : [];
    for (const h of liste) {
      const id = String(h.id ?? '');
      const s = h.session as Record<string, unknown> | undefined;
      if (!id || !s || s.via !== 'sessionFile' || !s.ort || !s.format) continue;
      sess.set(id, {
        via: String(s.via),
        ort: String(s.ort),
        format: String(s.format),
        maxAgeSec: typeof s.maxAgeSec === 'number' ? s.maxAgeSec : null,
      });
    }
  } catch {
    // Eine unlesbare Registry heisst "unbekannt", nicht "nimm irgendetwas an".
  }
  harnessRegistry.set(pfad, { mtimeMs, sess });
  return sess;
}

export function harnessSessionSpec(harness: string, modelsFile: string): HarnessSessionSpec | null {
  if (!harness) return null;
  return harnessRegistryLesen(modelsFile).get(harness) ?? null;
}

export interface SessionLoadStand {
  /** Belegte Tokens laut der Sitzungsdatei des Harness, 0 = unbekannt. */
  tokens: number;
  /** Auslastung in Prozent, -1 wenn nicht ermittelbar. */
  percent: number;
  /**
   * Der Nenner, der DIESE Prozentzahl wirklich ergeben hat -- meist der
   * uebergebene `contextWindow`, bei codex-rollout aber der Wert AUS der
   * Sitzungsdatei selbst (`wb-session-load` gibt ihn deshalb als drittes Feld
   * zurueck, statt dass der Aufrufer seinen eigenen annimmt). 0 = unbekannt.
   */
  contextWindow: number;
}

const LEER_SESSION: SessionLoadStand = { tokens: 0, percent: -1, contextWindow: 0 };

/** Zeitlimit fuer EINEN Lauf von `wb-session-load`. */
const SESSION_LOAD_FRIST_MS = 5_000;

/**
 * So lange gilt ein einmal gelesener Wert als frisch; erst danach wird im
 * Hintergrund neu gelesen. Der Takt der Oberflaeche liegt bei 2 Sekunden --
 * ohne diese Schranke liefe je Worker alle 2 Sekunden ein Python-Start, und
 * genau die CPU-Last waere nur vom Haupt-Thread in den Hintergrund verschoben,
 * statt weg zu sein. Eine Kontextzahl darf ein paar Sekunden alt sein: sie
 * bewegt sich mit den Zuegen eines Workers, nicht mit dem Bildschirm.
 */
const SESSION_LOAD_FRISCH_MS = 5_000;

/**
 * Ein Eintrag, nach dem so lange niemand mehr gefragt hat, faellt aus dem
 * Gedaechtnis -- sonst wuechse die Tabelle mit jedem je gesehenen Worker.
 */
const SESSION_LOAD_VERFALL_MS = 120_000;

interface SessionLoadEintrag {
  wert: SessionLoadStand;
  /** Wann der Wert entstand. 0 = noch nie gelesen. */
  gelesen: number;
  /** Wann zuletzt jemand danach gefragt hat (fuer das Aufraeumen). */
  gefragt: number;
  laufend: boolean;
}

const sessionLoadGedaechtnis = new Map<string, SessionLoadEintrag>();
let sessionLoadLaufend = 0;

/**
 * Wie viele Laeufe von `wb-session-load` gerade offen sind. NUR fuer Tests:
 * ein einzelner Durchgang von `leseSessions` ist seit dem Umbau nicht mehr die
 * ganze Antwort, und eine Suite muss warten koennen, statt zu raten.
 */
export function sessionLoadOffen(): number {
  return sessionLoadLaufend;
}

function sessionLoadDeuten(roh: string): SessionLoadStand {
  const m = roh.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
  if (!m) return LEER_SESSION;
  const tokens = Number(m[1]);
  const percent = Number(m[2]);
  const fenster = Number(m[3]);
  if (!Number.isFinite(tokens) || !Number.isFinite(percent) || !Number.isFinite(fenster)) return LEER_SESSION;
  return { tokens, percent: Math.max(0, Math.min(100, percent)), contextWindow: fenster };
}

function sessionLoadStarten(e: SessionLoadEintrag, bin: string, argv: string[]): void {
  e.laufend = true;
  sessionLoadLaufend++;
  let out = '';
  let fertig = false;
  // Die Uhr steht VOR `beenden`, weil der Fehlschlag beim Starten selbst schon
  // beendet -- und dann gibt es noch keine.
  let uhr: NodeJS.Timeout | null = null;
  const beenden = (gut: boolean) => {
    if (fertig) return;
    fertig = true;
    if (uhr) clearTimeout(uhr);
    // Ein fehlgeschlagener Lauf setzt den Wert auf UNBEKANNT zurueck, statt den
    // alten stehen zu lassen: eine Zahl von vorhin waere hier genau die
    // geratene Zahl, die diese Datei nirgends ausgibt.
    e.wert = gut ? sessionLoadDeuten(out) : LEER_SESSION;
    e.gelesen = Date.now();
    e.laufend = false;
    sessionLoadLaufend--;
  };
  let kind;
  try {
    kind = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    beenden(false);
    return;
  }
  uhr = setTimeout(() => kind.kill('SIGKILL'), SESSION_LOAD_FRIST_MS);
  kind.stdout?.on('data', (d: Buffer) => {
    out += d.toString('utf8');
  });
  kind.on('error', () => beenden(false));
  kind.on('close', (code: number | null) => beenden(code === 0));
}

function sessionLoadAufraeumen(jetzt: number): void {
  for (const [k, e] of sessionLoadGedaechtnis) {
    if (!e.laufend && jetzt - e.gefragt > SESSION_LOAD_VERFALL_MS) sessionLoadGedaechtnis.delete(k);
  }
}

/**
 * Ruft `wb-session-load` (siehe Kopf dieser Datei) mit dem session-Block des
 * Harness, dem Arbeitsverzeichnis des Workers und dem Kontextfenster seines
 * Modells auf. Der Nenner kommt aus der Registry (`kontextFenster`, dieselbe
 * Funktion wie beim Claude-Pfad) und wird dem Skript UEBERGEBEN, nicht dort
 * geraten -- fehlt er, gibt das Skript selbst nichts aus.
 *
 * Jeder Zweifel -- das Werkzeug fehlt, liefert nichts, liefert Muell, braucht
 * laenger als das Zeitlimit -- ergibt LEER_SESSION, nie eine geratene Zahl.
 *
 * DER LAUF BLOCKIERT NICHT MEHR (2026-08-16). Bis heute stand hier ein
 * `spawnSync`, und der lief IM 2-Sekunden-Takt der Oberflaeche (main.ts,
 * `leseSessions`) -- je Nicht-Claude-Worker ein Python-Start, waehrenddessen
 * kein IPC floss, also weder Terminal-Ausgabe noch Tastendruck. Gemessen im
 * Worktree (drei aider-Worker, eigenes HOME): 74-88 ms Stillstand je Takt.
 * Jetzt wird im HINTERGRUND gelesen und der letzte Wert vorgehalten -- dasselbe
 * Muster, das `budget.ts` (BudgetPoller) und `remote.ts` (RemotePoller) schon
 * vormachen. Der Aufrufer bekommt sofort, was zuletzt bekannt war; beim ersten
 * Mal ist das UNBEKANNT, und einen Takt spaeter steht die Zahl da.
 */
export function sessionLoadGemerkt(spec: HarnessSessionSpec, cwd: string, contextWindow: number, bin = 'wb-session-load'): SessionLoadStand {
  if (!spec.ort || !cwd) return LEER_SESSION;
  const specJson = JSON.stringify({ via: spec.via, ort: spec.ort, format: spec.format, maxAgeSec: spec.maxAgeSec });
  const argv = [specJson, cwd, String(contextWindow || 0)];
  // Der Schluessel traegt ALLES, was die Antwort bestimmt: ein anderer Ort, ein
  // anderes Verzeichnis oder ein anderer Nenner ist eine andere Frage und darf
  // nicht die Antwort der vorigen bekommen.
  const schluessel = JSON.stringify([bin, ...argv]);
  const jetzt = Date.now();
  let e = sessionLoadGedaechtnis.get(schluessel);
  if (!e) {
    e = { wert: LEER_SESSION, gelesen: 0, gefragt: jetzt, laufend: false };
    sessionLoadGedaechtnis.set(schluessel, e);
  }
  e.gefragt = jetzt;
  if (!e.laufend && jetzt - e.gelesen >= SESSION_LOAD_FRISCH_MS) sessionLoadStarten(e, bin, argv);
  sessionLoadAufraeumen(jetzt);
  return e.wert;
}

export interface TranscriptStand {
  /** Pfad der Transcript-Datei. Leer, wenn keine gefunden wurde. */
  path: string;
  /** Zeitpunkt der letzten Aenderung in Millisekunden, 0 = unbekannt. */
  mtimeMs: number;
  size: number;
  /** Belegte Tokens laut dem letzten Nutzungseintrag. */
  tokens: number;
  contextWindow: number;
  /** Auslastung in Prozent, -1 wenn nicht ermittelbar. */
  percent: number;
}

const LEER: TranscriptStand = { path: '', mtimeMs: 0, size: 0, tokens: 0, contextWindow: 0, percent: -1 };

/**
 * Wie lange ein erfolgloses Suchen nicht wiederholt wird. Die Suche geht durch
 * ALLE Projektordner (hier rund neunzig), und der Takt der Oberflaeche liegt
 * bei zwei Sekunden: ein Worker mit einer veralteten Sitzungskennung -- ein
 * geschlossener von gestern etwa, der in der Zustandsdatei stehen bleibt --
 * wuerde sonst dauerhaft Hunderte Dateiabfragen je Sekunde ausloesen, ohne dass
 * sich je etwas aendert.
 */
const SUCHE_PAUSE_MS = 60_000;
const gefunden = new Map<string, { pfad: string; zeit: number }>();

/**
 * Wo das Transcript einer Sitzung liegt. Erst der abgeleitete Pfad; findet der
 * nichts, wird im Projektordner gesucht -- ein Worker, dessen Verzeichnis
 * inzwischen ein anderes ist (Worktree, Umzug), soll nicht stumm ausfallen.
 */
export function transcriptPfad(projectsDir: string, dir: string, sessionId: string): string {
  if (!sessionId) return '';
  const direkt = join(projectsDir, projektSchluessel(dir), `${sessionId}.jsonl`);
  if (existsSync(direkt)) return direkt;

  // DER CACHE-SCHLUESSEL AUS ZWEI TEILEN, EINDEUTIG UND OHNE STEUERZEICHEN.
  // Hier stand ein NUL-Byte als Trenner -- unbedenklich fuer die Zuordnung
  // (ein Pfad enthaelt keins), aber es machte die ganze Datei fuer `grep`,
  // `rg` und `file` zu einer BINAERDATEI: eine Suche ohne `-a`/`--text` fand
  // darin nichts. `JSON.stringify` auf ein Paar ist genauso eindeutig und
  // laesst die Datei lesbar.
  const schluessel = JSON.stringify([projectsDir, sessionId]);
  const alt = gefunden.get(schluessel);
  // Ein einmal gefundener Pfad gilt, solange die Datei noch da ist.
  if (alt?.pfad && existsSync(alt.pfad)) return alt.pfad;
  if (alt && Date.now() - alt.zeit < SUCHE_PAUSE_MS) return '';

  let ordner: string[] = [];
  try {
    ordner = readdirSync(projectsDir);
  } catch {
    gefunden.set(schluessel, { pfad: '', zeit: Date.now() });
    return '';
  }
  for (const o of ordner) {
    const p = join(projectsDir, o, `${sessionId}.jsonl`);
    if (existsSync(p)) {
      gefunden.set(schluessel, { pfad: p, zeit: Date.now() });
      return p;
    }
  }
  gefunden.set(schluessel, { pfad: '', zeit: Date.now() });
  return '';
}

/**
 * Gelesen wird vom ENDE her: diese Dateien werden zweistellig megabytegross,
 * und der letzte Nutzungseintrag steht fast immer in den letzten Zeilen.
 * Reicht das erste Fenster nicht, wird einmal weiter aufgemacht -- danach
 * lieber keine Zahl als eine teure.
 */
const FENSTER = [128 * 1024, 2 * 1024 * 1024];

function letzteNutzung(path: string, size: number): number {
  for (const fenster of FENSTER) {
    const ab = Math.max(0, size - fenster);
    let fd = -1;
    let text = '';
    try {
      fd = openSync(path, 'r');
      const puffer = Buffer.alloc(Math.min(fenster, size));
      const gelesen = readSync(fd, puffer, 0, puffer.length, ab);
      text = puffer.subarray(0, gelesen).toString('utf8');
    } catch {
      return 0;
    } finally {
      if (fd >= 0) closeSync(fd);
    }
    // Die erste Zeile ist angeschnitten, wenn nicht von vorn gelesen wurde.
    const zeilen = ab > 0 ? text.split('\n').slice(1) : text.split('\n');
    for (let i = zeilen.length - 1; i >= 0; i--) {
      const z = zeilen[i].trim();
      if (!z) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(z) as Record<string, unknown>;
      } catch {
        continue;
      }
      const msg = rec.message as Record<string, unknown> | undefined;
      const u = ((msg?.usage ?? rec.usage) ?? null) as Record<string, number> | null;
      if (!u) continue;
      // Belegt ist, was beim naechsten Aufruf wieder hineingeht: frische
      // Eingabe plus alles, was aus dem Zwischenspeicher gelesen oder in ihn
      // geschrieben wurde. Dieselbe Rechnung wie im Kontext-Guard.
      const belegt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (belegt > 0) return belegt;
    }
    if (ab === 0) break; // schon die ganze Datei gesehen
  }
  return 0;
}

/**
 * Gelesen wird nur, wenn sich die Datei geaendert hat. Der Takt der Oberflaeche
 * liegt bei zwei Sekunden; ohne diesen Merker laesen zehn Worker im Dauerlauf
 * mehrere Megabyte je Sekunde, obwohl sich meistens nichts bewegt.
 */
const merker = new Map<string, { mtimeMs: number; size: number; stand: TranscriptStand }>();

export function transcriptStand(path: string, model: string, modelsFile: string): TranscriptStand {
  if (!path) return LEER;
  let st: { mtimeMs: number; size: number };
  try {
    const s = statSync(path);
    st = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return LEER;
  }
  // Das Fenster zuerst: es ist billig (die Registry haengt an ihrer eigenen
  // mtime) und gehoert in die Frage, ob der gemerkte Stand noch gilt. Ohne das
  // wuerde ein nachgetragener Registry-Eintrag erst beim naechsten Schreiben
  // ins Transcript wirken.
  const contextWindow = kontextFenster(model, modelsFile);
  const alt = merker.get(path);
  if (alt && alt.mtimeMs === st.mtimeMs && alt.size === st.size && alt.stand.contextWindow === contextWindow) {
    return alt.stand;
  }
  const tokens = letzteNutzung(path, st.size);
  const stand: TranscriptStand = {
    path,
    mtimeMs: st.mtimeMs,
    size: st.size,
    tokens,
    contextWindow,
    // Ohne Fenster aus der Registry gibt es keine Prozentzahl -- die Tokens
    // stehen trotzdem da, und die Anzeige nennt sie statt einer erfundenen Quote.
    percent: tokens > 0 && contextWindow > 0 ? Math.floor((tokens * 100) / contextWindow) : -1,
  };
  merker.set(path, { ...st, stand });
  return stand;
}

/** Nur fuer Tests: die Merker leeren, damit erneut gelesen und gesucht wird. */
export function merkerLeeren(): void {
  merker.clear();
  gefunden.clear();
  registry.clear();
  harnessRegistry.clear();
}

export interface ProzessZeile {
  ppid: number;
  cpu: number;
  /** Laufzeit in Sekunden seit dem Start des Prozesses. */
  ageSeconds: number;
  args: string;
}

/**
 * `ps`-Laufzeit (`etime`) in Sekunden. Formate: `mm:ss`, `hh:mm:ss`,
 * `dd-hh:mm:ss`. Steht dort etwas Unerwartetes, ist -1 die ehrliche Antwort --
 * eine 0 hiesse "gerade gestartet" und wuerde ein "haengt" verhindern.
 */
export function etimeSekunden(roh: string): number {
  const m = roh.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return -1;
  const [, tage, stunden, minuten, sekunden] = m;
  return Number(tage || 0) * 86400 + Number(stunden || 0) * 3600 + Number(minuten) * 60 + Number(sekunden);
}

/**
 * Steht ein Worker still? Zwei Bedingungen, und beide muessen zutreffen:
 *
 *   1. Im Transcript ist seit `stallSeconds` nichts passiert -- kein
 *      Nachrichtenwechsel, kein Werkzeugergebnis.
 *   2. Kein Prozess unter ihm ist JUENGER als diese Stille. Genau das trennt
 *      den haengenden Worker vom arbeitenden: ein langlaufendes Werkzeug
 *      (der Scan aus der Regel) schreibt 82 Minuten lang nichts ins Transcript,
 *      hat aber einen Kindprozess, der nach dem letzten Eintrag gestartet ist.
 *      Die blosse Existenz von Kindern taugt dafuer NICHT -- MCP-Server laufen
 *      die ganze Sitzung ueber mit.
 */
export function stillstand(idleSeconds: number, juengsterKindAlter: number, stallSeconds: number): boolean {
  if (idleSeconds < 0 || idleSeconds <= stallSeconds) return false;
  if (juengsterKindAlter >= 0 && juengsterKindAlter < idleSeconds) return false;
  return true;
}
