// Die Verbrauchsseite hinter der Token-Anzeige unten links: ein EIGENES Fenster, Zwilling des
// Einstellungs- und des Sitzungsfensters (einstellungsfenster.ts, sitzungsfenster.ts).
//
// WARUM EIN FENSTER UND KEIN KASTEN. Die Fusszeile zeigt heute eine einzige Zahl ("<n> heute")
// und beim Klick einen Satz darueber. Was hier gefragt ist -- Verbrauch gesamt und getrennt nach
// Ein- und Ausgabe, Filter nach Harness und Modell, Raten je Modell, Grafiken, der Weg zum
// Limit, zwei Zeitraeume nebeneinander -- passt in keine Sprechblase ueber der Buehne und
// verdeckte dort genau das Terminal, wegen dem man hinsieht.
//
// ES WIRD HIER NICHT GERECHNET. Die eine Wahrheit ueber den Verbrauch bleibt `wb-budget`; diese
// Datei ruft `wb-budget --json` auf und reicht dessen Ergebnis durch. Zahlen, die das Fenster
// zeigt, aber wb-budget nicht kennt, gaebe es damit gar nicht erst -- und das ist Absicht.
import { BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { parseVerbrauch, type VerbrauchsAntwort } from '../verbrauch/rechnen';

/** Was das Fenster erfragen darf. Alles davon reicht `wb-budget --json` unveraendert weiter. */
export interface VerbrauchsFrage {
  von?: string;
  bis?: string;
  tage?: number;
  harness?: string[];
  modell?: string[];
  sitzung?: string[];
}

/**
 * Aus einer Frage die Argumentliste. Eigene Funktion, weil genau hier eine Zeichenkette aus dem
 * Fenster in einen Programmaufruf uebergeht: gebaut wird eine ARGUMENTLISTE, nie eine
 * Befehlszeile -- `spawn` ohne Shell bekommt jedes Stueck einzeln, und damit ist ein Modellname
 * mit Semikolon darin ein Modellname und kein zweiter Befehl.
 */
export function verbrauchsArgumente(frage: VerbrauchsFrage): string[] {
  const args = ['--json'];
  if (frage.von && frage.bis) {
    args.push('--von', frage.von, '--bis', frage.bis);
  } else {
    args.push('--tage', String(Math.max(1, Math.floor(frage.tage ?? 7))));
  }
  if (frage.harness?.length) args.push('--harness', frage.harness.join(','));
  if (frage.modell?.length) args.push('--modell', frage.modell.join(','));
  if (frage.sitzung?.length) args.push('--sitzung', frage.sitzung.join(','));
  return args;
}

export interface VerbrauchLeserOptionen {
  /** Testhaken: ein anderes Programm statt `wb-budget` anspringen. */
  bin?: string;
  timeoutMs?: number;
}

/**
 * `wb-budget --json` aufrufen und sein Ergebnis lesen.
 *
 * ASYNCHRON UND MIT UHR, aus demselben Grund wie beim BudgetPoller (budget.ts): der Aufruf
 * scannt Transkripte, Datenbanken und Zustandsdateien. Gemessen am 11.08. braucht ein
 * 7-Tage-Lauf rund 1,5 Sekunden -- schnell genug fuer einen Klick, viel zu langsam fuer irgendein
 * Warten im Hauptprozess. Laeuft er aus dem Ruder, wird er hart beendet und der Grund
 * durchgereicht; ein Fenster, das ewig „wird gelesen" zeigt, ist der schlechteste aller Zustaende.
 */
export function verbrauchLesen(frage: VerbrauchsFrage, opt: VerbrauchLeserOptionen = {}): Promise<VerbrauchsAntwort> {
  return new Promise((fertig) => {
    let raus = '';
    let fehlerText = '';
    let erledigt = false;
    const kind = spawn(opt.bin ?? 'wb-budget', verbrauchsArgumente(frage), { stdio: ['ignore', 'pipe', 'pipe'] });
    const uhr = setTimeout(() => {
      fehlerText = `wb-budget antwortete nicht innerhalb von ${opt.timeoutMs ?? 60000} ms`;
      kind.kill('SIGKILL');
    }, opt.timeoutMs ?? 60000);
    const beenden = (grund: string) => {
      if (erledigt) return;
      erledigt = true;
      clearTimeout(uhr);
      if (grund) {
        fertig({ ok: false, fehler: grund, daten: null });
        return;
      }
      const d = parseVerbrauch(raus);
      if (!d) {
        // Nicht mit einer leeren Seite antworten: „nichts verbraucht" und „nicht gelesen" sind
        // zwei sehr verschiedene Auskuenfte, und nur eine davon stimmt hier.
        fertig({ ok: false, fehler: `Ausgabe von wb-budget nicht im erwarteten Format: ${raus.slice(0, 200)}`, daten: null });
        return;
      }
      fertig({ ok: true, fehler: '', daten: d });
    };
    kind.stdout?.on('data', (d: Buffer) => {
      raus += d.toString('utf8');
    });
    kind.stderr?.on('data', (d: Buffer) => {
      fehlerText += d.toString('utf8');
    });
    kind.on('error', (e) => beenden(e.message));
    kind.on('close', (code) => beenden(code === 0 ? '' : `wb-budget beendet mit Code ${code}: ${fehlerText.trim().slice(0, 300)}`));
  });
}

// --- Das Fenster -----------------------------------------------------------

/**
 * DIE AUFLAGE AUS DIESEM HAUS, hier genauso eingehalten wie bei den beiden anderen Fenstern
 * (Einstellungsfenster, Klassendoc: dort steht sie ausfuehrlich):
 *
 *   1. Das Fenster entsteht IMMER mit `show: false` (`baue()`). Steuerkanal und Testsuite
 *      bekommen genau diesen Weg: bauen, lesen, fotografieren.
 *   2. `zeigeNachEchtemKlick()` ist die EINZIGE Stelle mit `show()`, und sie haengt an einer
 *      Bedienung, die der Renderer nur bei `isTrusted === true` schickt (fuss-status.ts, der
 *      Zuhoerer an der Token-Zeile). Ein `el.click()` aus `executeJavaScript` traegt
 *      `isTrusted === false` und landet in 1.
 *   3. Der Steuerkanal hat KEINEN Befehl, der `zeige()` erreicht.
 *
 * Und dieselbe SPUR auf stderr mit dem Praefix `Verbrauchsfenster:`, aus demselben Grund: den
 * show()-Zweig kann kein Test erreichen, ohne ein Fenster auf Bildschirm des Nutzers zu bringen.
 */
export class Verbrauchsfenster {
  private fenster: BrowserWindow | null = null;
  private bereit: Promise<void> | null = null;

  constructor(private readonly eltern: () => BrowserWindow | null) {}

  /** Das Fenster, wenn es existiert -- fuer Foto und Auskunft. */
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
      // Breiter als die beiden anderen Fenster: hier stehen Diagramme neben Tabellen, und ein
      // Tagesverlauf, der auf 700 Punkte gestaucht ist, zeigt keinen Verlauf mehr.
      width: 1180,
      height: 820,
      minWidth: 900,
      minHeight: 600,
      useContentSize: true,
      // Immer. Sichtbar wird es nur ueber zeigeNachEchtemKlick(), siehe Klassendoc.
      show: false,
      parent: eltern ?? undefined,
      modal: false,
      title: 'Agent-Workbench — Verbrauch',
      backgroundColor: '#101216',
      paintWhenInitiallyHidden: true,
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'verbrauch-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        sandbox: false,
      },
    });
    w.setContentSize(1180, 820);
    w.on('closed', () => {
      this.fenster = null;
      this.bereit = null;
    });
    this.fenster = w;
    this.bereit = w.loadFile(join(__dirname, '..', 'verbrauch', 'index.html'));
    await this.bereit;
    process.stderr.write('Verbrauchsfenster: gebaut, noch nicht gezeigt\n');
    return w;
  }

  /**
   * DER EINZIGE show()-AUFRUF fuer dieses Fenster. Erreichbar ausschliesslich ueber die
   * Bedienung, die der Renderer nur bei `isTrusted === true` schickt.
   */
  async zeigeNachEchtemKlick(): Promise<void> {
    process.stderr.write('Verbrauchsfenster: echter Klick, show()\n');
    const w = await this.baue();
    if (w.isVisible()) w.focus();
    else w.show();
    // NACH dem Aufruf gelesen, nicht vorher angenommen.
    process.stderr.write(`Verbrauchsfenster: sichtbar=${w.isVisible()}\n`);
  }

  schliesse(): void {
    this.aktuell()?.close();
  }
}
