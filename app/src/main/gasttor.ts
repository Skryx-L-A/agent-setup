// DIE GAST-TOR-QUELLE (27.09.2026): Sitzungen einer fernen Maschine, die nur
// ueber `wb-gast-tor` erreichbar ist -- der Fall ist der Laptop eines zweiten Nutzers, der die
// Sitzungen auf dem Server des Betreibers sehen soll.
//
// WARUM NICHT DER GEWOEHNLICHE FERNWEG (remote.ts): der fragt mit
// `ssh <host> bash -s` ab und haengt mit `tmux -C` an. Beides kommt einer Shell
// gleich, und das Tor laesst genau das nicht zu (shell/wb-gast-tor, Kopf).
// Diese Quelle spricht deshalb NUR die Befehle des Tors:
//
//   liste --json                        -> Sitzungsliste (als RemoteSnapshot, damit
//                                          die Leiste sie zeichnet wie jede Fernsitzung)
//   anhaengen <sitzung> [<pane>]        -> Terminal auf der Buehne (node-pty, `ssh -t`)
//   vorschau <sitzung> --json           -> Kacheln (reiner Text, nur lesen)
//   neu / schliessen [--endgueltig]     -> Sitzung starten / eigene schliessen
//
// Was das Tor erlaubt, entscheidet allein das Tor. Hier wird nur der Aufruf
// gebaut und die Antwort gelesen -- und beides so, dass eine fremde Antwort
// nichts anrichten kann: Namen werden gequotet, Text wird vor dem Zeichnen
// noch einmal von Steuerzeichen befreit.
import { readFileSync } from 'node:fs';
import type { PaneRow } from './sessions';
import type { RemoteSessionRaw, RemoteSnapshot } from './remote';

export interface GastQuelle {
  /** Anzeigename und Maschinenkennung in der Leiste (`peer`). */
  name: string;
  /** SSH-Alias aus ~/.ssh/config, hinter dem der Tor-Schluessel steht. */
  ssh: string;
  /** Nur zur Anzeige: welche Projekte das Profil dort erwartet. Das Tor meldet die echten. */
  projekte: string[];
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
// NIE mit '-' vorn: `ssh -oProxyCommand=...` als "Alias" waere eine Option, kein Ziel.
const SSH_RE = /^[A-Za-z0-9_][A-Za-z0-9._@-]{0,99}$/;

function quelleAus(roh: unknown): GastQuelle | string {
  if (!roh || typeof roh !== 'object') return 'Eintrag ist kein Objekt';
  const r = roh as Record<string, unknown>;
  const name = String(r.name ?? '').trim();
  const ssh = String(r.ssh ?? name).trim();
  if (!NAME_RE.test(name)) return `unzulaessiger Name '${name}'`;
  if (!SSH_RE.test(ssh)) return `unzulaessiger SSH-Alias '${ssh}' bei '${name}'`;
  const projekte = Array.isArray(r.projekte) ? r.projekte.map(String).filter(Boolean) : [];
  return { name, ssh, projekte };
}

/**
 * Die Quellen dieses Programms. `AWB_GAST_SOURCES` schlaegt das Profil:
 * entweder JSON (`[{"name":"peer","ssh":"peer"}]`) oder kurz `peer` bzw.
 * `peer=peer-gast`, mehrere mit Komma. Sonst `AWB_GAST_PROFILE`: ein
 * Werkbank-Profil mit `remoteSessionSources`, davon nur `art: wb-gast-tor`.
 * OHNE BEIDES KEINE QUELLE -- wie bei den Fernmaschinen springt kein Netzzugriff
 * von selbst an (config.ts, `remoteMachines`).
 */
export function gastQuellenAus(env: NodeJS.ProcessEnv): { quellen: GastQuelle[]; fehler: string[] } {
  const fehler: string[] = [];
  let roh: unknown[] = [];
  const direkt = (env.AWB_GAST_SOURCES ?? '').trim();
  if (direkt) {
    if (direkt.startsWith('[')) {
      try {
        const j = JSON.parse(direkt) as unknown;
        roh = Array.isArray(j) ? j : [];
      } catch (e) {
        fehler.push(`AWB_GAST_SOURCES ist kein JSON: ${(e as Error).message}`);
      }
    } else {
      roh = direkt.split(',').map((t) => t.trim()).filter(Boolean).map((t) => {
        const [name, ssh] = t.split('=');
        return { name, ssh: ssh ?? name };
      });
    }
  } else if (env.AWB_GAST_PROFILE) {
    try {
      const profil = JSON.parse(readFileSync(env.AWB_GAST_PROFILE, 'utf8')) as Record<string, unknown>;
      const liste = Array.isArray(profil.remoteSessionSources) ? profil.remoteSessionSources : [];
      roh = liste.filter((q) => (q as Record<string, unknown>)?.art === 'wb-gast-tor');
    } catch (e) {
      fehler.push(`Profil ${env.AWB_GAST_PROFILE} nicht lesbar: ${(e as Error).message}`);
    }
  }
  const quellen: GastQuelle[] = [];
  for (const r of roh) {
    const q = quelleAus(r);
    if (typeof q === 'string') fehler.push(q);
    else if (!quellen.some((x) => x.name === q.name)) quellen.push(q);
  }
  return { quellen, fehler };
}

/** Ein Wort fuer die Befehlszeile des Tors, das `shlex.split` drueben unveraendert zurueckgibt. */
export function torWort(wert: string): string {
  return /^[A-Za-z0-9_.:=+%@/-]+$/.test(wert) ? wert : `'${wert.replace(/'/g, `'\\''`)}'`;
}

const SSH_OPTIONEN = ['-o', 'ConnectTimeout=4', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];

/**
 * Die ganze argv fuer einen Tor-Befehl. `terminal` fuer `anhaengen`: dann mit
 * `-t` und einem Lebenszeichen, damit eine abgerissene Leitung als Ende des
 * Terminals ankommt statt als stehendes Bild.
 */
export function gastArgv(q: GastQuelle, teile: string[], opt: { terminal?: boolean; sshBin?: string } = {}): string[] {
  return [
    opt.sshBin || 'ssh',
    ...(opt.terminal ? ['-t', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3'] : []),
    ...SSH_OPTIONEN,
    q.ssh,
    teile.map(torWort).join(' '),
  ];
}

const HARNESSE = ['claude', 'codex', 'opencode', 'goose', 'pi'];

/** Welcher Harness im Pane laeuft, soweit der Programmname es sagt. Claude meldet oft nur seine Fassung. */
export function harnessAus(programm: string): string {
  const p = programm.toLowerCase();
  return HARNESSE.find((h) => p === h || p.startsWith(`${h}-`) || p.startsWith(`${h}.`)) ?? 'claude';
}

/** Der Anzeigename: der tmux-Name ohne `wb-`, eigene Sitzungen des Gastes gekennzeichnet. */
function anzeigename(sitzung: string, eigene: boolean): string {
  const kurz = sitzung.replace(/^wb-/, '');
  return eigene ? `${kurz} (eigene)` : kurz;
}

/**
 * `liste --json` des Tors -> RemoteSnapshot. Das Tor fuehrt nur LEBENDE
 * Sitzungen; eine beendete verschwindet aus der Liste, statt als gestoppt
 * stehenzubleiben -- Zustandsdateien liest das Tor bewusst nicht mit.
 * Wirft bei einer Antwort, die kein Tor-JSON ist: der Poller zaehlt das als
 * Fehlversuch (remote.ts, `fehlschlag`).
 */
export function parseGastListe(machine: string, raw: string): RemoteSnapshot {
  const j = JSON.parse(raw) as Record<string, unknown>;
  if (!j || !Array.isArray(j.sitzungen)) throw new Error('Antwort des Tors ohne "sitzungen"');
  const sessionFiles: RemoteSessionRaw[] = [];
  const lebende = new Map<string, boolean>();
  const eigene = new Map<string, boolean>();
  const panes: PaneRow[] = [];
  for (const s of j.sitzungen as Record<string, unknown>[]) {
    const sitzung = String(s?.sitzung ?? '');
    if (!sitzung) continue;
    const gast = s.gast === true;
    const rohPanes = Array.isArray(s.panes) ? (s.panes as Record<string, unknown>[]) : [];
    let index = 0;
    for (const p of rohPanes) {
      const paneId = String(p?.pane ?? '');
      if (!/^%[0-9]+$/.test(paneId)) continue;
      const fenster = Number(p.fenster ?? 0) || 0;
      panes.push({
        session: sitzung,
        windowId: `@${fenster}`,
        windowIndex: fenster,
        paneId,
        paneIndex: index++,
        role: String(p.rolle ?? ''),
        worker: '',
        pid: 0,
        command: String(p.programm ?? ''),
        title: String(p.titel ?? ''),
        dead: p.tot === true,
      });
    }
    const hier = panes.filter((p) => p.session === sitzung);
    const orchestrator = hier.find((p) => p.role === 'orchestrator') ?? hier[0];
    const schluessel = sitzung.split('-').pop() ?? '';
    const erstellt = Number(s.erstellt ?? 0);
    sessionFiles.push({
      fileBase: sitzung,
      dir: String(s.ordner ?? ''),
      tmuxSession: sitzung,
      name: anzeigename(sitzung, gast),
      sessionKey: /^[0-9a-f]{6}$/.test(schluessel) ? schluessel : '',
      claudeSessionId: '',
      lastActive: erstellt > 0 ? new Date(erstellt * 1000).toISOString() : '',
      harness: harnessAus(orchestrator?.command ?? ''),
      model: '',
      workers: [],
    });
    lebende.set(sitzung, true);
    eigene.set(sitzung, false);
  }
  return {
    machine,
    reachable: true,
    fetchedAt: Date.now(),
    error: '',
    formatFehler: '',
    sessionFiles,
    lebende,
    eigene,
    panes,
    procTable: new Map(),
    testsuiteRaw: '',
    hygieneRaw: '',
    repoRaw: '',
    absturzRaw: '',
    gast: {
      person: String(j.person ?? ''),
      projekte: Array.isArray(j.projekte) ? (j.projekte as unknown[]).map(String) : [],
    },
  };
}

/** Eigene Sitzung des Gastes? Nur die darf er schliessen (das Tor prueft es ohnehin). */
export function istEigeneGastSitzung(snap: RemoteSnapshot | undefined, sitzung: string): boolean {
  return !!snap && snap.sessionFiles.some((f) => f.tmuxSession === sitzung && f.name.endsWith(' (eigene)'));
}

export interface GastVorschauPane {
  pane: string;
  breite: number;
  hoehe: number;
  text: string;
}

/** `vorschau <sitzung> --json` -> je Pane Groesse und Text. Wirft bei fremdem Format. */
export function parseGastVorschau(raw: string): GastVorschauPane[] {
  const j = JSON.parse(raw) as Record<string, unknown>;
  if (!j || !Array.isArray(j.panes)) throw new Error('Antwort des Tors ohne "panes"');
  return (j.panes as Record<string, unknown>[])
    .filter((p) => /^%[0-9]+$/.test(String(p?.pane ?? '')))
    .map((p) => ({
      pane: String(p.pane),
      breite: Math.max(1, Math.min(1000, Number(p.breite) || 80)),
      hoehe: Math.max(1, Math.min(500, Number(p.hoehe) || 24)),
      text: String(p.text ?? ''),
    }));
}

// Dieselbe Klasse wie im Tor (VORSCHAU_STEUERZEICHEN): alles unter 0x20 ausser
// Tabulator und Zeilenumbruch, DEL, C1. Hier noch einmal, weil ein Tor aelterer
// oder fremder Fassung am anderen Ende stehen kann -- gezeichnet wird in ein
// Terminal, und dort waere eine Folge ein Befehl.
const STEUERZEICHEN = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** Text einer Vorschau -> Inhalt fuer eine Kachel: Schirm loeschen, dann Zeile fuer Zeile. */
export function vorschauInhalt(text: string): string {
  return '\x1b[H\x1b[2J' + text.replace(STEUERZEICHEN, '').split('\n').join('\r\n');
}
