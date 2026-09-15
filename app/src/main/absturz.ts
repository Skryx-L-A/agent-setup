// Woher dieses Programm erfaehrt, dass eine Sitzung ABGESTUERZT ist -- und
// nicht bloss zu Ende gegangen.
//
// ENTSCHEIDUNG des Nutzers (05.09.2026, „Ja, nur bei Absturz"): Stirbt der
// Orchestrator einer Sitzung mit Fehlercode oder durch ein Signal, erscheint
// eine Zeile im Fenster; ein gewoehnliches `exit` (Status 0) bleibt still.
// Die Lebensspur (lebensspur.ts) kann das nicht leisten: sie sieht nur, DASS
// eine Sitzung verschwunden ist, nicht WIE.
//
// WOHER DER STATUS KOMMT, gemessen am 05.09.2026 auf eigenem Socket
// (tmux 3.7c, drei Faelle `exit 0`, `exit 3`, `kill -9`):
//
//   pane-exited        feuert ohne `remain-on-exit`, aber der Pane ist im Hook
//                      schon fort: `#{pane_dead_status}` ist leer, und die
//                      uebrigen Formate zeigen auf irgendeinen anderen Pane.
//                      Kein Status, in keinem der drei Faelle.
//   Steuerkanal (-CC)  kennt %exit, %window-close, %unlinked-window-close --
//                      keines davon traegt einen Exit-Status, und er haengt
//                      ohnehin nur an der Sitzung, die gerade angesehen wird.
//   pane-died          feuert nur mit `remain-on-exit on`, dann aber mit
//                      `#{pane_dead_status}` (3) bzw. `#{pane_dead_signal}`
//                      (`kill`, `term`, `segv` -- tmux nennt den NAMEN).
//
// Der dritte Weg ist der einzige mit Status, und er kostet hier nichts extra:
// `wb-code` setzt auf jedem Orchestrator-Pane laengst `remain-on-exit on`
// (wb-code:994), damit `wb-autorevive` ihn ueber denselben Hook
// wiederbeleben kann (~/.tmux.conf, `pane-died[0]`). Dieses Programm haengt
// sich als ZWEITER Eintrag an den Hook (`pane-died[91]`) und laesst den Pane
// in Ruhe: was mit ihm geschieht, entscheiden weiter wb-code, wb-autorevive
// und der Mensch. Deshalb aendert sich fuer wb-doctor und wb-waisen nichts --
// es bleibt kein Pane stehen, der nicht auch vorher stehen geblieben waere.
//
// WARUM EINE DATEI UND KEIN DIREKTER WEG: Der Hook laeuft im tmux-Server,
// nicht in diesem Prozess. `run-shell` haengt eine Zeile an eine Logdatei im
// Zustandsverzeichnis, der Takt liest die neuen Zeilen. Das ist dem
// Wettlauf mit wb-autorevive gewachsen: tmux setzt die Formate ein, BEVOR es
// den Hook-Befehl startet, also steht der Status fest, auch wenn der Pane
// eine Sekunde spaeter schon wieder lebt.
//
// WAS DER HOOK NICHT SIEHT, ausdruecklich: einen Pane ohne `remain-on-exit`
// (eine Sitzung, die nicht ueber wb-code entstand). Ein Ende, das die Werkbank
// mit `kill-session` selbst herbeifuehrt, feuert den Hook nicht (gemessen),
// also meldet ein absichtliches Schliessen auch keinen Absturz.
//
// FERNE MASCHINEN (05.09., Auftrag absturzfern; Entscheidung des Nutzers gilt
// fuer beide Maschinen): der oertliche Hook haengt am oertlichen Server, eine
// Sitzung auf peer stirbt auf dessen Server. Deshalb traegt das Fernskript
// (remote.ts) bei jedem Abruf einen ZWEITEN Hook in den fernen Server ein,
// `pane-died[92]`, der dieselbe Zeile in eine EIGENE Datei drueben schreibt
// (`absturz-fern.log`), und bringt die letzten Zeilen dieser Datei mit. Warum
// nicht `[91]` und `absturz.log` der fernen Werkbank: auf peer laeuft eine
// eigene Werkbank, die `[91]` fuer ihren oertlichen Hinweis belegt und ihre
// Datei bei jedem Start leert -- zwei Programme auf demselben Index wuerden
// sich minuetlich ueberschreiben, und ihre Datei kennt keinen Leser von
// aussen. Zwei Indizes, zwei Dateien, kein Wettlauf; jede Werkbank meldet in
// ihrem Fenster jeden Absturz genau einmal, den oertlichen ueber `[91]`, den
// fernen ueber `[92]`. Gemessen wurde dieser Weg gegen die beiden anderen:
// die ferne Werkbank melden zu lassen und ihre Meldung zu spiegeln, haengt an
// einem zweiten Programm, das laufen muss, und an einer Datei, die es beim
// Start leert; ein Dauerprozess drueben (tail -f ueber ssh) waere ein weiterer
// Prozess, den es zu beenden gaebe. Der Fernweg kostet nichts extra: der
// Poller laeuft ohnehin, ein `set-hook` und ein `tail` mehr je Abruf. Ist
// peer nicht erreichbar, faellt der Abruf aus wie bisher, und mit ihm dieser
// Teil -- die Zeilen bleiben drueben liegen, bis der naechste Abruf sie holt.
//
// KEIN ZUSTAND DRUEBEN, KEIN OFFSET: die ferne Datei wird nie geleert und nie
// mit einem Offset gelesen, weil mehrere Leser daran haengen koennten und
// jeder seine eigene Stelle haette. Stattdessen traegt jede Zeile die Totzeit
// des Panes (`#{pane_dead_time}`, Epochensekunden, gemessen 05.09.), und der
// Leser hier merkt sich, welche Zeilen er schon gesehen hat (FernAbsturzSpur).
// Was beim ERSTEN gelungenen Abruf schon dasteht, gilt als gesehen -- dieselbe
// Regel wie das Leeren der oertlichen Datei beim Start.
import { mkdirSync, openSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Der Hook-Eintrag, den dieses Programm belegt. Index 0 gehoert ~/.tmux.conf (wb-autorevive). */
export const ABSTURZ_HOOK = 'pane-died[91]';
/** Der Eintrag, den dieses Programm in den Server einer FERNEN Maschine traegt (Kopf: „FERNE MASCHINEN"). */
export const ABSTURZ_FERN_HOOK = 'pane-died[92]';
/** Dateiname der fernen Logdatei im Zustandsverzeichnis drueben; getrennt von dessen eigener `absturz.log`. */
export const ABSTURZ_FERN_LOG_NAME = 'absturz-fern.log';

/** Eine Zeile der Logdatei, zerlegt. */
export interface PaneEnde {
  /** `#{session_name}` -- der tmux-Name, nicht der Anzeigename. */
  session: string;
  paneId: string;
  /** `@wb_role` des Panes; leer, wenn nie gesetzt. */
  role: string;
  /** Exit-Status, oder null bei einem Signal. */
  status: number | null;
  /** Signalname, wie tmux ihn nennt (`kill`, `term`), sonst leer. */
  signal: string;
  /** `#{pane_dead_time}` (Epochensekunden) -- nur die ferne Zeile traegt es; oertlich leer. */
  zeit: string;
}

/**
 * Der Befehl, den tmux beim Tod eines Panes ausfuehrt. Reine Funktion, damit
 * ein Test ihn ansehen kann, ohne einen Server zu brauchen.
 *
 * Tabulator als Trenner, weil ein Sitzungsname Leerzeichen tragen darf; die
 * Felder sind einzeln in Anfuehrungszeichen, damit die Shell sie nicht
 * zerlegt. Ein Apostroph im Pfad wird fuer die Shell verpackt.
 */
export function absturzHookBefehl(logDatei: string): string {
  const pfad = logDatei.replace(/'/g, `'\\''`);
  const felder = ['#{session_name}', '#{pane_id}', '#{@wb_role}', '#{pane_dead_status}', '#{pane_dead_signal}'];
  return `run-shell -b "printf '%s\t%s\t%s\t%s\t%s\\n' ${felder.map((f) => `'${f}'`).join(' ')} >> '${pfad}'"`;
}

/**
 * Die Zeile des Fernskripts, die den Hook in den FERNEN Server traegt (bash,
 * ueber ssh). Drei Ebenen Quoting, von aussen nach innen: bash-Doppelquotes
 * (die ferne bash loest darin `$HOME` zur Setzzeit auf und laesst `\n`
 * stehen), tmux-Doppelquotes (`\"`), und die einfachen Quotes der sh, die
 * `run-shell` beim Feuern startet. Gemessen 05.09. auf eigenem Socket: die
 * Zeile kommt mit Tabulatoren, Status, Signalname und Totzeit an.
 *
 * `#{pane_dead_time}` als sechstes Feld, damit zwei gleiche Enden (derselbe
 * Pane nach einem Serverneustart) unterscheidbar bleiben; der Leser hier
 * (FernAbsturzSpur) dedupliziert ueber die ganze Zeile. Der Pfad ist relativ
 * zu `$HOME` und wird wie die uebrigen Pfade des Fernskripts ungequotet
 * eingesetzt -- er kommt aus der Konfiguration, nicht von aussen.
 */
export function absturzFernHookZeile(relLog: string): string {
  const felder = ['#{session_name}', '#{pane_id}', '#{@wb_role}', '#{pane_dead_status}', '#{pane_dead_signal}', '#{pane_dead_time}'];
  const sh = `printf '%s\t%s\t%s\t%s\t%s\t%s\\n' ${felder.map((f) => `'${f}'`).join(' ')} >> '$HOME/${relLog}'`;
  return `tmux set-hook -g '${ABSTURZ_FERN_HOOK}' "run-shell -b \\"${sh}\\"" 2>/dev/null || true`;
}

/** Eine Logzeile zerlegen; null fuer alles, was keine ist. */
export function paneEndeLesen(zeile: string): PaneEnde | null {
  const t = zeile.split('\t');
  if (t.length < 5 || !t[0]) return null;
  const status = /^\d+$/.test(t[3]) ? Number(t[3]) : null;
  return { session: t[0], paneId: t[1], role: t[2], status, signal: t[4].trim(), zeit: (t[5] ?? '').trim() };
}

/**
 * Signalname -> Shell-Status (128 + Nummer), damit die Zeile dasselbe sagt
 * wie ein Terminal nach `kill -9`: „Status 137". Nur die Nummern, die auf
 * jedem POSIX-System gleich sind; was tmux sonst nennt, bleibt beim Namen.
 *
 * AUF LINUX KOMMT DIE NUMMER, NICHT DER NAME (gemessen 05.09. auf peer, tmux
 * 3.7c, `kill -9` gegen einen Pane mit `remain-on-exit`): `#{pane_dead_signal}`
 * ist dort `9`, auf dem Mac `kill` -- tmux nimmt den Namen aus der libc, und
 * glibc hat ihn nicht. Bis zu dieser Messung hiess der Satz auf peer
 * „Signal 9" statt „Status 137", oertlich wie fern; `absturzText` nimmt jetzt
 * beides.
 */
const SIGNAL_NUMMER: Record<string, number> = {
  hup: 1, int: 2, quit: 3, ill: 4, trap: 5, abrt: 6, fpe: 8, kill: 9, segv: 11, pipe: 13, alrm: 14, term: 15,
};

/**
 * Der Satz fuer das Fenster -- oder null, wenn es nichts zu sagen gibt: ein
 * Ende mit Status 0, oder ein Pane, der kein Orchestrator ist (Worker haben
 * ihren eigenen Weg: Kachel, wb-autorevive, Ergebnisdatei).
 */
export function absturzText(anzeigename: string, e: PaneEnde, maschine = ''): string | null {
  if (e.role === 'worker' || e.role === 'agent' || e.role === 'placeholder') return null;
  // Eine ferne Sitzung nennt ihre Maschine: „Sitzung X auf peer abgestürzt (Status 137)".
  const wer = maschine ? `Sitzung ${anzeigename} auf ${maschine}` : `Sitzung ${anzeigename}`;
  if (e.signal) {
    const nr = /^\d+$/.test(e.signal) ? Number(e.signal) : SIGNAL_NUMMER[e.signal.toLowerCase()];
    return `${wer} abgestürzt (${nr ? `Status ${128 + nr}` : `Signal ${e.signal.toUpperCase()}`})`;
  }
  if (e.status === null || e.status === 0) return null;
  return `${wer} abgestürzt (Status ${e.status})`;
}

/**
 * Das Gedaechtnis: liest die Logdatei zeilenweise weiter, ab da, wo der
 * letzte Takt aufgehoert hat. Beim Start wird sie GELEERT -- was vor diesem
 * Lauf geschah, hat niemand angesehen, und dafuer gibt es die Lebensspur.
 */
export class AbsturzSpur {
  private offset = 0;
  private rest = '';

  constructor(readonly datei: string) {
    try {
      mkdirSync(dirname(datei), { recursive: true });
      writeFileSync(datei, '');
    } catch {
      // Ein nicht schreibbares Zustandsverzeichnis darf den Start nicht anhalten.
    }
  }

  /** Alle seit dem letzten Aufruf vollstaendig geschriebenen Zeilen. */
  neue(): PaneEnde[] {
    let groesse: number;
    try {
      groesse = statSync(this.datei).size;
    } catch {
      return [];
    }
    // Jemand hat die Datei gekuerzt: von vorn lesen statt ins Leere.
    if (groesse < this.offset) { this.offset = 0; this.rest = ''; }
    if (groesse === this.offset) return [];
    let fd = -1;
    try {
      fd = openSync(this.datei, 'r');
      const puffer = Buffer.alloc(groesse - this.offset);
      const gelesen = readSync(fd, puffer, 0, puffer.length, this.offset);
      this.offset += gelesen;
      const text = this.rest + puffer.subarray(0, gelesen).toString('utf8');
      const zeilen = text.split('\n');
      // Die letzte Zeile ist nur dann fertig, wenn ein Zeilenende dahinter steht.
      this.rest = zeilen.pop() ?? '';
      return zeilen.map(paneEndeLesen).filter((e): e is PaneEnde => e !== null);
    } catch {
      return [];
    } finally {
      if (fd >= 0) closeSync(fd);
    }
  }
}

/**
 * Das Gedaechtnis fuer FERNE Maschinen: je Maschine die Menge der schon
 * gesehenen Zeilen. Der erste Aufruf fuer eine Maschine liefert NICHTS und
 * merkt sich alles, was dasteht -- was vor diesem Lauf geschah, hat niemand
 * angesehen (dieselbe Regel wie das Leeren der oertlichen Datei). Danach
 * kommt jede Zeile genau einmal, auch wenn der Poller denselben Stand
 * mehrere Takte lang vorhaelt oder die Datei drueben nie geleert wird.
 *
 * Der Aufrufer reicht nur den Stand eines GELUNGENEN Abrufs herein: ein
 * ausgefallener Abruf traegt die alten Zeilen weiter (remote.ts,
 * `leererStand`), und ein leerer erster Stand nach einem Ausfall wuerde alle
 * alten Zeilen beim Wiederkommen als neu ausgeben.
 */
export class FernAbsturzSpur {
  private readonly gesehen = new Map<string, Set<string>>();

  /** Die Zeilen von `raw`, die fuer `maschine` neu sind -- beim ersten Mal keine. */
  neue(maschine: string, raw: string): PaneEnde[] {
    const zeilen = raw.split('\n').filter((z) => z.trim() !== '');
    const bekannt = this.gesehen.get(maschine);
    if (!bekannt) {
      this.gesehen.set(maschine, new Set(zeilen));
      return [];
    }
    const out: PaneEnde[] = [];
    for (const z of zeilen) {
      if (bekannt.has(z)) continue;
      bekannt.add(z);
      const e = paneEndeLesen(z);
      if (e) out.push(e);
    }
    return out;
  }
}
