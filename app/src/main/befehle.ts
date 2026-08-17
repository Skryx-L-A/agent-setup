// Was passiert, wenn jemand auf der uebernommenen Seite einen Knopf drueckt.
//
// Die Seiten schicken `vscode.postMessage({command: …})`. In der Extension
// hingen diese Befehle an deren Kommandopalette; hier gibt es die Empfaenger
// erst seit dieser Datei. Verdrahtet wird gegen die VORHANDENEN Werkzeuge --
// `wb-code`, `wb-session-delete`, `wb-state settings set` --, nie gegen eine
// zweite, eigene Fassung derselben Handlung.
//
// DREI REGELN, die hier ueber allem stehen:
//
//   1. WO EIN BEFEHL KEINE ENTSPRECHUNG HAT, WIRD ER NICHT VERDRAHTET. Ein
//      Knopf, der etwas Falsches tut, ist schlimmer als einer, der sichtbar
//      nichts tut. Was offen bleibt, sagt es beim Druecken und steht im
//      Ergebnis.
//   2. ALLES MIT NEBENWIRKUNG WIRD VORHER GEZEIGT. `plane()` beschreibt, was
//      geschehen WIRD, und fuehrt nichts aus; erst ein zweiter, ausdruecklicher
//      Aufruf mit derselben Beschreibung fuehrt sie aus. Ein Fehlklick loest
//      damit nichts Unwiderrufliches aus.
//   3. EINE LAUFENDE SESSION WIRD NIE ANGEFASST. Weder beim Anlegen noch beim
//      Loeschen. Laeuft sie, wird der Plan abgelehnt, mit Grund.
//
// UND: Von hier aus wird NIE ein Worker gespawnt. Der Orchestrator entscheidet
// und spawnt, nichts anderes -- keiner der Befehle der Seiten tut es, und es
// kommt hier auch keiner dazu.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fernAufruf, mitMaschinenLocale } from './pfad';

export interface BefehlsUmgebung {
  sessionsDir: string;
  settingsFile: string;
  tmuxSocket: string;
  /** Aufrufe, ueberschreibbar fuer Tests -- im Betrieb die Namen aus dem PATH. */
  wbCodeBin: string;
  wbSessionDeleteBin: string;
  /**
   * `wb-session-close`. Eine tmux-Session wird NIE mit `tmux kill-session`
   * beendet: der Guard blockt rohe Kill-Muster (ein zu breites hat schon
   * zweimal laufenden des Nutzers Client getroffen), und die Pruefungen des
   * Werkzeugs -- haengt ein Client dran, laeuft ein Worker, ist es die eigene
   * Session -- sind genau der Grund, warum es das gibt.
   */
  wbSessionCloseBin: string;
  wbStateBin: string;
  /**
   * Kennung DIESER Maschine. Sie entscheidet, ob ein Griff hier laeuft oder
   * ueber SSH auf der Zielmaschine -- ohne sie liefe jeder Griff an einer
   * Fernsitzung gegen einen tmux-Namen und einen Pfad, die es hier nicht gibt
   * (09.08.; die drei Faelle stehen unten je bei ihrem `fern`).
   */
  machine: string;
}

/**
 * Was ein Knopf auslösen WILL, bevor es geschieht. `art` sagt, wie damit
 * umzugehen ist:
 *
 *   sofort      Keine Nebenwirkung ausserhalb des Fensters (Seite wechseln,
 *               neu zeichnen) -- wird direkt getan.
 *   bestaetigen Nebenwirkung. Wird gezeigt und erst nach ausdruecklicher
 *               Zustimmung ausgefuehrt.
 *   abgelehnt   Darf nicht ausgefuehrt werden; `grund` sagt warum.
 *   offen       Kein Empfaenger vorhanden. Wird NICHT geraten.
 */
export interface Plan {
  art: 'sofort' | 'bestaetigen' | 'abgelehnt' | 'offen';
  command: string;
  /** Ein Satz, der sagt, was geschehen wird -- in der Sprache des Menschen. */
  beschreibung: string;
  /** Der Aufruf, der es tut, wortwoertlich. Steht in der Rueckfrage. */
  aufruf?: string[];
  /**
   * Was der Aufruf ZUSAETZLICH in seiner Umgebung braucht. Genau ein Fall:
   * `wb-session-close --force` verlangt neben dem Schalter noch
   * `WB_SESSION_CLOSE_CONFIRM=<session>` -- eine zweite, bewusste Angabe des
   * Namens, damit ein `--force` allein nichts schliesst. Die Variable gehoert
   * zum Aufruf und wird deshalb mit ihm geplant, nicht an der Ausfuehrung
   * vorbei gesetzt.
   */
  umgebung?: Record<string, string>;
  grund?: string;
  /** Mitgeschleppt bis zur Ausfuehrung, damit sie nichts neu erraten muss. */
  daten?: Record<string, unknown>;
}

function tmux(socket: string, args: string[]): { ok: boolean; out: string } {
  const basis = socket ? ['-L', socket] : [];
  // Kodierung mitgeben, aus demselben Grund wie in sessions.ts und tmux.ts
  // (Messung im Kopf von pfad.ts). Die Formate HIER trennen mit einem
  // Leerzeichen und waeren von der fehlenden Zeichenklasse nicht betroffen --
  // die Regel steht trotzdem an jedem Aufruf, dessen Ausgabe zerlegt wird,
  // damit sie nicht bei der naechsten Formataenderung neu erwogen werden muss.
  const r = spawnSync('tmux', [...basis, ...args], { encoding: 'utf8', env: mitMaschinenLocale() });
  return { ok: r.status === 0, out: (r.stdout || '').trim() };
}

/** Laeuft die tmux-Session dieses Namens gerade? */
function sessionLaeuft(socket: string, name: string): boolean {
  if (!name) return false;
  const r = tmux(socket, ['has-session', '-t', `=${name}`]);
  return r.ok;
}

/**
 * Wieviele Clients haengen an dieser Session ODER an einer Session ihrer
 * GRUPPE?
 *
 * DIESELBE RECHNUNG WIE IM WERKZEUG. `wb-session-close` verweigert den Dienst,
 * sobald diese Zahl groesser null ist (`group_attached()` dort), und zwar ueber
 * die ganze Gruppe: eine Basis-Session meldet selbst 0, waehrend ein Fenster an
 * ihrer '-view'-Schwester haengt. Wer die Zahl anders bildet, sagt eine andere
 * Antwort voraus als die, die dann kommt -- genau der Fehler, den das Menue am
 * 06.08. gemacht hat: „Sitzung schliessen" stand offen, und der Aufruf endete
 * planmaessig mit „an '…' haengt ein Client".
 *
 * Gezaehlt wird `#{session_attached}`, also JEDER Client -- auch der
 * Steuerclient dieses Programms, wenn es die Session gerade zeichnet. Das ist
 * kein Fehler der Zaehlung, sondern die Wahrheit ueber den Aufruf: das Werkzeug
 * sieht denselben Client und verweigert.
 */
export function gruppeAngehaengt(socket: string, name: string): number {
  if (!name) return 0;
  const r = tmux(socket, ['list-sessions', '-F', '#{session_name} #{session_group} #{session_attached}']);
  if (!r.ok) return 0;
  const zeilen = r.out.split('\n').filter(Boolean).map((z) => {
    const [n, g, a] = z.split(' ');
    return { name: n ?? '', gruppe: g ?? '', attached: Number(a) || 0 };
  });
  const eigene = zeilen.find((z) => z.name === name);
  if (!eigene) return 0;
  return zeilen
    .filter((z) => z.name === name || (eigene.gruppe !== '' && z.gruppe === eigene.gruppe))
    .reduce((summe, z) => summe + z.attached, 0);
}

export interface SessionAkte {
  datei: string;
  dir: string;
  name: string;
  tmuxSession: string;
  sessionKey: string;
  claudeSessionId: string;
}

/**
 * DIE GEMEINSAME FUNKTION FUER "FORTSETZEN" (Abstimmung mit Schritt 8).
 *
 * Sucht die Zustandsdatei zu einem Projektordner -- und, wenn angegeben, zu
 * genau einem `sessionKey` -- und gibt heraus, was zum Fortsetzen gebraucht
 * wird: Ordner, Name, tmux-Name, Schluessel und die `claudeSessionId`.
 *
 * Erwartet: `sessionsDir` (das Verzeichnis der Zustandsdateien), `dir` (der
 * Projektordner, absolut) und optional `sessionKey`. Gibt null zurueck, wenn
 * es keine passende Akte gibt -- das ist kein Fehler, sondern "gibt es nicht".
 *
 * Wer die Wiederaufnahme nach einem Absturz baut, braucht genau diese Angaben
 * und sollte diese Funktion benutzen statt die Dateien ein zweites Mal zu
 * lesen: Zwei Leser derselben Dateien sind zwei Gelegenheiten, verschieden zu
 * antworten. Sie liegt bewusst NICHT in sessions.ts -- die Datei gehoert
 * inzwischen einem anderen Bauabschnitt.
 */
export function findeSessionAkte(sessionsDir: string, dir: string, sessionKey?: string): SessionAkte | null {
  let dateien: string[] = [];
  try {
    dateien = readdirSync(sessionsDir).filter((d) => d.endsWith('.json'));
  } catch {
    return null;
  }
  for (const datei of dateien.sort()) {
    let roh: Record<string, unknown>;
    try {
      roh = JSON.parse(readFileSync(join(sessionsDir, datei), 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (String(roh.dir ?? '') !== dir) continue;
    // Der Schluessel steckt im Dateinamen hinter '__' -- ohne Angabe ist die
    // Standard-Session des Ordners gemeint, also die Datei OHNE Suffix.
    const kennung = basename(datei, '.json');
    const teil = kennung.split('__');
    const key = teil.length > 1 ? teil[teil.length - 1] : '';
    if ((sessionKey ?? '') !== key) continue;
    return {
      datei: join(sessionsDir, datei),
      dir,
      name: String(roh.name ?? ''),
      tmuxSession: String(roh.tmuxSession ?? ''),
      sessionKey: key,
      claudeSessionId: String(roh.claudeSessionId ?? ''),
    };
  }
  return null;
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function einstellung(settingsFile: string, key: string): unknown {
  try {
    const d = JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
    return d[key];
  } catch {
    return undefined;
  }
}

/**
 * Aus einer Nachricht der Seite einen Plan machen. FUEHRT NICHTS AUS.
 */
export function plane(nachricht: Record<string, unknown>, u: BefehlsUmgebung): Plan {
  const command = String(nachricht.command ?? '');
  switch (command) {
    // --- ohne Nebenwirkung ------------------------------------------------
    case 'settings':
      return { art: 'sofort', command, beschreibung: 'Die Einstellungsseite oeffnen.' };
    case 'refresh':
      return { art: 'sofort', command, beschreibung: 'Die Seite neu zeichnen.' };

    // --- Einstellungen: der EINE Schreibweg --------------------------------
    case 'set': {
      const key = String(nachricht.key ?? '');
      const wert = nachricht.value;
      if (!key) return { art: 'abgelehnt', command, beschreibung: '', grund: 'Kein Schluessel angegeben.' };
      const text = typeof wert === 'string' ? wert : JSON.stringify(wert);
      return {
        art: 'bestaetigen',
        command,
        beschreibung: `Einstellung '${key}' auf '${text}' setzen.`,
        // ueber wb-state, weil nur dieser Weg die Sperre nimmt, die sich beide
        // Programme teilen, und jede Aenderung protokolliert. Ein zweiter
        // Schreibweg daneben waere ein Rueckschritt.
        aufruf: [u.wbStateBin, 'settings', 'set', key, text],
        daten: { key, value: text },
      };
    }

    // --- Was ein MENSCH lockert: Guard, Wache, Deckel ----------------------
    //
    // Drei eigene Wege statt `set`, obwohl am Ende dieselbe Datei beschrieben
    // wird. Der Grund steht in `wb-state`: diese drei tragen Grund, Datum und
    // Rolle, und wer eine Sicherung LOCKERT, muss ein Mensch sein -- gemessen
    // an der Herkunft des Aufrufs. Ginge die Oberflaeche hier ueber
    // `settings set`, umginge sie beide Auflagen und schriebe ein Schema, das
    // die Werkzeuge nicht lesen. Genau das war der Befund vom 06.08.: vier
    // Schalter, die etwas anderes schrieben, als die Werkzeuge lasen.
    case 'guard-set': {
      const guard = String(nachricht.guard ?? '');
      const an = nachricht.an === true;
      const grund = String(nachricht.grund ?? '').trim();
      const rolle = String(nachricht.rolle ?? '').trim();
      if (!guard) return { art: 'abgelehnt', command, beschreibung: '', grund: 'Kein Guard angegeben.' };
      if (!an && !grund) {
        return {
          art: 'abgelehnt',
          command,
          beschreibung: '',
          grund: 'Ein abgeschalteter Guard ohne Grund ist genau die stille Sicherung, '
            + 'die schlimmer ist als keine. Nichts geschrieben.',
        };
      }
      const aufruf = [u.wbStateBin, 'guard', 'set', guard, an ? 'an' : 'aus'];
      if (!an) {
        aufruf.push('--grund', grund);
        if (rolle && rolle !== 'alle') aufruf.push('--rolle', rolle);
      }
      return {
        art: 'bestaetigen',
        command,
        beschreibung: an ? `Guard '${guard}' wieder einschalten.` : `Guard '${guard}' abschalten.`,
        aufruf,
        daten: { guard, an },
      };
    }

    case 'wache-set': {
      const rolle = String(nachricht.rolle ?? '');
      if (rolle !== 'orchestrator' && rolle !== 'worker') {
        return { art: 'abgelehnt', command, beschreibung: '', grund: `Unbekannte Rolle '${rolle}'.` };
      }
      const grund = String(nachricht.grund ?? '').trim();
      const aufruf = [u.wbStateBin, 'wache', 'set', rolle];
      const felder: [string, string][] = [
        ['an', 'an'], ['eingreifen', 'eingreifen'],
        ['mahnenAb', 'mahnen-ab'], ['notbremseAb', 'notbremse-ab'],
      ];
      let etwas = false;
      for (const [feld, flagge] of felder) {
        const wert = nachricht[feld];
        if (wert === undefined || wert === null) continue;
        etwas = true;
        aufruf.push(`--${flagge}`, typeof wert === 'boolean' ? String(wert) : String(wert));
      }
      if (!etwas) return { art: 'abgelehnt', command, beschreibung: '', grund: 'Nichts zu setzen.' };
      if (grund) aufruf.push('--grund', grund);
      return {
        art: 'bestaetigen',
        command,
        beschreibung: `Kontextwache fuer '${rolle}' aendern.`,
        aufruf,
        daten: { rolle },
      };
    }

    case 'effort-cap': {
      const modell = String(nachricht.model ?? '');
      const stufe = String(nachricht.stufe ?? '').trim();
      const grund = String(nachricht.grund ?? '').trim();
      if (!modell) return { art: 'abgelehnt', command, beschreibung: '', grund: 'Kein Modell angegeben.' };
      if (!stufe) {
        return {
          art: 'bestaetigen',
          command,
          beschreibung: `Deckel von '${modell}' auf die Auslieferung zuruecksetzen.`,
          aufruf: [u.wbStateBin, 'effort-cap', 'clear', modell],
          daten: { model: modell },
        };
      }
      if (!grund) {
        return {
          art: 'abgelehnt',
          command,
          beschreibung: '',
          grund: 'Ein Deckel ohne Grund liest sich in einem halben Jahr wie eine technische '
            + 'Grenze. Nichts geschrieben.',
        };
      }
      return {
        art: 'bestaetigen',
        command,
        beschreibung: `Deckel von '${modell}' auf '${stufe}' setzen.`,
        aufruf: [u.wbStateBin, 'effort-cap', 'set', modell, stufe, '--grund', grund],
        daten: { model: modell, stufe },
      };
    }

    // Die vierte Sicherung (2026-08-16, permmode-Auftrag): SENKEN -- jeder
    // Wechsel weg von bypassPermissions -- geht ohne Grund; das ANHEBEN darauf
    // zurueck verlangt einen Grund. `wb-state` selbst prueft zusaetzlich den
    // Menschen (WB_MENSCH_QUELLE/WB_APP_PID aus `fuehreAus`, wie bei Guard,
    // Wache und Deckel oben) -- diese Funktion baut nur den Aufruf.
    case 'permission-mode-set': {
      const modi = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
      const wert = String(nachricht.value ?? '').trim();
      const grund = String(nachricht.grund ?? '').trim();
      if (!modi.includes(wert)) {
        return { art: 'abgelehnt', command, beschreibung: '', grund: `Unbekannte Stufe '${wert}'.` };
      }
      const vorher = String(einstellung(u.settingsFile, 'orchestratorPermissionMode') ?? 'bypassPermissions');
      const hebtAn = wert === 'bypassPermissions' && vorher !== 'bypassPermissions';
      const aufruf = [u.wbStateBin, 'settings', 'set', 'orchestratorPermissionMode', wert];
      if (hebtAn) {
        if (!grund) {
          return {
            art: 'abgelehnt',
            command,
            beschreibung: '',
            grund: 'Ein Anheben auf bypassPermissions ohne Grund liest sich in einem halben Jahr wie eine '
              + 'technische Grenze. Nichts geschrieben.',
          };
        }
        aufruf.push('--grund', grund);
      }
      return {
        art: 'bestaetigen',
        command,
        beschreibung: hebtAn
          ? `orchestratorPermissionMode auf 'bypassPermissions' anheben.`
          : `orchestratorPermissionMode auf '${wert}' setzen.`,
        aufruf,
        daten: { value: wert },
      };
    }

    // --- Session fortsetzen ------------------------------------------------
    case 'resume': {
      const dir = String(nachricht.dir ?? '');
      const key = nachricht.sessionKey ? String(nachricht.sessionKey) : undefined;
      if (!dir) return { art: 'abgelehnt', command, beschreibung: '', grund: 'Kein Ordner angegeben.' };
      const akte = findeSessionAkte(u.sessionsDir, dir, key);
      if (!akte) {
        return { art: 'abgelehnt', command, beschreibung: '', grund: `Keine Zustandsdatei fuer '${dir}'.` };
      }
      // LAEUFT SIE SCHON, wird nichts gestartet -- sie wird nur gezeigt. Das
      // ist der Fall, in dem ein zweiter Start Schaden anrichten koennte.
      if (sessionLaeuft(u.tmuxSocket, akte.tmuxSession)) {
        return {
          art: 'sofort',
          command,
          beschreibung: `Die Session '${akte.tmuxSession}' laeuft bereits — sie wird nur gezeigt, nicht neu gestartet.`,
          daten: { tmuxSession: akte.tmuxSession, dir, bereitsAktiv: true },
        };
      }
      const args = [dir];
      if (akte.sessionKey) args.push('--key', akte.sessionKey);
      if (akte.name) args.push('--name', akte.name);
      if (akte.claudeSessionId) args.push('--resume', akte.claudeSessionId);
      return {
        art: 'bestaetigen',
        command,
        beschreibung: `Session '${akte.name || basename(dir)}' in ${dir} fortsetzen`
          + (akte.claudeSessionId ? ` (Unterhaltung ${akte.claudeSessionId.slice(0, 8)}…).` : ' (ohne gespeicherte Unterhaltung).'),
        aufruf: [u.wbCodeBin, ...args],
        daten: { dir, sessionKey: akte.sessionKey, tmuxSession: akte.tmuxSession },
      };
    }

    // --- Neue Session ------------------------------------------------------
    case 'newInFolder':
    case 'new': {
      const roh = command === 'newInFolder'
        ? String(nachricht.dir ?? '')
        : String(einstellung(u.settingsFile, 'newSessionDefaultDir') ?? '~/AI');
      const dir = expandHome(roh);
      if (!dir) return { art: 'abgelehnt', command, beschreibung: '', grund: 'Kein Ordner angegeben.' };
      if (!existsSync(dir)) {
        return { art: 'abgelehnt', command, beschreibung: '', grund: `Den Ordner gibt es nicht: ${dir}` };
      }
      return {
        art: 'bestaetigen',
        command,
        beschreibung: `Eine neue Session in ${dir} anlegen`
          + (command === 'new' ? ' (Ordner aus der Einstellung newSessionDefaultDir).' : '.'),
        aufruf: [u.wbCodeBin, dir],
        daten: { dir },
      };
    }

    // --- Session schliessen ------------------------------------------------
    //
    // Der Gegenpart zum Loeschen: die tmux-Session geht weg, die Zustandsdatei
    // BLEIBT. Damit verschwindet die Sitzung aus der Leiste (sie steht auf
    // 'stopped', und der Haken fuer beendete Sitzungen steht bei alice auf
    // aus) und bleibt trotzdem im Sitzungsfenster unter ihrem Ordner
    // fortsetzbar. Deshalb braucht dieser Weg auch keine Rueckfrage: er nimmt
    // nichts weg, was sich nicht zurueckholen liesse.
    case 'session-close': {
      const tmuxSession = String(nachricht.tmuxSession ?? '');
      if (!tmuxSession) {
        return { art: 'abgelehnt', command, beschreibung: '', grund: 'Keine tmux-Session angegeben.' };
      }
      const maschine = String(nachricht.machine ?? '');
      const fern = !!maschine && maschine !== u.machine;
      // OB SIE LAEUFT, IST AUF IHRER MASCHINE ZU BEANTWORTEN (09.08.). Hier
      // stand nur `sessionLaeuft` gegen das HIESIGE tmux, und das kennt den
      // Namen einer Fernsitzung nicht: jede von ihnen galt als beendet, der
      // Plan wurde abgelehnt, und im Fenster stand „laeuft nicht (mehr)",
      // waehrend sie drueben seit Tagen lief. Fuer eine Fernsitzung kommt die
      // Antwort mit der Nachricht -- aus dem letzten Abruf des RemotePollers,
      // derselben Quelle, aus der die Leiste sie als laufend zeichnet.
      const laeuft = fern ? nachricht.laeuft === true : sessionLaeuft(u.tmuxSocket, tmuxSession);
      if (!laeuft) {
        return {
          art: 'abgelehnt',
          command,
          beschreibung: '',
          grund: `Die Session '${tmuxSession}' laeuft nicht (mehr) -- es gibt nichts zu schliessen.`,
        };
      }
      // MIT ODER OHNE DEN AUSDRUECKLICHEN WEG.
      //
      // `wb-session-close` verweigert, solange ein Client an der Session oder
      // ihrer Gruppe haengt und solange ein Worker-Pane laeuft. Beides ist
      // richtig fuer einen Aufruf aus einem Skript -- und beides steht dem
      // Menschen im Weg, der im Fenster auf „Sitzung schließen" klickt: an
      // seiner Sitzung haengt immer sein Terminal (und dieses Programm selbst).
      // Das Werkzeug kennt dafuer seine eigenen Schalter, und genau die werden
      // benutzt, statt daneben einen zweiten Kill-Weg zu bauen:
      // `--force` hebt die Client-Pruefung auf und verlangt dafuer
      // `WB_SESSION_CLOSE_CONFIRM` mit demselben Namen, `--with-workers` die
      // Worker-Pruefung. Was dabei geschieht, steht in der Beschreibung, und
      // vor dem Loeschen fragt ohnehin ein Kasten nach.
      const erzwingen = nachricht.erzwingen === true;
      const schalter = erzwingen ? ['--force', '--with-workers', tmuxSession] : [tmuxSession];
      const bestaetigung = erzwingen ? { WB_SESSION_CLOSE_CONFIRM: tmuxSession } : undefined;
      return {
        art: 'bestaetigen',
        command,
        beschreibung: `Die tmux-Session '${tmuxSession}'${fern ? ` auf ${maschine}` : ''} schliessen. `
          + 'Die Zustandsdatei bleibt, die Sitzung laesst sich danach fortsetzen.'
          + (erzwingen ? ' Angehaengte Terminals und laufende Worker gehen dabei mit.' : ''),
        // Fern laeuft DASSELBE Werkzeug, nur drueben: es liegt dort in
        // ~/.local/bin, und die Bestaetigungsvariable reist in der Zeile mit
        // statt in unserer Umgebung (siehe `fernAufruf`).
        aufruf: fern
          ? fernAufruf(maschine, ['wb-session-close', ...schalter], bestaetigung)
          : [u.wbSessionCloseBin, ...schalter],
        umgebung: fern ? undefined : bestaetigung,
        daten: { tmuxSession, machine: maschine },
      };
    }

    // --- Sitzung umbenennen ------------------------------------------------
    //
    // GESCHRIEBEN WIRD MIT `wb-state touch`, nicht mit einem eigenen Griff in
    // die JSON-Datei. Der Auftrag nannte `wb-state session --name`; diesen
    // Unterbefehl gibt es nicht -- `session` LIEST nur den tmux-Namen (gemessen
    // am 06.08. gegen shell/wb-state). `touch <dir> <tmuxSession> --name <neu>`
    // ist der vorhandene Schreibweg, derselbe, den `wb-code` beim Anlegen
    // benutzt, samt Dateisperre. Seine Nebenwirkung wird hier nicht verschwiegen:
    // `touch` setzt `lastActive` auf jetzt, eine Umbenennung schiebt die Sitzung
    // also in jeder Liste nach oben.
    case 'session-rename': {
      const dir = String(nachricht.dir ?? '');
      const tmuxSession = String(nachricht.tmuxSession ?? '');
      const key = nachricht.sessionKey ? String(nachricht.sessionKey) : '';
      const neu = String(nachricht.name ?? '').trim();
      if (!dir) return { art: 'abgelehnt', command, beschreibung: '', grund: 'Kein Ordner angegeben.' };
      if (!tmuxSession) {
        return { art: 'abgelehnt', command, beschreibung: '', grund: 'Keine tmux-Session angegeben.' };
      }
      // Ein leerer Name ist keine Loeschung des Namens, sondern ein Versehen:
      // `touch` schriebe ihn ohnehin nicht, und die Sitzung hiesse danach
      // scheinbar unveraendert weiter. Also wird hier abgelehnt statt still
      // nichts zu tun.
      if (!neu) {
        return {
          art: 'abgelehnt',
          command,
          beschreibung: '',
          grund: 'Ein leerer Name wird nicht geschrieben -- die Sitzung behaelt ihren alten.',
        };
      }
      if (!/^[A-Za-z0-9 _.-]{1,60}$/.test(neu)) {
        return {
          art: 'abgelehnt',
          command,
          beschreibung: '',
          grund: 'Der Name enthaelt Zeichen, die hier nicht vorgesehen sind (erlaubt: Buchstaben, '
            + 'Ziffern, Leerzeichen, Punkt, Strich, Unterstrich; hoechstens 60).',
        };
      }
      const args = ['touch', dir, tmuxSession];
      if (key) args.push('--key', key);
      args.push('--name', neu);
      // DER GEFAEHRLICHSTE DER DREI FAELLE (09.08.). Umbenennen war der einzige
      // Griff, der fuer eine Fernsitzung nicht abgelehnt wurde, sondern LIEF:
      // das hiesige `wb-state touch` bekam den fernen Ordner und den fernen
      // tmux-Namen und haette hier eine zweite Zustandsdatei fuer ein
      // Verzeichnis angelegt, das es auf dieser Maschine nicht gibt -- eine
      // Sitzung, die niemandem gehoert. Gemessen, bevor diese Zeilen entstanden.
      const maschine = String(nachricht.machine ?? '');
      const fern = !!maschine && maschine !== u.machine;
      return {
        art: 'bestaetigen',
        command,
        beschreibung: `Die Sitzung in ${dir}${fern ? ` auf ${maschine}` : ''} heisst danach '${neu}'.`,
        aufruf: fern ? fernAufruf(maschine, ['wb-state', ...args]) : [u.wbStateBin, ...args],
        daten: { dir, sessionKey: key, name: neu, machine: maschine },
      };
    }

    // --- Session loeschen --------------------------------------------------
    case 'delete': {
      const dir = String(nachricht.dir ?? '');
      const key = nachricht.sessionKey ? String(nachricht.sessionKey) : undefined;
      if (!dir) return { art: 'abgelehnt', command, beschreibung: '', grund: 'Kein Ordner angegeben.' };
      const maschine = String(nachricht.machine ?? '');
      const fern = !!maschine && maschine !== u.machine;
      // DIE AKTE LIEGT AUF IHRER MASCHINE (09.08.). `findeSessionAkte` sucht im
      // HIESIGEN Sessionverzeichnis, und fuer eine Fernsitzung findet es dort
      // nichts -- der Plan wurde abgelehnt mit „Keine Zustandsdatei fuer
      // '/home/alice/…'", obwohl die Datei drueben lag und der Poller sie
      // gerade gelesen hatte. Fuer den fernen Fall stehen die vier Angaben
      // deshalb in der Nachricht (Ordner, Schluessel, tmux-Name, laeuft sie);
      // sie kommen aus derselben SessionInfo, aus der die Leiste gezeichnet wird.
      const akte = fern
        ? {
          name: String(nachricht.name ?? ''),
          sessionKey: key ?? '',
          tmuxSession: String(nachricht.tmuxSession ?? ''),
        }
        : findeSessionAkte(u.sessionsDir, dir, key);
      if (!akte) return { art: 'abgelehnt', command, beschreibung: '', grund: `Keine Zustandsdatei fuer '${dir}'.` };
      /**
       * EINE LAUFENDE SITZUNG WIRD GELOESCHT, WENN ES SO GEMEINT IST.
       *
       * Hier stand eine Ablehnung: laeuft sie, erst schliessen. alice hat sie
       * am 06.08. zurueckgenommen -- „sessions sollen auch sofort endgültig
       * löschbar sein ohne sie vorher zu schließen". Der Weg dorthin ist nicht
       * ein eigener Kill, sondern der, den `wb-session-delete` ohnehin geht: es
       * ruft `wb-session-close`, und dessen Pruefungen werden mit dessen eigenen
       * Schaltern aufgehoben (`--force` samt `WB_SESSION_CLOSE_CONFIRM`,
       * `--with-workers`). Ohne `erzwingen` bleibt es beim alten Verhalten --
       * ein Skript, das bloss `delete` schickt, raeumt keine laufende Arbeit ab.
       */
      // Fern gilt dieselbe Ueberlegung wie beim Schliessen: das hiesige tmux
      // kennt ihren Namen nicht, also kommt die Antwort aus dem letzten Abruf.
      const laeuft = fern ? nachricht.laeuft === true : sessionLaeuft(u.tmuxSocket, akte.tmuxSession);
      const erzwingen = nachricht.erzwingen === true;
      if (laeuft && !erzwingen) {
        return {
          art: 'abgelehnt',
          command,
          beschreibung: '',
          grund: `Die Session '${akte.tmuxSession}' laeuft. Erst schliessen (wb-session-close), dann loeschen.`,
        };
      }
      const args = ['--dir', dir];
      if (akte.sessionKey) args.push('--key', akte.sessionKey);
      args.push('--yes');
      if (laeuft && erzwingen) args.push('--force');
      const bestaetigung = laeuft && erzwingen ? { WB_SESSION_CLOSE_CONFIRM: akte.tmuxSession } : undefined;
      return {
        art: 'bestaetigen',
        command,
        beschreibung: `Session '${akte.name || basename(dir)}'${fern ? ` auf ${maschine}` : ''} loeschen: `
          + 'Zustandsdatei und ihr Claude-Transkript. Der Projektordner selbst bleibt unberuehrt.'
          + (laeuft && erzwingen
            ? ` Die laufende tmux-Session '${akte.tmuxSession}' wird dabei geschlossen, samt angehaengter Terminals und laufender Worker.`
            : ''),
        aufruf: fern
          ? fernAufruf(maschine, ['wb-session-delete', ...args], bestaetigung)
          : [u.wbSessionDeleteBin, ...args],
        umgebung: fern ? undefined : bestaetigung,
        daten: { dir, sessionKey: akte.sessionKey, tmuxSession: akte.tmuxSession, machine: maschine },
      };
    }

    // --- kein Empfaenger ---------------------------------------------------
    // `switchMachine` stand hier einmal als eigener Fall (Schritt 8 noch nicht
    // gebaut). Inzwischen zeigt `sessions` (sessions.ts) beide Maschinen
    // ohnehin schon in EINER zusammengefuehrten Liste (V10) -- ein Reiter, der
    // nichts mehr filtert, waere ein Knopf ohne Sinn. Der Knopf selbst ist
    // deshalb von der Startseite genommen (seiten.ts: `renderHomeHtml(...,
    // false)`); dieser Fall braucht keinen eigenen Text mehr, `default`
    // beantwortet ihn genauso ehrlich, falls doch noch jemand den Befehl schickt.
    default:
      return {
        art: 'offen',
        command,
        beschreibung: '',
        grund: `Fuer '${command}' gibt es in diesem Programm noch keinen Empfaenger.`,
      };
  }
}

export interface Ausgang {
  ok: boolean;
  ausgabe: string;
}

/**
 * Einen Plan ausfuehren -- und NUR einen, der ausgefuehrt werden darf. Die
 * Beschreibung wird dabei nicht neu erzeugt: Was der Mensch bestaetigt hat, ist
 * genau das, was hier laeuft.
 *
 * `wb-code` endet mit `exec tmux attach`. Aufgerufen wird es deshalb in einer
 * eigenen, kurzlebigen tmux-Session auf demselben Server -- so, wie ein Mensch
 * es in einem Terminal aufruft. Danach steht die Zielsession, das Fenster
 * zeichnet sie, und die Hilfssession wird wieder abgeraeumt. Ohne diesen Umweg
 * bliebe entweder ein Prozess ohne Terminal haengen oder wir muessten
 * nachbauen, was `wb-code` tut -- und dann gaebe es zwei Fassungen davon.
 */
/**
 * `mensch` sagt, ob hinter diesem Aufruf ein ECHTER Klick steht -- gemessen im
 * Fenster an `isTrusted`, nicht behauptet. Nur dann bekommt `wb-state` das
 * Merkmal mit, das eine Sicherung lockern darf. Die Vorgabe ist `false`: jeder
 * Weg, der nichts sagt (Steuerkanal, Plan-Bestaetigung im Hauptfenster, ein
 * Skript), gilt als Agent.
 */
export function fuehreAus(plan: Plan, u: BefehlsUmgebung, mensch = false): Ausgang {
  if (plan.art !== 'bestaetigen' || !plan.aufruf?.length) {
    return { ok: false, ausgabe: `Nichts auszufuehren (${plan.art}).` };
  }
  const [bin, ...args] = plan.aufruf;

  if (bin === u.wbCodeBin) {
    const helfer = `awb-neu-${process.pid}-${Date.now()}`;
    const zeile = [bin, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    // `unset TMUX`: sonst haelt tmux den Aufruf fuer eine verschachtelte
    // Sitzung und `attach` verweigert -- die Zielsession entstuende zwar, aber
    // der Weg dorthin waere ein Fehlschlag, auf den man sich nicht stuetzt.
    const start = tmux(u.tmuxSocket, [
      'new-session', '-d', '-s', helfer, `unset TMUX; ${zeile}`,
    ]);
    if (!start.ok) return { ok: false, ausgabe: `Hilfssession liess sich nicht anlegen: ${helfer}` };

    // Gewartet wird auf etwas, das DIESER Aufruf hervorbringt -- nicht auf
    // etwas, das ohnehin schon da ist. Ein erster Anlauf fragte nur "gibt es
    // eine wb-Session?", und weil immer eine lief, war die Antwort sofort ja:
    // die Hilfssession wurde beendet, bevor sie ihren Befehl ueberhaupt
    // ausgefuehrt hatte (gemessen 05.08., der Aufruf hinterliess keine Spur).
    //
    // Fertig ist es, wenn entweder die genannte Zielsession auftaucht, oder
    // eine wb-Session, die es VORHER nicht gab, oder die Hilfssession von
    // selbst endet (dann ist ihr Befehl durch).
    const ziel = String(plan.daten?.tmuxSession ?? '');
    const namen = (): string[] => tmux(u.tmuxSocket, ['list-sessions', '-F', '#{session_name}']).out
      .split('\n').filter(Boolean);
    const vorher = new Set(namen().filter((n) => n !== helfer));
    const frist = Date.now() + 20_000;
    let da = false;
    while (Date.now() < frist) {
      spawnSync('sleep', ['0.3']);
      const jetzt = namen();
      if (ziel && jetzt.includes(ziel)) { da = true; break; }
      if (jetzt.some((n) => n.startsWith('wb-') && n !== helfer && !vorher.has(n))) { da = true; break; }
      if (!jetzt.includes(helfer)) { da = true; break; }   // Befehl ist durch
    }
    // Die Hilfssession geht in jedem Fall wieder weg: sie hat ihren Zweck
    // erfuellt oder ist gescheitert, und stehen bleiben darf sie nie.
    tmux(u.tmuxSocket, ['kill-session', '-t', `=${helfer}`]);
    return da
      ? { ok: true, ausgabe: `Session steht${ziel ? `: ${ziel}` : ''}.` }
      : { ok: false, ausgabe: 'Die Session ist innerhalb von 20 Sekunden nicht erschienen.' };
  }

  // DER MENSCHEN-NACHWEIS, und warum er hier steht und nicht im Fenster.
  //
  // Drei Sicherungen darf nur ein Mensch lockern: der Effort-Deckel, ein
  // einzelner Guard und die Kontextwache. `wb-mensch` entscheidet das nicht an
  // dem, was der Aufrufer BEHAUPTET, sondern an seiner Herkunft: die genannte
  // PID muss ein echter Ahne des aufgerufenen Prozesses sein und wie dieses
  // Programm heissen. Beides zusammen kann ein Agent nicht herstellen -- er
  // kann die Variablen setzen, aber sich nicht unter den Hauptprozess haengen.
  //
  // Deshalb steht es genau HIER: an der Stelle, an der dieses Programm einen
  // Prozess startet, ist die Ahnenreihe die Wahrheit. Ein Merkmal, das die
  // Oberflaeche mitschickte, waere wieder nur eine Behauptung.
  //
  // WAS DER ECHTE KLICK DAZU BEITRAEGT (06.08., nach eigener Meldung). Die
  // Ahnenreihe belegt, dass die OBERFLAECHE ruft -- sie belegt nicht, dass ein
  // MENSCH sie bedient hat. Der Steuerkanal kann jeden Knopf dieses Fensters
  // druecken, und ohne diese Unterscheidung haette ein Agent damit einen Guard
  // abschalten koennen. `mensch` kommt deshalb aus `isTrusted` im Fenster: ein
  // `el.click()` traegt false, und das laesst sich nicht faelschen. Beide
  // Bedingungen zusammen, sonst keine Lockerung.
  //
  // Der Preis, offen benannt: dass ein ECHTER Klick durchgeht, prueft kein
  // Test mehr -- genau wie beim `show()`-Zweig des Fensters. Geprueft wird die
  // andere Haelfte, und das ist die, auf die es ankommt: ein Skript-Klick wird
  // abgewiesen.
  const umgebung = mensch && bin === u.wbStateBin
    ? { ...process.env, WB_MENSCH_QUELLE: 'oberflaeche', WB_APP_PID: String(process.pid), ...(plan.umgebung ?? {}) }
    : { ...process.env, ...(plan.umgebung ?? {}) };
  // EINE ZEITGRENZE FUER DEN WEG UEBER DIE LEITUNG (09.08.). Dieser Aufruf ist
  // SYNCHRON -- solange er laeuft, zeichnet das Fenster nicht und nimmt keine
  // Taste an. Oertlich ist das unauffaellig (die `wb-*`-Werkzeuge sind in
  // Sekundenbruchteilen durch), ueber SSH nicht: eine Maschine, die gerade
  // eingeschlafen ist, laesst die Verbindung stehen. `ConnectTimeout` in
  // `fernAufruf` deckt nur den AUFBAU; das hier deckt den Rest.
  const zeitlimit = bin === 'ssh' ? 30_000 : undefined;
  const r = spawnSync(bin, args, { encoding: 'utf8', env: umgebung, timeout: zeitlimit });
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return { ok: false, ausgabe: `Die andere Maschine hat in ${(zeitlimit ?? 0) / 1000} Sekunden nicht geantwortet.` };
  }
  const ausgabe = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return { ok: r.status === 0, ausgabe: ausgabe || (r.status === 0 ? 'erledigt' : `Fehlercode ${r.status}`) };
}
