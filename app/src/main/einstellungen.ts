// Die Einstellungen der Workbench, gelesen aus derselben Datei, die auch
// `wb-state settings get` beantwortet: ~/.claude/workbench/settings.json.
//
// GESCHRIEBEN WIRD HIER NICHTS. Für das Schreiben gibt es genau einen Weg,
// `wb-state settings set`, und der nimmt die mkdir-Sperre, die sich Shell und
// Node teilen (siehe den Kommentar dort: eine Sperrart, absichtlich). Wer hier
// direkt in die Datei schriebe, umginge sie -- und die Sperre ist gemessen,
// nicht angenommen (shell/tests/test-settings-lock.sh).
//
// WARUM DIESE DATEI ÜBERHAUPT: Plan 4c.2 verlangt, dass die Ausschlussliste für
// Geheimnisse in den EINSTELLUNGEN steht und nicht im Code -- "damit sie
// sichtbar und prüfbar ist, und nicht im Code, wo sie niemand findet". Der
// Editor hatte sie als zwei Konstanten in `editor.ts`, weil es die Einstellungen
// in dieser Anwendung noch nicht gab. Jetzt gibt es sie.
//
// F5 aus dem Fehler-Durchgang gehört dazu: Die Sperre sitzt eine Ebene tiefer
// als der Dateibaum. Editor, Schnellöffner, Inhaltssuche und Ordneransicht
// fragen dieselbe Stelle -- `istAusgeschlossen()` --, statt jede ihre eigene
// Liste zu führen. Ein Filter, den eine Ansicht umgehen kann, ist keiner.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// Die Stillstandsschwelle steht mit ihrer Messung an EINER Stelle. Die Vorgabe
// unten rechnet sie in Minuten um, statt die Zahl ein zweites Mal zu nennen.
import { STALL_SECONDS_DEFAULT } from './workerstate';
// Die Vorgabe je Rolle wird dort gedeutet, wo auch die Aufloesungsregel steht:
// eine reine Datei ohne Electron, ohne Dateizugriff (chat/ansichtsregel.ts).
import { chatVorgabeAus, type ChatVorgabe } from '../chat/ansichtsregel';

/**
 * Die Vorgaben stehen ZWEIMAL: hier und in `shell/wb-state` (DEFAULTS im
 * settings-Zweig). Das ist kein Versehen, sondern dieselbe Bauform wie bei
 * `models.default.json` gegenüber den BUILTIN-Tabellen -- beide Programme
 * müssen ohne das jeweils andere anlaufen können. Maßgeblich ist die Datei;
 * diese Werte greifen nur, solange dort nichts steht.
 *
 * Wer sie ändert, ändert BEIDE Stellen. Die Suite prüft genau das.
 */
export const VORGABE_AUSSCHLUSS_ORDNER: readonly string[] = [
  '90-secrets', '.ssh', '.gnupg',
  'node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'venv',
  '.mypy_cache', '.pytest_cache', '.next', '.turbo', 'target',
];

export const VORGABE_AUSSCHLUSS_MUSTER: readonly string[] = [
  '.env', '.env.*', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*',
  '*credentials*', '*.p12', '*.pfx', '*.keystore', '*.jks',
];

/**
 * Ein Eintrag der Rueckfrage-Stufe. Er beschreibt eine STELLE in der zerlegten
 * Befehlszeile, nicht eine Zeichenkette irgendwo im Text -- sonst hielte schon
 * das Schreiben ueber einen riskanten Befehl den Guard an (Befund 2026-08-05:
 * ein Absatz fuer SESSION-STATE.md, der den git-Aufraeumbefehl als Beispiel
 * nennt, wurde angehalten, obwohl nur eine Datei geschrieben wurde).
 *
 * Stand hier bis zum 06.08. in `config.ts`, zusammen mit der Vorgabeliste. Er
 * ist mit der Liste umgezogen: die Muster gehoeren seit heute in die GETEILTE
 * Einstellungsdatei, weil das Menue sie einzeln abschalten koennen muss und
 * der einzige Schreibweg dorthin `wb-state settings set` ist.
 */
export interface AskMuster {
  /** Regulaerer Ausdruck auf den NAMEN des Befehls (vollstaendig, ohne Pfad). Pflicht. */
  befehl: string;
  /** Optional: muss als GANZES Argument-Token vorkommen -- eine Zeichenkette in Anfuehrungszeichen ist nach der Zerlegung EIN Token. */
  unterbefehl?: string;
  /** Optional: regulaerer Ausdruck ueber die Argumente. */
  muster?: string;
  /** Der eine Satz, der in der Ansicht erklaert, warum gefragt wird. */
  grund: string;
  /**
   * Einzeln abgeschaltet (alice, 06.08.: "jeder Eintrag ist einzeln an- und
   * abschaltbar"). Der Eintrag bleibt in der Liste stehen und wirkt nicht --
   * anders als beim Loeschen sieht man danach noch, dass es ihn gab.
   */
  aus?: boolean;
}

/**
 * Die mitgelieferte Rueckfrage-Liste. Jeder Eintrag ist ein Befehl, der HEUTE
 * durch alle acht Guards laeuft (gemessen gegen hooks/bash-guard.py) und
 * trotzdem eine Frage wert ist. Wortgleich zu STANDARD_MUSTER in
 * hooks/lib/ask_muster.py -- dieselbe Bauform wie bei den Ausschlusslisten
 * darueber, damit Hook und Programm einzeln lauffaehig bleiben.
 * shell/tests/test-app-muster.sh vergleicht beide Kopien gegeneinander.
 */
export const VORGABE_ASK_MUSTER: readonly AskMuster[] = [
  { befehl: 'sudo', grund: 'Laeuft mit Systemrechten -- ausserhalb dessen, was ein Auftrag ueblich macht.' },
  { befehl: 'chmod', muster: '(^|\\s)-[A-Za-z]*R(\\s|$)', grund: 'Aendert Rechte eines ganzen Baums auf einmal.' },
  { befehl: 'chmod', muster: '(^|\\s)0?777(\\s|$)', grund: 'Gibt Schreibrecht an alle.' },
  { befehl: 'chown', muster: '(^|\\s)-[A-Za-z]*R(\\s|$)', grund: 'Uebereignet einen ganzen Baum an einen anderen Besitzer.' },
  { befehl: 'git', unterbefehl: 'push', muster: '(^|\\s)(--force|--force-with-lease|-f)(\\s|$)', grund: 'Ueberschreibt veroeffentlichte Geschichte -- nach dem Druecken nicht zurueckzuholen.' },
  { befehl: 'git', unterbefehl: 'reset', muster: '(^|\\s)--hard(\\s|$)', grund: 'Verwirft uncommittete Arbeit ohne Nachfrage.' },
  { befehl: 'git', unterbefehl: 'clean', muster: '(^|\\s)-[A-Za-z]*f[A-Za-z]*(\\s|$)', grund: 'Loescht nicht versionierte Dateien im Arbeitsbaum.' },
  { befehl: 'npm|pnpm|yarn|cargo', unterbefehl: 'publish', grund: 'Veroeffentlicht nach aussen -- eine Version draussen laesst sich nicht zurueckziehen.' },
  { befehl: 'twine', unterbefehl: 'upload', grund: 'Veroeffentlicht nach aussen -- eine Version draussen laesst sich nicht zurueckziehen.' },
  { befehl: 'gh', unterbefehl: 'release', muster: '(^|\\s)create(\\s|$)', grund: 'Veroeffentlicht nach aussen -- eine Version draussen laesst sich nicht zurueckziehen.' },
  { befehl: 'launchctl', unterbefehl: 'unload|bootout|disable|remove', grund: 'Haelt einen Hintergrunddienst an, der danach nicht von selbst wiederkommt.' },
  { befehl: 'crontab', muster: '(^|\\s)-[A-Za-z]*r(\\s|$)', grund: 'Loescht die gesamte Zeitplan-Tabelle.' },
  { befehl: 'diskutil', unterbefehl: 'erase[A-Za-z]*|reformat|partitionDisk', grund: 'Legt einen Datentraeger neu an -- der Inhalt ist danach weg.' },
  { befehl: 'mkfs(\\.[A-Za-z0-9]+)?', grund: 'Legt ein Dateisystem neu an -- der Inhalt ist danach weg.' },
];

/**
 * Die vier Protokoll-Pfade, die die Protokolle-Ansicht ohne eigene Konfiguration
 * zeigt. Sie stehen HIER und nicht in `protokolle.ts`, obwohl sie nur dort
 * gebraucht werden: `protokolle.ts` liest bereits aus dieser Datei, und die
 * Gegenrichtung waere ein Ring -- bei dem die Vorgabe unten je nach Ladereihen-
 * folge `undefined` waere. Zweite Stelle: DEFAULTS in `shell/wb-state`.
 */
export const VORGABE_PROTOKOLLE: readonly { label: string; path: string }[] = [
  { label: 'Guard-Log', path: '~/.pi-workers/guard-blocks.log' },
  { label: 'Hygiene-Bericht', path: '~/.local/state/wb-hygiene-report.md' },
  { label: 'Testlauf-Bericht', path: '~/.local/state/wb-testsuite-report.md' },
  { label: 'SESSION-STATE', path: '~/AI/claude-workbench/SESSION-STATE.md' },
];

/**
 * DIE AUSLIEFERUNG, an EINER Stelle im Programm. Sie beantwortet zwei Fragen,
 * die das Menue stellt: "weicht dieser Wert von der Vorgabe ab?" (dann traegt
 * die Zeile ihr Rueckstell-Zeichen) und "worauf stelle ich zurueck?".
 *
 * Sie steht ZWEIMAL -- hier und als DEFAULTS in `shell/wb-state` --, aus
 * demselben Grund wie die Ausschlusslisten darueber: beide Programme muessen
 * ohne das jeweils andere anlaufen. Wer sie aendert, aendert BEIDE Stellen.
 */
export const VORGABEN: Readonly<Record<string, unknown>> = {
  // Sitzungen
  //
  // AUS SEIT DEM 07.08. Wort des Nutzers: „Ich will nicht, dass die Sessions
  // beendet werden durch Schließen der App, dafür ist der Rechtsklick auf die
  // Session da." Der Schalter bleibt -- der Grund fuer ihn ist gemessen und
  // faellt nicht weg: drei vergessene Fenster hielten am 04.08. ihre
  // tmux-Sitzungen am Leben und zusammen 6,0 GB belegt. Er wiegt nur weniger
  // als das Gegenteil: belegter Speicher laesst sich jederzeit zurueckholen
  // (Rechtsklick, „Sitzung schließen"), eine versehentlich beendete Sitzung
  // samt laufender Arbeit nicht. Wer den alten Weg will, schaltet ihn ein.
  closeSessionOnWindowClose: false,
  orchestratorHarness: 'claude',
  orchestratorModel: 'claude-opus-5',
  orchestratorEffort: 'xhigh',
  // 2026-08-11: `workerLayout`, `newSessionDefaultDir` und `modelDiscoveryAuto`
  // standen bis heute NUR in der VS-Code-Erweiterung, obwohl dieses Programm
  // und die Werkzeuge sie laengst lesen. Sie sind in das Menue gewandert
  // (Seiten "Aussehen", "Sitzung", "Programme und Modelle").
  //
  // ZWEI SIND DABEI VERSCHWUNDEN, und beide aus demselben Grund -- ein
  // Schalter, den niemand liest, ist schlimmer als ein fehlender:
  //   * `workerPollSeconds` war nie eine Worker-Einstellung, sondern der
  //     Abfragetakt der Sidebar der Erweiterung. Die Erweiterung fuehrt ihre
  //     eigene Vorgabe (extension/src/settings.ts), `wb-ereignisse` faellt ohne
  //     den Schluessel auf seine eingebauten 2 Sekunden zurueck.
  //   * `terminalStartMaximized` wirkt ausschliesslich in der Erweiterung
  //     (extension/src/extension.ts, maximizePanel); dieses Programm hat keine
  //     Stelle, die es liest. Es hier anzubieten hiesse, einen wirkungslosen
  //     Haken zu zeigen.
  workerLayout: 'split',
  newSessionDefaultDir: '~/AI',
  modelDiscoveryAuto: true,
  // Worker. Die beiden folgenden stehen seit dem 11.08. NICHT mehr im Menue:
  // der Orchestrator nennt Modell und Denkstufe in jedem Spawn-Befehl selbst,
  // gelesen werden sie nur vom Zweig `default` in shell/pi-worker, den ein
  // Mensch am rohen Befehl trifft. Zu setzen sind sie weiterhin, nur eben dort:
  // `wb-state settings set workerModel <id>` und
  // `wb-state settings set workerEffort <stufe>`.
  workerModel: 'claude-sonnet-5',
  workerEffort: 'high',
  // Multi-Token-Vorhersage (2026-08-20, Vorgaben des Nutzers): AN/AUS getrennt
  // je Rolle, WELCHES Modell dabei benutzt wird, steht in der Registry
  // (Feld 'vorhersage' je Modell, siehe extension/src/models.ts) und ist
  // hier nicht einstellbar -- "die Zuordnung gehoert zur Auslieferung, nicht
  // in die Oberflaeche". Vorgabe AUS: spekulatives Decoding und die
  // gemeinsame MLX-Server-Nebenlaeufigkeit sind ein Entweder-oder
  // (`is_batchable = draft_model is None` in mlx_lm.server, siehe
  // shell/wb-mlx-server), ein stillschweigend eingeschalteter Schalter
  // wuerde also unbemerkt Durchsatz kosten. Zweite Stelle: DEFAULTS in
  // shell/wb-state.
  orchestratorVorhersage: false,
  workerVorhersage: false,
  maxWorkers: 8,
  workerWorktrees: true,
  defaultWorkerMachine: 'local',
  // Die zusammengelegte Doublette (06.08.). 6 ist gemessen (2 Spalten a 80
  // Spalten x 3 Reihen lesbarer Hoehe auf dem Bezugsfenster 197x54); die 8 aus
  // der alten Programmdatei war es nicht.
  maxWorkerPanesPerTab: 6,
  minWorkerPaneWidth: 80,
  // Programm-Schriftgroesse der Terminals in Pixeln (06.08.). Sie stand bis
  // dahin fest im Renderer und gehoert dorthin, wo der Mensch sie erreicht.
  terminalFontSize: 13,
  // Wieviele Zeilen EINE Rad-Rasterung bewegt (06.08.). Vorher fiel das aus der
  // Zellhoehe und dem Geraet -- ein Trackpad rollte anders als eine Maus, und
  // eine kleinere Schrift rollte schneller. Drei Zeilen sind die uebliche
  // Rasterung; wem es zu langsam ist, der stellt es hier hoch.
  terminalScrollLines: 3,
  // Aufsicht
  contextGuardAutostart: true,
  // Die Wache je Rolle und die einzelnen Guards stehen NICHT hier, sondern
  // unter `kontextwache` und `guards`, und werden ueber `wb-state wache` und
  // `wb-state guard` gesetzt: sie tragen Grund, Datum und Rolle, was ein
  // flacher Schalter nicht kann. Bis zum 06.08. standen an dieser Stelle vier
  // eigene Schluessel derselben Bedeutung -- die Oberflaeche schrieb sie, und
  // kein Werkzeug las sie. Ein wirkungsloser Schalter ist schlimmer als ein
  // fehlender: der fehlende ist sichtbar.
  //
  // 2026-08-11: `guardOrchWarnPct` und `guardWorkerWarnPct` sind hier
  // GESTRICHEN. Sie waren der zweite Schreibweg fuer dieselbe Wirkung -- nur
  // die VS-Code-Erweiterung bot sie an, und im Code gewinnt ohnehin
  // `kontextwache.mahnenAb` (shell/context-guard, resolve_pct). Zwei
  // Oberflaechen fuer eine Zahl heissen: ein Mensch, der beide benutzt, kann
  // nicht wissen, welche gilt. Der Rueckfall in context-guard bleibt bestehen,
  // er greift nur nicht mehr auf eine mitgelieferte Vorgabe zurueck, sondern
  // ausschliesslich auf einen von Hand gesetzten Wert.
  stallMinutes: STALL_SECONDS_DEFAULT / 60,
  // Tippt der Kontext-Wachprozess von sich aus etwas ueber den STATUS eines
  // Workers in den Orchestrator-Pane -- die Fertigmeldung und die
  // Haengt-Meldung? Vorgabe AUS: es sieht aus wie eigenes des Nutzers Wort,
  // unterbricht ihn, und dieselbe Information steht in der rechten Leiste.
  // Gelesen wird der Schluessel von shell/context-guard ueber `wb-state
  // settings get`; hier steht er, seit er am 07.08. beim Paritaetsvergleich als
  // einseitig auffiel -- ohne diese Zeile zeigt die Liste "was bei dir anders
  // ist" ausgerechnet eine Meldeeinstellung nicht an. Zweite Stelle: DEFAULTS
  // in shell/wb-state.
  guardMeldetWorkerStatus: false,
  workerSkipPermissions: true,
  // Der Zustellweg zum Worker (2026-08-20). Zweite Stelle: DEFAULTS in
  // shell/wb-state, dort steht auch, was die drei Werte bedeuten.
  workerZustellung: 'auto',
  // Die vierte Sicherung, die ein MENSCH lockert (2026-08-16). SENKEN -- jeder
  // Wechsel weg von 'bypassPermissions' -- geht immer und ohne Grund; nur das
  // ANHEBEN zurueck auf die staerkste Stufe verlangt einen Grund und einen
  // echten Menschen, geprueft in `wb-state` selbst (siehe befehle.ts,
  // 'permission-mode-set'). `shell/wb-code` liest den Wert beim Start der
  // naechsten Orchestrator-Sitzung. Zweite Stelle: DEFAULTS in shell/wb-state.
  orchestratorPermissionMode: 'bypassPermissions',
  askPatterns: VORGABE_ASK_MUSTER,
  // Die drei Namensraeume, die den WERKZEUGEN gehoeren. Sie stehen hier NICHT,
  // damit das Menue sie liest -- das tut es ueber `wb-state guard|wache|models
  // cap` -- sondern damit die Liste "was bei dir anders ist" sie zeigen kann.
  // Ihre Vorgabe ist "nichts gesetzt", und die Abweichung ist deshalb nicht
  // "der Wert ist ein anderer", sondern "hier steht ueberhaupt etwas". Ohne
  // diese drei Zeilen fehlten ausgerechnet die drei sicherheitsnahen: ein
  // abgeschalteter Guard, eine gelockerte Wache, ein angehobener Deckel
  // (Befund 06.08.). Werte wortgleich zu DEFAULTS in `shell/wb-state`.
  effortCaps: {},
  guards: {},
  kontextwache: {
    orchestrator: { an: true, eingreifen: true, mahnenAb: 75, notbremseAb: 80 },
    worker: { an: true, eingreifen: true, mahnenAb: 80 },
  },
  // Programm
  secretExcludeDirs: VORGABE_AUSSCHLUSS_ORDNER,
  secretExcludePatterns: VORGABE_AUSSCHLUSS_MUSTER,
  // Ohne diesen Eintrag konnte "was bei dir anders ist" zu `logPaths` nichts
  // sagen, obwohl die Datei den Wert tragen kann.
  logPaths: VORGABE_PROTOKOLLE,
  // Maschinen. Leer bleibt leer: ein SSH-Ziel ist ein echter Netzzugriff und
  // darf nie von selbst anspringen (gemessen 05.08., siehe config.ts).
  remoteMachines: [],
  // --- 2026-08-11, SPEC-V4 Abschnitt 3: die sieben neuen Schluessel ---------
  //
  // Die Adresse des lokalen Modell-Servers. Sie stand an sieben Stellen fest im
  // Quelltext (shell/wb-state, shell/models.default.json, shell/pi-worker,
  // shell/crushrc.default, shell/wb-dod, shell/cline-providers.default.json,
  // shell/kimi-config.default.toml) und war nirgends einstellbar; wer Ollama
  // auf einem anderen Rechner betreibt, musste sieben Dateien von Hand aendern.
  // Hier ist die eine Stelle. Die sieben Fundstellen ziehen in einem eigenen
  // Schritt nach -- bis dahin ist dieser Wert die Wahrheit der Oberflaeche und
  // noch nicht die des Abrufs.
  ollamaEndpoint: 'http://127.0.0.1:11434',
  // Benachrichtigungen nach aussen. Bis zum 11.08. meldete sich das Programm
  // nie: keine Fundstelle fuer osascript, notify-send oder Notification(). Die
  // Form dieses Blocks ist VORGEGEBEN, damit Oberflaeche und Sendeweg dasselbe
  // meinen -- die Oberflaeche steht hier, das Senden baut `melden.ts`, das
  // diese sechs Felder nur liest. E-Mail ist ausdruecklich KEIN Weg.
  //
  // `an` ist die eine Frage, an der alles haengt, und sie steht auf AUS: ein
  // Programm, das ungefragt anfaengt zu klingeln, waere ein schlechterer
  // Zustand als eines, das schweigt. Die Listen sind die empfohlene Auswahl
  // fuer den Vergleich mit `wb-state settings defaults` (test-vorgaben-paritaet.sh)
  // -- der Leser `meldungen()` unten fuellt sie NICHT automatisch ein, wenn im
  // gespeicherten Block `ereignisse`/`wege` fehlen: siehe dort, warum (Fund 3
  // vom 11.08., dieselbe Lesart wie `melden.ts`).
  meldungen: {
    an: false,
    ereignisse: ['workerFertig', 'freigabeWartet', 'sitzungTot', 'limitFastVoll'],
    wege: ['system'],
    /** Ein Webhook, den der Mensch selbst eintraegt. Leer heisst: kein Handy. */
    handyUrl: '',
    /** Leer heisst: der Systemton. */
    tonDatei: '',
    /** Ab wieviel Prozent des Kontingents gemeldet wird. */
    limitSchwelle: 85,
  },
  // Die Sprache der Oberflaeche (SPEC-V4 Abschnitt 4: Englisch als Vorgabe).
  // Deutsch und Englisch tragen seit dem 11.08. beide eine vollstaendige
  // Tabelle (app/src/einstellungen/texte.ts, app/src/verbrauch/texte.ts,
  // app/src/sitzung/texte.ts) -- deshalb erst jetzt die Vorgabe gedreht.
  sprache: 'en',
  // Hell, dunkel oder wie das Betriebssystem. Wirkt heute im
  // Einstellungsfenster; die uebrigen Fenster ziehen nach, sobald ihre Farben
  // aus derselben Quelle kommen.
  thema: 'system',
  // Die Farben der vier Sitzungszustaende. Sie muessen sich fuer den Menschen
  // unterscheiden, der davorsitzt -- wer Rot und Gruen schlecht auseinanderhaelt,
  // stellt hier zwei ein, die er sieht.
  zustandsfarben: {
    laeuft: '#4ea1ff',
    wartet: '#e0a33e',
    fertig: '#3fa66a',
    tot: '#c25b5b',
  },
  // Die Chat-Ansicht je Harness (SPEC-V4 Abschnitt 6). Leer heisst: ueberall
  // das Terminalbild. Ob ein Harness es ueberhaupt kann, steht NICHT hier,
  // sondern im `session`-Block seines Registry-Eintrags -- eine Einstellung
  // beschreibt einen Wunsch, keine Faehigkeit.
  chatAnsicht: {},
  // Die Vorgabe je ROLLE (12.08.). Bis dahin stand hier EIN Wahrheitswert fuer
  // alle Panes; alice will Orchestrator und Worker getrennt einstellen
  // koennen. Ein alter einzelner Wert in einer bestehenden Datei gilt weiter
  // fuer beide Rollen -- gedeutet wird er in `chatVorgabeAus`
  // (app/src/chat/ansichtsregel.ts). Zweite Stelle: DEFAULTS in shell/wb-state.
  chatAnsichtVorgabe: { orchestrator: false, worker: false },
  // Der geführte erste Start (SPEC-V4 3.8): kein Schalter im Menü, sondern der
  // Beleg, dass der Weg schon einmal gelaufen ist. Vorgabe FALSE -- eine frisch
  // ausgelieferte Werkbank hat ihn noch nicht gesehen. Zweite Stelle: DEFAULTS
  // in shell/wb-state (test-vorgaben-paritaet.sh vergleicht beide). Gesetzt
  // wird er ausschließlich durch den Erststart-Weg selbst (erststartfenster.ts,
  // genau einmal beim Abschluss) -- von Hand zurückgesetzt mit
  // `wb-state settings set erststartErledigt false`, danach erscheint der Weg
  // beim nächsten Start erneut.
  erststartErledigt: false,
};

export function einstellungenPfad(env: NodeJS.ProcessEnv = process.env): string {
  return env.AWB_SETTINGS_FILE ?? join(homedir(), '.claude', 'workbench', 'settings.json');
}

const merker = new Map<string, { mtimeMs: number; size: number; werte: Record<string, unknown> }>();

/**
 * Alle Einstellungen. Gelesen wird nur, wenn sich die Datei geändert hat -- die
 * Oberfläche fragt im Zwei-Sekunden-Takt, und eine fehlende oder kaputte Datei
 * ist kein Fehler, sondern heißt "es gelten die Vorgaben" (dieselbe Haltung wie
 * in `wb-state`: ein erster Start ohne alles muss laufen).
 */
export function alleEinstellungen(pfad = einstellungenPfad()): Record<string, unknown> {
  let st: { mtimeMs: number; size: number };
  try {
    const s = statSync(pfad);
    st = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return {};
  }
  const alt = merker.get(pfad);
  if (alt && alt.mtimeMs === st.mtimeMs && alt.size === st.size) return alt.werte;
  let werte: Record<string, unknown> = {};
  try {
    const roh = JSON.parse(readFileSync(pfad, 'utf8')) as unknown;
    if (roh && typeof roh === 'object' && !Array.isArray(roh)) werte = roh as Record<string, unknown>;
  } catch {
    // Eine halb geschriebene oder kaputte Datei darf die Oberfläche nicht
    // anhalten. Sie heißt hier dasselbe wie eine fehlende: Vorgaben.
  }
  merker.set(pfad, { ...st, werte });
  return werte;
}

/** Nur für Tests: erneut von der Platte lesen. */
export function merkerLeeren(): void {
  merker.clear();
}

function listeAus(wert: unknown, vorgabe: readonly string[]): string[] {
  if (Array.isArray(wert) && wert.every((x) => typeof x === 'string')) return wert as string[];
  return [...vorgabe];
}

/** Verzeichnisse, die keine Ansicht betritt. */
export function ausschlussOrdner(pfad = einstellungenPfad()): string[] {
  return listeAus(alleEinstellungen(pfad).secretExcludeDirs, VORGABE_AUSSCHLUSS_ORDNER);
}

/** Dateimuster, die keine Ansicht zeigt. */
export function ausschlussMuster(pfad = einstellungenPfad()): string[] {
  return listeAus(alleEinstellungen(pfad).secretExcludePatterns, VORGABE_AUSSCHLUSS_MUSTER);
}

/**
 * Ein Glob auf EINEN Namensteil, ohne Pfadtrenner: `*` steht für beliebig
 * viele Zeichen, `?` für eines. Bewusst klein gehalten -- die Liste soll ein
 * Mensch in den Einstellungen lesen und beurteilen können, und ein voller
 * Glob-Dialekt mit `**` und `{a,b}` lädt zu Mustern ein, deren Wirkung man
 * nicht mehr sieht.
 */
function passt(name: string, muster: string): boolean {
  const re = new RegExp(
    '^' + muster.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    'i',
  );
  return re.test(name);
}

/**
 * DIE eine Stelle, die für einen Pfad entscheidet, ob eine Ansicht ihn anfassen
 * darf (F5). Geprüft wird JEDER Namensteil -- ein Ordner mitten im Pfad zählt
 * genauso wie der letzte Teil, sonst käme `projekt/.ssh/config` durch.
 *
 * Der Pfad darf absolut oder relativ übergeben werden; getrennt wird an beiden
 * Trennzeichen, damit auch ein Windows-artiger Pfad nicht durchrutscht.
 */
export function istAusgeschlossen(
  pfad: string,
  ordner: readonly string[] = ausschlussOrdner(),
  muster: readonly string[] = ausschlussMuster(),
): boolean {
  const teile = pfad.split(/[\\/]+/).filter(Boolean);
  const ordnerSatz = new Set(ordner);
  for (const teil of teile) {
    if (ordnerSatz.has(teil)) return true;
    for (const m of muster) if (passt(teil, m)) return true;
  }
  return false;
}

/**
 * Beides in einem Aufruf, für Ansichten, die viele Pfade hintereinander prüfen
 * (Dateibaum, Inhaltssuche, Schnellöffner). Die Listen werden EINMAL geholt und
 * danach nicht mehr angefasst -- sonst liest jeder Pfad die Einstellungen neu.
 *
 * Aufruf:  const filter = ausschlussFilter();  if (filter(pfad)) continue;
 */
export function ausschlussFilter(pfad = einstellungenPfad()): (p: string) => boolean {
  const ordner = ausschlussOrdner(pfad);
  const muster = ausschlussMuster(pfad);
  return (p: string) => istAusgeschlossen(p, ordner, muster);
}

// --- Die GETEILTEN Werte, typisiert ----------------------------------------
//
// Seit dem 06.08. hat jeder Schluessel GENAU EIN Zuhause (des Nutzers
// Entscheidung, Aufteilung nach Zustaendigkeit):
//
//   ~/.claude/workbench/settings.json   was Programm und wb-*-Werkzeuge
//                                       GEMEINSAM meinen -- hier gelesen,
//                                       geschrieben nur ueber `wb-state`
//   ~/.config/agent-workbench/config.json   was nur dieses Programm zum
//                                       Hochfahren braucht: Pfade, Socket,
//                                       Maschinenkennung
//
// Die beiden Doubletten sind damit weg: `maxWorkersPerTab` (8) und
// `minPaneCols` (80) aus der Programmdatei sind aufgegangen in
// `maxWorkerPanesPerTab` (6) und `minWorkerPaneWidth` (80) der geteilten
// Datei. Bei der Paneszahl je Tab gewinnt die 6, weil nur sie eine Messung
// hinter sich hat; die abgeleitete Kapazitaet aus Fenstergroesse und
// Mindestbreite deckelt ohnehin zuerst, sobald das Fenster klein ist.

/** Eine Zahl aus den Einstellungen, mit Bereichspruefung und Vorgabe. */
export function zahlAus(key: string, min: number, max: number, pfad = einstellungenPfad()): number {
  const roh = alleEinstellungen(pfad)[key];
  const n = typeof roh === 'number' ? Math.floor(roh) : NaN;
  if (Number.isFinite(n) && n >= min && n <= max) return n;
  return Number(VORGABEN[key] ?? min);
}

/** Ein Schalter aus den Einstellungen. Alles, was nicht boolesch ist, heisst "Vorgabe". */
export function schalterAus(key: string, pfad = einstellungenPfad()): boolean {
  const roh = alleEinstellungen(pfad)[key];
  if (typeof roh === 'boolean') return roh;
  return VORGABEN[key] === true;
}

/** Eine Zeichenketten-Liste aus den Einstellungen. */
export function textlisteAus(key: string, pfad = einstellungenPfad()): string[] {
  const roh = alleEinstellungen(pfad)[key];
  if (Array.isArray(roh) && roh.every((x) => typeof x === 'string')) return roh as string[];
  return [...((VORGABEN[key] as readonly string[] | undefined) ?? [])];
}

/**
 * Die Rueckfrage-Muster. Eine fehlende oder unlesbare Liste heisst "Vorgabe
 * gilt", nicht "Stufe aus" -- dieselbe Haltung wie im Hook
 * (hooks/lib/ask_muster.py): eine Sicherung, die sich durch das Loeschen einer
 * Datei abschalten laesst, waere keine. Eine AUSDRUECKLICH leere Liste ist
 * dagegen eine Entscheidung und wird respektiert.
 */
export function askMuster(pfad = einstellungenPfad()): AskMuster[] {
  const roh = alleEinstellungen(pfad).askPatterns;
  if (!Array.isArray(roh)) return VORGABE_ASK_MUSTER.map((m) => ({ ...m }));
  const raus: AskMuster[] = [];
  for (const e of roh) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const o = e as Record<string, unknown>;
    const befehl = typeof o.befehl === 'string' ? o.befehl : '';
    if (!befehl) continue;
    const neu: AskMuster = { befehl, grund: typeof o.grund === 'string' ? o.grund : '' };
    if (typeof o.unterbefehl === 'string' && o.unterbefehl) neu.unterbefehl = o.unterbefehl;
    if (typeof o.muster === 'string' && o.muster) neu.muster = o.muster;
    if (o.aus === true) neu.aus = true;
    raus.push(neu);
  }
  return raus;
}

/** Fernmaschinen (V10). Ihr Name IST der SSH-Alias. */
export function maschinenliste(pfad = einstellungenPfad()): string[] {
  return textlisteAus('remoteMachines', pfad);
}

// --- Die sieben Schluessel vom 11.08., je mit ihrem Leser -------------------
//
// JEDE dieser Funktionen ist die eine Stelle, an der ihr Schluessel gelesen
// wird. Sie stehen hier und nicht in der Oberflaeche, und das ist kein
// Ordnungsgeschmack: `wb-consistency` (Check 6) zaehlt einen Fund im Menue
// ausdruecklich NICHT als Leser -- sonst saehe jeder tote Schalter lebendig
// aus. Ein Schluessel, dessen einziger Leser das Menue ist, das ihn schreibt,
// tut nichts.

/**
 * Die Adresse des lokalen Modell-Servers.
 *
 * Geprueft wird die FORM, nicht die Erreichbarkeit: eine Adresse zu pruefen
 * hiesse, beim Zeichnen des Fensters ins Netz zu gehen, und das tut dieses
 * Programm nie von selbst. Was nicht nach einer Adresse aussieht, faellt auf
 * die Vorgabe zurueck -- ein leeres Feld waere sonst eine stille Abschaltung
 * aller lokalen Modelle.
 */
export function ollamaEndpunkt(pfad = einstellungenPfad()): string {
  const roh = alleEinstellungen(pfad).ollamaEndpoint;
  const wert = typeof roh === 'string' ? roh.trim().replace(/\/+$/, '') : '';
  if (/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(wert)) return wert;
  return String(VORGABEN.ollamaEndpoint);
}

/**
 * Was gemeldet wird und auf welchem Weg.
 *
 * Die FORM ist vorgegeben und wird von zwei Seiten gelesen: von der Oberflaeche
 * (Seite "Aufsicht und Meldungen") und vom Sendeweg. Wer sie aendert, aendert
 * beide -- deshalb steht sie hier als Typ und nicht als loses Objekt.
 */
export interface MeldeEinstellung {
  an: boolean;
  ereignisse: string[];
  wege: string[];
  handyUrl: string;
  tonDatei: string;
  limitSchwelle: number;
}

/** Die vier Ereignisse in ihrer festen Reihenfolge -- sie ist die der Oberflaeche. */
export const MELDE_EREIGNISSE: readonly string[] = [
  'workerFertig', 'freigabeWartet', 'sitzungTot', 'limitFastVoll',
];

/**
 * Die drei Wege. E-Mail steht ausdruecklich NICHT dabei und taucht auch in der
 * Oberflaeche nicht auf: eine Mail zu senden ist eine aussenwirksame Handlung
 * mit eigener Freigaberegel, und ein Haken im Menue waere der stille Weg daran
 * vorbei.
 */
export const MELDE_WEGE: readonly string[] = ['system', 'ton', 'handy'];

/**
 * Der Meldeblock, vollstaendig und normalisiert -- die EINE Lesart, die sowohl
 * die Oberflaeche (dieses Menue) als auch der Sendeweg (`melden.ts`,
 * `meldungsEinstellungen()`) benutzt. Bis zum 11.08. hatten beide eine eigene
 * Lesart mit verschiedener Bedeutung fuer denselben fehlenden Schluessel: die
 * Oberflaeche zeigte "alle vier Ereignisse, Weg system" an, der Sendeweg
 * schickte nichts. `wb-state settings set meldungen '{"an":true}'` zeigte
 * danach vier gehakte Kaesten, ohne dass je etwas verschickt wurde --
 * test-app-meldungen-paritaet.sh haelt die beiden Leser seither zusammen.
 *
 * Ein unbekanntes Ereignis oder ein unbekannter Weg faellt WEG, statt den
 * ganzen Block zu verwerfen: eine aeltere oder neuere Fassung darf einen Namen
 * kennen, den diese nicht hat, und ein Tippfehler in einer Liste darf nicht die
 * Schwelle mitnehmen. Fehlt der ganze Block, fehlen nur `ereignisse`/`wege`
 * darunter, oder ist die Einstellungsdatei gar nicht da: in JEDEM dieser
 * Faelle gilt fuer `ereignisse`/`wege` LEER, nie "alle" -- dieselbe Vorsicht,
 * die vorher nur der Sendeweg hatte (der Grund steht dort: die Regel "es wird
 * nie etwas gesendet, solange 'an' nicht ausdruecklich wahr ist" soll auch bei
 * einem halb geschriebenen Block gelten, und ein Menue, das mehr anzeigt als
 * tatsaechlich verschickt wird, ist der teurere Fehler). Wer die Oberflaeche
 * benutzt, schreibt ohnehin immer den GANZEN Block zurueck (siehe
 * `meldeSetzen` in einstellungen/einstellungen.ts) -- die leere Vorgabe trifft
 * nur eine Datei, die nie ueber das Menue lief.
 */
export function meldungen(pfad = einstellungenPfad()): MeldeEinstellung {
  const vorgabe = VORGABEN.meldungen as unknown as MeldeEinstellung;
  const roh = alleEinstellungen(pfad).meldungen;
  const quelle = roh && typeof roh === 'object' && !Array.isArray(roh)
    ? (roh as Record<string, unknown>)
    : {};
  const liste = (wert: unknown, erlaubt: readonly string[]): string[] => {
    if (!Array.isArray(wert)) return [];
    return wert.filter((x): x is string => typeof x === 'string' && erlaubt.includes(x));
  };
  const schwelle = Number(quelle.limitSchwelle);
  return {
    an: quelle.an === true,
    ereignisse: liste(quelle.ereignisse, MELDE_EREIGNISSE),
    wege: liste(quelle.wege, MELDE_WEGE),
    handyUrl: typeof quelle.handyUrl === 'string' ? quelle.handyUrl.trim() : '',
    tonDatei: typeof quelle.tonDatei === 'string' ? quelle.tonDatei.trim() : '',
    limitSchwelle: Number.isFinite(schwelle) && schwelle >= 1 && schwelle <= 99
      ? Math.floor(schwelle)
      : vorgabe.limitSchwelle,
  };
}

/** Die Sprache der Oberflaeche. Alles, was keine bekannte Sprache ist, heisst Deutsch. */
export function sprache(pfad = einstellungenPfad()): string {
  const roh = alleEinstellungen(pfad).sprache;
  return roh === 'en' || roh === 'de' ? roh : String(VORGABEN.sprache);
}

/** Hell, dunkel oder wie das System. */
export function thema(pfad = einstellungenPfad()): string {
  const roh = alleEinstellungen(pfad).thema;
  return roh === 'hell' || roh === 'dunkel' || roh === 'system' ? roh : String(VORGABEN.thema);
}

/**
 * Die Farben der Sitzungszustaende. Eine Farbe, die keine ist, faellt einzeln
 * auf die Auslieferung zurueck -- nicht die ganze Tabelle: ein Tippfehler in
 * einer Farbe darf nicht die drei anderen mitnehmen.
 */
export function zustandsfarben(pfad = einstellungenPfad()): Record<string, string> {
  const vorgabe = VORGABEN.zustandsfarben as Record<string, string>;
  const roh = alleEinstellungen(pfad).zustandsfarben;
  const quelle = roh && typeof roh === 'object' && !Array.isArray(roh)
    ? (roh as Record<string, unknown>)
    : {};
  const raus: Record<string, string> = {};
  for (const [zustand, farbe] of Object.entries(vorgabe)) {
    const w = quelle[zustand];
    raus[zustand] = typeof w === 'string' && /^#[0-9a-fA-F]{6}$/.test(w) ? w : farbe;
  }
  return raus;
}

/**
 * Je Harness: soll die Werkbank das Gespraech statt des Terminalbilds zeichnen?
 *
 * Das ist ein WUNSCH und keine Faehigkeit. Ob ein Harness es kann, steht im
 * `session`-Block seines Registry-Eintrags; diese Tabelle sagt nur, was der
 * Mensch will, wo es geht.
 */
export function chatAnsicht(pfad = einstellungenPfad()): Record<string, boolean> {
  const roh = alleEinstellungen(pfad).chatAnsicht;
  const quelle = roh && typeof roh === 'object' && !Array.isArray(roh)
    ? (roh as Record<string, unknown>)
    : {};
  const raus: Record<string, boolean> = {};
  for (const [harness, wert] of Object.entries(quelle)) if (wert === true) raus[harness] = true;
  return raus;
}

/**
 * Die Vorgabe JE ROLLE, unabhaengig davon, was ein Harness kann.
 *
 * Gedeutet wird sie in `chatVorgabeAus` (app/src/chat/ansichtsregel.ts) --
 * dort, wo auch die Aufloesungsregel steht, und dort auch der Umgang mit dem
 * alten einzelnen Wahrheitswert.
 */
export function chatAnsichtVorgabe(pfad = einstellungenPfad()): ChatVorgabe {
  return chatVorgabeAus(alleEinstellungen(pfad).chatAnsichtVorgabe);
}

/**
 * Ist der gefuehrte erste Start schon gelaufen (SPEC-V4 3.8)?
 *
 * Die EINE Stelle, die diesen Schluessel liest -- gebraucht beim Start des
 * Programms, um zu entscheiden, ob sich das Erststart-Fenster von selbst
 * baut. `wb-consistency` (Check 6) zaehlt einen Fund im Menue ausdruecklich
 * NICHT als Leser; diese Funktion steht deshalb hier und nicht dort.
 */
export function erststartErledigt(pfad = einstellungenPfad()): boolean {
  return alleEinstellungen(pfad).erststartErledigt === true;
}
