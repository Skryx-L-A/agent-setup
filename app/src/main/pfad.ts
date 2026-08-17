// Was einem aus dem Finder gestarteten Programm an Umgebung fehlt: der PATH,
// mit dem es seine Werkzeuge sucht, und die Sprachumgebung, in der es sie
// versteht.
//
// DER BEFUND VOM 07.08. alice startet das Programm per Doppelklick auf
// `/Applications/Agent Workbench.app`. Eine so gestartete Anwendung bekommt
// ihre Umgebung von launchd, nicht von einer Shell, und launchd gibt ihr den
// Vorgabewert `/usr/bin:/bin:/usr/sbin:/sbin` (`launchctl getenv PATH` ist
// leer, also gilt genau dieser). Gemessen an einem GUI-gestarteten
// Electron-Prozess dieser Maschine (Elternprozess launchd):
//
//   PATH=/usr/bin:/bin:/usr/sbin:/sbin
//   SHELL=/bin/zsh
//
// In diesem PATH liegt weder `tmux` noch eines der `wb-*`-Werkzeuge. Zwei
// Symptome mit dieser einen Ursache: `spawnSync('tmux', …)` scheiterte mit
// ENOENT, die Sessionliste blieb leer und JEDE Sitzung stand auf „beendet";
// und das Fortsetzen einer Sitzung endete in `Uncaught Exception: Error:
// spawn wb-code ENOENT`.
//
// DER WEG: DIE ANMELDE-SHELL FRAGEN. Dieselbe Umgebung, die auch ein Terminal
// bekaeme -- gefragt wird sie einmal beim Start, das Ergebnis wird an den
// geerbten PATH ANGEHAENGT.
//
// Warum nicht eine Liste bekannter Orte im Quelltext: `/opt/homebrew/bin` gilt
// nur fuer Homebrew auf Apple Silicon, auf einem Intel-Mac liegt es unter
// `/usr/local`, und auf Peer (Linux, `/home/alice`) sieht wieder alles
// anders aus. Dieselben Skripte laufen auf beiden Maschinen; ein fester Pfad
// waere auf einer davon falsch. Die Anmelde-Shell kennt die richtige Antwort
// fuer die Maschine, auf der sie laeuft -- sie ist DIE Quelle, die der Mensch
// selbst gepflegt hat.
//
// Gemessen auf dieser Maschine, in genau der Umgebung des Finder-Starts
// (`env -i HOME=… PATH=/usr/bin:/bin:/usr/sbin:/sbin`): der Aufruf braucht
// 18 ms und liefert `/Users/alice/.local/bin:/opt/homebrew/bin:…` -- beide
// Orte, die gefehlt haben.
//
// ANGEHAENGT, NIE VORANGESTELLT. Der geerbte PATH behaelt seine Reihenfolge
// und bleibt vorn; die Anmelde-Shell steuert nur bei, was noch fehlt. Das ist
// keine Kosmetik: die Testsuiten stellen einen eigenen Ordner mit
// Stellvertretern (tmux auf einem Testsocket, ein wb-code, das nichts startet)
// VOR den PATH. Wuerde die Anmelde-Shell davorgeschoben, griffe ein Test
// ploetzlich zum ECHTEN tmux -- und damit an laufende des Nutzers Sitzungen.
//
// DER ZWEITE BEFUND: DIE SPRACHUMGEBUNG (gemessen am 07.08. beim Bau dieser
// Datei, nicht vorher bekannt). launchd gibt einer GUI-Anwendung WEDER `LANG`
// NOCH `LC_ALL` oder `LC_CTYPE` -- gemessen am selben GUI-Prozess wie oben:
// keine dieser drei Variablen ist gesetzt. Ohne UTF-8-Locale ersetzt tmux in
// seiner `-F`-Ausgabe den TABULATOR durch einen Unterstrich:
//
//   env -i PATH=…                 tmux … -F '#{session_name}\t#{@awb_owner}'
//                                   ->  l e b t - x _ \n
//   env -i PATH=… LANG=C.UTF-8    dasselbe Kommando
//                                   ->  l e b t - x \t \n
//
// Der Tabulator ist genau das Trennzeichen von SESSION_LIST_FORMAT und
// PANE_LIST_FORMAT (sessions.ts). Ohne ihn faellt `parseSessionList` auf einen
// einzigen Namen mit angehaengtem Unterstrich zurueck, `lebende.has(name)` ist
// fuer JEDE Sitzung falsch -- und die Oberflaeche sagt wieder „beendet".
// DASSELBE SYMPTOM, ZWEITE URSACHE, unabhaengig von der ersten: ein PATH-Fix
// allein haette alice dieselbe leere Leiste hinterlassen.
//
// Deshalb wird auch die Sprachumgebung hergerichtet -- aber nur, wenn KEINE
// der drei Variablen gesetzt ist. Wer eine gesetzt hat, hat sie gemeint.
//
// UND DESHALB REICHT DAS NICHT (Befund der Pruefung, 07.08.). Ist eine der drei
// Variablen gesetzt, aber ohne UTF-8 -- `LANG=de_DE` ohne `.UTF-8` schreibt
// sich jemand versehentlich ins Anmeldeprofil, `LC_ALL=C` steht in manchem
// Skript --, dann bleibt sie stehen, und der Fehler ist zurueck. Und zwar
// STILL: tmux ist ausfuehrbar, es gibt keinen Fehlersatz, die Sitzung landet
// auf 'stopped' statt 'unreachable', und der Fortsetzen-Knopf steht offen.
//
// Die Auskunft, die eine gesetzte Locale gibt, gilt fuer Text, den ein Mensch
// liest, und fuer Sortierung. Sie gilt NICHT fuer das Trennzeichen, mit dem
// dieses Programm seine eigene tmux-Abfrage zerlegt: das ist ein Datenformat.
// Also bekommt jeder tmux-Aufruf, dessen Ausgabe hier zerlegt wird, seine
// Kodierung MITGEGEBEN (`MASCHINEN_LOCALE` unten), und die Umgebung des
// Programms bleibt unangetastet. Selbst gemessen, gegen einen eigenen
// tmux-Socket, `list-sessions -F '#{session_name}\t#{@awb_owner}'`:
//
//   (keine Variable)                    ->  w b - T e s t _  \n
//   LC_ALL=C.UTF-8                      ->  w b - T e s t \t \n
//   LC_CTYPE=UTF-8                      ->  w b - T e s t \t \n
//   LC_ALL=C  LC_CTYPE=UTF-8            ->  w b - T e s t _  \n
//   LANG=de_DE                          ->  w b - T e s t _  \n
//   LC_ALL=C                            ->  w b - T e s t _  \n
//   LANG=de_DE LC_ALL=C.UTF-8 LC_CTYPE=UTF-8
//                                       ->  w b - T e s t \t \n
//
// Die vierte Zeile ist der Grund, warum `LC_ALL` mitgesetzt wird und nicht nur
// `LC_CTYPE`: LC_ALL ueberstimmt LC_CTYPE, und ein geerbtes `LC_ALL=C` haette
// die Ergaenzung sonst wirkungslos gemacht.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Die Marke, an der die Zeilen aus der Ausgabe der Anmelde-Shell erkannt
 * werden. Ein Anmeldeprofil darf schreiben, was es will (Begruessungen,
 * Versionshinweise, Warnungen); gelesen werden nur die Zeilen mit dieser
 * Marke, und je Variable die letzte.
 */
const MARKE = '__AWB_UMGEBUNG__';

/** Die drei Variablen, an denen die Sprachumgebung haengt -- in der Rangfolge von POSIX. */
const LOCALE_VARIABLEN = ['LC_ALL', 'LC_CTYPE', 'LANG'] as const;

/**
 * Was gesetzt wird, wenn weder das Programm noch die Anmelde-Shell eine
 * UTF-8-Sprachumgebung nennt. `LC_CTYPE=UTF-8` ist genau der Wert, den auch
 * Terminal.app setzt; er verlangt keine installierte Locale-Datei und wirkt
 * auf macOS wie auf Linux (gemessen: tmux gibt den Tabulator damit wieder aus).
 */
const NOTLOCALE = { name: 'LC_CTYPE', wert: 'UTF-8' };

/** Wie lange auf die Anmelde-Shell gewartet wird, bevor der Start ohne sie weitergeht. */
export const ANMELDESHELL_ZEITLIMIT_MS = 5000;

export interface PfadBefund {
  /** Der PATH, mit dem dieses Programm ab jetzt Kindprozesse startet. */
  pfad: string;
  /** Die Shell, die gefragt wurde -- leer, wenn keine gefragt wurde. */
  shell: string;
  /** Was dem geerbten PATH NEU hinzugefuegt wurde, in der Reihenfolge des Anhaengens. */
  dazu: string[];
  /**
   * Die Sprachumgebung, die jetzt gilt, als `NAME=wert` -- leer, wenn schon
   * eine gesetzt war und nichts zu tun blieb.
   */
  locale: string;
  /**
   * Warum die Anmelde-Shell nichts beigesteuert hat -- leer, wenn sie geantwortet
   * hat. Der Start geht in jedem Fall weiter: ein PATH ohne Ergaenzung ist
   * schlechter als einer mit, aber immer noch besser als kein Fenster.
   */
  fehler: string;
}

function zerlegen(pfad: string): string[] {
  return pfad.split(':').filter(Boolean);
}

/**
 * Die Shell, die gefragt wird. `SHELL` steht auch in der Umgebung einer aus dem
 * Finder gestarteten Anwendung (gemessen, siehe Kopf). Fehlt sie doch einmal,
 * gilt `/bin/sh`: von POSIX garantiert, auf beiden Maschinen vorhanden und --
 * anders als ein geratenes `/bin/zsh` -- keine Annahme ueber die Vorliebe des
 * Menschen an dieser Maschine.
 */
function anmeldeShell(env: NodeJS.ProcessEnv): string {
  const s = (env.SHELL ?? '').trim();
  return s.startsWith('/') ? s : '/bin/sh';
}

/**
 * Die Umgebung der Anmelde-Shell holen -- PATH UND Sprachumgebung in EINEM
 * Aufruf. Zwei Aufrufe waeren zwei Anmeldeprofile, und ein Profil darf teuer
 * sein; gemessen kostet dieser eine 18 ms.
 *
 * `-lc` und nicht `-ilc`: eine INTERAKTIVE Shell liest zusaetzlich `.zshrc`,
 * kann aber auf eine Eingabeaufforderung warten und damit den Programmstart
 * anhalten. Gemessen auf dieser Maschine reicht die Anmelde-Shell -- sie
 * liefert `~/.local/bin`, Homebrew und `LANG=C.UTF-8`. Wer seinen PATH
 * ausschliesslich in `.zshrc` setzt, bekommt ihn hier nicht; dann bleibt der
 * geerbte PATH stehen, und `pfadHerrichten` sagt in seiner Zeile, was es
 * gefunden hat.
 */
export function anmeldeShellUmgebung(
  env: NodeJS.ProcessEnv = process.env,
  zeitlimitMs = ANMELDESHELL_ZEITLIMIT_MS,
): { werte: Record<string, string>; shell: string; fehler: string } {
  const shell = anmeldeShell(env);
  if (!existsSync(shell)) {
    return { werte: {}, shell, fehler: `die Anmelde-Shell '${shell}' gibt es nicht` };
  }
  // `${LANG-}` statt `$LANG`: unter `set -u` in einem fremden Anmeldeprofil
  // waere eine ungesetzte Variable sonst ein Abbruch.
  const befehl = `printf '${MARKE}%s\\n' "PATH=$PATH" "LC_ALL=\${LC_ALL-}" "LC_CTYPE=\${LC_CTYPE-}" "LANG=\${LANG-}"`;
  const r = spawnSync(shell, ['-lc', befehl], { encoding: 'utf8', timeout: zeitlimitMs, env });
  if (r.error) {
    return { werte: {}, shell, fehler: `'${shell} -lc' liess sich nicht ausfuehren: ${r.error.message}` };
  }
  // Der Exitcode wird ABSICHTLICH nicht geprueft: ein Anmeldeprofil, dessen
  // letzter Befehl fehlschlaegt, faerbt ihn rot, obwohl der PATH laengst steht.
  // Massgeblich ist, ob die Marke da ist.
  const werte: Record<string, string> = {};
  for (const zeile of (r.stdout ?? '').split('\n')) {
    if (!zeile.startsWith(MARKE)) continue;
    const rest = zeile.slice(MARKE.length);
    const gleich = rest.indexOf('=');
    if (gleich <= 0) continue;
    werte[rest.slice(0, gleich)] = rest.slice(gleich + 1).trim();
  }
  if (!werte.PATH) {
    const stderr = (r.stderr ?? '').trim().split('\n').slice(-1)[0] ?? '';
    return { werte: {}, shell, fehler: `'${shell} -lc' nannte keinen PATH${stderr ? ` (${stderr})` : ''}` };
  }
  return { werte, shell, fehler: '' };
}

/** Nennt dieser Locale-Wert eine UTF-8-Zeichenkodierung? */
function istUtf8(wert: string): boolean {
  return /utf-?8/i.test(wert);
}

/**
 * Die Sprachumgebung herrichten, falls KEINE gesetzt ist. Gibt zurueck, was
 * gesetzt wurde (`NAME=wert`), oder eine leere Zeichenkette, wenn nichts zu tun
 * war -- eine vom Menschen gesetzte Locale wird nie ueberschrieben, auch keine
 * ohne UTF-8: sie ist dann seine Entscheidung, nicht unsere Luecke.
 */
export function spracheHerrichten(env: NodeJS.ProcessEnv, ausShell: Record<string, string>): string {
  if (LOCALE_VARIABLEN.some((v) => (env[v] ?? '').trim() !== '')) return '';
  for (const v of LOCALE_VARIABLEN) {
    const wert = (ausShell[v] ?? '').trim();
    if (wert && istUtf8(wert)) {
      env[v] = wert;
      return `${v}=${wert}`;
    }
  }
  env[NOTLOCALE.name] = NOTLOCALE.wert;
  return `${NOTLOCALE.name}=${NOTLOCALE.wert}`;
}

/**
 * Orte unter dem HEIMATVERZEICHNIS, die dazukommen, falls es sie gibt. Sie
 * stehen hier als letzte Sicherung fuer den Fall, dass die Anmelde-Shell
 * ausfaellt -- `~/.local/bin` ist der Ort, an dem in diesem Haus jedes
 * `wb-*`-Werkzeug liegt, auf dem Mac wie auf Peer.
 *
 * `homedir()` statt eines geschriebenen Pfades: `/Users/alice` gaebe es auf
 * Peer nicht, und ein Paket, das an einem Benutzernamen haengt, laeuft nur bei
 * genau einem Menschen.
 */
function heimatOrte(env: NodeJS.ProcessEnv): string[] {
  const heim = env.HOME ?? homedir();
  return [join(heim, '.local', 'bin'), join(heim, 'bin')].filter((p) => existsSync(p));
}

/**
 * Die Zusammenfuehrung, ohne Nebenwirkung -- damit sie sich einzeln pruefen
 * laesst. Der geerbte PATH bleibt vorn und behaelt seine Reihenfolge; alles
 * andere kommt hinten dran, jeder Ort hoechstens einmal.
 */
export function pfadZusammenfuehren(geerbt: string[], ...weitere: string[][]): { pfad: string; dazu: string[] } {
  const gesehen = new Set<string>();
  const raus: string[] = [];
  const dazu: string[] = [];
  for (const p of geerbt) {
    if (gesehen.has(p)) continue;
    gesehen.add(p);
    raus.push(p);
  }
  for (const liste of weitere) {
    for (const p of liste) {
      if (gesehen.has(p)) continue;
      gesehen.add(p);
      raus.push(p);
      dazu.push(p);
    }
  }
  return { pfad: raus.join(':'), dazu };
}

/**
 * DER EINE AUFRUF BEIM START. Er setzt `env.PATH` und, falls noetig, die
 * Sprachumgebung, und gibt zurueck, was er getan hat -- main.ts schreibt das
 * in sein Protokoll, damit im Fehlerfall nachlesbar ist, womit das Programm
 * gesucht hat.
 *
 * Der Testhaken `AWB_PFAD_ANMELDESHELL=0` laesst die Anmelde-Shell aus. Damit
 * laesst sich der Zustand VOR dieser Aenderung nachstellen, ohne das Programm
 * dafuer zurueckzubauen. Die Notlocale wird trotzdem gesetzt: sie haengt nicht
 * an der Shell, und ohne sie waere die Nachstellung eine andere Baustelle.
 */
export function pfadHerrichten(env: NodeJS.ProcessEnv = process.env): PfadBefund {
  const geerbt = zerlegen(env.PATH ?? '');
  const ohneShell = env.AWB_PFAD_ANMELDESHELL === '0';
  const shellBefund = ohneShell
    ? { werte: {} as Record<string, string>, shell: '', fehler: 'per AWB_PFAD_ANMELDESHELL=0 abgeschaltet' }
    : anmeldeShellUmgebung(env);
  const ausShell = shellBefund.werte.PATH ? zerlegen(shellBefund.werte.PATH) : [];
  const { pfad, dazu } = pfadZusammenfuehren(geerbt, ausShell, heimatOrte(env));
  env.PATH = pfad;
  const locale = spracheHerrichten(env, shellBefund.werte);
  return { pfad, shell: shellBefund.shell, dazu, locale, fehler: shellBefund.fehler };
}

/**
 * DIE KODIERUNG FUER EINEN MASCHINENLESBAREN AUFRUF (07.08.).
 *
 * Sie gilt fuer jeden Aufruf, dessen Ausgabe dieses Programm an einem
 * Trennzeichen zerlegt -- nicht fuer die Sprache des Menschen. Warum beide
 * Variablen gesetzt werden und was gemessen wurde, steht im Kopf dieser Datei.
 *
 * `C.UTF-8` fuer LC_ALL und `UTF-8` fuer LC_CTYPE: beides verlangt keine
 * installierte Locale-Datei, `LC_CTYPE=UTF-8` ist derselbe Wert, den auch
 * Terminal.app setzt, und beide wirken auf macOS wie auf Linux.
 */
export const MASCHINEN_LOCALE: Readonly<Record<string, string>> = {
  LC_ALL: 'C.UTF-8',
  LC_CTYPE: 'UTF-8',
};

/**
 * Die Umgebung fuer einen solchen Aufruf: alles wie gehabt, nur die Kodierung
 * gesetzt. Die Umgebung DIESES Prozesses wird dabei nicht angefasst.
 */
export function mitMaschinenLocale(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, ...MASCHINEN_LOCALE };
}

/**
 * Dasselbe als Praefix fuer eine SHELL-Zeile -- gebraucht fuer den Fernabruf
 * (remote.ts), der sein tmux nicht selbst spawnt, sondern in ein Skript
 * schreibt, das ueber SSH auf der anderen Maschine laeuft. Dort gilt die
 * Umgebung der SSH-Sitzung, nicht unsere.
 */
export const MASCHINEN_LOCALE_PREFIX = Object.entries(MASCHINEN_LOCALE)
  .map(([k, v]) => `${k}=${v}`)
  .join(' ');

/**
 * Einfaches POSIX-Quoting fuer ein Argument, das durch eine SHELL geht. Reicht
 * fuer Pfade, Namen und Sessionnamen -- mehr wird hier nie gequotet.
 */
export function schaleQuoten(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * DER AUFRUF EINES WERKZEUGS AUF EINER ANDEREN MASCHINE (09.08.).
 *
 * Bis heute gab es diese Zeile zweimal halb: `revive.ts` baute sie fuer
 * `wb-code` selbst zusammen, und die drei uebrigen Griffe am Kontextmenue --
 * schliessen, umbenennen, loeschen -- hatten sie gar nicht und liefen deshalb
 * OERTLICH gegen einen tmux-Namen und einen Pfad, die es hier nicht gibt.
 * Genau das war Befund des Nutzers: die Sitzung auf peer stand in der Leiste, und
 * kein Punkt des Menues tat etwas.
 *
 * DREI DINGE STECKEN IN DIESER EINEN FUNKTION, und jedes davon ist der Grund,
 * warum es sie gibt statt dreier handgebauter Zeilen:
 *
 *   1. DIE KODIERUNG REIST MIT. Drueben gilt die Umgebung der SSH-Sitzung,
 *      nicht unsere; ohne UTF-8-Zeichenklasse gibt das dortige tmux die
 *      Tabulatoren seiner Formatzeilen als Unterstrich aus, und die Werkzeuge,
 *      die diese Ausgabe zerlegen, arbeiten auf Schrott. Gemessen und im Kopf
 *      von remote.ts beschrieben; derselbe Praefix, dieselbe Begruendung.
 *   2. DIE UMGEBUNGSVARIABLEN GEHOEREN IN DIE ZEILE. `wb-session-close --force`
 *      verlangt `WB_SESSION_CLOSE_CONFIRM` mit demselben Sessionnamen. Lokal
 *      setzt `fuehreAus` das in die Umgebung des Kindprozesses -- ueber SSH
 *      kaeme davon nichts an, denn gesetzt wuerde es HIER. Also steht es vor
 *      dem Befehl, in der Zeile, die drueben laeuft.
 *   3. ES WIRD NICHT UNBEGRENZT GEWARTET. `BatchMode=yes` verbietet jede
 *      Rueckfrage nach Passwort oder Passphrase (die Antwort kaeme aus einem
 *      Fenster, das dieses Programm nicht hat), `ConnectTimeout` begrenzt den
 *      Verbindungsaufbau. Ohne beides koennte ein einziger Klick den
 *      Hauptprozess anhalten -- `fuehreAus` ruft synchron.
 *
 * Der PATH drueben braucht nichts: gemessen am 09.08. gegen peer liefert eine
 * nicht-interaktive SSH-Sitzung dort `~/.local/bin` im PATH, und alle vier
 * Werkzeuge liegen genau da (`command -v wb-session-close` ->
 * `/home/alice/.local/bin/wb-session-close`).
 *
 * DER VIERTE PARAMETER (10.08.), und warum er kein Rueckfall in zwei Fassungen
 * ist: seit heute geht auch der STEUERMODUS diesen Weg (tmux.ts), und der ist
 * kein Aufruf von Sekunden, sondern eine Verbindung, die stehenbleibt, solange
 * das Terminal gezeichnet wird. Fuer sie braucht es zwei Angaben mehr
 * (`ServerAliveInterval`, `ServerAliveCountMax`), damit eine tote Leitung
 * AUFFAELLT statt als stehendes Bild weiterzuleben -- ohne sie wartet ssh auf
 * ein TCP-Zeitlimit, das Minuten dauern kann. Alles andere -- Kodierung,
 * Umgebungsvariablen in der fernen Zeile, BatchMode, ConnectTimeout -- bleibt
 * fuer beide dasselbe, und genau deshalb steht es weiter nur hier.
 */
export function fernAufruf(
  maschine: string,
  teile: string[],
  umgebung: Record<string, string> = {},
  zusatzOptionen: string[] = [],
): string[] {
  const zeile = [
    MASCHINEN_LOCALE_PREFIX,
    ...Object.entries(umgebung).map(([k, v]) => `${k}=${schaleQuoten(v)}`),
    ...teile.map(schaleQuoten),
  ].join(' ');
  return [
    'ssh',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=6',
    ...zusatzOptionen.flatMap((o) => ['-o', o]),
    maschine,
    zeile,
  ];
}

/**
 * Findet der jetzige PATH dieses Werkzeug? Gebraucht fuer die eine Zeile im
 * Protokoll, die den Befund vom 07.08. beim naechsten Mal sofort sichtbar
 * macht -- und fuer die Pruefung.
 */
export function findetWerkzeug(name: string, env: NodeJS.ProcessEnv = process.env): string {
  for (const ordner of zerlegen(env.PATH ?? '')) {
    const kandidat = join(ordner, name);
    if (existsSync(kandidat)) return kandidat;
  }
  return '';
}
