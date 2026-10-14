// DER MANTEL-SOCKET (06.09.2026, Auftrag macplan) -- der Kanal, ueber den die
// Mac-native Oberflaeche („Mantel") diesen Hauptprozess als Kern benutzt.
//
// WARUM EIN ZWEITER SOCKET UND NICHT DER STEUERKANAL (control.ts). Der
// Steuerkanal ist per Bauart der Weg eines SKRIPTS in das laufende Programm:
// `type` und `key` fragen vor jedem Tastendruck `wb-pane-write darf`
// (steuerkanalDarfSchreiben in main.ts), damit kein Skript und kein Agent in
// einen Orchestrator-Pane tippt. Der Mantel ist das Gegenteil: er IST das
// Fenster, in dem der Mensch tippt -- derselbe Weg wie `awb:input` aus dem
// Electron-Renderer, der ohne Rueckfrage laeuft, weil dort ein Mensch sitzt
// (Regel 1 in wb-pane-write). Liefe der Mantel ueber den Steuerkanal, muesste
// entweder jeder Tastendruck des Menschen durch einen Unterprozess (0,16 s,
// gemessen 16.08.) und wuerde im Orchestrator-Pane abgelehnt, oder der
// Steuerkanal bekaeme einen Weg, der die Pruefung umgeht -- und damit haette
// jedes Skript ihn auch. Ein eigener Socket haelt beides auseinander: der
// Steuerkanal bleibt das gepruefte Werkzeug, der Mantel-Socket ist die
// Oberflaeche.
//
// WAS DIESER SOCKET IST: die Bruecke aus preload.ts, als JSON ueber eine Leitung.
//   Kern  -> Mantel   {"ev":"<kanal>", ...nutzlast}       (= webContents.send)
//   Mantel -> Kern    {"cmd":"send","kanal":"awb:input","args":[...]}     (= ipcRenderer.send)
//   Mantel -> Kern    {"id":n,"cmd":"invoke","kanal":"awb:ein-daten","args":[...]}
//   Kern  -> Mantel   {"id":n,"ok":true,"value":...} | {"id":n,"ok":false,"error":"..."}
// Die Kanalnamen sind die 54 aus main.ts, unveraendert -- es gibt EINE Logik
// und zwei Oberflaechen, und die Kanalliste ist die Vertragsgrenze (mac/PROTOKOLL.md).
//
// EIN MANTEL ZUR ZEIT. Eine zweite Verbindung loest die erste ab (sie wird
// geschlossen): es gibt ein Fenster, und ein Neustart der App soll nicht an
// einer haengengebliebenen Leitung scheitern.
//
// HANDSCHLAG. Die erste Zeile muss {"cmd":"hallo","token":"..."} sein; ohne
// den Token aus AWB_MANTEL_TOKEN wird die Leitung sofort geschlossen. Was
// derselbe Benutzer auf derselben Maschine erreichen kann, entscheidet auch
// diese Datei nicht (siehe control.ts) -- der Token verhindert, dass ein
// Prozess, der zufaellig den Pfad kennt, unbemerkt zum Fenster wird. Der
// Socket ist 0600 wie jede andere Datei dieses Programms.
//
// DER SOCKET ENTSTEHT NUR AUF VERLANGEN (AWB_MANTEL_SOCKET). Ohne die
// Variable laeuft die Electron-Fassung unveraendert: kein Server, keine Datei.
//
// DER TOKEN IST KEIN MENSCHEN-NACHWEIS (13.10.2026, Auftrag wz-mantel). Er
// stand im Env jedes Agenten (ueber den tmux-Server), in `mantel.token` (0600,
// also fuer jeden Prozess desselben Benutzers lesbar) und bleibt per `ps -E`
// im Start-Env des Kerns sichtbar. Ein Agent mit Token konnte so
// `muster-entscheiden` mit `echt: true` schicken -- eine Menschenfreigabe.
// Deshalb fragt der Kern bei jeder Verbindung den Kernel, WER verbunden ist
// (LOCAL_PEERPID, `peerPid`), und `echt`/`bestaetigt` gelten nur, wenn das die
// App ist (`istApp`, in main.ts: der Elternprozess des Kerns, den
// Kernstart.swift startet). Was eine andere Verbindung noch senden darf (siehe
// unten, `fremdErlaubt`), verliert zusaetzlich jede Menschen-Markierung
// (`fremdeBedienungEntschaerfen`).
//
// EINE FREMDE VERBINDUNG TIPPT NICHT (14.10.2026, Auftrag wz-mantel2). Seit
// `mac/bin/starten` die App den Kern starten laesst, ist die App auf beiden
// Startwegen Elternprozess des Kerns. Eine fremde Verbindung hat damit keinen
// Bedienbedarf mehr, nur noch einen Beobachterbedarf (Suiten, die mitlesen).
// `awb:input` von dort war das verbotene send-keys ueber einen Umweg: ungeprueft
// in jeden Pane, auch in einen Orchestrator. Deshalb gilt fuer eine fremde
// Verbindung eine POSITIVLISTE (`fremdErlaubt`): nur lesende Kanaele und
// Bedienungen, die bloss die Ansicht aendern. Alles andere -- Tippen, Einfuegen,
// Senden an Chat oder Orchestrator, Sitzungen starten/fortsetzen/beenden,
// Befehle ausfuehren, Dateien schreiben, Freigaben -- wird abgelehnt und ohne
// Inhalt protokolliert. Eine Positivliste, damit ein neuer Kanal fuer Fremde
// zu ist, bis jemand ihn bewusst freigibt. Der Weg ueber `steuerkanalDarfSchreiben`
// (wb-pane-write darf) waere die Alternative; er hat keinen belegten Bedarf:
// Skripte tippen ueber den Steuerkanal (`awb-ctl type/key`), der genau diese
// Pruefung schon macht.
import { connect, createServer, Server, Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/** Wer am anderen Ende der Leitung sitzt. `app`: die Peer-PID ist die App. */
export interface MantelHerkunft {
  pid: number | null;
  app: boolean;
}

export interface MantelAnschluss {
  /** ipcRenderer.send: feuern und vergessen. */
  send(kanal: string, args: unknown[], herkunft: MantelHerkunft): void;
  /** ipcRenderer.invoke: eine Antwort. */
  invoke(kanal: string, args: unknown[], herkunft: MantelHerkunft): Promise<unknown>;
  /** Ein Mantel hat sich angemeldet -- Zeit, ihm den Anfangszustand zu schicken. */
  verbunden(): void;
  /** Ob diese PID die App ist. Ohne Angabe ist es keine Verbindung. */
  istApp?(pid: number): boolean;
  /** Eine fremde Verbindung hat eine Menschen-Markierung geschickt, die verworfen wurde. */
  fremd?(meldung: string): void;
}

/**
 * Die PID des Prozesses am anderen Ende einer Unix-Verbindung, vom Kernel
 * erfragt: LOCAL_PEERPID auf macOS, SO_PEERCRED auf Linux. Node hat dafuer
 * keine API, also erbt ein kurzer `/usr/bin/perl` den fd als stdin und ruft
 * getsockopt -- ohne natives Addon, ohne neue Abhaengigkeit (perl liegt auf
 * macOS und Linux im Grundsystem), gemessen 3 ms. Der fd wird als ZAHL
 * vererbt: mit dem Socket-Objekt in `stdio` verstummte die Leitung im Kern
 * (gemessen 13.10.). Jeder Fehler heisst `null`, und `null` ist nie die App.
 *
 * DER FD GEHT ALS fd 3, NICHT ALS stdin (14.10.2026, wz-mantel4). libuv
 * schaltet im Kind jeden geerbten fd 0..2 auf BLOCKIEREND, und O_NONBLOCK
 * haengt an der geteilten Dateibeschreibung: als stdin vererbt wurde der
 * Socket damit auch im Kern blockierend. Las die Gegenseite nicht, blieb das
 * naechste `write` bei vollem Kernelpuffer im Kern stehen -- mit ihm die
 * ganze Ereignisschleife, also Steuerkanal (`ping`), awb-ctl und Hooks
 * (gemessen: ping nach 10 s ohne Antwort). fd 3 laesst libuv unangetastet;
 * perl setzt O_NONBLOCK trotzdem noch einmal, bevor es endet.
 */
export function peerPid(sock: Socket, fristMs = 2000, perl = '/usr/bin/perl'): Promise<number | null> {
  const fd = (sock as unknown as { _handle?: { fd?: number } })._handle?.fd;
  if (typeof fd !== 'number' || fd < 0) return Promise.resolve(null);
  const abfrage = process.platform === 'darwin'
    ? 'my $v = getsockopt($s, 0, 2); print defined $v ? unpack("i", $v) : ""'
    : process.platform === 'linux'
      ? 'my $v = getsockopt($s, 1, 17); print defined $v ? (unpack("iII", $v))[0] : ""'
      : '';
  if (!abfrage) return Promise.resolve(null);
  const skript = 'use Fcntl; open(my $s, "+<&=3") or exit 1; '
    + 'my $f = fcntl($s, F_GETFL, 0); fcntl($s, F_SETFL, $f | O_NONBLOCK) if defined $f; ' + abfrage;
  return new Promise((resolve) => {
    let aus = '';
    let fertig = false;
    const ende = (pid: number | null) => {
      if (fertig) return;
      fertig = true;
      clearTimeout(uhr);
      resolve(pid);
    };
    let kind: ReturnType<typeof spawn>;
    try {
      kind = spawn(perl, ['-e', skript], { stdio: ['ignore', 'pipe', 'ignore', fd], env: { PATH: '/usr/bin:/bin' } });
    } catch {
      resolve(null);
      return;
    }
    const uhr = setTimeout(() => { kind.kill('SIGKILL'); ende(null); }, fristMs);
    kind.stdout?.on('data', (d: Buffer) => { aus += d.toString('utf8'); });
    kind.on('error', () => ende(null));
    kind.on('close', (code) => {
      const pid = Number(aus.trim());
      ende(code === 0 && Number.isSafeInteger(pid) && pid > 0 ? pid : null);
    });
  });
}

/**
 * Die Menschen-Markierungen der Kanaele, die eine fremde Verbindung NICHT
 * setzen darf: Stelle des Arguments (ohne Ereignis), die `echt`,
 * `bestaetigt` oder eine Erlaubnis traegt. Objekte werden davon unabhaengig
 * durchsucht (`echt`/`bestaetigt` in jeder Tiefe, z. B. 'awb:bedienung' ->
 * `muster-entscheiden`, `sitzung-menue-punkt`, 'awb:aufgabe',
 * 'awb:sitzung-menue'). Wer einen Kanal mit einer neuen Stelle anlegt, traegt
 * ihn hier ein (main.ts, Registrierungen mit `echt`).
 */
export const MENSCHEN_STELLEN: Readonly<Record<string, readonly number[]>> = {
  'awb:welt-ordner': [0],
  'awb:ein-werkzeug': [1],
  'awb:sitz-neu': [3],
  'awb:sitz-neu-chat': [1],
  'awb:sitz-neu-wahl': [4],
  'awb:sitz-fortsetzen': [1],
  'awb:sitz-modell-wechsel': [3],
  'awb:sitz-beenden': [1, 2],
  'awb:mobil-koppeln': [0],
  'awb:mobil-widerrufen': [1],
  // Eine Rechte-Anfrage einer Chat-Sitzung erlauben ist eine Freigabe; seit 69444a4e
  // traegt Stelle 2 den echten Klick (`echt`).
  'awb:chat-freigabe': [1, 2],
};

/** Bedienungen, die eine fremde Verbindung gar nicht ausloesen darf (sie geben frei, ohne `echt` zu tragen). */
const FREMD_ABGELEHNT: ReadonlyArray<(kanal: string, args: unknown[]) => boolean> = [
  // Ein Antrag (wb-decide) wird ohne Menschen-Markierung erteilt; Ablehnen nimmt nichts weg.
  (kanal, args) => {
    const n = args[0] as { aktion?: unknown; wert?: { action?: unknown } } | undefined;
    return kanal === 'awb:bedienung' && n?.aktion === 'freigaben-entscheiden' && n?.wert?.action !== 'reject';
  },
];

/**
 * Was eine FREMDE Verbindung (nicht die App) ueberhaupt ausloesen darf: nur
 * lesende Kanaele und Bedienungen, die nichts ausserhalb ihrer eigenen
 * Antwort veraendern. Kein Eintrag schreibt in einen Pane, startet einen
 * Prozess, schreibt eine Datei oder verstellt, was der Mensch sieht.
 * Wer hier einen Kanal ergaenzt, prueft das an seiner Registrierung in main.ts.
 *
 * ENGER SEIT 14.10.2026 (wz-mantel4, Review mantel2 F4). Herausgenommen:
 * - der Editor (`awb:editor-read-file`, `-list-files`, `-watch`): die App
 *   laesst dort jede Wurzel zu, es gibt also keine Wurzelgrenze, die man fuer
 *   Fremde uebernehmen koennte; ueber den Mantel liest ein Agent damit jede
 *   Datei an den Pfad-Hooks seines Harness vorbei, und `-watch` ersetzt die
 *   Beobachtungsliste der App. Ein Bedarf eines Mitlesers ist nicht belegt
 *   (test-mac-chatstrom liest nur `awb:chat-daten`).
 * - `select` (startet bei Gast- und Fernsitzungen ssh), `show-pane`,
 *   `show-tab`, `flaeche` und `blatt-offen` (verstellen tmux-Lage, Zoom und
 *   Groesse auch fuer die anderen Clients des Menschen), die ui.json-Bedienungen
 *   und `plan-abbrechen` (verwirft einen offenen Plan des Menschen).
 * Wer als Skript eine Sitzung anhaengen muss, nimmt den Steuerkanal
 * (`awb-ctl select`); der prueft seine Aufrufer selbst.
 *
 * ENGER SEIT 14.10.2026 (wz-mantel5, Entscheidung WorkbenchOrchestrator zu
 * mantel4 OPEN 4): auch `ordner-liste` und `suche-lesen` sind fuer Fremde zu.
 * Beide lesen Verzeichnisse und Suchtreffer unter frei waehlbaren Pfaden, also
 * an den Pfad-Hooks eines Agenten vorbei. Gesendet werden sie nur von der App
 * selbst (KernVerbindung.swift `ordnerListe`/`suche`) und vom Electron-Renderer
 * (ordner-view.ts, IPC im Prozess, nicht ueber den Mantel); kein Mobilserver,
 * Companion, wb-Werkzeug und keine VS-Code-Erweiterung sendet sie.
 */
export const FREMD_KANAELE: ReadonlySet<string> = new Set([
  // Fenster meldet sich bereit (der Kern schickt daraufhin Daten).
  'awb:ready', 'awb:chat-bereit', 'awb:ein-bereit', 'awb:sitz-bereit', 'awb:verbrauch-bereit', 'awb:erststart-bereit',
  'awb:aufgaben-sichtbar', 'awb:rueckblick-fehlt',
  // Lesen.
  'awb:aufgaben-daten', 'awb:aktivitaet-read', 'awb:aktivitaet-diff',
  'awb:aktivitaet-auftrag', 'awb:protokolle-list', 'awb:protokolle-read', 'awb:chat-stand', 'awb:chat-pfade',
  'awb:ein-daten', 'awb:ein-texte', 'awb:kontext-stufen', 'awb:ein-schluessel-status', 'awb:sitz-daten', 'awb:sitz-texte',
  'awb:thema-daten', 'awb:verbrauch-daten', 'awb:verbrauch-texte', 'awb:sprache', 'awb:erststart-daten',
  'awb:erststart-texte', 'awb:sitz-wahl-daten', 'awb:chat-daten', 'awb:chat-dateien', 'awb:mobil-stand',
  'awb:bedienung', // nur mit einer Aktion aus FREMD_BEDIENUNGEN
]);

/** Die Aktionen von 'awb:bedienung', die eine fremde Verbindung senden darf: nur Lesen. */
export const FREMD_BEDIENUNGEN: ReadonlySet<string> = new Set([
  'aktivitaet-lesen', 'seite', 'seite-schliessen',
]);

/** Ob eine fremde Verbindung diesen Aufruf ausloesen darf (Positivliste). */
export function fremdErlaubt(kanal: string, args: unknown[]): boolean {
  if (!FREMD_KANAELE.has(kanal)) return false;
  if (kanal !== 'awb:bedienung') return true;
  const aktion = (args[0] as { aktion?: unknown } | undefined)?.aktion;
  return typeof aktion === 'string' && FREMD_BEDIENUNGEN.has(aktion);
}

/** Wie eine abgelehnte Bedienung im Protokoll heisst: Kanal und Aktion, nie Inhalt. */
function aufrufName(kanal: string, args: unknown[]): string {
  if (kanal !== 'awb:bedienung') return kanal;
  const aktion = (args[0] as { aktion?: unknown } | undefined)?.aktion;
  return `${kanal} (${typeof aktion === 'string' ? aktion.replace(/[^\w-]/g, '?').slice(0, 40) : '?'})`;
}

function markierungenLoeschen(wert: unknown, entzogen: string[], pfad: string): unknown {
  if (Array.isArray(wert)) return wert.map((w, i) => markierungenLoeschen(w, entzogen, `${pfad}[${i}]`));
  if (!wert || typeof wert !== 'object') return wert;
  const aus: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(wert as Record<string, unknown>)) {
    if ((k === 'echt' || k === 'bestaetigt') && v !== false && v !== undefined) {
      entzogen.push(`${pfad}.${k}`);
      aus[k] = false;
    } else {
      aus[k] = markierungenLoeschen(v, entzogen, `${pfad}.${k}`);
    }
  }
  return aus;
}

/**
 * Was von einer Nachricht einer FREMDEN Verbindung uebrig bleibt: jede
 * Menschen-Markierung auf false, und Bedienungen, die ohne Markierung
 * freigeben, abgelehnt. `entzogen` nennt, was verworfen wurde (fuer das
 * Protokoll); leer heisst: die Nachricht trug nichts davon.
 */
export function fremdeBedienungEntschaerfen(kanal: string, args: unknown[]): { args: unknown[]; entzogen: string[]; abgelehnt: boolean } {
  if (FREMD_ABGELEHNT.some((f) => f(kanal, args))) return { args, entzogen: [], abgelehnt: true };
  const entzogen: string[] = [];
  const stellen = MENSCHEN_STELLEN[kanal] ?? [];
  const aus = args.map((a, i) => {
    if (stellen.includes(i) && a !== false && a !== undefined && a !== null) {
      entzogen.push(`[${i}]`);
      return false;
    }
    return markierungenLoeschen(a, entzogen, `[${i}]`);
  });
  return { args: aus, entzogen, abgelehnt: false };
}

/**
 * Ob eine vorhandene Socket-Datei niemandem mehr gehoert. Nur ein abgewiesener
 * Verbindungsversuch (ECONNREFUSED) oder eine inzwischen fehlende Datei (ENOENT)
 * gilt als verwaist; eine Antwort, eine Zeitueberschreitung oder jeder andere
 * Fehler heisst: nicht anfassen.
 */
export function socketVerwaist(pfad: string, fristMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(pfad);
    const fertig = (verwaist: boolean) => {
      clearTimeout(uhr);
      sock.destroy();
      resolve(verwaist);
    };
    const uhr = setTimeout(() => fertig(false), fristMs);
    sock.once('connect', () => fertig(false));
    sock.once('error', (e: NodeJS.ErrnoException) => fertig(e.code === 'ECONNREFUSED' || e.code === 'ENOENT'));
  });
}

/**
 * RUECKSTAU (14.10.2026, wz-mantel4): wie viel ungelesen beim Kern liegen
 * darf, bevor er eine Verbindung trennt. `sock.write` blockiert nie (der
 * Socket ist nicht-blockierend, siehe `peerPid`), aber was die Gegenseite
 * nicht liest, sammelt Node ohne Grenze im Speicher des Kerns.
 *
 * Eine FREMDE Verbindung, die nicht liest, wird bei 1 MiB getrennt: sie darf
 * nur mitlesen, und wer mitliest, leert seinen Puffer in Millisekunden.
 *
 * Die APP wird bei 8 MiB laut gewarnt (kern.log) und bei 64 MiB getrennt,
 * nie still gedrosselt: verworfene Pushes (`awb:output`) hinterliessen ein
 * Terminal mit Luecken, das niemand bemerkt. Die Trennung dagegen heilt:
 * KernVerbindung.swift verbindet nach einer Sekunde neu, und `verbunden()`
 * schickt den vollen Stand samt neu gezeichneter Lage. Den Grund bekommt die
 * App gleich nach dem neuen Handschlag als `awb:meldung`.
 */
export const RUECKSTAU_FREMD_GRENZE = 1 << 20;
export const RUECKSTAU_APP_WARNUNG = 8 << 20;
export const RUECKSTAU_APP_GRENZE = 64 << 20;

function mib(bytes: number): string {
  return (bytes / (1 << 20)).toFixed(1);
}

export class MantelKanal {
  private server: Server | null = null;
  private client: Socket | null = null;
  private clientIstApp = false;
  private inode = 0;
  private readonly herkunftJe = new WeakMap<Socket, MantelHerkunft>();
  private appGewarnt = false;
  private rueckstauHinweis: string | null = null;
  private readonly nachpruefung = new WeakMap<Socket, Promise<void>>();

  /**
   * `pidFragen` ist die Peer-PID-Abfrage; Tests setzen eine eigene ein, die
   * etwa beim ersten Versuch scheitert.
   */
  constructor(
    private readonly pfad: string,
    private readonly token: string,
    private readonly anschluss: MantelAnschluss,
    private readonly pidFragen: (sock: Socket) => Promise<number | null> = (s) => peerPid(s),
  ) {}

  /** Ob gerade ein Mantel angemeldet ist (nach dem Handschlag). */
  get angemeldet(): boolean {
    return this.client !== null;
  }

  async listen(): Promise<void> {
    mkdirSync(dirname(this.pfad), { recursive: true });
    if (existsSync(this.pfad)) {
      if (!statSync(this.pfad).isSocket()) {
        throw new Error(`${this.pfad} ist kein Socket -- Pfad pruefen, hier wird nichts geloescht`);
      }
      // Der Kern haelt genau EINEN Mantel-Socket, und er wird beim Start gesetzt:
      // eine liegengebliebene Datei gehoert einem Kern, den es nicht mehr gibt.
      // ERST FRAGEN, DANN LOESCHEN (27.09.2026): ein Test-Kern mit geerbtem
      // AWB_MANTEL_SOCKET loeschte den Socket des laufenden Kerns. Antwortet dort
      // jemand, bleibt die Datei liegen; verwaist ist sie nur bei ECONNREFUSED/ENOENT.
      if (!(await socketVerwaist(this.pfad))) {
        throw new Error(`Mantel-Socket gehoert einem laufenden Kern: ${this.pfad} -- Test mit AWB_* aus der Live-Umgebung?`);
      }
      unlinkSync(this.pfad);
    }
    const server = createServer((sock) => this.bedienen(sock));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.pfad, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    chmodSync(this.pfad, 0o600);
    this.inode = statSync(this.pfad).ino;
  }

  /** webContents.send: ein Ereignis an den angemeldeten Mantel. Ohne Mantel verhallt es. */
  push(kanal: string, nutzlast: unknown): void {
    if (!this.client) return;
    this.schreiben(this.client, { ev: kanal, ...(nutzlast && typeof nutzlast === 'object' ? nutzlast as object : { wert: nutzlast }) });
  }

  private schreiben(sock: Socket, obj: unknown): void {
    if (sock.destroyed) return;
    const zeile = JSON.stringify(obj) + '\n';
    const istApp = sock === this.client && this.clientIstApp;
    const grenze = istApp ? RUECKSTAU_APP_GRENZE : RUECKSTAU_FREMD_GRENZE;
    if (sock.writableLength + zeile.length > grenze) {
      this.rueckstauTrennen(sock, istApp);
      return;
    }
    sock.write(zeile);
    if (istApp && !this.appGewarnt && sock.writableLength > RUECKSTAU_APP_WARNUNG) {
      this.appGewarnt = true;
      process.stderr.write(`Mantel: die App liest nicht mit (${mib(sock.writableLength)} MiB ungelesen, `
        + `Trennung bei ${mib(RUECKSTAU_APP_GRENZE)} MiB)\n`);
      sock.once('drain', () => {
        this.appGewarnt = false;
        process.stderr.write('Mantel: die App hat ihren Rueckstau gelesen\n');
      });
    }
  }

  /** Trennt eine Verbindung, die nicht liest. Ins Protokoll gehen Groesse und Herkunft, nie Inhalt. */
  private rueckstauTrennen(sock: Socket, istApp: boolean): void {
    const ungelesen = mib(sock.writableLength);
    sock.destroy();
    if (this.client === sock) this.client = null;
    const pid = this.herkunftJe.get(sock)?.pid ?? 'unbekannt';
    if (istApp) {
      this.appGewarnt = false;
      this.rueckstauHinweis = `Die Verbindung zum Kern wurde neu aufgebaut: die Oberflaeche hatte ${ungelesen} MiB nicht gelesen.`;
      process.stderr.write(`Mantel: die App (Peer-PID ${pid}) getrennt: ${ungelesen} MiB ungelesen, Grenze `
        + `${mib(RUECKSTAU_APP_GRENZE)} MiB -- sie verbindet neu und bekommt den vollen Stand\n`);
      return;
    }
    const meldung = `fremde Mantel-Verbindung (Peer-PID ${pid}) getrennt: liest nicht (${ungelesen} MiB ungelesen)`;
    process.stderr.write(`Mantel: ${meldung}\n`);
    this.anschluss.fremd?.(meldung);
  }

  private bedienen(sock: Socket): void {
    let buf = '';
    let begruesst = false;
    const decoder = new StringDecoder('utf8');
    // Bis der Kernel gesagt hat, wer verbunden ist, wird nichts gelesen: die
    // erste Zeile koennte schon eine Bedienung sein.
    const herkunft: MantelHerkunft = { pid: null, app: false };
    this.herkunftJe.set(sock, herkunft);
    sock.pause();
    void this.herkunftBestimmen(sock, herkunft).then(() => {
      if (!sock.destroyed) sock.resume();
    });
    sock.on('data', (chunk) => {
      buf += decoder.write(chunk);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const zeile = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!zeile.trim()) continue;
        if (!begruesst) {
          begruesst = this.handschlag(sock, zeile, herkunft);
          if (!begruesst) return;
          continue;
        }
        void this.zeile(sock, zeile, herkunft);
      }
    });
    sock.on('error', () => sock.destroy());
    sock.on('close', () => {
      if (this.client === sock) this.client = null;
    });
  }

  /**
   * FEHLT DIE PEER-PID, IST AUCH DIE APP FREMD (Review mantel2 F2, 14.10.2026):
   * fail-closed, aber die echte App koennte dann bis zur Neuverbindung nicht
   * tippen. Unter Last (Gesamtlauf) kann ein perl-Kind seine 2 s verfehlen.
   * Deshalb ein zweiter Versuch gleich hier und, wenn auch der scheitert, eine
   * einzige Nachpruefung vor der ersten Bedienung (`nachpruefen`). Hoechstens
   * drei Abfragen je Verbindung; bleibt die PID unbekannt, sagen kern.log und
   * eine `awb:meldung` an die Verbindung, warum sie nur lesen darf.
   */
  private async herkunftBestimmen(sock: Socket, herkunft: MantelHerkunft): Promise<void> {
    let pid = await this.pidFragen(sock);
    if (pid === null && !sock.destroyed) {
      process.stderr.write('Mantel: Peer-PID beim ersten Versuch nicht erfragt -- zweiter Versuch\n');
      pid = await this.pidFragen(sock);
    }
    herkunft.pid = pid;
    herkunft.app = pid !== null && this.anschluss.istApp?.(pid) === true;
  }

  private nachpruefen(sock: Socket, herkunft: MantelHerkunft): Promise<void> {
    let laeuft = this.nachpruefung.get(sock);
    if (!laeuft) {
      laeuft = (async () => {
        const pid = await this.pidFragen(sock);
        if (pid === null) {
          process.stderr.write('Mantel: Peer-PID auch bei der Nachpruefung unbekannt -- die Verbindung bleibt fremd, bis sie neu verbindet\n');
          return;
        }
        herkunft.pid = pid;
        herkunft.app = this.anschluss.istApp?.(pid) === true;
        if (herkunft.app && this.client === sock) this.clientIstApp = true;
        process.stderr.write(`Mantel: Peer-PID nachgeprueft: ${pid}, ${herkunft.app ? 'die App' : 'FREMD'}\n`);
      })();
      this.nachpruefung.set(sock, laeuft);
    }
    return laeuft;
  }

  private handschlag(sock: Socket, zeile: string, herkunft: MantelHerkunft): boolean {
    let req: { cmd?: unknown; token?: unknown } = {};
    try {
      req = JSON.parse(zeile) as typeof req;
    } catch {
      // unlesbar -- unten abgewiesen
    }
    if (req.cmd !== 'hallo' || (this.token && req.token !== this.token)) {
      this.schreiben(sock, { ok: false, error: 'Handschlag abgelehnt' });
      sock.destroy();
      return false;
    }
    // Der Neue loest den Alten ab -- aber eine fremde Verbindung nie die App
    // (13.10.2026): sonst nahm ein Prozess mit Token dem Menschen das Fenster
    // und bekam jedes Ereignis des Kerns (Pane-Inhalte) zugestellt.
    if (this.client && this.client !== sock && this.clientIstApp && !herkunft.app) {
      this.schreiben(sock, { ok: false, error: 'Mantel belegt: die App ist verbunden' });
      process.stderr.write(`Mantel: fremde Verbindung (Peer-PID ${herkunft.pid ?? 'unbekannt'}) abgewiesen, die App ist verbunden\n`);
      sock.destroy();
      return false;
    }
    if (this.client && this.client !== sock) this.client.destroy();
    this.client = sock;
    this.clientIstApp = herkunft.app;
    this.appGewarnt = false;
    this.schreiben(sock, { ok: true, ev: 'hallo', pid: process.pid, app: herkunft.app });
    if (herkunft.pid === null) {
      process.stderr.write('Mantel: Peer-PID unbekannt -- die Verbindung gilt als fremd (nur lesen); vor der ersten Bedienung wird noch einmal gefragt\n');
      this.schreiben(sock, { ev: 'awb:meldung', text: 'Der Kern konnte diese Oberflaeche nicht als die App erkennen. Bis zur Neuverbindung ist nur Lesen moeglich.', dauerMs: 10000 });
    }
    if (herkunft.app && this.rueckstauHinweis) {
      this.schreiben(sock, { ev: 'awb:meldung', text: this.rueckstauHinweis, dauerMs: 10000 });
      this.rueckstauHinweis = null;
    }
    process.stderr.write(`Mantel verbunden: Peer-PID ${herkunft.pid ?? 'unbekannt'}, ${herkunft.app ? 'die App' : 'FREMD (echt/bestaetigt werden verworfen)'}\n`);
    this.anschluss.verbunden();
    return true;
  }

  private async zeile(sock: Socket, zeile: string, herkunft: MantelHerkunft): Promise<void> {
    let req: { id?: unknown; cmd?: unknown; kanal?: unknown; args?: unknown };
    try {
      req = JSON.parse(zeile) as typeof req;
    } catch {
      this.schreiben(sock, { ok: false, error: `unlesbare Zeile: ${zeile.slice(0, 80)}` });
      return;
    }
    const kanal = String(req.kanal ?? '');
    let args = Array.isArray(req.args) ? req.args : [];
    if (!herkunft.app && herkunft.pid === null && (req.cmd === 'send' || req.cmd === 'invoke')) {
      await this.nachpruefen(sock, herkunft);
    }
    if (!herkunft.app && (req.cmd === 'send' || req.cmd === 'invoke') && !fremdErlaubt(kanal, args)) {
      // Kein Inhalt ins Protokoll (Tastendruecke, Text): nur Kanal und Aktion.
      const name = aufrufName(kanal.replace(/[^\w:-]/g, '?').slice(0, 60), args);
      const meldung = `fremde Mantel-Verbindung (Peer-PID ${herkunft.pid ?? 'unbekannt'}): ${name} abgelehnt (nur die App darf bedienen)`;
      process.stderr.write(`Mantel: ${meldung}\n`);
      this.anschluss.fremd?.(meldung);
      this.schreiben(sock, { id: req.id ?? null, ok: false, kanal, error: 'von einer fremden Verbindung abgelehnt' });
      return;
    }
    if (!herkunft.app && (req.cmd === 'send' || req.cmd === 'invoke')) {
      const e = fremdeBedienungEntschaerfen(kanal, args);
      if (e.abgelehnt || e.entzogen.length) {
        const meldung = `fremde Mantel-Verbindung (Peer-PID ${herkunft.pid ?? 'unbekannt'}): ${kanal} `
          + (e.abgelehnt ? 'abgelehnt (gibt ohne Menschen-Nachweis frei)' : `ohne Menschen-Markierung (${e.entzogen.join(', ')})`);
        process.stderr.write(`Mantel: ${meldung}\n`);
        this.anschluss.fremd?.(meldung);
      }
      if (e.abgelehnt) {
        this.schreiben(sock, { id: req.id ?? null, ok: false, kanal, error: 'von einer fremden Verbindung abgelehnt' });
        return;
      }
      args = e.args;
    }
    if (req.cmd === 'send') {
      try {
        this.anschluss.send(kanal, args, herkunft);
      } catch (e) {
        this.schreiben(sock, { ok: false, kanal, error: (e as Error).message });
      }
      return;
    }
    if (req.cmd === 'invoke') {
      try {
        const value = await this.anschluss.invoke(kanal, args, herkunft);
        this.schreiben(sock, { id: req.id ?? null, ok: true, value: value === undefined ? null : value });
      } catch (e) {
        this.schreiben(sock, { id: req.id ?? null, ok: false, error: (e as Error).message });
      }
      return;
    }
    if (req.cmd === 'ping') {
      this.schreiben(sock, { id: req.id ?? null, ok: true, value: { pid: process.pid } });
      return;
    }
    this.schreiben(sock, { id: req.id ?? null, ok: false, error: `unbekannter Befehl ${String(req.cmd)}` });
  }

  async close(): Promise<void> {
    this.client?.destroy();
    this.client = null;
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
    try {
      if (this.inode && statSync(this.pfad).ino !== this.inode) return;
      unlinkSync(this.pfad);
    } catch {
      // schon weg
    }
  }
}
