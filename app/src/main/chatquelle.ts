// DIE QUELLE DER CHAT-ANSICHT -- die unreine Haelfte (SPEC-V4 Abschnitt 6).
//
// Hier wird angefasst, was die reinen Bausteine unter app/src/chat/ nur deuten:
// Dateien, Prozesse, ein lokaler Server. Die Aufteilung ist Absicht -- jeder
// Leser, jeder Mustervergleich und jedes Urteil ist ohne Electron, ohne Netz und
// ohne tmux pruefbar (shell/tests/test-app-chat.sh), und diese Datei bleibt der
// duenne Rand, der ihnen ihren Text besorgt.
//
// DREI WEGE, und sie stehen in der Reihenfolge, die die Messung vom 11.08.
// vorgibt (SPEC-V4 6.3):
//   1  http-sse      der Server neben dem laufenden TUI. ZWEI Harnesses koennen
//                    das, nicht vier: opencode und jcode (gemessen). crush und
//                    qwen koennen es nachweislich nicht.
//   2  sessionFile   die Sitzungsdatei, mit Formatverteilung wie in
//                    `session_load()` der Kontextwache.
//   3  acp           gebaut bis zur Grenze des Belegbaren, siehe chat/acp.ts.
//
// DIE ANSICHT ERSETZT DEN PANE NICHT, sie legt sich darueber: der Pane laeuft
// weiter, wird weiter ausgewertet, und die Eingabe geht weiterhin ueber
// `wb-pane-write` in den Pane. Nichts in dieser Datei schreibt in eine Sitzung.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { chatAnsicht, chatAnsichtVorgabe } from './einstellungen';
import { sessionBloeckeAus, urteil } from '../chat/registry';
import { ansichtOffen, type PaneRolle } from '../chat/ansichtsregel';
import { leserVorhanden, nachrichtenAus, kopfAus } from '../chat/leser';
import { kandidatWaehlen } from '../chat/zuordnung';
import { bruecke } from '../chat/bruecke';
import type { PaneLage } from '../chat/bruecke';
import { transcriptStand } from './workerstate';
import { ortFuellen, segmentPasst, istMuster } from '../chat/pfadmuster';
import {
  adresseErlaubt,
  jcodeSitzungen,
  opencodeNachrichten,
  opencodeSitzungen,
  portAusLsof,
} from '../chat/httpsse';
import type { Bruecke, ChatNachricht, ChatStand, Kandidat, SessionBlock } from '../chat/typen';
import { LEERE_BRUECKE } from '../chat/typen';

/** Wie viel vom Ende einer Sitzungsdatei gelesen wird. Ein Transcript waechst auf Megabyte. */
const TAIL_BYTES = 512 * 1024;

/** Wie viele Nachrichten die Ansicht bekommt. Aelteres steht im Terminal-Rueckblick. */
const MAX_NACHRICHTEN = 200;

/** Wie lange ein Aufruf nach aussen hoechstens dauern darf. Nie unbegrenzt warten. */
const FRIST_MS = 3000;

export interface PaneAnfrage {
  paneId: string;
  harness: string;
  /**
   * Die Sitzung, zu der dieser Pane gehoert (Kennung der Werkbank, nicht die
   * des Harness). Fuer das Uebersteuern je Sitzung -- der Rechtsklick trifft
   * die Sitzung, nicht den Pane.
   */
  sitzung: string;
  /** Wer in diesem Pane sitzt. Entscheidet, WELCHE Rollenvorgabe gilt. */
  rolle: PaneRolle;
  /** Arbeitsverzeichnis des Panes. */
  cwd: string;
  /** Prozesskennung des Panes -- fuer die Zuordnung ueber `pid` und fuer lsof. */
  pid: number;
  /**
   * Die Sitzungskennung, die der Harness selbst gemeldet hat (Zuordnung
   * 'hook'). Leer, solange kein Hook gelaufen ist -- dann gibt es keine
   * Ansicht, und der Grund sagt das.
   */
  sitzungsId: string;
  /**
   * Die Unterhaltung, die sich die WERKBANK zu diesem Pane notiert hat
   * (`claudeSessionId` der Sitzung bzw. des Workers in der Zustandsdatei).
   * Der mittlere der drei Wege aus chat/zuordnung.ts: gebraucht, sobald der
   * Pane aelter ist als der Haken, der die Kennung an den Pane haengt.
   */
  vermerkteId: string;
  /** Was die Werkbank ueber den Pane ohnehin weiss -- fuer die Bruecke. */
  lage: PaneLage | null;
  /**
   * Das Modell dieses Panes -- des Workers, oder bei der Rolle 'orchestrator'
   * das der Sitzung selbst. Leer, wenn unbekannt. Gebraucht NUR fuer
   * `auslastungAusDatei()`: das Kontextfenster kommt aus der Registry, indiziert
   * ueber das Modell, nicht ueber den Harness.
   */
  model: string;
}

export interface QuellenOptionen {
  /** Die gepflegte Registry dieser Maschine. */
  modelsFile: string;
  /** Die Einstellungsdatei mit `chatAnsicht` je Harness. */
  settingsFile?: string;
  /**
   * Das Uebersteuern DIESER Sitzung, aus ui.json. `null` oder weggelassen
   * heisst: es gibt keins. Es kommt von aussen herein, weil ui.json dem
   * Fenster gehoert und diese Datei nur Registry und Einstellungen liest.
   */
  uebersteuerung?: boolean | null;
  /** Fuer Tests: die Uhr und das Heimatverzeichnis kommen von aussen. */
  jetztMs?: number;
  home?: string;
}

/**
 * Ob dieser Pane das Gespraech zeigen soll -- das Ergebnis der Aufloesungsregel
 * (chat/ansichtsregel.ts), einmal je Aufruf gebildet und in jeden `ChatStand`
 * dieses Durchgangs durchgereicht.
 *
 * ALS PARAMETER UND NICHT ALS MODULZUSTAND (Befund 5 der Bugjagd, 15.08.).
 * Vorher stand der Wert in einer Modulvariablen, gesetzt am Anfang von
 * `chatStand()` und gelesen NACH dessen `await`s. Nachgestellt in der Nacht zum
 * 16.08. mit zwei gleichzeitigen Abfragen -- eine ueber einen langsamen
 * opencode-Server, eine sofort fertige daneben --: die langsame kam mit der
 * Vorgabe der anderen zurueck (allein `true`, im Doppellauf `false`). Im
 * Betrieb pollt die Oberflaeche mehrere Panes; zwei davon genuegen.
 */
function leererStand(
  a: PaneAnfrage,
  grund: string,
  via: ChatStand['via'],
  jetzt: number,
  vorgabe: boolean,
): ChatStand {
  return {
    paneId: a.paneId,
    harness: a.harness,
    via,
    moeglich: false,
    grund,
    quelle: '',
    herkunft: '',
    nachrichten: [],
    bruecke: a.lage ? bruecke(a.lage) : { ...LEERE_BRUECKE },
    vorgabe,
    stand: jetzt,
  };
}

// --- Registry, einmal gelesen und bei Aenderung neu ---------------------------
//
// Dieselbe Zurueckhaltung wie bei `harnessResume` in main.ts: die Vorschau
// laeuft im Sekundentakt, und 78 KB JSON je Takt waeren dafuer zu teuer.
let merker: { mtimeMs: number; size: number; bloecke: Record<string, SessionBlock> } | null = null;

export function sessionBloecke(modelsFile: string): Record<string, SessionBlock> {
  let st: { mtimeMs: number; size: number };
  try {
    const x = statSync(modelsFile);
    st = { mtimeMs: x.mtimeMs, size: x.size };
  } catch {
    return {};
  }
  if (!merker || merker.mtimeMs !== st.mtimeMs || merker.size !== st.size) {
    let bloecke: Record<string, SessionBlock> = {};
    try {
      bloecke = sessionBloeckeAus(JSON.parse(readFileSync(modelsFile, 'utf8')) as unknown);
    } catch {
      // Eine kaputte Registry darf die Ansicht nicht sprengen: dann gibt es
      // keine Bloecke, und jeder Pane bekommt seinen Grund im Klartext.
    }
    merker = { ...st, bloecke };
  }
  return merker.bloecke;
}

/**
 * Ob dieses Programm fuer einen in der Registry genannten Formatnamen
 * ueberhaupt einen Leser hat. EINE Fassung -- `chatStand` und
 * `chatFaehigkeit` fragen dieselbe, sonst faellt ein Urteil zweimal
 * verschieden aus.
 */
function leserDa(format: string): boolean {
  return leserVorhanden(format) || format === 'opencode-http' || format === 'jcode-daemon';
}

/**
 * KANN dieser Harness sein Gespraech hergeben -- und wenn nicht, warum nicht?
 *
 * Die erste der drei Ebenen aus chat/ansichtsregel.ts, allein aus der Registry
 * beantwortet und ohne jede Einstellung: eine Faehigkeit, keine Vorliebe.
 * Gebraucht wird sie vom Menuepunkt in main.ts, der auch dann ausgefuehrt wird,
 * wenn es nicht geht -- und der dann den Grund nennen muss.
 */
export function chatFaehigkeit(harness: string, modelsFile: string): { kann: boolean; grund: string } {
  const u = urteil(sessionBloecke(modelsFile)[harness] ?? null, true, leserDa);
  return { kann: u.moeglich, grund: u.grund };
}

// --- Dateien finden ----------------------------------------------------------

/**
 * Alle Pfade zu einem Muster. Nur `*` innerhalb eines Namensteils (siehe
 * chat/pfadmuster.ts), und mit Deckel: ein Ordner mit zehntausend
 * Sitzungsdateien darf einen Takt der Oberflaeche nicht aufhalten.
 */
function pfadeZuMuster(muster: string, deckel = 400): string[] {
  if (!istMuster(muster)) {
    try {
      statSync(muster);
      return [muster];
    } catch {
      return [];
    }
  }
  const teile = muster.split('/');
  let staende = [teile[0] || '/'];
  for (const teil of teile.slice(1)) {
    if (!teil) continue;
    const naechste: string[] = [];
    for (const basis of staende) {
      if (naechste.length >= deckel) break;
      if (!teil.includes('*')) {
        naechste.push(join(basis, teil));
        continue;
      }
      let eintraege: string[];
      try {
        eintraege = readdirSync(basis);
      } catch {
        continue;
      }
      for (const e of eintraege) {
        if (naechste.length >= deckel) break;
        if (segmentPasst(e, teil)) naechste.push(join(basis, e));
      }
    }
    staende = naechste;
  }
  return staende.filter((p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/** Das Ende einer Datei, hoechstens TAIL_BYTES -- und ohne die erste, halbe Zeile. */
function schwanz(pfad: string, bytes = TAIL_BYTES): string {
  const st = statSync(pfad);
  const roh = readFileSync(pfad);
  if (st.size <= bytes) return roh.toString('utf8');
  const teil = roh.subarray(st.size - bytes).toString('utf8');
  const i = teil.indexOf('\n');
  return i >= 0 ? teil.slice(i + 1) : teil;
}

/** Der Kopf einer Datei -- fuer die Zuordnung genuegen die ersten Zeilen. */
function kopf(pfad: string, bytes = 64 * 1024): string {
  const roh = readFileSync(pfad);
  return roh.subarray(0, Math.min(roh.length, bytes)).toString('utf8');
}

/**
 * Die Prozesskennung, die qwen neben seine Sitzungsdatei legt: die Datei
 * `<sessionId>.runtime.json` mit `pid`, `session_id` und `work_dir` (gemessen
 * 11.08.). Damit ist die Zuordnung ueber die PID des Panes eindeutig, auch bei
 * zwei Sitzungen im selben Ordner -- qwen ist der einzige Eintrag mit
 * `zuordnung: 'pid'`.
 */
function laufzeitPid(pfad: string): number {
  const neben = join(dirname(pfad), `${basename(pfad, '.jsonl')}.runtime.json`);
  try {
    const d = JSON.parse(readFileSync(neben, 'utf8')) as Record<string, unknown>;
    return typeof d.pid === 'number' ? d.pid : 0;
  } catch {
    return 0;
  }
}

/**
 * DIE AUSLASTUNG AUS DER SITZUNGSDATEI SELBST, wenn die Bruecke noch nichts
 * weiss (12.08.). `sessions.ts` fuehrt `contextPercent`/`contextTokens`/
 * `contextWindow` NUR je Worker (`transcriptStand()` in workerstate.ts, ueber
 * dessen eigenes Transcript) -- fuer den Orchestrator-Pane selbst traegt
 * `anfrageFuerPane()` dort bislang immer -1/0/0 ein, weil niemand seine
 * eigene Sitzungsdatei ausliest. Genau die liegt hier aber schon vor: dieselbe
 * Datei, die `ausSitzungsdatei()` fuer den Gespraechsverlauf gewaehlt hat.
 *
 * GEMESSEN (12.08., echte Sitzungsdatei dieser Maschine): jeder
 * `assistant`-Eintrag traegt `message.usage` mit `input_tokens`,
 * `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`.
 * Belegt ist, was beim naechsten Aufruf wieder hineingeht -- dieselbe Rechnung
 * wie im Kontext-Guard und in `transcriptStand()`, und genau DESHALB wird sie
 * hier nicht ein zweites Mal geschrieben: `transcriptStand()` liest densel-
 * ben juengsten Nutzungseintrag vom Dateiende her, das Kontextfenster kommt
 * aus derselben Modell-Registry wie ueberall sonst im Haus. EIN Leser fuer die
 * Tokenzahl, nicht zwei.
 *
 * Nur fuer `claude-transcript` versucht: das ist das einzige Format, an dem
 * `usage` je gemessen wurde (workerstate.ts baut seinen eigenen Weg deshalb
 * ebenso nur fuer den Harness 'claude'). Ohne Modell wird nicht geraten --
 * das Kontextfenster liesse sich sonst nicht nachschlagen.
 *
 * NUR BEI EINER EINDEUTIGEN ZUORDNUNG (Reviewer-Befund B2, 12.08.): `hook` und
 * `vermerk` treffen GENAU diesen Pane; `ordner` ist der schwaechste der vier
 * Wege (die juengste Datei eines Projektordners) und kann bei zwei Sitzungen im
 * selben Ordner die Datei eines FREMDEN Panes sein -- die Tokenzahl gehoerte
 * dann zu einer anderen Unterhaltung. Eine falsche Zahl ist schlechter als
 * keine (dieselbe Haltung wie ueberall sonst im Haus: "eine Zahl ohne Herkunft
 * ist eine Behauptung"), deshalb bleibt die Bruecke bei `ordner` unangetastet.
 */
function auslastungAusDatei(
  stand: Bruecke,
  pfad: string,
  format: string,
  model: string,
  modelsFile: string,
  herkunft: string,
): Bruecke {
  const eindeutig = herkunft === 'hook' || herkunft === 'vermerk';
  if (stand.auslastung >= 0 || stand.tokens > 0 || format !== 'claude-transcript' || !model || !eindeutig) return stand;
  const t = transcriptStand(pfad, model, modelsFile);
  if (t.tokens <= 0) return stand;
  return {
    ...stand,
    auslastung: t.percent >= 0 ? Math.min(100, t.percent) : -1,
    tokens: t.tokens,
    fenster: t.contextWindow,
  };
}

// --- Weg 2: die Sitzungsdatei ------------------------------------------------

function ausSitzungsdatei(
  a: PaneAnfrage,
  block: SessionBlock,
  opt: Required<Pick<QuellenOptionen, 'home'>> & { jetztMs: number; modelsFile: string; vorgabe: boolean },
): ChatStand {
  const ort = ortFuellen(block.ort, {
    cwd: a.cwd,
    home: opt.home,
    sessionId: a.sitzungsId,
    tmpdir: process.env.TMPDIR ?? '/tmp',
  });
  // Ein relativer Ort ist einer IM Arbeitsverzeichnis des Panes (aider, crush).
  const muster = ort.startsWith('/') ? ort : join(a.cwd, ort);
  const pfade = pfadeZuMuster(muster);
  const kandidaten: Kandidat[] = [];
  // OB DER ORDNERWEG UEBERHAUPT IN FRAGE KOMMT, entscheidet sich hier -- und nur
  // dann wird je Kandidat der Kopf gelesen. Der Hook-Weg mit gemeldeter Kennung
  // (der Normalfall) kommt weiterhin ohne einen einzigen Dateikopf aus.
  //
  // Ein VERMERK allein genuegt dafuer nicht: er kann ins Leere zeigen (die Datei
  // ist geloescht oder wurde nie geschrieben), und dann faellt die Zuordnung auf
  // den Ordnerweg zurueck -- der ohne die Koepfe nichts vergleichen koennte und
  // "Keine Sitzung nennt das Arbeitsverzeichnis dieses Panes" saegte, obwohl
  // niemand nachgesehen hat. Deshalb wird zuerst am NAMEN geprueft, ob der
  // Vermerk ueberhaupt eine Datei trifft; nur wenn nicht, kostet es Koepfe.
  const vermerkTrifft = !!a.vermerkteId && pfade.some((p) => p.includes(a.vermerkteId));
  const ordnerWegMoeglich = block.zuordnung === 'cwd'
    || (block.zuordnung === 'hook' && !a.sitzungsId && !vermerkTrifft);
  for (const pfad of pfade) {
    try {
      const st = statSync(pfad);
      const k: Kandidat = { pfad, mtimeMs: st.mtimeMs, cwd: '', pid: 0 };
      if (block.zuordnung === 'pid') k.pid = laufzeitPid(pfad);
      // 8 KB statt 64: das Arbeitsverzeichnis steht in der ERSTEN Zeile eines
      // claude-Transcripts, und der Ordnerweg liest im Zweifel jede Datei des
      // Ordners. Der cwd-Weg behaelt seinen bisherigen Kopf, damit sich an
      // gemessenem Verhalten nichts aendert.
      else if (block.zuordnung === 'cwd') k.cwd = kopfAus(block.format, kopf(pfad)).cwd;
      else if (ordnerWegMoeglich) k.cwd = kopfAus(block.format, kopf(pfad, 8 * 1024)).cwd;
      kandidaten.push(k);
    } catch {
      // Verschwunden, waehrend wir hinsahen: uebergehen.
    }
  }
  const wahl = kandidatWaehlen(
    kandidaten,
    block.zuordnung,
    { cwd: a.cwd, pid: a.pid, sitzungsId: a.sitzungsId, vermerkteId: a.vermerkteId },
    opt.jetztMs,
    block.maxAgeSec,
  );
  if (!wahl.kandidat) return leererStand(a, wahl.grund, block.via, opt.jetztMs, opt.vorgabe);

  let nachrichten: ChatNachricht[];
  try {
    nachrichten = nachrichtenAus(block.format, schwanz(wahl.kandidat.pfad));
  } catch (e) {
    return leererStand(a, `Die Quelle liess sich nicht lesen: ${(e as Error).message}`, block.via, opt.jetztMs, opt.vorgabe);
  }
  return {
    paneId: a.paneId,
    harness: a.harness,
    via: block.via,
    moeglich: true,
    grund: '',
    quelle: wahl.kandidat.pfad,
    herkunft: wahl.herkunft,
    nachrichten: nachrichten.slice(-MAX_NACHRICHTEN),
    bruecke: auslastungAusDatei(bruecke(a.lage), wahl.kandidat.pfad, block.format, a.model, opt.modelsFile, wahl.herkunft),
    vorgabe: opt.vorgabe,
    stand: opt.jetztMs,
  };
}

/**
 * Ein Wert als SQLite-Zeichenkette. GEBRAUCHT, weil das Werkzeug KEINE
 * Parameter nimmt: `sqlite3 db "select … ?1" wert` deutet den Wert als zweite
 * ANWEISUNG und scheitert (gemessen mit sqlite3 3.51.0). Gequotet wird nach der
 * einzigen Regel, die SQLite kennt — ein Apostroph wird verdoppelt --, und ein
 * Nullbyte fliegt vorher raus. Die Werte kommen aus tmux (ein Pfad) und aus der
 * Datenbank selbst (eine Kennung); trotzdem wird gequotet und nicht darauf
 * vertraut.
 */
function sqlWert(s: string): string {
  return `'${s.replace(/\u0000/g, '').replace(/'/g, "''")}'`;
}

/**
 * copilot-sqlite geht seinen eigenen kurzen Weg: dort ist die Zuordnung eine
 * ABFRAGE (Tabelle `sessions`, Spalte `cwd`) und kein Dateiname, und gelesen
 * wird ueber `sqlite3 -readonly` -- die Datei gehoert einem laufenden Prozess,
 * und eine gewoehnlich geoeffnete Verbindung legt bei Bedarf Journal- und
 * WAL-Dateien an. Dieselbe Vorsicht wie `mode=ro` in der Kontextwache.
 */
function ausCopilotDb(
  a: PaneAnfrage,
  block: SessionBlock,
  opt: { home: string; jetztMs: number; vorgabe: boolean },
): ChatStand {
  const datei = ortFuellen(block.ort, { home: opt.home });
  const frage = (sql: string): string => {
    const r = spawnSync('/usr/bin/sqlite3', ['-readonly', '-json', datei, sql], {
      encoding: 'utf8',
      timeout: FRIST_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return r.status === 0 ? (r.stdout || '[]') : '';
  };
  // Beide Schreibweisen fragen, wie in der Kontextwache: die Copilot CLI traegt
  // den aufgeloesten Pfad ein (/private/var/…), der Pane heisst /var/….
  const wege = [a.cwd, a.cwd.startsWith('/private/') ? a.cwd.slice('/private'.length) : `/private${a.cwd}`];
  const sitzungen = frage(
    `select id, updated_at from sessions where cwd in (${wege.map(sqlWert).join(',')}) `
    + 'order by updated_at desc limit 2;',
  );
  let zeilen: Record<string, unknown>[];
  try {
    zeilen = JSON.parse(sitzungen || '[]') as Record<string, unknown>[];
  } catch {
    zeilen = [];
  }
  if (!zeilen.length) {
    return leererStand(a, 'Keine Copilot-Sitzung nennt das Arbeitsverzeichnis dieses Panes.', block.via, opt.jetztMs, opt.vorgabe);
  }
  if (zeilen.length > 1 && String(zeilen[0].updated_at ?? '').slice(0, 10) === String(zeilen[1].updated_at ?? '').slice(0, 10)) {
    return leererStand(
      a,
      'Zwei Copilot-Sitzungen in diesem Ordner am selben Tag — welche zu diesem Pane gehoert, ist von aussen nicht zu entscheiden.',
      block.via,
      opt.jetztMs,
      opt.vorgabe,
    );
  }
  const roh = frage(
    'select user_message, assistant_response, timestamp from turns where session_id = '
    + `${sqlWert(String(zeilen[0].id ?? ''))} order by turn_index asc;`,
  );
  return {
    paneId: a.paneId,
    harness: a.harness,
    via: block.via,
    moeglich: true,
    grund: '',
    quelle: datei,
    // Der Weg ueber die Copilot-Datenbank vergleicht das Arbeitsverzeichnis --
    // dieselbe Staerke wie der Ordnerweg, und dieselbe Grenze.
    herkunft: 'ordner',
    nachrichten: nachrichtenAus(block.format, roh).slice(-MAX_NACHRICHTEN),
    bruecke: bruecke(a.lage),
    vorgabe: opt.vorgabe,
    stand: opt.jetztMs,
  };
}

// --- Weg 1: der Server neben dem TUI -----------------------------------------

/**
 * Wie lange ein einmal gefundener Port gilt, solange sein Prozess lebt. Der
 * Port SELBST veraltet nicht -- ein Server wechselt ihn nicht im Betrieb --,
 * aber eine PID kann nach dem Ende ihres Prozesses neu vergeben werden. Diese
 * Schranke ist die Obergrenze fuer den Schaden daraus; erkannt wird ein falscher
 * Port ohnehin an der ersten fehlgeschlagenen Anfrage (siehe `ausOpencode`).
 */
const PORT_GEDAECHTNIS_MS = 300_000;

/**
 * Und wie lange gilt ein NICHT gefundener Port. Deutlich kuerzer, und das ist
 * der Unterschied, an dem so ein Gedaechtnis sonst falsch wird: neben einem
 * Pane kann jederzeit ein Server hochkommen (opencode braucht dafuer gemessen
 * rund 15 Sekunden), und "hier lauscht keiner" ist deshalb nur eine Auskunft
 * ueber diesen Moment. 15 Sekunden nehmen dem 2-Sekunden-Takt sieben von acht
 * Suchlaeufen ab und lassen einen frisch gestarteten Server trotzdem in der
 * Zeit auftauchen, in der ein Mensch die Ansicht ansieht.
 */
const OHNE_PORT_GEDAECHTNIS_MS = 15_000;

const portGedaechtnis = new Map<number, { port: number; gefunden: number }>();

/** Lebt dieser Prozess noch? Signal 0 stellt nur die Frage, es sendet nichts. */
function lebt(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM heisst: es gibt ihn, er gehoert nur jemand anderem.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Den gemerkten Port eines Panes vergessen. Aufgerufen wird das an genau EINER
 * Stelle: wenn die HTTP-Anfrage an diesen Port ins Leere lief. Alles andere
 * (eine Antwort mit Fehlercode etwa) beweist, dass dort jemand lauscht -- dann
 * ist der Port richtig und das Problem ein anderes.
 */
export function portVergessen(pid: number): void {
  portGedaechtnis.delete(pid);
}

/**
 * Der lauschende Port eines Panes. Gefragt wird `lsof` nach dem Prozessbaum des
 * Panes; genommen wird nur, was auf 127.0.0.1 lauscht (chat/httpsse.ts).
 *
 * Warum nicht aus der Registry: `opencode serve --port` hat die Vorgabe 0, der
 * Server sucht sich also selbst einen freien Port. Ein fester Port in der
 * Registry waere eine Zusage, die beim zweiten gleichzeitigen Worker bricht.
 *
 * GEFRAGT WIRD EINMAL, NICHT IM TAKT (2026-08-16). Die Suche kostet einen
 * `ps`-Aufruf und bis zu 40 `lsof`-Aufrufe, alle synchron im Hauptprozess --
 * gemessen 108 ms fuer einen Baum ohne Server (dann laufen alle 40 durch). Die
 * offene Gesprächsansicht fragte den Stand alle 2 Sekunden ab und bezahlte das
 * jedes Mal neu. Jetzt gilt ein gefundener Port, solange sein Prozess lebt.
 */
export function portVonPane(pid: number): number {
  if (!pid) return 0;
  const gemerkt = portGedaechtnis.get(pid);
  const frist = gemerkt?.port ? PORT_GEDAECHTNIS_MS : OHNE_PORT_GEDAECHTNIS_MS;
  if (gemerkt && Date.now() - gemerkt.gefunden < frist && lebt(pid)) return gemerkt.port;
  if (gemerkt) portGedaechtnis.delete(pid);
  const port = portSuchen(pid);
  // Auch die NULL wird gemerkt, nur kuerzer: der Fall "kein Server neben diesem
  // Pane" ist der TEUERSTE (alle 40 Aufrufe laufen durch, ohne dass einer etwas
  // findet) und zugleich der, der sich am ehesten aendert.
  portGedaechtnis.set(pid, { port, gefunden: Date.now() });
  return port;
}

function portSuchen(pid: number): number {
  const kinder = spawnSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: FRIST_MS });
  const baum: number[] = [pid];
  if (kinder.status === 0) {
    const eltern = new Map<number, number>();
    for (const z of (kinder.stdout || '').split('\n')) {
      const m = z.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) eltern.set(Number(m[1]), Number(m[2]));
    }
    for (const [k, e] of eltern) {
      let lauf = e;
      let tiefe = 0;
      while (lauf && tiefe++ < 12) {
        if (lauf === pid) {
          baum.push(k);
          break;
        }
        lauf = eltern.get(lauf) ?? 0;
      }
    }
  }
  for (const p of baum.slice(0, 40)) {
    const r = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(p), '-iTCP', '-sTCP:LISTEN', '-Fn'], {
      encoding: 'utf8',
      timeout: FRIST_MS,
    });
    const port = portAusLsof(r.stdout || '');
    if (port) return port;
  }
  return 0;
}

async function hole(adresse: string): Promise<{ ok: boolean; text: string; status: number }> {
  if (!adresseErlaubt(adresse)) return { ok: false, text: '', status: 0 };
  const abbruch = new AbortController();
  const uhr = setTimeout(() => abbruch.abort(), FRIST_MS);
  try {
    const antwort = await fetch(adresse, { signal: abbruch.signal });
    return { ok: antwort.ok, status: antwort.status, text: await antwort.text() };
  } catch {
    return { ok: false, text: '', status: 0 };
  } finally {
    clearTimeout(uhr);
  }
}

async function ausOpencode(a: PaneAnfrage, block: SessionBlock, jetztMs: number, vorgabe: boolean): Promise<ChatStand> {
  let port = portVonPane(a.pid);
  if (!port) {
    return leererStand(a, 'Neben diesem Pane lauscht kein opencode-Server auf 127.0.0.1.', block.via, jetztMs, vorgabe);
  }
  let basis = `http://127.0.0.1:${port}`;
  let liste = await hole(`${basis}/api/session`);
  // HIER, UND NUR HIER, WIRD DER GEMERKTE PORT VERWORFEN. `status === 0` heisst:
  // gar keine Verbindung -- der Server ist weg oder lauscht woanders. Jede
  // ANTWORT (auch eine mit Fehlercode) beweist dagegen, dass der Port stimmt;
  // ihn dann neu zu suchen hiesse, die 40 lsof-Aufrufe im Takt zurueckzuholen.
  if (!liste.ok && liste.status === 0) {
    portVergessen(a.pid);
    const neu = portVonPane(a.pid);
    if (neu && neu !== port) {
      port = neu;
      basis = `http://127.0.0.1:${port}`;
      liste = await hole(`${basis}/api/session`);
    }
  }
  if (liste.status === 401) {
    // Die Auflage aus SPEC-V4 6.3 Punkt 5 wirkt: der Server verlangt ein Token.
    // WELCHE Form die Anmeldung hat, ist nicht gemessen (vier Kopfzeilen und
    // Basic-Auth am 11.08. durchprobiert, alle 401) -- deshalb steht hier ein
    // ehrliches Nein und kein Ratespiel.
    return leererStand(
      a,
      'Der opencode-Server verlangt ein Token; die Form der Anmeldung ist nicht gemessen.',
      block.via,
      jetztMs,
      vorgabe,
    );
  }
  if (!liste.ok) {
    return leererStand(a, `Der opencode-Server antwortete nicht (${liste.status || 'keine Verbindung'}).`, block.via, jetztMs, vorgabe);
  }
  const sitzungen = opencodeSitzungen(liste.text)
    .filter((s) => s.verzeichnis === a.cwd)
    .sort((x, y) => y.aktualisiert - x.aktualisiert);
  if (!sitzungen.length) {
    return leererStand(a, 'Der Server kennt keine Sitzung in diesem Arbeitsverzeichnis.', block.via, jetztMs, vorgabe);
  }
  const nachrichten = await hole(`${basis}/api/session/${sitzungen[0].id}/message`);
  if (!nachrichten.ok) {
    return leererStand(a, 'Die Sitzung liess sich beim Server nicht abrufen.', block.via, jetztMs, vorgabe);
  }
  return {
    paneId: a.paneId,
    harness: a.harness,
    via: block.via,
    moeglich: true,
    grund: '',
    quelle: `${basis}/api/session/${sitzungen[0].id}`,
    // Der Server nennt zu jeder Sitzung ihr Verzeichnis; gewaehlt wird daraus.
    herkunft: 'ordner',
    nachrichten: opencodeNachrichten(nachrichten.text).slice(-MAX_NACHRICHTEN),
    bruecke: bruecke(a.lage),
    vorgabe,
    stand: jetztMs,
  };
}

/**
 * jcode: derselbe Weg, anderer Kanal -- ein Unix-Socket im TMPDIR der Sitzung,
 * angesprochen ueber `jcode debug --socket <sock> sessions` und nur mit
 * JCODE_DEBUG_CONTROL=1 (ohne den Schalter antwortet der Dienst "Debug control
 * is disabled", gemessen 11.08.).
 *
 * WAS DABEI HERAUSKOMMT, ist Zustand und kein Gespraech: session_id, status,
 * is_processing, model, provider, token_usage, swarm_id. `is_processing`
 * beantwortet die dritte Bruecken-Frage; Nachrichten stehen in dieser Antwort
 * nicht, und deshalb behauptet die Ansicht hier keine.
 */
function ausJcode(a: PaneAnfrage, block: SessionBlock, jetztMs: number, vorgabe: boolean): ChatStand {
  const sock = ortFuellen(block.ort, { tmpdir: process.env.TMPDIR ?? '/tmp' }).replace(/^unix:\/\//, '');
  let roh = '';
  try {
    roh = execFileSync('jcode', ['debug', '--socket', sock, 'sessions'], {
      encoding: 'utf8',
      timeout: FRIST_MS,
      env: { ...process.env, JCODE_DEBUG_CONTROL: '1' },
    });
  } catch {
    return leererStand(a, 'Der Debug-Kanal von jcode antwortete nicht.', block.via, jetztMs, vorgabe);
  }
  const sitzungen = jcodeSitzungen(roh).filter((s) => !s.verzeichnis || s.verzeichnis === a.cwd);
  const stand = leererStand(
    a,
    'jcode meldet ueber seinen Kanal nur den Zustand seiner Sitzungen, keine Nachrichten — ein Leser dafuer ist an keiner Messung belegt.',
    block.via,
    jetztMs,
    vorgabe,
  );
  if (sitzungen.length) stand.bruecke = { ...stand.bruecke, arbeitet: sitzungen[0].arbeitet };
  return stand;
}

// --- Wer sitzt in diesem Pane? ------------------------------------------------

/** Genau so viel vom Sessionmodell, wie die Ansicht braucht. */
export interface PaneUmfeld {
  /** Die Kennung der Sitzung -- an ihr haengt das Uebersteuern per Rechtsklick. */
  id: string;
  harness: string;
  orchestratorPane: string;
  pendingApprovals: number;
  /**
   * Die Unterhaltung des ORCHESTRATOR-Panes, wie die Zustandsdatei sie fuehrt.
   * Sie ist auch der Rueckfall der Zuordnung (chat/zuordnung.ts, Stufe
   * 'vermerk'), sobald der Pane aelter ist als der Haken am Pane.
   */
  claudeSessionId: string;
  /** Das Modell DIESER Sitzung -- fuer den Orchestrator-Pane (`SessionInfo.model`). */
  model: string;
  workers: {
    paneId: string;
    kind: string;
    dir: string;
    state: string;
    blockedReason: string;
    contextPercent: number;
    contextTokens: number;
    contextWindow: number;
    idleSeconds: number;
    /** Dieselbe Rolle wie oben, je Worker: die beim Spawn vermerkte Unterhaltung. */
    claudeSessionId: string;
    /** Das Modell dieses Workers (`WorkerInfo.model`). */
    model: string;
  }[];
}

/**
 * Die Anfrage fuer einen Pane, aus dem, was die Werkbank ohnehin fuehrt.
 *
 * `cwd` und `pid` kommen von tmux und nicht aus dem Modell: das Modell fuehrt
 * das Verzeichnis, in dem ein Worker GESTARTET wurde, tmux das, in dem sein Pane
 * gerade steht -- und die Sitzungsdatei traegt das zweite. Die Prozesskennung
 * fuehrt das Modell gar nicht; sie ist fuer qwen (Zuordnung 'pid') und fuer die
 * Portsuche bei opencode noetig.
 */
export function anfrageFuerPane(
  paneId: string,
  sitzungen: PaneUmfeld[],
  tmuxSocket: string,
): PaneAnfrage | null {
  let harness = '';
  let lage: PaneLage | null = null;
  let sitzung = '';
  let rolle: PaneRolle = 'worker';
  let vermerkteId = '';
  let modell = '';
  for (const s of sitzungen) {
    const w = s.workers.find((x) => x.paneId === paneId);
    if (w) {
      harness = w.kind || s.harness;
      sitzung = s.id;
      rolle = 'worker';
      vermerkteId = w.claudeSessionId;
      modell = w.model;
      lage = {
        zustand: w.state,
        blockGrund: w.blockedReason,
        auslastung: w.contextPercent,
        tokens: w.contextTokens,
        fenster: w.contextWindow,
        ruheSekunden: w.idleSeconds,
        antraegeOffen: s.pendingApprovals,
      };
      break;
    }
    if (s.orchestratorPane === paneId) {
      harness = s.harness;
      sitzung = s.id;
      rolle = 'orchestrator';
      vermerkteId = s.claudeSessionId;
      modell = s.model;
      lage = {
        zustand: 'running',
        blockGrund: '',
        auslastung: -1,
        tokens: 0,
        fenster: 0,
        ruheSekunden: -1,
        antraegeOffen: s.pendingApprovals,
      };
      break;
    }
  }
  if (!harness) return null;
  // '-L' (Socket-NAME), nicht '-S' (Pfad) -- dieselbe Lesart wie ueberall sonst, wo
  // `config.tmuxSocket` an tmux geht (sessions.ts' `tmux()`, main.ts:4260 und
  // shell/wb-pane-write ueber main.ts:3293). Mit dem Standardsocket (leerer String) macht
  // der Unterschied nichts aus, beide Zweige liefern dann `[]`; erst ein BENANNTER Socket
  // (AWB_TMUX_SOCKET, --tmux-socket) deckte ihn auf: '-S wbtest-...' sucht eine Datei dieses
  // Namens im Arbeitsverzeichnis statt den benannten Socket im tmux-Verzeichnis zu oeffnen,
  // der Aufruf schlaegt fehl, und cwd/PID/Sitzungskennung dieser Funktion bleiben leer.
  const basis = tmuxSocket ? ['-L', tmuxSocket] : [];
  const frag = (format: string): string => {
    const r = spawnSync('tmux', [...basis, 'display-message', '-p', '-t', paneId, format], {
      encoding: 'utf8',
      timeout: FRIST_MS,
    });
    return r.status === 0 ? (r.stdout || '').trim() : '';
  };
  return {
    paneId,
    harness,
    sitzung,
    rolle,
    cwd: frag('#{pane_current_path}'),
    pid: Number(frag('#{pane_pid}')) || 0,
    // Die Sitzungskennung, die der Harness selbst gemeldet hat -- geschrieben
    // von der Hook-Installation in shell/wb-harness-run, gelesen ueber die
    // Pane-Option, in die sie der Hook legt. Fehlt sie, sagt die Zuordnung das.
    sitzungsId: frag('#{@wb_chat_session}'),
    // Was die WERKBANK sich notiert hat -- die zweite Stufe der Zuordnung. Sie
    // steht im Modell und kostet deshalb keinen weiteren Aufruf nach aussen.
    vermerkteId,
    lage,
    model: modell,
  };
}

// --- Der eine Eingang --------------------------------------------------------

/**
 * DER STAND EINES PANES. Erst das Urteil aus der Registry, dann -- und nur dann
 * -- ein Zugriff. Ein Nein kommt immer mit seinem Grund im Klartext; was ein
 * Harness nicht kann, wird nicht ausgegraut (SPEC-V4 6.3 Punkt 6).
 */
export async function chatStand(a: PaneAnfrage, opt: QuellenOptionen): Promise<ChatStand> {
  const jetztMs = opt.jetztMs ?? Date.now();
  const home = opt.home ?? homedir();
  const block = sessionBloecke(opt.modelsFile)[a.harness] ?? null;
  const harnessSchalter = chatAnsicht(opt.settingsFile)[a.harness] === true;
  // ZWEI URTEILE AUS DERSELBEN QUELLE, und der Unterschied ist genau die
  // zweite Ebene: das erste fragt nur nach der FAEHIGKEIT (`gewuenscht: true`),
  // das zweite nach dem, was dieser Lauf wirklich tun darf. Die Faehigkeit
  // braucht die Aufloesungsregel getrennt -- ein Nein wegen "nicht
  // eingeschaltet" ist etwas anderes als ein Nein wegen "kann es nicht".
  const kann = urteil(block, true, leserDa).moeglich;
  const vorgabe = ansichtOffen({
    kann,
    erlaubt: harnessSchalter,
    rolle: a.rolle,
    vorgabe: chatAnsichtVorgabe(opt.settingsFile),
    uebersteuerung: opt.uebersteuerung ?? null,
  });
  // EINE GESETZTE SITZUNGS-UEBERSTEUERUNG SCHLAEGT AUCH HIER DEN
  // HARNESS-SCHALTER, nicht nur `vorgabe` oben -- sonst oeffnet der
  // Rechtsklick eine Ansicht, die dann leer bleibt: `vorgabe` sagt "an",
  // aber dieses zweite Urteil las bislang weiterhin nur den Harness-Schalter
  // und verweigerte den Zugriff, den der Rechtsklick gerade zugesagt hat.
  // Dieselbe Regel wie in ansichtsUrteil() (chat/ansichtsregel.ts), hier auf
  // den Harness-Schalter statt die Rollenvorgabe angewandt, weil dieses
  // Urteil ueber den ZUGRIFF entscheidet, nicht ueber das automatische
  // Oeffnen.
  const uebersteuerungGesetzt = typeof opt.uebersteuerung === 'boolean';
  const erlaubtJetzt = uebersteuerungGesetzt ? opt.uebersteuerung === true : harnessSchalter;
  const u = urteil(block, erlaubtJetzt, leserDa);
  if (!u.moeglich) return leererStand(a, u.grund, u.via, jetztMs, vorgabe);
  const b = block as SessionBlock;
  if (b.via === 'http-sse') {
    return b.format === 'jcode-daemon' ? ausJcode(a, b, jetztMs, vorgabe) : ausOpencode(a, b, jetztMs, vorgabe);
  }
  if (b.via === 'sessionFile') {
    return b.format === 'copilot-sqlite'
      ? ausCopilotDb(a, b, { home, jetztMs, vorgabe })
      : ausSitzungsdatei(a, b, { home, jetztMs, modelsFile: opt.modelsFile, vorgabe });
  }
  // acp: der Adapter reicht bis zum Handschlag und zur Sitzungsliste (chat/acp.ts).
  // Dass darueber das Gespraech eines im Pane laufenden TUI herauskommt, ist an
  // keinem Harness gemessen -- also wird es auch nicht behauptet.
  return leererStand(
    a,
    'Dieser Harness ist ueber das Agent Client Protocol eingetragen; dass daraus das Gespraech eines im Pane laufenden Programms herauskommt, ist an keinem Harness gemessen.',
    b.via,
    jetztMs,
    vorgabe,
  );
}
