// EIN PSEUDO-TERMINAL JE WORKER, OHNE TMUX (Probe fuer Option E, 04.09.2026).
//
// Die Werkbank haelt den Worker-Prozess hier selbst: `node-pty` startet ihn auf
// einem eigenen Pseudo-Terminal, `@xterm/headless` spiegelt seinen Bytestrom in
// ein Terminalmodell, und aus diesem Modell faellt derselbe Text, den heute
// `capture-pane -p` liefert. Das ist die eine Frage, an der die Probe haengt:
// die Kontextwache liest den Bildschirm, nicht den Prozess -- bekommt sie
// denselben Bildschirm, ist ihr der Weg darunter gleichgueltig.
//
// DREI MESSUNGEN BESTIMMEN DIESE DATEI:
//
//   M1  `capture-pane -p` ist NICHT "alle Zeilen mit Zeilenumbruch". Gemessen am
//       04.09. auf einem eigenen Socket (10 Zeilen hoher Pane, drei Zeilen
//       Inhalt): tmux gibt alle `rows` Zeilen rechts beschnitten aus, verbindet
//       sie mit "\n" und haengt KEINEN Umbruch an die letzte. Wer stattdessen
//       die leeren Zeilen am Ende wegwirft, verschiebt die Statuszeile -- und
//       die Wache sucht sie in den letzten fuenf Zeilen (`read_load`, tail -5).
//       `schirm()` bildet deshalb genau diese Form nach.
//
//   M2  node-pty 1.1.0 verliert auf macOS je Spawn einen /dev/ptmx-Deskriptor;
//       darum steht 1.2.0-beta.14 in package.json, dieselbe Fassung, auf die
//       Superset festgenagelt hat (DIREKTWEG-BEFUND, Abschnitt 6). Die
//       beta-Reihe liefert ihre Binaerteile ueber node-api, und damit laeuft sie
//       in Electron 40 OHNE Neuuebersetzung -- gemessen am 04.09. mit einem
//       nackten Electron-Start aus app/: der Kindprozess schrieb, der kopflose
//       Emulator gab "eins/zwei/rot" zurueck.
//
//   M3  Der Emulator ist billig genug, um ihn IMMER mitlaufen zu lassen, auch
//       fuer einen Pane, den niemand ansieht: er bekommt nur die Bytes, die der
//       Prozess ohnehin schreibt. Das ist der Unterschied zur heutigen Lage, in
//       der tmux den Bildschirm haelt und die Wache ihn je Poll abholt.
//
// WAS DIESE DATEI NICHT TUT: sie kennt keine Fenster, keine Aufteilung und
// keinen Tab. Ein pty-Worker ist eine Flaeche mit Spalten und Zeilen, sonst
// nichts -- genau das ist der Gewinn, den Option E verspricht.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Terminal } from '@xterm/headless';
import type * as NodePty from 'node-pty';

/**
 * Wie dieser Worker nach einem Neustart der Anwendung zurueckkommt.
 *
 * `args` sind die Fortsetzungs-Argumente des Harness aus der Registry, mit
 * `{resumeId}` als Platzhalter; `sitzungsOrt` sagt, wo die Sitzungsdatei liegt,
 * aus deren Namen die Kennung faellt. Laesst sich keine Kennung finden, greift
 * `fallbackArgs` (bei Claude `--continue`) -- und gibt es auch die nicht, wird
 * der Worker frisch gestartet und das ehrlich vermerkt.
 */
export interface PtyWiederaufnahme {
  args: string[];
  fallbackArgs?: string[];
  /** Ordner, in dem die Sitzungsdateien des Harness liegen. */
  sitzungsOrdner?: string;
  /** Dateiendung der Sitzungsdatei, z. B. '.jsonl'. */
  sitzungsEndung?: string;
}

export interface PtyAuftrag {
  name: string;
  befehl: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  cols: number;
  rows: number;
  /** Harness-Kennung aus der Registry -- die Wache liest sie wie `@wb_cmd`. */
  harness?: string;
  /** 'worker' oder 'orchestrator'; wb-pane-write entscheidet daran. */
  rolle?: string;
  wiederaufnahme?: PtyWiederaufnahme;
}

export interface PtyStand {
  id: string;
  name: string;
  cols: number;
  rows: number;
  lebt: boolean;
  cwd: string;
  harness: string;
  rolle: string;
  /** Die ganze Startzeile -- die Wache liest sie an der Stelle von `@wb_cmd`. */
  startbefehl: string;
  /** 'frisch' oder 'fortgesetzt', und bei fortgesetzt womit. */
  herkunft: string;
  pid: number;
}

interface PtyEintrag {
  id: string;
  auftrag: PtyAuftrag;
  /** Die wirklich gestartete Zeile, inklusive Fortsetzungs-Argumenten. */
  argv: string[];
  term: Terminal;
  pty: NodePty.IPty | null;
  lebt: boolean;
  herkunft: string;
  pid: number;
}

/** Wieviele Zeilen Rueckblick der Emulator haelt. tmux haelt vorgabemaessig 2000. */
const RUECKBLICK = 2000;

/**
 * node-pty wird SPAET geladen (`require` erst beim ersten Start), nicht beim
 * Laden des Moduls. Grund: es ist der einzige Binaerteil dieser Anwendung, und
 * ein Programm, das ihn beim Start braucht, laeuft ueberhaupt nicht mehr, wenn
 * er auf einer Plattform fehlt -- auch dann nicht, wenn der Schalter
 * `workerTransport` auf 'tmux' steht und ihn gar niemand will.
 */
type PtyModul = typeof NodePty;
let ptyModul: PtyModul | null = null;
function ladePty(): PtyModul {
  if (!ptyModul) ptyModul = require('node-pty') as PtyModul;
  return ptyModul;
}

/**
 * Der Bildschirm eines Terminalmodells als Text, in der Form von
 * `capture-pane -p` (M1 oben): alle sichtbaren Zeilen, rechts beschnitten, mit
 * "\n" verbunden, ohne Umbruch am Ende.
 */
export function schirmText(term: Terminal): string {
  const puffer = term.buffer.active;
  const zeilen: string[] = [];
  for (let i = 0; i < term.rows; i++) {
    const zeile = puffer.getLine(puffer.viewportY + i);
    zeilen.push(zeile ? rechtsBeschnitten(zeile.translateToString(true)) : '');
  }
  return zeilen.join('\n');
}

/**
 * GEMESSEN, nicht angenommen (04.09.2026, erster Lauf von
 * shell/tests/test-pty-wache.sh, Zusage A): `translateToString(true)` von xterm
 * schneidet nur Zellen ab, in die nie etwas geschrieben wurde -- ein
 * ausdruecklich geschriebenes Leerzeichen bleibt stehen. `capture-pane -p`
 * schneidet dagegen jedes Leerzeichen am Zeilenende weg. Der Unterschied war im
 * ersten Lauf genau ein Byte -- die Eingabezeile "❯ " gegen "❯" -- und haette
 * jeden byteweisen Vergleich der beiden Wege scheitern lassen.
 */
function rechtsBeschnitten(zeile: string): string {
  return zeile.replace(/[ \t]+$/, '');
}

/**
 * Der Rueckblick, in der Form von `capture-pane -p -S -<n>`: die letzten `n`
 * Zeilen VOR dem Schirm, gefolgt vom Schirm selbst.
 */
export function historieText(term: Terminal, zeilen: number): string {
  const puffer = term.buffer.active;
  const bis = puffer.viewportY + term.rows;
  const von = Math.max(0, puffer.viewportY - zeilen);
  const raus: string[] = [];
  for (let i = von; i < bis; i++) {
    const zeile = puffer.getLine(i);
    raus.push(zeile ? rechtsBeschnitten(zeile.translateToString(true)) : '');
  }
  return raus.join('\n');
}

export class PtyVerwaltung extends EventEmitter {
  private readonly panes = new Map<string, PtyEintrag>();
  private naechste = 1;

  /** @param merkDatei Wo die Momentaufnahme fuer den Neustart liegt. */
  constructor(private readonly merkDatei: string) {
    super();
  }

  /**
   * Die Kennung eines pty-Panes traegt ihr Praefix im Namen. Jede Stelle
   * ausserhalb dieser Datei -- die Wache, wb-pane-write, der Steuerkanal, der
   * Renderer -- unterscheidet daran, welchen Weg ein Pane braucht, ohne
   * irgendwo eine Liste fuehren zu muessen.
   */
  static istPty(paneId: string): boolean {
    return paneId.startsWith('pty:');
  }

  liste(): PtyStand[] {
    return [...this.panes.values()].map((e) => this.stand(e));
  }

  stand(e: PtyEintrag): PtyStand {
    return {
      id: e.id,
      name: e.auftrag.name,
      cols: e.term.cols,
      rows: e.term.rows,
      lebt: e.lebt,
      cwd: e.auftrag.cwd,
      harness: e.auftrag.harness ?? '',
      rolle: e.auftrag.rolle ?? 'worker',
      startbefehl: e.argv.join(' '),
      herkunft: e.herkunft,
      pid: e.pid,
    };
  }

  standVon(paneId: string): PtyStand | null {
    const e = this.panes.get(paneId);
    return e ? this.stand(e) : null;
  }

  /**
   * Einen Worker starten. Gibt die Pane-Kennung zurueck ('pty:1', 'pty:2', …).
   *
   * `fortsetzen` fuegt die Fortsetzungs-Argumente des Harness ein; das tut nur
   * `wiederaufnehmen()` beim Start der Anwendung, ein Aufruf von aussen startet
   * immer frisch.
   */
  starten(auftrag: PtyAuftrag, fortsetzen = false): string {
    const id = `pty:${this.naechste++}`;
    const { argv, herkunft } = this.startzeile(auftrag, fortsetzen);
    const term = new Terminal({
      cols: auftrag.cols,
      rows: auftrag.rows,
      scrollback: RUECKBLICK,
      allowProposedApi: true,
    });
    const eintrag: PtyEintrag = { id, auftrag, argv, term, pty: null, lebt: false, herkunft, pid: 0 };
    this.panes.set(id, eintrag);

    const pty = ladePty();
    const kind = pty.spawn(argv[0], argv.slice(1), {
      name: 'xterm-256color',
      cols: auftrag.cols,
      rows: auftrag.rows,
      cwd: auftrag.cwd,
      env: { ...process.env, ...(auftrag.env ?? {}) } as Record<string, string>,
    });
    eintrag.pty = kind;
    eintrag.lebt = true;
    eintrag.pid = kind.pid;
    kind.onData((d) => {
      // ZWEI EMPFAENGER, EINE QUELLE: der Emulator (damit `schirm()` stimmt,
      // auch wenn kein Fenster offen ist) und der Renderer ueber das Ereignis.
      // Die Reihenfolge ist tragend -- wer zuerst zeichnet und dann spiegelt,
      // liefert auf eine Anfrage im selben Moment einen veralteten Schirm.
      eintrag.term.write(d);
      this.emit('ausgabe', id, Buffer.from(d, 'utf8'));
    });
    kind.onExit(({ exitCode, signal }) => {
      eintrag.lebt = false;
      this.emit('ende', id, exitCode, signal ?? 0);
      this.merken();
    });
    this.merken();
    return id;
  }

  /** Die wirklich zu startende Zeile, mit oder ohne Fortsetzung. */
  private startzeile(auftrag: PtyAuftrag, fortsetzen: boolean): { argv: string[]; herkunft: string } {
    const grund = [auftrag.befehl, ...auftrag.args];
    if (!fortsetzen || !auftrag.wiederaufnahme) return { argv: grund, herkunft: 'frisch' };
    const w = auftrag.wiederaufnahme;
    const kennung = this.sitzungsKennung(w);
    if (kennung && w.args.length) {
      const zusatz = w.args.map((a) => a.replace('{resumeId}', kennung));
      return { argv: [...grund, ...zusatz], herkunft: `fortgesetzt (${zusatz.join(' ')})` };
    }
    if (w.fallbackArgs && w.fallbackArgs.length) {
      return { argv: [...grund, ...w.fallbackArgs], herkunft: `fortgesetzt (${w.fallbackArgs.join(' ')})` };
    }
    return { argv: grund, herkunft: 'frisch (keine Fortsetzung moeglich)' };
  }

  /**
   * Die Kennung der zuletzt geschriebenen Sitzungsdatei. Bewusst ueber die
   * Aenderungszeit und nicht ueber den Namen: die Kennung IST der Name, und
   * welcher davon der aktuelle ist, sagt nur die Uhr.
   */
  private sitzungsKennung(w: PtyWiederaufnahme): string {
    if (!w.sitzungsOrdner || !existsSync(w.sitzungsOrdner)) return '';
    const endung = w.sitzungsEndung ?? '.jsonl';
    let bester = '';
    let zeit = 0;
    for (const d of readdirSync(w.sitzungsOrdner)) {
      if (!d.endsWith(endung)) continue;
      try {
        const s = statSync(join(w.sitzungsOrdner, d));
        if (s.mtimeMs > zeit) {
          zeit = s.mtimeMs;
          bester = d.slice(0, -endung.length);
        }
      } catch {
        // Eine Datei, die zwischen readdir und stat verschwindet, ist keine.
      }
    }
    return bester;
  }

  schirm(paneId: string): string {
    const e = this.panes.get(paneId);
    if (!e) throw new Error(`kein pty-Pane ${paneId}`);
    return schirmText(e.term);
  }

  historie(paneId: string, zeilen = RUECKBLICK): string {
    const e = this.panes.get(paneId);
    if (!e) throw new Error(`kein pty-Pane ${paneId}`);
    return historieText(e.term, zeilen);
  }

  schreiben(paneId: string, bytes: Buffer): void {
    const e = this.panes.get(paneId);
    if (!e || !e.pty) throw new Error(`kein pty-Pane ${paneId}`);
    if (!e.lebt) throw new Error(`pty-Pane ${paneId} lebt nicht mehr`);
    e.pty.write(bytes.toString('utf8'));
  }

  /**
   * Die Kachel bestimmt Spalten und Zeilen -- beide Seiten, Emulator und
   * Pseudo-Terminal, bekommen dieselbe Zahl. Genau hier faellt die Beschraenkung
   * weg, die tmux auferlegt: keine gemeinsame Ganzzahl-Rasterung ueber alle
   * Panes eines Fensters, keine drei vorgegebenen Aufteilungen.
   */
  groesse(paneId: string, cols: number, rows: number): void {
    const e = this.panes.get(paneId);
    if (!e) throw new Error(`kein pty-Pane ${paneId}`);
    if (cols < 1 || rows < 1) throw new Error(`unsinnige Groesse ${cols}x${rows}`);
    if (e.term.cols === cols && e.term.rows === rows) return;
    e.term.resize(cols, rows);
    if (e.pty && e.lebt) e.pty.resize(cols, rows);
    e.auftrag.cols = cols;
    e.auftrag.rows = rows;
    this.merken();
  }

  beenden(paneId: string): void {
    const e = this.panes.get(paneId);
    if (!e) return;
    if (e.pty && e.lebt) {
      try {
        e.pty.kill();
      } catch {
        // Ein Kind, das schon weg ist, ist genau das gewuenschte Ergebnis.
      }
    }
    e.lebt = false;
    this.panes.delete(paneId);
    this.merken();
  }

  /** Alle Kinder beenden -- beim Herunterfahren der Anwendung. */
  allesBeenden(): void {
    for (const id of [...this.panes.keys()]) {
      const e = this.panes.get(id);
      if (e?.pty && e.lebt) {
        try {
          e.pty.kill();
        } catch {
          // siehe beenden()
        }
      }
      e && (e.lebt = false);
    }
  }

  /**
   * Die Momentaufnahme auf der Platte. Sie traegt den Auftrag, nicht den
   * Zustand: was ein Worker getan hat, steht in der Sitzungsdatei seines
   * Harness, und die ueberlebt die Anwendung ohnehin.
   *
   * Geschrieben wird ueber eine Tempdatei und `rename` -- aus demselben Grund
   * wie in build.mjs: ein Leser sieht immer eine vollstaendige Datei.
   */
  merken(): void {
    const daten = {
      version: 1,
      geschrieben: new Date().toISOString(),
      panes: [...this.panes.values()].map((e) => ({ auftrag: e.auftrag, lebte: e.lebt })),
    };
    try {
      mkdirSync(dirname(this.merkDatei), { recursive: true });
      const tmp = `${this.merkDatei}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(daten, null, 2), 'utf8');
      renameSync(tmp, this.merkDatei);
    } catch (err) {
      process.stderr.write(`pty: Momentaufnahme nicht geschrieben: ${(err as Error).message}\n`);
    }
  }

  /**
   * Nach einem Neustart: jeden gemerkten Worker wieder starten, mit den
   * Fortsetzungs-Argumenten seines Harness. Gibt zurueck, was daraus wurde --
   * der Aufrufer soll es protokollieren koennen, statt es zu vermuten.
   */
  wiederaufnehmen(): PtyStand[] {
    if (!existsSync(this.merkDatei)) return [];
    let daten: { panes?: Array<{ auftrag: PtyAuftrag; lebte?: boolean }> };
    try {
      daten = JSON.parse(readFileSync(this.merkDatei, 'utf8'));
    } catch (err) {
      process.stderr.write(`pty: Momentaufnahme unlesbar (${(err as Error).message}) -- nichts wiederaufgenommen\n`);
      return [];
    }
    const raus: PtyStand[] = [];
    for (const p of daten.panes ?? []) {
      if (!p?.auftrag?.befehl) continue;
      try {
        const id = this.starten(p.auftrag, true);
        const s = this.standVon(id);
        if (s) raus.push(s);
      } catch (err) {
        process.stderr.write(`pty: ${p.auftrag.name} nicht wiederaufgenommen: ${(err as Error).message}\n`);
      }
    }
    return raus;
  }
}
