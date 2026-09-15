// DER MANTEL-SOCKET (06.09.2026, Auftrag macplan) -- der Kanal, ueber den die
// Mac-native Oberflaeche („Mantel") diesen Hauptprozess als Kern benutzt.
//
// WARUM EIN ZWEITER SOCKET UND NICHT DER STEUERKANAL (control.ts). Der
// Steuerkanal ist per Bauart der Weg eines SKRIPTS in das laufende Programm:
// `type` und `key` fragen vor jedem Tastendruck `wb-pane-write darf`
// (steuerkanalDarfSchreiben in main.ts), damit kein Skript und kein Agent in
// einen Orchestrator-Pane tippt. Der Mantel ist das Gegenteil: er IST das
// Fenster, in dem der Mensch tippt -- derselbe Weg wie `awb:input` aus dem
// Electron-Renderer, der ohne Rueckfrage laeuft, weil dort ein Mensch sitzt
// (Regel 1 in wb-pane-write). Liefe der Mantel ueber den Steuerkanal, muesste
// entweder jeder Tastendruck des Menschen durch einen Unterprozess (0,16 s,
// gemessen 16.08.) und wuerde im Orchestrator-Pane abgelehnt, oder der
// Steuerkanal bekaeme einen Weg, der die Pruefung umgeht -- und damit haette
// jedes Skript ihn auch. Ein eigener Socket haelt beides auseinander: der
// Steuerkanal bleibt das gepruefte Werkzeug, der Mantel-Socket ist die
// Oberflaeche.
//
// WAS DIESER SOCKET IST: die Bruecke aus preload.ts, als JSON ueber eine Leitung.
//   Kern  -> Mantel   {"ev":"<kanal>", ...nutzlast}       (= webContents.send)
//   Mantel -> Kern    {"cmd":"send","kanal":"awb:input","args":[...]}     (= ipcRenderer.send)
//   Mantel -> Kern    {"id":n,"cmd":"invoke","kanal":"awb:ein-daten","args":[...]}
//   Kern  -> Mantel   {"id":n,"ok":true,"value":...} | {"id":n,"ok":false,"error":"..."}
// Die Kanalnamen sind die 54 aus main.ts, unveraendert -- es gibt EINE Logik
// und zwei Oberflaechen, und die Kanalliste ist die Vertragsgrenze (mac/PROTOKOLL.md).
//
// EIN MANTEL ZUR ZEIT. Eine zweite Verbindung loest die erste ab (sie wird
// geschlossen): es gibt ein Fenster, und ein Neustart der App soll nicht an
// einer haengengebliebenen Leitung scheitern.
//
// HANDSCHLAG. Die erste Zeile muss {"cmd":"hallo","token":"..."} sein; ohne
// den Token aus AWB_MANTEL_TOKEN wird die Leitung sofort geschlossen. Was
// derselbe Benutzer auf derselben Maschine erreichen kann, entscheidet auch
// diese Datei nicht (siehe control.ts) -- der Token verhindert, dass ein
// Prozess, der zufaellig den Pfad kennt, unbemerkt zum Fenster wird. Der
// Socket ist 0600 wie jede andere Datei dieses Programms.
//
// DER SOCKET ENTSTEHT NUR AUF VERLANGEN (AWB_MANTEL_SOCKET). Ohne die
// Variable laeuft die Electron-Fassung unveraendert: kein Server, keine Datei.
import { createServer, Server, Socket } from 'node:net';
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export interface MantelAnschluss {
  /** ipcRenderer.send: feuern und vergessen. */
  send(kanal: string, args: unknown[]): void;
  /** ipcRenderer.invoke: eine Antwort. */
  invoke(kanal: string, args: unknown[]): Promise<unknown>;
  /** Ein Mantel hat sich angemeldet -- Zeit, ihm den Anfangszustand zu schicken. */
  verbunden(): void;
}

export class MantelKanal {
  private server: Server | null = null;
  private client: Socket | null = null;
  private inode = 0;

  constructor(
    private readonly pfad: string,
    private readonly token: string,
    private readonly anschluss: MantelAnschluss,
  ) {}

  /** Ob gerade ein Mantel angemeldet ist (nach dem Handschlag). */
  get angemeldet(): boolean {
    return this.client !== null;
  }

  async listen(): Promise<void> {
    mkdirSync(dirname(this.pfad), { recursive: true });
    if (existsSync(this.pfad)) {
      if (!statSync(this.pfad).isSocket()) {
        throw new Error(`${this.pfad} ist kein Socket -- Pfad pruefen, hier wird nichts geloescht`);
      }
      // Der Kern haelt genau EINEN Mantel-Socket, und er wird beim Start gesetzt:
      // eine liegengebliebene Datei gehoert einem Kern, den es nicht mehr gibt.
      unlinkSync(this.pfad);
    }
    const server = createServer((sock) => this.bedienen(sock));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.pfad, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    chmodSync(this.pfad, 0o600);
    this.inode = statSync(this.pfad).ino;
  }

  /** webContents.send: ein Ereignis an den angemeldeten Mantel. Ohne Mantel verhallt es. */
  push(kanal: string, nutzlast: unknown): void {
    if (!this.client) return;
    this.schreiben(this.client, { ev: kanal, ...(nutzlast && typeof nutzlast === 'object' ? nutzlast as object : { wert: nutzlast }) });
  }

  private schreiben(sock: Socket, obj: unknown): void {
    if (sock.destroyed) return;
    sock.write(JSON.stringify(obj) + '\n');
  }

  private bedienen(sock: Socket): void {
    let buf = '';
    let begruesst = false;
    const decoder = new StringDecoder('utf8');
    sock.on('data', (chunk) => {
      buf += decoder.write(chunk);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const zeile = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!zeile.trim()) continue;
        if (!begruesst) {
          begruesst = this.handschlag(sock, zeile);
          if (!begruesst) return;
          continue;
        }
        void this.zeile(sock, zeile);
      }
    });
    sock.on('error', () => sock.destroy());
    sock.on('close', () => {
      if (this.client === sock) this.client = null;
    });
  }

  private handschlag(sock: Socket, zeile: string): boolean {
    let req: { cmd?: unknown; token?: unknown } = {};
    try {
      req = JSON.parse(zeile) as typeof req;
    } catch {
      // unlesbar -- unten abgewiesen
    }
    if (req.cmd !== 'hallo' || (this.token && req.token !== this.token)) {
      this.schreiben(sock, { ok: false, error: 'Handschlag abgelehnt' });
      sock.destroy();
      return false;
    }
    // Der Neue loest den Alten ab.
    if (this.client && this.client !== sock) this.client.destroy();
    this.client = sock;
    this.schreiben(sock, { ok: true, ev: 'hallo', pid: process.pid });
    this.anschluss.verbunden();
    return true;
  }

  private async zeile(sock: Socket, zeile: string): Promise<void> {
    let req: { id?: unknown; cmd?: unknown; kanal?: unknown; args?: unknown };
    try {
      req = JSON.parse(zeile) as typeof req;
    } catch {
      this.schreiben(sock, { ok: false, error: `unlesbare Zeile: ${zeile.slice(0, 80)}` });
      return;
    }
    const kanal = String(req.kanal ?? '');
    const args = Array.isArray(req.args) ? req.args : [];
    if (req.cmd === 'send') {
      try {
        this.anschluss.send(kanal, args);
      } catch (e) {
        this.schreiben(sock, { ok: false, kanal, error: (e as Error).message });
      }
      return;
    }
    if (req.cmd === 'invoke') {
      try {
        const value = await this.anschluss.invoke(kanal, args);
        this.schreiben(sock, { id: req.id ?? null, ok: true, value: value === undefined ? null : value });
      } catch (e) {
        this.schreiben(sock, { id: req.id ?? null, ok: false, error: (e as Error).message });
      }
      return;
    }
    if (req.cmd === 'ping') {
      this.schreiben(sock, { id: req.id ?? null, ok: true, value: { pid: process.pid } });
      return;
    }
    this.schreiben(sock, { id: req.id ?? null, ok: false, error: `unbekannter Befehl ${String(req.cmd)}` });
  }

  async close(): Promise<void> {
    this.client?.destroy();
    this.client = null;
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
    try {
      if (this.inode && statSync(this.pfad).ino !== this.inode) return;
      unlinkSync(this.pfad);
    } catch {
      // schon weg
    }
  }
}
