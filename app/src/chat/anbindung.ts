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
  ) {
    this.ansicht = new ChatAnsicht({ aufTerminal: () => this.zeigen(false) });
    this.kasten.appendChild(this.ansicht.element());
    // Der Griff steht am Pane, solange die Ansicht AUS ist: ohne ihn gaebe es
    // keinen Weg zurueck ins Gespraech, sobald jemand einmal auf Terminal
    // gestellt hat. Er ist klein und sitzt in der Ecke, weil er dem Terminal
    // darunter nichts wegnehmen darf.
    this.griff = document.createElement('button');
    this.griff.className = 'chat-griff';
    this.griff.textContent = t('kopf.gespraech');
    this.griff.addEventListener('click', () => this.zeigen(true));
    this.kasten.appendChild(this.griff);
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
        // zeichne()) -- der Griff wird deshalb hier nachgezogen, nicht schon beim Bauen.
        this.griff.textContent = t('kopf.gespraech');
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
