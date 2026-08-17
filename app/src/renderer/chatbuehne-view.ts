// DIE CHAT-SITZUNG AUF DER BUEHNE DES HAUPTFENSTERS -- die Naht zwischen der
// Ansicht (chatbuehne/ansicht.ts, reines DOM) und der Bruecke (`window.awbChat`).
//
// WARUM HIER UND NICHT IN EINEM EIGENEN FENSTER (Umbau 13.08.). Bis zum 12.08.
// bekam jede Chat-Sitzung ein eigenes BrowserWindow. Begruendet war das damit,
// dass die Buehne des Hauptfensters in tmux-ZELLEN rechnet und eine
// Chat-Sitzung keinen Pane hat -- eine zweite Kachelquelle in den Renderer zu
// ziehen haette jede Flaechen- und Rasterprobe mit in die Haftung genommen.
// alice hat nach dem ersten echten Gebrauch anders entschieden: „du hast es
// als extra fenster, ich will es aber auch hier in der workbench als
// orchestrator." Beides gilt jetzt, und zwar OHNE die befuerchtete Umrechnung:
// die Ansicht liegt als EIGENER Kasten (`#chatbuehne`) UEBER dem Kachelgitter,
// genau wie die Lese-Ansicht eines Panes (chat/anbindung.ts) ueber ihrem
// Terminal liegt. Das Gitter darunter bleibt unberuehrt, tmux bekommt weiter
// dieselben Zahlen, und keine Zelle wird umgerechnet.
//
// DER PROZESS LEBT IM HAUPTPROZESS, nicht hier. Was gezeigt wird, entscheidet
// allein das Modell (`chatGezeigt`); wird eine Terminal-Sitzung gewaehlt, geht
// dieser Kasten zu und die Sitzung dahinter laeuft weiter.
import {
  Chatansicht, type Dateivorschlag, type Stand, type Werkstattworker,
} from '../chatbuehne/ansicht';

/** Die Bruecke des Hauptfensters, soweit die Chat-Sitzung sie braucht. */
export interface ChatBruecke {
  daten(seit: number): Promise<(Stand & { id: string }) | null>;
  senden(text: string): Promise<boolean>;
  freigabe(anfrageId: string, erlauben: boolean): Promise<boolean>;
  neustart(): Promise<boolean>;
  /** Den Freigabemodus zur Laufzeit umstellen (Luecke 5c). */
  modus(modus: string): Promise<boolean>;
  /** Einen laufenden Zug unterbrechen (Punkt 6). */
  halt(): Promise<boolean>;
  /** Die Dateiliste des Projektordners fuer das `@` (Punkt 3). */
  dateien(): Promise<{ ordner: string; quelle: 'git' | 'dateisystem'; dateien: Dateivorschlag[] }>;
  onStand(fn: (s: Stand & { id: string }) => void): void;
  bereit(id: string): void;
}

const LEER: Stand = {
  kopf: {
    sessionId: '', modell: '', ordner: '', modus: '',
    arbeitet: false, wartetAufFreigabe: false, tokens: 0, kosten: -1,
    kontext: 0, kompaktierungen: 0, letzteKompaktierung: null,
    fehler: '', initGesehen: false, takt: 0, modi: [], modusFehler: '',
  },
  befehle: [],
  geaendert: [],
  ordnung: [],
  seit: 0,
  sprache: 'de',
  laeuft: true,
  neustartMoeglich: false,
  status: {
    ordner: '', zweig: '', modell: '', tokens: 0, fenster: 0, kosten: -1,
    fuenfStunden: -1, siebenTage: -1, zurueck: '',
  },
};

export class Chatbuehne {
  /** Die Ansicht der gerade gezeigten Sitzung. Beim Wechsel wird sie neu gebaut. */
  private ansicht: Chatansicht;

  /** Welche Chat-Sitzung liegt auf der Buehne? Leer heisst: keine. */
  private chat = '';

  private letzter: Stand = LEER;

  /**
   * Die gemessenen Zeichenzeiten -- die Zahlen, mit denen
   * shell/tests/test-app-chatsdk-last.sh belegt, dass der Aufwand je Stueck
   * NICHT mit der Laenge des Gespraechs waechst (Befund B1).
   */
  private readonly zeiten: number[] = [];

  constructor(
    private readonly kasten: HTMLElement,
    private readonly bruecke: ChatBruecke | undefined,
  ) {
    this.ansicht = this.neueAnsicht();
    this.bruecke?.onStand((s) => {
      // Ein Stand einer Sitzung, die gerade NICHT auf der Buehne liegt, wird
      // verworfen: er gehoerte in eine andere Ansicht, und eingemischt saehe
      // er aus wie ein Teil dieses Gespraechs.
      if (!s || s.id !== this.chat) return;
      const start = performance.now();
      this.zeichne(s);
      this.zeiten.push(performance.now() - start);
    });
  }

  /** Welche Sitzung gerade gezeigt wird -- leer, solange keine gezeigt wird. */
  gezeigter(): string {
    return this.chat;
  }

  /**
   * DAS MODELL ENTSCHEIDET, WAS LIEGT. Aufgerufen bei jedem `awb:model`: steht
   * dort eine andere Sitzung als hier, wird gewechselt; steht dort keine, geht
   * der Kasten zu.
   */
  nachModell(gezeigt: string, worker: Werkstattworker[] = []): void {
    // DIE WORKER KOMMEN AUS DEM MODELL, bei jedem Takt -- auch dann, wenn sich
    // die gezeigte Sitzung NICHT geaendert hat. Sonst stuende die Leiste auf
    // dem Stand des Wechsels, und ein Worker, der danach entstanden ist,
    // taucht nie auf.
    if (gezeigt && gezeigt === this.chat) {
      this.ansicht.setzeWorker(worker);
      return;
    }
    if (gezeigt === this.chat) return;
    this.chat = gezeigt;
    if (!gezeigt) {
      this.kasten.classList.remove('an');
      this.kasten.removeAttribute('data-chat');
      return;
    }
    // Beim Wechsel eine FRISCHE Ansicht: die alte traegt die Bloecke der
    // vorigen Sitzung, und zwei Gespraeche in einem Verlauf waeren schlimmer
    // als ein leerer.
    this.ansicht = this.neueAnsicht();
    this.letzter = LEER;
    this.kasten.dataset.chat = gezeigt;
    this.kasten.classList.add('an');
    this.zeichne(LEER);
    this.ansicht.setzeWorker(worker);
    if (!this.bruecke) return;
    // `seit: 0` heisst „alles" -- danach schickt der Hauptprozess von sich aus
    // nur noch das Geaenderte (Befund B1).
    void this.bruecke.daten(0).then((s) => {
      // Wurde in der Zwischenzeit weitergewechselt, gehoert dieser Stand nicht
      // mehr hierher -- und gemeldet wird auch nichts, sonst beendete diese
      // Meldung das Warten des NEUEN Wechsels.
      if (this.chat !== gezeigt) return;
      if (s && s.id === gezeigt) this.zeichne(s);
      this.ansicht.fokus();
      this.bruecke?.bereit(gezeigt);
    });
  }

  /**
   * DER TESTHAKEN, dieselbe Bauart wie im alten Chat-Fenster: ein kopfloser
   * Test kann einen Stand einsetzen und die Ansicht zeichnen lassen, OHNE dass
   * ein echter Claude-Prozess laufen muss. Das ist der Grund, warum der
   * Sichtbeleg dieser Ansicht kein Geld kostet und in jeder Umgebung
   * durchlaeuft.
   */
  haken(): Record<string, unknown> {
    return {
      zeichne: (s: Stand) => this.zeichne(s),
      stand: () => this.letzter,
      /** Welche Sitzung liegt auf der Buehne, und ist der Kasten offen? */
      buehne: () => ({ chat: this.chat, an: this.kasten.classList.contains('an') }),
      zeiten: () => this.zeiten.slice(),
      zeitenLeeren: () => {
        this.zeiten.length = 0;
        return true;
      },
      /**
       * EIN ELEMENT ZEICHNEN UND SPAETER WIEDERERKENNEN -- der Beleg zu Befund
       * B1, dass ein Teilstueck nur seinen eigenen Block anfasst.
       *
       * Die Marke wird als EIGENSCHAFT am Objekt abgelegt, nicht als Attribut:
       * ein neu gebautes Element traegt dasselbe HTML, aber niemals dieselbe
       * Eigenschaft. Wer die Marke wiederfindet, hat bewiesen, dass genau
       * dieser Knoten stehengeblieben ist -- und mit ihm alles, was daran
       * haengt: die Textauswahl des Menschen und der Rollstand eines
       * aufgeklappten Feldes.
       */
      marke: (css: string, wert?: string) => {
        const e = this.kasten.querySelector(css) as (HTMLElement & { __awbMarke?: string }) | null;
        if (!e) return '';
        if (typeof wert === 'string') e.__awbMarke = wert;
        return e.__awbMarke ?? '';
      },
      /**
       * TEXT INS FELD SCHREIBEN, OHNE ABZUSCHICKEN -- der Griff, mit dem sich
       * die Vervollstaendigung belegen laesst (Punkt 3). `tippen` unten
       * schickt sofort ab und kaeme nie zu einer offenen Liste.
       *
       * Der Schreibstrich wird ans Ende gesetzt, bevor das `input`-Ereignis
       * geht: die Ansicht entscheidet an genau dieser Stelle, ob ein `/` oder
       * `@` dahintersteht.
       */
      feld: (text: string) => {
        const feld = this.kasten.querySelector('.csdk-feld') as HTMLTextAreaElement | null;
        if (!feld) return false;
        feld.focus();
        feld.value = text;
        feld.setSelectionRange(text.length, text.length);
        feld.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      },
      /**
       * Eine Taste ans Feld geben -- Pfeiltasten, Tabulator, Escape. Mit dem
       * Vorsatz `Shift+` kommt sie MIT gedrueckter Umschalttaste an; ohne den
       * liesse sich Befund 9 des Reviews nicht belegen (Umschalt+Eingabe bei
       * offener Liste soll eine neue Zeile beginnen, keinen Vorschlag setzen).
       */
      taste: (roh: string) => {
        const feld = this.kasten.querySelector('.csdk-feld') as HTMLTextAreaElement | null;
        if (!feld) return '';
        const umschalt = roh.startsWith('Shift+');
        const key = umschalt ? roh.slice('Shift+'.length) : roh;
        feld.dispatchEvent(new KeyboardEvent('keydown', {
          key, shiftKey: umschalt, bubbles: true, cancelable: true,
        }));
        return feld.value;
      },
      /** Was die Vervollstaendigungsliste gerade zeigt -- leer, wenn sie zu ist. */
      vervoll: () => {
        const liste = this.kasten.querySelector('.csdk-vervoll') as HTMLElement | null;
        if (!liste || liste.hidden) return { offen: false, kopf: '', eintraege: [] as string[] };
        return {
          offen: true,
          kopf: liste.querySelector('.csdk-vervoll-kopf')?.textContent ?? '',
          eintraege: [...liste.querySelectorAll('.csdk-vervoll-wert')]
            .map((e) => e.textContent ?? ''),
        };
      },
      /** Was die Statusleiste unten zeigt (Punkt 2). */
      status: () => {
        const leiste = this.kasten.querySelector('.csdk-status') as HTMLElement | null;
        if (!leiste) return { da: false, felder: [] as string[] };
        return {
          da: true,
          felder: [...leiste.querySelectorAll('.csdk-statuswert')].map((e) => e.textContent ?? ''),
        };
      },
      /** Text ins Feld schreiben und abschicken -- fuer den Eingabe-Test. */
      tippen: (text: string) => {
        const feld = this.kasten.querySelector('.csdk-feld') as HTMLTextAreaElement | null;
        if (!feld) return false;
        feld.value = text;
        feld.dispatchEvent(new Event('input', { bubbles: true }));
        feld.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        return feld.value === '';
      },
    };
  }

  private neueAnsicht(): Chatansicht {
    const a = new Chatansicht({
      aufSenden: (text) => {
        void this.bruecke?.senden(text);
      },
      aufFreigabe: (anfrageId, erlauben) => {
        void this.bruecke?.freigabe(anfrageId, erlauben);
      },
      aufNeustart: () => {
        void this.bruecke?.neustart();
      },
      aufModus: (modus) => {
        void this.bruecke?.modus(modus);
      },
      aufHalt: () => {
        void this.bruecke?.halt();
      },
      // Die Dateiliste kommt vom Hauptprozess -- WELCHER Ordner gelesen wird,
      // entscheidet er an der Sitzung auf der Buehne, nicht diese Ansicht.
      // Die HERKUNFT reist mit: der Rueckfallweg ohne git kennt nur die
      // .gitignore der Wurzel, und die Liste sagt das in ihrer Kopfzeile
      // (Reviewbefund 10).
      dateien: async () => {
        const a = await this.bruecke?.dateien();
        return { quelle: a?.quelle ?? 'git', dateien: a?.dateien ?? [] };
      },
      // Der Wechsel zu einem Worker geht ueber DIESELBE Bruecke wie jede
      // andere Bedienung des Hauptfensters -- nicht ueber `awbChat`: er
      // betrifft die Buehne als Ganzes (Kacheln statt Gespraech), nicht die
      // Sitzung. Die Chat-Kennung reist mit, weil ein Pane allein nicht sagt,
      // zu welcher Werkstatt er gehoert.
      aufWorker: (paneId) => {
        if (!this.chat) return;
        window.awbBridge.bedienung('chat-worker', `${this.chat}|${paneId}`);
      },
    });
    this.kasten.replaceChildren(a.element());
    return a;
  }

  private zeichne(s: Stand): void {
    this.letzter = s;
    this.ansicht.zeichne(s);
  }
}
