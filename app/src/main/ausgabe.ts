// DIE AUSGABE EINES PANES KOMMT IN BUENDELN IM RENDERER AN (2026-08-16).
//
// Vorher ging jedes einzelne `%output`-Stueck des tmux-Steuerkanals als eigene
// IPC-Nachricht ueber die Bruecke und wurde im Renderer einzeln in xterm
// geschrieben. GEMESSEN auf eigenem Testsocket: `seq 20000` in einem Pane
// erzeugt 1305 Stuecke mit im Mittel 202 Bytes in rund zwei Sekunden -- also
// ueber 600 IPC-Nachrichten je Sekunde und Pane, jede mit eigener
// Base64-Umwandlung, eigenem Strukturklon und eigenem xterm-Schreibvorgang.
//
// Eigene Messung vom 16.08. auf einem Testsocket (test-app-ausgabe-buendel.sh):
// 1569 Stuecke mit zusammen 129 069 Bytes -- durch diese Buendelung wurden daraus
// zwei Nachrichten.
//
// Diese Klasse sammelt sie je Pane und gibt sie im festen Takt ab. xterm
// verkraftet einen grossen `write` deutlich besser als viele kleine, und die
// Bruecke ueberquert dabei nur noch ein Bruchteil der Nachrichten.
//
// ZWEI ZUSAGEN, an denen sie haengt:
//
//   REIHENFOLGE. Was fuer einen Pane hereinkommt, geht in derselben Reihenfolge
//   wieder hinaus -- die Stuecke werden aneinandergehaengt, nie umsortiert und
//   nie zusammengefasst. Zwischen zwei Panes gibt es keine Ordnung, die
//   jemandem etwas verspraeche: der Renderer verteilt an der Pane-Kennung.
//
//   KEIN UEBERHOLEN EINER MOMENTAUFNAHME. Wer ein `awb:layout` mit
//   Pane-Inhalten schickt, gibt VORHER ab (`abgeben()`). Sonst kaeme
//   gesammelte Ausgabe NACH dem Bild an, auf dem sie schon steht, und stuende
//   doppelt da. Deshalb liegt das Abgeben in main.ts an genau einer Stelle:
//   in `lageSenden`.

export type AusgabeSenden = (paneId: string, base64: string) => void;

/**
 * Der Sammeltakt in Millisekunden. 16 ms ist ein Einzelbild bei 60 Hz: kuerzer
 * brächte nichts, weil der Renderer ohnehin nur je Bild zeichnet, laenger waere
 * als Verzoegerung beim Tippen zu spueren.
 */
export const BUENDEL_MS = 16;

export class AusgabeBuendel {
  private readonly teile = new Map<string, Buffer[]>();
  private uhr: NodeJS.Timeout | null = null;

  constructor(private readonly senden: AusgabeSenden, private readonly ms: number = BUENDEL_MS) {}

  nimm(paneId: string, data: Buffer): void {
    const liste = this.teile.get(paneId);
    if (liste) liste.push(data);
    else this.teile.set(paneId, [data]);
    // EINE Uhr fuer alle Panes: sie laeuft ab dem ERSTEN Stueck des Buendels und
    // wird nicht bei jedem weiteren neu gestellt. Ein nachgestelltes Zeitfenster
    // kaeme bei durchgehender Ausgabe nie zum Ende -- der Bildschirm bliebe
    // stehen, solange etwas druckt, und das ist genau der Fall, um den es geht.
    if (!this.uhr) this.uhr = setTimeout(() => this.abgeben(), this.ms);
  }

  /** Sofort abgeben, was liegt. Nach dem Aufruf ist nichts mehr unterwegs. */
  abgeben(): void {
    if (this.uhr) {
      clearTimeout(this.uhr);
      this.uhr = null;
    }
    if (!this.teile.size) return;
    for (const [paneId, liste] of this.teile) {
      this.senden(paneId, Buffer.concat(liste).toString('base64'));
    }
    this.teile.clear();
  }
}
