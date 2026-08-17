// Woher die Sessions kommen: aus den Zustandsdateien und aus tmux, nie aus
// einer eigenen Buchfuehrung. Diese Datei liest beides und legt daraus das
// Modell an, das die Oberflaeche zeichnet.
//
// Drei Entscheidungen aus dem Plan stecken hier drin:
//
//   Farbe  Massgeblich ist, ob die tmux-Session LEBT, nicht ob jemand zusieht.
//          Eine Session, die seit Stunden ohne Client arbeitet, ist gruen.
//   F6     Eine Maschine, die nicht antwortet, sieht ueber SSH genauso aus wie
//          eine beendete Session. Deshalb gibt es einen vierten Zustand, und
//          eine unerreichbare Maschine verliert ihre Sessions NICHT aus der
//          Liste. Was man nicht sehen kann, ist nicht dasselbe wie das, was es
//          nicht mehr gibt.
//   V19    Subagenten von Claude Code tragen `--agent-id`, `--agent-name` und
//          `--agent-type` in ihrer Kommandozeile und KEIN `@wb_role`. Sie
//          werden erkannt, eingerueckt gezeigt und nicht mitgezaehlt.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  STALL_SECONDS_DEFAULT,
  etimeSekunden,
  stillstand,
  transcriptPfad,
  transcriptStand,
  harnessSessionSpec,
  kontextFenster,
  sessionLoadGemerkt,
} from './workerstate';
import { Ergebnis, ergebnisStand } from './results';
import { blockiertePanes } from './freigaben';
import { mitMaschinenLocale } from './pfad';
import type { RemoteSnapshot } from './remote';

export type SessionState = 'running' | 'attention' | 'stopped' | 'unreachable';

/**
 * Der Zustand eines Workers (V1). Jeder Wert hat GENAU EINE Quelle, und keine
 * davon ist der Bildschirm -- die Herleitung steht in workerstate.ts.
 *
 *   running   Der Pane lebt und es geht voran.
 *   blocked   Der Worker wartet auf einen Menschen, aus einem von zwei Gruenden:
 *             ein eigener Antrag wartet auf die Entscheidung des Orchestrators,
 *             oder ein Guard hat ihm einen Befehl verweigert und er steht vor
 *             der Rueckfrage. Beides steht in Dateien; keiner der beiden Gruende
 *             wird aus dem Pane-Text gelesen.
 *   stalled   Der Pane lebt, aber seit STALL_SECONDS bewegt sich weder das
 *             Transcript noch laeuft ein Werkzeug unter ihm.
 *   done      Kein Pane mehr. Ob er ein Ergebnis hinterlassen hat, steht
 *             getrennt in `resultPath` -- fertig und Ergebnis-da sind zwei
 *             Aussagen, und ein Worker kann das eine ohne das andere sein.
 *   unknown   NICHT NACHGESEHEN (07.08.). Die Panes dieser Sitzung waren nicht
 *             abzufragen -- tmux nicht ausfuehrbar, seine Antwort unzerlegbar
 *             oder die Maschine still. Dann ist "kein Pane" keine Auskunft,
 *             sondern eine Luecke, und `done` waere dieselbe Luege, die auf der
 *             Sitzungsebene seit dem 07.08. `unreachable` heisst.
 *
 * WARUM EIN FUENFTER ZUSTAND UND KEIN ZWEITES MERKMAL: Die vier oberen sind
 * schon die Antwort auf genau eine Frage -- was tut dieser Worker? --, und wer
 * nicht nachsehen konnte, hat auf diese eine Frage keine der vier Antworten.
 * Ein Merkmal `nichtNachgesehen` NEBEN dem Zustand haette daneben eine zweite
 * Wahrheit gefuehrt, die jede Verzweigung im Haus zusaetzlich haette lesen
 * muessen; wer sie vergisst, zeichnet stillschweigend weiter `done`. Genau
 * dieselbe Wahl ist auf der Sitzungsebene schon getroffen (SessionState kennt
 * 'unreachable' NEBEN 'stopped', nicht als Beiwerk dazu) -- zwei verschiedene
 * Bauarten fuer dieselbe Aussage waeren die Stelle, an der beide auseinander
 * laufen.
 *
 * Er tritt NUR auf, solange die Sitzung selbst 'unreachable' ist: beide kommen
 * aus derselben Bedingung, damit ein Worker nie einsehbar heisst, waehrend
 * seine Sitzung es nicht ist.
 */
export type WorkerState = 'running' | 'blocked' | 'stalled' | 'done' | 'unknown';

export interface SubagentInfo {
  paneId: string;
  agentId: string;
  name: string;
  type: string;
}

export interface WorkerInfo {
  name: string;
  kind: string;
  model: string;
  dir: string;
  paneId: string;
  /**
   * Wurde ein lebender Pane fuer ihn GESEHEN? Das ist die Beobachtung, nicht
   * das Urteil: bei `state === 'unknown'` steht hier `false`, weil niemand
   * nachsehen konnte -- nicht, weil der Pane weg waere. Wer "ist er fertig?"
   * meint, fragt `state === 'done'`; `alive` beantwortet nur "haben wir ihn
   * eben gesehen?".
   */
  alive: boolean;
  /**
   * CPU in Prozent, Summe ueber den Prozessbaum des Panes. ANZEIGE, kein
   * Fortschrittsmass: `ps` mittelt ueber die Lebenszeit des Prozesses, und ein
   * Client, der auf eine Antwort wartet, rechnet nicht -- gemessen 1,3 Sekunden
   * CPU in 82 Minuten durchgehender Arbeit. Wer daraus "haengt" ableitet, liegt
   * falsch; dafuer ist das Transcript da (siehe `idleSeconds`).
   */
  cpu: number;
  state: WorkerState;
  /**
   * Kontextauslastung in Prozent. Fuer Claude aus dem Transcript, fuer jeden
   * anderen Harness aus dessen session-Block der Registry (workerstate.ts,
   * `sessionLoad`). -1 = unbekannt -- geraten wird sie in keinem der beiden Faelle.
   */
  contextPercent: number;
  /** Belegte Tokens laut dem letzten Nutzungseintrag, 0 = unbekannt. */
  contextTokens: number;
  /** Groesse des Kontextfensters, aus dem Modell abgeleitet. */
  contextWindow: number;
  /** Das Transcript, aus dem die beiden Zahlen kommen. Leer = keins gefunden. */
  transcriptPath: string;
  /** Sekunden ohne Bewegung im Transcript, -1 = unbekannt. */
  idleSeconds: number;
  /** Die Ergebnisdatei, aufgeloest -- leer, solange keine da ist (V2). */
  resultPath: string;
  /** Zeitpunkt der Ergebnisdatei in Millisekunden, 0 = keine. */
  resultAt: number;
  subagents: SubagentInfo[];
  /**
   * Der Worker, auf dessen ANTRAG dieser hier entstanden ist -- leer, wenn er
   * keinem Antrag entstammt. Ein Worker spawnt in diesem Haus nie selbst: er
   * beantragt, der Orchestrator entscheidet und spawnt. Die Anzeige muss das
   * sagen, sonst behauptet sie eine Befugnis, die es nicht gibt.
   */
  requestedBy: string;
  /** Ein eigener Antrag wartet auf die Entscheidung des Orchestrators. */
  pendingRequest: boolean;
  /**
   * Warum der Worker blockiert ist -- leer, wenn er es nicht ist. `request`:
   * sein Antrag wartet auf eine Entscheidung. `guard`: ein Guard hat ihm einen
   * Befehl verweigert, der Marker unter guard-blocks/ steht. Steht beides an,
   * gilt `guard`: das haelt ihn JETZT an, ein Antrag nur seine Unterarbeit.
   */
  blockedReason: '' | 'request' | 'guard';
  /**
   * Die Unterhaltung, die beim Spawn vermerkt wurde (`wb-state add-worker`).
   * Sie steht im Modell, weil die Chat-Ansicht sie als zweiten Zuordnungsweg
   * braucht, sobald der Pane aelter ist als der Haken, der die Kennung an den
   * Pane haengt (chat/zuordnung.ts, Stufe 'vermerk').
   */
  claudeSessionId: string;
}

export interface SessionInfo {
  id: string;
  name: string;
  dir: string;
  machine: string;
  tmuxSession: string;
  alive: boolean;
  reachable: boolean;
  state: SessionState;
  initials: string;
  lastActive: string;
  /** Von uns angelegt? Nur dann darf das Layout angefasst werden (F14). */
  owned: boolean;
  orchestratorPane: string;
  workers: WorkerInfo[];
  pendingApprovals: number;
  /** Subagenten, die keinem Worker zuzuordnen waren -- sichtbar bleiben sie. */
  orphanSubagents: SubagentInfo[];
  /**
   * Die Unterhaltung DIESER Session (nicht eines Workers) -- leer, wenn keine
   * gemerkt ist. `wb-code` schreibt sie beim ersten Transcript hinein und
   * nutzt genau sie, um nach einem Abbruch dieselbe Unterhaltung statt einer
   * neuen zu starten (V14).
   */
  claudeSessionId: string;
  /**
   * SIE LIEF NOCH, ALS DIESES PROGRAMM ZULETZT HINSAH (11.08.). Gilt nur
   * zusammen mit `state === 'stopped'`: kein Pane mehr, aber das Ende hat
   * niemand gesehen -- der Fall nach dem Absturz vom 10.08., in dem vier
   * hiesige Sitzungen aus der Liste fielen, weil sie beendeten glichen.
   * Gemessen wird es NICHT hier, sondern in lebensspur.ts; hier steht nur, was
   * von dort mitkommt.
   *
   * WARUM EIN MERKMAL UND KEIN FUENFTER SESSIONSTATE -- die umgekehrte Wahl zu
   * WorkerState 'unknown' weiter oben, und aus demselben Grund: Der Zustand
   * beantwortet EINE Frage, naemlich „laeuft sie?". Darauf ist die Antwort
   * hier eindeutig 'stopped', und jede Verzweigung im Haus, die daran haengt
   * (der Fortsetzen-Knopf im Renderer, `darfWiederherstellen`, die Vorschau in
   * main.ts), soll genau so weiterlaufen wie bisher. Verloren beantwortet eine
   * ZWEITE Frage -- „hat jemand das Ende gesehen?" --, und die liest genau eine
   * Stelle (`sichtbare()` in main.ts). Ein fuenfter Zustand haette dafuer jede
   * dieser Verzweigungen um einen Fall erweitern muessen, und wer einen
   * vergisst, sperrt still den Knopf, den es hier gerade zu retten gilt.
   */
  verloren: boolean;
  /** Nur bei einer NICHT-Standardsession des Ordners gesetzt (SPEC-V2 B). */
  sessionKey: string;
  /**
   * Der Harness, mit dem diese Session laeuft -- 'claude', 'pi' oder ein
   * registrierter Adapter. GESCHRIEBEN, nicht geraten: `wb-code` gibt ihn beim
   * Anlegen an `wb-state touch` weiter, er steht seitdem in der Zustandsdatei
   * (17 der 24 Dateien am 06.08.; die sieben aelteren stammen alle aus der Zeit
   * vor dem Feld und tragen auch kein Modell). Fehlt er, gilt 'claude' -- das
   * war damals der einzige Harness, und genau so hat sich die Oberflaeche bis
   * heute verhalten.
   *
   * Fuer eine tote Session ist die Zustandsdatei die EINZIGE Quelle: ihr Pane
   * ist weg, und damit auch das `@wb_cmd`, aus dem `shell/wb-revive` den
   * Harness eines Panes ableitet.
   */
  harness: string;
  /** Das Modell, mit dem sie lief. Leer bei Dateien aus der Zeit vor dem Feld. */
  model: string;
}

export interface SessionsOptions {
  sessionsDir: string;
  requestsDir: string;
  tmuxSocket: string;
  /** Kennung dieser Maschine. Kommt aus der Umgebung, steht nirgends fest. */
  machine: string;
  /** Kennungen der Maschinen, die gerade antworten. */
  reachable: string[];
  /** Wo die Ergebnisdateien der Worker liegen (V2). */
  resultsDir: string;
  /** Marker angehaltener Worker, von bash-guard.py geschrieben (V20). */
  guardBlocksDir: string;
  /** Die Modell-Registry -- einzige Quelle fuer die Groesse des Kontextfensters. */
  modelsFile: string;
  /** Wo Claude Code seine Transcripte ablegt (Quelle der Kontextzahl). */
  projectsDir: string;
  /** Ab wann ein Worker ohne Bewegung als haengend gilt. */
  stallSeconds?: number;
  /**
   * Zuletzt abgerufener Stand jeder Fernmaschine (V10) -- vom `RemotePoller`
   * NEBENHER gefuellt, nie hier gelesen. Fehlt eine Maschine hier ganz, hat
   * sie noch NIE geantwortet; ein Eintrag mit `reachable:false` ist dagegen
   * einer, dessen letzter bekannter Stand jetzt veraltet sein kann -- und
   * genau deshalb bleiben seine Sessions trotzdem in der Liste (F6).
   */
  remoteSnapshots?: RemoteSnapshot[];
  /**
   * Kennungen der Sitzungen, die beim letzten Blick dieses Programms noch
   * liefen (lebensspur.ts). Sie werden hier NUR durchgereicht: gemessen wird
   * die Spur dort, und wer sie nicht mitgibt, bekommt die Liste wie bisher.
   */
  verlorene?: string[];
}

export interface ProcRow {
  pid: number;
  ppid: number;
  cpu: number;
  /** Laufzeit in Sekunden, -1 wenn `ps` etwas Unerwartetes liefert. */
  ageSeconds: number;
  args: string;
}

export interface PaneRow {
  session: string;
  windowId: string;
  windowIndex: number;
  paneId: string;
  paneIndex: number;
  role: string;
  worker: string;
  pid: number;
  command: string;
}

/** `tmux list-sessions -F '#{session_name}\t#{@awb_owner}'`, roh -- lokal wie ueber SSH gleich. */
export const SESSION_LIST_FORMAT = '#{session_name}\t#{@awb_owner}';
/** Dieselbe Formatzeile wie `readPanes`, exportiert, damit ein Fernabruf (V10) genau dasselbe fragt. */
export const PANE_LIST_FORMAT =
  '#{session_name}\t#{window_id}\t#{window_index}\t#{pane_id}\t#{pane_index}\t#{@wb_role}\t#{@wb_worker}\t#{pane_pid}\t#{pane_current_command}';

/**
 * Was ein tmux-Aufruf ergeben hat -- und zwar in ZWEI Fragen, die bis zum
 * 07.08. beide mit derselben leeren Zeichenkette beantwortet wurden:
 *
 *   ausfuehrbar=true,  raw=''   tmux hat geantwortet, es laeuft nichts
 *   ausfuehrbar=false, raw=''   tmux liess sich gar nicht erst ausfuehren
 *
 * Der Unterschied ist keine Feinheit. Am 07.08. fand das aus dem Finder
 * gestartete Programm `tmux` nicht im PATH (siehe pfad.ts), bekam ENOENT, und
 * die Oberflaeche behauptete daraufhin ueber JEDE Sitzung, sie sei beendet.
 * Das ist eine Falschaussage ueber fremden Zustand: alice hat geglaubt,
 * seine laufenden Sitzungen seien weg. Was man nicht sehen kann, ist nicht
 * dasselbe wie das, was es nicht mehr gibt -- derselbe Satz, der schon F6
 * traegt (siehe den Kopf dieser Datei), hier nur eine Ebene tiefer.
 *
 * Ein Exitcode ungleich 0 zaehlt nur dann als Antwort, wenn tmux dazu SAGT,
 * dass keine Sitzung laeuft: `list-sessions` endet mit 1 und „no server running
 * on …" bzw. „error connecting to … (No such file or directory)". Bis zum
 * 16.08. galt jeder Exitcode ungleich 0 als „nichts laeuft" -- damit las ein
 * einziger schlechter Takt (ein abgestuerzter Server, ein abgebrochener Aufruf,
 * ein Signal) ALLE Sitzungen als beendet. Solche Fehlschlaege werden jetzt wie
 * `r.error` behandelt: „nicht ausfuehrbar", also keine Aussage.
 */
export interface TmuxAntwort {
  ausfuehrbar: boolean;
  raw: string;
  /** Der Satz fuer den Menschen. Leer, solange tmux ausfuehrbar ist. */
  fehler: string;
}

/**
 * Die zwei Meldungen, mit denen tmux „es laeuft keine Sitzung" sagt -- auf
 * dieser Maschine (tmux 3.x) nachgemessen: ohne Socketdatei „error connecting
 * to <pfad> (No such file or directory)", mit stehengebliebener Socketdatei
 * „no server running on <pfad>". Jede ANDERE Fehlermeldung heisst „keine
 * Antwort", nicht „keine Sitzung".
 */
const KEINE_SITZUNG = /no server running on|error connecting to .*No such file or directory/i;

function tmuxAntwort(socket: string, args: string[]): TmuxAntwort {
  const base = socket ? ['-L', socket] : [];
  // Der Tabulator in SESSION_LIST_FORMAT und PANE_LIST_FORMAT ist das
  // Trennzeichen eines MASCHINENFORMATS und keine Sprache fuer den Menschen.
  // Ohne UTF-8-Zeichenklasse gibt tmux ihn als Unterstrich aus, und die Liste
  // zerfaellt still -- deshalb bekommt genau dieser Aufruf seine Kodierung mit,
  // unabhaengig davon, welche Locale der Mensch fuer sich gesetzt hat. Die
  // Messung dazu steht im Kopf von pfad.ts.
  const r = spawnSync('tmux', [...base, ...args], { encoding: 'utf8', env: mitMaschinenLocale() });
  if (r.error) {
    return {
      ausfuehrbar: false,
      raw: '',
      fehler: `tmux liess sich nicht ausfuehren (${r.error.message}). `
        + 'Solange das so ist, sagt dieses Fenster ueber keine Sitzung, ob sie laeuft.',
    };
  }
  if (r.status !== 0 || r.signal) {
    // EIN Exitcode ungleich 0, ZWEI ganz verschiedene Bedeutungen -- bis zum
    // 16.08. wurden beide gleich behandelt, naemlich als leere Ausgabe, aus der
    // die Oberflaeche „keine Sitzung laeuft" las.
    //
    // Wirklich keine Sitzung sagt tmux auf genau zwei Arten (auf dieser
    // Maschine nachgemessen): „no server running on <socket>", wenn die
    // Socketdatei noch da ist, und „error connecting to <socket> (No such file
    // or directory)", wenn sie es nicht ist. Das IST eine Antwort und bleibt
    // eine.
    //
    // Alles andere -- „lost server", ein abgebrochener oder per Signal
    // beendeter Aufruf, eine Fehlermeldung, die wir nicht kennen -- heisst:
    // tmux hat nicht geantwortet. Daraus „alle Sitzungen sind beendet" zu
    // machen, ist dieselbe Falschaussage ueber fremden Zustand wie beim
    // ENOENT-Fall darueber, nur eine Ursache weiter.
    const err = String(r.stderr ?? '').trim();
    if (!r.signal && KEINE_SITZUNG.test(err)) return { ausfuehrbar: true, raw: '', fehler: '' };
    const grund = err || (r.signal ? `abgebrochen durch ${r.signal}` : `Exitcode ${r.status}`);
    return {
      ausfuehrbar: false,
      raw: '',
      fehler: `tmux hat nicht geantwortet (${grund}). `
        + 'Solange das so ist, sagt dieses Fenster ueber keine Sitzung, ob sie laeuft.',
    };
  }
  return { ausfuehrbar: true, raw: (r.stdout || '').replace(/\n$/, ''), fehler: '' };
}

function tmux(socket: string, args: string[]): string {
  return tmuxAntwort(socket, args).raw;
}

/**
 * `tmux list-sessions -F SESSION_LIST_FORMAT` roh -> (lebende Sessionnamen,
 * welche davon @awb_owner tragen). Reine Funktion, damit V10 sie gegen die
 * Ausgabe eines SSH-Aufrufs genauso anwenden kann wie gegen lokales tmux.
 */
/**
 * DIE ZWEITE SICHERUNG, unabhaengig von der ersten (07.08.).
 *
 * `list-sessions -F` mit einem Format, das einen Tabulator enthaelt, kann keine
 * nichtleere Antwort ohne Tabulator geben. Kommt trotzdem eine, ist das kein
 * Sitzungsverzeichnis, sondern ein kaputtes Format -- genau so sah der Befund
 * vom 07.08. aus, als tmux ohne UTF-8-Zeichenklasse den Tabulator durch einen
 * Unterstrich ersetzte. Die Kodierung wird jetzt mitgegeben, damit das nicht
 * mehr vorkommt; diese Pruefung steht daneben, damit die NAECHSTE Ursache
 * derselben Art auffaellt, statt sich wieder als „alles beendet" zu tarnen.
 *
 * Gefragt wird gegen das Format selbst und nicht gegen ein geschriebenes
 * Zeichen: enthaelt das Format keinen Tabulator mehr, hat die Pruefung keinen
 * Gegenstand und schweigt.
 */
export function trennzeichenFehlt(raw: string, format: string = SESSION_LIST_FORMAT): boolean {
  if (!raw || !format.includes('\t')) return false;
  return !raw.includes('\t');
}

export function parseSessionList(raw: string): { lebende: Map<string, boolean>; eigene: Map<string, boolean> } {
  const lebende = new Map<string, boolean>();
  const eigene = new Map<string, boolean>();
  for (const z of raw.split('\n')) {
    if (!z) continue;
    const [name, owner] = z.split('\t');
    lebende.set(name, true);
    eigene.set(name, !!owner);
  }
  return { lebende, eigene };
}

/** `ps -axo/-eo pid=,ppid=,pcpu=,etime=,args=` roh -> Tabelle. Reine Funktion (siehe oben). */
export function parseProcTable(raw: string): Map<number, ProcRow> {
  const tabelle = new Map<number, ProcRow>();
  for (const zeile of raw.split('\n')) {
    const m = zeile.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d:-]+)\s+(.*)$/);
    if (!m) continue;
    tabelle.set(Number(m[1]), {
      pid: Number(m[1]),
      ppid: Number(m[2]),
      cpu: Number(m[3]) || 0,
      ageSeconds: etimeSekunden(m[4]),
      args: m[5],
    });
  }
  return tabelle;
}

/** `tmux list-panes -a -F PANE_LIST_FORMAT` roh -> Zeilen. Reine Funktion (siehe oben). */
export function parsePaneRows(raw: string): PaneRow[] {
  return raw.split('\n').filter(Boolean).map((z) => {
    const [session, windowId, windowIndex, paneId, paneIndex, role, worker, pid, command] = z.split('\t');
    return {
      session,
      windowId,
      windowIndex: Number(windowIndex) || 0,
      paneId,
      paneIndex: Number(paneIndex) || 0,
      role: role ?? '',
      worker: worker ?? '',
      pid: Number(pid) || 0,
      command: command ?? '',
    };
  });
}

/**
 * Zwei Buchstaben aus dem Projektnamen, sonst nichts. Bei mehreren Wortteilen
 * die Anfangsbuchstaben der ersten beiden, bei einem Wort seine ersten zwei.
 */
export function initialsOf(name: string): string {
  const teile = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (teile.length >= 2) return (teile[0][0] + teile[1][0]).toUpperCase();
  const eins = teile[0] ?? '?';
  return (eins.length >= 2 ? eins.slice(0, 2) : eins + eins).toUpperCase();
}

/**
 * Alle Prozesse einmal lesen, damit die Kommandozeilen der Panes bekannt sind.
 * `etime` kommt mit: es sagt, WANN ein Prozess entstanden ist, und genau daran
 * haengt die Unterscheidung zwischen "haengt" und "arbeitet an einem langen
 * Werkzeugaufruf" (siehe stillstand()). Ein zweiter ps-Aufruf dafuer waere
 * verschenkt -- dieser hier laeuft ohnehin bei jedem Takt.
 */
function processTable(): Map<number, ProcRow> {
  let out = spawnSync('ps', ['-axo', 'pid=,ppid=,pcpu=,etime=,args='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (out.status !== 0) out = spawnSync('ps', ['-eo', 'pid=,ppid=,pcpu=,etime=,args='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return parseProcTable(out.stdout || '');
}

export function subtree(pid: number, tabelle: Map<number, ProcRow>): ProcRow[] {
  const kinder = new Map<number, number[]>();
  for (const [p, v] of tabelle) {
    const liste = kinder.get(v.ppid) ?? [];
    liste.push(p);
    kinder.set(v.ppid, liste);
  }
  const raus: ProcRow[] = [];
  const offen = [pid];
  const gesehen = new Set<number>();
  while (offen.length) {
    const p = offen.pop()!;
    if (gesehen.has(p)) continue;
    gesehen.add(p);
    const e = tabelle.get(p);
    if (e) raus.push(e);
    for (const k of kinder.get(p) ?? []) offen.push(k);
  }
  return raus;
}

/**
 * Das Alter des JUENGSTEN Prozesses unter einem Pane, ohne den Pane-Prozess
 * selbst; -1, wenn es keinen gibt. Damit laesst sich sagen, ob unter einem
 * stillen Worker gerade ein Werkzeug laeuft -- ein Kindprozess, der NACH dem
 * letzten Transcript-Eintrag entstanden ist, ist Arbeit und kein Stillstand.
 */
export function juengsterKindProzess(pid: number, tabelle: Map<number, ProcRow>): number {
  let jung = -1;
  for (const r of subtree(pid, tabelle)) {
    if (r.pid === pid || r.ageSeconds < 0) continue;
    if (jung < 0 || r.ageSeconds < jung) jung = r.ageSeconds;
  }
  return jung;
}

export function agentFlags(args: string): { agentId: string; name: string; type: string } | null {
  if (!args.includes('--agent-id')) return null;
  const hol = (flag: string): string => {
    const m = args.match(new RegExp(`${flag}[= ]("[^"]*"|\\S+)`));
    return m ? m[1].replace(/^"|"$/g, '') : '';
  };
  return { agentId: hol('--agent-id'), name: hol('--agent-name'), type: hol('--agent-type') };
}

function readPanes(socket: string): PaneRow[] {
  const roh = tmux(socket, ['list-panes', '-a', '-F', PANE_LIST_FORMAT]);
  return roh ? parsePaneRows(roh) : [];
}

/**
 * Das Ergebnis eines Durchgangs: die Sitzungen UND ob tmux dabei ueberhaupt
 * erreichbar war. Beides zusammen, weil das eine ohne das andere nicht zu
 * beurteilen ist -- eine leere Liste heisst je nach Antwort „nichts laeuft"
 * oder „wir konnten nicht nachsehen".
 */
export interface SessionsBefund {
  sessions: SessionInfo[];
  /** false = tmux liess sich auf dieser Maschine nicht ausfuehren. */
  tmuxAusfuehrbar: boolean;
  /** Der Satz dazu, fuer das Fenster. Leer, solange tmux ausfuehrbar ist. */
  tmuxFehler: string;
}

/**
 * Subagenten einem Worker zuordnen. Ein sicherer Weg dafuer existiert nicht:
 * tmux-Panes haengen alle am tmux-Server, nicht an dem Prozess, der sie
 * gestartet hat. Deshalb zwei Regeln, in dieser Reihenfolge, und beide werden
 * im Bericht als Heuristik benannt: Nennt die Kommandozeile einen bekannten
 * Workernamen, gilt der. Sonst der naechste Worker-Pane davor im selben
 * Fenster, weil ein Split den neuen Pane neben den Ausloeser setzt.
 */
export function zuordnen(sub: PaneRow, panes: PaneRow[], args: string, workerNamen: string[]): string {
  const genannt = workerNamen.find((n) => n && args.includes(n));
  if (genannt) return genannt;
  const geschwister = panes
    .filter((p) => p.windowId === sub.windowId && p.role === 'worker' && p.paneIndex < sub.paneIndex)
    .sort((a, b) => b.paneIndex - a.paneIndex);
  return geschwister[0]?.worker ?? '';
}

function offeneFreigaben(requestsDir: string): { total: number; jeSession: Map<string, number>; jeWorker: Set<string> } {
  const jeSession = new Map<string, number>();
  // Die Antragsdatei heisst `<antragsteller>-<zeitstempel>.json`. Daraus laesst
  // sich ohne Kenntnis des Dateiinhalts sagen, WER gerade auf eine Entscheidung
  // wartet -- und das faerbt seinen Tab.
  const jeWorker = new Set<string>();
  let total = 0;
  if (!existsSync(requestsDir)) return { total, jeSession, jeWorker };
  let dateien: string[] = [];
  try {
    dateien = readdirSync(requestsDir);
  } catch {
    return { total, jeSession, jeWorker };
  }
  for (const d of dateien) {
    if (d.endsWith('.decision') || d === 'log.tsv') continue;
    if (dateien.includes(`${d}.decision`)) continue;
    total++;
    const antragsteller = basename(d, '.json').replace(/-\d+$/, '');
    if (antragsteller && antragsteller !== basename(d, '.json')) jeWorker.add(antragsteller);
    try {
      const inhalt = JSON.parse(readFileSync(join(requestsDir, d), 'utf8')) as Record<string, unknown>;
      const schluessel = String(inhalt.tmuxSession ?? inhalt.session ?? inhalt.dir ?? '');
      if (schluessel) jeSession.set(schluessel, (jeSession.get(schluessel) ?? 0) + 1);
    } catch {
      // Eine Datei, die sich nicht lesen laesst, zaehlt trotzdem als offen --
      // sie ist da, und jemand wartet darauf.
    }
  }
  return { total, jeSession, jeWorker };
}

/**
 * Wer wen BEANTRAGT hat, aus dem Protokoll der Antraege. Je Zeile:
 * `ts  parent  parent_model  child_name  child_model  est`. Gelesen wird nur;
 * geschrieben wird diese Datei von den wb-Werkzeugen.
 *
 * Ob ein Antrag bewilligt wurde und ob das Kind noch laeuft, steht hier NICHT
 * und wird auch nicht hier entschieden: Ein Kind erscheint in der Anzeige nur,
 * wenn es unter den lebenden Workern der Session auftaucht. Damit fallen
 * abgelehnte und beendete von selbst heraus, ohne dass die Entscheidungsdateien
 * ein zweites Mal ausgewertet werden muessen.
 */
function antragsEltern(requestsDir: string): Map<string, string> {
  const eltern = new Map<string, string>();
  const datei = join(requestsDir, 'log.tsv');
  if (!existsSync(datei)) return eltern;
  let roh = '';
  try {
    roh = readFileSync(datei, 'utf8');
  } catch {
    return eltern;
  }
  for (const zeile of roh.split('\n')) {
    if (!zeile.trim()) continue;
    const spalten = zeile.split('\t');
    const parent = (spalten[1] ?? '').trim();
    const kind = (spalten[3] ?? '').trim();
    // Der letzte Eintrag gewinnt: ein Name kann nach einem Abbruch neu vergeben
    // werden, und dann gilt der juengere Antrag.
    if (parent && kind && parent !== kind) eltern.set(kind, parent);
  }
  return eltern;
}

/** Die Sitzungen allein -- fuer alle Aufrufer, die den tmux-Befund nicht brauchen. */
export function readSessions(opt: SessionsOptions): SessionInfo[] {
  return leseSessions(opt).sessions;
}

/**
 * Weitergereicht aus workerstate.ts, und zwar HIER, weil ein Testbuendel sein
 * eigenes Modul mitbringt: wer `sessionLoadOffen` aus dist/test/workerstate.mjs
 * holte, saehe den Zaehler einer ZWEITEN Kopie und damit immer 0. Eine Suite,
 * die auf das Nachlesen im Hintergrund warten muss, fragt deshalb hier.
 */
export { sessionLoadOffen } from './workerstate';

export function leseSessions(opt: SessionsOptions): SessionsBefund {
  const jetzt = Date.now();
  const stallSeconds = opt.stallSeconds ?? STALL_SECONDS_DEFAULT;
  const sitzungsListe = tmuxAntwort(opt.tmuxSocket, ['list-sessions', '-F', SESSION_LIST_FORMAT]);
  // Eine Antwort, die das Trennzeichen des Formats nicht traegt, ist keine
  // Sitzungsliste. Sie wird behandelt wie „tmux hat nicht brauchbar
  // geantwortet" und ausdruecklich NICHT wie „es laeuft nichts" -- eine Zeile,
  // die wir nicht zerlegen koennen, sagt nichts ueber die Sitzungen aus.
  const formatKaputt = trennzeichenFehlt(sitzungsListe.raw);
  const tmuxDa = sitzungsListe.ausfuehrbar && !formatKaputt;
  const tmuxFehler = sitzungsListe.fehler || (formatKaputt
    ? 'tmux hat geantwortet, aber ohne das Trennzeichen des Formats -- die Antwort '
      + 'laesst sich nicht zerlegen. Solange das so ist, sagt dieses Fenster ueber keine '
      + 'Sitzung, ob sie laeuft.'
    : '');
  const { lebende, eigene } = parseSessionList(formatKaputt ? '' : sitzungsListe.raw);
  const verlorene = new Set(opt.verlorene ?? []);

  // Ist tmux nicht ausfuehrbar, scheitert der zweite Aufruf genauso -- und
  // zwar bei JEDEM Takt aufs Neue. Er wird ausgelassen; die Panes waeren
  // ohnehin leer. Dasselbe gilt fuer eine unzerlegbare Antwort: die Pane-Liste
  // traegt dieselben Tabulatoren und waere genauso unbrauchbar.
  const panes = tmuxDa ? readPanes(opt.tmuxSocket) : [];
  const ps: Map<number, ProcRow> = panes.length ? processTable() : new Map();
  const freigaben = offeneFreigaben(opt.requestsDir);
  const eltern = antragsEltern(opt.requestsDir);
  // Zweite Quelle fuer `blocked`, aus derselben Datei wie die Freigabe-Ansicht.
  const angehalten = blockiertePanes(opt.guardBlocksDir);

  let dateien: string[] = [];
  try {
    dateien = readdirSync(opt.sessionsDir).filter((d) => d.endsWith('.json'));
  } catch {
    dateien = [];
  }

  const raus: SessionInfo[] = [];
  for (const datei of dateien.sort()) {
    let roh: Record<string, unknown>;
    try {
      roh = JSON.parse(readFileSync(join(opt.sessionsDir, datei), 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const tmuxSession = String(roh.tmuxSession ?? '');
    const name = String(roh.name ?? basename(datei, '.json'));
    const machine = String(roh.machine ?? opt.machine);
    const reachable = opt.reachable.includes(machine);
    const alive = reachable && lebende.has(tmuxSession);
    // Konnten wir ueberhaupt nachsehen? DIESELBE Bedingung, aus der weiter
    // unten 'unreachable' wird -- einmal benannt, damit Sitzung und Worker nicht
    // zwei Vorstellungen davon bekommen, was einsehbar heisst. Ist sie falsch,
    // ist `panes` entweder leer (tmux nicht ausfuehrbar oder unzerlegbar) oder
    // gehoert zu einer anderen Maschine als dieser Sitzung; in beiden Faellen
    // sagt ein fehlender Pane nichts ueber den Worker aus.
    const einsehbar = tmuxDa && reachable;

    const sessionPanes = panes.filter((p) => p.session === tmuxSession);
    const orchestrator = sessionPanes.find((p) => p.role === 'orchestrator');

    const rohWorker = Array.isArray(roh.workers) ? (roh.workers as Record<string, unknown>[]) : [];
    const workerNamen = rohWorker.map((w) => String(w.name ?? ''));

    // Subagenten einsammeln: kein @wb_role, aber Agenten-Flags im Prozessbaum.
    const subagenten = new Map<string, SubagentInfo[]>();
    for (const p of sessionPanes) {
      if (p.role) continue;
      const args = subtree(p.pid, ps).map((r) => r.args).find((a) => a.includes('--agent-id'));
      if (!args) continue;
      const flags = agentFlags(args);
      if (!flags) continue;
      const ziel = zuordnen(p, sessionPanes, args, workerNamen);
      const liste = subagenten.get(ziel) ?? [];
      liste.push({ paneId: p.paneId, agentId: flags.agentId, name: flags.name, type: flags.type });
      subagenten.set(ziel, liste);
    }

    const workers: WorkerInfo[] = rohWorker.map((w) => {
      const wname = String(w.name ?? '');
      const wmodel = String(w.model ?? '');
      const wdir = String(w.dir ?? '');
      const pane = sessionPanes.find((p) => p.role === 'worker' && p.worker === wname);
      const cpu = pane ? subtree(pane.pid, ps).reduce((sum, r) => sum + r.cpu, 0) : 0;

      // Die Kontextzahl kommt aus dem Transcript, und WELCHES Transcript es ist,
      // steht in dieser Zustandsdatei -- `claudeSessionId` schreibt der Spawn
      // hinein, sobald die Unterhaltung beginnt. Kein Suchen im Prozessbaum,
      // kein Raten bei mehreren Sitzungen in einem Ordner, keine Statuszeile.
      const tpfad = transcriptPfad(opt.projectsDir, wdir, String(w.claudeSessionId ?? ''));
      const t = transcriptStand(tpfad, wmodel, opt.modelsFile);
      const idleSeconds = t.mtimeMs > 0 ? Math.max(0, Math.floor((jetzt - t.mtimeMs) / 1000)) : -1;

      // FUENFTE QUELLE (2026-08-11, workerstate.ts): ein Worker ohne
      // Claude-Transcript -- jeder Harness ausser 'claude' -- bekommt seine
      // Auslastung ueber den session-Block der Registry statt ueber -1.
      // Versucht wird das NUR, wenn der Claude-Pfad oben nichts fand: fuer
      // Claude bleibt der schnelle, eingebaute Weg die einzige Quelle, ohne
      // einen zusaetzlichen Prozessaufruf je Takt.
      //
      // GELESEN WIRD IM HINTERGRUND (2026-08-16): `sessionLoadGemerkt` gibt
      // sofort zurueck, was zuletzt bekannt war, und stoesst das Nachlesen
      // nebenher an. Dieser Takt haelt damit nie mehr an einem Kindprozess an;
      // der Preis ist, dass die Zahl beim ERSTEN Sehen eines Workers noch
      // unbekannt ist und einen Takt spaeter dasteht.
      const wharness = String(w.kind ?? '');
      let contextPercent = t.percent;
      let contextTokens = t.tokens;
      let contextWindow = t.contextWindow;
      if (contextPercent === -1 && wharness && wharness !== 'claude') {
        const spec = harnessSessionSpec(wharness, opt.modelsFile);
        if (spec) {
          const fenster = kontextFenster(wmodel, opt.modelsFile);
          const s = sessionLoadGemerkt(spec, wdir, fenster);
          if (s.percent !== -1) {
            contextPercent = s.percent;
            contextTokens = s.tokens;
            // NICHT `fenster`: bei codex-rollout steht der Nenner in der
            // Sitzungsdatei selbst und kann vom Registry-Wert abweichen --
            // `s.contextWindow` ist der, der die Prozentzahl wirklich ergab.
            contextWindow = s.contextWindow;
          }
        }
      }
      const ergebnis: Ergebnis | null = ergebnisStand(opt.resultsDir, wname);

      // Ein angehaltener Worker sieht lebendig aus und arbeitet nicht. Bis zum
      // 05.08. war das aus Dateien nicht zu sehen -- die Rueckfrage stand nur
      // im Pane-Text, und einmal hat sie 45 Minuten unbemerkt gestanden. Seit
      // bash-guard.py bei jeder Ablehnung einen Marker hinterlaesst, ist es
      // eine Datei wie alles andere hier.
      const blockedReason: '' | 'request' | 'guard' = !pane
        ? ''
        : angehalten.has(pane.paneId)
          ? 'guard'
          : freigaben.jeWorker.has(wname)
            ? 'request'
            : '';

      let state: WorkerState;
      // OHNE BLICK AUF DIE PANES WIRD KEIN WORKER FERTIG GENANNT (07.08.). Die
      // Sitzungsebene hat diese Luege am 07.08. verloren, eine Ebene tiefer
      // stand sie noch: `pane` ist dann immer undefined, und daraus wurde
      // `done` -- fuer JEDEN Worker der Sitzung, samt der Unterzeile "fertig,
      // kein Ergebnis". Diese Verzweigung steht deshalb VOR allen anderen.
      if (!einsehbar) state = 'unknown';
      else if (!pane) state = 'done';
      else if (blockedReason) state = 'blocked';
      else if (stillstand(idleSeconds, juengsterKindProzess(pane.pid, ps), stallSeconds)) state = 'stalled';
      else state = 'running';

      return {
        name: wname,
        kind: String(w.kind ?? ''),
        model: wmodel,
        dir: wdir,
        paneId: pane?.paneId ?? '',
        alive: !!pane,
        cpu: Math.round(cpu * 10) / 10,
        state,
        contextPercent,
        contextTokens,
        contextWindow,
        transcriptPath: t.path,
        idleSeconds,
        resultPath: ergebnis?.path ?? '',
        resultAt: ergebnis?.mtimeMs ?? 0,
        subagents: subagenten.get(wname) ?? [],
        requestedBy: eltern.get(wname) ?? '',
        pendingRequest: freigaben.jeWorker.has(wname),
        blockedReason,
        claudeSessionId: String(w.claudeSessionId ?? ''),
      };
    });

    // Subagenten ohne zuordenbaren Worker gehen nicht verloren: sie haengen
    // dann am Orchestrator, sichtbar wie alle anderen.
    const heimatlos = subagenten.get('') ?? [];

    const offen = freigaben.jeSession.get(tmuxSession) ?? freigaben.jeSession.get(String(roh.dir ?? '')) ?? 0;
    // Aufmerksamkeit verlangt nicht nur, wer fertig ist: ein haengender oder
    // blockierter Worker arbeitet nicht mehr und niemand merkt es -- genau der
    // Fall, der bisher nur auffiel, wenn zufaellig jemand davorsass.
    const wartend = workers.filter((w) => w.state !== 'running').length;

    let state: SessionState;
    // OHNE tmux WIRD NICHTS BEENDET GENANNT (07.08.). `alive` ist dann keine
    // Auskunft, sondern eine Luecke: wir haben nicht nachgesehen, wir konnten
    // es nicht. Genau dafuer gibt es den vierten Zustand seit F6 -- er heisst
    // „nicht einsehbar" und nicht „auf einer anderen Maschine". Ihn hier zu
    // nehmen hat zwei erwuenschte Folgen: die Sitzung faellt nicht dem Filter
    // fuer beendete Sitzungen zum Opfer (A12, sie bleibt sichtbar), und
    // `darfWiederherstellen` verweigert den Fortsetzen-Knopf -- eine womoeglich
    // laufende Sitzung bekommt keinen zweiten Orchestrator.
    if (!tmuxDa) state = 'unreachable';
    else if (!reachable) state = 'unreachable';
    else if (!alive) state = 'stopped';
    else if (offen > 0 || wartend > 0) state = 'attention';
    else state = 'running';

    raus.push({
      id: basename(datei, '.json'),
      name,
      dir: String(roh.dir ?? ''),
      machine,
      tmuxSession,
      alive,
      reachable,
      state,
      initials: initialsOf(name),
      lastActive: String(roh.lastActive ?? ''),
      owned: eigene.get(tmuxSession) === true,
      orchestratorPane: orchestrator?.paneId ?? '',
      workers,
      pendingApprovals: offen,
      orphanSubagents: heimatlos,
      claudeSessionId: String(roh.claudeSessionId ?? ''),
      // Nur eine wirklich beendete Sitzung kann verloren sein: bei
      // 'unreachable' haben wir gar nicht nachgesehen, und dann waere
      // „niemand hat ihr Ende gesehen" keine Aussage ueber sie, sondern
      // ueber uns.
      verloren: state === 'stopped' && verlorene.has(basename(datei, '.json')),
      sessionKey: String(roh.sessionKey ?? ''),
      harness: String(roh.harness ?? '') || 'claude',
      model: String(roh.model ?? ''),
    });
  }

  // Die Fernmaschinen haengen nicht am lokalen tmux: ihr Stand kommt ueber SSH
  // vom `RemotePoller` und ist auch dann noch gueltig, wenn hier kein tmux
  // gefunden wird.
  raus.push(...remoteSessions(opt.remoteSnapshots ?? [], verlorene));
  return { sessions: raus, tmuxAusfuehrbar: tmuxDa, tmuxFehler };
}

/**
 * Dieselbe Ableitung wie oben, aber aus dem Stand einer Fernmaschine (V10):
 * KEIN Zugriff auf ihre Transcripte, Ergebnisse oder Antraege -- das waere ein
 * zweiter SSH-Umweg fuer jede Datei statt des einen Abrufs, den der
 * `RemotePoller` schon macht. Ein Worker dort ist deshalb nur running/done,
 * nie stalled/blocked, und traegt -1/leer, wo lokal ein Transcript- oder
 * Ergebnispfad staende. Das ist ein bewusster Unterschied, kein Bug: sichtbar
 * in dieser Liste ist wichtiger als die volle lokale Genauigkeit.
 *
 * ANTWORTET DIE MASCHINE NICHT, IST AUCH DAS NICHT MEHR WAHR (07.08.). Der
 * Poller traegt den letzten bekannten Stand weiter (`leererStand`: dieselben
 * sessionFiles, dieselben panes), damit die Sitzungen nicht aus der Liste
 * fallen -- und genau deshalb stand hier bis heute 'running' fuer einen Worker,
 * dessen Pane vor Minuten gesehen wurde, oder 'done', wenn es nie einen
 * Vorgaenger-Stand gab. Beides ist eine Behauptung ueber die Gegenwart aus
 * einem alten Blatt. Ein nicht erreichbarer Stand macht die Worker deshalb
 * 'unknown', so wie er die Sitzung 'unreachable' macht.
 */
function remoteSessions(snapshots: RemoteSnapshot[], verlorene: Set<string>): SessionInfo[] {
  const raus: SessionInfo[] = [];
  for (const snap of snapshots) {
    for (const rec of snap.sessionFiles) {
      const alive = snap.reachable && snap.lebende.has(rec.tmuxSession);
      const sessionPanes = snap.panes.filter((p) => p.session === rec.tmuxSession);
      const orchestrator = sessionPanes.find((p) => p.role === 'orchestrator');
      const workerNamen = rec.workers.map((w) => w.name);

      const subagenten = new Map<string, SubagentInfo[]>();
      for (const p of sessionPanes) {
        if (p.role) continue;
        const args = subtree(p.pid, snap.procTable).map((r) => r.args).find((a) => a.includes('--agent-id'));
        if (!args) continue;
        const flags = agentFlags(args);
        if (!flags) continue;
        const ziel = zuordnen(p, sessionPanes, args, workerNamen);
        const liste = subagenten.get(ziel) ?? [];
        liste.push({ paneId: p.paneId, agentId: flags.agentId, name: flags.name, type: flags.type });
        subagenten.set(ziel, liste);
      }

      const workers: WorkerInfo[] = rec.workers.map((w) => {
        const pane = sessionPanes.find((p) => p.role === 'worker' && p.worker === w.name);
        const cpu = pane ? subtree(pane.pid, snap.procTable).reduce((sum, r) => sum + r.cpu, 0) : 0;
        return {
          name: w.name,
          kind: w.kind,
          claudeSessionId: w.claudeSessionId,
          model: w.model,
          dir: w.dir,
          paneId: pane?.paneId ?? '',
          alive: !!pane,
          cpu: Math.round(cpu * 10) / 10,
          state: !snap.reachable ? 'unknown' : pane ? 'running' : 'done',
          contextPercent: -1,
          contextTokens: 0,
          contextWindow: 0,
          transcriptPath: '',
          idleSeconds: -1,
          resultPath: '',
          resultAt: 0,
          subagents: subagenten.get(w.name) ?? [],
          requestedBy: '',
          pendingRequest: false,
          blockedReason: '',
        };
      });

      const heimatlos = subagenten.get('') ?? [];
      const wartend = workers.filter((w) => w.state !== 'running').length;

      let state: SessionState;
      if (!snap.reachable) state = 'unreachable';
      else if (!alive) state = 'stopped';
      else if (wartend > 0) state = 'attention';
      else state = 'running';

      const id = `${snap.machine}:${rec.fileBase}`;
      raus.push({
        id,
        name: rec.name || rec.fileBase,
        dir: rec.dir,
        machine: snap.machine,
        tmuxSession: rec.tmuxSession,
        alive,
        reachable: snap.reachable,
        state,
        initials: initialsOf(rec.name || rec.fileBase),
        lastActive: rec.lastActive,
        owned: snap.eigene.get(rec.tmuxSession) === true,
        orchestratorPane: orchestrator?.paneId ?? '',
        workers,
        pendingApprovals: 0,
        orphanSubagents: heimatlos,
        claudeSessionId: rec.claudeSessionId,
        // Dieselbe Bedingung wie hiesig, aus demselben Grund (siehe dort).
        verloren: state === 'stopped' && verlorene.has(id),
        sessionKey: rec.sessionKey,
        harness: rec.harness || 'claude',
        model: rec.model,
      });
    }
  }
  return raus;
}
