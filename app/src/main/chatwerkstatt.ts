// DIE WERKSTATT EINER CHAT-SITZUNG -- der Ort, an dem IHRE Worker landen.
//
// DER BEFUND (alice nach dem ersten echten Gebrauch, 12.08.): „ich kann
// nicht vom orchestrator zu den workern wechseln."
//
// NACHGEMESSEN, WORAN ES LIEGT. `claude-worker` legt keinen Pane an, es reicht
// an `pi-worker` weiter, und der sucht sich sein Ziel in dieser Reihenfolge
// (shell/pi-worker, Abschnitt „spawn a fresh permanent chat pane"):
//
//   0) $WB_SESSION, wenn gesetzt
//   1) der eigene Pane ($TMUX_PANE), wenn der Aufrufer in tmux sitzt
//   2) die Session des rufenden Orchestrators, ueber die Prozess-Ahnenreihe
//   3) die ANGEHAENGTE wb-*-Session
//   4) die EINZIGE wb-*-Session -- sonst Abbruch
//
// Eine Chat-Sitzung erfuellt 0 bis 2 nicht: ihr Prozess ist ein Kind dieser
// App, er sitzt in keinem Pane, und seine Ahnenreihe fuehrt zu Electron, nicht
// zu einer wb-*-Session. Damit fiel jeder `claude-worker`-Aufruf aus einem Chat
// auf Stufe 3 oder 4 -- der Worker landete in einer FREMDEN Workbench oder gar
// nicht, und aus der Chat-Sitzung heraus war er nirgends zu sehen.
//
// DIE ANTWORT IST STUFE 0. Jede Chat-Sitzung bekommt ihre eigene tmux-Session,
// und ihr Prozess bekommt deren Namen in `WB_SESSION`. Ab da landen ihre Worker
// genau dort, deterministisch -- und weil das eine gewoehnliche wb-*-Session
// mit gewoehnlichen Worker-Panes ist, greift alles, was dieses Programm fuer
// Worker schon kann: anhaengen, zeichnen, umschalten, schliessen.
//
// WARUM KEINE ZUSTANDSDATEI (`wb-state touch`). Dann stuende die Werkstatt als
// EIGENE Sitzung in der linken Leiste -- neben der Chat-Zeile, die dieselbe
// Sache meint. Zwei Zeilen fuer eine Sitzung sind genau das, was Punkt 4 gerade
// beseitigt hat. Die Werkstatt bleibt deshalb aus der Buchfuehrung heraus und
// wird ueber die Chat-Zeile erreicht.
//
// DER HALTE-PANE. Eine tmux-Session ohne Pane gibt es nicht, und `pi-worker`
// braucht ein PANE als Ziel (`split-window -t`), keinen Sessionnamen -- gemessen
// am 25.07. auf peer: `display -p -t "=<session>"` antwortet still mit nichts.
// Also steht dort ein Pane, der nichts tut ausser dazustehen und zu sagen,
// wofuer er da ist. Er traegt `@wb_role orchestrator`, weil er in dieser Session
// die Stelle des Orchestrators einnimmt: `pi-worker` zaehlt daran seine
// `maxWorkers`, und die Guards lesen dieselbe Option.
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

/** Ein Worker-Pane in der Werkstatt einer Chat-Sitzung. */
export interface Werkstattworker {
  /** Der Name, den `pi-worker` an den Pane geschrieben hat (`@wb_worker`). */
  name: string;
  paneId: string;
  /** Lebt der Pane noch? `remain-on-exit` laesst einen beendeten stehen. */
  laeuft: boolean;
}

/**
 * DER NAME DER WERKSTATT ZU EINER CHAT-SITZUNG -- rein, damit er ohne tmux
 * pruefbar ist, und deterministisch, damit ein Neustart der App dieselbe
 * Werkstatt wiederfindet statt eine zweite anzulegen.
 *
 * Er faengt mit `wb-` an, weil `pi-worker` und `wb-close` genau darauf
 * filtern; das Stueck `chat-` dahinter haelt ihn von den Namen fern, die
 * `wb-code` fuer Terminal-Sitzungen baut (`wb-<ordner>-<md5>`).
 */
export function werkstattName(chatId: string, ordner: string): string {
  const roh = basename(ordner.replace(/\/+$/, '')) || 'chat';
  const slug = roh.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 24) || 'chat';
  // Aus der Kennung nur den Zufallsteil: `neueId` baut sie als
  // `chat-<zeit36>-<zufall6>`, und die sechs Stellen am Ende trennen zwei
  // Sitzungen desselben Ordners sicher genug.
  const kurz = chatId.split('-').pop() ?? chatId;
  return `wb-chat-${slug}-${kurz}`;
}

/** Die Zeile, die im Halte-Pane steht. Sie erklaert sich selbst, ohne Emoji. */
const HALTETEXT = 'Werkstatt dieser Chat-Sitzung. Der Orchestrator ist das Gespraech im Fenster; '
  + 'hier stehen ihre Worker.';

export interface WerkstattOptionen {
  /** Der tmux-Socket dieses Programms. Leer = der Vorgabesocket. */
  socket: string;
  /** Testhaken: ein anderes Programm statt `tmux`. */
  bin?: string;
}

export class Chatwerkstatt {
  constructor(private readonly opt: WerkstattOptionen) {}

  private tmux(args: string[], frist = 5000): { ok: boolean; aus: string } {
    const basis = this.opt.socket ? ['-L', this.opt.socket] : [];
    const r = spawnSync(this.opt.bin ?? 'tmux', [...basis, ...args], {
      encoding: 'utf8', timeout: frist,
    });
    if (r.error) return { ok: false, aus: '' };
    return { ok: r.status === 0, aus: (r.stdout ?? '').replace(/\n$/, '') };
  }

  /** Gibt es diese Session? */
  private gibtEs(name: string): boolean {
    return this.tmux(['has-session', '-t', `=${name}`]).ok;
  }

  /**
   * DIE WERKSTATT BEREITSTELLEN. Gibt den Namen zurueck, oder leer, wenn tmux
   * nicht ausfuehrbar war -- dann laeuft die Chat-Sitzung wie bisher, nur ohne
   * eigenen Ort fuer ihre Worker. Eine Sitzung darf daran nicht scheitern.
   */
  sicherstellen(chatId: string, ordner: string): string {
    const name = werkstattName(chatId, ordner);
    if (this.gibtEs(name)) {
      // Die Marke auch an eine SCHON vorhandene Werkstatt (12.08.): eine, die
      // vor dieser Fassung entstanden ist, traegt sie noch nicht, und ohne sie
      // faellt sie `pi-worker` wieder in die Ziel-Suche. Der Aufruf laeuft je
      // Start einer Sitzung, nicht je Takt.
      this.markiere(name);
      return name;
    }
    const angelegt = this.tmux([
      'new-session', '-d', '-s', name, '-c', ordner,
      // Der Halte-Pane: eine Zeile, dann warten. `read` waere kuerzer, haenge
      // aber an einem stdin, das es hier nicht gibt.
      'bash', '-lc', `printf '%s\\n\\n' ${JSON.stringify(HALTETEXT)}; while :; do sleep 3600; done`,
    ]);
    if (!angelegt.ok) {
      process.stderr.write(`Chatwerkstatt: '${name}' liess sich nicht anlegen\n`);
      return '';
    }
    const halte = this.tmux(['list-panes', '-t', `=${name}`, '-F', '#{pane_id}']).aus.split('\n')[0];
    if (halte) {
      // Dieselben Marken wie an einem Orchestrator-Pane von `wb-code`: die
      // Rolle, damit `pi-worker` seine Worker zaehlen kann, und der Titel,
      // damit im Bild steht, was das ist.
      this.tmux(['set', '-p', '-t', halte, '@wb_role', 'orchestrator']);
      this.tmux(['set', '-p', '-t', halte, 'remain-on-exit', 'on']);
      this.tmux(['select-pane', '-t', halte, '-T', 'CHAT-WERKSTATT']);
    }
    // `@awb_owner` sagt diesem Programm, dass die Session ihm gehoert -- dieselbe
    // Marke, an der `sessions.ts` eigene von uebernommenen unterscheidet.
    this.tmux(['set-option', '-t', name, '@awb_owner', String(process.pid)]);
    this.markiere(name);
    process.stderr.write(`Chatwerkstatt: angelegt (${name})\n`);
    return name;
  }

  /**
   * DIE MARKE, AN DER `pi-worker` EINE WERKSTATT ERKENNT (Reviewbefund 2,
   * 12.08.).
   *
   * Eine Werkstatt traegt das Praefix `wb-`, weil `find_pane` und `wb-close`
   * darauf filtern -- und wirkte genau dadurch auf die ZIEL-Suche von
   * `pi-worker` zurueck: Stufe 4 dort verlangt genau EINE `wb-*`-Session, also
   * scheiterte jeder `claude-worker` aus einem gewoehnlichen Terminal, sobald
   * eine Chat-Sitzung offen war. Stufe 3 war schlimmer: war die Werkstatt
   * gerade angehaengt (weil der Mensch zu einem Chat-Worker gewechselt hatte),
   * fing sie fremde Worker ein.
   *
   * `shell/pi-worker` uebergeht deshalb jede Session mit `@wb_chat=1` in seinen
   * Stufen 3 und 4. Eine OPTION und nicht der Name: `wb-code` baut fuer einen
   * Ordner namens `chat-foo` denselben Anfang, und eine echte Terminal-Sitzung
   * dieses Ordners waere sonst unsichtbar geworden.
   */
  private markiere(name: string): void {
    this.tmux(['set-option', '-t', name, '@wb_chat', '1']);
  }

  /**
   * DIE WORKER DIESER WERKSTATT. Der Halte-Pane faellt heraus: er traegt die
   * Rolle `orchestrator`, nicht `worker`, und ist kein Worker, sondern der
   * Platzhalter des Gespraechs.
   */
  worker(name: string): Werkstattworker[] {
    return this.workerAuskunft(name).liste;
  }

  /**
   * DASSELBE, ABER MIT DER FRAGE, OB TMUX UEBERHAUPT GEANTWORTET HAT (Befund 3
   * der Bugjagd, 15.08.).
   *
   * `worker()` gab bei einem Fehlschlag eine leere Liste zurueck, und
   * `aufraeumen()` las daraus „kein Worker laeuft hier mehr" -- nachgestellt in der Nacht
   * zum 16.08. mit einem `tmux`, dessen `list-panes` ueber die Frist hinaus haengt:
   * `aufraeumen()` schickte sein `kill-session`, obwohl es ueber die Panes
   * dieser Session nichts wusste. Genau der Fall, den die Sperre verhindern
   * soll. Wer nicht weiss, was in einer Session laeuft, raeumt sie nicht ab.
   */
  workerAuskunft(name: string): { ok: boolean; liste: Werkstattworker[] } {
    if (!name) return { ok: false, liste: [] };
    // KUERZERE FRIST ALS SONST (Reviewbefund 3, 12.08.): dieser Aufruf laeuft
    // im MODELLTAKT, alle zwei Sekunden. Haengt der tmux-Server, hielte er den
    // Hauptprozess sonst fuenf Sekunden je Takt auf -- laenger als der Takt
    // selbst. Anlegen und Abraeumen behalten die grosse Frist: sie laufen
    // einmal und duerfen nicht auf halbem Weg abbrechen.
    const r = this.tmux([
      'list-panes', '-s', '-t', `=${name}`, '-F',
      '#{pane_id}\t#{@wb_role}\t#{@wb_worker}\t#{pane_dead}',
    ], 1500);
    if (!r.ok) return { ok: false, liste: [] };
    const raus: Werkstattworker[] = [];
    for (const zeile of r.aus.split('\n')) {
      if (!zeile.trim()) continue;
      const [paneId, rolle, wname, tot] = zeile.split('\t');
      if (rolle !== 'worker') continue;
      raus.push({ name: wname || paneId, paneId, laeuft: tot !== '1' });
    }
    return { ok: true, liste: raus };
  }

  /**
   * DIE WERKSTATT ABRAEUMEN -- ABER NUR, WENN NICHTS DARIN LAEUFT.
   *
   * Eine Chat-Sitzung zu schliessen heisst, IHREN Prozess zu beenden; es heisst
   * nicht, die Arbeit ihrer Worker abzubrechen. Solange ein lebender
   * Worker-Pane dasteht, bleibt die Session stehen und der Grund auf stderr --
   * derselbe Satz, den ein Mensch braucht, um zu verstehen, warum sie noch da
   * ist. Steht nur noch der Halte-Pane, geht sie weg: ein Pane, der nichts tut,
   * ueberlebt seine Sitzung nicht.
   *
   * Gibt zurueck, ob wirklich abgeraeumt wurde.
   */
  aufraeumen(name: string): boolean {
    if (!name || !this.gibtEs(name)) return false;
    const auskunft = this.workerAuskunft(name);
    if (!auskunft.ok) {
      // Schweigen ist kein Freibrief: eine Session, ueber deren Panes tmux
      // gerade nichts sagt, bleibt stehen. Sie kostet nichts ausser einem
      // Eintrag in der Liste; ein Abbruch laufender Worker kostet ihre Arbeit.
      process.stderr.write(
        `Chatwerkstatt: '${name}' bleibt -- tmux hat auf die Frage nach ihren Panes nicht geantwortet\n`,
      );
      return false;
    }
    const lebende = auskunft.liste.filter((w) => w.laeuft);
    if (lebende.length) {
      process.stderr.write(
        `Chatwerkstatt: '${name}' bleibt -- ${lebende.length} Worker laufen noch `
        + `(${lebende.map((w) => w.name).join(', ')})\n`,
      );
      return false;
    }
    this.tmux(['kill-session', '-t', `=${name}`]);
    process.stderr.write(`Chatwerkstatt: abgeraeumt (${name})\n`);
    return true;
  }
}
