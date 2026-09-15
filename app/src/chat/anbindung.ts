// DIE ANBINDUNG DER ANSICHT AN EINEN PANE (SPEC-V4 Abschnitt 6).
//
// Sie haelt je Pane eine `ChatAnsicht`, holt im Takt ihren Stand und legt sie
// UEBER den Pane -- der Pane bleibt darunter stehen, laeuft weiter und wird
// weiter ausgewertet.
//
// WARUM DER RENDERER FRAGT und der Hauptprozess nicht von sich aus schickt:
// gelesen werden soll nur, was gerade jemand ansieht. Ein Hauptprozess, der bei
// jedem Takt fuer jeden Pane eine Sitzungsdatei oeffnet, kostet bei acht Workern
// acht Dateizugriffe je Sekunde fuer Text, den niemand liest.
//
// WAS HIER NICHT STEHT: ein Weg, etwas abzuschicken. Getippt wird im Terminal
// darunter -- die Ansicht liest, mehr nicht.
import { ChatAnsicht } from './ansicht';
import type { ChatStand } from './typen';
import { t } from './texte';
import type { PfadHaken } from './pfadlinks';

/**
 * Nur das eine Stueck der Bruecke, das diese Datei braucht -- und die Nutzlast
 * bleibt `unknown`, wie sie ueber die Bruecke kommt. Der Renderer deklariert
 * `chatStand` in editor-view.ts (die einzige erlaubte Stelle fuer den Typ von
 * `window.awbEditorBridge`), und dort steht bewusst kein `ChatStand`: sonst
 * fuehrte der Renderer die Begriffe der Chat-Ansicht ein zweites Mal. Gedeutet
 * wird die Antwort deshalb hier, an einer Stelle.
 */
interface ChatBruecke {
  chatStand(paneId: string): Promise<{ ok: boolean; value?: unknown; error?: string } | { ok: false; error: string }>;
  chatAnsichtSetzen(paneId: string, an: boolean): Promise<{ ok: boolean; value?: unknown; error?: string }>;
}

/** Sieht die Antwort wie ein Stand aus? Sonst wird sie nicht gezeichnet. */
function alsStand(w: unknown): ChatStand | null {
  if (!w || typeof w !== 'object') return null;
  const d = w as Record<string, unknown>;
  return Array.isArray(d.nachrichten) && typeof d.moeglich === 'boolean' ? (w as ChatStand) : null;
}

/** Wie oft nachgesehen wird, solange die Ansicht offen ist. */
export const TAKT_MS = 2000;

export class ChatAnbindung {
  private readonly ansicht: ChatAnsicht;

  private readonly griff: HTMLButtonElement;

  private uhr: number | undefined;

  private laeuft = false;

  constructor(
    private readonly kasten: HTMLElement,
    private readonly paneId: string,
    private readonly bruecke: ChatBruecke,
    offen: boolean,
    /** Pfade pruefen und oeffnen (chatdatei, 05.09.2026) -- kommt von aussen, wie die Bruecke. */
    pfade: PfadHaken,
  ) {
    this.ansicht = new ChatAnsicht({ aufTerminal: () => this.terminalWaehlen(), pfade });
    this.kasten.appendChild(this.ansicht.element());
    // DER GRIFF STEHT IN DER KOPFZEILE DES PANES (04.09.2026). Ohne ihn gaebe
    // es keinen Weg zurueck ins Gespraech, sobald jemand einmal auf Terminal
    // gestellt hat -- aber als beschrifteter Knopf ueber dem Terminal lag er
    // bei drei Kacheln dreimal gleichzeitig im Bild. Die Kopfzeile traegt
    // ohnehin alles, was diesem einen Pane gehoert (Name, Modell, Tokenstand,
    // Zoom); dort ist er ein Symbol neben dem Zoom-Knopf und kostet nichts.
    //
    // Der Waehler `.chat-griff` bleibt: `awb-ctl pane-chat-klick` spricht ihn
    // ueber genau diesen Namen an, und die Kopfzeile liegt im selben Kasten.
    // Gibt es ausnahmsweise keine Kopfzeile, faellt er in den Kasten zurueck.
    this.griff = document.createElement('button');
    this.griff.className = 'chat-griff';
    this.griff.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"'
      + ' stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">'
      + '<path d="M2.6 4.2a1.6 1.6 0 011.6-1.6h7.6a1.6 1.6 0 011.6 1.6v4.6a1.6 1.6 0'
      + ' 01-1.6 1.6H6.4L3.4 13V10.4h-.8z"/></svg>';
    this.griff.title = t('kopf.gespraech');
    this.griff.addEventListener('click', () => this.gespraechWaehlen());
    const kopf = this.kasten.querySelector('.panekopf');
    (kopf ?? this.kasten).appendChild(this.griff);
    this.zeigen(offen);
    // EINMAL nachsehen, auch wenn die Ansicht zu ist: welche Ansicht ein Pane
    // zeigt, entscheidet die Regel in chat/ansichtsregel.ts aus drei Ebenen --
    // was der Harness kann, was fuer ihn und fuer diese ROLLE eingestellt ist,
    // und ob diese Sitzung per Rechtsklick uebersteuert wurde. Alle drei kennt
    // nur der Hauptprozess; ein Pane, der gerade entsteht, ist genau der Fall,
    // fuer den das zaehlt. Danach wird nur noch gelesen, solange jemand
    // hinsieht -- ein Umschalten waehrenddessen kommt als eigene Nachricht
    // (main.ts, 'awb:chat-ansicht').
    if (!offen) void this.hole(true);
  }

  /**
   * EIN KLICK AUF DEN GRIFF ODER AUF "Terminal zeigen" IN DER ANSICHT (22.08.):
   * beide schreiben die Sitzungs-Uebersteuerung, genau wie der Rechtsklick auf
   * die Sitzung -- sonst kann eine dort schon gesetzte Uebersteuerung (aus dem
   * Rechtsklick, oder aus einem frueheren Klick hier) den naechsten Klick
   * stumm ausser Kraft setzen: die Ansicht ginge auf, `hole()` bekaeme aber
   * `moeglich: false` zurueck und zeigte den Grund statt des Gespraechs.
   *
   * `zeigen()` selbst bleibt rein anzeigend -- sie laeuft auch aus dem
   * Konstruktor und aus dem automatischen Oeffnen nach der Rollenvorgabe
   * (`hole(true)`), und keiner der beiden Faelle ist ein Klick, der eine
   * Uebersteuerung verdient.
   */
  private gespraechWaehlen(): void {
    // ERST SCHREIBEN, DANN ZEIGEN: `zeigen(true)` liest ueber `hole()` sofort
    // den Stand nach -- laeuft das VOR der geschriebenen Uebersteuerung, saehe
    // dieser erste Blick noch die alte Sperre.
    void this.bruecke.chatAnsichtSetzen(this.paneId, true).finally(() => this.zeigen(true));
  }

  private terminalWaehlen(): void {
    void this.bruecke.chatAnsichtSetzen(this.paneId, false).finally(() => this.zeigen(false));
  }

  /** Ansicht an oder aus. Beim Anschalten wird sofort einmal gelesen. */
  zeigen(an: boolean): void {
    this.ansicht.sichtbar(an);
    this.griff.style.display = an ? 'none' : '';
    if (an) {
      void this.hole();
      if (this.uhr === undefined) {
        this.uhr = setInterval(() => void this.hole(), TAKT_MS) as unknown as number;
      }
    } else if (this.uhr !== undefined) {
      clearInterval(this.uhr);
      this.uhr = undefined;
    }
  }

  istOffen(): boolean {
    return this.ansicht.istSichtbar();
  }

  /** Der Pane ist weg: Uhr aus, Kasten weg. Kein Takt fuer etwas, das nicht mehr da ist. */
  weg(): void {
    if (this.uhr !== undefined) clearInterval(this.uhr);
    this.uhr = undefined;
    this.ansicht.element().remove();
    this.griff.remove();
  }

  private async hole(nurVorgabe = false): Promise<void> {
    // Ein Durchgang zur Zeit: ein langsamer Zugriff darf sich nicht stapeln.
    if (this.laeuft) return;
    this.laeuft = true;
    try {
      const antwort = await this.bruecke.chatStand(this.paneId);
      const stand = antwort.ok ? alsStand((antwort as { value?: unknown }).value) : null;
      if (nurVorgabe) {
        // Der erste Blick entscheidet nur, ob die Ansicht offen beginnt.
        if (stand?.moeglich && stand.vorgabe) this.zeigen(true);
        return;
      }
      if (stand) {
        this.ansicht.zeichne(stand);
        // Die Sprache steht erst nach dem ersten Stand fest (setzeSprache() lief gerade in
        // zeichne()) -- das Schildchen des Griffs wird deshalb hier nachgezogen,
        // nicht schon beim Bauen. Seine Zeichnung haengt nicht an der Sprache.
        this.griff.title = t('kopf.gespraech');
        return;
      }
      this.ansicht.zeichne({
        paneId: this.paneId,
        harness: '',
        via: '',
        moeglich: false,
        grund: antwort.error || t('grund.keinBlock'),
        quelle: '',
        herkunft: '',
        nachrichten: [],
        bruecke: {
          freigabeOffen: false, freigabeText: '', auslastung: -1, tokens: 0, fenster: 0, arbeitet: false,
        },
        vorgabe: false,
        stand: 0,
      });
    } finally {
      this.laeuft = false;
    }
  }
}
