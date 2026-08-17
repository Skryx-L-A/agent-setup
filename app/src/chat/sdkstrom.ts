// DER EREIGNISSTROM EINER CHAT-SITZUNG -- die Begriffe und der Umbau von
// stream-json in das, was die Oberflaeche zeichnet.
//
// GETRENNTE WELTEN (Entscheidung des Nutzers, 12.08.). Diese Datei hat mit
// chat/typen.ts und chat/leser.ts NICHTS zu tun. Jene beschreiben das
// MITLESEN einer fremden Terminal-Sitzung: ein Protokoll, das jemand anders
// fuehrt, wird von aussen aufgeschlagen und angezeigt. Hier gehoert die
// Sitzung der App: sie startet den Prozess, sie schickt die Eingabe, sie
// beantwortet die Freigabefragen. Zwei Welten, zwei Datenmodelle -- ein
// gemeinsamer Typ haette an jeder Verzweigung die Frage „welche Sorte ist das
// hier?" hinterlassen.
//
// DIE FORM IST GEMESSEN, NICHT GERATEN (12.08.). Jede Ereignisform unten
// stammt aus einer echten Sitzung mit `claude --print --input-format
// stream-json --output-format stream-json --include-partial-messages`
// (Modell claude-haiku-4-5, zwei Zuege); die Mitschnitte liegen als
// Vorlagen unter shell/tests/fixtures/chatsdk/. Was dort nicht vorkam, steht
// hier auch nicht.
//
// REIN: kein Zugriff auf Prozesse, Dateien oder `window` -- Ereignisse hinein,
// Stand heraus. So laesst sich der Umbau ohne Electron und ohne echte Sitzung
// gegen die Mitschnitte pruefen.

/** Was ein Block im Gespraech ist. Mehr Sorten braucht die Anzeige nicht. */
export type BlockArt = 'mensch' | 'agent' | 'denken' | 'werkzeug' | 'freigabe' | 'system';

/** Eine Textzeile des Menschen oder des Programms. */
export interface TextBlock {
  art: 'mensch' | 'agent' | 'denken' | 'system';
  id: string;
  /**
   * Die Fassung dieses Blocks -- sie steigt bei jeder Aenderung (siehe
   * `Gespraechsstrom.beruehre`). Daran erkennt der Hauptprozess, WAS er
   * schicken muss, und die Ansicht, WAS sie neu zeichnen muss. Ohne diese
   * Zahl gaebe es nur „alles" (Befund B1, 12.08.).
   */
  rev: number;
  text: string;
  /** Laeuft der Text gerade noch ein? Dann zeichnet die Ansicht ihn als lebend. */
  offen: boolean;
}

/**
 * EIN WERKZEUGAUFRUF, so wie ihn das Foto zeigt: Titelzeile „Bash — <description>",
 * darunter je eine gekuerzte Zeile IN und OUT.
 *
 * `beschreibung` kommt aus dem `description`-Feld des tool_use-Inputs -- das
 * schickt der Harness von sich aus mit (gemessen: `{"command":"echo hallo",
 * "description":"Print hallo to stdout"}`). Fehlt es, bleibt das Feld leer und
 * die Ansicht zeigt nur den Werkzeugnamen; erfunden wird nichts.
 */
export interface WerkzeugBlock {
  art: 'werkzeug';
  id: string;
  /** Die Fassung dieses Blocks -- siehe `TextBlock.rev`. */
  rev: number;
  /** Der Werkzeugname, wie der Harness ihn nennt: 'Bash', 'Write', 'Read'. */
  name: string;
  /** Der Satz aus dem Input, leer wenn keiner mitkam. */
  beschreibung: string;
  /** Die Eingabe, einzeilig zusammengefasst. */
  ein: string;
  /** Die vollstaendige Eingabe als JSON -- fuer das Aufklappen. */
  einVoll: string;
  /** Die Ausgabe. Leer, solange das Werkzeug laeuft. */
  aus: string;
  /** Hat das Werkzeug einen Fehler gemeldet? */
  fehler: boolean;
  /** Laeuft es noch? Dann steht noch kein Ergebnis da. */
  laeuft: boolean;
}

/**
 * EINE WARTENDE FREIGABE. Anders als in der Lese-Ansicht ist das hier keine
 * Beobachtung vom Bildschirm, sondern eine echte Frage des Prozesses, die eine
 * Antwort BRAUCHT: solange sie unbeantwortet ist, arbeitet die Sitzung nicht
 * weiter (gemessen 12.08. -- ein `deny` verhinderte das Schreiben der Datei).
 */
export interface FreigabeBlock {
  art: 'freigabe';
  id: string;
  /** Die Fassung dieses Blocks -- siehe `TextBlock.rev`. */
  rev: number;
  /** Die Kennung der Steuer-Anfrage; sie geht mit der Antwort zurueck. */
  anfrageId: string;
  name: string;
  beschreibung: string;
  ein: string;
  einVoll: string;
  /** Beantwortet? Dann steht in `entschieden` was. */
  offen: boolean;
  entschieden: '' | 'erlaubt' | 'abgelehnt' | 'zurueckgezogen';
  /**
   * OHNE KENNUNG LAESST SICH NICHT ANTWORTEN (Befund B7, 12.08.). Eine
   * `control_response` mit leerer `request_id` ordnet die CLI keiner Frage zu:
   * die Sitzung stuende weiter, waehrend das Fenster „erlaubt" behauptet. Und
   * bei zwei solchen Fragen schloesse ein Klick beide, weil die Zuordnung ueber
   * genau diese Kennung laeuft. Ein Kasten ohne Kennung bekommt deshalb keine
   * Knoepfe, sondern diesen Vermerk.
   */
  defekt: boolean;
}

export type Block = TextBlock | WerkzeugBlock | FreigabeBlock;

/**
 * EIN SLASH-BEFEHL DES HARNESS, wie ihn die Vervollstaendigung im Eingabefeld
 * anbietet.
 *
 * WOHER DIE LISTE KOMMT -- gemessen am 12.08. gegen die CLI 2.1.228, weil die
 * Vermutung danebenlag: sie steht NICHT im `system/init`-Ereignis (das traegt
 * nur session_id, model, cwd, permissionMode), sondern in der ANTWORT auf den
 * `initialize`-Handschlag, den chatsitzung.ts ohnehin schickt.
 *
 * DIE VORLAGE IST EIN GEKUERZTER AUSZUG (Randbemerkung des Reviews, 12.08.):
 * shell/tests/fixtures/chatsdk/initialize-antwort.jsonl traegt FUENF Befehle,
 * die echte Messung ergab 79. Gekuerzt ist sie aus zwei Gruenden -- die volle
 * Liste waere 16 KB Bestand DIESER Maschine (Namen und Beschreibungen aller
 * hier eingerichteten Skills), und die FORM prueft sich an fuenf Eintraegen
 * genauso wie an 79. Was die Suite damit NICHT prueft, ist das Verhalten bei
 * der echten Groesse; dafuer steht die Zahl im Kopf von
 * `ChatStandNachricht.befehle` (main/chatbuehne.ts), wo sie zaehlt.
 */
export interface Slashbefehl {
  /** Der Name OHNE Schraegstrich, so wie der Harness ihn nennt. */
  name: string;
  /** Der Satz darunter in der Liste. Leer, wenn keiner mitkam. */
  beschreibung: string;
  /** Der Hinweis auf die Argumente ('[interval] [prompt]'), leer wenn keiner. */
  argumente: string;
}

/** Der Stand einer Chat-Sitzung, so wie die Ansicht ihn zeichnet. */
export interface Gespraech {
  bloecke: Block[];
  /** Die Sitzungskennung des Harness -- fuer das Fortsetzen. Leer vor dem init. */
  sessionId: string;
  /** Das Modell, das der Harness meldet. */
  modell: string;
  /** Das Arbeitsverzeichnis, das der Harness meldet. */
  ordner: string;
  /** Der Freigabemodus, den der Harness meldet ('manual', 'acceptEdits', …). */
  modus: string;
  /** Arbeitet die Sitzung gerade an einer Antwort? */
  arbeitet: boolean;
  /** Wartet eine Freigabe auf den Menschen? */
  wartetAufFreigabe: boolean;
  /** Belegte Tokens des letzten Zuges, 0 = unbekannt. */
  tokens: number;
  /**
   * DER BELEGTE KONTEXT beim letzten Aufruf an das Modell, 0 = unbekannt.
   *
   * NICHT DASSELBE WIE `tokens`, und das ist der Grund, warum es das Feld gibt
   * (gemessen am 15.08.). `tokens` ist `input_tokens + output_tokens` aus dem
   * `result`-Ereignis -- die beiden Felder also, die den ZWISCHENSPEICHER
   * gerade NICHT enthalten. Genau dort liegt aber fast der ganze Kontext:
   * gemessen am Mitschnitt sitzung-zwei-zuege.jsonl steht `tokens` am Ende bei
   * 248, waehrend wirklich 45.022 Tokens belegt sind. Als Auslastung gelesen
   * ergaebe das einen Balken, der bei jedem Fenster auf null steht.
   *
   * Belegt ist, was beim NAECHSTEN Aufruf wieder hineingeht: frische Eingabe
   * plus alles, was aus dem Zwischenspeicher gelesen oder in ihn geschrieben
   * wurde. Dieselbe Rechnung wie im Kontext-Guard und in `transcriptStand()`
   * (workerstate.ts) -- EINE Rechnung im Haus, nicht zwei. Gelesen wird sie
   * aus dem JUENGSTEN `message_start`/`message_delta` und nicht aus dem
   * `result`, weil nur dort EIN einzelner Aufruf steht.
   */
  kontext: number;
  /**
   * Wieviele Kompaktierungen der Harness in dieser Sitzung gemeldet hat. Die
   * Zahl steigt mit jedem `system/compact_boundary`-Ereignis -- das ist die
   * einzige BESTAETIGUNG, dass eine Kompaktierung wirklich stattgefunden hat,
   * und die Kontextwache haengt ihren Resume-Prompt genau daran (wache.ts).
   */
  kompaktierungen: number;
  /**
   * Die letzte Kompaktierung in Zahlen, wie der Harness sie meldet: vorher,
   * nachher, und wer sie ausgeloest hat ('manual' bei `/compact`). Leer, wenn
   * in dieser Sitzung noch keine stattfand.
   */
  letzteKompaktierung: { vorher: number; nachher: number; ausloeser: string } | null;
  /** Aufgelaufene Kosten in Dollar, -1 = unbekannt. */
  kosten: number;
  /** Der letzte Fehler im Klartext, leer wenn keiner. */
  fehler: string;
  /**
   * Kam ueberhaupt ein `init`? Nur dann hat der Harness die Sitzung
   * angenommen. Ein Fehlstart -- etwa `--resume` auf eine Unterhaltung, die
   * die CLI inzwischen weggeraeumt hat -- endet OHNE dieses Ereignis, und
   * genau daran erkennt der Aufrufer ihn (Befund B3, 12.08.).
   */
  initGesehen: boolean;
  /**
   * Der Stand des Zaehlers, mit dem die Bloecke gestempelt sind. Wer den
   * letzten Takt kennt, den er gesehen hat, weiss genau, welche Bloecke sich
   * seither geaendert haben -- das ist der ganze Abgleich (Befund B1).
   */
  takt: number;
  /**
   * Die Slash-Befehle, die dieser Harness kennt -- leer, bis die Antwort auf
   * den Handschlag da ist. Sie reisen im KOPF und nicht in einem eigenen
   * Kanal: die Vervollstaendigung braucht sie genau dann, wenn die Ansicht
   * ohnehin zeichnet, und eine zweite Leitung waere eine zweite Wahrheit.
   */
  befehle: Slashbefehl[];
  /**
   * Die Freigabemodi, die dieser Harness zur LAUFZEIT annimmt. Anfangs die
   * gemessene Liste (`MODI_LAUFZEIT`); lehnt der Harness einen Modus ab,
   * ersetzt die Aufzaehlung aus seiner Absage sie. So altert sie nicht still.
   */
  modi: string[];
  /**
   * Kam auf die letzte Modus-Umschaltung eine Absage? Dann steht der Grund
   * hier, im Wortlaut des Harness. Leer, wenn nichts anliegt.
   */
  modusFehler: string;
}

/**
 * DIE FREIGABEMODI, die die CLI zur Laufzeit annimmt -- GEMESSEN am 12.08.
 * gegen Fassung 2.1.228, indem ihr ein unbekannter Modus geschickt wurde: sie
 * antwortet mit „Cannot set permission mode: must be one of acceptEdits, auto,
 * bypassPermissions, default, dontAsk, plan".
 *
 * ES IST NICHT DIESELBE LISTE WIE AM BEFEHLSZEILEN-SCHALTER. `claude --help`
 * nennt fuer `--permission-mode` „manual" statt „default"; zur Laufzeit wird
 * „manual" abgelehnt und „default" angenommen. Wer die eine Liste an der
 * anderen Stelle verwendet, bekommt eine Absage, die niemand erklaert.
 *
 * Diese Liste ist nur der ANFANG: lehnt der Harness einen Modus ab, ersetzt
 * die Aufzaehlung aus seiner Absage sie (siehe `modiAusAbsage`). So altert sie
 * nicht still, wenn die CLI ihre Modi aendert.
 */
export const MODI_LAUFZEIT = [
  'default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions',
];

export function leeresGespraech(): Gespraech {
  return {
    bloecke: [],
    sessionId: '',
    modell: '',
    ordner: '',
    modus: '',
    arbeitet: false,
    wartetAufFreigabe: false,
    tokens: 0,
    kontext: 0,
    kompaktierungen: 0,
    letzteKompaktierung: null,
    kosten: -1,
    fehler: '',
    initGesehen: false,
    takt: 0,
    befehle: [],
    modi: [...MODI_LAUFZEIT],
    modusFehler: '',
  };
}

/**
 * DIE MODUSLISTE AUS EINER ABSAGE. Der Harness lehnt einen unbekannten Modus
 * mit dem vollstaendigen Satz ab: „Cannot set permission mode: must be one of
 * acceptEdits, auto, bypassPermissions, default, dontAsk, plan" (gemessen
 * 12.08. gegen CLI 2.1.228). Das ist die einzige Stelle, an der die CLI ihre
 * Modi zur Laufzeit ueberhaupt aufzaehlt -- die Antwort auf den Handschlag
 * nennt nur den GERADE geltenden.
 *
 * Rein und getrennt geprueft, weil sie die einzige Stelle ist, an der ein
 * Formatwechsel des Harness still zu einer leeren Auswahl fuehrte.
 */
export function modiAusAbsage(text: string): string[] {
  const treffer = /must be one of\s+([^.\n]+)/i.exec(text);
  if (!treffer) return [];
  return treffer[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[a-zA-Z]+$/.test(s));
}

// --- Die Ereignisse, wie sie ueber stdout kommen -----------------------------

/** Ein Ereignis des Harness. Bewusst locker getippt: was nicht gemessen wurde, wird nicht behauptet. */
export interface RohEreignis {
  type: string;
  subtype?: string;
  session_id?: string;
  [k: string]: unknown;
}

/**
 * EINE ZEILE EINE ANTWORT. Der Umbau gibt zurueck, was der Aufrufer TUN muss --
 * er tut es nicht selbst. Das haelt diese Datei frei von Prozessen: der
 * Hauptprozess nimmt die `antwort` und schreibt sie auf stdin.
 */
export interface Folge {
  /** Eine Steuer-Antwort, die zurueckgeschickt werden muss (Freigabe-Frage). */
  antwortNoetig: boolean;
  /**
   * Die Kennung einer Steuer-Anfrage, die wir NICHT bedienen koennen -- der
   * Aufrufer schickt darauf eine Fehler-Antwort. Leer, wenn nichts ansteht.
   *
   * Schweigen waere die schlechtere Antwort: der Harness wartet dann auf eine
   * Antwort, die nie kommt (Befund B6, 12.08.).
   */
  fehlerAntwortFuer: string;
}

/** Nichts zu tun -- die haeufigste Folge, deshalb einmal hier statt ueberall neu gebaut. */
const NICHTS: Folge = { antwortNoetig: false, fehlerAntwortFuer: '' };

/** Was eine Freigabe-Entscheidung des Menschen auf stdin ergibt. */
export interface Entscheidung {
  anfrageId: string;
  erlauben: boolean;
  grund: string;
}

function kurz(s: string, max = 300): string {
  const eine = s.replace(/\s+/g, ' ').trim();
  return eine.length > max ? `${eine.slice(0, max)}…` : eine;
}

/**
 * DIE EINGABE EINES WERKZEUGS IN EINER ZEILE. Ein Befehl ist sein Befehl, eine
 * Datei ist ihr Pfad -- alles andere wird als JSON gezeigt. Die Reihenfolge der
 * Felder ist die der gemessenen Werkzeuge; `description` bleibt aussen vor, die
 * steht schon in der Titelzeile.
 */
export function eingabeZeile(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return kurz(input);
  if (typeof input !== 'object') return kurz(String(input));
  const o = input as Record<string, unknown>;
  for (const feld of ['command', 'file_path', 'path', 'pattern', 'url', 'prompt', 'query']) {
    const w = o[feld];
    if (typeof w === 'string' && w) return kurz(w);
  }
  const ohneBeschreibung: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (k !== 'description') ohneBeschreibung[k] = v;
  return kurz(JSON.stringify(ohneBeschreibung));
}

/** Der Inhalt eines tool_result -- Text, oder eine Liste von Textbloecken. */
export function ergebnisText(inhalt: unknown): string {
  if (typeof inhalt === 'string') return inhalt;
  if (!Array.isArray(inhalt)) return inhalt === undefined || inhalt === null ? '' : JSON.stringify(inhalt);
  const teile: string[] = [];
  for (const b of inhalt) {
    if (typeof b === 'string') teile.push(b);
    else if (b && typeof b === 'object') {
      const o = b as Record<string, unknown>;
      if (typeof o.text === 'string') teile.push(o.text);
      else teile.push(JSON.stringify(o));
    }
  }
  return teile.join('\n');
}

/**
 * DER UMBAU. Ein Zustand, gefuettert mit Ereignissen, liefert auf Abruf den
 * Stand. Kein Timer, kein Zufall, keine Uhr -- zweimal dieselbe Folge von
 * Ereignissen ergibt zweimal denselben Stand, und genau das pruefen die Tests.
 */
export class Gespraechsstrom {
  private g: Gespraech = leeresGespraech();

  /** Laufende Text-/Denkbloecke des aktuellen Zuges, nach Blockindex. */
  private offeneBloecke = new Map<number, TextBlock>();

  /**
   * WELCHER BLOCK ZU WELCHER STELLE DER LAUFENDEN NACHRICHT GEHOERT.
   *
   * Der `index` eines stream_event ist die Stelle im `content`-Feld derselben
   * Nachricht -- damit laesst sich jeder stueckweise gewachsene Block genau
   * seinem Eintrag im spaeteren assistant-Ereignis zuordnen. Ohne diese
   * Zuordnung bliebe nur Zaehlen ("die ersten N Textbloecke stehen schon da"),
   * und dabei rutscht ein Werkzeugaufruf, der MITTEN in der Nachricht steht,
   * hinter den Text, der ihm folgte: die Anzeige behauptet dann eine
   * Reihenfolge, die es nie gab.
   */
  private nachrichtBloecke = new Map<number, Block>();

  /** Werkzeugbloecke nach tool_use_id -- das Ergebnis kommt spaeter und muss sie finden. */
  private werkzeuge = new Map<string, WerkzeugBlock>();

  private zaehler = 0;

  /**
   * DER TAKTGEBER. Jede Aenderung an einem Block stempelt ihn mit der
   * naechsten Zahl. Wer weiss, welchen Takt er zuletzt gesehen hat, kann genau
   * die geaenderten Bloecke holen -- ohne das waere jede Regung auf stdout ein
   * vollstaendiger Neuaufbau (Befund B1, 12.08.).
   */
  private takt = 0;

  /** Einen Block als geaendert stempeln und zurueckgeben. */
  private beruehre<T extends Block>(b: T): T {
    this.takt += 1;
    b.rev = this.takt;
    this.g.takt = this.takt;
    return b;
  }

  private neueId(vorsatz: string): string {
    this.zaehler += 1;
    return `${vorsatz}-${this.zaehler}`;
  }

  stand(): Gespraech {
    return this.g;
  }

  /** Eine Nachricht des Menschen -- kommt nicht vom Harness, sondern von der Eingabe. */
  mensch(text: string): void {
    this.g.bloecke.push(this.beruehre<TextBlock>({
      art: 'mensch', id: this.neueId('m'), rev: 0, text, offen: false,
    }));
    this.g.arbeitet = true;
  }

  /** Ein Ereignis aus dem Strom verarbeiten. */
  nimm(e: RohEreignis): Folge {
    switch (e.type) {
      case 'system':
        return this.system(e);
      case 'stream_event':
        return this.teilstueck(e);
      case 'assistant':
        return this.assistent(e);
      case 'user':
        return this.benutzer(e);
      case 'control_request':
        return this.steuerfrage(e);
      case 'control_cancel_request':
        return this.steuerRuecknahme(e);
      case 'control_response':
        return this.steuerantwort(e);
      case 'result':
        return this.ergebnis(e);
      default:
        // rate_limit_event, keep_alive und was sonst noch kommt: bekannt
        // genug, um es NICHT als Fehler zu zeigen, und nicht gemessen genug,
        // um daraus etwas zu bauen.
        return NICHTS;
    }
  }

  /**
   * DIE ANTWORT AUF UNSERE EIGENE STEUER-ANFRAGE.
   *
   * Bis zum 12.08. fiel sie in den `default`-Zweig oben und wurde verworfen --
   * und mit ihr das, was der Harness genau HIER und nirgends sonst herausgibt:
   * die Liste seiner Slash-Befehle und der geltende Freigabemodus (Antwort auf
   * `initialize`), die Bestaetigung einer Modus-Umschaltung, und die Absage,
   * aus der sich die Liste der moeglichen Modi lesen laesst.
   *
   * Zugeordnet wird ueber die Kennung, die chatsitzung.ts vergibt -- nicht
   * ueber die Reihenfolge: zwischen Frage und Antwort liegen beliebig viele
   * andere Ereignisse.
   */
  private steuerantwort(e: RohEreignis): Folge {
    const aussen = e.response as Record<string, unknown> | undefined;
    if (!aussen) return NICHTS;
    const kennung = typeof aussen.request_id === 'string' ? aussen.request_id : '';

    if (aussen.subtype === 'error') {
      const grund = typeof aussen.error === 'string' ? aussen.error : '';
      if (kennung.startsWith('awb-modus')) {
        const modi = modiAusAbsage(grund);
        if (modi.length) this.g.modi = modi;
        this.g.modusFehler = grund;
        return NICHTS;
      }
      // EINE ABGELEHNTE UNTERBRECHUNG WIRD SICHTBAR (Reviewbefund 4, 12.08.).
      // Bis heute fiel sie hier heraus, waehrend im Verlauf schon „Der Zug
      // wurde unterbrochen" stand -- geschrieben, sobald das Schreiben auf
      // stdin gelungen war. Wer das liest, glaubt, es sei vorbei, und die
      // Antwort laeuft weiter.
      if (kennung.startsWith('awb-halt')) {
        this.melde(`Die Unterbrechung wurde abgelehnt: ${grund}`);
        return NICHTS;
      }
      // EIN GESCHEITERTER HANDSCHLAG WIRD SICHTBAR. Ohne ihn fragt der Harness
      // bei keiner Handlung nach (gemessen 12.08.), und die Sitzung sieht
      // trotzdem normal aus -- bis sie ohne Rueckfrage etwas schreibt. Das ist
      // die eine Absage, die niemand uebersehen darf.
      if (kennung === 'awb-init') {
        this.melde(`Der Handschlag mit dem Harness schlug fehl: ${grund}`);
      }
      return NICHTS;
    }

    const innen = aussen.response as Record<string, unknown> | undefined;
    if (!innen) return NICHTS;

    // DIE UNTERBRECHUNG IST ERST BESTAETIGT, WENN DER HARNESS SIE BESTAETIGT
    // (Reviewbefund 4). Gemessen antwortet er mit `{still_queued: []}`; die
    // Zuordnung laeuft ueber die Kennung `awb-halt-<n>`, die chatsitzung.ts
    // vergibt -- nicht ueber die Reihenfolge, denn zwischen Frage und Antwort
    // liegen beliebig viele andere Ereignisse.
    if (kennung.startsWith('awb-halt')) {
      const rest = Array.isArray(innen.still_queued) ? innen.still_queued.length : 0;
      this.melde(rest > 0
        ? `Der Zug wurde unterbrochen. ${rest} Eingabe(n) stehen noch an.`
        : 'Der Zug wurde unterbrochen.');
      return NICHTS;
    }

    if (Array.isArray(innen.commands)) {
      const befehle: Slashbefehl[] = [];
      for (const roh of innen.commands) {
        if (!roh || typeof roh !== 'object') continue;
        const c = roh as Record<string, unknown>;
        if (typeof c.name !== 'string' || !c.name) continue;
        befehle.push({
          name: c.name,
          beschreibung: typeof c.description === 'string' ? c.description : '',
          argumente: typeof c.argumentHint === 'string' ? c.argumentHint : '',
        });
      }
      this.g.befehle = befehle;
    }
    // Der Harness nennt den geltenden Modus in BEIDEN Antworten mit je eigenem
    // Feld: `current_permission_mode` nach dem Handschlag, `mode` nach einer
    // Umschaltung. Beide zaehlen, weil beide von ihm kommen -- die Ansicht
    // zeigt danach, was WIRKLICH gilt, nicht was gewuenscht war.
    if (typeof innen.current_permission_mode === 'string' && innen.current_permission_mode) {
      this.g.modus = innen.current_permission_mode;
    }
    if (typeof innen.mode === 'string' && innen.mode) {
      this.g.modus = innen.mode;
      this.g.modusFehler = '';
    }
    return NICHTS;
  }

  private system(e: RohEreignis): Folge {
    if (e.subtype === 'init') {
      this.g.initGesehen = true;
      if (typeof e.session_id === 'string') this.g.sessionId = e.session_id;
      if (typeof e.model === 'string') this.g.modell = e.model;
      if (typeof e.cwd === 'string') this.g.ordner = e.cwd;
      if (typeof e.permissionMode === 'string') this.g.modus = e.permissionMode;
    }
    // DIE KOMPAKTIERUNGSGRENZE -- gemessen am 15.08. gegen die CLI 2.1.233.
    //
    // Sie ist die einzige BESTAETIGUNG, dass eine Kompaktierung wirklich
    // stattgefunden hat, und sie bringt die Zahlen gleich mit:
    // `{"type":"system","subtype":"compact_boundary","compact_metadata":
    // {"trigger":"manual","pre_tokens":60202,"post_tokens":8575,
    // "duration_ms":13034,…}}`. Der Rueckgabewert des Schreibens auf stdin
    // sagt nur, dass die Bytes angekommen sind -- dieselbe Lehre wie beim
    // tmux-Guard, dessen getippte Prompts nie abgeschickt wurden (12.08.).
    //
    // `trigger` wird mitgefuehrt, weil der Harness auch von SELBST kompaktiert
    // (dann steht dort nicht 'manual'). Er steht im Protokoll der Wache und
    // sagt dem Menschen, WER kompaktiert hat -- ENTSCHIEDEN wird damit nichts:
    // die Wache zaehlt Grenzen (`kompaktierungen`), und eine fremde Grenze ist
    // fuer sie so gut wie ihre eigene, denn kompaktiert ist kompaktiert. Der
    // Fall, in dem das frueher schieflief -- die Wache bittet, jemand anders
    // kompaktiert waehrenddessen, die Wache kompaktiert danach ein leeres
    // Fenster ein zweites Mal --, haengt nicht am Ausloeser, sondern an der
    // gefallenen Auslastung; dort steht der Ausstieg (wache.ts, Stufe
    // `gebeten`, Befund 2 des Reviews vom 15.08.).
    if (e.subtype === 'compact_boundary') {
      const m = e.compact_metadata as Record<string, unknown> | undefined;
      this.g.kompaktierungen += 1;
      this.g.letzteKompaktierung = {
        vorher: typeof m?.pre_tokens === 'number' ? m.pre_tokens : 0,
        nachher: typeof m?.post_tokens === 'number' ? m.post_tokens : 0,
        ausloeser: typeof m?.trigger === 'string' ? m.trigger : '',
      };
      // Der naechste Aufruf faengt beim komprimierten Stand an. Bis er kommt,
      // stuende sonst weiter die alte Belegung da, und die Wache haette ihre
      // eigene Kompaktierung nicht bemerkt.
      if (this.g.letzteKompaktierung.nachher > 0) this.g.kontext = this.g.letzteKompaktierung.nachher;
    }
    return NICHTS;
  }

  /**
   * DIE BELEGUNG AUS EINEM NUTZUNGSBLOCK. Getrennt, weil sie an zwei Stellen
   * gebraucht wird und weil eine falsche Rechnung hier still bliebe: sie
   * ergaebe eine plausible Zahl, nur eben nicht die Auslastung.
   */
  private kontextAus(roh: unknown): void {
    if (!roh || typeof roh !== 'object') return;
    const u = roh as Record<string, unknown>;
    const zahl = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0);
    const belegt = zahl('input_tokens') + zahl('cache_read_input_tokens') + zahl('cache_creation_input_tokens');
    if (belegt > 0) this.g.kontext = belegt;
  }

  /**
   * DIE TEILSTUECKE -- der Grund, warum der Text im Fenster mitwaechst statt
   * am Ende auf einmal dazustehen. Der Harness schickt sie nur mit
   * `--include-partial-messages`; ohne das Flag bleibt die Anzeige richtig,
   * aber sie ruckelt (der ganze Absatz erscheint mit dem assistant-Ereignis).
   */
  private teilstueck(e: RohEreignis): Folge {
    const ev = e.event as Record<string, unknown> | undefined;
    if (!ev || typeof ev.type !== 'string') return NICHTS;
    const index = typeof ev.index === 'number' ? ev.index : -1;
    // DIE BELEGUNG EINES SUBAGENTEN GEHOERT NICHT IN DIESES FENSTER.
    //
    // GEMESSEN am 15.08. gegen die CLI 2.1.233, Vorlage subagent-zug.jsonl: ein
    // Zug mit `Task` traegt seine Ereignisse mit `parent_tool_use_id` -- und
    // seine Belegung ist die des Subagenten (22.935), nicht die dieser Sitzung
    // (46.242 im selben Augenblick). Im Mitschnitt kommen diese Ereignisse
    // ausschliesslich als `assistant` herein, also gar nicht hier vorbei; die
    // Wache stand nie falsch. Der Zaun bleibt trotzdem: schickte der Harness
    // die Teilstuecke des Subagenten einmal mit, saehe die Wache mitten in
    // schwerer Arbeit ein fast leeres Fenster -- genau die Lage, in der sie am
    // noetigsten ist (Befund 9 des Reviews vom 15.08.).
    const fremderZug = typeof e.parent_tool_use_id === 'string' && e.parent_tool_use_id.length > 0;

    if (ev.type === 'message_start') {
      this.offeneBloecke.clear();
      this.nachrichtBloecke.clear();
      this.g.arbeitet = true;
      // Der belegte Kontext dieses Aufrufs steht schon im Kopf der Nachricht,
      // bevor das erste Wort da ist -- damit weiss die Wache die Auslastung
      // eines langen Zuges, ohne auf sein Ende zu warten.
      if (!fremderZug) this.kontextAus((ev.message as Record<string, unknown> | undefined)?.usage);
      return NICHTS;
    }
    if (ev.type === 'message_delta') {
      // Und am Ende noch einmal: `message_delta` traegt dieselben Eingabefelder
      // und dazu die endgueltige Ausgabezahl. Gemessen sind beide gleich; die
      // zweite Lesung kostet nichts und haelt den Wert richtig, falls der
      // Harness den Kopf einmal ohne Nutzung schickt.
      if (!fremderZug) this.kontextAus(ev.usage);
      return NICHTS;
    }
    if (ev.type === 'content_block_start') {
      const cb = ev.content_block as Record<string, unknown> | undefined;
      const art = cb && typeof cb.type === 'string' ? cb.type : '';
      if (art === 'text' || art === 'thinking') {
        const block: TextBlock = this.beruehre<TextBlock>({
          art: art === 'thinking' ? 'denken' : 'agent',
          id: this.neueId(art === 'thinking' ? 'd' : 'a'),
          rev: 0,
          text: typeof cb?.text === 'string' ? (cb.text as string) : '',
          offen: true,
        });
        this.offeneBloecke.set(index, block);
        this.nachrichtBloecke.set(index, block);
        this.g.bloecke.push(block);
      }
      // tool_use-Bloecke werden hier NICHT angelegt: ihr Input laeuft als
      // input_json_delta stueckweise ein und waere bis zum Schluss unlesbar.
      // Der fertige Aufruf kommt mit dem assistant-Ereignis.
      return NICHTS;
    }
    if (ev.type === 'content_block_delta') {
      const d = ev.delta as Record<string, unknown> | undefined;
      const block = this.offeneBloecke.get(index);
      if (!block || !d) return NICHTS;
      if (d.type === 'text_delta' && typeof d.text === 'string') block.text += d.text;
      else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') block.text += d.thinking;
      else return NICHTS;
      this.beruehre(block);
      return NICHTS;
    }
    if (ev.type === 'content_block_stop') {
      const block = this.offeneBloecke.get(index);
      if (block) {
        block.offen = false;
        this.beruehre(block);
      }
      this.offeneBloecke.delete(index);
      return NICHTS;
    }
    return NICHTS;
  }

  /**
   * DIE FERTIGE NACHRICHT -- und die Stelle, an der die REIHENFOLGE entsteht.
   *
   * Sie traegt dieselben Text- und Denkbloecke noch einmal, die eben
   * stueckweise einliefen, plus die Werkzeugaufrufe, die es stueckweise NICHT
   * gab (ihr Input laeuft als `input_json_delta` ein und waere bis zum Schluss
   * unlesbar). Gebaut wird deshalb entlang des `content`-Feldes: was schon
   * dasteht, wird an seinem Inhaltsindex wiedererkannt, was fehlt, entsteht
   * neu -- und danach stehen die Bloecke dieser Nachricht in genau der
   * Reihenfolge, in der der Harness sie geschickt hat.
   *
   * WARUM NICHT EINFACH ZAEHLEN. Die erste Fassung zaehlte, wieviele
   * Textbloecke schon dastanden, und haengte die Werkzeugaufrufe hinten an.
   * Bei einer Nachricht der Form Text, Werkzeug, Text ergab das Text, Text,
   * Werkzeug: eine Reihenfolge, die es nie gab, und niemand sieht ihr an, dass
   * sie falsch ist.
   */
  private assistent(e: RohEreignis): Folge {
    const nachricht = e.message as Record<string, unknown> | undefined;
    const inhalt = nachricht?.content;
    if (!Array.isArray(inhalt)) return NICHTS;

    const dieserNachricht: Block[] = [];

    for (const [i, roh] of inhalt.entries()) {
      if (!roh || typeof roh !== 'object') continue;
      const b = roh as Record<string, unknown>;
      const schonDa = this.nachrichtBloecke.get(i);

      if (b.type === 'text' || b.type === 'thinking') {
        const text = b.type === 'text'
          ? (typeof b.text === 'string' ? b.text : '')
          : (typeof b.thinking === 'string' ? b.thinking : '');
        if (schonDa && (schonDa.art === 'agent' || schonDa.art === 'denken')) {
          // Der gewachsene Block bleibt -- aber die fertige Fassung ist die
          // massgebliche: ein verlorenes Teilstueck faellt hier auf.
          if (text) schonDa.text = text;
          schonDa.offen = false;
          this.beruehre(schonDa);
          dieserNachricht.push(schonDa);
          continue;
        }
        if (!text) continue;
        const neu: TextBlock = this.beruehre<TextBlock>({
          art: b.type === 'thinking' ? 'denken' : 'agent',
          id: this.neueId(b.type === 'thinking' ? 'd' : 'a'),
          rev: 0,
          text,
          offen: false,
        });
        this.nachrichtBloecke.set(i, neu);
        dieserNachricht.push(neu);
        continue;
      }

      if (b.type !== 'tool_use') continue;
      const id = typeof b.id === 'string' ? b.id : this.neueId('w');
      const vorhanden = this.werkzeuge.get(id);
      if (vorhanden) {
        dieserNachricht.push(vorhanden);
        continue;
      }
      const input = b.input as Record<string, unknown> | undefined;
      const w: WerkzeugBlock = this.beruehre<WerkzeugBlock>({
        art: 'werkzeug',
        id,
        rev: 0,
        name: typeof b.name === 'string' ? b.name : 'Werkzeug',
        beschreibung: typeof input?.description === 'string' ? (input.description as string) : '',
        ein: eingabeZeile(input),
        einVoll: JSON.stringify(input ?? {}, null, 2),
        aus: '',
        fehler: false,
        laeuft: true,
      });
      this.werkzeuge.set(id, w);
      this.nachrichtBloecke.set(i, w);
      dieserNachricht.push(w);
    }

    // Die Bloecke dieser Nachricht aus der Liste nehmen und in der Reihenfolge
    // des `content`-Feldes wieder anhaengen. Alles davor -- fruehere Zuege,
    // Nachrichten des Menschen, Freigaben -- bleibt unberuehrt.
    const gehoertDazu = new Set(dieserNachricht);
    this.g.bloecke = this.g.bloecke.filter((b) => !gehoertDazu.has(b));
    this.g.bloecke.push(...dieserNachricht);

    return NICHTS;
  }

  /**
   * EIN user-EREIGNIS AUS DEM STROM ist kein Mensch, sondern das Ergebnis
   * eines Werkzeugs -- der Harness verpackt es so, weil es in der Unterhaltung
   * an der Stelle des Menschen steht. Wer das verwechselt, zeigt jede
   * Werkzeugausgabe als Nachricht des Nutzers an.
   */
  private benutzer(e: RohEreignis): Folge {
    const nachricht = e.message as Record<string, unknown> | undefined;
    const inhalt = nachricht?.content;
    if (!Array.isArray(inhalt)) return NICHTS;
    for (const roh of inhalt) {
      if (!roh || typeof roh !== 'object') continue;
      const b = roh as Record<string, unknown>;
      if (b.type !== 'tool_result') continue;
      const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
      const w = this.werkzeuge.get(id);
      if (!w) continue;
      w.aus = ergebnisText(b.content);
      w.fehler = b.is_error === true;
      w.laeuft = false;
      this.beruehre(w);
    }
    return NICHTS;
  }

  /**
   * DIE FREIGABEFRAGE. Sie kommt nur, wenn der Prozess mit
   * `--permission-prompt-tool stdio` gestartet wurde UND der Handschlag
   * (`initialize`) gelaufen ist -- beides gemessen am 12.08.: ohne das eine
   * oder das andere fragt der Harness nicht, er handelt.
   */
  private steuerfrage(e: RohEreignis): Folge {
    const anfrage = e.request as Record<string, unknown> | undefined;
    const kennung = typeof e.request_id === 'string' ? e.request_id : '';
    if (!anfrage) return NICHTS;

    if (anfrage.subtype !== 'can_use_tool') {
      // EIN UNBEKANNTER SUBTYP BEKOMMT EINE ABSAGE, KEIN SCHWEIGEN (Befund B6,
      // 12.08.). Die CLI kennt neben `can_use_tool` noch `hook_callback` und
      // `mcp_message`; heute kann keiner davon eintreten (der Handschlag meldet
      // `hooks: {}`, SDK-eigene MCP-Server gibt es nicht). Wenn doch einmal
      // einer kommt, wartet der Harness sonst auf eine Antwort, die nie
      // kommt -- und die Sitzung steht ohne sichtbaren Grund.
      return kennung ? { antwortNoetig: false, fehlerAntwortFuer: kennung } : NICHTS;
    }

    const input = anfrage.input as Record<string, unknown> | undefined;
    const f: FreigabeBlock = this.beruehre<FreigabeBlock>({
      art: 'freigabe',
      id: this.neueId('f'),
      rev: 0,
      anfrageId: kennung,
      name: typeof anfrage.tool_name === 'string' ? anfrage.tool_name : 'Werkzeug',
      beschreibung: typeof anfrage.description === 'string' ? (anfrage.description as string) : '',
      ein: eingabeZeile(input),
      einVoll: JSON.stringify(input ?? {}, null, 2),
      offen: true,
      entschieden: '',
      // Ohne Kennung laesst sich nicht antworten -- siehe FreigabeBlock.defekt.
      defekt: !kennung,
    });
    this.g.bloecke.push(f);
    if (!f.defekt) this.g.wartetAufFreigabe = true;
    return { antwortNoetig: !f.defekt, fehlerAntwortFuer: '' };
  }

  /**
   * DER HARNESS ZIEHT EINE FRAGE ZURUECK (Befund B6, 12.08.). Ohne diesen Weg
   * bliebe der Kasten offen, der Kopf behauptete weiter „wartet auf Freigabe",
   * und ein spaeterer Klick auf „Erlauben" schickte eine Antwort auf eine
   * Frage, die es nicht mehr gibt.
   */
  private steuerRuecknahme(e: RohEreignis): Folge {
    const kennung = typeof e.request_id === 'string' ? e.request_id : '';
    if (!kennung) return NICHTS;
    for (const b of this.g.bloecke) {
      if (b.art !== 'freigabe' || b.anfrageId !== kennung || !b.offen) continue;
      b.offen = false;
      b.entschieden = 'zurueckgezogen';
      this.beruehre(b);
    }
    this.g.wartetAufFreigabe = this.g.bloecke.some((b) => b.art === 'freigabe' && b.offen);
    return NICHTS;
  }

  /** Der Mensch hat entschieden -- der Block wird geschlossen, der Aufrufer schickt die Antwort. */
  entscheide(anfrageId: string, erlauben: boolean): boolean {
    // Ohne Kennung gibt es nichts zu entscheiden: die Antwort waere keiner
    // Frage zuzuordnen, und der Klick schloesse jede andere kennungslose Frage
    // gleich mit (Befund B7).
    if (!anfrageId) return false;
    let gefunden = false;
    for (const b of this.g.bloecke) {
      if (b.art !== 'freigabe' || b.anfrageId !== anfrageId || !b.offen || b.defekt) continue;
      b.offen = false;
      b.entschieden = erlauben ? 'erlaubt' : 'abgelehnt';
      this.beruehre(b);
      gefunden = true;
    }
    this.g.wartetAufFreigabe = this.g.bloecke.some((b) => b.art === 'freigabe' && b.offen);
    return gefunden;
  }

  private ergebnis(e: RohEreignis): Folge {
    this.g.arbeitet = false;
    for (const b of this.offeneBloecke.values()) {
      b.offen = false;
      this.beruehre(b);
    }
    this.offeneBloecke.clear();
    // Ein Werkzeug, das beim Zugende noch laeuft, laeuft nicht mehr -- sonst
    // dreht sich sein Zeichen fuer immer weiter.
    for (const w of this.werkzeuge.values()) {
      if (!w.laeuft) continue;
      w.laeuft = false;
      this.beruehre(w);
    }
    if (typeof e.session_id === 'string' && e.session_id) this.g.sessionId = e.session_id;
    const nutzung = e.usage as Record<string, unknown> | undefined;
    if (nutzung && typeof nutzung.output_tokens === 'number') {
      const ein = typeof nutzung.input_tokens === 'number' ? nutzung.input_tokens : 0;
      this.g.tokens = ein + (nutzung.output_tokens as number);
    }
    if (typeof e.total_cost_usd === 'number') this.g.kosten = e.total_cost_usd;
    if (e.is_error === true) {
      // EIN ABBRUCH WIRD SICHTBAR (Befund B2, 12.08.). Vorher landete der Grund
      // nur in `g.fehler`, und das Feld zeichnete niemand: der Kopf fiel von
      // „arbeitet" auf „wartet", der Verlauf blieb, wie er war, und der Mensch
      // tippte seine Frage noch einmal. Weil der Prozess mit
      // `--input-format stream-json` weiterlaeuft, kommt auch kein `exit`, das
      // es melden koennte.
      const grund = typeof e.result === 'string' && e.result
        ? e.result
        : String(e.subtype ?? 'unbekannt');
      this.g.fehler = grund;
      this.g.bloecke.push(this.beruehre<TextBlock>({
        art: 'system', id: this.neueId('s'), rev: 0, text: grund, offen: false,
      }));
    }
    return NICHTS;
  }

  /** Ein Fehler von aussen (Prozess weg, Zeile unlesbar) gehoert sichtbar ins Gespraech. */
  melde(text: string): void {
    this.g.fehler = text;
    this.g.arbeitet = false;
    this.g.bloecke.push(this.beruehre<TextBlock>({
      art: 'system', id: this.neueId('s'), rev: 0, text, offen: false,
    }));
  }
}

/**
 * DIE ZERLEGUNG DES STROMS. Der Harness schreibt eine JSON-Zeile je Ereignis,
 * aber ein Lesevorgang liefert Bruchstuecke -- eine halbe Zeile am Ende eines
 * Puffers ist der Normalfall, nicht die Ausnahme. Diese Klasse haelt den Rest
 * fest, bis er ganz ist.
 */
export class Zeilenleser {
  private rest = '';

  /**
   * DER DECKEL (Bugjagd-Befund vom 15.08., gesetzt am 16.08.). Ohne ihn waechst
   * `rest` unbegrenzt: ein Harness, der nie einen Zeilenumbruch schickt -- weil
   * er kaputt ist, weil eine Binaerdatei in seinen stdout geraten ist, weil er
   * hangt --, laesst diesen Puffer im HAUPTPROZESS bis zum Speicherende
   * anwachsen, und das Fenster stirbt mit ihm.
   *
   * Acht Megabyte sind weit jenseits jeder echten Zeile: das groesste gemessene
   * Werkzeugergebnis dieser Sitzungen liegt bei rund 200 KB. Was darueber ohne
   * Umbruch ankommt, ist keine Zeile mehr, sondern ein kaputter Strom -- der
   * Rest wird verworfen, und WIEVIEL verworfen wurde, bleibt ablesbar, statt
   * still zu verschwinden.
   */
  static readonly GRENZE = 8 * 1024 * 1024;

  /** Wieviele Zeichen bisher als „keine Zeile" verworfen wurden. 0 im Normalfall. */
  verworfen = 0;

  /** Bytes hineinreichen, ganze Zeilen herausbekommen. */
  nimm(stueck: string): string[] {
    this.rest += stueck;
    const teile = this.rest.split('\n');
    this.rest = teile.pop() ?? '';
    if (this.rest.length > Zeilenleser.GRENZE) {
      this.verworfen += this.rest.length;
      this.rest = '';
    }
    return teile.map((z) => z.trim()).filter((z) => z.length > 0);
  }
}
