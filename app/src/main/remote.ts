// Der Stand einer FERNEN Maschine (V10): dieselben Sessions, dieselbe Farbe,
// nur ueber SSH statt ueber lokales tmux geholt. Ein Aufruf je Takt bringt
// alles mit, was gebraucht wird -- Sessionliste, Panes, Prozesstabelle, jede
// Zustandsdatei -- damit ein Poll nicht in vier SSH-Verbindungen zerfaellt.
//
// GRUND FUER DEN EIGENEN TAKT: `readSessions()` laeuft alle zwei Sekunden
// SYNCHRON im Hauptprozess (main.ts) -- ein blockierender SSH-Aufruf darin
// wuerde das ganze Fenster fuer die Dauer der Verbindung einfrieren, auch den
// Terminal-Pane, den dieser Auftrag ausdruecklich nicht anfassen soll. Der
// `RemotePoller` laeuft deshalb ASYNCHRON auf einem eigenen, langsameren Takt
// und haelt nur den JEWEILS LETZTEN Stand vor; `readSessions()` liest diesen
// Stand synchron und ohne eigenes I/O.
//
// F6: antwortet eine Maschine nicht, verliert sie ihre Sessions NICHT aus der
// Liste -- der letzte bekannte Stand bleibt, nur `reachable` kippt auf false.
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { PaneRow, ProcRow } from './sessions';
import {
  parsePaneRows, parseProcTable, parseSessionList, trennzeichenFehlt,
  PANE_LIST_FORMAT, SESSION_LIST_FORMAT,
} from './sessions';
import { MASCHINEN_LOCALE_PREFIX } from './pfad';

export interface RemoteWorkerRaw {
  name: string;
  kind: string;
  model: string;
  dir: string;
  claudeSessionId: string;
}

export interface RemoteSessionRaw {
  /** Dateiname ohne `.json` -- Grundlage der Session-Kennung (`<maschine>:<fileBase>`). */
  fileBase: string;
  dir: string;
  tmuxSession: string;
  name: string;
  sessionKey: string;
  claudeSessionId: string;
  lastActive: string;
  /** Harness und Modell der fernen Session -- dieselben Felder wie lokal. */
  harness: string;
  model: string;
  workers: RemoteWorkerRaw[];
}

export interface RemoteSnapshot {
  /** SSH-Ziel und Anzeigename zugleich (siehe config.ts: der Maschinenname IST der SSH-Alias). */
  machine: string;
  /** Hat der LETZTE Abruf geantwortet? Der Stand darunter kann trotzdem aelter sein. */
  reachable: boolean;
  fetchedAt: number;
  /** Leer, wenn der letzte Abruf glatt lief -- sonst der Grund, fuers Debuggen. */
  error: string;
  /**
   * Warum die ANTWORT nicht zu gebrauchen war, obwohl der Abruf durchlief --
   * leer, solange sie zu gebrauchen ist (07.08.). Das ist etwas anderes als
   * `error`: dort steht, warum die Maschine nicht geantwortet hat, hier steht,
   * dass sie geantwortet hat und wir mit der Antwort nichts anfangen konnten.
   * Zwei verschiedene Auskuenfte fuer den Menschen, und die falsche schickt ihn
   * auf die Suche nach einem Netzproblem, das es nicht gibt.
   */
  formatFehler: string;
  sessionFiles: RemoteSessionRaw[];
  lebende: Map<string, boolean>;
  eigene: Map<string, boolean>;
  panes: PaneRow[];
  procTable: Map<number, ProcRow>;
  /** Roh-Inhalt der beiden Statusdateien (V12) -- leer, wenn sie dort fehlen. */
  testsuiteRaw: string;
  hygieneRaw: string;
  /**
   * Der Stand des Repos DIESER Maschine, wie das Fernskript ihn eben gemessen
   * hat (21.08.) -- `head_commit`/`head_commit_ts`/`head_ahead` als key=value.
   * Leer, wenn drueben kein Baum steht oder die Statusdatei noch nicht sagt,
   * wo er liegt; ampel.ts faellt dann auf ihr bisheriges Verhalten zurueck.
   */
  repoRaw: string;
}

const SECTION_MARK = 'SECTION:';
const FILE_MARK = 'FILE:';

function leererStand(machine: string, error: string, vorheriger?: RemoteSnapshot): RemoteSnapshot {
  return {
    machine,
    reachable: false,
    fetchedAt: Date.now(),
    error,
    // Ein Abruf, der gar nicht durchkam, hat keine unbrauchbare Antwort --
    // er hat keine. Der letzte bekannte Stand wird darunter weitergetragen.
    formatFehler: '',
    sessionFiles: vorheriger?.sessionFiles ?? [],
    lebende: vorheriger?.lebende ?? new Map(),
    eigene: vorheriger?.eigene ?? new Map(),
    panes: vorheriger?.panes ?? [],
    procTable: vorheriger?.procTable ?? new Map(),
    testsuiteRaw: vorheriger?.testsuiteRaw ?? '',
    hygieneRaw: vorheriger?.hygieneRaw ?? '',
    repoRaw: vorheriger?.repoRaw ?? '',
  };
}

/**
 * Das Fernskript: eine feste, ohne lokale Werte zusammengesetzte Zeichenkette
 * -- nichts wird hineininterpoliert, also gibt es an dieser Stelle nichts
 * zu quoten und nichts einzuschleusen. `$HOME` und `$D` loest die REMOTE
 * Shell auf, nicht dieser Prozess.
 */
export function fernSkript(relSessionsDir: string, relTestsuiteStatus: string, relHygieneStatus: string): string {
  return [
    'set -u',
    `D="$HOME/${relSessionsDir}"`,
    `printf '${SECTION_MARK}SESSIONS\\1\\n'`,
    // Die Kodierung steht VOR dem Befehl, nicht in unserer Umgebung: dieses
    // tmux laeuft auf der ANDEREN Maschine, in der Umgebung der SSH-Sitzung.
    // Ohne UTF-8-Zeichenklasse gibt es den Tabulator seiner Formatzeile als
    // Unterstrich aus, und die Fernliste zerfaellt genauso still wie die
    // hiesige (Messung im Kopf von pfad.ts).
    `${MASCHINEN_LOCALE_PREFIX} tmux list-sessions -F '${SESSION_LIST_FORMAT}' 2>/dev/null`,
    `printf '${SECTION_MARK}PANES\\1\\n'`,
    `${MASCHINEN_LOCALE_PREFIX} tmux list-panes -a -F '${PANE_LIST_FORMAT}' 2>/dev/null`,
    `printf '${SECTION_MARK}PS\\1\\n'`,
    'ps -axo pid=,ppid=,pcpu=,etime=,args= 2>/dev/null || ps -eo pid=,ppid=,pcpu=,etime=,args= 2>/dev/null',
    `printf '${SECTION_MARK}FILES\\1\\n'`,
    'if [ -d "$D" ]; then',
    '  for f in "$D"/*.json; do',
    '    [ -f "$f" ] || continue',
    `    printf '${FILE_MARK}%s\\1\\n' "$(basename "$f")"`,
    '    cat "$f"',
    "    printf '\\n'",
    '  done',
    'fi',
    // V12+ (21.08.): DER STAND DER ANDEREN MASCHINE. Ohne ihn laesst sich der
    // Vergleich "ist dieser Befund aelter als der Code, den er geprueft hat?"
    // fuer eine Fernmaschine gar nicht fuehren -- und ihn mit dem Stand des
    // MACS zu fuehren waere schlimmer als die alte Anzeige: zwei Zahlen von
    // zwei verschiedenen Baeumen ergeben eine Aussage ueber keinen von beiden.
    //
    // Wo der Baum liegt, sagt die Statusdatei drueben SELBST (`repo_dir`, von
    // wb-testsuite-run geschrieben) -- kein geratener Pfad, und auf peer ein
    // anderer als hier. Fehlt das Feld (aeltere Statusdatei), fehlt der Baum
    // oder fehlt git, bleibt der Abschnitt LEER und die Ampel faellt auf ihr
    // bisheriges Verhalten zurueck. `head_ahead` zaehlt gegen den geprueften
    // Commit und bleibt leer, wenn der drueben nicht mehr aufloesbar ist.
    //
    // DIESER ABSCHNITT STEHT VOR DEN BEIDEN `cat`-ZEILEN, nicht hinter ihnen --
    // aus dem Grund, der gleich darunter steht: die letzte Zeile bestimmt den
    // Rueckgabewert des ganzen ssh-Aufrufs, und ein `git`, das mit 1 endet,
    // haette an letzter Stelle dieselbe Wirkung gehabt wie das fehlende
    // `|| true` am 10.08. -- die ganze Maschine als unerreichbar gefuehrt.
    `printf '${SECTION_MARK}REPO\\1\\n'`,
    `R="$(sed -n 's/^repo_dir=//p' "$HOME/${relTestsuiteStatus}" 2>/dev/null | tail -1)"`,
    `GEPRUEFT="$(sed -n 's/^repo_commit=//p' "$HOME/${relTestsuiteStatus}" 2>/dev/null | tail -1)"`,
    'if [ -n "$R" ] && [ -d "$R" ] && command -v git >/dev/null 2>&1; then',
    `  printf 'head_commit=%s\\n' "$(git --no-optional-locks -C "$R" rev-parse HEAD 2>/dev/null)"`,
    `  printf 'head_commit_ts=%s\\n' "$(git --no-optional-locks -C "$R" log -1 --format=%ct 2>/dev/null)"`,
    '  if [ -n "$GEPRUEFT" ]; then',
    `    printf 'head_ahead=%s\\n' "$(git --no-optional-locks -C "$R" rev-list --count "$GEPRUEFT..HEAD" 2>/dev/null)"`,
    '  fi',
    'fi',
    // V12: dieselben zwei Statusdateien, die die SessionStart-Hooks auf der
    // Fernmaschine schon lesen -- hier nur mitgebracht, nicht neu bewertet
    // (die Bewertung sitzt in ampel.ts, EINE Stelle fuer beide Maschinen).
    //
    // `|| true` HINTER BEIDEN (10.08.). Fehlt eine der Dateien drueben, endet
    // `cat` mit 1, und weil dies die LETZTE Zeile des Skripts ist, ist das der
    // Rueckgabewert des ganzen Aufrufs. `pollOne` liest daraus „ssh beendet mit
    // Code 1", verwirft die vollstaendige Antwort und fuehrt die GANZE Maschine
    // als nicht erreichbar -- keine ihrer Sitzungen steht dann in der Leiste.
    // Gemessen am echten `fernSkript` gegen ein eigenes HOME: ohne beide Dateien
    // rc=1, mit beiden rc=0, und fehlt nur die HYGIENE-Datei rc=1 (fehlt nur die
    // Testsuite-Datei, bleibt es bei 0 -- der Rueckgabewert haengt allein an der
    // letzten Zeile). Auf peer gibt es beide, der Fall trifft also gerade
    // niemanden; er trifft jede Maschine, die neu dazukommt, bevor ihre Hooks
    // einmal gelaufen sind. Eine fehlende Statusdatei ist eine LUECKE IN DER
    // AMPEL, kein Ausfall der Maschine, und genau so wird sie behandelt: der
    // Abschnitt bleibt leer, alles andere kommt an.
    `printf '${SECTION_MARK}TESTSUITE\\1\\n'`,
    `cat "$HOME/${relTestsuiteStatus}" 2>/dev/null || true`,
    `printf '${SECTION_MARK}HYGIENE\\1\\n'`,
    `cat "$HOME/${relHygieneStatus}" 2>/dev/null || true`,
    '',
  ].join('\n');
}

function abschnitte(raw: string): Record<string, string> {
  const teile = raw.split(new RegExp(`${SECTION_MARK}(\\w+)\\u0001\\n`));
  const out: Record<string, string> = {};
  for (let i = 1; i < teile.length; i += 2) out[teile[i]] = teile[i + 1] ?? '';
  return out;
}

function dateiTeile(raw: string): { name: string; inhalt: string }[] {
  const teile = raw.split(new RegExp(`${FILE_MARK}([^\\u0001\\n]+)\\u0001\\n`));
  const out: { name: string; inhalt: string }[] = [];
  for (let i = 1; i < teile.length; i += 2) out.push({ name: teile[i], inhalt: teile[i + 1] ?? '' });
  return out;
}

/**
 * Roh-Text des Fernskripts -> RemoteSnapshot. Reine Funktion, eigens getestet
 * (siehe test-app-maschinen.sh) unabhaengig vom SSH-Aufruf drumherum.
 */
export function parseFernAusgabe(machine: string, raw: string): RemoteSnapshot {
  const sec = abschnitte(raw);
  // DIESELBE ZWEITE SICHERUNG WIE LOKAL (sessions.ts, `trennzeichenFehlt`).
  // Der Fernweg zerlegt dieselben zwei Formate an denselben Tabulatoren, und
  // der Praefix im Fernskript schuetzt ihn nur, solange die andere Maschine
  // `C.UTF-8` kennt. Kennt sie ihn nicht, weist tmux den Namen NICHT zurueck,
  // sondern arbeitet ohne UTF-8-Zeichenklasse weiter (gemessen: `rc=0`, und der
  // Tabulator ist ein Unterstrich). Ohne diese Pruefung stuende in `lebende`
  // ein einziger Schluessel mit angehaengtem Unterstrich, `alive` waere fuer
  // JEDE Fernsitzung falsch, und daraus wuerde 'stopped' -- wortwoertlich das
  // Symptom vom 07.08., nur eine Maschine weiter.
  //
  // Auf Peer selbst nachgemessen (07.08., von hier aus ueber ssh): `locale -a`
  // fuehrt dort `C.utf8` und KEIN `C.UTF-8` -- der Praefix wirkt trotzdem, weil
  // glibc den Namen normalisiert (mit Praefix ein Tabulator, ohne ihn ein
  // Unterstrich, beides gegen einen eigenen tmux-Socket). Der Fernweg war also
  // wirklich offen, und die Schreibweise im Praefix ist die richtige. Aus
  // `locale -a` allein liesse sich beides nicht schliessen; deshalb steht hier
  // die Messung und nicht die Paketliste.
  const rohSessions = sec.SESSIONS ?? '';
  const kaputt = trennzeichenFehlt(rohSessions, SESSION_LIST_FORMAT);
  const { lebende, eigene } = parseSessionList(kaputt ? '' : rohSessions);
  const panes = kaputt ? [] : parsePaneRows(sec.PANES ?? '');
  const procTable = parseProcTable(sec.PS ?? '');
  const sessionFiles: RemoteSessionRaw[] = [];
  for (const { name, inhalt } of dateiTeile(sec.FILES ?? '')) {
    if (!name.endsWith('.json')) continue;
    let roh: Record<string, unknown>;
    try {
      roh = JSON.parse(inhalt) as Record<string, unknown>;
    } catch {
      continue;
    }
    const rohWorker = Array.isArray(roh.workers) ? (roh.workers as Record<string, unknown>[]) : [];
    sessionFiles.push({
      fileBase: name.slice(0, -'.json'.length),
      dir: String(roh.dir ?? ''),
      tmuxSession: String(roh.tmuxSession ?? ''),
      name: String(roh.name ?? name.slice(0, -'.json'.length)),
      sessionKey: String(roh.sessionKey ?? ''),
      claudeSessionId: String(roh.claudeSessionId ?? ''),
      lastActive: String(roh.lastActive ?? ''),
      harness: String(roh.harness ?? ''),
      model: String(roh.model ?? ''),
      workers: rohWorker.map((w) => ({
        name: String(w.name ?? ''),
        kind: String(w.kind ?? ''),
        model: String(w.model ?? ''),
        dir: String(w.dir ?? ''),
        claudeSessionId: String(w.claudeSessionId ?? ''),
      })),
    });
  }
  return {
    machine,
    // NICHT EINSEHBAR, NICHT BEENDET. Eine unzerlegbare Antwort erklaert die
    // Maschine als Ganzes fuer nicht einsehbar -- genau wie lokal ein nicht
    // ausfuehrbares tmux. Das ist die vorsichtige Richtung: der letzte bekannte
    // Stand bleibt in der Liste stehen (F6), die Sitzungen heissen
    // 'unreachable' statt 'stopped', und der Fortsetzen-Knopf bleibt zu, statt
    // gegen eine womoeglich laufende Sitzung angeboten zu werden.
    reachable: !kaputt,
    fetchedAt: Date.now(),
    error: '',
    formatFehler: kaputt
      ? `Die Maschine '${machine}' hat geantwortet, aber ohne das Trennzeichen des Formats -- `
        + 'ihre Sitzungsliste laesst sich nicht zerlegen. Solange das so ist, sagt dieses '
        + 'Fenster ueber keine ihrer Sitzungen, ob sie laeuft.'
      : '',
    sessionFiles,
    lebende,
    eigene,
    panes,
    procTable,
    testsuiteRaw: sec.TESTSUITE ?? '',
    hygieneRaw: sec.HYGIENE ?? '',
    repoRaw: sec.REPO ?? '',
  };
}

export interface RemotePollerOptions {
  /** SSH-Ziele -- der Maschinenname IST der Alias (siehe config.ts). Leer = kein Polling. */
  hosts: string[];
  /** Wie oft neu abgerufen wird. Bewusst deutlich langsamer als der lokale 2s-Takt. */
  intervalMs: number;
  /** Ab wann ein einzelner Abruf als haengend gilt und abgebrochen wird. */
  timeoutMs: number;
  /** Sessions-Verzeichnis relativ zu `$HOME` der Fernmaschine. */
  relSessionsDir: string;
  /** V12: die zwei Statusdateien, relativ zu `$HOME` der Fernmaschine. */
  relTestsuiteStatus: string;
  relHygieneStatus: string;
  /** Testhaken: ein anderes Programm statt `ssh` anspringen. */
  sshBin?: string;
}

/**
 * Haelt je konfigurierter Maschine den zuletzt abgerufenen Stand vor und holt
 * ihn im Hintergrund nach, NIE blockierend fuer den Aufrufer. `snapshots()`
 * liefert sofort, was gerade da ist -- auch nichts, beim allerersten Tick.
 */
export class RemotePoller {
  private readonly cache = new Map<string, RemoteSnapshot>();
  private timer: NodeJS.Timeout | null = null;
  private laufend = new Set<string>();
  /**
   * Fehlversuche in Folge je Maschine. Ein EINZELNER Fehlschlag faerbt noch
   * nichts um: er passiert im Alltag (eine kurz gesaettigte Verbindung, ein
   * beschaeftigter Rechner), und er faerbte am 05.08. sechs Eintraege in der
   * Leiste blau und beim naechsten Takt wieder zurueck. Fuer den Menschen
   * davor ist ein Flackern kein Zustand, sondern Rauschen. Erst der ZWEITE
   * Fehlschlag in Folge meldet die Maschine als nicht erreichbar -- das
   * kostet einen Takt Verzoegerung und nimmt dem Bild das Zittern.
   */
  private fehlversuche = new Map<string, number>();
  /** Ab wie vielen Fehlversuchen in Folge eine Maschine als weg gilt. */
  private static readonly AUSFALL_AB = 2;

  /**
   * Die Maschinenliste ist NICHT mehr die des Programmstarts.
   *
   * Sie stand bis zum 06.08. in `opt.hosts` und damit fest, obwohl das
   * Einstellungsmenue sie mit dem Etikett "sofort" anbietet -- wer eine
   * Maschine eintrug, sah sie erst nach einem Neustart. Jetzt haelt der Poller
   * seine eigene Liste, und `hostsSetzen` zieht sie im Takt nach.
   */
  private hosts: string[];

  constructor(private readonly opt: RemotePollerOptions) {
    this.hosts = [...opt.hosts];
  }

  /** Die aktuelle Liste -- fuer die Auskunft, damit eine Aenderung messbar ist. */
  hostliste(): string[] {
    return [...this.hosts];
  }

  /**
   * Eine neue Liste uebernehmen. Was wegfaellt, verliert auch seinen gemerkten
   * Stand: eine Maschine, die nicht mehr in der Liste steht, darf in der
   * Sessionleiste nicht als letzter bekannter Zustand weiterleben. Kommt die
   * erste Maschine dazu, faengt der Takt an; faellt die letzte weg, hoert er auf.
   */
  hostsSetzen(neu: string[]): void {
    const sauber = neu.map((h) => h.trim()).filter(Boolean);
    if (sauber.length === this.hosts.length && sauber.every((h, i) => h === this.hosts[i])) return;
    for (const alt of this.hosts) {
      if (sauber.includes(alt)) continue;
      this.cache.delete(alt);
      this.fehlversuche.delete(alt);
    }
    this.hosts = sauber;
    if (!sauber.length) {
      this.stop();
      return;
    }
    if (!this.timer) this.start();
    else this.tick();
  }

  start(): void {
    if (this.timer || !this.hosts.length) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.opt.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshots(): RemoteSnapshot[] {
    return this.hosts.map((h) => this.cache.get(h)).filter((s): s is RemoteSnapshot => !!s);
  }

  private tick(): void {
    for (const host of this.hosts) {
      if (this.laufend.has(host)) continue; // ein Abruf pro Maschine gleichzeitig -- kein Stau bei langsamer Leitung
      this.laufend.add(host);
      this.pollOne(host).finally(() => this.laufend.delete(host));
    }
  }

  /**
   * Ein Abruf ist fehlgeschlagen. Bis zur Schwelle bleibt der letzte Stand
   * stehen, INKLUSIVE `reachable: true` -- die Maschine war ja eben noch da,
   * und ein einzelner Aussetzer ist keine Auskunft. Der Grund wird trotzdem
   * mitgeschrieben, damit er zum Nachsehen da ist.
   */
  private fehlschlag(host: string, grund: string): void {
    const n = (this.fehlversuche.get(host) ?? 0) + 1;
    this.fehlversuche.set(host, n);
    const vorher = this.cache.get(host);
    if (n < RemotePoller.AUSFALL_AB && vorher?.reachable) {
      this.cache.set(host, { ...vorher, error: `${grund} (1. Fehlversuch, noch als erreichbar gefuehrt)` });
      return;
    }
    this.cache.set(host, leererStand(host, grund, vorher));
  }

  private pollOne(host: string): Promise<void> {
    return new Promise((resolve) => {
      const kind = spawn(
        this.opt.sshBin ?? 'ssh',
        ['-o', 'ConnectTimeout=4', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', host, 'bash', '-s'],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let out = '';
      let fertig = false;
      const beenden = (grund: string) => {
        if (fertig) return;
        fertig = true;
        clearTimeout(uhr);
        this.fehlschlag(host, grund);
        resolve();
      };
      const uhr = setTimeout(() => {
        kind.kill('SIGKILL');
        beenden('Zeitueberschreitung');
      }, this.opt.timeoutMs);
      // Ein Zeichen darf an einer Chunk-Grenze nicht zerbrechen. Die Antwort
      // ist rund 80 KB und kommt in zwoelf bis sechzehn Stuecken (gemessen
      // 05.08.), darin gut hundert Mehrbyte-Zeichen. Wird jedes Stueck fuer
      // sich uebersetzt, wird aus einem Zeichen, das genau auf der Grenze
      // liegt, ein Ersatzzeichen -- und wenn das eine Zustandsdatei trifft,
      // scheitert `JSON.parse`, der Abruf gilt als fehlgeschlagen und die
      // ganze Maschine erscheint als nicht erreichbar. Dieselbe Falle steckte
      // heute schon in `awb-ctl` und im Steuerkanal; das ist die dritte
      // Stelle. `StringDecoder` haelt eine angefangene Folge bis zum
      // naechsten Stueck fest.
      const decoder = new StringDecoder('utf8');
      kind.stdout.on('data', (d: Buffer) => {
        out += decoder.write(d);
      });
      kind.on('error', (e) => beenden(e.message));
      kind.on('close', (code) => {
        if (fertig) return;
        fertig = true;
        clearTimeout(uhr);
        if (code !== 0) {
          this.fehlschlag(host, `ssh beendet mit Code ${code}`);
          resolve();
          return;
        }
        try {
          this.cache.set(host, parseFernAusgabe(host, out));
          this.fehlversuche.delete(host);
        } catch (e) {
          this.fehlschlag(host, (e as Error).message);
        }
        resolve();
      });
      // DER SCHREIBWEG BRAUCHT SEIN OHR (Befund 6 der Bugjagd, 15.08.). Stirbt
      // das ssh zwischen Spawn und Write -- ein sofort abgewiesener Host
      // genuegt --, faellt der Fehler ASYNCHRON an und waere ohne diesen
      // Listener eine unbehandelte Ausnahme im Hauptprozess. Ein misslungener
      // Abruf ist ein Fehlversuch, kein Grund, das Fenster mitzunehmen.
      kind.stdin.on('error', (e: NodeJS.ErrnoException) => beenden(`Das Skript liess sich nicht schicken (${e.code ?? e.message})`));
      kind.stdin.write(fernSkript(this.opt.relSessionsDir, this.opt.relTestsuiteStatus, this.opt.relHygieneStatus));
      kind.stdin.end();
    });
  }
}
