// Das Sitzungsfenster hinter dem Plus-Knopf: ein EIGENES kleines Fenster mit
// zwei Wegen -- eine neue Sitzung starten oder eine alte fortsetzen.
//
// WARUM NICHT MEHR DIE UEBERLAGERUNG. Bis zum 06.08. klappte das Plus eine
// Flaeche ueber der Buehne auf (`#neu` in renderer/index.html). Sie konnte genau
// einen der beiden Wege -- Ordner waehlen und starten -- und fuer den zweiten
// gab es sie gar nicht: eine gestoppte Sitzung fortzusetzen ging nur ueber den
// Knopf an ihrer Zeile in der Leiste, und der zeigt sich erst, wenn der Haken
// fuer beendete Sitzungen steht. Beide Wege gehoeren an dieselbe Stelle, und
// eine Flaeche ueber der Buehne verdeckt genau das Terminal, wegen dem man
// hinsieht. Bauform und Auflagen sind deshalb die des Einstellungsfensters
// (einstellungsfenster.ts); diese Datei ist sein Zwilling, nicht seine Kopie:
// sie zeigt anderes und schreibt nichts in die Einstellungsdatei.
//
// WAS GETEILT BLEIBT. Gestartet und fortgesetzt wird ueber die Wege, die es
// schon gibt: `wb-code` fuer eine neue Sitzung (main.ts, `sessionAnlegen`) und
// `reviveCommand`/`darfWiederherstellen` fuer das Fortsetzen (revive.ts, main.ts
// `sessionWiederherstellen`). Hier wird nichts davon nachgebaut -- dieses
// Fenster stellt die Frage, die Antwort fuehren dieselben Funktionen aus wie
// vorher.
import { BrowserWindow } from 'electron';
import { join } from 'node:path';

import { darfWiederherstellen, type ReviveCommand } from './revive';
import type { SessionInfo } from './sessions';

/**
 * Eine bekannte Sitzung, so wie die Seite „Fortsetzen" sie zeigt. Bewusst
 * WENIGER als `SessionInfo`: Worker, Panes und Freigaben gehoeren in die
 * Leiste, hier steht nur, was die Wahl entscheidet -- wo sie lief, womit, wann
 * zuletzt, und ob sie ueberhaupt zurueckkommen kann.
 */
export interface SitzungsZeile {
  id: string;
  name: string;
  dir: string;
  machine: string;
  harness: string;
  model: string;
  state: string;
  lastActive: string;
  /**
   * Darf diese Zeile fortgesetzt werden? Die Antwort kommt aus
   * `darfWiederherstellen` -- derselben Pruefung, die main.ts unmittelbar vor
   * dem Start ein zweites Mal anwendet.
   */
  fortsetzbar: boolean;
  /**
   * Ein Satz fuer den Menschen, nie leer: bei einer fortsetzbaren Sitzung, was
   * mit ihrer Unterhaltung geschieht (aus `reviveCommand`, nicht aus einer
   * zweiten Regel hier); sonst, warum sie nicht zur Wahl steht.
   */
  grund: string;
  /** 'resumed' oder 'fresh' bei einer fortsetzbaren Zeile, sonst leer. */
  unterhaltung: string;
}

export interface SitzungsDaten {
  machine: string;
  /** Die Sprache der Oberflaeche -- dieselbe Ableitung wie beim Einstellungsfenster (einstellungen.ts, `sprache()`). */
  sprache: string;
  /**
   * Fuer welche Maschinen sich eine NEUE Sitzung anlegen laesst -- dieselbe
   * Liste wie die Maschinen-Seite des Einstellungsfensters (config.remoteMachines,
   * aus der geteilten Datei). Leer bei einem Ein-Rechner-Nutzer, und dann
   * entfaellt im Fenster die Maschinenwahl still (11.08., Bauteil 1) -- eine
   * feste Liste stuende dem Auftrag ausdruecklich entgegen ("skalierbar fuer
   * andere mit einer anderen Menge an Computern").
   */
  remoteMachines: string[];
  /**
   * Die bekannten Sitzungen, FLACH und absteigend nach letzter Aktivitaet.
   * Gruppiert nach Ordner wird erst in der Oberflaeche (sitzung/sitzung.ts):
   * das ist eine Frage der Anzeige, und eine zweite Vorstellung davon, was eine
   * Sitzung ist, soll hier nicht entstehen.
   */
  sitzungen: SitzungsZeile[];
}

/**
 * Aus dem Sessionmodell die Liste der Seite „Fortsetzen".
 *
 * GEZEIGT WERDEN ALLE, auch die laufenden. Eine Liste, die nur die toten
 * fuehrt, laesst den Menschen raten, ob eine Sitzung fehlt oder nur laeuft --
 * und der Haken „beendete Sitzungen zeigen" (A12) gehoert der LEISTE, nicht
 * diesem Fenster. Was nicht zurueckgeholt werden kann, traegt seinen Grund.
 *
 * Die Vorschau kommt von aussen herein (`vorschau`), weil sie die Registry
 * braucht: main.ts haelt sie ohnehin gemerkt und reicht `reviveCommand` mit
 * dem passenden `resume`-Block herein. Zwei Ideen davon, was beim Fortsetzen
 * geschieht, waeren genau die Stelle, an der Anzeige und Aufruf auseinander
 * laufen.
 */
export function sitzungsZeilen(
  sessions: SessionInfo[],
  vorschau: (s: SessionInfo) => ReviveCommand,
  /**
   * Der GENAUE Grund je Maschine, warum ihre Sitzungen gerade nicht einsehbar
   * sind -- leer, wenn es keinen genaueren gibt als „sie antwortet nicht"
   * (07.08.). Ohne diese Angabe stuende an einer hiesigen Sitzung „Die Maschine
   * antwortet gerade nicht", obwohl die Maschine antwortet und nur ihr tmux
   * fehlt; und an einer Fernsitzung stuende dasselbe, obwohl die Maschine
   * geantwortet hat und nur ihre Antwort unbrauchbar war. Alle drei Faelle
   * fuehren zum Zustand 'unreachable', aber es sind drei verschiedene
   * Auskuenfte, und die falsche schickt jemanden auf die Suche nach einem
   * Netzproblem, das es nicht gibt.
   *
   * Eine Funktion und keine zwei Zeichenketten, weil es nicht mehr nur um die
   * eigene Maschine geht: main.ts kennt den hiesigen tmux-Befund und den
   * Format-Befund jeder Fernmaschine und beantwortet damit dieselbe Frage fuer
   * jede von ihnen.
   */
  grundFuerMaschine: (machine: string) => string = () => '',
): SitzungsZeile[] {
  const zeilen = sessions.map((s) => {
    const kann = darfWiederherstellen(s);
    let grund: string;
    let unterhaltung = '';
    if (kann) {
      const v = vorschau(s);
      grund = v.conversationReason;
      unterhaltung = v.conversation;
    } else if (s.state === 'unreachable' && grundFuerMaschine(s.machine)) {
      grund = grundFuerMaschine(s.machine);
    } else if (s.state === 'unreachable') {
      grund = `Die Maschine '${s.machine}' antwortet gerade nicht.`;
    } else if (s.state !== 'stopped') {
      grund = 'Läuft noch — sie steht schon in der Sessionleiste.';
    } else {
      grund = 'Zu dieser Sitzung ist kein Projektordner gemerkt.';
    }
    return {
      id: s.id,
      name: s.name,
      dir: s.dir,
      machine: s.machine,
      harness: s.harness,
      model: s.model,
      state: s.state,
      lastActive: s.lastActive,
      fortsetzbar: kann,
      grund,
      unterhaltung,
    };
  });
  // Zuletzt aktiv zuerst -- dieselbe Vorgabe wie in der Leiste (uistate.ts,
  // sortSessions mit 'recent'). Wer eine Sitzung fortsetzen will, sucht in aller
  // Regel die, an der er eben noch sass.
  return zeilen.sort((a, b) => (b.lastActive || '').localeCompare(a.lastActive || ''));
}

// --- Das Fenster -----------------------------------------------------------

/**
 * DIE AUFLAGE AUS DIESEM HAUS, hier genauso eingehalten wie beim
 * Einstellungsfenster (dessen Klassendoc erklaert sie ausfuehrlich).
 *
 *   1. Das Fenster entsteht IMMER mit `show: false` (`baue()`). Steuerkanal und
 *      Testsuite bekommen genau diesen Weg: bauen, lesen, fotografieren.
 *   2. `zeigeNachEchtemKlick()` ist die EINZIGE Stelle mit `show()`, und sie
 *      haengt an einer Bedienung, die der Renderer nur bei `isTrusted === true`
 *      schickt (renderer.ts, der Zuhoerer am Plus-Knopf). Ein `el.click()` aus
 *      `executeJavaScript` -- der Weg jedes Tests, `awb-ctl klick neue-session`
 *      eingeschlossen -- traegt `isTrusted === false` und landet in 1.
 *   3. Der Steuerkanal hat KEINEN Befehl, der `zeige()` erreicht.
 *
 * Und dieselbe SPUR auf stderr, aus demselben Grund: den show()-Zweig kann kein
 * Test erreichen, ohne ein Fenster auf Bildschirm des Nutzers zu bringen. Wer auf
 * das Plus drueckt und kein Fenster sieht, liest an den Zeilen mit dem Praefix
 * `Sitzungsfenster:` ab, wo es haengt -- keine Zeile heisst, der Klick kam nie
 * im Hauptprozess an; nur „gebaut, noch nicht gezeigt" heisst, er kam als
 * unechtes Ereignis an.
 */
export class Sitzungsfenster {
  private fenster: BrowserWindow | null = null;
  private bereit: Promise<void> | null = null;

  constructor(private readonly eltern: () => BrowserWindow | null) {}

  /** Das Fenster, wenn es existiert -- fuer Foto und Auskunft. */
  aktuell(): BrowserWindow | null {
    return this.fenster && !this.fenster.isDestroyed() ? this.fenster : null;
  }

  /**
   * Bauen und laden, OHNE zu zeigen. Mehrfach aufrufbar: ein stehendes Fenster
   * wird wiederverwendet, damit ein zweiter Klick nicht ein zweites aufmacht.
   */
  async baue(): Promise<BrowserWindow> {
    const da = this.aktuell();
    if (da && this.bereit) {
      await this.bereit;
      return da;
    }
    const eltern = this.eltern();
    const w = new BrowserWindow({
      // Kleiner als das Einstellungsfenster: zwei Seiten mit je einer Liste,
      // keine Modelltabelle. Breit genug bleibt es fuer einen Pfad in einer
      // Zeile -- ein umgebrochener Projektpfad ist in einer Auswahl unlesbar.
      width: 900,
      height: 620,
      minWidth: 700,
      minHeight: 460,
      useContentSize: true,
      // Immer. Sichtbar wird es nur ueber zeigeNachEchtemKlick(), siehe Klassendoc.
      show: false,
      // Kind des Hauptfensters, damit es darueber bleibt und mit ihm
      // verschwindet -- aber NICHT modal, aus demselben Grund wie dort: modal
      // spraeche das Hauptfenster tot, und dann saehe man das Terminal nicht
      // mehr, aus dem heraus man eine zweite Sitzung aufmacht.
      parent: eltern ?? undefined,
      modal: false,
      title: 'Agent-Workbench — Sitzungen',
      backgroundColor: '#101216',
      paintWhenInitiallyHidden: true,
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'sitzung-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        sandbox: false,
      },
    });
    w.setContentSize(900, 620);
    // Zu ist zu: geschlossen wird es weggeraeumt, der naechste Klick baut neu.
    w.on('closed', () => {
      this.fenster = null;
      this.bereit = null;
    });
    this.fenster = w;
    this.bereit = w.loadFile(join(__dirname, '..', 'sitzung', 'index.html'));
    await this.bereit;
    process.stderr.write('Sitzungsfenster: gebaut, noch nicht gezeigt\n');
    return w;
  }

  /**
   * DER EINZIGE show()-AUFRUF fuer dieses Fenster. Erreichbar ausschliesslich
   * ueber die Bedienung, die der Renderer nur bei `isTrusted === true` schickt.
   */
  async zeigeNachEchtemKlick(): Promise<void> {
    process.stderr.write('Sitzungsfenster: echter Klick, show()\n');
    const w = await this.baue();
    if (w.isVisible()) w.focus();
    else w.show();
    // NACH dem Aufruf gelesen, nicht vorher angenommen.
    process.stderr.write(`Sitzungsfenster: sichtbar=${w.isVisible()}\n`);
  }

  schliesse(): void {
    this.aktuell()?.close();
  }
}
