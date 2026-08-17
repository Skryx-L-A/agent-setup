// Der geführte erste Start (SPEC-V4 3.8): ein EIGENES Fenster, viertes Geschwister von
// Einstellungs-, Sitzungs- und Verbrauchsfenster (einstellungsfenster.ts, sitzungsfenster.ts,
// verbrauchsfenster.ts). Vier kurze Fragen -- Maschine, Harness anmelden, Modell, fertig --, jede
// überspringbar, alles andere bleibt auf Vorgabe. Die Logik, welcher Schritt wann kommt, steht in
// app/src/erststart/ablauf.ts; hier steht nur das Fenster.
//
// DIE AUFLAGE AUS DIESEM HAUS gilt auch hier: es entsteht immer mit `show:false` (`baue()`), und
// der Steuerkanal darf es bauen und lesen, aber nicht zeigen. Anders als bei den drei
// Geschwistern gibt es hier aber ZWEI Wege zu `show()`, nicht einen -- aus einem Grund, der aus
// SPEC-V4 3.8 selbst folgt:
//
//   `zeigeAutomatisch()`   Der Weg, um den es in 3.8 geht: „Wer das Programm zum ersten Mal
//                          öffnet, wird geführt" -- OHNE Klick. Erreichbar ist er trotzdem nur
//                          über dieselbe Bedingung, unter der auch das HAUPTfenster sichtbar wird
//                          (main.ts, `if (zeigen) win.show()`): die Befehlszeilen-Angabe --show,
//                          die ein Mensch beim wirklichen Start setzt. Der Steuerkanal und jeder
//                          Test starten das Programm mit --headless und erreichen diesen Pfad
//                          darum nie -- geprüft wird nur, DASS er beim ersten Start überhaupt
//                          gebaut wird (die SPUR unten), nicht dass er sich zeigt: genau dasselbe
//                          "kein Test erreicht ihn" wie bei den drei Geschwistern.
//   `zeigeNachEchtemKlick()` Für das manuelle Wiederaufrufen "über die Seite Programm" (SPEC-V4
//                          3.8) -- derselbe Weg wie bei den drei Geschwistern: ein isTrusted-Klick
//                          im Hauptfenster, über den Steuerkanal nie erreichbar.
//
// Beide Wege sind nur Verdrahtung; ihre Bedingung entscheidet main.ts, nicht diese Datei.
import { BrowserWindow } from 'electron';
import { join } from 'node:path';

export class Erststartfenster {
  private fenster: BrowserWindow | null = null;
  private bereit: Promise<void> | null = null;

  constructor(private readonly eltern: () => BrowserWindow | null) {}

  /** Das Fenster, wenn es existiert -- für Auskunft und Foto. */
  aktuell(): BrowserWindow | null {
    return this.fenster && !this.fenster.isDestroyed() ? this.fenster : null;
  }

  /** Bauen und laden, OHNE zu zeigen. Ein stehendes Fenster wird wiederverwendet. */
  async baue(): Promise<BrowserWindow> {
    const da = this.aktuell();
    if (da && this.bereit) {
      await this.bereit;
      return da;
    }
    const eltern = this.eltern();
    const w = new BrowserWindow({
      width: 620,
      height: 480,
      minWidth: 520,
      minHeight: 420,
      useContentSize: true,
      // Immer. Sichtbar wird es nur über zeigeAutomatisch() oder zeigeNachEchtemKlick(), siehe
      // Klassendoc.
      show: false,
      parent: eltern ?? undefined,
      modal: false,
      title: 'Agent-Workbench — Erste Schritte',
      backgroundColor: '#101216',
      paintWhenInitiallyHidden: true,
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'erststart-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        sandbox: false,
      },
    });
    w.setContentSize(620, 480);
    w.on('closed', () => {
      this.fenster = null;
      this.bereit = null;
    });
    this.fenster = w;
    this.bereit = w.loadFile(join(__dirname, '..', 'erststart', 'index.html'));
    await this.bereit;
    process.stderr.write('Erststartfenster: gebaut, noch nicht gezeigt\n');
    return w;
  }

  /**
   * Der erste-Start-Weg OHNE Klick (SPEC-V4 3.8) -- siehe Klassendoc. Wird von main.ts nur dann
   * überhaupt aufgerufen, wenn `erststartErledigt` (noch) nicht gesetzt ist; ob danach wirklich
   * `show()` läuft, entscheidet der `zeigen`-Parameter (main.ts: dieselbe Bedingung wie beim
   * Hauptfenster).
   */
  async zeigeAutomatisch(zeigen: boolean): Promise<void> {
    const w = await this.baue();
    process.stderr.write('Erststartfenster: erster Start erkannt, gebaut\n');
    if (!zeigen) return;
    process.stderr.write('Erststartfenster: automatisch gezeigt (erster Start)\n');
    if (w.isVisible()) w.focus();
    else w.show();
    process.stderr.write(`Erststartfenster: sichtbar=${w.isVisible()}\n`);
  }

  /**
   * DER EINE show()-AUFRUF für das manuelle Wiederaufrufen. Erreichbar ausschließlich über den
   * IPC-Kanal, den der Renderer nur bei `isTrusted === true` bedient -- derselbe Aufbau wie bei
   * den drei Geschwistern.
   */
  async zeigeNachEchtemKlick(): Promise<void> {
    process.stderr.write('Erststartfenster: echter Klick, show()\n');
    const w = await this.baue();
    if (w.isVisible()) w.focus();
    else w.show();
    process.stderr.write(`Erststartfenster: sichtbar=${w.isVisible()}\n`);
  }

  schliesse(): void {
    this.aktuell()?.close();
  }
}
