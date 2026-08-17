// V5 -- der Steuerkanal. Ein Unix-Socket, ueber den ein Skript das laufende
// Programm erreicht: Zustand abfragen, neu laden, Pane fokussieren, Foto
// ausloesen, sauber beenden.
//
// Er steht ab der ersten Zeile und nicht spaeter: Genau das nachtraeglich
// einzubauen ist der Fehler, den der vorige Aufbau eine ganze Nacht gekostet
// hat. Der Kanal ist eine BAUENTSCHEIDUNG und keine Sicherung -- er wird den
// Agenten in den Panes nicht in die Hand gegeben, weder als Dokumentation noch
// als Werkzeug (F17). Was ein Prozess desselben Benutzers auf derselben
// Maschine erreichen kann, entscheidet diese Datei nicht.
import { createServer, Server, Socket } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { connect } from 'node:net';
import { StringDecoder } from 'node:string_decoder';

export interface ControlRequest {
  cmd: string;
  [key: string]: unknown;
}

export type ControlHandler = (req: ControlRequest) => Promise<unknown>;

const warte = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Der Kommandoname eines Prozesses, oder '' wenn es ihn nicht mehr gibt. */
function prozessName(pid: number): string {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim();
  } catch {
    // ps meldet einen Fehlercode, wenn die PID nicht existiert -- genau das.
    return '';
  }
}

function eigenerName(): string {
  return prozessName(process.pid);
}

/**
 * Was die Info-Datei einer bestehenden Sperre ueber ihren Halter sagt.
 * 'unfertig' heisst: das Verzeichnis steht, die Zeile ist noch nicht
 * geschrieben -- jemand ist gerade mitten im Erwerb.
 */
function halterStand(info: string): 'lebt' | 'tot' | 'unfertig' {
  let zeile: string;
  try {
    zeile = readFileSync(info, 'utf8').trim();
  } catch {
    return 'unfertig';
  }
  if (!zeile) return 'unfertig';
  const [pidText, , name = ''] = zeile.split('\t');
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return 'tot';
  if (!name) {
    // Ohne `ps` (dann steht hier nichts) bleibt die reine Lebendpruefung. Sie
    // erkennt eine wiederverwendete PID nicht, ist aber besser als jeden
    // Halter fuer tot zu erklaeren, nur weil der Vergleichsname fehlt.
    try {
      process.kill(pid, 0);
      return 'lebt';
    } catch {
      return 'tot';
    }
  }
  const jetzt = prozessName(pid);
  return jetzt && jetzt === name ? 'lebt' : 'tot';
}

export class ControlChannel {
  private server: Server | null = null;
  /** Inode unseres eigenen Sockets -- siehe close(). */
  private inode = 0;

  constructor(private readonly path: string, private readonly handler: ControlHandler) {}

  async listen(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    // Anklopfen und Lauschen gehoeren ZUSAMMEN unter die Sperre: getrennt
    // klopfen zwei gleichzeitig startende Programme beide an, finden beide
    // niemanden, loeschen beide und lauschen beide (B6). Siehe uebernimmSperre.
    await this.mitSperre(async () => {
      await this.clearStaleSocket();
      const server = createServer((sock) => this.serve(sock));
      this.server = server;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(this.path, () => {
            server.removeListener('error', reject);
            resolve();
          });
        });
      } catch (e) {
        // Ein halb offener Server bliebe sonst als Zuhoerer im Prozess stehen.
        this.server = null;
        server.close();
        throw e;
      }
      // Nur der eigene Benutzer, so wie bei jeder anderen Datei dieses Programms.
      chmodSync(this.path, 0o600);
      this.inode = statSync(this.path).ino;
    });
  }

  /**
   * Gegenseitiger Ausschluss ueber ein Sperrverzeichnis mit PID und
   * Lebendpruefung -- derselbe Weg, den `shell/tests/run-all.sh` in
   * `acquire_run_lock` fuer dasselbe Problem geht, und aus demselben Grund:
   * eine Verfallsfrist muesste raten, wie lange ein legitimer Halter braucht,
   * eine Pruefung auf die lebende PID beantwortet "lebt der Halter noch?"
   * exakt. Zusaetzlich wird der Kommandoname verglichen, damit eine seit
   * einem Absturz wiederverwendete PID nicht faelschlich als Halter gilt.
   *
   * Ein Unterschied zu run-all.sh: dort haelt ein Lauf die Sperre minutenlang,
   * deshalb bricht der Zweite sofort laut ab. Hier ist sie nur fuer das
   * Anklopfen und das listen() gehalten, also Millisekunden -- warten ist
   * richtig, und wer wartet, findet danach den Steuerkanal des Gewinners
   * belegt und bekommt die lesbare Meldung aus clearStaleSocket().
   */
  private async mitSperre<T>(fn: () => Promise<T>): Promise<T> {
    const dir = `${this.path}.lock.d`;
    const info = join(dir, 'info');
    let leerSeit: number | null = null;
    for (let versuch = 1; versuch <= 100; versuch++) {
      try {
        // mkdir ist der atomare Teil: entweder wir legen es an, oder es gibt es.
        mkdirSync(dir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const stand = halterStand(info);
        if (stand === 'unfertig') {
          // Jemand ist gerade zwischen mkdir und dem Schreiben der Zeile.
          // Bleibt es laenger dabei, ist er genau dazwischen gestorben --
          // dann uebernehmen wir, statt ewig auf eine Zeile zu warten.
          leerSeit ??= Date.now();
          if (Date.now() - leerSeit > 1000) {
            rmSync(dir, { recursive: true, force: true });
            leerSeit = null;
          }
        } else {
          leerSeit = null;
          // Halter tot oder PID inzwischen anderweitig vergeben: liegengeblieben.
          if (stand === 'tot') rmSync(dir, { recursive: true, force: true });
        }
        await warte(30);
        continue;
      }
      try {
        writeFileSync(info, `${process.pid}\t${Date.now()}\t${eigenerName()}\n`);
        return await fn();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    throw new Error(`Sperre ${dir} liess sich nach 100 Versuchen nicht erwerben -- Wettlauf?`);
  }

  /**
   * Eine liegengebliebene Socketdatei blockiert den Start, ein LAUFENDES
   * Programm darf sie aber nicht verlieren. Also erst anklopfen: antwortet
   * jemand, brechen wir laut ab; antwortet niemand, ist die Datei tot.
   */
  private async clearStaleSocket(): Promise<void> {
    if (!existsSync(this.path)) return;
    // Was kein Socket ist, gehoert uns nicht. Ein vertippter Pfad oder eine
    // fremde Datei mit demselben Namen wird gemeldet, nicht geloescht.
    if (!statSync(this.path).isSocket()) {
      throw new Error(`${this.path} ist kein Socket -- Pfad pruefen, hier wird nichts geloescht`);
    }
    const alive = await new Promise<boolean>((resolve) => {
      const probe = connect(this.path);
      const done = (v: boolean) => {
        probe.destroy();
        resolve(v);
      };
      probe.once('connect', () => done(true));
      probe.once('error', () => done(false));
      setTimeout(() => done(false), 500);
    });
    if (alive) throw new Error(`Steuerkanal ${this.path} ist bereits belegt`);
    unlinkSync(this.path);
  }

  private serve(sock: Socket): void {
    let buf = '';
    /**
     * DIE ANTWORTEN EINES CLIENTS IN DER REIHENFOLGE SEINER ANFRAGEN
     * (Bugjagd-Befund vom 15.08., behoben am 16.08.).
     *
     * Das Protokoll dieses Kanals ist zeilenweise und traegt KEINE Kennung:
     * wer zwei Anfragen schickt, ordnet die erste Antwortzeile der ersten
     * Anfrage zu -- er hat gar kein anderes Merkmal. Bis heute startete jede
     * Zeile ihre Bearbeitung sofort (`void this.answer(...)`), und wer zwei
     * Befehle nacheinander in dieselbe Verbindung schrieb, bekam die schnelle
     * Antwort zuerst: `state` (Millisekunden) ueberholte `chat zeigen`
     * (Sekunden), und beide Antworten landeten beim falschen Befehl.
     *
     * Die Kette haelt sie auseinander. Sie gilt JE VERBINDUNG -- zwei Clients
     * bremsen sich nicht gegenseitig aus, und ein Client, der Nebenlaeufigkeit
     * will, oeffnet wie bisher zwei Verbindungen (`awb-ctl` tut je Aufruf
     * genau das).
     */
    let kette: Promise<void> = Promise.resolve();
    // Dieselbe Vorsicht wie in bin/awb-ctl auf der Gegenseite: ein Zeichen, das
    // auf eine Chunk-Grenze faellt, darf nicht zerbrechen. Hier sind die Zeilen
    // kurz, aber `type <text>` traegt beliebigen Text herein -- und ein Fehler,
    // der nur ab einer bestimmten Laenge auftritt, ist der unangenehmste.
    const decoder = new StringDecoder('utf8');
    sock.on('data', (chunk) => {
      buf += decoder.write(chunk);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        // Das `catch` haelt die Kette heil: eine geplatzte Verbindung darf
        // nicht dazu fuehren, dass keine weitere Zeile mehr beantwortet wird.
        kette = kette.then(() => this.answer(sock, line)).catch(() => {});
        void kette;
      }
    });
    sock.on('error', () => sock.destroy());
  }

  private async answer(sock: Socket, line: string): Promise<void> {
    let reply: unknown;
    try {
      const req = JSON.parse(line) as ControlRequest;
      if (typeof req.cmd !== 'string') throw new Error('Feld cmd fehlt');
      reply = { ok: true, ...(await this.handler(req) as object) };
    } catch (e) {
      reply = { ok: false, error: (e as Error).message };
    }
    sock.write(JSON.stringify(reply) + '\n');
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
    try {
      // Nur den EIGENEN Socket wegraeumen. Starten zwei Programme gleichzeitig
      // auf einer liegengebliebenen Datei, lauschen beide, erreichbar ist der
      // zweite -- und der erste nahm beim Beenden bisher den Socket des
      // anderen mit. Der Vergleich der Inode verhindert genau das.
      if (this.inode && statSync(this.path).ino !== this.inode) return;
      unlinkSync(this.path);
    } catch {
      // schon weg -- kein Grund, den Ausstieg daran scheitern zu lassen
    }
  }
}
