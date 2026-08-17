// EINE CHAT-SITZUNG ALS EIGENER PROZESS -- Start, Strom, Freigaben, Ende.
//
// WARUM DIE BLANKE CLI UND NICHT DAS AGENT-SDK (gemessen am 12.08., die
// Entscheidung steht mit ihren Zahlen im Ergebnisbericht):
//
//   1. Das SDK ist eine Huelle um GENAU DIESES Protokoll. Der Freigabe-Weg,
//      um den es hier vor allem geht, laeuft auch ohne SDK vollstaendig:
//      `--permission-prompt-tool stdio` plus der `initialize`-Handschlag
//      bringt `control_request/can_use_tool` auf stdout, und eine
//      `control_response` mit `behavior: "deny"` verhindert die Handlung
//      wirklich -- gemessen an einer echten Sitzung, die Datei entstand nicht.
//   2. Das SDK ueberlebt das Buendeln dieses Hauses NICHT. `app/build.mjs`
//      buendelt main.ts mit esbuild zu EINER Datei (nur 'electron' bleibt
//      aussen). Gebuendelt stirbt das SDK beim Laden an
//      `createRequire(undefined)` -- gemessen, reproduzierbar. Es aussen vor
//      zu lassen hiesse, 4,2 MB Abhaengigkeit mit auszuliefern, damit sie
//      denselben `claude`-Prozess startet, den diese Datei direkt startet.
//
// Damit kommt die Chat-Sitzung ohne eine einzige neue Laufzeit-Abhaengigkeit
// aus. Was das SDK an Bequemlichkeit bietet -- Typen fuer den Strom --, steht
// hier in chat/sdkstrom.ts, gegen echte Mitschnitte geprueft.
//
// EIN SCHREIBER JE SITZUNG. Eine Sitzung gehoert der App: auf derselben
// sessionId startet NIE zusaetzlich eine CLI. Das ist keine Hoeflichkeit,
// sondern die Bedingung dafuer, dass das Protokoll heil bleibt -- zwei
// Schreiber auf einer Unterhaltung ueberschreiben einander die Zuege.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { Gespraechsstrom, Zeilenleser, type Gespraech, type RohEreignis } from '../chat/sdkstrom';

/** Was eine Chat-Sitzung zum Starten braucht. */
export interface Auftrag {
  /** Der Projektordner -- das Arbeitsverzeichnis des Prozesses. */
  ordner: string;
  /** Das Modell, leer = die Vorgabe des Harness. */
  modell: string;
  /** Der Freigabemodus. Leer = die Vorgabe der CLI, NICHT hart verdrahtet. */
  modus: string;
  /** Die Sitzung des Harness, die fortgesetzt werden soll. Leer = neue. */
  fortsetzen: string;
  /**
   * DIE WERKSTATT: der Name der tmux-Session, in der die Worker DIESER Sitzung
   * landen sollen (Punkt 1). Er geht als `WB_SESSION` in die Umgebung des
   * Prozesses -- die erste Stufe, in der `pi-worker` sein Ziel sucht, und die
   * einzige, die eine Chat-Sitzung erfuellen kann (chatwerkstatt.ts,
   * Dateikopf). Leer = wie bisher, dann sucht sich `claude-worker` sein Ziel
   * selbst.
   */
  werkstatt?: string;
}

/**
 * DIE BEFEHLSZEILE, als eigene Funktion, weil sie die einzige Stelle ist, an
 * der eine falsche Annahme still bleibt: ein vergessenes Flag faellt nicht
 * auf, es macht nur die Anzeige aermer. Getrennt geprueft in
 * shell/tests/test-app-chatsdk-strom.sh.
 *
 * `--verbose` ist bei `--print --output-format stream-json` Pflicht (die CLI
 * verweigert sonst den Dienst); `--include-partial-messages` ist der Grund,
 * warum Text mitwaechst statt am Stueck zu erscheinen.
 */
export function baueArgumente(a: Auftrag): string[] {
  const args = [
    '--print',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    // Ohne dieses Flag fragt der Harness NICHT, er handelt (gemessen 12.08.).
    '--permission-prompt-tool', 'stdio',
  ];
  if (a.modell) args.push('--model', a.modell);
  // Der Modus wird NICHT hart verdrahtet: ohne Angabe gilt, was die CLI
  // ohnehin tut. Ein hier eingebautes 'acceptEdits' waere eine stille
  // Rechteerweiterung gegenueber dem, was der Mensch im Terminal gewohnt ist.
  if (a.modus) args.push('--permission-mode', a.modus);
  // GEMESSEN am 12.08. gegen die echte CLI, nicht nur gegen die Attrappe: ein
  // Zug merkt sich ein Wort, der Prozess wird beendet, ein zweiter startet mit
  // genau diesem Flag -- und die Antwort nennt das Wort wieder. Die
  // Sitzungskennung bleibt dabei dieselbe, es entsteht also keine Abzweigung.
  // Mitschnitt beider Zuege: ~/.pi-workers/results/chatsdk/resume/.
  if (a.fortsetzen) args.push('--resume', a.fortsetzen);
  return args;
}

export interface SitzungsHaken {
  /** Der Stand hat sich geaendert -- neu zeichnen. */
  aufStand(g: Gespraech): void;
  /** Der Prozess ist weg. `code` ist der Rueckgabewert, -1 wenn unbekannt. */
  aufEnde(code: number): void;
}

/**
 * EINE LAUFENDE CHAT-SITZUNG. Sie besitzt genau einen Prozess und beendet ihn
 * auch -- `beende()` ist keine Bitte, sondern eine Zusage mit Nachfassen
 * (SIGTERM, dann SIGKILL), damit kein Prozess die App ueberlebt.
 */
export class Chatsitzung {
  private kind: ChildProcessWithoutNullStreams | null = null;

  private readonly strom = new Gespraechsstrom();

  private readonly leser = new Zeilenleser();

  private nachfassen: NodeJS.Timeout | null = null;

  /** Die letzte Frist nach dem SIGKILL -- siehe `beende()`. */
  private aufgeben: NodeJS.Timeout | null = null;

  private laeuft = false;

  /** Zaehlt die Modus-Anfragen -- jede braucht ihre eigene Kennung. */
  private modusZaehler = 0;

  /** Dasselbe fuer die Unterbrechungen. */
  private haltZaehler = 0;

  constructor(
    private readonly auftrag: Auftrag,
    private readonly haken: SitzungsHaken,
    /** Der Befehl -- als Feld, damit die Tests einen Attrappen-Harness einsetzen koennen. */
    private readonly befehl = 'claude',
  ) {}

  stand(): Gespraech {
    return this.strom.stand();
  }

  istOffen(): boolean {
    return this.laeuft;
  }

  /** Den Prozess starten. Wirft nicht: ein Fehlstart landet als Meldung im Gespraech. */
  starte(): void {
    if (this.kind) return;
    const args = baueArgumente(this.auftrag);
    try {
      this.kind = spawn(this.befehl, args, {
        cwd: this.auftrag.ordner,
        stdio: ['pipe', 'pipe', 'pipe'],
        // WB_SESSION sagt `claude-worker`/`pi-worker`, WO die Worker dieser
        // Sitzung hingehoeren. Ohne ihn faellt die Suche dort auf „die
        // angehaengte wb-*-Session" zurueck, und der Worker landet in einer
        // fremden Workbench (gemessen, chatwerkstatt.ts).
        //
        // TMUX/TMUX_PANE WERDEN IMMER AUSGERAEUMT, auch OHNE Werkstatt
        // (Reviewbefund 7, 12.08.). Startet dieses Programm aus einem
        // tmux-Pane heraus, erbt der Chat-Prozess dessen Umgebung, und Stufe 1
        // der Ziel-Suche (`$TMUX_PANE`) kommt VOR WB_SESSION. Bis heute stand
        // die Bereinigung nur im Zweig MIT Werkstatt -- also genau dort, wo sie
        // ohnehin nicht noetig war. Fehlt die Werkstatt (tmux nicht
        // ausfuehrbar, `new-session` gescheitert), landete ein Worker in dem
        // Pane, aus dem die App gestartet wurde: in Fenster des Nutzers. Das ist
        // der einzige Fall, in dem der Schutz ueberhaupt zaehlt.
        env: {
          ...process.env,
          TMUX: undefined,
          TMUX_PANE: undefined,
          ...(this.auftrag.werkstatt ? { WB_SESSION: this.auftrag.werkstatt } : {}),
        },
      });
    } catch (fehler) {
      this.strom.melde(`Die Sitzung liess sich nicht starten: ${String(fehler)}`);
      this.haken.aufStand(this.strom.stand());
      this.haken.aufEnde(-1);
      return;
    }
    this.laeuft = true;

    this.kind.stdout.setEncoding('utf8');
    this.kind.stdout.on('data', (stueck: string) => {
      for (const zeile of this.leser.nimm(stueck)) this.zeile(zeile);
      this.haken.aufStand(this.strom.stand());
    });

    // stderr ist beim Harness der Ort fuer Startfehler (fehlende Anmeldung,
    // unbekanntes Modell). Still verschluckt wuerde daraus ein Fenster, das
    // ohne Grund leer bleibt.
    let fehlerText = '';
    this.kind.stderr.setEncoding('utf8');
    this.kind.stderr.on('data', (stueck: string) => {
      fehlerText += stueck;
      if (fehlerText.length > 4000) fehlerText = fehlerText.slice(-4000);
    });

    this.kind.on('error', (fehler) => {
      this.strom.melde(`Die Sitzung liess sich nicht starten: ${fehler.message}`);
      this.haken.aufStand(this.strom.stand());
    });

    // UND EIN OHR AM SCHREIBWEG (Befund 6 der Bugjagd, 15.08.). Ein Fehler beim
    // Schreiben auf stdin kommt ASYNCHRON: das try/catch um den `write` faengt
    // ihn nicht, und ohne diesen Listener wird er zur unbehandelten Ausnahme im
    // HAUPTPROZESS -- das Fenster mit allen Sitzungen ginge an einem einzelnen
    // toten Kind zugrunde. Nachgestellt in der Nacht zum 16.08. mit einem Harness, der sein
    // stdin schliesst und weiterlaeuft: `sende()` meldete Erfolg, und der
    // Prozess starb an „write EPIPE".
    //
    // INS PROTOKOLL, NICHT INS GESPRAECH: welche Zeile es traf, sagt der
    // Rueckruf in `schreibe()` an der richtigen Stelle im Verlauf. Dieser
    // Listener hat genau eine Aufgabe -- die Ausnahme abfangen.
    this.kind.stdin.on('error', (fehler: NodeJS.ErrnoException) => {
      process.stderr.write(`Chatsitzung: Schreibweg gestoert (${fehler.code ?? fehler.message})\n`);
    });

    this.kind.on('exit', (code) => {
      this.laeuft = false;
      this.kind = null;
      this.zeitgeberWeg();
      if (code !== 0 && code !== null) {
        this.strom.melde(
          fehlerText.trim()
            ? `Die Sitzung endete (Code ${code}): ${fehlerText.trim().slice(0, 600)}`
            : `Die Sitzung endete unerwartet (Code ${code}).`,
        );
      }
      this.haken.aufStand(this.strom.stand());
      this.haken.aufEnde(code ?? -1);
    });

    // DER HANDSCHLAG. Ohne ihn stellt der Harness keine Freigabefrage --
    // gemessen 12.08.: derselbe Aufruf ohne `initialize` fuehrte das Werkzeug
    // aus, statt zu fragen.
    this.schreibe({
      type: 'control_request',
      request_id: 'awb-init',
      request: { subtype: 'initialize', hooks: {} },
    });
  }

  private zeile(zeile: string): void {
    let e: RohEreignis;
    try {
      e = JSON.parse(zeile) as RohEreignis;
    } catch {
      // Eine unlesbare Zeile ist ein Befund, kein Grund zum Abbruch: der Rest
      // des Stroms bleibt brauchbar.
      return;
    }
    const folge = this.strom.nimm(e);
    // Eine Steuer-Anfrage, die wir nicht bedienen koennen, bekommt eine Absage
    // statt Schweigen -- sonst wartet der Harness auf eine Antwort, die nie
    // kommt (Befund B6, 12.08.).
    if (folge.fehlerAntwortFuer) {
      this.schreibe({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: folge.fehlerAntwortFuer,
          error: 'Diese Anfrage unterstuetzt die Agent-Workbench nicht.',
        },
      });
    }
  }

  /**
   * Eine Zeile an den Harness. `wozu` benennt, WAS gerade nicht ankam, falls es
   * schiefgeht -- der Fehler faellt asynchron an, lange nachdem der Aufrufer
   * seinen Rueckgabewert bekommen hat (Befund 6/10 der Bugjagd, 15.08.), und
   * eine Meldung ohne Bezug waere an dieser Stelle wertlos.
   */
  private schreibe(o: unknown, wozu = 'Das Abgeschickte'): boolean {
    if (!this.kind || !this.kind.stdin.writable) return false;
    try {
      this.kind.stdin.write(`${JSON.stringify(o)}\n`, (fehler) => {
        if (!fehler) return;
        this.strom.melde(`${wozu} kam beim Harness nicht an: ${fehler.message}`);
        this.haken.aufStand(this.strom.stand());
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Eine Meldung von aussen sichtbar ins Gespraech legen -- etwa der Hinweis
   * nach einem Fehlstart (Befund B3). Der Hauptprozess braucht diesen Weg,
   * weil nur er weiss, WARUM ein Start scheiterte.
   */
  melde(text: string): void {
    this.strom.melde(text);
    this.haken.aufStand(this.strom.stand());
  }

  /**
   * Eine Nachricht des Menschen abschicken.
   *
   * WAS IM VERLAUF STEHT, MUSS AUCH HINAUSGEGANGEN SEIN (Befund 10 der
   * Bugjagd, 15.08.). Bisher stand die Nachricht im Gespraech, bevor der
   * Schreibweg ueberhaupt gefragt war -- scheiterte er, las der Mensch seinen
   * eigenen Satz und wartete auf eine Antwort, die niemand je bekommen hatte.
   * Der Text bleibt trotzdem sichtbar (er waere sonst verloren), aber er
   * bekommt seine Meldung DANEBEN und `sende()` sagt Nein. Was erst spaeter
   * scheitert, meldet `schreibe()` nach (dort die Erklaerung).
   */
  sende(text: string): boolean {
    if (!text.trim()) return false;
    if (!this.kind) return false;
    this.strom.mensch(text);
    const gelungen = this.schreibe({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: this.strom.stand().sessionId || 'awb',
    }, 'Die Nachricht');
    if (!gelungen) {
      this.strom.melde('Diese Nachricht ging nicht hinaus: der Schreibweg zum Harness ist zu.');
    }
    this.haken.aufStand(this.strom.stand());
    return gelungen;
  }

  /**
   * Eine Freigabe beantworten. Die Antwort geht als `control_response`
   * zurueck -- dieselbe Form, mit der die Messfahrt vom 12.08. ein Schreiben
   * verhindert hat.
   */
  entscheide(anfrageId: string, erlauben: boolean, grund = ''): boolean {
    if (!this.strom.entscheide(anfrageId, erlauben)) return false;
    const antwort = erlauben
      ? { behavior: 'allow', updatedInput: undefined as unknown }
      : { behavior: 'deny', message: grund || 'Vom Menschen abgelehnt.' };
    const gelungen = this.schreibe({
      type: 'control_response',
      response: { subtype: 'success', request_id: anfrageId, response: antwort },
    });
    this.haken.aufStand(this.strom.stand());
    return gelungen;
  }

  /**
   * DEN FREIGABEMODUS ZUR LAUFZEIT UMSTELLEN (Luecke 5c, gemessen am 12.08.).
   *
   * DIE MESSUNG: gegen die echte CLI 2.1.228 wurde
   * `{"type":"control_request","request_id":"awb-modus-1","request":
   * {"subtype":"set_permission_mode","mode":"acceptEdits"}}` geschickt; die
   * Antwort war `{"subtype":"success","request_id":"awb-modus-1",
   * "response":{"mode":"acceptEdits"}}`. Der Modus ist also NICHT nur beim
   * Start setzbar -- die Vermutung im Auftrag („wenn nur beim Start setzbar,
   * dann Wahl beim Anlegen + Neustart-Weg") trifft nicht zu, und der teure
   * Umweg ueber einen Neustart entfaellt.
   *
   * Die Kennung faengt mit `awb-modus` an, weil der Strom daran erkennt, dass
   * eine Absage die Modusliste traegt (sdkstrom.ts, `steuerantwort`).
   */
  setzeModus(modus: string): boolean {
    if (!modus) return false;
    this.modusZaehler += 1;
    return this.schreibe({
      type: 'control_request',
      request_id: `awb-modus-${this.modusZaehler}`,
      request: { subtype: 'set_permission_mode', mode: modus },
    });
  }

  /**
   * EINEN LAUFENDEN ZUG UNTERBRECHEN (Punkt 6, gemessen am 12.08.).
   *
   * Derselbe Weg, denselben Handschlag vorausgesetzt:
   * `{"subtype":"interrupt"}` wird mit `{"subtype":"success","response":
   * {"still_queued":[]}}` beantwortet. Das ist das Gegenstueck zu Escape im
   * Terminal -- ohne es bleibt einer Chat-Sitzung nur das Beenden des ganzen
   * Prozesses, und damit faellt der Verlauf mit.
   */
  halte(): boolean {
    this.haltZaehler += 1;
    // GEMELDET WIRD ERST, WENN DER HARNESS GEANTWORTET HAT (Reviewbefund 4,
    // 12.08.). Hier stand die Zeile „Der Zug wurde unterbrochen", sobald das
    // SCHREIBEN auf stdin gelungen war -- das sagt nur, dass die Bytes den
    // Prozess erreicht haben, nicht dass er sie befolgt. Lehnt er ab (aus
    // SEINER Sicht laeuft kein Zug, oder eine spaetere Fassung antwortet
    // anders), stuende im Verlauf eine Unterbrechung, waehrend die Antwort
    // weiterlaeuft. Beide Ausgaenge wertet jetzt der Strom aus, ueber genau
    // diese Kennung (sdkstrom.ts, `steuerantwort`).
    return this.schreibe({
      type: 'control_request',
      request_id: `awb-halt-${this.haltZaehler}`,
      request: { subtype: 'interrupt' },
    });
  }

  /**
   * DAS SIGNAL SOFORT, OHNE JEDES WARTEN (Befund B5, gemessen am 12.08.).
   *
   * Auf einen Signaleingang beendet Electron den Prozess SELBST -- gemessen
   * rund 400 ms nach einem SIGTERM, mitten in `shutdown()`, lange vor dem
   * Nachfassen nach zwei Sekunden. Alles, was in dieser Zeitspanne noch
   * wirken soll, muss synchron laufen. Deshalb bekommt das Kind sein SIGTERM
   * hier auf der Stelle, statt am Ende einer Kette von Versprechen.
   */
  signalSofort(): void {
    const kind = this.kind;
    if (!kind) return;
    this.laeuft = false;
    try {
      kind.kill('SIGTERM');
    } catch {
      // Schon weg -- dann ist nichts mehr zu tun.
    }
  }

  /**
   * DIE KENNUNG DES KINDES, 0 wenn es keins gibt. Ob es noch lebt, entscheidet
   * der Aufrufer -- waehrend des synchronen Beendens taugt weder `exitCode`
   * noch Signal 0 dafuer, siehe `lebt()` in chatbuehne.ts.
   */
  kindPid(): number {
    return this.kind?.pid ?? 0;
  }

  /**
   * BEENDEN MIT NACHFASSEN -- UND MIT ZUSAGE (Befunde B5 und B8, 12.08.).
   *
   * Zurueckgegeben wird ein Versprechen, das erst faellt, wenn das Kind
   * WIRKLICH weg ist. Vorher stellte diese Funktion den SIGKILL nur in einen
   * Zeitgeber und kehrte sofort zurueck; beim Herunterfahren der App lief
   * `app.exit()` in aller Regel frueher als die zwei Sekunden, und ein Kind,
   * das auf SIGTERM nicht reagiert, ueberlebte die App ohne Fenster. Wer
   * zusagt, dass nichts uebrig bleibt, muss nachsehen.
   *
   * `istOffen()` sagt ab dem ersten Signal „nein". Bis dahin meldete es
   * weiter „laeuft", und die Sessionleiste zeigte einen Punkt fuer eine
   * Sitzung, die gerade getoetet wurde.
   */
  async beende(): Promise<void> {
    const kind = this.kind;
    if (!kind) {
      // Auch der zweite Aufruf raeumt auf: `alleBeenden()` und das
      // `closed`-Ereignis des Fensters rufen beide hierher (Befund B8).
      this.zeitgeberWeg();
      return;
    }
    // Ab jetzt ist diese Sitzung nicht mehr offen -- unabhaengig davon, wie
    // lange das Kind noch braucht.
    this.laeuft = false;
    this.zeitgeberWeg();

    try {
      kind.stdin.end();
    } catch {
      // stdin war schon zu -- das Beenden geht trotzdem weiter.
    }
    try {
      kind.kill('SIGTERM');
    } catch {
      // Der Prozess war schon weg.
    }

    await new Promise<void>((fertig) => {
      if (kind.exitCode !== null || kind.signalCode !== null) {
        fertig();
        return;
      }
      let erledigt = false;
      const schliessen = (): void => {
        if (erledigt) return;
        erledigt = true;
        this.zeitgeberWeg();
        fertig();
      };
      kind.once('exit', schliessen);
      kind.once('close', schliessen);
      this.nachfassen = setTimeout(() => {
        // Nachgesehen, nicht angenommen: nur toeten, was noch da ist.
        try {
          if (kind.exitCode === null && kind.signalCode === null) kind.kill('SIGKILL');
        } catch {
          // Zwischen Pruefung und Signal beendet -- nichts mehr zu tun.
        }
        // Auch nach SIGKILL wird auf das echte Ende gewartet, aber nicht
        // ewig: ein Kind, das selbst darauf nicht faellt, darf das Beenden
        // der App nicht aufhalten.
        this.aufgeben = setTimeout(schliessen, 1500);
        this.aufgeben.unref?.();
      }, 2000);
      this.nachfassen.unref?.();
    });
  }

  /** Beide Zeitgeber loeschen -- zweimal `beende()` liess sonst einen stehen (Befund B8). */
  private zeitgeberWeg(): void {
    if (this.nachfassen) {
      clearTimeout(this.nachfassen);
      this.nachfassen = null;
    }
    if (this.aufgeben) {
      clearTimeout(this.aufgeben);
      this.aufgeben = null;
    }
  }
}
