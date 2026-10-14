// AUTOMATISCHE GERAETE-REPLIKATION NACH peer (Auftrag mobil-replik, 09.10.2026).
//
// Nach jeder Kopplung und jedem Widerruf am Mac wandert das Geraeteregister
// (auth-state.json) ueber den erlaubten Syncthing-Kanal ~/.secrets-sync/mobile
// zur Gegenstelle und wird dort mit `geraete-replizieren.mjs registry` und
// danach `audience --origin <ihre Origin>` uebernommen. Vorher ging das nur von
// Hand (docs/MOBILE-APP-BETRIEB.md, Schritt 10 und Abschnitt 7) -- und ohne
// Replikation nahm peer ein widerrufenes Geraet weiter an.
//
// Ein Lauf je Ziel:
//   1. Kopie der auth-state.json als 0600-Datei `wb-replik-<...>.json` in den Kanal,
//   2. `ssh <maschine> bash -s -- <name> <sha256> <origin> <frist>` mit
//      deploy/mobile/replik-gegenseite.sh (samt beiden Werkzeugen) als stdin:
//      dort Warten auf die Kopie mit Hash-Vergleich, Import, Aufraeumen,
//   3. Kanalkopie am Mac loeschen -- auch im Fehlerfall -- und pruefen, dass sie weg ist,
//   4. Pruefung: der Gerätestand (sha256 ueber "id:status") drueben gleicht dem
//      der geschickten Kopie.
//
// FAIL-CLOSED UND LAUT: Vor jedem Lauf steht die Vormerkung
// `<authVerzeichnis>/peer-replikation-offen.json` (Grund, Zeit) schon auf der
// Platte; sie verschwindet erst nach einem geprueften Erfolg. Ein Absturz
// mitten im Lauf laesst sie also stehen. Solange sie liegt, wiederholt der Kern
// beim Start und im ruhigen Takt (10 min, hoechstens 4 Versuche je Stunde),
// trockenpruefung.sh meldet sie, und jeder Fehlschlag steht im Protokoll.
//
// Nie gedruckt: Dateiinhalte, Schluessel, Hashes ueber Schluesselmaterial. Im
// Protokoll stehen nur Anlass, Ziel, Grund und die Kurzform des Geraetestands.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const VORMERKUNG = 'peer-replikation-offen.json';
const SCHLOSS = 'peer-replikation.lock';
const PRAEFIX = 'wb-replik-';

export interface ReplikZiel {
  /** ssh-Name aus `remoteMachines`. */
  readonly maschine: string;
  /** Die Origin dieser Maschine aus `mobileOrigins`; sie wird drueben je Geraet freigeschaltet. */
  readonly origin: string;
}

export interface ReplikKonfig {
  /** Verzeichnis mit auth-state.json (Quelle) -- dort liegen auch Vormerkung und Schloss. */
  readonly authVerzeichnis: string;
  /** Ziele; ein Eintrag mit leerer Maschine ist ein Konfigurationsfehler, der als Vormerkung sichtbar bleibt. */
  readonly ziele: readonly ReplikZiel[];
  /** deploy/mobile des laufenden Repos (Gegenseitenskript und Werkzeuge). */
  readonly werkzeugVerzeichnis: string;
  /** Kanal am Mac; Vorgabe ~/.secrets-sync/mobile. Drueben gilt immer $HOME/.secrets-sync/mobile. */
  readonly kanalVerzeichnis?: string;
  readonly sshBin?: string;
  /** Frist fuer die Ankunft der Kanalkopie drueben (Sekunden). */
  readonly ankunftFristS?: number;
  readonly taktMs?: number;
  readonly versucheJeStunde?: number;
  readonly protokoll?: (zeile: string) => void;
  readonly jetzt?: () => number;
}

export interface Replikation {
  /** Nach Kopplung/Widerruf: Vormerkung sofort schreiben, Lauf im Hintergrund anstossen. Blockiert nie. */
  ausloesen(anlass: string): void;
  /** Beim Kernstart: Reste aufraeumen, offene Vormerkung wiederholen, Takt starten. */
  starten(): void;
  stoppen(): void;
  /** Wartet, bis kein Lauf mehr laeuft oder geplant ist (fuer Tests und geordnetes Beenden). */
  ruhig(): Promise<void>;
  offen(): Vormerkung | null;
}

export interface Vormerkung {
  readonly seit: string;
  readonly aktualisiert: string;
  readonly anlass: string;
  readonly grund: string;
  readonly versuche: readonly number[];
}

const sha256 = (daten: Buffer | string): string => createHash('sha256').update(daten).digest('hex');

/** sha256 ueber die sortierten Zeilen "device_id:status" -- dieselbe Rechnung wie in replik-gegenseite.sh. */
export function geraeteStand(authState: Buffer): string {
  const devices = (JSON.parse(authState.toString('utf8')) as { devices?: Record<string, { device_id: string; status: string }> }).devices ?? {};
  return sha256(Object.values(devices).map((g) => `${g.device_id}:${g.status}`).sort().join('\n'));
}

/**
 * Ziele aus der Konfiguration: jede Origin ausser der eigenen, zugeordnet der
 * Maschine aus `remoteMachines`, deren Name das erste DNS-Label des Hosts ist
 * (`https://peer.tailnet.example.ts.net:8444` -> `peer`). Findet sich keine, bleibt
 * das Ziel mit leerer Maschine stehen und scheitert laut.
 */
export function replikZiele(origins: readonly string[], eigene: string, maschinen: readonly string[]): ReplikZiel[] {
  return origins.filter((o) => o !== eigene).map((origin) => {
    let label = '';
    try {
      label = new URL(origin).hostname.split('.')[0].toLowerCase();
    } catch {
      label = '';
    }
    return { origin, maschine: maschinen.find((m) => m.toLowerCase() === label) ?? '' };
  });
}

function schreibeAtomar(pfad: string, inhalt: string): void {
  const tmp = `${pfad}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, inhalt, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, pfad);
}

interface SshErgebnis { code: number | null; stdout: string; stderr: string }

function sshLaufen(bin: string, argv: readonly string[], stdin: string, fristMs: number): Promise<SshErgebnis> {
  return new Promise((resolve) => {
    let kind: ReturnType<typeof spawn>;
    try {
      kind = spawn(bin, [...argv], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (fehler) {
      resolve({ code: null, stdout: '', stderr: (fehler as Error).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let fertig = false;
    const ende = (code: number | null, zusatz = ''): void => {
      if (fertig) return;
      fertig = true;
      clearTimeout(uhr);
      resolve({ code, stdout, stderr: `${stderr}${zusatz}` });
    };
    const uhr = setTimeout(() => {
      kind.kill('SIGKILL');
      ende(null, `Frist von ${Math.round(fristMs / 1000)} s ueberschritten`);
    }, fristMs);
    kind.stdout!.setEncoding('utf8');
    kind.stderr!.setEncoding('utf8');
    kind.stdout!.on('data', (t: string) => { if (stdout.length < 8192) stdout += t; });
    kind.stderr!.on('data', (t: string) => { if (stderr.length < 8192) stderr += t; });
    kind.once('error', (fehler) => ende(null, fehler.message));
    kind.once('close', (code) => ende(code));
    kind.stdin!.once('error', () => { /* ein frueh beendetes ssh schliesst stdin; sein Exit zaehlt */ });
    kind.stdin!.end(stdin);
  });
}

/** Letzte aussagekraeftige Zeile von stderr, ohne Steuerzeichen, gekuerzt. */
function kurzGrund(text: string, ersatz: string): string {
  const zeile = text.split('\n').map((z) => z.trim()).filter(Boolean).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  return (zeile.replace(/[\u0000-\u001f]/g, ' ').slice(0, 200)) || ersatz;
}

function lebt(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (fehler) {
    return (fehler as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function replikationBauen(konfig: ReplikKonfig): Replikation {
  const protokoll = konfig.protokoll ?? ((): void => undefined);
  const jetzt = konfig.jetzt ?? Date.now;
  const kanal = konfig.kanalVerzeichnis ?? join(homedir(), '.secrets-sync', 'mobile');
  const sshBin = konfig.sshBin ?? 'ssh';
  const frist = konfig.ankunftFristS ?? 120;
  const taktMs = konfig.taktMs ?? 10 * 60_000;
  const proStunde = konfig.versucheJeStunde ?? 4;
  const vormerkungPfad = join(konfig.authVerzeichnis, VORMERKUNG);
  const schlossPfad = join(konfig.authVerzeichnis, SCHLOSS);

  let laeuft: Promise<void> | null = null;
  let nochmal = false;
  let geplant = false;
  let anlassOffen = '';
  let uhr: NodeJS.Timeout | null = null;

  const offen = (): Vormerkung | null => {
    try {
      return JSON.parse(readFileSync(vormerkungPfad, 'utf8')) as Vormerkung;
    } catch {
      return existsSync(vormerkungPfad)
        ? { seit: '', aktualisiert: '', anlass: 'unlesbar', grund: 'Vormerkung unlesbar', versuche: [] } : null;
    }
  };

  const vormerken = (anlass: string, grund: string, versuch: boolean): void => {
    const alt = offen();
    const stunde = jetzt() - 3_600_000;
    const versuche = [...(alt?.versuche ?? []).filter((t) => t > stunde), ...(versuch ? [jetzt()] : [])];
    const zeit = new Date(jetzt()).toISOString();
    const neu: Vormerkung = { seit: alt?.seit || zeit, aktualisiert: zeit, anlass: anlass || alt?.anlass || '', grund, versuche };
    mkdirSync(konfig.authVerzeichnis, { recursive: true, mode: 0o700 });
    schreibeAtomar(vormerkungPfad, `${JSON.stringify(neu)}\n`);
  };

  /** Prozessuebergreifendes Schloss (mkdir ist atomar); ein totes Schloss wird uebernommen. */
  const schlossNehmen = (): boolean => {
    for (let i = 0; i < 2; i += 1) {
      try {
        mkdirSync(schlossPfad, { mode: 0o700 });
        writeFileSync(join(schlossPfad, 'pid'), String(process.pid), { mode: 0o600 });
        return true;
      } catch (fehler) {
        if ((fehler as NodeJS.ErrnoException).code !== 'EEXIST') return false;
        const pid = Number(((): string => { try { return readFileSync(join(schlossPfad, 'pid'), 'utf8'); } catch { return ''; } })());
        let alter = 0;
        try { alter = jetzt() - statSync(schlossPfad).mtimeMs; } catch { /* eben verschwunden */ }
        const tot = Number.isSafeInteger(pid) && pid > 0 ? !lebt(pid) : alter > 60_000;
        if (!tot) return false;
        rmSync(schlossPfad, { recursive: true, force: true });
      }
    }
    return false;
  };
  const schlossGeben = (): void => { rmSync(schlossPfad, { recursive: true, force: true }); };

  const kanalReste = (): void => {
    let namen: string[] = [];
    try { namen = readdirSync(kanal); } catch { return; }
    for (const n of namen) if (n.startsWith(PRAEFIX) && n.endsWith('.json')) rmSync(join(kanal, n), { force: true });
  };

  const einZiel = async (ziel: ReplikZiel, daten: Buffer, skript: string): Promise<string> => {
    if (!ziel.maschine) return `keine Maschine in remoteMachines fuer ${ziel.origin}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ziel.maschine)) return `ungueltiger Maschinenname ${ziel.maschine}`;
    if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(ziel.origin)) return `ungueltige Origin ${ziel.origin}`;
    const name = `${PRAEFIX}${ziel.maschine}-${jetzt()}-${randomBytes(4).toString('hex')}.json`;
    const kopie = join(kanal, name);
    const soll = sha256(daten);
    try {
      let fd: number;
      try {
        fd = openSync(kopie, 'wx', 0o600);
      } catch (fehler) {
        return `Kanalkopie nicht schreibbar (${(fehler as NodeJS.ErrnoException).code ?? 'Fehler'})`;
      }
      try {
        writeFileSync(fd, daten);
      } finally {
        closeSync(fd);
      }
      chmodSync(kopie, 0o600);
      const befehl = ['bash', '-s', '--', name, soll, ziel.origin, String(frist)].map((t) => `'${t}'`).join(' ');
      const r = await sshLaufen(sshBin, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', ziel.maschine, befehl], skript, (frist + 90) * 1000);
      if (r.code !== 0) return `${ziel.maschine}: ${kurzGrund(r.stderr, `ssh endete mit ${r.code ?? 'Abbruch'}`)}`;
      const stand = /^GERAETE ([0-9a-f]{64})$/m.exec(r.stdout)?.[1] ?? '';
      if (!/^AUFGERAEUMT$/m.test(r.stdout)) return `${ziel.maschine}: Gegenseite meldet kein Aufraeumen`;
      if (stand !== geraeteStand(daten)) return `${ziel.maschine}: Geraetestand drueben weicht nach dem Import ab`;
      return '';
    } finally {
      rmSync(kopie, { force: true });
      if (existsSync(kopie)) protokoll(`Mobil-Replikation: Kanalkopie ${name} liess sich nicht entfernen`);
    }
  };

  const einmal = async (): Promise<void> => {
    const anlass = anlassOffen || offen()?.anlass || 'Wiederholung';
    anlassOffen = '';
    if (!schlossNehmen()) {
      vormerken(anlass, 'ein anderer Replikationslauf haelt das Schloss', false);
      protokoll('Mobil-Replikation nach peer offen: ein anderer Lauf haelt das Schloss; Wiederholung im Takt.');
      return;
    }
    try {
      vormerken(anlass, 'Lauf begonnen', true);
      let fehler = '';
      let daten: Buffer | null = null;
      let skript = '';
      try {
        daten = readFileSync(join(konfig.authVerzeichnis, 'auth-state.json'));
        geraeteStand(daten);
        const b64 = (n: string): string => readFileSync(join(konfig.werkzeugVerzeichnis, n)).toString('base64');
        skript = `WB_GR_B64='${b64('geraete-replizieren.mjs')}'\nWB_AS_B64='${b64('auth-schloss.mjs')}'\n`
          + readFileSync(join(konfig.werkzeugVerzeichnis, 'replik-gegenseite.sh'), 'utf8');
      } catch (e) {
        fehler = `Quelle oder Werkzeuge unlesbar (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`;
      }
      if (!fehler && !konfig.ziele.length) fehler = 'keine Gegenstelle in mobileOrigins';
      if (!fehler && daten) {
        try {
          mkdirSync(kanal, { recursive: false, mode: 0o700 });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') fehler = `Kanal ${kanal} fehlt (${(e as NodeJS.ErrnoException).code})`;
        }
      }
      if (!fehler && daten) {
        const gruende: string[] = [];
        for (const ziel of konfig.ziele) {
          const g = await einZiel(ziel, daten, skript);
          if (g) gruende.push(g);
          else protokoll(`Mobil-Replikation nach ${ziel.maschine} geprueft (${anlass}; Geraetestand ${geraeteStand(daten).slice(0, 8)}).`);
        }
        fehler = gruende.join('; ');
      }
      if (fehler) {
        vormerken(anlass, fehler, false);
        protokoll(`Mobil-Replikation nach peer OFFEN (${anlass}): ${fehler}. Vormerkung ${vormerkungPfad}; Wiederholung im Takt.`);
      } else if (!nochmal) {
        rmSync(vormerkungPfad, { force: true });
      }
    } finally {
      schlossGeben();
    }
  };

  const laufen = (): void => {
    geplant = false;
    if (laeuft) {
      nochmal = true;
      return;
    }
    laeuft = (async () => {
      do {
        nochmal = false;
        try {
          await einmal();
        } catch (fehler) {
          protokoll(`Mobil-Replikation nach peer OFFEN: ${(fehler as Error).message}`);
        }
      } while (nochmal);
    })().finally(() => { laeuft = null; });
  };

  const planen = (): void => {
    if (geplant) return;
    geplant = true;
    setImmediate(laufen);
  };

  return {
    ausloesen(anlass: string): void {
      try {
        // Zuerst die Vormerkung: stirbt der Prozess vor dem Lauf, ist die Luecke sichtbar.
        vormerken(anlass, 'ausstehend', false);
      } catch (fehler) {
        protokoll(`Mobil-Replikation: Vormerkung nicht schreibbar (${(fehler as Error).message})`);
      }
      anlassOffen = anlassOffen ? `${anlassOffen}, ${anlass}` : anlass;
      if (laeuft) nochmal = true;
      else planen();
    },
    starten(): void {
      kanalReste();
      if (offen()) {
        protokoll('Mobil-Replikation nach peer offen seit dem letzten Lauf; wiederhole beim Start.');
        planen();
      }
      if (uhr) clearInterval(uhr);
      uhr = setInterval(() => {
        const v = offen();
        if (!v || laeuft || geplant) return;
        const stunde = jetzt() - 3_600_000;
        if (v.versuche.filter((t) => t > stunde).length >= proStunde) return;
        planen();
      }, taktMs);
      uhr.unref();
    },
    stoppen(): void {
      if (uhr) clearInterval(uhr);
      uhr = null;
    },
    async ruhig(): Promise<void> {
      while (laeuft || geplant) {
        if (laeuft) await laeuft;
        else await new Promise((r) => setImmediate(r));
      }
    },
    offen,
  };
}
