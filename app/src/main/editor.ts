// Hauptprozess-Seite des Editors (Schritt 6 im Plan, A3): Dateien eines
// Projektordners auflisten, lesen, schreiben -- und der eine Befehl, der den
// Editor ueberhaupt erst rechtfertigt: eine Auswahl in den Orchestrator-Pane
// legen.
//
// Absichtlich schmal: kein Sprachserver, keine Fehlerdiagnose, kein Debugger,
// keine Git-Oberflaeche -- das steht bei A3/4c und gilt auch hier. Gelesen und
// geschrieben wird ausschliesslich innerhalb des Ordners der gewaehlten
// Session (4c: "gezeigt wird der Ordner der gewaehlten Session"), nie
// darueber hinaus -- das haelt den Editor auf denselben Umfang wie der
// Schnelloeffner und macht einen Pfadausbruch unmoeglich.
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, realpathSync, watch, type FSWatcher } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { assertPaneId } from './tmux';
import { ausschlussFilter } from './einstellungen';

// Die Ausschlussliste stand bis zum 05.08. hier als zwei Konstanten, weil es die
// Einstellungen in dieser Anwendung noch nicht gab. Jetzt gibt es sie, und Plan
// 4c.2/A9 verlangt genau diesen Ort: "Die Ausschlussliste gehoert in die
// Einstellungen, damit sie sichtbar und pruefbar ist -- und nicht in den Code,
// wo sie niemand findet." Gefragt wird ueber `einstellungen.ts`, dieselbe
// Stelle, die auch Dateibaum, Schnelloeffner und Inhaltssuche fragen (F5: die
// Sperre sitzt eine Ebene tiefer als der Baum, sonst geht eine Ansicht daran
// vorbei).

/** Grobe Grenze gegen ein Riesenverzeichnis oder eine Endlosschleife per Symlink. */
const MAX_FILES = 20000;
const MAX_DEPTH = 24;
/** Dateien ueber dieser Groesse zeigt der Editor nicht -- kein Sprachserver, kein Streaming. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface FileEntry {
  /** Pfad relativ zum Projektordner, mit '/' getrennt -- so wie ihn der Schnelloeffner braucht. */
  rel: string;
}

/**
 * Darf diese Ansicht den Pfad ueberhaupt anfassen? Die Antwort kommt aus den
 * Einstellungen, nicht von hier -- und sie gilt fuer JEDEN Namensteil, also auch
 * fuer einen Ordner mitten im Pfad.
 */
function ausgeschlossen(relPath: string): boolean {
  return ausschlussFilter()(relPath);
}

/**
 * Alle Dateien unter `root`, als Pfade relativ zu `root`. Fuer den
 * Schnelloeffner (4c: "eine Datei ueber ihren Namen findet, ohne dass der
 * Baum aufgeklappt werden muss") -- die Suche selbst macht der Aufrufer
 * (Fuzzy-Treffer auf `rel`), hier wird nur einmal eingesammelt.
 */
export function listFiles(root: string): FileEntry[] {
  const out: FileEntry[] = [];
  if (!root || !existsSync(root)) return out;
  const start = statSync(root);
  if (!start.isDirectory()) return out;

  // EINMAL geholt, nicht je Datei: der Baum laeuft ueber Zehntausende Namen,
  // und die Einstellungen aendern sich waehrend eines Durchlaufs nicht.
  const filter = ausschlussFilter();

  const gehe = (dir: string, tiefe: number): void => {
    if (out.length >= MAX_FILES || tiefe > MAX_DEPTH) return;
    let kinder: string[];
    try {
      kinder = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of kinder) {
      if (out.length >= MAX_FILES) return;
      if (filter(name)) continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      const rel = relative(root, abs).split(sep).join('/');
      if (filter(rel)) continue;
      if (st.isDirectory()) {
        gehe(abs, tiefe + 1);
      } else if (st.isFile()) {
        out.push({ rel });
      }
    }
  };
  gehe(root, 0);
  return out;
}

/**
 * Loest einen (relativen oder absoluten) Pfad gegen `root` auf und
 * verweigert JEDEN Ausbruch aus dem Projektordner -- ".." ebenso wie ein
 * absoluter Pfad ausserhalb, ebenso wie ein Symlink, der aus dem Ordner
 * hinausfuehrt (realpath wird ebenfalls gegen die Wurzel geprueft).
 */
function innerhalb(p: string, basis: string): boolean {
  return p === basis || p.startsWith(basis + sep);
}

function aufloesen(root: string, pfad: string): string {
  const rootAbs = resolve(root);
  const zielRoh = resolve(rootAbs, pfad);
  if (!innerhalb(zielRoh, rootAbs)) throw new Error(`Pfad liegt ausserhalb des Projektordners: ${pfad}`);
  if (existsSync(zielRoh)) {
    // Beide Seiten auf DIESELBE Kanonisierungsstufe bringen, sonst schlaegt
    // die Pruefung auf jeder Maschine fehl, deren Projektordner selbst hinter
    // einem Symlink liegt -- etwa macOS, wo /var nach /private/var zeigt und
    // ein via mktemp erzeugter Ordner also IMMER einen "Symlink-Ausbruch"
    // vorgetaeuscht haette, obwohl Ziel und Wurzel dasselbe Verzeichnis sind.
    const rootReal = existsSync(rootAbs) ? realpathSync(rootAbs) : rootAbs;
    const real = realpathSync(zielRoh);
    if (!innerhalb(real, rootReal)) throw new Error(`Pfad fuehrt ueber einen Symlink aus dem Projektordner hinaus: ${pfad}`);
  }
  const rel = relative(rootAbs, zielRoh).split(sep).join('/');
  if (ausgeschlossen(rel)) throw new Error(`Datei ist von der Anzeige ausgeschlossen: ${pfad}`);
  return zielRoh;
}

export function readFileSafe(root: string, pfad: string): { abs: string; content: string } {
  const abs = aufloesen(root, pfad);
  const st = statSync(abs);
  if (!st.isFile()) throw new Error(`keine Datei: ${pfad}`);
  if (st.size > MAX_FILE_BYTES) {
    throw new Error(`Datei zu gross fuer den Editor (${Math.round(st.size / 1024)} KB, Grenze ${Math.round(MAX_FILE_BYTES / 1024)} KB): ${pfad}`);
  }
  const buf = readFileSync(abs);
  // Ein Nullbyte in den ersten Kilobytes gilt als Binaerdatei -- der Editor
  // liest Text, kein Bild, kein Binaerformat.
  const probe = buf.subarray(0, Math.min(buf.length, 8192));
  if (probe.includes(0)) throw new Error(`keine Textdatei (Binaerinhalt erkannt): ${pfad}`);
  return { abs, content: buf.toString('utf8') };
}

export function writeFileSafe(root: string, pfad: string, content: string): { abs: string; bytes: number } {
  const abs = aufloesen(root, pfad);
  writeFileSync(abs, content, 'utf8');
  // Der eigene Schreibvorgang darf nicht als fremde Aenderung zurueckkommen
  // (siehe startEditorWaechter): gemerkt wird der Fingerabdruck des Inhalts,
  // nicht eine Uhrzeit -- eine Frist wuerde einen ECHTEN fremden Schreibvorgang
  // im selben Augenblick verschlucken.
  eigeneSchrift.set(abs, fingerabdruck(content));
  return { abs, bytes: Buffer.byteLength(content, 'utf8') };
}

/** Was diese Anwendung zuletzt in eine Datei geschrieben hat (Fingerabdruck). */
const eigeneSchrift = new Map<string, string>();

function fingerabdruck(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Eine Auswahl in den Orchestrator-Pane legen -- der eine Befehl, der den
 * Editor ueberhaupt noetig macht (4c). Der Text landet im EINGABEFELD, ohne
 * Enter: wer sendet, entscheidet der Mensch.
 *
 * Der Weg ist der in diesem Haus bereits erprobte (siehe shell/pi-worker):
 * `load-buffer` ueber die Standardeingabe eines eigenstaendigen tmux-Aufrufs
 * (kein Zeichen des Textes durchlaeuft je die zeilenbasierte
 * tmux-Befehlssyntax -- Anfuehrungszeichen, Semikolons und Backslashes im
 * Quelltext einer Datei koennten sie sonst als weiteren Befehl lesen), dann
 * `paste-buffer -p` (das -p setzt den Klammer-Einfuege-Modus, damit die
 * Ziel-Anwendung den Text als EIN Einfuegen liest und nicht Zeile fuer Zeile
 * wie eigene Tastendruecke -- sonst wuerde jeder Zeilenumbruch als Enter
 * gelesen und die Auswahl haeppchenweise abgeschickt).
 *
 * `paneId` wird ueber `assertPaneId` aus tmux.ts geprueft (dieselbe Regel wie
 * ueberall sonst in diesem Haus) -- diese Datei aendert tmux.ts nicht, sie
 * benutzt nur seine exportierte Pruefung.
 */
export function sendSelectionToOrchestrator(tmuxSocket: string, paneId: string, text: string): Promise<void> {
  assertPaneId(paneId);
  const bufName = `awb-editor-${process.pid}-${Date.now()}`;
  const baseArgs = tmuxSocket ? ['-L', tmuxSocket] : [];
  return new Promise((resolvePromise, reject) => {
    // FRIST (2026-09-03, Audit "tmux-Aufrufe ohne Frist"): dieser Aufruf hatte
    // GAR KEIN Timeout -- ein haengendes tmux liess die Zusage dieser Funktion
    // nie mehr auflösen. `spawn()` traegt seit Node 15.14 dieselben Optionen
    // wie `spawnSync` (dieses Haus nutzt ein deutlich neueres ueber Electron
    // 40); 2s wie jeder andere oertliche bare-tmux-Aufruf, SIGKILL aus
    // demselben Grund wie in sessions.ts/befehle.ts (SIGTERM ist abfangbar).
    const load = spawn('tmux', [...baseArgs, 'load-buffer', '-b', bufName, '-'], {
      stdio: ['pipe', 'ignore', 'pipe'], timeout: 2000, killSignal: 'SIGKILL',
    });
    let stderr = '';
    load.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    load.on('error', reject);
    load.on('exit', (code, signal) => {
      if (code !== 0 || signal) {
        reject(new Error(`tmux load-buffer schlug fehl: ${
          signal ? `nach 2000ms abgebrochen (${signal})` : (stderr.trim() || `Exitcode ${code}`)}`));
        return;
      }
      // FRIST (2026-08-20, dieselbe Fehlerklasse wie beim Beenden): oertlich,
      // 2s wie die anderen bare-tmux-Aufrufe dieses Hauses.
      // killSignal:SIGKILL (2026-09-03, ergaenzt im selben Audit): SIGTERM
      // (die Node-Vorgabe) ist abfangbar, siehe sessions.ts/befehle.ts.
      const paste = spawnSync('tmux', [...baseArgs, 'paste-buffer', '-p', '-b', bufName, '-d', '-t', paneId], {
        encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL',
      });
      if (paste.status !== 0) {
        reject(new Error(`tmux paste-buffer schlug fehl: ${paste.signal ? 'nach 2000ms abgebrochen' : (paste.stderr || '').trim()}`));
        return;
      }
      resolvePromise();
    });
    load.stdin.write(text);
    load.stdin.end();
  });
}

/**
 * DER WAECHTER UEBER DIE OFFENEN DATEIEN (06.09.2026, Auftrag 3.4).
 *
 * Bis heute merkte keine Oberflaeche, wenn eine offene Datei von aussen
 * geschrieben wurde -- ein Worker legt in derselben Datei los, im Editor steht
 * weiter der Stand von vorhin, und ein Speichern haette seine Arbeit
 * ueberschrieben. Beobachtet werden deshalb genau die Dateien, die gerade
 * offen sind: nichts auf Vorrat, kein Baum, keine Uhr.
 *
 * Wie `dateiwaechter.ts` meldet er nur, WELCHE Datei sich geaendert hat; ob
 * daraus ein Hinweis wird oder still neu geladen wird, entscheidet die
 * Oberflaeche -- sie allein weiss, ob der Mensch gerade in dieser Datei tippt.
 *
 * `setzen` ist die ganze Bedienung: die Liste der offenen Dateien, jedes Mal
 * vollstaendig. Was nicht mehr darin steht, wird abgeraeumt; was schon
 * beobachtet wird, bleibt stehen (ein Neuaufbau bei jedem Tabwechsel waere ein
 * Ereignissturm). Ein `watch()`, das fehlschlaegt (Datei weg, Kontingent
 * erschoepft), wird still uebergangen -- die Auffrischung faellt dann fuer
 * diese Datei aus, das Programm laeuft weiter.
 */
export interface EditorWaechterHandle {
  /** Die Pfade, die gerade wirklich beobachtet werden (absolut). */
  readonly beobachtet: readonly string[];
  /** Die offenen Dateien setzen -- relativ zu `root` oder absolut. */
  setzen(root: string, pfade: readonly string[]): void;
  close(): void;
}

export function startEditorWaechter(
  auf: (abs: string) => void,
  debounceMs = 300,
): EditorWaechterHandle {
  const watcher = new Map<string, FSWatcher>();
  const timer = new Map<string, NodeJS.Timeout>();
  let zu = false;

  const melden = (abs: string): void => {
    const bestehend = timer.get(abs);
    if (bestehend) clearTimeout(bestehend);
    timer.set(abs, setTimeout(() => {
      timer.delete(abs);
      if (zu) return;
      // Der eigene Schreibvorgang meldet sich selbst zurueck -- er ist keine
      // fremde Aenderung. Verglichen wird der INHALT, nicht die Uhrzeit.
      const eigen = eigeneSchrift.get(abs);
      if (eigen !== undefined) {
        try {
          if (fingerabdruck(readFileSync(abs, 'utf8')) === eigen) {
            eigeneSchrift.delete(abs);
            return;
          }
        } catch {
          // Nicht lesbar: dann gilt es als fremde Aenderung, wie jede andere.
        }
      }
      auf(abs);
    }, debounceMs));
  };

  return {
    get beobachtet(): readonly string[] {
      return [...watcher.keys()];
    },
    setzen(root: string, pfade: readonly string[]): void {
      if (zu) return;
      const gewuenscht = new Set<string>();
      for (const p of pfade) {
        if (!p) continue;
        // Derselbe Weg wie beim Lesen und Schreiben: nichts ausserhalb des
        // Projektordners, nichts von der Ausschlussliste.
        try {
          gewuenscht.add(aufloesen(root, p));
        } catch {
          // Ein Pfad, den der Editor nicht oeffnen duerfte, wird auch nicht beobachtet.
        }
      }
      for (const [abs, w] of watcher) {
        if (gewuenscht.has(abs)) continue;
        w.close();
        watcher.delete(abs);
        const t = timer.get(abs);
        if (t) { clearTimeout(t); timer.delete(abs); }
      }
      for (const abs of gewuenscht) {
        if (watcher.has(abs)) continue;
        try {
          watcher.set(abs, watch(abs, () => melden(abs)));
        } catch {
          // Kein Beobachter fuer diese Datei -- kein Grund, die uebrigen zu verlieren.
        }
      }
    },
    close(): void {
      zu = true;
      for (const [, w] of watcher) w.close();
      watcher.clear();
      for (const [, t] of timer) clearTimeout(t);
      timer.clear();
    },
  };
}
