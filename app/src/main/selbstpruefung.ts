// STARTSPERRE DES DESKTOP-KERNS AUF LINUX (16.10.2026, Entwurf B1 aus wz-m2eng,
// Freigabe WorkbenchOrchestrator; docs/AGENTS-RECHTE.md, "Oberflaeche als Ahne").
//
// shell/wb-mensch nimmt auf peer einen Klick als menschlich, wenn er aus dem
// Kern-Electron unter `systemd --user` kommt (M2). Unter Electron 42 ist
// /proc/X/environ des Kerns ganz NUL, die Umgebung also von aussen nicht mehr
// pruefbar. Deshalb prueft der Kern sie selbst, bevor er irgendetwas anlegt:
// Startet er als Desktop-Kern (shell/linux/agent-workbench) mit einer Umgebung
// ausserhalb der Positivliste, endet er. Ein laufender Kern, der M2 besteht,
// hat diese Pruefung also bestanden. Kern-JS ist benutzerschreibbar; die Sperre
// ist Tiefenverteidigung, keine Grenze gegen denselben Benutzer.
//
// Dev-Start (node_modules/.bin/electron, wb-dev), Testkerne und der Mac sind
// nicht betroffen: Die Sperre greift nur auf Linux, nur fuer genau das
// Kern-Electron dieses App-Ordners und nur mit den Argumenten `. --show`.
//
// Einen Abschalter ueber eine Umgebungsvariable gibt es bewusst nicht: er waere
// selbst eine Variable, die ein Angreifer setzt. Rueckweg ist ein Revert.
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

// DIESELBE LISTE STEHT IN shell/wb-mensch (M2_UMGEBUNG_LINUX). Wer eine aendert,
// aendert beide; shell/tests/test-app-selbstpruefung.sh vergleicht sie und wird
// rot, wenn sie auseinanderlaufen.
export const M2_UMGEBUNG_LINUX = [
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'XDG_SESSION_DESKTOP',
  'XDG_CURRENT_DESKTOP', 'XDG_SESSION_ID', 'XDG_SEAT', 'DESKTOP_SESSION', 'DBUS_SESSION_BUS_ADDRESS',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_NUMERIC', 'LC_TIME', 'LC_COLLATE', 'LC_MONETARY',
  'SSH_AUTH_SOCK',
] as const;

// Setzt shell/linux/agent-workbench selbst (HOME aus der Benutzerdatenbank, PATH fest).
export const UMGEBUNG_FEST = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH'] as const;

// Ergaenzt Electron 42 selbst im Hauptprozess (gemessen auf peer 16.10., Kern-Electron
// 42.11.10 unter systemd-run --user und env -i): CHROME_DESKTOP vor `ready`,
// FC_FONTATIONS, GDK_BACKEND und NO_AT_BRIDGE bis `ready`. Alle vier sind erlaubt,
// damit die Sperre nicht davon abhaengt, wann sie laeuft.
//
// NODE_OPTIONS und NODE_EXTRA_CA_CERTS sieht process.env NIE: Electron entfernt
// beide beim Start, weil die Fuse EnableNodeOptionsEnvironmentVariable aus ist
// (app/tools/kern-electron.mjs; gemessen 16.10., auch mit nicht leerem Wert).
// Gegen sie wirkt allein die Fuse, nicht diese Pruefung.
export const ELECTRON_ZUSAETZE = ['CHROME_DESKTOP', 'FC_FONTATIONS', 'GDK_BACKEND', 'NO_AT_BRIDGE'] as const;

export const PFAD_FEST = '/usr/local/bin:/usr/bin:/bin';

export interface StartLage {
  platform: string;
  execPath: string;
  argv: readonly string[];       // process.argv
  appOrdner: string;             // app.getAppPath()
  env: Record<string, string | undefined>;
  heim: string;                  // os.userInfo().homedir (Benutzerdatenbank)
  realpath?: (p: string) => string;
}

export type StartUrteil =
  | { greift: false; grund: string }
  | { greift: true; ok: true }
  | { greift: true; ok: false; abweichungen: string[] };

function echt(rp: (p: string) => string, p: string): string | null {
  try { return rp(p); } catch { return null; }
}

// Reine Funktion: entscheidet ohne Electron, ob die Sperre greift und ob die
// Umgebung besteht. Abweichungen nennen nur Schluesselnamen, nie Werte.
export function startUmgebungPruefen(lage: StartLage): StartUrteil {
  if (lage.platform !== 'linux') return { greift: false, grund: 'nicht Linux' };
  const rp = lage.realpath ?? ((p: string) => realpathSync(p));
  const kern = echt(rp, join(lage.appOrdner, 'kern-electron', 'electron'));
  const selbst = echt(rp, lage.execPath);
  if (!kern || !selbst || kern !== selbst) return { greift: false, grund: 'nicht das Kern-Electron dieses App-Ordners' };
  const args = lage.argv.slice(1).join(' ');
  if (args !== '. --show' && args !== '--show .') return { greift: false, grund: 'nicht der Desktop-Start (. --show)' };

  const erlaubt = new Set<string>([...UMGEBUNG_FEST, ...M2_UMGEBUNG_LINUX, ...ELECTRON_ZUSAETZE]);
  const abweichungen: string[] = [];
  for (const name of Object.keys(lage.env).sort()) {
    if (!erlaubt.has(name)) abweichungen.push(`${name} ist gesetzt`);
  }
  if (lage.env.HOME !== lage.heim) abweichungen.push('HOME weicht ab');
  if (lage.env.PATH !== PFAD_FEST) abweichungen.push('PATH weicht ab');
  return abweichungen.length ? { greift: true, ok: false, abweichungen } : { greift: true, ok: true };
}

interface SperrApp { getAppPath(): string; exit(code?: number): void }
interface SperrDialog { showErrorBox(titel: string, inhalt: string): void }

// Ganz am Anfang von main.ts: vor Steuersocket, Fenster und jedem Zustand.
export function startsperre(app: SperrApp, dialog: SperrDialog, heim: string): void {
  const urteil = startUmgebungPruefen({
    platform: process.platform, execPath: process.execPath, argv: process.argv,
    appOrdner: app.getAppPath(), env: process.env, heim,
  });
  if (!urteil.greift || urteil.ok) return;
  process.stderr.write(`Agent Workbench: Startsperre, Umgebung ausserhalb der Positivliste: ${urteil.abweichungen.join(', ')}\n`);
  try {
    dialog.showErrorBox('Agent Workbench startet nicht',
      'Die Werkbank wurde mit einer fremden Umgebung gestartet und beendet sich; Grund im Journal.');
  } catch { /* ohne Anzeige reicht die Zeile im Journal */ }
  app.exit(1);
  // Nicht darauf bauen, dass app.exit den laufenden Code sofort anhaelt: process.exit
  // endet synchron, bevor main.ts weiterlaeuft und den Steuersocket anlegt.
  process.exit(1);
}
