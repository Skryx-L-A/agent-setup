// Konfiguration. Kein Pfad und kein Maschinenname steht hier fest verdrahtet:
// alles kommt aus der Umgebung, aus einer Konfigurationsdatei oder aus
// os.homedir()/os.tmpdir(). Wer das Paket bekommt, soll es starten koennen,
// ohne eine Zeile Quelltext zu aendern.
//
// ZWEI DATEIEN, GETRENNT NACH ZUSTAENDIGKEIT (06.08.2026). Diese Datei liest
// ~/.config/agent-workbench/config.json: was NUR dieses Programm zum
// Hochfahren braucht -- Pfade, Socket, Takte, Maschinenkennung. Alles, was
// Programm und `wb-*`-Werkzeuge GEMEINSAM meinen, steht in
// ~/.claude/workbench/settings.json und wird ueber `einstellungen.ts` gelesen.
// KEIN SCHLUESSEL STEHT IN BEIDEN. Vier sind deshalb umgezogen:
// `maxWorkersPerTab` (8) und `minPaneCols` (80) sind in
// `maxWorkerPanesPerTab` (6) und `minWorkerPaneWidth` (80) aufgegangen --
// dieselbe Groesse hatte zwei Namen und zwei Zahlen --, `askPatterns` und
// `remoteMachines` sind gewandert, weil das Menue sie pflegt und der einzige
// Schreibweg in die geteilte Datei `wb-state settings set` ist. Steht einer
// der vier noch in einer alten config.json, wird er nicht mehr gelesen.
import { homedir, hostname, tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Die GETEILTEN Werte kommen seit dem 06.08. aus der geteilten Datei
// (~/.claude/workbench/settings.json), nicht mehr aus der Programmdatei --
// siehe den Abschnitt "Die GETEILTEN Werte" dort. Diese Datei liest sie nur;
// geschrieben wird ausschliesslich ueber `wb-state settings set`.
import {
  askMuster as askMusterAusEinstellungen,
  maschinenliste,
  zahlAus,
  type AskMuster,
} from './einstellungen';

export type { AskMuster };

export interface Config {
  /** tmux-Socketname (`tmux -L`). Leer = Standardsocket von tmux. */
  tmuxSocket: string;
  /** Name der tmux-Session, die das Fenster zeichnet. Leer = erste vorhandene. */
  session: string;
  /** Pfad des Steuersockets (V5). */
  controlSocket: string;
  /** Verzeichnis, in das Selbstfotos geschrieben werden (V6). */
  shotDir: string;
  /** Kopfloser Modus (V7): kein Dock, kein Menue, Fenster bleibt ungezeigt. */
  headless: boolean;
  /** Spaltenzahl, die eine SELBST angelegte Session bekommt. */
  ownedCols: number;
  /** Zeilenzahl, die eine SELBST angelegte Session bekommt. */
  ownedRows: number;
  /** Verzeichnis der Zustandsdateien, aus denen die Sessions kommen. */
  sessionsDir: string;
  /** Verzeichnis der offenen Freigaben. */
  requestsDir: string;
  /** Verzeichnis der Marker angehaltener Worker (V20, von bash-guard.py geschrieben). */
  guardBlocksDir: string;
  /** Der Verlauf ALLER Ablehnungen (V17, von bash-guard.py angehaengt) -- derselbe Name wie der Hook (AWB_GUARD_LOG). */
  guardLogFile: string;
  /** Aufruf fuer wb-decide -- bewusst kein absoluter Pfad, damit gilt, was auch am
   *  echten Terminal gilt (PATH). Ein Test kann ihn ueberschreiben. */
  wbDecideBin: string;
  /** V14: Aufruf fuer `wb-code` -- derselbe Grund wie bei wbDecideBin (PATH statt fester Pfad). */
  wbCodeBin: string;
  /**
   * Aufruf fuer `wb-pane-write` (2026-08-06) -- die eine Stelle, die entscheidet, wer in
   * einen Pane tippen darf. Das Programm bringt KEINE eigene Fassung dieser Regel mit; es
   * fragt dieses Werkzeug (`wb-pane-write darf <pane>`), damit es die Regel nur einmal gibt.
   * Derselbe Grund fuer den PATH-Aufruf wie bei wbDecideBin.
   */
  wbPaneWriteBin: string;
  /**
   * Aufruf fuer `wb-freigabe` (2026-08-07) -- die eine Stelle, an der eine GUELTIGE
   * Freigabe entsteht. Dieses Programm schreibt die Freigabedatei nicht mehr selbst:
   * seit dem Befund vom 07.08. zaehlt eine Freigabe nur mit gemessener Herkunft und
   * Signatur, und gemessen wird sie dort, wo der Prozess startet (siehe freigaben.ts).
   * Derselbe Grund fuer den PATH-Aufruf wie bei wbDecideBin.
   */
  wbFreigabeBin: string;
  /**
   * DIE ATTRAPPE FUER DEN ORDNER-DIALOG. Leer im Betrieb; steht hier ein Pfad,
   * liefert die Ordnerwahl des Sitzungsfensters genau ihn und oeffnet KEINEN
   * Dialog.
   *
   * Warum ueberhaupt: Der Knopf „Neue Sitzung" oeffnet den nativen Ordner-Dialog
   * von macOS. Ein Test darf den nie aufmachen -- er waere ein Fenster auf
   * Bildschirm des Nutzers und wartet zudem auf einen Menschen. Geprueft werden
   * soll aber, was mit dem gewaehlten Pfad GESCHIEHT: Ausschlussliste, Aufruf an
   * `wb-code`, Meldung im Fenster. Also wird genau die eine Stelle austauschbar,
   * an der das Betriebssystem gefragt wird, und nichts sonst.
   */
  ordnerDialogAttrappe: string;
  /**
   * DER BEFEHL EINER CHAT-SITZUNG. Im Betrieb 'claude'; ein Testlauf setzt
   * hier einen Attrappen-Harness ein, der aufgezeichnete Ereignisse
   * ausspuckt. Dieselbe Ueberlegung wie beim Ordner-Dialog: austauschbar wird
   * genau die eine Stelle, an der etwas ausserhalb dieses Programms passiert,
   * und nichts sonst -- so laeuft die ganze Kette (Prozess, Strom, Fenster,
   * Freigabe) im Test wirklich, ohne echtes Modell und ohne Kosten.
   */
  chatBefehl: string;
  /**
   * DIE ATTRAPPE FUER JEDE RUECKFRAGE ('ja' oder 'nein'). Leer im Betrieb.
   * Dieselbe Ueberlegung wie beim Ordner-Dialog: `dialog.showMessageBox` wartet
   * auf einen Menschen, den es in einem Testlauf nicht gibt, und brachte eine
   * Flaeche auf den Bildschirm. Geprueft werden soll aber, ob VORHER gefragt
   * wird und was die Antwort bewirkt.
   */
  rueckfrageAttrappe: string;
  /** Verzeichnis fuer den eigenen Oberflaechen-Zustand. */
  stateDir: string;
  /** Verzeichnis der Ergebnisdateien der Worker (V2). */
  resultsDir: string;
  /** Verzeichnis der Claude-Transcripte -- Quelle der Kontextauslastung (V1). */
  projectsDir: string;
  /**
   * Sekunden ohne Bewegung, ab denen ein Worker als haengend gilt. Zuhause ist
   * `stallMinutes` in der geteilten Datei -- die Zahl entscheidet, wann eine
   * Meldung an einen Menschen geht, und ist damit keine Startgroesse dieses
   * Programms.
   */
  stallSeconds: number;
  /**
   * Die Modell-Registry. Einzige Quelle fuer Modelleigenschaften, hier fuer die
   * Groesse des Kontextfensters -- dieselbe Datei, aus der `wb-state models get
   * <id> --field contextWindow` antwortet.
   */
  modelsFile: string;
  /**
   * Pfade, die Ordneransicht und Inhaltssuche NIE zeigen -- ausgelassen, nicht
   * nur verborgen (4c.2). Gehoert bewusst hierher und nicht in eine Konstante
   * im Code, damit die Liste sichtbar und pruefbar ist (~/.config/agent-
   * workbench/config.json). Glob-Syntax: `*` = ein Pfadstueck, `**` = beliebig
   * viele. Die Vorgabe deckt `~/Knowledge/90-secrets/`, `~/.ssh/` und die
   * gaengigen Zugangsdaten-Dateimuster ab (dieselben wie in
   * hooks/bash-guard-secrets.sh, aus demselben Grund).
   */
  excludeGlobs: string[];
  /**
   * Die Muster der Rueckfrage-Stufe: Befehle, die weder harmlos noch verboten
   * sind, sondern eine Frage wert. Sie stehen seit dem 06.08. in der GETEILTEN
   * Datei (~/.claude/workbench/settings.json, Schluessel "askPatterns") statt
   * in der Programmdatei -- das Menue muss jeden Eintrag einzeln abschalten
   * koennen, und der einzige Schreibweg dorthin ist `wb-state settings set`.
   * Der Hook liest dieselbe Stelle (hooks/lib/ask_muster.py).
   * Die Vorgabeliste steht als VORGABE_ASK_MUSTER in `einstellungen.ts` und
   * ein zweites Mal als STANDARD_MUSTER im Hook, damit beide einzeln
   * lauffaehig bleiben; shell/tests/test-app-muster.sh vergleicht sie.
   */
  askPatterns: AskMuster[];
  /** Verzeichnis der erteilten Einmal-Freigaben (vom Programm geschrieben, vom Hook verbraucht). */
  askGrantsDir: string;
  /** Gueltigkeit einer Freigabe in Sekunden. Der Hook deckelt zusaetzlich hart auf 900. */
  askGrantTtlSeconds: number;
  /** Die Einstellungen -- dieselbe Datei, die `wb-state settings get` liest. */
  settingsFile: string;
  /** Die Programm-Konfiguration, aus der diese Struktur gelesen wurde. Nur zum Anzeigen. */
  configFile: string;
  /** Kennung dieser Maschine. Ein Name steht nirgends im Quelltext. */
  machine: string;
  /**
   * Fernmaschinen fuer V10 -- ihr Name IST der SSH-Alias (`ssh peer`, `ssh
   * mac` funktionieren bereits von Hand, siehe SESSION-STATE V10a). Leer =
   * kein Fernabruf. Vorgabe spiegelt `wb-sync-setup`s eigene Logik: von einem
   * Mac aus ist die andere bekannte Maschine peer, umgekehrt der Mac.
   */
  remoteMachines: string[];
  /** Takt des Fernabrufs in Millisekunden -- deutlich langsamer als der lokale 2s-Takt. */
  remotePollMs: number;
  /** Ab wann ein einzelner SSH-Abruf als haengend gilt und abgebrochen wird. */
  remoteTimeoutMs: number;
  /** V12: die zwei Statusdateien von wb-testsuite-run und wb-hygiene. */
  testsuiteStatusFile: string;
  hygieneStatusFile: string;
  /** V13: Takt und Zeitlimit fuer `wb-budget` (gemessen: 9,3s je Lauf). */
  budgetPollMs: number;
  budgetTimeoutMs: number;
  budgetBin: string;
  /**
   * Mindestbreite eines Worker-Panes in Spalten -- darunter erblindet der
   * Guard. Zuhause ist `minWorkerPaneWidth` in der geteilten Datei; `wb-grid`
   * und `context-guard` lesen dieselbe Zahl. Bis zum 06.08. stand sie hier ein
   * zweites Mal als `minPaneCols`, mit eigener Vorgabe.
   */
  minPaneCols: number;
  /** Mindesthoehe eines Worker-Panes in Zeilen. Hat keine Entsprechung in der geteilten Datei und bleibt hier. */
  minPaneRows: number;
  /**
   * Obergrenze der Worker je Tab, ueberschreibt die abgeleitete Zahl. Zuhause
   * ist `maxWorkerPanesPerTab` in der geteilten Datei -- dieselbe Zahl, die
   * `wb-grid` liest. Bis zum 06.08. hiess sie hier `maxWorkersPerTab` und
   * stand auf 8, waehrend dieselbe Groesse dort auf 6 stand.
   */
  maxWorkersPerTab: number;
  /**
   * Pfad fuer EIN Selbstfoto direkt nach dem Start (`--startfoto=<pfad>`).
   * Leer = keins. Gebraucht fuer den Fall, in dem es keinen Steuerkanal gibt
   * und `awb-ctl shot` deshalb nicht erreichbar ist: ohne diesen Weg liesse
   * sich nicht belegen, dass das Fenster trotzdem steht und die fehlende
   * Verbindung ANZEIGT. Kein Automatismus -- nur wer es hinschreibt, bekommt es.
   */
  startShot: string;
}

/**
 * Standardpfad des Steuersockets. Dieselbe Ableitung steht ein zweites Mal in
 * bin/awb-ctl, das ohne Bauschritt laufen soll und deshalb nichts aus dist/
 * laden kann. Die Testsuite vergleicht beide Ergebnisse gegeneinander.
 */
export function defaultControlSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AWB_CONTROL_SOCKET) return env.AWB_CONTROL_SOCKET;
  const base = env.XDG_RUNTIME_DIR || tmpdir();
  // Unix-Socketpfade sind auf rund 104 Zeichen begrenzt, deshalb kurz halten.
  return join(base, `awb-${process.getuid?.() ?? 0}.sock`);
}

function configFilePath(env: NodeJS.ProcessEnv): string {
  return env.AWB_CONFIG || join(homedir(), '.config', 'agent-workbench', 'config.json');
}

function readConfigFile(env: NodeJS.ProcessEnv): Partial<Config> {
  try {
    return JSON.parse(readFileSync(configFilePath(env), 'utf8')) as Partial<Config>;
  } catch {
    // Ein erster Start ohne alles muss funktionieren (Plan 3.5, Punkt 4).
    return {};
  }
}

export function loadConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): Config {
  const file = readConfigFile(env);
  // Die geteilte Datei. Sie wird HIER schon gebraucht, weil ein Teil der
  // Startwerte dort zuhause ist -- dieselbe Ableitung wie beim Feld
  // `settingsFile` weiter unten, damit nicht zwei Stellen den Pfad raten.
  const einstellungen = env.AWB_SETTINGS_FILE
    ?? file.settingsFile
    ?? join(homedir(), '.claude', 'workbench', 'settings.json');
  const flag = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const num = (v: string | undefined, fallback: number): number => {
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };

  return {
    tmuxSocket: flag('tmux-socket') ?? env.AWB_TMUX_SOCKET ?? file.tmuxSocket ?? '',
    session: flag('session') ?? env.AWB_SESSION ?? file.session ?? '',
    controlSocket: flag('control-socket') ?? defaultControlSocketPath(env),
    shotDir: flag('shot-dir') ?? env.AWB_SHOT_DIR ?? file.shotDir ?? join(tmpdir(), 'agent-workbench-shots'),
    headless: argv.includes('--headless') || env.AWB_HEADLESS === '1' || file.headless === true,
    ownedCols: num(flag('cols') ?? env.AWB_COLS, file.ownedCols ?? 120),
    ownedRows: num(flag('rows') ?? env.AWB_ROWS, file.ownedRows ?? 34),
    sessionsDir: env.AWB_SESSIONS_DIR ?? file.sessionsDir ?? join(homedir(), '.claude', 'workbench', 'sessions'),
    requestsDir: env.AWB_REQUESTS_DIR ?? file.requestsDir ?? join(homedir(), '.pi-workers', 'requests'),
    guardBlocksDir: env.AWB_GUARD_BLOCKS_DIR ?? file.guardBlocksDir ?? join(homedir(), '.pi-workers', 'guard-blocks'),
    guardLogFile: env.AWB_GUARD_LOG ?? file.guardLogFile ?? join(homedir(), '.pi-workers', 'guard-blocks.log'),
    wbDecideBin: env.AWB_WB_DECIDE ?? file.wbDecideBin ?? 'wb-decide',
    wbCodeBin: env.AWB_WB_CODE ?? file.wbCodeBin ?? 'wb-code',
    wbPaneWriteBin: env.AWB_WB_PANE_WRITE ?? file.wbPaneWriteBin ?? 'wb-pane-write',
    wbFreigabeBin: env.AWB_WB_FREIGABE ?? file.wbFreigabeBin ?? 'wb-freigabe',
    // Nur ueber die Umgebung, NICHT ueber die Konfigurationsdatei: eine
    // Attrappe gehoert einem Testlauf, nicht einer Einstellung, die jemand
    // versehentlich stehen laesst.
    ordnerDialogAttrappe: env.AWB_ORDNER_DIALOG ?? '',
    chatBefehl: env.AWB_CHAT_CMD ?? file.chatBefehl ?? 'claude',
    rueckfrageAttrappe: env.AWB_RUECKFRAGE ?? '',
    stateDir: env.AWB_STATE_DIR ?? file.stateDir ?? join(homedir(), '.config', 'agent-workbench'),
    resultsDir: env.AWB_RESULTS_DIR ?? file.resultsDir ?? join(homedir(), '.pi-workers', 'results'),
    projectsDir: env.AWB_PROJECTS_DIR ?? file.projectsDir ?? join(homedir(), '.claude', 'projects'),
    stallSeconds: num(env.AWB_STALL_SECONDS, zahlAus('stallMinutes', 1, 120, einstellungen) * 60),
    modelsFile: env.AWB_MODELS_FILE ?? file.modelsFile ?? join(homedir(), '.claude', 'workbench', 'models.json'),
    excludeGlobs: (env.AWB_EXCLUDE_GLOBS?.split(',').map((s) => s.trim()).filter(Boolean))
      ?? file.excludeGlobs
      ?? [
        '**/90-secrets', '**/90-secrets/**',
        '**/.ssh', '**/.ssh/**',
        '**/.env', '**/.env.*',
        '**/id_rsa', '**/id_ed25519', '**/id_ecdsa',
        '**/*.pem', '**/*.p12', '**/*.pfx',
        '**/credentials.json', '**/service-account*.json', '**/secrets.yaml', '**/secrets.yml',
      ],
    askPatterns: askMusterAusEinstellungen(einstellungen),
    askGrantsDir: env.AWB_GUARD_GRANTS_DIR ?? file.askGrantsDir ?? join(homedir(), '.pi-workers', 'guard-grants'),
    askGrantTtlSeconds: num(env.AWB_ASK_GRANT_TTL, file.askGrantTtlSeconds ?? 300),
    settingsFile: einstellungen,
    configFile: configFilePath(env),
    // Der Rechnername kommt aus der Umgebung, nie aus dem Quelltext. Nur der
    // erste Namensteil, damit in der Leiste keine ganze Adresse steht.
    machine: env.AWB_MACHINE ?? file.machine ?? hostname().split('.')[0],
    // KEINE eingebaute Vorgabe: ein SSH-Ziel ist ein echter Netzzugriff, und
    // der darf nie von selbst anspringen. Gemessen am 05.08.: ein Testlauf mit
    // umgeleitetem HOME holte trotzdem sechs ECHTE Sessions von peer, weil
    // weder Tailscales MagicDNS-Aufloesung von "peer" noch ein laufender
    // ssh-agent an $HOME haengen -- beide ueberleben eine HOME-Umleitung
    // unveraendert. Wer die zweite Maschine will, traegt sie ausdruecklich ein;
    // leer bleibt leer. Seit dem 06.08. steht die Liste in der GETEILTEN Datei,
    // weil die Maschinen-Seite des Menues sie pflegt und der einzige
    // Schreibweg dorthin `wb-state settings set` ist.
    remoteMachines: (env.AWB_REMOTE_MACHINES !== undefined
      ? env.AWB_REMOTE_MACHINES.split(',').map((s) => s.trim()).filter(Boolean)
      : maschinenliste(einstellungen)),
    remotePollMs: num(env.AWB_REMOTE_POLL_MS, file.remotePollMs ?? 10000),
    remoteTimeoutMs: num(env.AWB_REMOTE_TIMEOUT_MS, file.remoteTimeoutMs ?? 6000),
    testsuiteStatusFile: env.AWB_TESTSUITE_STATUS_FILE ?? file.testsuiteStatusFile ?? join(homedir(), '.local', 'state', 'wb-testsuite-status.txt'),
    hygieneStatusFile: env.AWB_HYGIENE_STATUS_FILE ?? file.hygieneStatusFile ?? join(homedir(), '.local', 'state', 'wb-hygiene-status.txt'),
    budgetPollMs: num(env.AWB_BUDGET_POLL_MS, file.budgetPollMs ?? 300000),
    budgetTimeoutMs: num(env.AWB_BUDGET_TIMEOUT_MS, file.budgetTimeoutMs ?? 20000),
    budgetBin: env.AWB_BUDGET_BIN ?? file.budgetBin ?? 'wb-budget',
    minPaneCols: num(env.AWB_MIN_PANE_COLS, zahlAus('minWorkerPaneWidth', 20, 1000, einstellungen)),
    minPaneRows: num(env.AWB_MIN_PANE_ROWS, file.minPaneRows ?? 12),
    maxWorkersPerTab: num(env.AWB_MAX_WORKERS_PER_TAB, zahlAus('maxWorkerPanesPerTab', 0, 64, einstellungen)),
    startShot: flag('startfoto') ?? env.AWB_START_SHOT ?? '',
  };
}
