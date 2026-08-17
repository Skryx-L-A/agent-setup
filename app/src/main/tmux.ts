// tmux-Steuermodus (`tmux -C`). Das ist die Bruecke, die wir nicht selbst
// erfinden muessen: tmux zeichnet nichts mehr, sondern schickt Ereignisse
// herauf und nimmt Befehle hinunter.
//
// Zwei gemessene Eigenheiten bestimmen den Aufbau dieser Datei:
//
//   F1  Beim Anhaengen schickt tmux NICHTS vom vorhandenen Inhalt. Gemessen auf
//       tmux 3.7b: drei Protokollzeilen (%begin, %end, %session-changed) und
//       kein Zeichen des Puffers. Wer sich an eine seit Stunden laufende
//       Session haengt, sieht sonst ein leeres Fenster und haelt sie fuer tot.
//       Deshalb holt `attach()` den Anfangszustand selbst: capture-pane fuer
//       den sichtbaren Inhalt, list-windows und list-panes fuer das Layout.
//
//   F2  Ein Steuerclient hat nach dem Anhaengen keine eigene Groesse; erst
//       `refresh-client -C WxH` gibt ihm eine -- und diese Groesse BLEIBT der
//       Session auch nach dem Abloesen erhalten. Naiv angewandt verformt das
//       jede fremde Session dauerhaft. Die Antwort steht in `applySizePolicy`.
//
// DERSELBE KANAL AUF DER ANDEREN MASCHINE (10.08.). Bekommt diese Klasse einen
// Maschinennamen, laeuft ihr tmux nicht hier, sondern drueben: statt
// `tmux -C attach-session` steht dann `ssh <maschine> "… tmux -C
// attach-session …"` davor, gebaut von `fernAufruf` (pfad.ts) -- derselben
// einen Stelle, die auch Schliessen, Umbenennen und Fortsetzen auf die andere
// Maschine bringt. Der Steuermodus traegt ueber SSH; das ist am 05.08. gemessen
// und steht in SESSION-STATE.md. Alles ueber diesem Kanal -- Momentaufnahme,
// Tastendruecke, Groesse, Zurueckstellen beim Abloesen -- ist danach WORTGLEICH
// dasselbe wie oertlich, denn es sind alles Zeilen im Steuerkanal.
//
// DREI STELLEN SIND ES NICHT, und sie sind der ganze Unterschied:
//
//   1  Die Fragen VOR und NEBEN dem Kanal (`isOwned`, die Fenstergroesse in
//      `applySizePolicy`) liefen oertlich als eigener, SYNCHRONER tmux-Aufruf.
//      Fern waere das je Frage eine eigene ssh-Verbindung, synchron im
//      Hauptprozess -- das Fenster stuende fuer die Dauer des
//      Verbindungsaufbaus. Fern gehen sie deshalb durch den schon offenen Kanal.
//   2  Das Anhaengen dauert laenger (Verbindungsaufbau statt Prozessstart), also
//      bekommt es eine eigene, groessere Frist.
//   3  Eine tote Leitung muss AUFFALLEN. Dafuer sorgen die ServerAlive-Angaben
//      in `fernAufruf`; ihr Ende kommt hier als 'closed' an wie ein beendeter
//      oertlicher Steuerclient, und das Fenster raeumt darauf die Buehne.
import { spawn, ChildProcessWithoutNullStreams, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
// Jeder tmux-Aufruf dieses Moduls bekommt seine Kodierung mitgegeben. Der
// Grund und die Messung stehen im Kopf von pfad.ts: `listWindows` und
// `listPanes` unten zerlegen ihre Antwort an Tabulatoren, und ohne
// UTF-8-Zeichenklasse gibt tmux die als Unterstrich aus. Es steht hier an
// JEDEM Aufruf und nicht nur an den beiden, damit niemand die Frage pro
// Aufrufstelle neu beantworten muss -- es war schon zweimal dieselbe.
// (Fuer die ferne Fassung steckt dieselbe Kodierung in der Zeile, die drueben
// laeuft -- `fernAufruf` setzt sie davor.)
import { fernAufruf, mitMaschinenLocale } from './pfad';

export interface PaneInfo {
  paneId: string;
  windowId: string;
  width: number;
  height: number;
  active: boolean;
  title: string;
}

export interface WindowInfo {
  windowId: string;
  name: string;
  width: number;
  height: number;
  active: boolean;
  layout: string;
}

export interface AttachResult {
  session: string;
  windows: WindowInfo[];
  panes: PaneInfo[];
  /** Sichtbarer Inhalt je Pane, so wie er beim Anhaengen schon dastand (F1). */
  initialContent: Record<string, string>;
  /** Wie die Groesse behandelt wurde -- siehe applySizePolicy. */
  sizePolicy: 'adopted' | 'owned';
  cols: number;
  rows: number;
  /** Ob unser Client aus der Groessenrechnung genommen wurde (B2). */
  sizeIgnored: boolean;
}

/** Benutzer-Option, an der eine selbst angelegte Session erkennbar ist (F14). */
export const OWNER_OPTION = '@awb_owner';

/**
 * DIE WACHE UEBER DER FERNEN LEITUNG.
 *
 * Ein Steuerkanal ueber ssh ist eine Verbindung, die stundenlang steht und die
 * meiste Zeit schweigt -- ein Agent, der nachdenkt, schickt nichts. Faellt die
 * Leitung dabei aus (Deckel zu, WLAN weg, Rechner schlafen gelegt), MERKT ssh
 * das von sich aus nicht: es wartet auf ein TCP-Zeitlimit, und bis dahin steht
 * im Fenster ein Bild, das aussieht wie ein lebendes Terminal. Genau das ist
 * der schlimmere Fehler -- schlimmer als eine ehrliche leere Buehne.
 *
 * Mit diesen beiden Angaben fragt ssh alle fuenf Sekunden nach und gibt nach
 * drei unbeantworteten Fragen auf. Der Abbruch kommt dann als 'closed' herauf,
 * und das Fenster sagt ihn an. Fuenfzehn Sekunden sind lang genug, dass eine
 * kurz gesaettigte Leitung nicht als Ausfall gilt, und kurz genug, dass niemand
 * lange in ein totes Bild sieht.
 */
export const FERN_VERBINDUNGSWACHE = ['ServerAliveInterval=5', 'ServerAliveCountMax=3'];

/**
 * Wie lange auf das erste Lebenszeichen des FERNEN Steuermodus gewartet wird.
 * Oertlich sind es fuenf Sekunden fuer einen Prozessstart; hier kommt ein
 * Verbindungsaufbau davor (`ConnectTimeout=6` in `fernAufruf` deckelt allein
 * schon sechs davon ab).
 */
export const FERN_ANHAENGE_FRIST_MS = 15000;

export interface PaneBox {
  paneId: string;
  /** Lage in ZELLEN im Fenster, so wie tmux sie fuehrt. */
  x: number;
  y: number;
  cols: number;
  rows: number;
}

/**
 * Die Aufteilung eines Fensters aus `#{window_layout}`.
 *
 * Der Text sieht so aus: `bc61,197x52,0,0{98x52,0,0,1,98x52,99,0[98x50,99,0,2,
 * 98x1,99,51,3]}`. Vorn eine Pruefsumme, dann das Fenster, dann geschachtelt
 * die Teile -- `{}` nebeneinander, `[]` uebereinander. Jedes Blatt endet auf
 * die NUMMER des Panes (`%3` steht dort als `3`).
 *
 * Der Baum muss nicht nachgebildet werden: jedes Blatt traegt seine absolute
 * Lage in Zellen. Fuer das Zeichnen reicht deshalb die flache Liste, und die
 * Trennlinien stecken schon in den Abstaenden (ein Pane bei x=99 hinter einem
 * 98 Spalten breiten laesst genau eine Spalte frei).
 */
export function parseLayout(layout: string): { cols: number; rows: number; panes: PaneBox[] } {
  const kopf = /^[0-9a-f]+,(\d+)x(\d+),\d+,\d+/.exec(layout);
  const cols = kopf ? Number(kopf[1]) : 0;
  const rows = kopf ? Number(kopf[2]) : 0;
  const panes: PaneBox[] = [];
  // Blaetter sind die Stellen mit einer vierten Zahl: BxH,X,Y,NUMMER.
  for (const m of layout.matchAll(/(\d+)x(\d+),(\d+),(\d+),(\d+)/g)) {
    panes.push({
      paneId: `%${m[5]}`,
      cols: Number(m[1]),
      rows: Number(m[2]),
      x: Number(m[3]),
      y: Number(m[4]),
    });
  }
  return { cols, rows, panes };
}

/**
 * Jeder Wert, der in eine tmux-Befehlszeile eingesetzt wird, geht vorher durch
 * eine dieser beiden Pruefungen. Der Kanal zu tmux ist ZEILENBASIERT: ein
 * Zeilenumbruch im Wert ist ein zweiter Befehl, und `send-keys` in jeden Pane
 * waere dann nur eine Zeile entfernt. Deshalb stehen die Pruefungen hier und
 * nicht bei den Aufrufern -- an dieser Funktion kommt keiner vorbei.
 */
export function assertPaneId(paneId: string): string {
  if (!/^%\d{1,9}$/.test(paneId)) throw new Error(`unzulaessige Pane-Kennung: ${JSON.stringify(paneId)}`);
  return paneId;
}

/**
 * Sessionnamen kommen aus der Umgebung, aus `--session=` und aus den
 * Zustandsdateien -- also aus Dateien, die ein anderes Programm schreibt.
 * Erlaubt ist, was in einer unquotierten Befehlszeile eindeutig bleibt: keine
 * Leerzeichen, keine Steuerzeichen, kein Semikolon, kein Doppelpunkt (den
 * benutzt tmux selbst als Trenner zwischen Session und Fenster).
 */
export function assertSessionName(name: string): string {
  if (!/^[A-Za-z0-9_.@%+=,-]{1,128}$/.test(name)) {
    throw new Error(`unzulaessiger Sessionname: ${JSON.stringify(name)}`);
  }
  return name;
}

type Pending = {
  resolve: (lines: string[]) => void;
  reject: (e: Error) => void;
  /** Laeuft im Parser genau bei %end -- vor jeder weiteren gelesenen Zeile. */
  atEnd?: () => void;
  /** Die Frist dieses Befehls, geloescht, sobald seine Antwort da ist. */
  uhr?: NodeJS.Timeout;
  /** Die Frist ist abgelaufen -- die Antwort kommt zu spaet und wird verworfen. */
  abgelaufen?: boolean;
  /**
   * Dieser Befehl steht in EINER Zeile mit dem naechsten (siehe commandPaar).
   * Scheitert er, fuehrt tmux den naechsten gar nicht mehr aus -- dessen
   * Antwort kaeme nie, und die Warteschlange stuende von da an um eins
   * verschoben. Also stirbt der Partner mit.
   */
  zieheNachsten?: boolean;
};

/**
 * Wie lange auf die Antwort EINES Befehls gewartet wird (Befund 7 der Bugjagd,
 * 15.08.). Ohne Frist wartete ein Aufrufer bei einem haengenden Steuerclient
 * fuer immer -- und mit ihm alles, was an seiner Zusage haengt: das Zeichnen
 * eines Panes, die Groessenanpassung, das Schliessen. Fuenf Sekunden sind das
 * Vielfache dessen, was ein `capture-pane` oder `display -p` je gebraucht hat,
 * und immer noch eine Zahl, hinter der ein Mensch nicht ratlos sitzt.
 */
const BEFEHL_FRIST_MS = 5000;

export class TmuxControl extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rest = Buffer.alloc(0);
  private inBlock = false;
  private blockLines: string[] = [];
  /** Kennung des offenen Blocks ("<zeit> <nummer>"), aus seinem %begin. */
  private blockId = '';
  private pending: Pending[] = [];
  private closed = false;
  // Ausgabe, die zwischen dem Anhaengen und dem ersten gezeichneten Bild
  // ankommt, darf weder verlorengehen noch doppelt erscheinen. Sie wird
  // deshalb gesammelt und mit einer laufenden Nummer versehen: verworfen wird
  // je Pane nur, was VOR seiner eigenen Momentaufnahme kam; startStreaming()
  // spielt den Rest nach und schaltet auf laufend.
  private outQueue: { seq: number; paneId: string; data: Buffer }[] = [];
  private outSeq = 0;
  /** Je Pane die Bytes eines Zeichens, das am Ende eines %output angefangen hat. */
  private offeneBytes = new Map<string, Buffer>();
  /** Panes, deren Ausgabe gerade gesammelt statt durchgereicht wird (capturePane). */
  private pausiert = new Set<string>();
  private streaming = false;
  /** Ob tmux unseren Client aus der Groessenrechnung genommen hat (B2). */
  private sizeIgnored = false;
  /**
   * Was wir an der Session veraendert haben, um sie zu fuellen -- und wie es
   * vorher war. Solange wir zeichnen, gehoert uns die Groesse; beim Abloesen
   * bekommt die Session ALLES zurueck: Fenstergroesse, Aufteilung und die
   * window-size-Option. Ohne diese Buchfuehrung waere das Fuellen ein
   * bleibender Eingriff, und genau den verbietet F2.
   */
  private vorZustand: { windowId: string; layout: string; cols: number; rows: number }[] = [];
  private windowSizeVorher: string | null = null;
  /**
   * Nur eine FREMDE Session bekommt ihren Zustand zurueck. Eine selbst
   * angelegte behaelt die Groesse, die wir ihr gegeben haben -- das ist die
   * andere Haelfte der Regel aus F2 und ausdruecklich gewollt.
   */
  private ownSession = false;
  /** Von UNS gezoomter Pane -- nur der wird auch von uns wieder entzoomt. */
  private gezoomt = '';
  /**
   * Die letzte Zeile, die ssh oder tmux nach stderr geschrieben hat. Sie ist
   * die einzige Auskunft, die ein gescheitertes fernes Anhaengen mitbringt --
   * „kein %session-changed" allein sagt dem Menschen nicht, dass der Rechner
   * nicht antwortet.
   */
  private letzterFehlertext = '';

  /**
   * @param socket  tmux-Socket fuer den OERTLICHEN Weg (Testhaken). Fuer eine
   *                ferne Sitzung ohne Bedeutung: drueben gilt das tmux, das
   *                dort im PATH steht, mit seinem eigenen Vorgabesocket.
   * @param maschine Leer = oertlich. Sonst der SSH-Alias der Maschine, der die
   *                Sitzung gehoert (in config.ts ist der Maschinenname genau
   *                dieser Alias).
   */
  constructor(private readonly socket: string, private session: string, private readonly maschine = '') {
    super();
  }

  /** Zeichnet diese Verbindung eine Sitzung auf einer anderen Maschine? */
  istFern(): boolean {
    return !!this.maschine;
  }

  /** Was ssh oder tmux zuletzt nach stderr gesagt hat -- fuer die Fehlermeldung. */
  fehlertext(): string {
    return this.letzterFehlertext;
  }

  private baseArgs(): string[] {
    return this.socket ? ['-L', this.socket] : [];
  }

  /**
   * Ein vollstaendiger Aufruf: oertlich `tmux …`, fern `ssh <maschine> "… tmux
   * …"`. JEDER Prozessstart dieser Datei geht hier durch -- damit gibt es die
   * Frage „hier oder drueben?" genau einmal und nicht an fuenf Aufrufstellen.
   */
  private argv(args: string[], zusatzOptionen: string[] = []): string[] {
    if (!this.maschine) return ['tmux', ...this.baseArgs(), ...args];
    return fernAufruf(this.maschine, ['tmux', ...args], {}, zusatzOptionen);
  }

  /**
   * Zielangabe fuer alle Befehle: exakter Sessionname, gefolgt vom Doppelpunkt.
   *
   * Der Doppelpunkt ist nicht kosmetisch, sondern gemessen. `-t =name` sucht
   * bei `display` und `show-options` ein Fenster beziehungsweise einen Pane
   * dieses Namens und findet keins -- die Antwort ist dann LEER statt falsch,
   * und der Rueckgabewert bleibt 0. `-t =name:` benennt die Session und laesst
   * Fenster und Pane offen; damit liefern alle fuenf benutzten Befehle
   * (display, show-options, set-option, resize-window, list-*) das Erwartete.
   */
  private target(): string {
    return `=${assertSessionName(this.session)}:`;
  }

  /**
   * Ein tmux-Aufruf ausserhalb des Steuerkanals, fuer Fragen vor dem Anhaengen.
   *
   * NUR OERTLICH. Er ist SYNCHRON, und fern hiesse das: der Hauptprozess steht,
   * bis eine ssh-Verbindung aufgebaut, benutzt und wieder abgebaut ist -- mit
   * `ConnectTimeout=6` im schlechtesten Fall sechs Sekunden ohne Fenster. Die
   * ferne Fassung derselben Fragen laeuft durch den schon offenen Steuerkanal
   * (`auskunft`).
   */
  private query(args: string[]): string {
    if (this.maschine) throw new Error(`query() ist der oertliche Weg -- fuer ${this.maschine} gilt der Steuerkanal`);
    const r = spawnSync('tmux', [...this.baseArgs(), ...args], { encoding: 'utf8', env: mitMaschinenLocale() });
    if (r.status !== 0) throw new Error(`tmux ${args.join(' ')}: ${(r.stderr || '').trim()}`);
    return (r.stdout || '').replace(/\n$/, '');
  }

  /**
   * Dieselbe Frage, aber ueber den offenen Steuerkanal -- die ferne Fassung von
   * `query`. Eine Zeile Antwort, leer wenn tmux nichts sagt.
   */
  private async auskunft(cmd: string): Promise<string> {
    const [z] = await this.command(cmd).catch(() => ['']);
    return (z ?? '').trim();
  }

  /**
   * Erste vorhandene Session, falls keine benannt wurde.
   *
   * Fuer eine ferne Sitzung MUSS der Name dastehen: er steht in der
   * Zustandsdatei drueben, die der Fernabruf ohnehin mitbringt, und „irgendeine
   * Session auf der anderen Maschine" waere geraten -- moeglicherweise die eines
   * Menschen, der dort gerade arbeitet.
   */
  resolveSession(): string {
    if (this.session) return assertSessionName(this.session);
    if (this.maschine) throw new Error(`fuer ${this.maschine} muss der Sessionname genannt werden`);
    const list = this.query(['list-sessions', '-F', '#{session_name}']);
    const first = list.split('\n').filter(Boolean)[0];
    if (!first) throw new Error('keine tmux-Session vorhanden');
    this.session = assertSessionName(first);
    return this.session;
  }

  isOwned(): boolean {
    const r = spawnSync('tmux', [...this.baseArgs(), 'show-options', '-t', this.target(), '-qv', OWNER_OPTION], { encoding: 'utf8', env: mitMaschinenLocale() });
    return (r.stdout || '').trim().length > 0;
  }

  /**
   * Dieselbe Frage fuer eine ferne Sitzung, durch den Steuerkanal. Sie kann
   * erst NACH dem Anhaengen beantwortet werden -- vorher gibt es keinen Kanal --
   * und genau dort steht sie in `attach`.
   */
  private async istEigenUeberKanal(): Promise<boolean> {
    return (await this.auskunft(`show-options -t ${this.target()} -qv ${OWNER_OPTION}`)).length > 0;
  }

  async attach(desired: { cols: number; rows: number }): Promise<AttachResult> {
    const session = this.resolveSession();
    // Oertlich steht der Besitz vor dem Anhaengen fest (ein eigener Aufruf);
    // fern gibt es dafuer erst nach dem Anhaengen einen Weg -- siehe unten.
    const ownedVorher = this.maschine ? false : this.isOwned();
    this.ownSession = ownedVorher;

    const argv = this.argv(['-C', 'attach-session', '-t', this.target()], FERN_VERBINDUNGSWACHE);
    this.proc = spawn(argv[0], argv.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: mitMaschinenLocale(),
    });
    // Ein Steuerclient ohne offene Eingabe bekommt sofort EOF und beendet sich
    // mit %exit. stdin bleibt deshalb offen, bis detach() es schliesst.
    //
    // UND SIE BRAUCHT EIN OHR (Befund 6 der Bugjagd, 15.08.): stirbt der
    // Steuerclient, waehrend ein Befehl hinausgeht, faellt der Schreibfehler
    // ASYNCHRON an. Ohne diesen Listener waere er eine unbehandelte Ausnahme im
    // Hauptprozess -- das Fenster ginge an einem beendeten tmux zugrunde. WAS
    // nicht ankam, sagt der Rueckruf in `command()`; hier steht nur, dass es
    // den Kanal getroffen hat.
    this.proc.stdin.on('error', (fehler: NodeJS.ErrnoException) => {
      process.stderr.write(`Steuerkanal: Schreibweg gestoert (${fehler.code ?? fehler.message})\n`);
    });
    this.proc.stdout.on('data', (b: Buffer) => this.feed(b));
    this.proc.stderr.on('data', (b: Buffer) => {
      const text = b.toString('utf8');
      // Aufgehoben wird die letzte NICHT leere Zeile: ssh sagt seinen Grund
      // („Connection timed out", „Host key verification failed") genau dort,
      // und ohne ihn stuende im Fenster nur, dass etwas ausblieb.
      const zeile = text.split('\n').map((z) => z.trim()).filter(Boolean).pop();
      if (zeile) this.letzterFehlertext = zeile;
      this.emit('stderr', text);
    });
    this.proc.on('exit', (code, signal) => {
      this.closed = true;
      const err = new Error(`Steuerclient beendet (${code})`);
      while (this.pending.length) {
        const p = this.pending.shift()!;
        if (p.uhr) clearTimeout(p.uhr);
        p.reject(err);
      }
      // Das SIGNAL gehoert dazu, nicht nur der Rueckgabewert: wird der
      // ssh-Prozess umgebracht -- weil das Netz ihn mitreisst, weil jemand
      // aufraeumt --, ist `code` null, und „beendet mit Code null" waere ein
      // Satz, aus dem niemand etwas ablesen kann.
      this.emit('closed', code, signal);
    });

    // Auf %session-changed warten, damit der erste unangeforderte %begin/%end-
    // Block durch ist, bevor wir eigene Befehle schicken.
    //
    // FERN MIT LAENGERER FRIST: hier startet ein Prozess, drueben wird eine
    // Verbindung aufgebaut -- Namensaufloesung, TCP, Anmeldung. Fuenf Sekunden
    // sind dafuer knapp bemessen, und ein Ablauf dieser Frist saehe aus wie ein
    // Fehler des Programms.
    try {
      await this.waitFor('session-changed', this.maschine ? FERN_ANHAENGE_FRIST_MS : 5000);
    } catch (e) {
      if (!this.maschine) throw e;
      const grund = this.letzterFehlertext ? ` (${this.letzterFehlertext})` : '';
      throw new Error(`${this.maschine} hat den Steuermodus nicht geoeffnet: ${(e as Error).message}${grund}`);
    }
    const owned = this.maschine ? await this.istEigenUeberKanal() : ownedVorher;
    this.ownSession = owned;
    await this.ignoreOwnSize();

    const { cols, rows, policy } = await this.applySizePolicy(owned, desired);
    const windows = await this.listWindows();
    const panes = await this.listPanes();
    // NUR der aktive Pane. Jede weitere Momentaufnahme kostet einen Umlauf,
    // in dem laufende Ausgabe anfaellt, und gezeichnet wird ohnehin nur einer;
    // die uebrigen holt paneZeigen() beim Wechsel.
    const active = panes.find((p) => p.active) ?? panes[0];
    const initialContent: Record<string, string> = {};
    if (active) initialContent[active.paneId] = await this.capturePane(active.paneId);

    return { session, windows, panes, initialContent, sizePolicy: policy, cols, rows, sizeIgnored: this.sizeIgnored };
  }

  /**
   * B2: Unter der tmux-Vorgabe `window-size latest` bestimmt der ZULETZT
   * angehaengte Client die Fenstergroesse -- und das sind wir. Gemessen auf
   * tmux 3.7b, zwei Clients an einer Session:
   *
   *   ohne diesen Aufruf : Mensch will 100x28, Fenster bleibt 120x30,
   *                        erst nach unserem Abloesen springt es auf 100x28
   *   mit ignore-size    : Mensch will 100x28, Fenster ist 100x28
   *
   * Damit ist unser Steuerclient aus der Groessenrechnung heraus. Er meldet
   * seine Groesse weiterhin (fuer sich selbst), aber er bestimmt sie nicht mehr
   * fuer andere -- die fremde Session gehoert dem Menschen davor.
   *
   * Schlaegt der Aufruf fehl (aeltere tmux-Fassung), haengen wir trotzdem an:
   * ein eingefrorenes Fenster ist besser als gar keins. Der Zustand sagt dann,
   * dass es nicht griff.
   */
  private async ignoreOwnSize(): Promise<void> {
    try {
      await this.command('refresh-client -f ignore-size');
      this.sizeIgnored = true;
    } catch (e) {
      this.sizeIgnored = false;
      this.emit('stderr', `refresh-client -f ignore-size nicht angenommen: ${(e as Error).message}\n`);
    }
  }

  /**
   * Die Antwort auf F2, aus vier gemessenen Varianten (tmux 3.7b, Session
   * 200x50 angelegt, Steuerclient mit 100x30):
   *
   *   A  refresh-client -C 100x30 auf eine fremde Session
   *      -> Fenster 100x30, und es BLEIBT 100x30 nach dem Abloesen. Genau der
   *         bleibende Eingriff, den F2 beschreibt.
   *   B  refresh-client -C <aktuelle Fenstergroesse der Session>
   *      -> waehrend und nach dem Anhaengen unveraendert 200x50, die Option
   *         window-size bleibt ungesetzt. %output fliesst.
   *   C  window-size largest, dann refresh-client -C 100x30
   *      -> Fenster 100x30 UND die Session traegt danach dauerhaft
   *         window-size=largest. Zwei Aenderungen statt einer.
   *   D  window-size manual + resize-window -x 120 -y 40
   *      -> Fenster bleibt 120x40, egal was der Client meldet, auch nach dem
   *         Abloesen. Die Groesse haengt nicht mehr daran, wer gerade zusieht.
   *
   * Daraus die Regel: eine fremde Session wird UEBERNOMMEN (B) -- wir passen
   * unsere Darstellung an ihre Groesse an, nie umgekehrt. Eine selbst angelegte
   * Session bekommt (D), damit die Panebreite eine Entscheidung ist und nicht
   * die Nebenwirkung der Fensterbreite; daran haengt spaeter die
   * 80-Spalten-Schwelle.
   */
  private async applySizePolicy(owned: boolean, desired: { cols: number; rows: number }): Promise<{ cols: number; rows: number; policy: 'adopted' | 'owned' }> {
    if (owned) {
      await this.command(`set-option -t ${this.target()} window-size manual`);
      await this.command(`resize-window -t ${this.target()} -x ${desired.cols} -y ${desired.rows}`);
      await this.command(`refresh-client -C ${desired.cols}x${desired.rows}`);
      return { cols: desired.cols, rows: desired.rows, policy: 'owned' };
    }
    const size = this.maschine
      ? await this.auskunft(`display -p -t ${this.target()} '#{window_width}x#{window_height}'`)
      : this.query(['display', '-p', '-t', this.target(), '#{window_width}x#{window_height}']);
    const [w, h] = size.split('x').map((n) => parseInt(n, 10));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      throw new Error(`tmux nannte keine Fenstergroesse fuer ${this.session}: "${size}"`);
    }
    await this.command(`refresh-client -C ${w}x${h}`);
    return { cols: w, rows: h, policy: 'adopted' };
  }

  /**
   * Wieviele FREMDE Clients an dieser Session haengen -- unser eigener
   * Steuermodus-Client zaehlt nicht mit (`#{client_control_mode}` ist bei ihm
   * 1). Daran haengt seit dem 06.08. die Frage, ob eine uebernommene Session
   * umgeraeumt werden darf: solange niemand sonst hinsieht, ist Umraeumen
   * folgenlos und wird beim Abloesen zurueckgenommen; sobald jemand die
   * Session anderswo offen hat, wuerden ihm die Fenster unter den Haenden
   * springen.
   */
  async fremdeClients(): Promise<number> {
    const lines = await this.command(`list-clients -t ${this.target()} -F '#{client_control_mode}'`).catch(() => []);
    return lines.filter((l) => l.trim() !== '' && l.trim() !== '1').length;
  }

  /**
   * Verfolgt die Anwendung in diesem Pane die Maus -- und in welcher Kodierung?
   *
   * tmux fuehrt diese Zustaende selbst mit (`mouse_*_flag`), und das ist die
   * einzige verlaessliche Quelle: die Momentaufnahme eines Panes
   * (`capture-pane`) traegt Text und Farben, aber KEINE Modus-Umschaltungen.
   * Ein frisch angelegtes Terminal im Fenster weiss deshalb nichts davon, dass
   * die Anwendung im Pane seit Stunden die Maus verfolgt -- und schluckt das
   * Rad, statt es weiterzureichen.
   */
  async mausFlags(paneId: string): Promise<{ an: boolean; sgr: boolean }> {
    assertPaneId(paneId);
    const [z] = await this.command(
      `display -p -t ${paneId} '#{mouse_any_flag};#{mouse_button_flag};#{mouse_standard_flag};#{mouse_all_flag};#{mouse_sgr_flag}'`,
    ).catch(() => ['']);
    const [any, button, standard, all, sgr] = (z ?? '').split(';');
    return { an: [any, button, standard, all].some((f) => f === '1'), sgr: sgr === '1' };
  }

  async listWindows(): Promise<WindowInfo[]> {
    const lines = await this.command(
      `list-windows -t ${this.target()} -F '#{window_id}\t#{window_name}\t#{window_width}\t#{window_height}\t#{window_active}\t#{window_layout}'`,
    );
    return lines.filter(Boolean).map((l) => {
      const [windowId, name, w, h, active, layout] = l.split('\t');
      return { windowId, name, width: parseInt(w, 10), height: parseInt(h, 10), active: active === '1', layout: layout ?? '' };
    });
  }

  async listPanes(): Promise<PaneInfo[]> {
    const lines = await this.command(
      `list-panes -s -t ${this.target()} -F '#{pane_id}\t#{window_id}\t#{pane_width}\t#{pane_height}\t#{pane_active}\t#{pane_title}'`,
    );
    return lines.filter(Boolean).map((l) => {
      const [paneId, windowId, w, h, active, title] = l.split('\t');
      return { paneId, windowId, width: parseInt(w, 10), height: parseInt(h, 10), active: active === '1', title: title ?? '' };
    });
  }

  /**
   * Der sichtbare Inhalt eines Panes. Laeuft absichtlich DURCH den Steuerkanal
   * und nicht als eigener tmux-Aufruf: tmux beantwortet Befehle in der
   * Reihenfolge, in der sie ankommen, damit liegt die Momentaufnahme sauber
   * zwischen den %output-Ereignissen und kann nichts doppeln oder verlieren.
   */
  /**
   * Der RUECKBLICK eines Panes -- die Zeilen ueber dem sichtbaren Schirm.
   *
   * Ohne ihn gibt es im Fenster nichts zum Hochrollen: `capturePane` liefert
   * genau einen Schirm, und der Renderer setzt ihn ins Terminal. Solange nur
   * das ankommt, sind Puffer und Schirm gleich lang, und das Rad bewegt
   * nichts -- gemessen, und es war der Grund, warum das Hochrollen "manchmal
   * gar nicht" ging.
   *
   * OHNE -J: jede Zeile ist genau eine Bildschirmzeile. Der Aufrufer haengt
   * hinter den Rueckblick so viele Zeilenumbrueche, dass er vollstaendig ueber
   * den Schirm hinauswandert; das geht nur auf, wenn Zeile und Bildschirmzeile
   * dasselbe sind.
   */
  async capturePaneHistorie(paneId: string, zeilen: number): Promise<string> {
    assertPaneId(paneId);
    const n = Math.max(0, Math.min(20000, Math.floor(zeilen)));
    if (!n) return '';
    const [hoehe] = await this.command(`display -p -t ${paneId} '#{pane_height}'`);
    const rows = Math.max(1, parseInt(hoehe ?? '24', 10) || 24);
    // -E -1 endet EINE Zeile ueber dem Schirm: der Schirm selbst kommt aus
    // capturePane und wuerde sich sonst doppeln.
    const lines = await this.command(`capture-pane -p -e -S -${n} -E -1 -t ${paneId}`).catch(() => [] as string[]);
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    if (!lines.length) return '';
    // Die Umbrueche danach schieben den Rueckblick vollstaendig nach oben. Ohne
    // sie stuende sein Ende noch im sichtbaren Schirm -- und das anschliessende
    // "Schirm loeschen" von capturePane wischt es weg, statt es in den
    // Rueckblick zu schieben (Bildschirm loeschen rollt nicht).
    return lines.join('\r\n') + '\r\n'.repeat(rows + 1);
  }

  async capturePane(paneId: string): Promise<string> {
    assertPaneId(paneId);
    // Ab hier wird die Ausgabe dieses Panes NICHT mehr durchgereicht, sondern
    // gesammelt -- bis der Aufrufer die Aufnahme abgeschickt hat und
    // fortsetzen() ruft.
    //
    // Ohne das entsteht eine Luecke, die nichts wieder schliesst: die Aufnahme
    // gilt fuer den Augenblick T, aber sie wird erst spaeter gezeichnet, und
    // dazwischen laufende Ausgabe steht schon im Terminal. Das Zuruecksetzen
    // vor der Aufnahme wischt sie weg, und die Aufnahme selbst kennt sie noch
    // nicht. Gemessen an einer Oberflaeche, die sich nach jedem
    // Groessenwechsel vollstaendig neu zeichnet: nach dem Maximieren fehlten
    // elf Zeilen mitten im Bild, und sie kamen auch nach acht Sekunden nicht
    // wieder -- die Anwendung hatte sie ja gezeichnet, nur nicht noch einmal.
    // NUR im laufenden Betrieb. Vor startStreaming() sammelt die Warteschlange
    // ohnehin alles, und dort loest die Marke die Naht auf -- ein Anhalten
    // waere dort nicht nur ueberfluessig, sondern schaedlich: attach() nimmt
    // seine Momentaufnahmen selbst und ruft kein fortsetzen(). Der Pane bliebe
    // fuer immer angehalten, und der Strom kaeme nie in Gang. Gemessen als
    // sporadischer Fehlschlag der B3-Naht in test-app-geruest.sh.
    if (this.streaming) this.pausiert.add(paneId);
    // UND WENN DIESER WEG WIRFT, WIRD DAS ANHALTEN ZURUECKGENOMMEN (Befund 4
    // der Bugjagd, 15.08.). Das Gegenstueck `fortsetzen()` ruft der AUFRUFER,
    // nachdem er die Aufnahme abgeschickt hat -- eine Ausnahme kommt dort nie
    // an. Nachgestellt auf eigenem Socket: `capturePane('%9999')` endet mit
    // „can't find pane", und der Pane stand danach dauerhaft in `pausiert`;
    // seine `%output`-Stuecke waeren von da an unbegrenzt gesammelt worden und
    // das Terminal haette bis zum naechsten Anhaengen eingefroren gewirkt.
    try {
      // INHALT UND CURSOR MUESSEN DERSELBE AUGENBLICK SEIN (16.08.).
      //
      // Bis heute waren es zwei getrennte tmux-Befehle, und dazwischen las tmux
      // weiter vom Pane. GEMESSEN auf eigenem Socket unter Dauerausgabe: bei 10
      // von 129 Aufnahmen kam dazwischen Ausgabe an. Dann steht im Bild der
      // Schirm von vorhin, der Cursor aber schon dort, wo diese Ausgabe ihn
      // hingestellt hat -- und weil sie danach nachgespielt wird (sie liegt
      // hinter der Marke), schreibt sie sich ab dieser vorgerueckten Stelle.
      // Sichtbar wurde das als Luecke mitten im Wort: `BLOCKBLOCK...BLO` +
      // zweiunddreissig Leerzeichen + `CKBLOCK...`, genau so lang wie das, was
      // dazwischen kam. Das ist das Verrutschen, das alice gemeldet hat.
      //
      // Jetzt gehen beide Befehle in EINER Zeile hinaus; tmux arbeitet die
      // Liste ohne einen Durchlauf seiner Ereignisschleife ab und liest
      // dazwischen nicht vom Pane (gemessen, siehe commandPaar). Der Cursor
      // steht deshalb vor der Aufnahme: so meint er zwangslaeufig denselben
      // Schirm.
      //
      // Die Marke wird im Parser gesetzt, genau bei %end der Aufnahme, und NICHT
      // hier nach dem await: zwischen beiden liegt ein Durchlauf der
      // Ereignisschleife, in dem schon die naechsten %output-Zeilen gelesen sein
      // koennen. Genau dieses Fenster war der Verlust aus B3.
      let marke = -1;
      const [[pos], lines] = await this.commandPaar(
        `display -p -t ${paneId} '#{cursor_y};#{cursor_x}'`,
        `capture-pane -p -e -J -t ${paneId}`,
        () => {
          marke = this.outSeq;
        },
      );
      // Verworfen wird nur, was DIESER Pane vor seiner eigenen Aufnahme
      // ausgegeben hat. Alles danach -- auch die Ausgabe anderer Panes --
      // bleibt zum Nachspielen liegen.
      this.outQueue = this.outQueue.filter((o) => !(o.paneId === paneId && o.seq <= marke));
      const [y, x] = (pos ?? '0;0').split(';').map((n) => parseInt(n, 10) || 0);
      // Bildschirm loeschen, den Inhalt setzen und den Cursor dahin stellen, wo
      // tmux ihn hat. Ohne den letzten Schritt haengt die naechste Ausgabe unten
      // am Pufferende statt an der Eingabezeile, und der Anfang scrollt weg.
      const esc = '\x1b';
      return `${esc}[2J${esc}[H${lines.join('\r\n')}${esc}[${y + 1};${x + 1}H`;
    } catch (e) {
      // Nachspielen statt Wegwerfen: was waehrend des gescheiterten Versuchs
      // auflief, gehoert weiterhin diesem Pane.
      this.fortsetzen(paneId);
      throw e;
    }
  }

  /**
   * Gibt dem angezeigten Pane GENAU die Groesse, die gezeichnet wird.
   *
   * Bisher lief es andersherum: tmux nannte die Fenstergroesse, der Renderer
   * stellte sein Gitter darauf und passte es mit transform: scale() in die
   * Flaeche. Daraus kamen drei Fehler auf einmal -- der leere Rand oben und
   * unten (Seitenverhaeltnisse passen selten), ein falsch gezeichneter
   * Worker-Pane (die Zahl kam vom FENSTER, der Inhalt vom PANE) und ein
   * unscharfes Gitter. Jetzt bestimmt die Flaeche die Zahlen, und tmux bekommt
   * dieselben.
   *
   * In einem geteilten Fenster reicht `resize-pane` allein nicht: gemessen
   * bekommt der Pane in einem 91x42-Fenster nur 91x36, weil die uebrigen Panes
   * und die Trennlinien Platz behalten. Deshalb wird das Fenster um den
   * Fehlbetrag groesser gemacht und der Pane erneut gesetzt -- danach stimmt
   * die Groesse auf die Zeile genau (gemessen: 91x42 in einem 91x48-Fenster).
   */
  async fitPane(paneId: string, cols: number, rows: number): Promise<{ cols: number; rows: number }> {
    assertPaneId(paneId);
    const c = Math.max(20, Math.min(999, Math.floor(cols)));
    const r = Math.max(5, Math.min(999, Math.floor(rows)));

    const [kopf] = await this.command(`display -p -t ${paneId} '#{window_id};#{window_width};#{window_height};#{window_layout}'`);
    const [windowId, wBreite, wHoehe, ...rest] = (kopf ?? '').split(';');
    if (!/^@\d+$/.test(windowId ?? '')) throw new Error(`kein Fenster zu Pane ${paneId}: ${kopf}`);
    // Der Aufteilungs-Text enthaelt selbst Kommas, aber kein Semikolon.
    const layout = rest.join(';');

    // Einmal je Fenster merken, wie es vorher aussah.
    if (!this.vorZustand.some((v) => v.windowId === windowId)) {
      this.vorZustand.push({ windowId, layout, cols: parseInt(wBreite, 10), rows: parseInt(wHoehe, 10) });
    }
    if (this.windowSizeVorher === null) {
      const [wert] = await this.command(`show-options -t ${this.target()} -qv window-size`);
      this.windowSizeVorher = wert ?? '';
      await this.command(`set-option -t ${this.target()} window-size manual`);
    }

    const messen = async (): Promise<{ cols: number; rows: number }> => {
      const [z] = await this.command(`display -p -t ${paneId} '#{pane_width}x#{pane_height}'`);
      const [a, b] = (z ?? '0x0').split('x').map((n) => parseInt(n, 10) || 0);
      return { cols: a, rows: b };
    };

    await this.command(`resize-window -t ${windowId} -x ${c} -y ${r}`);
    await this.command(`resize-pane -t ${paneId} -x ${c} -y ${r}`);
    let ist = await messen();
    if (ist.cols < c || ist.rows < r) {
      await this.command(`resize-window -t ${windowId} -x ${c + (c - ist.cols)} -y ${r + (r - ist.rows)}`);
      await this.command(`resize-pane -t ${paneId} -x ${c} -y ${r}`);
      ist = await messen();
    }
    return ist;
  }

  /** Stellt zurueck, was fuers Fuellen veraendert wurde. Reihenfolge zaehlt. */
  private async zustandZurueck(): Promise<void> {
    // Der Zoom geht IMMER weg, auch bei einer eigenen Session: er ist eine
    // Ansichtssache von uns und keine Eigenschaft der Session.
    await this.entzoomen();
    if (this.ownSession) {
      this.vorZustand = [];
      this.windowSizeVorher = null;
      return;
    }
    for (const v of this.vorZustand) {
      try {
        await this.command(`resize-window -t ${v.windowId} -x ${v.cols} -y ${v.rows}`);
        // Erst die Groesse, dann die Aufteilung: der Aufteilungs-Text traegt
        // absolute Zahlen und passt nur zur alten Fenstergroesse.
        //
        // Der Text MUSS in Anfuehrungszeichen. Eine Aufteilung mit
        // nebeneinanderliegenden Panes enthaelt geschweifte Klammern, und die
        // liest der Befehlsparser von tmux als Anfang eines Befehlsblocks --
        // unquotiert kam die Aufteilung deshalb still verbogen zurueck
        // (gemessen: 98x50/98x1 wurde zu 98x45/98x6).
        if (v.layout && /^[0-9a-f]+,[\d,x[\]{}]+$/.test(v.layout)) {
          await this.command(`select-layout -t ${v.windowId} '${v.layout}'`);
        }
      } catch {
        // Ein Fenster kann inzwischen geschlossen sein -- das ist kein Grund,
        // die uebrigen nicht zurueckzustellen.
      }
    }
    this.vorZustand = [];
    if (this.windowSizeVorher !== null) {
      try {
        if (this.windowSizeVorher) await this.command(`set-option -t ${this.target()} window-size ${this.windowSizeVorher}`);
        else await this.command(`set-option -t ${this.target()} -u window-size`);
      } catch {
        // dito
      }
      this.windowSizeVorher = null;
    }
  }

  /**
   * Dasselbe Zurueckstellen, aber SYNCHRON und ohne den Steuerkanal.
   *
   * Gebraucht im Signalhandler: Auf SIGTERM kommt das asynchrone Zurueckstellen
   * nicht mehr durch -- gemessen blieb die Session dann auf der Fuellgroesse
   * stehen, mit `window-size manual`. Ein synchroner Aufruf blockiert den
   * Faden, bis tmux geantwortet hat, und laeuft deshalb auch dann noch zu Ende.
   */
  zustandZurueckSync(): void {
    const ruf = (args: string[]): void => {
      try {
        const argv = this.argv(args);
        spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', env: mitMaschinenLocale() });
      } catch {
        // Beim Beenden ist ein fehlgeschlagener Aufruf kein Grund anzuhalten.
      }
    };
    // Auch der Zoom muss weg, wenn das Programm haesslich endet.
    if (this.gezoomt) {
      ruf(['resize-pane', '-Z', '-t', this.gezoomt]);
      this.gezoomt = '';
    }
    if (this.ownSession) {
      this.vorZustand = [];
      this.windowSizeVorher = null;
      return;
    }
    const gruppen: string[][] = [];
    for (const v of this.vorZustand) {
      gruppen.push(['resize-window', '-t', v.windowId, '-x', String(v.cols), '-y', String(v.rows)]);
      if (v.layout) gruppen.push(['select-layout', '-t', v.windowId, v.layout]);
    }
    this.vorZustand = [];
    if (this.windowSizeVorher !== null) {
      gruppen.push(this.windowSizeVorher
        ? ['set-option', '-t', this.target(), 'window-size', this.windowSizeVorher]
        : ['set-option', '-t', this.target(), '-u', 'window-size']);
      this.windowSizeVorher = null;
    }
    if (!gruppen.length) return;
    if (this.maschine) {
      // FERN ALS EIN EINZIGER AUFRUF. Jeder dieser Befehle waere sonst eine
      // eigene ssh-Verbindung mit eigenem Verbindungsaufbau -- und das hier
      // laeuft im Signalhandler, wo jede Sekunde eine ist, die das Programm noch
      // am Leben halten muss. tmux nimmt mehrere Befehle in einem Aufruf, wenn
      // ein einzelnes ';' dazwischensteht; `fernAufruf` quotet es, die ferne
      // Schale reicht es unveraendert durch, und tmux liest es als Trenner.
      const args: string[] = [];
      for (const g of gruppen) {
        if (args.length) args.push(';');
        args.push(...g);
      }
      ruf(args);
      return;
    }
    for (const g of gruppen) ruf(g);
  }

  /**
   * Das Fenster eines Panes auf die Zeichenflaeche bringen und seine Aufteilung
   * zurueckgeben -- fuer die Ansicht, die ALLE Worker eines Tabs nebeneinander
   * zeigt.
   *
   * Eine EIGENE Session wird dabei gleichmaessig aufgeteilt (`select-layout
   * tiled`). Das ist die Einloesung von V8/A13: jeder Worker bekommt dieselbe
   * Flaeche, statt dass einer bei einer Zeile von zweiundfuenfzig endet und
   * unlesbar wird. Eine FREMDE Session wird gezeichnet, wie sie ist -- dort
   * gilt weiter: nicht umgeraeumt.
   */
  /**
   * Die Aufteilung eines Fensters LESEN, ohne sie anzufassen. Fuer eine
   * uebernommene Session ist das der einzige erlaubte Weg: F14 laesst uns
   * fremde Fenster zeichnen, nicht umbauen. `fitWindow` schreibt immer eine
   * Groesse -- auch bei Null, denn es klemmt auf 20x5 fest, und genau das hat
   * am 05.08. die Fenster einer fremden Session auf drei Zeilen gedrueckt.
   */
  async leseFensterLage(paneId: string): Promise<{ cols: number; rows: number; panes: PaneBox[] }> {
    assertPaneId(paneId);
    const [windowId] = await this.command(`display -p -t ${paneId} '#{window_id}'`);
    if (!/^@\d+$/.test(windowId ?? '')) throw new Error(`kein Fenster zu Pane ${paneId}: ${windowId}`);
    const [layout] = await this.command(`display -p -t ${windowId} '#{window_layout}'`);
    return parseLayout(layout ?? '');
  }

  async fitWindow(
    paneId: string,
    cols: number,
    rows: number,
    aufteilung: 'tiled' | 'even-vertical' | 'even-horizontal' = 'tiled',
    umraeumen = this.ownSession,
  ): Promise<{ cols: number; rows: number; panes: PaneBox[] }> {
    assertPaneId(paneId);
    const c = Math.max(20, Math.min(999, Math.floor(cols)));
    const r = Math.max(5, Math.min(999, Math.floor(rows)));
    const [windowId] = await this.command(`display -p -t ${paneId} '#{window_id}'`);
    if (!/^@\d+$/.test(windowId ?? '')) throw new Error(`kein Fenster zu Pane ${paneId}: ${windowId}`);

    await this.merkeFenster(windowId);
    await this.entzoomen();
    await this.command(`resize-window -t ${windowId} -x ${c} -y ${r}`);
    // Die Aufteilung wird MITGEGEBEN, damit sie zu dem Gitter passt, das die
    // Buehne legt: eine Spalte ist `even-vertical`, eine Zeile
    // `even-horizontal`, alles andere `tiled`. Fest auf `tiled` gestellt teilte
    // tmux drei Panes in zwei Spalten auf, waehrend die Buehne sie
    // untereinander legte -- der Inhalt war dann doppelt so breit wie seine
    // Kachel und wurde abgeschnitten (gemessen: 198 Prozent).
    // Ob die Aufteilung angefasst werden darf, entscheidet der Aufrufer und
    // nicht mehr allein die Herkunft der Session: seit dem 06.08. wird auch
    // eine uebernommene Session umgeraeumt, solange kein anderer Client an ihr
    // haengt (siehe fremdeClients). Zurueckgestellt wird sie beim Abloesen
    // trotzdem -- das haengt weiter an `ownSession`.
    if (umraeumen) await this.command(`select-layout -t ${windowId} ${aufteilung}`);
    const [layout] = await this.command(`display -p -t ${windowId} '#{window_layout}'`);
    return parseLayout(layout ?? '');
  }

  /** Merkt sich Groesse und Aufteilung eines Fensters, einmal je Fenster. */
  private async merkeFenster(windowId: string): Promise<void> {
    if (!this.vorZustand.some((v) => v.windowId === windowId)) {
      const [z] = await this.command(`display -p -t ${windowId} '#{window_width};#{window_height};#{window_layout}'`);
      const [b, h, ...rest] = (z ?? '').split(';');
      this.vorZustand.push({ windowId, layout: rest.join(';'), cols: parseInt(b, 10), rows: parseInt(h, 10) });
    }
    // Der ALTE Wert wird genau einmal festgehalten -- er ist das, was beim
    // Abloesen wieder hergestellt wird.
    if (this.windowSizeVorher === null) {
      const [wert] = await this.command(`show-options -t ${this.target()} -qv window-size`);
      this.windowSizeVorher = wert ?? '';
    }
    // Dass 'manual' GILT, wird dagegen jedes Mal nachgesehen, nicht nur beim
    // ersten Fenster: die Option kann von aussen zurueckgestellt werden (ein
    // `set-option -u`, ein zweites Programm, ein Abloesen mitten im Lauf), und
    // ohne sie rechnet tmux die Fenstergroesse wieder aus den angehaengten
    // Clients. Die Buehne verliert ihre Flaeche dann an das schmalste Terminal
    // und bekommt sie NIE zurueck -- gemessen am 06.08.: 208 Spalten gestellt,
    // 144 vom angehaengten Terminal durchgesetzt, 515 Bildpunkte dauerhaft leer.
    const [jetzt] = await this.command(`show-options -t ${this.target()} -qv window-size`).catch(() => ['']);
    if ((jetzt ?? '') !== 'manual') {
      await this.command(`set-option -t ${this.target()} window-size manual`);
    }
  }

  /**
   * Die Fenstergroesse eines Panes auf die Buehne nachziehen -- OHNE Zoom und
   * ohne den aktiven Pane anzufassen.
   *
   * Der Unterschied zu `zoomPane` ist Absicht. Zoom ist eine Ansichtssache, die
   * ein MENSCH gewaehlt hat: `resize-pane -Z` macht den Pane in tmux auch
   * aktiv, und der aktive Pane einer fremden Session gehoert dem Menschen
   * davor. Zieht das Programm dagegen nur eine Aenderung von aussen nach, darf
   * es dort nichts umstellen -- die GROESSE aber muss es trotzdem setzen.
   *
   * Ohne diesen Weg endete jede Groesse von aussen als neue Wahrheit: das
   * Programm zeichnete brav nach, was tmux hergab, und die Flaeche, die es
   * vorher hatte, kam nie wieder (Befund des Nutzers vom 06.08.).
   */
  async fensterNachziehen(paneId: string, cols: number, rows: number): Promise<{ cols: number; rows: number }> {
    assertPaneId(paneId);
    const c = Math.max(20, Math.min(999, Math.floor(cols)));
    const r = Math.max(5, Math.min(999, Math.floor(rows)));
    const [windowId] = await this.command(`display -p -t ${paneId} '#{window_id}'`);
    if (!/^@\d+$/.test(windowId ?? '')) throw new Error(`kein Fenster zu Pane ${paneId}`);
    await this.merkeFenster(windowId);
    await this.command(`resize-window -t ${windowId} -x ${c} -y ${r}`);
    const [z] = await this.command(`display -p -t ${paneId} '#{pane_width}x#{pane_height}'`);
    const [a, b] = (z ?? '0x0').split('x').map((n) => parseInt(n, 10) || 0);
    return { cols: a, rows: b };
  }

  /**
   * Einen einzelnen Pane gross zeigen. tmux hat dafuer ein eigenes Mittel:
   * Zoom belegt das ganze Fenster mit einem Pane und haelt die Aufteilung
   * daneben fest. Das ist der Weg fuer einen Pane, der als eine Zeile von
   * zweiundfuenfzig daliegt -- ihn ueber die Fenstergroesse gross zu rechnen
   * hiesse, das Fenster ins Absurde wachsen zu lassen und die uebrigen Panes
   * mitzuzerren.
   */
  async zoomPane(paneId: string, cols: number, rows: number): Promise<{ cols: number; rows: number }> {
    assertPaneId(paneId);
    const c = Math.max(20, Math.min(999, Math.floor(cols)));
    const r = Math.max(5, Math.min(999, Math.floor(rows)));
    const [windowId] = await this.command(`display -p -t ${paneId} '#{window_id}'`);
    if (!/^@\d+$/.test(windowId ?? '')) throw new Error(`kein Fenster zu Pane ${paneId}`);
    await this.merkeFenster(windowId);
    await this.entzoomen();
    const [flagge] = await this.command(`display -p -t ${windowId} '#{window_zoomed_flag}'`);
    if (flagge !== '1') {
      await this.command(`resize-pane -Z -t ${paneId}`);
      this.gezoomt = paneId;
    }
    await this.command(`resize-window -t ${windowId} -x ${c} -y ${r}`);
    const [z] = await this.command(`display -p -t ${paneId} '#{pane_width}x#{pane_height}'`);
    const [a, b] = (z ?? '0x0').split('x').map((n) => parseInt(n, 10) || 0);
    return { cols: a, rows: b };
  }

  /** Nimmt einen von UNS gesetzten Zoom zurueck. Fremde Zooms bleiben. */
  private async entzoomen(): Promise<void> {
    if (!this.gezoomt) return;
    const pane = this.gezoomt;
    this.gezoomt = '';
    try {
      const [flagge] = await this.command(`display -p -t ${pane} '#{window_zoomed_flag}'`);
      if (flagge === '1') await this.command(`resize-pane -Z -t ${pane}`);
    } catch {
      // Der Pane kann weg sein -- dann ist auch der Zoom weg.
    }
  }

  /** Einen Pane aktiv setzen. Die Kennung wird geprueft, nicht eingesetzt (B4). */
  async selectPane(paneId: string): Promise<void> {
    await this.command(`select-pane -t ${assertPaneId(paneId)}`);
  }

  /** Bytes als Tastendruecke in einen Pane. -H nimmt Hex und deutet nichts um. */
  async sendBytes(paneId: string, bytes: Buffer): Promise<void> {
    assertPaneId(paneId);
    if (!bytes.length) return;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    await this.command(`send-keys -t ${paneId} -H ${hex}`);
  }

  /** Benannte Taste (Enter, C-c, Escape). Der Name wird eng geprueft (B4). */
  async sendKeyName(paneId: string, name: string): Promise<void> {
    assertPaneId(paneId);
    if (!/^[A-Za-z0-9_^-]{1,32}$/.test(name)) throw new Error(`unzulaessiger Tastenname: ${JSON.stringify(name)}`);
    await this.command(`send-keys -t ${paneId} ${name}`);
  }

  /** Schaltet auf laufende Ausgabe und spielt das Gesammelte nach. */
  startStreaming(): void {
    this.streaming = true;
    // Der Uebergang in den laufenden Betrieb hebt jedes Anhalten auf: was
    // vorher gesammelt wurde, geht jetzt vollstaendig heraus.
    this.pausiert.clear();
    const rest = this.outQueue;
    this.outQueue = [];
    for (const o of rest) this.emit('output', o.paneId, o.data);
  }

  /**
   * Gegenstueck zu capturePane: die Ausgabe dieses Panes laeuft wieder, und was
   * seit der Aufnahme aufgelaufen ist, wird in seiner Reihenfolge nachgespielt.
   * Zu rufen, NACHDEM die Aufnahme an den Renderer gegangen ist -- sonst
   * ueberholt der Strom das Bild, auf dem er aufsetzt.
   */
  fortsetzen(paneId: string): void {
    if (!this.pausiert.delete(paneId)) return;
    const rest = this.outQueue.filter((o) => o.paneId === paneId);
    this.outQueue = this.outQueue.filter((o) => o.paneId !== paneId);
    if (!this.streaming) {
      // Vor startStreaming() gehoert alles weiter in die gemeinsame Reihe.
      this.outQueue.push(...rest);
      return;
    }
    for (const o of rest) this.emit('output', o.paneId, o.data);
  }

  /**
   * Rohen Befehl in den Steuerkanal, Antwort zwischen %begin und %end. Was hier
   * hineingeht, ist eine ZEILE: kein Aufrufer setzt ungeprueften Text ein --
   * dafuer stehen assertPaneId und assertSessionName (B4).
   */
  command(cmd: string, atEnd?: () => void): Promise<string[]> {
    if (!this.proc || this.closed) return Promise.reject(new Error('Steuerclient nicht verbunden'));
    if (/[\r\n]/.test(cmd)) return Promise.reject(new Error('Befehl enthaelt einen Zeilenumbruch'));
    return new Promise<string[]>((resolve, reject) => {
      const eintrag: Pending = { resolve, reject, atEnd };
      // DIE FRIST, UND WARUM DER EINTRAG TROTZDEM STEHEN BLEIBT: die Antworten
      // kommen in der Reihenfolge der Befehle, und diese Warteschlange ist die
      // einzige Zuordnung dazu. Wer einen abgelaufenen Eintrag herausnimmt,
      // gibt die naechste Antwort dem falschen Aufrufer. Also bleibt er
      // stehen, nur als `abgelaufen` markiert -- seine Antwort wird verworfen,
      // wenn sie doch noch kommt.
      eintrag.uhr = setTimeout(() => {
        eintrag.abgelaufen = true;
        reject(new Error(`tmux antwortete nicht in ${BEFEHL_FRIST_MS} ms auf: ${cmd}`));
      }, BEFEHL_FRIST_MS);
      this.pending.push(eintrag);
      // Und ein Ohr am Schreibweg (Befund 6): stirbt der Steuerclient zwischen
      // Spawn und Write, kaeme das EPIPE sonst als unbehandelte Ausnahme im
      // Hauptprozess an. Es gehoert dem Befehl, der gerade hinausgeht.
      this.proc!.stdin.write(cmd + '\n', (fehler) => {
        if (!fehler || eintrag.abgelaufen) return;
        eintrag.abgelaufen = true;
        if (eintrag.uhr) clearTimeout(eintrag.uhr);
        reject(new Error(`Befehl liess sich nicht schicken: ${fehler.message}`));
      });
    });
  }

  /**
   * ZWEI BEFEHLE IN EINER ZEILE -- und damit im selben Augenblick.
   *
   * tmux arbeitet eine Befehlsliste in EINEM Durchlauf seiner Ereignisschleife
   * ab: dazwischen liest es nicht vom Pane. GEMESSEN auf eigenem Socket unter
   * Dauerausgabe (200 Listen, je zwei Bloecke): zwischen den beiden Bloecken
   * EINER Liste stand kein einziges Mal ein %output, zwischen zwei Listen bei
   * 199 von 199 Gelegenheiten. Genau das braucht `capturePane`: Cursor und
   * Inhalt muessen denselben Schirm meinen.
   *
   * Zurueck kommen zwei Bloecke, in der Reihenfolge der Befehle. `atEnd` haengt
   * am ZWEITEN -- dort steht der Augenblick, bis zu dem die Aufnahme reicht.
   *
   * Und wenn der erste scheitert: tmux bricht die Liste ab, der zweite Block
   * kaeme nie, und die Warteschlange stuende von da an um eins verschoben --
   * jede folgende Antwort ginge an den falschen Aufrufer. Deshalb `zieheNachsten`.
   */
  private commandPaar(a: string, b: string, atEnd?: () => void): Promise<[string[], string[]]> {
    if (/[\r\n]/.test(a) || /[\r\n]/.test(b)) return Promise.reject(new Error('Befehl enthaelt einen Zeilenumbruch'));
    const ersteAntwort = new Promise<string[]>((resolve, reject) => {
      const eintrag: Pending = { resolve, reject, zieheNachsten: true };
      eintrag.uhr = setTimeout(() => {
        eintrag.abgelaufen = true;
        reject(new Error(`tmux antwortete nicht in ${BEFEHL_FRIST_MS} ms auf: ${a}`));
      }, BEFEHL_FRIST_MS);
      this.pending.push(eintrag);
    });
    const zweiteAntwort = this.command(`${a} ; ${b}`, atEnd);
    return Promise.all([ersteAntwort, zweiteAntwort]);
  }

  private waitFor(event: string, ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`tmux meldete kein %${event} in ${ms} ms`)), ms);
      this.once(event, () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private feed(chunk: Buffer): void {
    this.rest = Buffer.concat([this.rest, chunk]);
    let nl: number;
    while ((nl = this.rest.indexOf(0x0a)) >= 0) {
      let roh = this.rest.subarray(0, nl);
      this.rest = this.rest.subarray(nl + 1);
      if (roh[roh.length - 1] === 0x0d) roh = roh.subarray(0, roh.length - 1);
      // %output bleibt BYTES und wird nie in einen String uebersetzt.
      //
      // tmux zerlegt lange Ausgabe in mehrere %output-Zeilen und schneidet
      // dabei mitten durch ein Zeichen: die Trennlinie einer Agenten-
      // Oberflaeche ist bei 178 Spalten ueber 500 Byte lang, und der Schnitt
      // fiel zwischen das erste und das zweite Byte eines U+2500. Wer die
      // Zeile fuer sich nach UTF-8 uebersetzt, macht aus den zwei Haelften
      // drei Ersatzzeichen -- gemessen als U+FFFD mitten im Strich, und weil
      // ein Zeichen zu zweien oder dreien wird, rutscht der Rest der Zeile um
      // eine Zelle weiter und bricht um. Als Bytes weitergereicht setzt der
      // Decoder von xterm die beiden Haelften wieder zusammen.
      if (!this.inBlock && roh.length >= 8 && roh.subarray(0, 8).toString('latin1') === '%output ') {
        this.outputZeile(roh.subarray(8));
        continue;
      }
      this.line(roh.toString('utf8'));
    }
  }

  /** Der Rest einer %output-Zeile: Pane-Kennung, Leerzeichen, rohe Nutzlast. */
  private outputZeile(roh: Buffer): void {
    const sp = roh.indexOf(0x20);
    const paneId = (sp < 0 ? roh : roh.subarray(0, sp)).toString('latin1');
    let bytes = unescapeOutputBytes(sp < 0 ? Buffer.alloc(0) : roh.subarray(sp + 1));
    // Das Angefangene vom letzten Mal gehoert vorne dran, das Angefangene von
    // diesem Mal wird zurueckgehalten. Danach ist JEDER weitergereichte Block
    // eine ganze Zahl von Zeichen UND von Steuerfolgen -- und nur so bleibt es
    // heil, wenn dazwischen eine Momentaufnahme geschrieben, ein Stueck
    // verworfen oder das Terminal zurueckgesetzt wird: der Parser von xterm
    // haelt eine halbe Folge zwar ueber zwei Schreibvorgaenge, aber nicht ueber
    // ein reset() -- und ueber ein weggeworfenes Stueck erst recht nicht
    // (siehe ohneAngefangeneFolge).
    const offen = this.offeneBytes.get(paneId);
    if (offen && offen.length) bytes = Buffer.concat([offen, bytes]);
    const [ganz, rest] = ohneAngefangenes(bytes);
    if (rest.length) this.offeneBytes.set(paneId, rest);
    else this.offeneBytes.delete(paneId);
    if (!ganz.length) return;
    if (this.streaming && !this.pausiert.has(paneId)) this.emit('output', paneId, ganz);
    else this.outQueue.push({ seq: ++this.outSeq, paneId, data: ganz });
  }

  private line(line: string): void {
    // Die Kennung MUSS verglichen werden: der Inhalt eines Blocks kommt roh
    // durch, tmux schuetzt Zeilen im Blockinhalt nicht. Ein Pane, in dem eine
    // Zeile mit %end anfaengt -- etwa weil ein Agent ueber den Steuermodus
    // schreibt --, beendet sonst den Block eines fremden Befehls: die
    // Momentaufnahme bricht still ab, %error laesst das Anhaengen ganz
    // scheitern, und bei zwei gleichzeitigen Befehlen rutscht die
    // Warteschlange um eins weiter.
    const block = /^%(begin|end|error) (\d+) (\d+) (\d+)$/.exec(line);

    if (this.inBlock) {
      if (block && block[1] !== 'begin' && `${block[2]} ${block[3]}` === this.blockId) {
        this.inBlock = false;
        this.blockId = '';
        const lines = this.blockLines;
        const failed = block[1] === 'error';
        this.blockLines = [];
        const p = this.pending.shift();
        if (p) {
          if (p.uhr) clearTimeout(p.uhr);
          p.atEnd?.();
          // Der Partner aus derselben Zeile stirbt mit: tmux bricht eine
          // Befehlsliste beim ersten Fehler ab, sein Block kaeme nie, und die
          // Warteschlange stuende von da an um eins verschoben (commandPaar).
          if (failed && p.zieheNachsten) {
            const partner = this.pending.shift();
            if (partner) {
              if (partner.uhr) clearTimeout(partner.uhr);
              if (!partner.abgelaufen) {
                partner.reject(new Error(lines.join('\n') || 'tmux meldete einen Fehler'));
              }
            }
          }
          // Eine Antwort auf einen abgelaufenen Befehl wird verworfen: sein
          // Aufrufer hat seine Absage laengst bekommen.
          if (p.abgelaufen) return;
          if (failed) p.reject(new Error(lines.join('\n') || 'tmux meldete einen Fehler'));
          else p.resolve(lines);
        }
        return;
      }
      this.blockLines.push(line);
      return;
    }

    if (block && block[1] === 'begin') {
      this.inBlock = true;
      this.blockId = `${block[2]} ${block[3]}`;
      this.blockLines = [];
      return;
    }
    // %output kommt hier nicht mehr an -- feed() nimmt es vorher als Bytes ab.
    // Eine Zeile INNERHALB eines Blocks, die zufaellig so anfaengt, gehoert zum
    // Blockinhalt und wird oben schon abgefangen.
    if (line.startsWith('%session-changed')) {
      this.emit('session-changed', line.split(' ').slice(1));
      return;
    }
    if (line.startsWith('%exit')) {
      this.emit('exit', line.slice(6));
      return;
    }
    if (line.startsWith('%layout-change') || line.startsWith('%window-add') || line.startsWith('%window-close') || line.startsWith('%window-renamed')) {
      this.emit('layout', line);
      return;
    }
    this.emit('notification', line);
  }

  /** Loest den Steuerclient. Die tmux-Session laeuft weiter (V4-Grundlage). */
  /**
   * Den Kanal WEGWERFEN, ohne tmux noch etwas zu fragen.
   *
   * Fuer den einen Fall, in dem `detach()` nicht taugt: die Session ist weg.
   * Dann gibt es nichts zurueckzustellen -- ihre Fenster existieren nicht mehr
   * --, und jede Frage an den Steuerclient bleibt unbeantwortet. GEMESSEN am
   * 06.08.: nach dem Loeschen der gezeichneten Sitzung blieb das Programm im
   * Zurueckstellen stehen und beantwortete auch kein `ping` mehr. Diese Fassung
   * ist synchron und kann per Bauart nicht haengen.
   */
  aufgeben(): void {
    this.closed = true;
    for (const p of this.pending.splice(0)) {
      if (p.uhr) clearTimeout(p.uhr);
      p.reject(new Error('Steuerclient aufgegeben'));
    }
    const p = this.proc;
    this.proc = null;
    // Es gibt nichts mehr zurueckzustellen: die Fenster sind mit der Session
    // gegangen. Die Buchfuehrung wird geleert, damit auch der Ausstieg nichts
    // mehr an einer Session versucht, die es nicht gibt.
    this.vorZustand = [];
    this.windowSizeVorher = null;
    this.gezoomt = '';
    try {
      p?.kill('SIGTERM');
    } catch {
      // Schon weg -- genau das, was hier erreicht werden soll.
    }
  }

  async detach(): Promise<void> {
    const p = this.proc;
    if (!p || this.closed) return;
    // Erst zurueckstellen, dann gehen: danach ist der Kanal zu.
    //
    // MIT FRIST, und die ist nicht vorsorglich. Jeder Befehl dieses Kanals
    // wartet auf eine Antwort von tmux; ist die SESSION weg -- geschlossen oder
    // eben geloescht --, kommt sie nie, und `zustandZurueck` wartete darauf
    // ohne Ende. GEMESSEN am 06.08.: nach dem Loeschen der gerade gezeichneten
    // Sitzung stand das ganze Programm und beantwortete auch kein `ping` mehr.
    // Zwei Sekunden reichen einem lebenden tmux um Groessenordnungen (er
    // antwortet in Millisekunden); einem toten reichen auch zwei Stunden nicht.
    //
    // Fern das Doppelte: dieselben Befehle, aber jede Antwort geht ueber die
    // Leitung. Mehr waere falsch herum gedacht -- auf einer lebenden Leitung
    // sind es ein halbes Dutzend Umlaeufe von Millisekunden, und auf einer toten
    // wartet hier ein Mensch vor einem Fenster, das nicht weiterschaltet.
    await Promise.race([
      this.zustandZurueck().catch(() => undefined),
      new Promise<void>((r) => { setTimeout(r, this.maschine ? 4000 : 2000); }),
    ]);
    await new Promise<void>((resolve) => {
      const done = setTimeout(() => {
        p.kill('SIGTERM');
        resolve();
      }, 2000);
      p.once('exit', () => {
        clearTimeout(done);
        resolve();
      });
      try {
        p.stdin.end();
      } catch {
        p.kill('SIGTERM');
      }
    });
    this.proc = null;
  }
}

/**
 * tmux ersetzt in %output jedes Zeichen ausserhalb des druckbaren ASCII durch
 * eine dreistellige Oktalfolge. Zurueckuebersetzt ergibt das wieder die Bytes,
 * die das Terminal gesendet hat -- Umlaute und Steuersequenzen eingeschlossen.
 */
export function unescapeOutput(data: string): Buffer {
  return unescapeOutputBytes(Buffer.from(data, 'utf8'));
}

/**
 * WIEVIEL EINER ANGEFANGENEN STEUERFOLGE HOECHSTENS ZURUECKGEHALTEN WIRD.
 *
 * Eine Folge, die nie endet, darf den Pane nicht anhalten: ein Programm, das
 * `ESC ]0;` schreibt und den Titel nie abschliesst, wuerde sonst alles Weitere
 * mit zurueckhalten. Ab diesem Deckel geht der Rest hinaus, wie er ist -- ein
 * sichtbarer Rest ist besser als ein Fenster, das stehenbleibt. 4096 liegt
 * weit ueber jeder echten Folge (die laengste ist ein Titel, und der ist
 * selten laenger als ein paar hundert Bytes).
 */
const FOLGE_DECKEL = 4096;

/**
 * Ist das eine VOLLSTAENDIGE Steuerfolge? `rest` faengt mit ESC an.
 *
 * Die drei Formen, die vorkommen -- mehr braucht es nicht, weil hinter dem
 * letzten ESC des Blocks nie ein zweites steht:
 *   CSI  `ESC [` Parameter/Zwischenzeichen, dann ein Endzeichen 0x40..0x7e
 *   OSC und Verwandte (`ESC ] P X ^ _`): bis BEL; das andere Ende (ST) faengt
 *        selbst mit ESC an und waere dann das letzte
 *   sonst `ESC` Zwischenzeichen 0x20..0x2f, dann ein Endzeichen 0x30..0x7e
 */
function folgeFertig(rest: Buffer): boolean {
  if (rest.length < 2) return false;
  const art = rest[1];
  if (art === 0x5b) {
    for (let i = 2; i < rest.length; i++) if (rest[i] >= 0x40 && rest[i] <= 0x7e) return true;
    return false;
  }
  if (art === 0x5d || art === 0x50 || art === 0x58 || art === 0x5e || art === 0x5f) {
    return rest.indexOf(0x07, 2) >= 0;
  }
  let i = 1;
  while (i < rest.length && rest[i] >= 0x20 && rest[i] <= 0x2f) i++;
  return i < rest.length && rest[i] >= 0x30 && rest[i] <= 0x7e;
}

/**
 * Trennt eine Steuerfolge ab, die am Ende angefangen, aber nicht fertig ist.
 *
 * WARUM DAS SEIN MUSS (16.08., gemessene Ursache der verrutschten Darstellung):
 * tmux zerlegt lange Ausgabe in mehrere %output-Zeilen und schneidet dabei
 * mitten durch eine Steuerfolge -- gemessen auf eigenem Socket 7 % aller
 * Stuecke, bei einem langsam lesenden Client ueber die Haelfte. Solange die
 * beiden Haelften unmittelbar nacheinander in dasselbe Terminal laufen, ist das
 * gleichgueltig: der Parser von xterm haelt seinen Zustand ueber zwei
 * Schreibvorgaenge. Dazwischen passiert aber zweierlei, und beides zerreisst
 * die Folge:
 *
 *   1  `capturePane` VERWIRFT die gesammelten Stuecke bis zur Marke, weil die
 *      Momentaufnahme sie schon enthaelt. Faellt die Marke zwischen die beiden
 *      Haelften, ist die erste weg und die zweite kommt als TEXT im Fenster an.
 *      Gemessen (test-app-steuerfolgen-naht.sh): genau ein solcher Schnitt, und
 *      genau eine beschaedigte Zeile im Puffer.
 *   2  Die Momentaufnahme selbst faengt mit `ESC [ 2 J` an. Ein ESC bricht eine
 *      laufende Folge ab -- die erste Haelfte ist damit wirkungslos, die zweite
 *      wird gedruckt.
 *
 * Sichtbar wird das als Rest einer Farbfolge im Text (`8;5;153m` in des Nutzers
 * Bildschirmfoto vom 16.08.) und, wenn die zerschnittene Folge den Cursor
 * gesetzt haette, als zwei ineinandergeschriebene Bildschirmzustaende: der
 * neue Text landet dort, wo der Cursor zufaellig steht, statt dort, wo die
 * Anwendung ihn haben wollte.
 *
 * Zurueckgehalten wird deshalb hier, an derselben Stelle wie ein angefangenes
 * Zeichen -- danach ist JEDES weitergereichte Stueck eine ganze Zahl von
 * Zeichen UND von Steuerfolgen, und weder ein Verwerfen noch eine
 * Momentaufnahme kann eine Folge in der Mitte treffen.
 */
export function ohneAngefangeneFolge(buf: Buffer): [Buffer, Buffer] {
  const i = buf.lastIndexOf(0x1b);
  if (i < 0) return [buf, Buffer.alloc(0)];
  if (buf.length - i > FOLGE_DECKEL) return [buf, Buffer.alloc(0)];
  const rest = buf.subarray(i);
  if (folgeFertig(rest)) return [buf, Buffer.alloc(0)];
  return [buf.subarray(0, i), rest];
}

/**
 * Beides zusammen: was vollstaendig ist, und der angefangene Rest -- ein
 * halbes Zeichen ODER eine halbe Steuerfolge. Das ist die Fassung, die im
 * Betrieb gerufen wird.
 */
export function ohneAngefangenes(buf: Buffer): [Buffer, Buffer] {
  const [ganz, rest] = ohneAngefangeneFolge(buf);
  if (rest.length) return [ganz, rest];
  return ohneAngefangenesZeichen(buf);
}

/**
 * Trennt die Bytes eines Zeichens ab, das am Ende noch nicht fertig ist.
 * Zurueck kommt das, was vollstaendig ist, und der angefangene Rest. Ein
 * ungueltiges Byte bleibt drin, statt den Strom anzuhalten -- xterm zeigt dafuer
 * ein Ersatzzeichen, und das ist ehrlicher als ein Block, der nie ankommt.
 */
export function ohneAngefangenesZeichen(buf: Buffer): [Buffer, Buffer] {
  for (let i = buf.length - 1; i >= 0 && i >= buf.length - 3; i--) {
    const b = buf[i];
    if ((b & 0xc0) === 0x80) continue; // Folgebyte -- weiter nach vorn schauen
    const laenge = (b & 0x80) === 0 ? 1 : (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : (b & 0xf8) === 0xf0 ? 4 : 1;
    if (laenge > 1 && buf.length - i < laenge) return [buf.subarray(0, i), buf.subarray(i)];
    break;
  }
  return [buf, Buffer.alloc(0)];
}

/**
 * Dasselbe auf BYTES statt auf einem String. Das ist die Fassung, die im
 * Betrieb laeuft: alles, was nicht als Oktalfolge geschrieben steht, geht
 * unveraendert durch, also auch die Haelfte eines Zeichens an einer
 * Zeilengrenze. Erst dadurch bleibt eine ueber zwei %output-Zeilen verteilte
 * UTF-8-Folge heil.
 */
export function unescapeOutputBytes(data: Buffer): Buffer {
  const out: number[] = [];
  const oktal = (b: number): boolean => b >= 0x30 && b <= 0x37;
  for (let i = 0; i < data.length; i++) {
    if (
      data[i] === 0x5c && i + 3 < data.length
      && oktal(data[i + 1]) && oktal(data[i + 2]) && oktal(data[i + 3])
    ) {
      out.push(((data[i + 1] - 0x30) << 6) | ((data[i + 2] - 0x30) << 3) | (data[i + 3] - 0x30));
      i += 3;
      continue;
    }
    out.push(data[i]);
  }
  return Buffer.from(out);
}
