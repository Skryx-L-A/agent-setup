// Agent-Workbench: Fenster, Sessionleiste, Worker-Leiste, Steuerkanal.
//
// Das Fenster entsteht immer mit show:false. Es gibt kein win.focus() und kein
// setAlwaysOnTop, und kein Automatismus zeigt das Fenster: der Weg zu einem Bild
// fuehrt ueber capturePage() auf einem unsichtbaren Fenster. Der EINZIGE Aufruf
// von show() haengt an der Befehlszeilen-Angabe --show, die ein Mensch selbst
// tippt -- kein Ereignis, kein Steuerbefehl und kein Test erreicht ihn.
import {
  app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell, protocol, systemPreferences,
} from 'electron';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { readFileSync, statSync, mkdirSync, openSync, closeSync, existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, relative, dirname, basename } from 'node:path';
import { loadConfig, Config } from './config';
import { MantelKanal } from './mantel';
import { fernAufruf, findetWerkzeug, pfadHerrichten } from './pfad';
import { Ergebnis, ErgebnisWaechter } from './results';
import { TmuxControl, PaneInfo, WindowInfo, assertSessionName, assertPaneId } from './tmux';
import { ControlChannel, ControlRequest } from './control';
import { captureWindow } from './shot';
import { leseSessions, SessionInfo, panesHinweisOderFrisch, fremdeSpiegelPanes } from './sessions';
import { RemotePoller } from './remote';
import { ampelFuerMaschine, parseRepoStand, repoStandLokal, AmpelStand, RepoStand } from './ampel';
import { BudgetPoller } from './budget';
import { AufgabenQuelle, aufgabenOptionenAusUmgebung } from './aufgaben';
import { AusgabeBuendel } from './ausgabe';
import { darfWiederherstellen, fortsetzenHinweis, nimmtSitzungskennung, reviveCommand } from './revive';
import { kontextFenster, transcriptPfad, transcriptStand } from './workerstate';
import type { HarnessResume, ReviveCommand } from './revive';
import { capacity, tabsFor, mayArrange, gitterFuer, gitterFrei, tiledRaster, kachelZellen } from './capacity';
import { UiStore, sortSessions, sortProjekte, UiState } from './uistate';
import { fensterzustandLesen, fensterzustandVerfolgen, gemerktesBoundsGueltig } from './fensterzustand';
import { LebensSpur } from './lebensspur';
import { ABSTURZ_FERN_LOG_NAME, ABSTURZ_HOOK, AbsturzSpur, FernAbsturzSpur, absturzHookBefehl, absturzText } from './absturz';
import { readRequests, readGuardBlocks, decideRequest, RequestEntry, GuardBlockEntry } from './freigaben';
import {
  meldungsEinstellungen, melden, budgetProzent, NeuheitsFilter, SchwellenMelder, STANDARD_WEGE,
  meldenTesten, STANDARD_TEST_WEGE,
} from './melden';
import { renderSeite, SEITEN_SCHEMA, type SeitenName } from './seiten';
import {
  Einstellungsfenster, einstellungsDaten, wacheLesen, type EinstellungsDaten,
} from './einstellungsfenster';
import { kontextStufen, wbCodeKenntKontext, KONTEXT_PROBE_ARGS } from './kontext';
import { DE as TEXTE_DE, EN as TEXTE_EN } from '../einstellungen/texte';
import { DE as SITZ_TEXTE_DE, EN as SITZ_TEXTE_EN } from '../sitzung/texte';
import { DE as ERST_TEXTE_DE, EN as ERST_TEXTE_EN } from '../erststart/texte';
import { DE as VERB_TEXTE_DE, EN as VERB_TEXTE_EN } from '../verbrauch/texte';
import { startBefund, kurzfassung } from './startprotokoll';
import { Sitzungsfenster, sitzungsZeilen, type SitzungsDaten } from './sitzungsfenster';
import { Chatbuehne } from './chatbuehne';
import { Chatwache } from './chatwache';
import type { Wacheregel } from '../chat/wache';
import { ChatRegistry, nameAusOrdner, neueId } from './chatregistry';
import { projektDateien } from './chatdateien';
import { Chatwerkstatt } from './chatwerkstatt';
import { Verbrauchsfenster, verbrauchLesen, type VerbrauchsFrage } from './verbrauchsfenster';
import { Erststartfenster } from './erststartfenster';
import { PtyVerwaltung, type PtyAuftrag } from './pty';
import { plane, fuehreAus, gruppeAngehaengt, type Plan, type BefehlsUmgebung } from './befehle';
import { listFiles, readFileSafe, writeFileSafe, sendSelectionToOrchestrator, startEditorWaechter, type EditorWaechterHandle } from './editor';
// Die Chat-Ansicht (SPEC-V4 Abschnitt 6) haengt mit genau diesen zwei Namen am
// Hauptprozess: die Anfrage wird aus dem Sessionmodell gebaut, der Stand daraus
// gelesen. Alles Weitere steht in chatquelle.ts und app/src/chat/.
import { anfrageFuerPane, chatFaehigkeit, chatStand } from './chatquelle';
import { oeffnungBestimmen, pfadeAufloesen } from './chatpfade';
// Die Aufloesungsregel der Chat-Ansicht steht an EINER Stelle (chat/ansichtsregel.ts)
// und wird hier fuer den Menuepunkt gefragt -- dieselbe Funktion, die auch
// chatquelle.ts fuer den Stand eines Panes fragt.
import { ansichtsUrteil, harnessErlaubt } from '../chat/ansichtsregel';
import { listDir, isExcluded, EintragInfo } from './folder';
import { leseAktivitaet, leseInhalt, leseDiffFuerEintrag, leseAuftragFuerErgebnis, AktivitaetEintrag } from './aktivitaet';
import { sucheInhalt, Treffer } from './suche';
import { protokollListe, protokollLesen } from './protokolle';
import { readGuardLog, GuardLogGruppe } from './freigaben';
// Die mittlere Stufe (Muster-Erkennung riskanter Befehle): erteilen und
// verweigern liegen in freigaben.ts, hier steht nur die Verdrahtung.
import { freigabeErteilen, freigabeVerweigern, type FreigabeErgebnis } from './freigaben';
import { startDateiWaechter, type DateiWaechterHandle } from './dateiwaechter';
import {
  zahlAus, schalterAus, maschinenliste, maschinenAktiv, maschinenPausiert, sprache, erststartErledigt, chatAnsicht, chatAnsichtVorgabe,
  alleEinstellungen, systemSpracheSetzen, workerTransport,
} from './einstellungen';
// Farben durchreichen (11.08.): das Einstellungsfenster wendet Thema und
// Zustandsfarben schon auf sich selbst an (einstellungen.ts, `themaAnwenden`);
// die uebrigen Fenster ziehen ueber diese eine Stelle nach. Die Kontrastrechnung
// steht in thema.ts, ohne 'electron' -- hier wird nur noch `nativeTheme` angereicht.
import { themaPayload } from './thema';
import { schluesselSetzenFuerAnbieter, schluesselStatusAlle } from './schluesselbund';

// KEIN FENSTER FUER EINEN FEHLER, DEN NIEMAND ERWARTET HAT (Auftrag 2026-08-19).
//
// Anlass: waehrend eines parallelen Testlaufs poppten mehrere native
// "A JavaScript error occurred in the main process"-Fenster auf des Nutzers
// Bildschirm auf -- Electrons EIGENE Standardreaktion auf eine unbehandelte
// Ausnahme im Hauptprozess, wenn nichts anderes sie abfaengt. Bis heute stand
// hier kein einziger `process.on('uncaughtException'|'unhandledRejection')`
// -- jede der 68 App-Suiten startet denselben Hauptprozess, also war JEDE von
// ihnen demselben Risiko ausgesetzt, nicht nur die, bei denen es zufaellig
// zuschlug.
//
// Diese Zeilen stehen bewusst VOR JEDEM anderen Code dieser Datei (vor
// app.dock?.hide(), vor pfadHerrichten(), vor loadConfig()) -- ein Fehler in
// irgendeinem dieser fruehen Schritte soll denselben Weg nehmen wie einer,
// der Minuten spaeter passiert.
//
// Die Regel gilt UNBEDINGT, nicht nur unter --headless: ein rohes natives
// Fehlerfenster ist auch im echten, sichtbaren Betrieb keine brauchbare
// Fehlermeldung fuer einen Menschen -- die Zeile im Protokoll ist es. Ein
// Test macht daraus ausserdem eine ROTE Suite (die Meldung steht in
// $LOG, das jede test-app-*.sh-Suite selbst ausliest), statt dass der Fehler
// unbemerkt in einem Fenster liegt, das niemand sieht, weil --headless kein
// Fenster zeigt -- nur eben die eine native Fehlerbox, die --headless NICHT
// verhindert.
//
// `app.exit()` statt `process.exit()`: beendet sofort, ohne den normalen
// 'before-quit'/'will-quit'-Weg (der selbst wieder Code ist, der bei einem
// bereits kaputten Zustand seinerseits werfen koennte) -- angemessen fuer
// einen Zustand, den dieses Programm nicht mehr fuer vertrauenswuerdig haelt.
function unbehandelterFehler(art: string, fehler: unknown): void {
  const text = fehler instanceof Error ? (fehler.stack || fehler.message) : String(fehler);
  process.stderr.write(`UNBEHANDELTER FEHLER (${art}) im Hauptprozess -- kein Fenster, nur diese Zeile:\n${text}\n`);
  app.exit(1);
}
process.on('uncaughtException', (e) => unbehandelterFehler('uncaughtException', e));
process.on('unhandledRejection', (e) => unbehandelterFehler('unhandledRejection', e));

// NUR FUER DEN REGRESSIONSTEST (test-app-kein-fehlerfenster.sh): wirft absichtlich,
// bevor irgendein Fenster entsteht, damit der Test beweisen kann, dass daraus
// eine Protokollzeile wird und NIE ein sichtbares Fenster. Ohne AWB_TEST_UNCAUGHT
// aendert sich nichts -- dieselbe Bauform wie AWB_RUECKFRAGE/AWB_ORDNER_DIALOG.
if (process.env.AWB_TEST_UNCAUGHT === 'throw') {
  throw new Error('AWB_TEST_UNCAUGHT: absichtlicher Fehler fuer den Regressionstest');
}
if (process.env.AWB_TEST_UNCAUGHT === 'reject') {
  Promise.reject(new Error('AWB_TEST_UNCAUGHT: absichtliche Ablehnung fuer den Regressionstest'));
}

// Auf macOS aktiviert Electron beim Start die App und legt ein Dock-Symbol an.
// Beides wuerde dem Menschen an dieser Maschine den Fokus nehmen. Das Verstecken
// des Docks setzt die App auf "Zubehoer"; sie wird damit nicht mehr aktiv.
// Muss vor dem ersten Fenster passieren, deshalb steht es hier oben.
const zeigen = process.argv.includes('--show');
// Sichtbar, aber OHNE den Fokus zu nehmen. Gebraucht wird das fuer den einen
// Fall, den ein kopfloses Fenster nicht hergibt: macOS zoomt und geht in den
// Vollbildmodus ANIMIERT, und genau waehrend dieser Animation entsteht der
// Fehler, den eine Messung sonst nie zu sehen bekommt. Wer davor arbeitet,
// soll deswegen nicht seinen Tastaturfokus verlieren.
const zeigenInaktiv = process.argv.includes('--show-inaktiv');
if (process.platform === 'darwin' && !zeigen && !zeigenInaktiv) app.dock?.hide();

// Belegbilder in voller Aufloesung entstehen KOPFLOS: mit
// `--force-device-scale-factor=2` liefert capturePage() 2200x1276 statt
// 1100x638, ohne dass ein Fenster auf einem Bildschirm erscheint. Auf dem
// halbierten Bild fielen Verschiebungen um wenige Bildpunkte und duenne Kanten
// unter die Messschwelle -- eine 1-Pixel-Kante verschwand darin ganz und sah
// wie Leerraum aus.

// Das Schema der uebernommenen Seiten muss VOR dem Bereitsein angemeldet sein.
// 'standard': eigene Herkunft, damit die Seite die CSP des Fensters nicht erbt.
// Weder 'supportFetchAPI' noch Netzrechte -- ausgeliefert wird nur, was dieses
// Programm selbst erzeugt hat, und sonst nichts.
protocol.registerSchemesAsPrivileged([
  { scheme: SEITEN_SCHEMA, privileges: { standard: true, secure: true } },
]);

// DER PATH, BEVOR IRGENDETWAS GESTARTET WIRD (07.08.). Aus dem Finder,
// Spotlight, Launchpad oder Dock gestartet, erbt dieses Programm von launchd
// nur `/usr/bin:/bin:/usr/sbin:/sbin` -- darin liegt weder `tmux` noch eines
// der `wb-*`-Werkzeuge, und die Folge war eine Sessionleiste, die JEDE Sitzung
// als beendet auswies. Die Begruendung des Weges steht in pfad.ts.
//
// Diese Zeile steht bewusst VOR `loadConfig` und vor jedem `spawn`: sie setzt
// `process.env.PATH`, und jeder Kindprozess dieses Programms erbt ihn von dort
// (auch die Aufrufe, die sich ihre Umgebung aus `...process.env` bauen).
const pfadStand = pfadHerrichten();
process.stderr.write(
  `PATH hergerichtet${pfadStand.shell ? ` (Anmelde-Shell ${pfadStand.shell})` : ''}: `
  + `${pfadStand.dazu.length ? `+${pfadStand.dazu.join(' +')}` : 'nichts hinzugefuegt'}`
  + `${pfadStand.fehler ? ` -- ${pfadStand.fehler}` : ''}\n`,
);
// Ohne UTF-8-Locale gibt tmux den Tabulator seiner Formatzeilen als
// Unterstrich aus, und damit zerfaellt die Sessionliste (siehe pfad.ts).
// Deshalb steht auch das im Protokoll.
if (pfadStand.locale) process.stderr.write(`  Sprachumgebung gesetzt: ${pfadStand.locale}\n`);
// Die zwei Werkzeuge, an denen der Befund vom 07.08. haengt. Eine Zeile beim
// Start ist billig; die Suche danach hat einen halben Tag gekostet.
for (const werkzeug of ['tmux', 'wb-code']) {
  const gefunden = findetWerkzeug(werkzeug);
  process.stderr.write(gefunden
    ? `  ${werkzeug}: ${gefunden}\n`
    : `  ${werkzeug}: NICHT im PATH -- dieses Programm kann es nicht starten\n`);
}

const started = Date.now();
const config: Config = loadConfig(process.argv.slice(1));
// DER MENSCHEN-NACHWEIS WIRD NIE GEERBT (08.09.2026, gemessen). Ein Terminal,
// das aus dieser Werkbank heraus entstanden ist, traegt WB_MENSCH_QUELLE und
// WB_APP_PID der Werkbank, die es gestartet hat -- und ein Kern, der aus so
// einem Terminal startet (Pruefung, `wb-dev`, ein zweiter Kern fuer den
// Mac-Mantel), reichte beides mit `...process.env` an JEDES Kind weiter: ein
// Sitzungsstart ueber den Steuerkanal galt dann als Klick eines Menschen, und
// der Effort-Deckel war fuer jeden Agenten offen. Die beiden Variablen setzt
// ausschliesslich dieser Prozess selbst, an genau den Stellen, an denen ein
// echter Klick belegt ist (`sessionAnlegen`, `fuehreAus`, freigaben.ts) --
// alles, was von aussen kommt, ist ein Erbe und wird hier verworfen.
// Suite: shell/tests/test-app-mensch-sitzungsstart.sh (Zusage 2 stellt das
// Erbe her und prueft, dass es nicht ankommt).
delete process.env.WB_MENSCH_QUELLE;
delete process.env.WB_APP_PID;

/**
 * DIE BRUECKE, ZWEIMAL ANGESCHLOSSEN (06.09.2026, Auftrag macplan).
 *
 * Jeder Kanal, den der Electron-Renderer ueber preload.ts erreicht, wird hier
 * registriert -- bei `ipcMain` wie bisher UND in einer Tabelle, aus der der
 * Mantel-Socket (mantel.ts) dieselben Handler ruft. Es gibt damit EINE
 * Fassung jedes Kanals fuer beide Oberflaechen; wer einen Kanal anlegt, legt
 * ihn fuer beide an, ohne es zu wissen. `anOberflaeche` ist das Gegenstueck
 * fuer die Richtung hinaus: was das Hauptfenster bekommt, bekommt der Mantel.
 *
 * Der Mantel ruft die Handler mit einem Ereignis, dessen `sender` das
 * Hauptfenster ist: `vomHauptfenster(e)` bleibt damit wahr, und die Regel
 * „bedient wird die Sitzung auf der Buehne" gilt fuer beide Oberflaechen.
 */
type IpcHandler = (e: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type IpcHoerer = (e: Electron.IpcMainEvent, ...args: unknown[]) => void;
const ipcHandler = new Map<string, IpcHandler>();
const ipcHoerer = new Map<string, IpcHoerer>();
const ipc = {
  handle(kanal: string, fn: (e: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown): void {
    ipcMain.handle(kanal, fn);
    ipcHandler.set(kanal, fn as IpcHandler);
  },
  on(kanal: string, fn: (e: Electron.IpcMainEvent, ...args: any[]) => void): void {
    ipcMain.on(kanal, fn);
    ipcHoerer.set(kanal, fn as IpcHoerer);
  },
};
let mantel: MantelKanal | null = null;

/**
 * DER MANTELBETRIEB: DIESER PROZESS IST NUR NOCH KERN (06.09.2026, Auftrag 4.1).
 *
 * Bis heute baute der Hauptprozess sein Electron-Fenster auch dann, wenn die
 * Mac-native Oberflaeche ueber den Mantel-Socket haengt -- zwei Buehnen fuer
 * dieselbe Sitzung. Die zweite sah niemand: sie kostete einen Renderer-Prozess,
 * bekam jeden `webContents.send` mit, zeichnete Terminal und Chat neben der
 * echten Oberflaeche her und hielt beim Beenden alles auf.
 *
 * Mit `AWB_MANTEL_SOCKET` entsteht deshalb GAR KEIN `BrowserWindow` mehr --
 * weder das Hauptfenster noch eines der vier Nebenfenster (Einstellungen,
 * Sitzung, Verbrauch, erster Start): die Mac-Fassung bringt jedes davon selbst
 * mit. `awb:mantel-flaeche` ist dann die einzige Buehne.
 *
 * Was daran haengt, steht an drei Stellen: die Bruecke des Mantels schickt
 * ihre Ereignisse mit `MANTEL_SENDER` statt mit dem Fenster los (siehe
 * `vomHauptfenster`), `handle()` wartet nicht mehr auf einen Renderer, den es
 * nie geben wird, und jeder Steuerbefehl, der doch in einen greifen wollte,
 * antwortet mit `KEIN_RENDERER` statt mit einem Absturz.
 */
const mantelBetrieb = !!config.mantelSocket;

/**
 * Die Antwort jedes Steuerbefehls, der einen Renderer braucht und keinen
 * findet -- im Mantelbetrieb immer, in der Electron-Fassung nur, wenn das
 * Fenster fort ist.
 */
const KEIN_RENDERER = 'kein Renderer: dieser Befehl greift in ein Electron-Fenster. '
  + 'Im Mantelbetrieb (AWB_MANTEL_SOCKET) gibt es keines -- die Mac-Oberflaeche ist die Buehne.';

/**
 * Ob ein Fenster gebaut werden darf. Die vier Nebenfenster fragen das vor
 * jedem `new BrowserWindow` (ihre Klassen bekommen diese Funktion im
 * Konstruktor); `null` heisst „ja".
 */
function fenstersperre(): string | null {
  return mantelBetrieb ? KEIN_RENDERER : null;
}

/**
 * DER ABSENDER DER MANTEL-BRUECKE. Er steht dort, wo sonst
 * `win.webContents` steht: die Handler bekommen ein Ereignis, das aussieht wie
 * eines aus dem Hauptfenster, und `vomHauptfenster()` erkennt es an dieser
 * einen Kennung wieder. Ein echtes `webContents` gibt es im Mantelbetrieb
 * nicht mehr, und keiner der Handler liest daran etwas anderes als die
 * Herkunft (geprueft: `.sender` kommt in main.ts genau einmal vor).
 */
const MANTEL_SENDER = { __awbMantel: true } as unknown as Electron.WebContents;

/** webContents.send an das Hauptfenster -- und an den Mantel, wenn einer haengt. */
function anOberflaeche(kanal: string, nutzlast?: unknown): void {
  win?.webContents.send(kanal, nutzlast);
  mantel?.push(kanal, nutzlast);
}

/**
 * Dasselbe fuer die Nebenfenster (Einstellungen, Sitzung): ihr Fenster, falls
 * es steht, und der Mantel.
 *
 * Die Nutzlast darf eine FUNKTION sein, und die wird nur gerufen, wenn es
 * einen Empfaenger gibt. Der Grund ist gemessen (06.09.2026, Auftrag
 * seitenfix): `einstellungenDatenJetzt()` kostet rund 800 ms synchron
 * (`which` je Harness, `wb-state` je Deckel), und `fenster?.webContents.send(
 * kanal, einstellungenDatenJetzt())` hatte sie bei geschlossenem Fenster nie
 * ausgewertet -- der Umbau auf diese Funktion tat es bei JEDEM Ereignis des
 * Dateiwaechters, und die Auffrischung der offenen Seite im Hauptfenster kam
 * eine Sekunde spaeter als vorher (test-app-seiten-auffrischung.sh, rot).
 */
function anFenster(fenster: BrowserWindow | null | undefined, kanal: string, nutzlast?: unknown | (() => unknown)): void {
  if (!fenster && !mantel) return;
  const daten = typeof nutzlast === 'function' ? (nutzlast as () => unknown)() : nutzlast;
  fenster?.webContents.send(kanal, daten);
  mantel?.push(kanal, daten);
}
// KOPFLOS UNTER LINUX: DER BILDTAKT MUSS ERST GELOEST WERDEN.
//
// Das Fenster entsteht immer mit show:false. Unter Linux nimmt Chromium ein
// nie gezeigtes Fenster von der Bildquelle des Bildschirms und faellt auf einen
// Nottakt zurueck; GEMESSEN auf peer am 21.08. ueber `window.__awb.scroll-
// leistung`: 1016,6 ms zwischen zwei requestAnimationFrame-Zeitstempeln, also
// EIN Bild je Sekunde, in jedem Anlauf auf die Zehntelmillisekunde gleich.
// macOS zeigt an derselben Stelle 8,9 ms.
//
// Das trifft nicht nur das Zeichnen. Chromium reicht Rad-Ereignisse aus
// `sendInputEvent` im Takt der Bilder an den Renderer weiter; bei einem Bild je
// Sekunde kam von 30 Ereignissen eines an, der Rest verfiel. Genau daran starb
// test-app-scroll-wisch.sh auf peer mit „0 Zeilen bewegt", ohne dass an der
// Rechnung etwas falsch war. Mit dem Schalter: 4,9 ms je Bild und 30 von 30
// Ereignissen angekommen.
//
// Nur kopflos, nur unter Linux: ein sichtbares Fenster hat seinen Takt vom
// Bildschirm, und auf macOS wuerde der Schalter die Bildgrenze auch dort
// aufheben, wo sie richtig ist (gemessen 8,9 ms auf 2,9 ms).
if (config.headless && process.platform === 'linux') {
  app.commandLine.appendSwitch('disable-frame-rate-limit');
}
const ui = new UiStore(config.stateDir);
// Was beim letzten Blick dieses Programms noch lief (11.08.) -- die eine
// Quelle dafuer, dass eine nach einem Absturz weggebrochene Sitzung nicht
// aussieht wie eine, die jemand geschlossen hat. Der Grund steht in
// lebensspur.ts.
const lebensspur = new LebensSpur(config.stateDir);
// WIE eine Sitzung endete (05.09., „nur bei Absturz"): der tmux-Hook schreibt
// Status oder Signal jedes gestorbenen Panes hierher, der Takt liest es und
// sagt einen Satz -- nur bei Status ungleich 0. Der Grund und die Messung der
// drei Wege stehen in absturz.ts.
const absturzspur = new AbsturzSpur(join(config.stateDir, 'absturz.log'));
/**
 * Wann der Hook zuletzt gesetzt wurde, 0 heisst: steht nicht. Er wird bei
 * jedem Takt nachgesetzt, solange es nicht gelang (kein Server, solange keine
 * Sitzung laeuft -- der Hook kann erst mit der ersten entstehen), und danach
 * einmal je Minute erneuert, falls der Server zwischendurch neu entstand.
 */
let absturzHookGesetztAm = 0;
const ABSTURZ_HOOK_ERNEUERN_MS = 60_000;

function absturzHookSetzen(): void {
  const jetzt = Date.now();
  if (absturzHookGesetztAm && jetzt - absturzHookGesetztAm < ABSTURZ_HOOK_ERNEUERN_MS) return;
  const base = config.tmuxSocket ? ['-L', config.tmuxSocket] : [];
  // Dieselbe Frist und dasselbe Signal wie jeder oertliche tmux-Aufruf im Takt
  // (sessions.ts, tmuxAntwort): ein haengendes tmux darf hier nicht den
  // Hauptprozess anhalten.
  const r = spawnSync('tmux', [...base, 'set-hook', '-g', ABSTURZ_HOOK, absturzHookBefehl(absturzspur.datei)], {
    encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL',
  });
  absturzHookGesetztAm = !r.error && r.status === 0 ? jetzt : 0;
}

/** Was seit dem letzten Takt gestorben ist -- und davon nur, was ein Absturz war. */
function abstuerzeMelden(): void {
  for (const e of absturzspur.neue()) {
    const s = sessions.find((x) => x.tmuxSession === e.session);
    const text = absturzText(s?.name ?? e.session, e);
    if (!text) continue;
    process.stderr.write(`${text} -- Pane ${e.paneId}, Rolle '${e.role}'\n`);
    melde(text, ABSTURZ_HINWEIS_MS);
  }
}
/** Der Absturz-Satz steht laenger als eine gewoehnliche Rueckmeldung: 30 s oder bis zum naechsten Klick. */
const ABSTURZ_HINWEIS_MS = 30_000;
/**
 * Dasselbe fuer FERNE Maschinen (05.09., absturz.ts, Kopf „FERNE MASCHINEN"):
 * die Zeilen kommen mit dem Fernabruf, nur ein GELUNGENER Abruf zaehlt --
 * ein ausgefallener traegt den alten Stand weiter, und der wuerde nach dem
 * Wiederkommen alles Alte als neu ausgeben. Der Satz nennt die Maschine.
 */
const fernAbsturzspur = new FernAbsturzSpur();
function fernAbstuerzeMelden(): void {
  const hosts = new Set(remotePoller.hostliste());
  for (const snap of remotePoller.snapshots()) {
    if (snap.error || !hosts.has(snap.machine)) continue;
    for (const e of fernAbsturzspur.neue(snap.machine, snap.absturzRaw)) {
      const s = sessions.find((x) => x.machine === snap.machine && x.tmuxSession === e.session);
      const text = absturzText(s?.name ?? e.session, e, snap.machine);
      if (!text) continue;
      process.stderr.write(`${text} -- Pane ${e.paneId}, Rolle '${e.role}'\n`);
      melde(text, ABSTURZ_HINWEIS_MS);
    }
  }
}
// V10: der eigene, langsamere Takt fuer Fernmaschinen -- siehe remote.ts fuer
// den Grund, warum das NICHT im 2s-Takt von modellLesen() passieren darf.
const remotePoller = new RemotePoller({
  hosts: config.remoteMachines,
  intervalMs: config.remotePollMs,
  timeoutMs: config.remoteTimeoutMs,
  relSessionsDir: relative(homedir(), config.sessionsDir),
  relTestsuiteStatus: relative(homedir(), config.testsuiteStatusFile),
  relHygieneStatus: relative(homedir(), config.hygieneStatusFile),
  relAbsturzLog: relative(homedir(), join(config.stateDir, ABSTURZ_FERN_LOG_NAME)),
});
const budgetPoller = new BudgetPoller({ intervalMs: config.budgetPollMs, timeoutMs: config.budgetTimeoutMs, bin: config.budgetBin });
// DER TAB „AGENTS" (aufgaben.ts, welten.ts): eigener Kanal `awb:aufgaben` mit den
// Welten und der Fusszeile des Traegers, im Zwei-Sekunden-Takt, solange eine
// Oberflaeche ihn zeigt; die Handlungen als `welt:<handlung> <JSON>` -- beides
// fuer Renderer und Mantel.
const aufgabenQuelle = new AufgabenQuelle({
  ...aufgabenOptionenAusUmgebung(process.env, homedir(), config),
  sitzungen: () => sessions,
  aufNeu: (p) => anOberflaeche('awb:aufgaben', p),
});
ipc.handle('awb:aufgaben-daten', () => aufgabenQuelle.aktuell());
ipc.handle('awb:aufgabe', (_e, befehl: unknown, opt: unknown) => aufgabenQuelle.ausfuehren(String(befehl ?? ''), 'oberflaeche', opt));
// Ob eine Oberflaeche die Ansicht zeigt: dann taktet der Kern schnell, sonst langsam (Befund M4).
ipc.on('awb:aufgaben-sichtbar', (_e, an: unknown) => aufgabenQuelle.sichtbarSetzen(an === true));
// Auftrag agentsform (16.09.2026): „Neue Welt in einem Projektordner" waehlt den Ordner im Dialog des
// Systems statt als Texteingabe (die bleibt als zweiter Weg). Dieselben Auflagen wie beim Ordner einer
// Sitzung: nur auf einen echten Klick, und eine Suite bekommt mit AWB_ORDNER_DIALOG den Pfad ohne Dialog.
ipc.handle('awb:welt-ordner', (_e, echt: unknown) => weltOrdnerDialog(echt === true));

function leseStatusdatei(pfad: string): string {
  try {
    return readFileSync(pfad, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Der Stand des EIGENEN Repos (21.08.) -- die zweite Zahl, die ampel.ts
 * braucht, um einen ueberholten Befund von einem frischen zu unterscheiden.
 * Wo der Baum liegt, sagt die Statusdatei selbst (`repo_dir`, von
 * wb-testsuite-run geschrieben); geraten wird nichts, und eine aeltere Datei
 * ohne das Feld laesst die Ampel unveraendert.
 *
 * GEMERKT, NICHT BEI JEDEM TAKT GEMESSEN: `ampelStandJetzt()` haengt am
 * 2-Sekunden-Takt des Hauptprozesses, und `spawnSync('git', ...)` darin waere
 * derselbe Fehler, den remote.ts fuer SSH ausdruecklich vermeidet -- ein
 * blockierender Aufruf im Takt friert das Fenster ein. Ein HEAD-Wechsel ist
 * eine Sache von Minuten, nicht von Sekunden; eine Minute Nachlauf aendert an
 * der Auskunft nichts.
 */
const REPO_STAND_FRIST_MS = 60_000;
// Der gepruefte Commit gehoert in den Schluessel: laeuft die Suite neu, waehrend
// der gemerkte Stand noch gilt, waere `head_ahead` sonst bis zu eine Minute lang
// gegen den VORIGEN Lauf gezaehlt -- eine Zahl, die zu keiner der beiden
// Messungen passt.
let repoStandCache: { wann: number; geprueft: string; stand: RepoStand | null } | null = null;

function gitAus(dir: string, args: string[]): string {
  const r = spawnSync('git', ['--no-optional-locks', '-C', dir, ...args], { encoding: 'utf8', timeout: 3000 });
  if (r.status !== 0 || r.error) return '';
  return (r.stdout ?? '').trim();
}

function eigenerRepoStand(testsuiteRaw: string): RepoStand | null {
  const jetzt = Date.now();
  const dir = /^repo_dir=(.+)$/m.exec(testsuiteRaw)?.[1]?.trim() ?? '';
  const geprueft = /^repo_commit=(.+)$/m.exec(testsuiteRaw)?.[1]?.trim() ?? '';
  if (repoStandCache && repoStandCache.geprueft === geprueft && jetzt - repoStandCache.wann < REPO_STAND_FRIST_MS) {
    return repoStandCache.stand;
  }
  // Die Regel selbst sitzt in ampel.ts (`repoStandLokal`), damit sie dieselbe
  // ist wie die des Fernwegs und einzeln geprueft werden kann; hier steht nur,
  // WIE git auf dieser Maschine gerufen wird.
  const stand = dir && existsSync(dir) ? repoStandLokal(testsuiteRaw, gitAus) : null;
  repoStandCache = { wann: jetzt, geprueft, stand };
  return stand;
}

/** V12: eigene Maschine aus den lokalen Dateien, jede Fernmaschine aus ihrem letzten Poll-Stand. */
function ampelStandJetzt(): AmpelStand[] {
  const jetztSek = Math.floor(Date.now() / 1000);
  const eigenTestsuite = leseStatusdatei(config.testsuiteStatusFile);
  const eigene = ampelFuerMaschine(
    config.machine,
    eigenTestsuite,
    leseStatusdatei(config.hygieneStatusFile),
    jetztSek,
    eigenerRepoStand(eigenTestsuite),
  );
  // JEDE MASCHINE MIT IHREN EIGENEN ZAHLEN: der Fernstand kommt aus dem
  // REPO-Abschnitt DIESER Maschine, nie aus dem des Macs -- ein Lauf von peer
  // gegen den Baum des Macs zu halten waere schlimmer als gar kein Vergleich.
  const fern = remotePoller
    .snapshots()
    .map((s) => ampelFuerMaschine(s.machine, s.testsuiteRaw, s.hygieneRaw, jetztSek, parseRepoStand(s.repoRaw)));
  return [eigene, ...fern];
}

let win: BrowserWindow | null = null;
// NUR FUER TESTS (clipfixtest, 'kontextmenu-fake'/'menu-stand'/'kontextmenu-klick'):
// was der letzte 'context-menu'-Aufruf entschieden hat -- ohne dieses Feld
// liesse sich von aussen nur das echte, sichtbare Popup pruefen. `art` sagt,
// welcher der drei Zweige griff ('textfeld', 'terminal' oder 'keins', wenn
// weder ein editierbares Feld noch ein Terminal getroffen wurde), `eintraege`
// die Eintraege der gebauten Menue-Vorlage (Rolle, Beschriftung, ob aktiv).
let awbLetzterKontextmenu: {
  isEditable: boolean;
  popupAufgerufen: boolean;
  art: 'textfeld' | 'terminal' | 'keins';
  eintraege: Array<{ rolle: string; label: string; aktiv: boolean }>;
} | null = null;
// NUR FUER TESTS (clipfixtest, 'kontextmenu-klick'): die click()-Funktionen der
// zuletzt gebauten Terminal-Menue-Vorlage, direkt aufrufbar -- unter
// AWB_TEST_KONTEXTMENUE_STUMM=1 zeigt sich nie ein natives Popup, ueber das
// eine Suite klicken koennte.
let awbLetzterKontextmenuAktionen: { kopieren?: () => void; einfuegen?: () => Promise<void> } | null = null;
/**
 * A9: die Einstellungen als eigenes Fenster ueber dem Hauptfenster. Es entsteht
 * erst, wenn jemand danach fragt, und es wird NIE von hier aus gezeigt -- der
 * einzige show()-Aufruf haengt an einem echten Klick im Hauptfenster
 * (einstellungsfenster.ts, Klassendoc).
 */
const einstellungsfenster = new Einstellungsfenster(() => win, fenstersperre);
/**
 * Das Sitzungsfenster hinter dem Plus-Knopf. Dieselbe Bauform und dieselbe
 * Auflage wie beim Einstellungsfenster: es entsteht erst, wenn jemand danach
 * fragt, und es wird NIE von hier aus gezeigt -- der einzige show()-Aufruf
 * haengt an einem echten Klick im Hauptfenster (sitzungsfenster.ts, Klassendoc).
 */
const sitzungsfenster = new Sitzungsfenster(() => win, fenstersperre);

// Die Chat-Sitzungen (12.08.) -- eigene Welt neben den Terminal-Sitzungen:
// eigene Buchfuehrung (chats.json neben ui.json), eigene Prozesse. Die
// Sessionleiste zeigt beide, gemischt wird sonst nichts.
//
// Gezeigt werden sie seit dem 13.08. IM HAUPTFENSTER, auf der Buehne, an der
// Stelle der Kacheln (chatbuehne.ts, Klassendoc: dort steht auch, warum es
// vorher ein eigenes Fenster war und wer das geaendert hat).
const chatRegistry = new ChatRegistry(config.stateDir);
const chatbuehne = new Chatbuehne(
  chatRegistry,
  () => win,
  () => sprache(config.settingsFile),
  () => modellSenden(),
  config.chatBefehl,
  // Die Statusleiste der Chat-Sitzung (Punkt 2). Beide Zahlen kommen aus
  // Quellen, die dieses Programm schon fuehrt: die Fenstergroesse aus der
  // Modell-Registry (dieselbe Funktion, die die Worker-Auslastung rechnet), der
  // Kontingentstand aus dem BudgetPoller, der `wb-budget` liest -- und das
  // wiederum limits.jsonl, das die Statuszeile im Terminal fortschreibt.
  () => {
    const b = budgetPoller.aktuell();
    return {
      kontextFenster: (modell: string) => kontextFenster(modell, config.modelsFile),
      fuenfStunden: b?.fiveHourPct ?? -1,
      siebenTage: b?.sevenDayPct ?? -1,
      zurueck: b?.resetText ?? '',
    };
  },
  // DIE WERKSTATT (Punkt 1): die tmux-Session, in der die Worker einer
  // Chat-Sitzung landen. Sie laeuft auf DEMSELBEN Socket wie alles andere --
  // ein Testlauf setzt ihn, der Betrieb nimmt den Vorgabesocket.
  new Chatwerkstatt({ socket: config.tmuxSocket }),
  // DIE KONTEXTWACHE (15.08.). Der `shell/context-guard` erreicht Chat-Sitzungen
  // nicht -- er liest tmux-Panes, und eine Chat-Sitzung hat keinen. Diese Wache
  // laeuft im Programm, an derselben Stelle wie die Sitzung selbst
  // (chatwache.ts, Dateikopf: dort steht die ganze Kette und was sie NIE tut).
  //
  // BEIDE ZAHLEN KOMMEN AUS QUELLEN, DIE DIESES HAUS SCHON FUEHRT: die
  // Schwellen aus `wb-state wache get` -- also aus `kontextwache.orchestrator`,
  // derselben Setzung, an der auch der tmux-Guard haengt -- und die
  // Fenstergroesse aus der Modell-Registry, ueber dieselbe Funktion wie die
  // Worker-Auslastung. Eine eigene Zahl im Quelltext waere eine zweite
  // Wahrheit.
  //
  // Die Rolle ist der ORCHESTRATOR: eine Chat-Sitzung ist eigene des Nutzers
  // Sitzung, sie hat eine Werkstatt und schickt Worker hinein.
  // GEFRAGT WIRD ASYNCHRON, und das ist gemessen: `wb-state` braucht 40 ms, und
  // synchron im Zwei-Sekunden-Takt sind das 40 ms Stillstand des Fensters --
  // im Lasttest fielen dadurch rund zwanzig von 400 Zeichenvorgaengen aus. Die
  // AUSWERTUNG macht weiter `wacheLesen`, es wird nur der Aufruf
  // herumgedreht (einstellungsfenster.ts, `vorabText`).
  new Chatwache({
    // ANTWORTET DAS WERKZEUG NICHT, WIRD NICHT EINGEGRIFFEN -- und das
    // Versprechen muss dafuer SCHEITERN duerfen (Reviewbefund 5 vom 15.08.).
    // Bis dahin loeste diese Verdrahtung ihr eigenes Versprechen auch im
    // Fehlerfall auf und rief `wacheLesen('', '')`; das liefert die VORGABE
    // (`an: true`, Notbremse 80), nicht das, was alice gesetzt hat. Eine
    // abgeschaltete Wache schaltete sich so bei einem stummen oder in den
    // Acht-Sekunden-Deckel gelaufenen `wb-state` selbst wieder ein und konnte
    // kompaktieren. Der sichere Rueckfall liegt an einer Stelle, in
    // `Chatwache.frischeRegel`.
    regel: () => new Promise<Wacheregel>((fertig, schiefgegangen) => {
      execFile(befehlsUmgebung().wbStateBin, ['wache', 'get', '--json'], { timeout: 8000 }, (fehler, text) => {
        const roh = String(text ?? '').trim();
        if (fehler || !roh) {
          schiefgegangen(new Error(`wb-state wache get: ${fehler ? String(fehler) : 'leere Antwort'}`));
          return;
        }
        const w = wacheLesen('', roh).orchestrator;
        fertig({
          an: w.an,
          mahnenAb: w.mahnenAb,
          eingreifen: w.eingreifen,
          // Ohne eigene Notbremse gilt die Mahnschwelle auch als Notbremse. Die
          // Wache erkennt diese Gleichheit als Fehlkonfiguration, sagt es und
          // haelt die Uebergabe-Garantie (chat/wache.ts, Befund 4) -- statt
          // still ohne Uebergabe zu kompaktieren.
          notbremseAb: w.notbremseAb ?? w.mahnenAb,
        });
      });
    }),
    fenster: (modell: string) => kontextFenster(modell, config.modelsFile),
  }),
  // DER STAND GEHT AN BEIDE OBERFLAECHEN (06.09.2026, Auftrag 3.1 von
  // mac/PLAN.md): `anOberflaeche` schickt an das Electron-Fenster UND an den
  // Mantel. Vorher lief `awb:chat-stand-neu` als einziger Kanal direkt an
  // `win.webContents` vorbei am Mantel (mac/PROTOKOLL.md, Offen aus Phase 1).
  (nachricht) => anOberflaeche('awb:chat-stand-neu', nachricht),
);

/**
 * Das Modell einer neuen Chat-Sitzung. Es kommt aus den EINSTELLUNGEN
 * (`orchestratorModel`, Seite „Programme und Modelle"), nicht aus einer festen
 * Zeile hier: die Modellwahl dieses Hauses gehoert dieser Seite, und eine
 * zweite Vorgabe im Quelltext waere genau die Stelle, an der beide
 * auseinander laufen. Leer heisst: die Vorgabe der CLI gilt.
 */
function chatModellVorgabe(): string {
  const roh = alleEinstellungen(config.settingsFile).orchestratorModel;
  return typeof roh === 'string' ? roh.trim() : '';
}
/**
 * Die Verbrauchsseite hinter der Token-Anzeige unten links. Dritte Fenster
 * derselben Bauform und unter derselben Auflage: es entsteht erst auf
 * Nachfrage und wird NIE von hier aus gezeigt (verbrauchsfenster.ts,
 * Klassendoc).
 */
const verbrauchsfenster = new Verbrauchsfenster(() => win, fenstersperre);
/**
 * Der geführte erste Start (SPEC-V4 3.8). Viertes Fenster derselben Bauform -- entsteht erst auf
 * Nachfrage oder beim ersten echten Start und wird nie von HIER aus gezeigt
 * (erststartfenster.ts, Klassendoc).
 */
const erststartfenster = new Erststartfenster(() => win, fenstersperre);
let dateiWaechter: DateiWaechterHandle | null = null;
/**
 * Der Waechter ueber die im Editor OFFENEN Dateien (06.09.2026, Auftrag 3.4).
 * Er entsteht erst, wenn eine Oberflaeche `awb:editor-watch` schickt -- ohne
 * offenen Editor beobachtet niemand etwas.
 */
let editorWaechter: EditorWaechterHandle | null = null;
let tmux: TmuxControl | null = null;
let channel: ControlChannel | null = null;
/** Warum es keinen Steuerkanal gibt -- null heisst: es gibt einen. */
let kanalFehler: string | null = null;
let attachState: { session: string; windows: WindowInfo[]; panes: PaneInfo[]; cols: number; rows: number; sizePolicy: string; sizeIgnored: boolean } | null = null;
let attachError: string | null = null;
let rendererReady = false;
let sessions: SessionInfo[] = [];
/** V20: die Freigabe-Ansicht, aus denselben Zustandsdateien wie alles andere. */
let freigaben: { requests: RequestEntry[]; guardBlocks: GuardBlockEntry[]; guardLog: GuardLogGruppe[] } = { requests: [], guardBlocks: [], guardLog: [] };
let streamPane = '';
/** Zuletzt vom Renderer gemeldete Zeichenflaeche in Spalten und Zeilen. */
let flaeche: { cols: number; rows: number } | null = null;
/**
 * Steht rechts ein Blatt des Inspektors offen? Der Renderer meldet es, sobald
 * es sich aendert. Gebraucht in `kapazitaet()`: ein offenes Blatt nimmt der
 * Buehne rund 360 Bildpunkte, und ohne diese Auskunft faellt sie dabei von zwei
 * Spalten auf eine (Electron-Befund 7). Nicht gemerkt und nicht in ui.json:
 * ein Blatt ist ein Zustand des Augenblicks, kein Vorzug.
 */
let blattOffen = false;
/** Was die Mitte gerade zeigt: einen einzelnen Pane oder einen ganzen Tab. */
let ansicht: { art: 'pane'; pane: string } | { art: 'tab'; panes: string[] } = { art: 'pane', pane: '' };
/**
 * Mit welchen Groessen die Panes zuletzt abgeschickt wurden. Nur dafuer da,
 * eine Aufteilungs-Meldung von tmux zu beantworten: weicht ab, was tmux JETZT
 * hat, wird neu gezeichnet -- weicht nichts ab, passiert nichts, und die
 * Meldungen, die unser eigenes Umstellen ausloest, laufen ins Leere.
 */
let gezeichneteLage: { paneId: string; cols: number; rows: number }[] = [];
let uhr: NodeJS.Timeout | null = null;

/**
 * Die Terminal-Ausgabe geht gebuendelt ueber die Bruecke (16.08., ausgabe.ts):
 * gemessen auf eigenem Testsocket 1569 Stuecke fuer ein `seq 20000` -- ebenso
 * viele IPC-Nachrichten, wenn jedes einzeln faehrt, und zwei, wenn sie
 * gebuendelt werden (shell/tests/test-app-ausgabe-buendel.sh).
 */
const ausgabeBuendel = new AusgabeBuendel((paneId, data) => anOberflaeche('awb:output', { paneId, data }));

/**
 * DIE PROBE FUER OPTION E (04.09.2026): ein Worker auf einem eigenen
 * Pseudo-Terminal, ohne tmux, gehalten von diesem Prozess.
 *
 * Sie haengt vollstaendig an einem Schalter (`workerTransport` in den
 * Einstellungen, Vorgabe 'tmux'). Steht er nicht auf 'pty', wird `node-pty`
 * nicht einmal geladen: dieselbe Anwendung, derselbe Weg wie bisher, und der
 * Zweig `dev` laeuft mit dem Prototyp im Baum genauso wie ohne ihn.
 *
 * Die Ausgabe geht durch DIESELBE Buendelung wie die tmux-Ausgabe und ueber
 * dieselbe Bruecke (`awb:output`); der Renderer sieht keinen Unterschied und
 * ist unveraendert geblieben. Genau das ist der Punkt der Probe -- was ein
 * Pane IST, geht die Zeichenflaeche nichts an.
 */
let ptyPanes: PtyVerwaltung | null = null;
function ptyVerwaltung(): PtyVerwaltung {
  if (!ptyPanes) {
    const v = new PtyVerwaltung(join(config.stateDir, 'pty-panes.json'));
    v.on('ausgabe', (paneId: string, data: Buffer) => ausgabeBuendel.nimm(paneId, data));
    v.on('ende', (paneId: string, code: number) => {
      process.stderr.write(`pty ${paneId} beendet (Code ${code})\n`);
    });
    ptyPanes = v;
  }
  return ptyPanes;
}

/** Ob der Prototyp ueberhaupt eingeschaltet ist. Zweite Stelle: einstellungen.ts. */
function ptyTransport(): boolean {
  return workerTransport(config.settingsFile) === 'pty';
}

/**
 * Ein tmux-Tastenname als Bytes. `null` heisst "kenne ich nicht" -- und das ist
 * eine Ablehnung, keine leere Sendung: wer 'Enter' schreibt und nichts bekommt,
 * sucht den Fehler am falschen Ende.
 *
 * Die Namen sind die von `send-keys`, damit die Werkzeuge unveraendert dieselben
 * Woerter benutzen koennen. Mehr als diese Liste braucht die Wache nicht; sie
 * tippt Enter, Escape und C-c, sonst nichts.
 */
function tastenBytes(name: string): string | null {
  const fest: Record<string, string> = {
    Enter: '\r',
    Escape: '\x1b',
    Tab: '\t',
    Space: ' ',
    BSpace: '\x7f',
    Up: '\x1b[A',
    Down: '\x1b[B',
    Right: '\x1b[C',
    Left: '\x1b[D',
  };
  if (fest[name]) return fest[name];
  // C-a bis C-z und die Steuerzeichen daneben, in derselben Schreibweise wie
  // tmux sie nimmt.
  const strg = /^C-([A-Za-z@[\]\\^_])$/.exec(name);
  if (strg) {
    const z = strg[1].toUpperCase().charCodeAt(0);
    return String.fromCharCode(z & 0x1f);
  }
  return null;
}

/**
 * Die EINE Stelle, an der eine Lage-Meldung hinausgeht -- und damit die eine
 * Stelle, an der die gesammelte Ausgabe vorher abgegeben wird. Eine Lage traegt
 * Momentaufnahmen der Panes; kaeme gesammelte Ausgabe DANACH an, stuende sie
 * doppelt auf dem Bild, auf dem sie schon steht. Vorher abgegeben, ist die
 * Reihenfolge dieselbe wie vor der Buendelung.
 */
function lageSenden(nutzlast: unknown): void {
  ausgabeBuendel.abgeben();
  anOberflaeche('awb:layout', nutzlast);
}

function createWindow(cols: number, rows: number): BrowserWindow {
  // Grob an der Pane-Groesse ausgerichtet; der Renderer skaliert genau.
  const breite = Math.max(640, cols * 8 + 140);
  const hoehe = Math.max(360, rows * 17 + 60);
  // Zustand aus dem letzten Lauf (siehe fensterzustand.ts) schlaegt die
  // Pane-Groesse, wenn er zum aktuellen Bildschirm passt -- ein Mensch, der
  // das Fenster von Hand groesser gezogen oder verschoben hat, soll das nach
  // einem Neustart wiederfinden, nicht wieder auf 34 Zeilen zurueckfallen.
  const gemerkt = fensterzustandLesen(config.stateDir);
  const bounds = gemerktesBoundsGueltig(gemerkt) ? gemerkt : null;
  const w = new BrowserWindow({
    ...(bounds ? bounds : { width: breite, height: hoehe }),
    // Die Zahlen meinen den Inhalt, nicht den Rahmen -- das Selbstfoto zeigt
    // den Inhalt, also soll er die angegebene Groesse haben.
    useContentSize: true,
    show: false,
    // Ein verstecktes Fenster darf nicht gedrosselt werden, sonst zeigt das
    // Selbstfoto einen aelteren Stand als der Puffer (V6).
    paintWhenInitiallyHidden: true,
    backgroundColor: '#101216',
    // Die drei Fensterknoepfe bleiben am gewohnten Mac-Platz oben links, aber
    // OHNE die separate graue Titelleiste darueber -- der Inhalt (die
    // Sessionleiste) laeuft bis unter sie durch. Nur macOS kennt diesen Wert;
    // auf jeder anderen Plattform bleibt der Rahmen wie er war.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      sandbox: false,
    },
  });
  // Ohne nutzbaren Bildschirm setzt Electron das Fenster auf seine Vorgabe von
  // 800x600 bei 0,0 und ignoriert die Groesse aus dem Aufruf -- gemessen im
  // kopflosen Lauf. Nachgesetzt gilt sie trotzdem.
  //
  // DAS GILT AUCH FUER EINEN GEMERKTEN RAHMEN (03.09.2026). Bis dahin wurde nur
  // nachgesetzt, wenn KEINER vorlag -- lag einer vor, blieb es beim Konstruktor,
  // und genau der wird ohne nutzbaren Bildschirm ignoriert. Gemessen mit einer
  // fenster.json von 1600x900: die Buehne kam mit 818x534 heraus, also aus der
  // Panezahl. Kopflos meldet Electron dabei einen erfundenen Bildschirm von
  // 800x600; ein gemerkter Rahmen gilt dort nur, wenn seine Mitte darin liegt
  // (fensterzustand.ts) -- ein Test, der eine bestimmte Buehnengroesse braucht,
  // setzt seine x/y deshalb entsprechend.
  //
  // `bounds.width`/`.height` sind die INHALTS-Groesse (siehe fensterzustand.ts),
  // und `useContentSize` steht -- der Aufruf schreibt also denselben Wert noch
  // einmal, den der Konstruktor schon bekommen hat, und ist dort, wo dieser
  // gewirkt hat, folgenlos.
  if (bounds) w.setContentSize(bounds.width, bounds.height);
  else w.setContentSize(breite, hoehe);
  fensterzustandVerfolgen(w, config.stateDir);

  // ENTWICKLUNGSFASSUNG SICHTBAR MACHEN (2026-09-03). Die Dev-Fassung laeuft
  // neben der ausgelieferten, mit eigenen Daten und eigenem tmux-Server -- aber
  // sie trug denselben Fenstertitel. Zwei gleich aussehende Fenster
  // nebeneinander sind eine Falle, und es ist genau die, in die alice am
  // 10.08. schon einmal gelaufen ist: damals standen zwei Symbole im Dock, und
  // er klickte auf das falsche (siehe den Kopf von shell/make-app.sh).
  //
  // Der Titel wird vom RENDERER gesetzt (renderer.ts, `document.title`), damit
  // er der eingestellten Sprache folgt. Deshalb wird hier nicht einmalig ein
  // Titel gesetzt, sondern jede Meldung des Renderers abgefangen und ergaenzt.
  // `setTitle` aus dem Hauptprozess loest das Ereignis nicht erneut aus, es
  // entsteht also keine Schleife.
  if (process.env.AWB_DEV === '1') {
    w.on('page-title-updated', (e) => {
      e.preventDefault();
      w.setTitle(`${w.webContents.getTitle()} – Entwicklungsfassung`);
    });
  }
  return w;
}

// Der Renderer meldet sich frueher, als das Laden des Fensters aufloest. Der
// Empfaenger steht deshalb, bevor ueberhaupt geladen wird.
function neuerWaechter(): { p: Promise<void>; melden: () => void } {
  let melden!: () => void;
  const p = new Promise<void>((resolve) => {
    melden = resolve;
  });
  return { p, melden };
}
let waechter = neuerWaechter();
ipc.on('awb:ready', () => {
  rendererReady = true;
  waechter.melden();
});

async function waitForRenderer(timeoutMs = 15000): Promise<void> {
  if (rendererReady) return;
  let t: NodeJS.Timeout;
  await Promise.race([
    waechter.p,
    new Promise<void>((_r, reject) => {
      t = setTimeout(() => reject(new Error('Renderer meldete sich nicht')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(t));
}

/**
 * IST DER RENDERER DIESES FENSTERS UEBERHAUPT NOCH DA (Prueferbefund vom
 * 05.09.2026, hier nachgestellt und gemessen)?
 *
 * WAS GEMESSEN WURDE: Stirbt der Renderer-Prozess des Fensters, laeuft der
 * Hauptprozess weiter und tickt weiter -- aber jeder Ruf in den Renderer
 * (`executeJavaScript`) loest sein Versprechen NIE mehr auf. `awb-ctl state`
 * liest ueber `bufferText()` und `schirmText()` genau dort und blieb deshalb
 * ohne Antwort stehen; weil `ControlChannel.answer()` eine Anfrage nach der
 * anderen abarbeitet, stand mit ihr der ganze Steuerkanal. Von aussen sieht
 * das aus wie ein totes Programm: keine Antwort auf `state`, keine auf alles
 * Weitere. Im Protokoll steht davor die Kette „Render frame was disposed
 * before WebFrameMain could be accessed" -- Electrons eigene Meldung ueber
 * jedes `webContents.send()`, das ins Leere ging.
 *
 * Ein Steuerbefehl, der das Programm unerreichbar macht, ist eine Waffe gegen
 * seinen eigenen Benutzer. Also wird VOR dem Ruf gefragt, ob es ueberhaupt
 * jemanden gibt, der ihn beantworten kann.
 *
 * MASSGEBLICH IST `rendererReady`, NICHT DAS OBJEKT (gemessen, 05.09.): nach
 * dem Tod des Renderer-Prozesses meldet weder `isDestroyed()` noch der Zugriff
 * auf `mainFrame` etwas Auffaelliges -- das Fenster steht, das Objekt
 * antwortet, und erst der Ruf hinein bleibt offen. Was den Unterschied
 * wirklich kennt, ist der Merker, den `awb:ready` setzt und den
 * 'render-process-gone' wieder loescht. Die beiden Abfragen davor bleiben
 * trotzdem stehen: sie kosten nichts und fangen den Fall ab, in dem das
 * Fenster schon fort ist, bevor irgendein Ereignis gelaufen ist.
 */
function rendererErreichbar(ziel: BrowserWindow | null = win): boolean {
  if (!ziel || ziel.isDestroyed() || ziel.webContents.isDestroyed()) return false;
  try {
    if (!ziel.webContents.mainFrame) return false;
  } catch {
    return false;
  }
  return rendererReady;
}

/**
 * Wie lange ein Steuerbefehl auf einen wiedergekommenen Renderer wartet. Der
 * Hauptprozess holt ihn nach einem Absturz von selbst zurueck (siehe den
 * `render-process-gone`-Zuhoerer bei der Fenstererzeugung); dieser Weg dauert
 * einen Neustart des Renderers lang, also wenige hundert Millisekunden. Fuenf
 * Sekunden sind reichlich dafuer und kurz genug, dass ein Mensch am Terminal
 * nicht glaubt, sein Befehl sei verlorengegangen.
 */
const RENDERER_RUECKKEHR_MS = 5000;

/**
 * Die Befehle, die ohne lebenden Renderer beantwortet werden -- Begruendung
 * je Eintrag am Eingang von `handle()`.
 */
const STEUERBEFEHLE_OHNE_RENDERER = new Set(['ping', 'quit', 'reload']);

/** Wann der Renderer zuletzt nach einem Absturz neu geladen wurde. */
let rendererNeustartAm = 0;
/** Und wie dicht zwei solche Neustarts hoechstens aufeinander folgen duerfen. */
const RENDERER_NEUSTART_ABSTAND_MS = 5000;

/**
 * Warten, bis der Renderer wieder da ist -- oder mit einem lesbaren Satz
 * aufgeben. Aufgeben ist hier ausdruecklich das bessere Ende: eine Antwort
 * „der Renderer ist weg" sagt, was los ist, ein Haengenbleiben sagt nichts und
 * nimmt den Kanal fuer jeden weiteren Befehl mit.
 */
async function rendererZurueck(frist = RENDERER_RUECKKEHR_MS): Promise<void> {
  const bis = Date.now() + frist;
  for (;;) {
    if (rendererErreichbar()) return;
    if (Date.now() >= bis) {
      throw new Error(
        `der Renderer dieses Fensters ist weg und in ${frist} ms nicht wiedergekommen -- `
        + 'dieser Befehl braucht ihn. Das Protokoll nennt den Grund (render-process-gone).',
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// --- Sessionmodell ---------------------------------------------------------

/**
 * Erreichbare Maschinen. Die eigene gilt immer; jede Fernmaschine gilt genau
 * dann, wenn ihr letzter Abruf glatt lief (V10) -- fehlt sie ganz (noch nie
 * geantwortet), gilt sie ebensowenig, aber ohne dass es Sessions gibt, die
 * verschwinden koennten. Der vierte Zustand aus F6 haengt genau daran.
 */
function erreichbareMaschinen(): string[] {
  const extra = (process.env.AWB_REACHABLE ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const fern = remotePoller.snapshots().filter((s) => s.reachable).map((s) => s.machine);
  return [config.machine, ...extra, ...fern];
}

/**
 * Der letzte tmux-Befund (07.08.). Er wird bei jedem Durchgang mitgelesen, aber
 * nur GEMELDET, wenn er sich aendert -- und danach hoechstens einmal je
 * Wiederholungsfrist, solange der Zustand anhaelt. Ein Zwei-Sekunden-Takt, der
 * dieselbe Meldung 30-mal je Minute ins Fenster schoebe, waere keine Warnung
 * mehr, sondern Rauschen; einmal und dann nie wieder waere zu wenig, weil die
 * Meldung nach vier Sekunden von selbst verschwindet und der Zustand bleibt.
 */
let tmuxBefund = { ausfuehrbar: true, fehler: '' };

/**
 * DAS ANHAENGEN BEIM START WIRD NACHGEHOLT, WENN TMUX BEIM START NICHT
 * GEANTWORTET HAT (2026-08-24, Auftrag "was bei zwanzig gleichzeitig
 * passiert").
 *
 * Der Start haengt genau EINMAL an: er liest das Modell, nimmt die gewaehlte
 * Sitzung und zeichnet sie, falls sie laeuft. Ob sie laeuft, beantwortet ein
 * `spawnSync('tmux', ['list-sessions', …])` mit einer Frist von 2000 ms
 * (sessions.ts). Reisst diese Frist, ist `alive` fuer JEDE Sitzung false --
 * nicht weil keine laeuft, sondern weil niemand nachsehen konnte. Das Programm
 * haengte sich dann an nichts, und weil das Anhaengen nur am Start und beim
 * Klick passiert, blieb es dabei: die Mitte blieb leer, bis ein Mensch die
 * Sitzung anklickte. Der 2s-Takt darunter las das Modell laengst wieder
 * richtig -- er zog nur keine Folgerung daraus.
 *
 * GEMESSEN, warum die Frist ueberhaupt reisst (2026-08-24, diese Maschine):
 * Jede Testsuite schreibt ihren tmux-Schirm frisch in ein eigenes HOME, und
 * macOS prueft jede FRISCH GESCHRIEBENE ausfuehrbare Datei beim ERSTEN Start --
 * `XprotectService`, maschinenweit hintereinander, rund 100 bis 250 ms je
 * Datei. Bei 24 gleichzeitigen ersten Starts stand der langsamste 2,6 s an;
 * das Programm sah davon nur seinen abgelaufenen tmux-Aufruf. Von 24
 * gleichzeitig gestarteten Instanzen bekamen 15 nie eine Lage -- und alle 15
 * trugen genau diesen abgelaufenen Aufruf im Protokoll, die neun anderen
 * keinen.
 *
 * Die Frist bleibt, wie sie ist: sie schuetzt den Hauptprozess davor, an einem
 * haengenden tmux stehenzubleiben, und laenger machen hiesse nur, dieselbe
 * Wette bei mehr Last erneut zu verlieren. Was hier falsch war, ist nicht die
 * Frist, sondern dass eine GESCHEITERTE MESSUNG zu einer ENDGUELTIGEN
 * ENTSCHEIDUNG wurde. Dieser Merker haelt fest, dass der Start ohne Auskunft
 * entschieden hat; der naechste Takt, in dem tmux wieder antwortet, holt das
 * Anhaengen einmalig nach -- und nur dann, wenn seither nichts anderes
 * angehaengt wurde.
 */
let startAnhaengenNachholen = false;
let tmuxGemeldetAm = 0;
const TMUX_MELDUNG_WIEDERHOLUNG_MS = 60_000;

function tmuxBefundMelden(neu: { ausfuehrbar: boolean; fehler: string }): void {
  const jetzt = Date.now();
  const gewechselt = neu.ausfuehrbar !== tmuxBefund.ausfuehrbar;
  tmuxBefund = neu;
  if (neu.ausfuehrbar) {
    if (gewechselt) {
      process.stderr.write('tmux ist wieder erreichbar -- die Sitzungszustaende gelten wieder.\n');
      melde('tmux ist wieder erreichbar.');
    }
    tmuxGemeldetAm = 0;
    return;
  }
  if (!gewechselt && jetzt - tmuxGemeldetAm < TMUX_MELDUNG_WIEDERHOLUNG_MS) return;
  tmuxGemeldetAm = jetzt;
  process.stderr.write(`${neu.fehler}\n`);
  melde(neu.fehler);
}

function modellLesen(): SessionInfo[] {
  const befund = leseSessions({
    sessionsDir: config.sessionsDir,
    requestsDir: config.requestsDir,
    tmuxSocket: config.tmuxSocket,
    machine: config.machine,
    reachable: erreichbareMaschinen(),
    resultsDir: config.resultsDir,
    projectsDir: config.projectsDir,
    stallSeconds: stallSekundenJetzt(),
    guardBlocksDir: config.guardBlocksDir,
    modelsFile: config.modelsFile,
    remoteSnapshots: remotePoller.snapshots(),
    verlorene: lebensspur.verlorene(),
  });
  tmuxBefundMelden({ ausfuehrbar: befund.tmuxAusfuehrbar, fehler: befund.tmuxFehler });
  // Was dieser Prozess ueber laufende und gescheiterte Starts weiss, gehoert an
  // die Liste, bevor irgendjemand sie filtert oder zeichnet.
  startzustand(befund.sessions);
  // Erst lesen, dann fortschreiben: was dieser Durchgang gesehen hat, ist der
  // Stand, gegen den der NAECHSTE Start misst. Ob eine Beobachtung ueberhaupt
  // etwas wert ist, wird JE MASCHINE beantwortet (11.08.): hier haengt es am
  // tmux-Befund -- ohne tmux ist `alive` fuer jede Sitzung false, und ein
  // Fortschreiben loeschte genau die Auskunft, um die es geht --, fern am
  // letzten Abruf des Pollers. Eine Maschine, von der noch nie etwas kam
  // (erster Takt, die SSH-Antwort ist noch unterwegs), ist ausdruecklich NICHT
  // einsehbar; sonst faellt jede ferne Sitzung schon im ersten Takt aus der
  // Spur und ein ferner Verlust liesse sich nie mehr melden.
  const fernErreichbar = new Map(remotePoller.snapshots().map((s) => [s.machine, s.reachable]));
  const verloreneJetzt = lebensspur.durchgang(befund.sessions, (maschine) => (
    !maschine || maschine === config.machine
      ? befund.tmuxAusfuehrbar
      : fernErreichbar.get(maschine) ?? false
  ));
  // Benachrichtigung 'sitzungTot': `verloreneJetzt` steht, bis die Sitzung
  // wieder laeuft oder ihre Zustandsdatei weg ist (lebensspur.ts) -- ohne
  // die Entprellung meldete jeder Takt denselben Verlust erneut.
  meldungSitzungTot.neue(verloreneJetzt).forEach((id) => {
    const verlorene = befund.sessions.find((s) => s.id === id);
    melden(
      'sitzungTot',
      `Sitzung '${verlorene?.name ?? id}' ist ohne sichtbares Ende verschwunden.`,
      meldungsEinstellungen(config.settingsFile),
      STANDARD_WEGE,
    );
  });
  // DAS AUFRAEUMEN DER SITZUNGS-UEBERSTEUERUNGEN (12.08.): eine Sitzung, die es
  // nicht mehr gibt, nimmt ihren Eintrag in ui.json mit. Geschrieben wird nur,
  // wenn wirklich einer wegfaellt. Bei einer LEEREN Liste passiert nichts --
  // die entsteht auch, wenn das Verzeichnis gerade nicht lesbar ist, und ein
  // voruebergehender Fehler darf keine Einstellung loeschen.
  if (befund.sessions.length) ui.sitzungenAufraeumen(befund.sessions.map((s) => s.id));
  return befund.sessions;
}

/**
 * Schritt 7: das HTML einer uebernommenen Seite. Die Quellen sind dieselben
 * Dateien, die auch `wb-state` liest -- eine zweite Buchfuehrung ueber
 * Einstellungen oder Registry gibt es nicht.
 */
function seiteHtml(name: SeitenName): string {
  return renderSeite(name, sessions, config.machine, {
    settingsFile: config.settingsFile,
    modelsFile: config.modelsFile,
    remoteMachines: config.remoteMachines,
  });
}

/** Die letzte Nachricht einer Seite -- damit der Steuerkanal sie belegen kann. */
let letzteSeitenNachricht: unknown = null;
/** Der Plan, der gerade zur Bestaetigung steht. Nur er darf ausgefuehrt werden. */
let letzterPlan: Plan | null = null;
/** Was zuletzt ausgefuehrt wurde -- fuer den Steuerkanal und die Pruefung. */
let letzterAusgang: unknown = null;
/** Welche Seite offen ist, damit sie nach einer Handlung neu gezeichnet wird. */
let seiteOffen: SeitenName | '' = '';

function befehlsUmgebung(): BefehlsUmgebung {
  return {
    sessionsDir: config.sessionsDir,
    settingsFile: config.settingsFile,
    tmuxSocket: config.tmuxSocket,
    // Ohne absoluten Pfad: es soll gelten, was auch am Terminal gilt (PATH).
    // Ein Test setzt sie um, damit er keine echte Session anlegt.
    wbCodeBin: process.env.AWB_WB_CODE ?? 'wb-code',
    wbSessionDeleteBin: process.env.AWB_WB_SESSION_DELETE ?? 'wb-session-delete',
    wbSessionCloseBin: process.env.AWB_WB_SESSION_CLOSE ?? 'wb-session-close',
    wbStateBin: process.env.AWB_WB_STATE ?? 'wb-state',
    // Woran `plane` erkennt, ob ein Griff hier laeuft oder drueben (09.08.).
    machine: config.machine,
    // Der Weg fuer Zwischenmeldungen waehrend eines langen Starts (21.08.):
    // dieselbe Buehne, ueber die auch sonst ein Satz ins Fenster geht. Ohne sie
    // saesse der Mensch bei einem lokalen Modell minutenlang vor einem Fenster,
    // das nichts sagt -- `wb-code` legt seine tmux-Session erst nach dem
    // Modellstart an.
    fortschritt: (text: string) => melde(text),
    // Wohin `wb-code` auf dem Fortsetzen-Weg schreibt -- derselbe Ordner wie
    // beim Plus-Menue, damit beide Wege ihre Gruende am selben Platz ablegen.
    startProtokollDir: join(config.stateDir, 'sitzungsstart'),
    // Und der Fehlschlag wird gemeldet wie dort: derselbe Satz ins Fenster,
    // dieselbe Nachricht ans Sitzungsfenster, dieselbe Auffrischung der Liste.
    // Bis zum 21.08. meldete dieser Weg gar nichts -- er gab sogar `ok` zurueck,
    // wenn `wb-code` abbrach.
    startVerlauf: (phase, info) => startVerlaufEintragen(phase, info),
  };
}

/**
 * Ein gescheiterter Start, auf beiden Wegen gleich behandelt.
 *
 * Die Merkmale `startet`/`startFehler` an der Sitzung haengen an
 * `sessionAnlegen` -- der Fortsetzen-Weg hat keinen eigenen Kindprozess, den
 * dieses Programm halten koennte, also traegt er den Fehlschlag hier ein. Ein
 * `dir` gibt es dabei nicht immer; ohne eines bleibt es bei der Meldung, und
 * die ist ohnehin das, was der Mensch zuerst sieht.
 */
function startVerlaufEintragen(
  phase: 'beginnt' | 'steht' | 'gescheitert',
  info: { dir: string; key: string; ort: string; kurz?: string; grund?: string; protokoll?: string },
): void {
  // Der Fortsetzen-Weg laeuft immer auf dieser Maschine: eine ferne Sitzung
  // geht ueber `ssh`, und dann ist der Aufruf gar kein `wb-code` mehr, den
  // dieser Zweig behandelt.
  const schluessel = info.dir ? startSchluessel(config.machine, info.dir) : '';
  if (phase === 'beginnt') {
    if (!schluessel) return;
    laufendeStarts.set(schluessel, { seit: Date.now(), key: info.key });
    gescheiterteStarts.delete(schluessel);
    sessions = modellLesen();
    modellSenden();
    return;
  }
  if (schluessel) laufendeStarts.delete(schluessel);
  if (phase === 'steht') {
    if (schluessel) gescheiterteStarts.delete(schluessel);
    sessions = modellLesen();
    modellSenden();
    return;
  }
  startFehlschlagMelden(
    {
      ort: info.ort,
      kurz: info.kurz ?? '',
      grund: info.grund ?? '',
      protokoll: info.protokoll ?? '',
    },
    schluessel ? { machine: config.machine, dir: info.dir, key: info.key } : undefined,
  );
}

function startFehlschlagMelden(
  befund: { ort: string; kurz: string; grund: string; protokoll: string },
  ziel?: { machine: string; dir: string; key: string },
): void {
  process.stderr.write(
    `Sitzungsstart in ${befund.ort} GESCHEITERT -- ${befund.kurz || 'kein Grund im Protokoll'}`
    + `${befund.protokoll ? ` (${befund.protokoll})` : ''}\n`,
  );
  melde(befund.grund
    ? `Die Sitzung in ${befund.ort} ist NICHT gestartet:\n${befund.grund}`
      + (befund.protokoll ? `\n\nVollstaendig: ${befund.protokoll}` : '')
    : `Die Sitzung in ${befund.ort} ist NICHT gestartet, und wb-code hat keinen Grund hinterlassen.`
      + (befund.protokoll ? ` Protokoll: ${befund.protokoll}` : ''));
  anFenster(sitzungsfenster.aktuell(), 'awb:sitz-startfehler', {
    ort: befund.ort, kurz: befund.kurz, grund: befund.grund, protokoll: befund.protokoll,
  });
  if (ziel) {
    gescheiterteStarts.set(startSchluessel(ziel.machine, ziel.dir), {
      key: ziel.key, kurz: befund.kurz, protokoll: befund.protokoll, zeit: Date.now(),
    });
  }
  sessions = modellLesen();
  modellSenden();
  sitzungsfensterAuffrischen();
}

/**
 * Ein Plan ohne Nebenwirkung ausserhalb des Fensters. Hier steht die eine
 * Stelle, an der 'settings', 'refresh' und "laeuft schon" tatsaechlich etwas
 * bewirken -- alles davon bleibt in diesem Programm.
 */
async function planSofort(plan: Plan): Promise<void> {
  if (plan.command === 'settings') {
    seiteOffen = 'einstellungen';
    sessions = modellLesen();
    anOberflaeche('awb:seite', { name: 'einstellungen' });
    return;
  }
  if (plan.command === 'refresh') {
    sessions = modellLesen();
    modellSenden();
    if (seiteOffen) anOberflaeche('awb:seite', { name: seiteOffen });
    return;
  }
  if (plan.command === 'resume' && plan.daten?.bereitsAktiv) {
    // Sie laeuft schon: gezeigt, nicht gestartet.
    const ziel = String(plan.daten.tmuxSession ?? '');
    if (ziel) await sessionWaehlen(ziel).catch((e) => process.stderr.write(`${(e as Error).message}\n`));
  }
}

/**
 * V14: startet eine wirklich tote Session neu (Knopf statt Handarbeit mit
 * `wb-code --resume`). Prueft GEGEN DEN AKTUELLEN Stand, nicht gegen das, was
 * die Oberflaeche im Klickmoment zeigte -- ein Klick, der Sekunden vorher
 * entstand, darf keine inzwischen wieder laufende Session anfassen. `wb-code`
 * endet selbst mit `exec tmux attach`; ohne Terminal (stdio 'ignore') schlaegt
 * genau dieser letzte Schritt sofort fehl (geprueft: 'open terminal failed:
 * not a terminal', Exitcode 1) -- die Session steht zu dem Zeitpunkt schon,
 * das ist kein Fehlschlag dieser Funktion.
 */
function sessionWiederherstellen(id: string, mensch = false): { command: string; conversation: string; conversationReason: string } {
  const s = sessions.find((x) => x.id === id);
  if (!s) throw new Error(`unbekannte Session: ${id}`);
  if (!darfWiederherstellen(s)) throw new Error(`Session '${s.name}' ist nicht (mehr) im Zustand 'stopped' -- keine Wiederherstellung.`);
  // Ob das `wb-code`, das gleich laeuft, `--kontext` kennt -- oertlich das
  // eigene, fern das der Zielmaschine, ueber denselben ssh-Weg wie beim
  // Plus-Menue. Ohne diese Frage bliebe die einmal gewaehlte Stufe liegen.
  //
  // GEFRAGT WIRD NUR, WENN ES ETWAS ZU FRAGEN GIBT: die Probe startet einen
  // echten Prozess, und eine Sitzung ohne gewaehlte Stufe hat davon nichts.
  // (Ohne diese Bedingung lief sie bei JEDEM Fortsetzen mit -- aufgefallen an
  // einer fremden Suite, deren Attrappe den Probeaufruf mitprotokollierte.)
  const fern = s.machine !== config.machine;
  const kenntKontext = s.kontext > 0 && wbCodeKenntKontext(fern
    ? fernAufruf(s.machine, ['wb-code', ...KONTEXT_PROBE_ARGS])
    : [config.wbCodeBin, ...KONTEXT_PROBE_ARGS]);
  const cmd = reviveCommand(
    s, config.machine, config.wbCodeBin, harnessResume(s.harness), kenntKontext,
    reviveKennung(s, true),
  );
  // DERSELBE UMGANG WIE BEIM PLUS-MENUE (21.08.), und zwar in allen drei
  // Punkten. Bis heute stand hier `stdio: 'ignore'` und sonst nichts: der Grund
  // eines Fehlschlags wurde weggeworfen, es gab keinen Eigentuemer fuer einen
  // Modellserver, und in der Liste stand danach eine Sitzung, die nie kam.
  // Genau die Kette, die `sessionAnlegen` seit Auftrag 1 hinter sich hat.
  const startKey = startSchluessel(s.machine, s.dir);
  laufendeStarts.set(startKey, { seit: Date.now(), key: s.sessionKey });
  gescheiterteStarts.delete(startKey);
  const protokollPfad = join(config.stateDir, 'sitzungsstart',
    `${Date.now()}-fortsetzen-${basename(s.dir).replace(/[^A-Za-z0-9._-]/g, '_')}.log`);
  // DERSELBE MENSCHEN-NACHWEIS WIE BEIM PLUS-MENUE (21.08.2026, zweite des Nutzers
  // Ansage: "der user wird im menu gewarnt, das reicht, die app sollte es dann nicht
  // mehr verhindern"). Der Wiederholen-Pfeil ist der Knopf, den er drueckt, NACHDEM
  // ihm die Oberflaeche eine Stufe als nicht passend gezeigt hat -- gerade hier darf
  // eine abgelehnte Speicherbuchung ihn nicht ein zweites Mal aufhalten. `wb-code`
  // macht daraus mit `--mensch` eine laute Warnung statt eines Abbruchs.
  //
  // Die Ahnenreihe traegt hier aus demselben Grund wie in `sessionAnlegen`: `wb-code`
  // laeuft als Kind DIESES Prozesses. Und wie dort wird das Flag geprobt statt blind
  // angehaengt -- ein abgelehntes `--mensch` beendet `wb-code` mit Exit 1, und ein
  // Wiederholen, das daran scheitert, waere schlimmer als der Deckel.
  const menschUmgebungR: Record<string, string> = {};
  const cmdArgs = [...cmd.args];
  if (mensch && s.machine === config.machine) {
    const probeUmgebung = {
      ...process.env,
      WB_MENSCH_QUELLE: 'oberflaeche',
      WB_APP_PID: String(process.pid),
    };
    const probe = spawnSync(config.wbMenschBin, ['pruefen'], { env: probeUmgebung, timeout: 5000 });
    if (probe.status === 0) {
      cmdArgs.push('--mensch');
      menschUmgebungR.WB_MENSCH_QUELLE = 'oberflaeche';
      menschUmgebungR.WB_APP_PID = String(process.pid);
    }
  }
  const startUmgebung = { ...process.env, WB_EIGENTUEMER_WERKBANK: String(process.pid), ...menschUmgebungR };
  let kind: ReturnType<typeof spawn>;
  try {
    mkdirSync(dirname(protokollPfad), { recursive: true });
    const fd = openSync(protokollPfad, 'a');
    kind = spawn(cmd.bin, cmdArgs, { stdio: ['ignore', fd, fd], detached: true, env: startUmgebung });
    closeSync(fd);
    startGrundBeobachten(kind, protokollPfad, s.dir, startKey, s.sessionKey);
  } catch (e) {
    process.stderr.write(`Fortsetzen: kein Protokoll moeglich (${(e as Error).message}) -- Start ohne Mitschrift.\n`);
    kind = spawn(cmd.bin, cmdArgs, { stdio: 'ignore', detached: true, env: startUmgebung });
    kind.once('exit', () => { laufendeStarts.delete(startKey); });
  }
  kind.unref();
  // Der Satz geht mit ins Protokoll: nach dem Klick sieht der Mensch die
  // Oberflaeche, nicht die neue Session -- und ob seine Unterhaltung
  // zurueckkommt, darf er nicht erst am Pane merken.
  process.stderr.write(`revive '${s.name}' (Harness ${s.harness}): ${cmd.conversationReason}\n`);
  // cmdArgs statt cmd.args: was gemeldet wird, muss das sein, was wirklich lief -- mit --mensch, wenn es mitging.
  return { command: `${cmd.bin} ${cmdArgs.join(' ')}`, conversation: cmd.conversation, conversationReason: cmd.conversationReason };
}

/**
 * Der `resume`-Block eines Harness aus der Registry. Gelesen wird die Datei nur
 * nach, wenn sie sich geaendert hat -- die Vorschau unten laeuft im
 * Zwei-Sekunden-Takt, und 78 KB JSON je Takt waeren dafuer zu teuer.
 *
 * Kennt die Registry den Harness nicht (fremde Kennung, kaputte Datei), kommt
 * `undefined` zurueck, und `reviveCommand` verhaelt sich wie vor dem 06.08.
 * Das ist die vorsichtige Richtung: lieber der alte, fuer claude richtige Weg
 * als eine geratene Fortsetzung.
 */
let registryMerker: { mtimeMs: number; size: number; harnesses: Record<string, HarnessResume> } | null = null;
function harnessResume(id: string): HarnessResume | undefined {
  if (!id) return undefined;
  let st: { mtimeMs: number; size: number };
  try {
    const x = statSync(config.modelsFile);
    st = { mtimeMs: x.mtimeMs, size: x.size };
  } catch {
    return undefined;
  }
  if (!registryMerker || registryMerker.mtimeMs !== st.mtimeMs || registryMerker.size !== st.size) {
    const harnesses: Record<string, HarnessResume> = {};
    try {
      const roh = JSON.parse(readFileSync(config.modelsFile, 'utf8')) as Record<string, unknown>;
      const h = roh.harnesses;
      // Beide Formen: Objekt (heute) und Liste (aeltere Staende).
      const eintraege: Record<string, unknown>[] = Array.isArray(h)
        ? (h as Record<string, unknown>[])
        : Object.entries((h ?? {}) as Record<string, Record<string, unknown>>).map(([k, v]) => ({ id: k, ...v }));
      for (const e of eintraege) {
        const hid = String(e.id ?? '');
        if (!hid) continue;
        const r = (e.resume ?? {}) as Record<string, unknown>;
        harnesses[hid] = {
          id: hid,
          args: Array.isArray(r.args) ? (r.args as string[]) : undefined,
          fallbackArgs: Array.isArray(r.fallbackArgs) ? (r.fallbackArgs as string[]) : undefined,
          builtin: e.builtin === true,
        };
      }
    } catch {
      // Eine kaputte Registry darf den Knopf nicht sprengen -- dann gilt der alte Weg.
    }
    registryMerker = { ...st, harnesses };
  }
  return registryMerker.harnesses[id];
}

/**
 * Die Kennung der Unterhaltung EINES Ordners fuer einen Registry-Harness (cline/forge),
 * aufgeloest ueber `wb-resume-id` -- dieselbe Aufloesung wie im Pane-Weg shell/wb-revive,
 * nur einmal gepflegt (2026-09-06). Nur fuer NICHT-builtin Harnesses mit `{resumeId}`;
 * fuer claude bleibt es bei der gemerkten `claudeSessionId`. Ohne eindeutigen Treffer
 * (leere Ausgabe) `undefined`, und reviveCommand faengt dann neu an.
 *
 * `erlaubeFern` steuert den Preis: die Vorschau ruft dies fuer JEDE gestoppte Session bei
 * jedem Auffrischen, und ein `ssh` je Fernsitzung waere dort zu teuer -- deshalb loest die
 * Vorschau nur LOKAL auf (fern: `undefined`). Die WIRKLICHE Wiederherstellung (ein Klick)
 * loest auch fern auf.
 */
function reviveKennung(
  s: Pick<SessionInfo, 'harness' | 'dir' | 'machine'>,
  erlaubeFern = false,
): string | undefined {
  const h = harnessResume(s.harness);
  if (!h || h.builtin || !nimmtSitzungskennung(h) || !s.dir) return undefined;
  let bin: string;
  let argv: string[];
  if (s.machine === config.machine) {
    bin = config.wbResumeIdBin;
    argv = [s.harness, '--dir', s.dir, '--models', config.modelsFile];
  } else {
    if (!erlaubeFern) return undefined;
    [bin, ...argv] = fernAufruf(s.machine, ['wb-resume-id', s.harness, '--dir', s.dir]);
  }
  try {
    const r = spawnSync(bin, argv, { encoding: 'utf8', timeout: 6000 });
    if (r.status !== 0 || !r.stdout) return undefined;
    for (const line of r.stdout.split('\n')) {
      const idx = line.indexOf('\t');
      if (idx < 0) continue;
      if (line.slice(0, idx) !== 'id') continue;
      const id = line.slice(idx + 1).trim();
      if (/^[A-Za-z0-9._-]{1,128}$/.test(id)) return id;
    }
  } catch {
    /* eine kaputte Aufloesung darf den Knopf nie sprengen -- dann faengt die Session neu an */
  }
  return undefined;
}

/**
 * Eine NEUE Session anlegen -- der Knopf mit dem Plus ueber den Sessions.
 *
 * Dahinter steckt derselbe Weg wie bei der Wiederherstellung: `wb-code
 * <ordner>` legt die tmux-Session an, startet den Orchestrator und schreibt
 * die Zustandsdatei. Hier wird nur entschieden, ob der Aufruf erlaubt ist, und
 * der Aufruf zusammengebaut. Harness, Modell und Effort kommen aus den
 * Einstellungen -- wb-code liest sie selbst, und deshalb fragt der Knopf nur
 * nach dem Ordner und, wenn man mag, nach einem Namen.
 *
 * Wie bei `revive` ist das die Stelle, an der wirklich etwas STARTET. Also
 * dieselbe Strenge:
 *   - der Ordner muss existieren, unter dem Heimatverzeichnis liegen und darf
 *     nicht ausgeschlossen sein (dieselbe Liste wie im Ordnerbaum),
 *   - ein zweiter Klick binnen zehn Sekunden auf denselben Ordner laeuft ins
 *     Leere. `wb-code` ist zwar selbst idempotent (es haengt sich an eine
 *     bestehende Session an), aber sein Zustand steht erst da, wenn es
 *     durchgelaufen ist -- bis dahin saehe der zweite Klick nichts.
 *
 * MEHRERE SITZUNGEN IM SELBEN ORDNER (07.08.), Wunsch des Nutzers: „außerdem
 * sollen mehrere sessions im gleichen ordner möglich werden."
 *
 * Hier stand eine Ablehnung: laeuft in diesem Ordner schon eine Sitzung, wird
 * nichts gestartet, sondern die vorhandene benannt. Sie war eine Grenze DIESES
 * Knopfes, nicht des Unterbaus -- `wb-code --key <schluessel>` legt seit V2
 * (SPEC-V2, Abschnitt B) eine zweite Sitzung desselben Ordners an, deren
 * tmux-Name den Schluessel als Nachsilbe traegt und deren Zustandsdatei
 * `<slug>__<schluessel>.json` heisst. Das Sitzungsfenster gruppiert ohnehin
 * schon nach Ordner und klappt „N weitere" auf.
 *
 * Also: kennt der gewaehlte Ordner schon eine Sitzung -- laufend ODER beendet,
 * siehe die Begruendung unten an der Stelle selbst --, bekommt die neue einen
 * Schluessel. Er wird nicht hier erwuerfelt, sondern bei `wb-state new-key`
 * geholt -- dasselbe Werkzeug, das die Zustandsdateien anlegt, kennt als
 * einziges verlaesslich, welche Schluessel dieses Ordners schon vergeben sind.
 * Antwortet es nicht, wird NICHTS gestartet: eine zweite Sitzung ohne
 * Schluessel waere keine zweite, sondern ein zweiter Orchestrator in derselben.
 *
 * DER SCHUTZ GEGEN DEN DOPPELKLICK BLEIBT. Er verhindert etwas anderes als die
 * gefallene Sperre: nicht eine zweite Sitzung, sondern zwei Starts aus EINEM
 * Klick -- die zweite Meldung des Fensters, bevor `wb-code` seinen Zustand
 * geschrieben hat. Er greift weiterhin je Ordner und ueber zehn Sekunden; wer
 * absichtlich sofort eine zweite Sitzung will, klickt zehn Sekunden spaeter
 * noch einmal.
 *
 * DER LETZTE SATZ GILT SEIT DEM 07.08. NICHT MEHR -- die zehn Sekunden sind
 * keine Wartezeit mehr, sondern nur noch die Obergrenze fuer den einen Fall,
 * in dem nichts anderes zu erkennen ist. Was jetzt gilt und warum:
 *
 * Seit mehrere Sitzungen je Ordner erwuenscht sind, traf die pauschale Frist
 * auch den, der es SO WILL: zwei absichtliche Klicks im selben Ordner wurden
 * zehn Sekunden lang mit „Wird schon gestartet" abgewiesen, obwohl die erste
 * Sitzung laengst stand. Ein Doppelklick und zwei absichtliche Klicks
 * unterscheiden sich aber in dem, was DAZWISCHEN passiert: der zweite
 * absichtliche Klick faellt, nachdem die erste Sitzung angekommen ist -- ihre
 * Zustandsdatei liegt da und sie steht in der Leiste. Der zweite Anstoss eines
 * Doppelklicks kann das nicht gesehen haben; er kommt aus derselben
 * Handbewegung, und `wb-code` hat bis dahin nichts geschrieben. Genau diese
 * Luecke sollte der Schutz von Anfang an ueberbruecken (siehe den Absatz
 * darueber), und genau sie ueberbrueckt er jetzt -- nicht mehr.
 *
 * Drei Stufen, und jede hat ihren Grund:
 *   unter DOPPELKLICK_MS  wird IMMER abgewiesen. Zwei Ereignisse einer
 *                         Handbewegung liegen darunter (macOS laesst als
 *                         laengsten Doppelklick-Abstand rund eine Sekunde zu);
 *                         ohne diese Untergrenze haenge die Unterscheidung
 *                         daran, ob `wb-code` schneller ist als der Finger,
 *                         und das ist keine Grenze, sondern ein Wettlauf.
 *   bis START_FRIST_MS    wird abgewiesen, SOLANGE der erste Start nicht
 *                         angekommen ist -- gemessen an der Zahl der Sitzungen
 *                         dieses Ordners, die beim Start gemerkt wurde.
 *   danach                gilt nichts mehr. Ein `wb-code`, das in zehn
 *                         Sekunden nichts geschrieben hat, wird es auch nicht
 *                         mehr tun; dann darf ein zweiter Versuch nicht ewig
 *                         an einem gescheiterten ersten haengenbleiben.
 *
 * Der Weg ueber die Oberflaeche haette diesen Schutz uebrigens gar nicht mehr
 * noetig -- das Sitzungsfenster sperrt sich waehrend eines laufenden Starts
 * selbst (`beschaeftigt` in sitzung/sitzung.ts), und der Ordnerdialog davor ist
 * modal. Er bleibt fuer den Steuerkanal und fuer jede kuenftige Oberflaeche,
 * die diese beiden Sicherungen nicht hat.
 */
const gestarteteOrdner = new Map<string, { zeit: number; sitzungenVorher: number }>();

/** Kuerzer als jeder Doppelklick -- darunter wird nie gestartet. */
const DOPPELKLICK_MS = 1500;
/** Obergrenze: danach greift der Schutz gar nicht mehr. */
const START_FRIST_MS = 10000;

/**
 * Darf in diesem Ordner JETZT gestartet werden? `sitzungenJetzt` ist die Zahl
 * der bekannten Sitzungen dieses Ordners aus dem eben gelesenen Modell -- sie
 * ist der Beleg dafuer, dass der vorige Start angekommen ist.
 */
function startErlaubt(pfad: string, sitzungenJetzt: number, jetzt: number): boolean {
  const vorheriger = gestarteteOrdner.get(pfad);
  if (!vorheriger) return true;
  const her = jetzt - vorheriger.zeit;
  if (her >= START_FRIST_MS) return true;
  if (her < DOPPELKLICK_MS) return false;
  return sitzungenJetzt > vorheriger.sitzungenVorher;
}

/**
 * Ein freier Sitzungsschluessel fuer diesen Ordner, von `wb-state new-key`.
 * Leer heisst: das Werkzeug hat nicht geantwortet -- der Aufrufer startet dann
 * nichts.
 */
/**
 * `wb-state new-key <dir>` -- lokal direkt, auf einer FERNMASCHINE ueber
 * dieselbe `fernAufruf`-Zeile wie jeder andere Griff auf eine Fernsitzung
 * (pfad.ts). Der lokale Werkzeugname (`befehlsUmgebung().wbStateBin`) gilt nur
 * hier: er kann in Tests auf eine Attrappe zeigen, die es auf der anderen
 * Maschine nicht gibt. Drueben zaehlt nur der PATH-Name, wie bei `wb-code` in
 * revive.ts.
 */
function neuerSitzungsschluessel(dir: string, machine: string): { key: string; fehler: string } {
  const fern = machine !== config.machine;
  const bin = fern ? 'ssh' : befehlsUmgebung().wbStateBin;
  const args = fern
    ? fernAufruf(machine, ['wb-state', 'new-key', dir]).slice(1)
    : ['new-key', dir];
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: config.remoteTimeoutMs + 2000 });
  const anzeige = fern ? `wb-state new-key (auf '${machine}')` : `${bin} new-key`;
  if (r.error) return { key: '', fehler: `${anzeige} liess sich nicht aufrufen: ${r.error.message}` };
  const key = (r.stdout ?? '').trim();
  if (r.status !== 0 || !/^[0-9a-f]{4,16}$/.test(key)) {
    const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    return { key: '', fehler: `${anzeige} lieferte keinen Schluessel${text ? `: ${text}` : ''}` };
  }
  return { key, fehler: '' };
}

/**
 * Ob es `pfad` auf `machine` als Verzeichnis gibt -- lokal `statSync`, fern
 * `ssh <machine> [ -d <pfad> ]` mit derselben Zeitgrenze wie jeder andere
 * Fernaufruf. GENUTZT AN ZWEI STELLEN: einmal als eigener „Pruefen"-Knopf im
 * Fenster (der Mensch will es vorher wissen, ohne gleich zu starten), einmal
 * hier in `sessionAnlegen` selbst -- dieselbe Pruefung, kein zweiter Weg, der
 * abweichen koennte.
 */
function fernOrdnerPruefen(machine: string, pfad: string): { ok: boolean; meldung: string } {
  const ziel = (pfad || '').trim();
  if (!ziel.startsWith('/')) {
    return { ok: false, meldung: `Auf '${machine}' wird ein absoluter Pfad gebraucht: ${ziel || '(leer)'}` };
  }
  const [bin, ...args] = fernAufruf(machine, ['test', '-d', ziel]);
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: config.remoteTimeoutMs + 2000 });
  if (r.error) return { ok: false, meldung: `ssh liess sich nicht aufrufen: ${r.error.message}` };
  if (r.status === 0) return { ok: true, meldung: `Ordner gefunden auf '${machine}'.` };
  const fehler = `${r.stderr ?? ''}`.trim().split('\n').pop() ?? '';
  return { ok: false, meldung: fehler || `kein Verzeichnis auf '${machine}': ${ziel}` };
}

/**
 * DIE WAHL FUER GENAU DIESE EINE SITZUNG (19.08.), Wort des Nutzers: „damit man,
 * wenn man nur diese eine Sitzung anders fahren will, nicht erst in die
 * Einstellungen muss und sie danach wieder zurueckstellt."
 *
 * Sie geht ausschliesslich als BEFEHLSZEILE mit -- `wb-code` kennt die vier
 * Schalter laengst und laesst sie den Einstellungen vorgehen (shell/wb-code,
 * Zeilen 166-168: die Datei wird nur gelesen, wenn nichts auf der Zeile steht).
 * DIE EINSTELLUNGSDATEI WIRD DABEI NICHT ANGEFASST, und zwar nirgends auf
 * diesem Weg: es gibt hier keinen `wb-state settings set`-Aufruf, weder vor
 * noch nach dem Start. Genau das ist der Sinn dieses zweiten Weges.
 *
 * Ein Feld, das leer bleibt, erzeugt KEINEN Schalter -- dann gilt fuer diesen
 * Punkt weiter, was in den Einstellungen steht.
 */
export interface SitzungsWahl {
  harness?: string;
  model?: string;
  effort?: string;
  /** Kontextfenster in Token. Nur bei einem lokalen Modell sinnvoll -- 0 heisst „nichts sagen". */
  kontext?: number;
}

/** Ein Wert, der ohne Anfuehrungszeichen auf eine Befehlszeile darf. */
function harmlosesArgument(wert: string): boolean {
  return /^[A-Za-z0-9._:/-]{1,120}$/.test(wert);
}

/**
 * `machine` ist NEU (11.08., Bauteil 1): ohne Angabe wie bisher die eigene
 * Maschine, mit einer aus `config.remoteMachines` startet die Sitzung DORT --
 * ueber dieselbe `fernAufruf`-Zeile, mit der auch Fortsetzen, Schliessen und
 * Loeschen eine Fernsitzung erreichen (revive.ts, pfad.ts). Der native
 * Ordner-Dialog kann drueben nichts waehlen; der Pfad kommt darum als Text aus
 * dem Fenster und wird HIER gegen die Fernmaschine geprueft, nicht nur gegen
 * eine Zeichenkette.
 */
/**
 * Warten, bis `wb-code` durch ist, und den Grund zeigen, wenn keine Sitzung
 * entstanden ist.
 *
 * GEWARTET WIRD AUF 'exit', NICHT AUF 'close': `wb-code` laesst Hintergrund-
 * prozesse zurueck, die die Ausgabedatei geerbt haben (record_conversation,
 * bis zu 40 s). 'close' kaeme erst, wenn auch die fertig sind -- der Mensch
 * saehe seinen Fehlschlag also eine halbe Minute zu spaet.
 *
 * Der Exit-Code sagt hier NICHTS: `wb-code` endet mit `exec tmux attach`, und
 * das scheitert ohne Terminal immer. Entschieden wird an der Marke im
 * Protokoll, siehe startprotokoll.ts.
 */
function startGrundBeobachten(
  kind: ReturnType<typeof spawn>,
  protokollPfad: string,
  ort: string,
  schluessel: string,
  sitzungsSchluessel: string,
): void {
  kind.once('exit', () => {
    // Der Startvorgang ist beendet, wie auch immer er ausging: die Zeile in der
    // Liste soll ab jetzt nicht mehr „startet" sagen.
    laufendeStarts.delete(schluessel);
    // Ein kurzer Nachlauf: die letzte stderr-Zeile kann die Datei nach dem
    // Prozessende noch erreichen (der Puffer des Kernels), und gerade die
    // letzte Zeile traegt oft den Abbruchgrund.
    setTimeout(() => {
      let inhalt = '';
      try {
        inhalt = readFileSync(protokollPfad, 'utf8');
      } catch {
        return;
      }
      const befund = startBefund(inhalt);
      if (befund.gestartet) {
        gescheiterteStarts.delete(schluessel);
        return;
      }
      const kurz = kurzfassung(befund.grund);
      // GESCHEITERT IST NICHT BEENDET (21.08.). Ohne diese Zeile stuende die
      // Sitzung gleich wieder als gewoehnliche beendete da und fiele bei
      // `showStopped: false` aus der Liste -- genau der Fall, in dem alice
      // seine Sitzung nicht mehr fand.
      gescheiterteStarts.set(schluessel, {
        key: sitzungsSchluessel, kurz, protokoll: protokollPfad, zeit: Date.now(),
      });
      process.stderr.write(`Sitzungsstart in ${ort} GESCHEITERT -- ${kurz || 'kein Grund im Protokoll'} (${protokollPfad})\n`);
      const text = befund.grund
        ? `Die Sitzung in ${ort} ist NICHT gestartet:\n${befund.grund}\n\nVollstaendig: ${protokollPfad}`
        : `Die Sitzung in ${ort} ist NICHT gestartet, und wb-code hat keinen Grund hinterlassen. Protokoll: ${protokollPfad}`;
      melde(text);
      anFenster(sitzungsfenster.aktuell(), 'awb:sitz-startfehler', {
        ort, kurz, grund: befund.grund, protokoll: protokollPfad,
      });
      // Damit die Zeile in der Leiste nachzieht: der Ordner steht jetzt als
      // gescheiterter Start da (nicht als beendete Sitzung), und das Fenster
      // soll das zeigen, statt auf einen Start zu warten, der nicht mehr kommt.
      sessions = modellLesen();
      modellSenden();
      sitzungsfensterAuffrischen();
    }, 400);
  });
}

/**
 * WAS ZWISCHEN KLICK UND LAUFENDER SITZUNG PASSIERT -- und warum es hier steht
 * und nicht in `sessions.ts` (21.08.).
 *
 * `wb-code` schreibt die Zustandsdatei frueh und legt seine tmux-Sitzung spaet
 * an; dazwischen liegt bei einem lokalen Modell das Laden von rund 20 GiB.
 * Aus dem Dateisystem allein ist dieser Zwischenzustand nicht zu erkennen: die
 * Datei sieht genauso aus wie die einer beendeten Sitzung. Wer es weiss, ist
 * dieser Prozess -- er hat den Start ausgeloest und haelt das Kind.
 *
 * DIE ZUORDNUNG GEHT UEBER MASCHINE, ORDNER UND SCHLUESSEL, nicht ueber die
 * Kennung: die entsteht erst mit der Zustandsdatei, also nach dem Start. Ein
 * Start ohne eigenen Schluessel meint die Standardsitzung des Ordners (die mit
 * leerem `sessionKey`) -- genau die, die `wb-code` ohne `--key` bedient.
 */
interface Startvorgang { seit: number; key: string; }
const laufendeStarts = new Map<string, Startvorgang>();
const gescheiterteStarts = new Map<string, { key: string; kurz: string; protokoll: string; zeit: number }>();
/**
 * Wie lange ein gescheiterter Start in der Liste stehen bleibt, wenn ihn
 * niemand mehr anfasst. Er verschwindet ausserdem sofort, sobald die Sitzung
 * doch laeuft oder ein neuer Versuch beginnt -- diese Frist ist nur die
 * Obergrenze fuer den Fall, dass beides nie eintritt. Zwoelf Stunden: lang
 * genug, um am naechsten Morgen noch dazustehen, kurz genug, um nicht ewig zu
 * bleiben.
 */
const START_FEHLER_VERFALL_MS = 12 * 60 * 60 * 1000;

/** Maschine und Ordner -- der Schluessel beider Karten. */
function startSchluessel(machine: string, dir: string): string {
  return `${machine}\t${dir}`;
}

/**
 * Gehoert diese Sitzung zu jenem Startvorgang? Mit Schluessel: nur die Sitzung
 * mit genau diesem `sessionKey`. Ohne: nur die Standardsitzung des Ordners.
 */
function startBetrifft(s: SessionInfo, key: string): boolean {
  return key ? s.sessionKey === key : !s.sessionKey;
}

/**
 * Die beiden Merkmale an die frisch gelesene Liste heften -- und dabei
 * aufraeumen, was sich erledigt hat.
 */
function startzustand(liste: SessionInfo[]): void {
  const jetzt = Date.now();
  for (const [k, v] of gescheiterteStarts) {
    if (jetzt - v.zeit > START_FEHLER_VERFALL_MS) gescheiterteStarts.delete(k);
  }
  for (const s of liste) {
    const k = startSchluessel(s.machine, s.dir);
    const laeuft = laufendeStarts.get(k);
    if (laeuft && startBetrifft(s, laeuft.key)) {
      // Steht die Sitzung schon, ist der Startvorgang beantwortet -- auch wenn
      // `wb-code` noch ein paar Zeilen schreibt.
      if (s.state === 'stopped') { s.startet = true; continue; }
      laufendeStarts.delete(k);
    }
    const fehler = gescheiterteStarts.get(k);
    if (!fehler || !startBetrifft(s, fehler.key)) continue;
    // Laeuft sie wieder, ist der alte Fehlschlag Geschichte.
    if (s.state !== 'stopped') { gescheiterteStarts.delete(k); continue; }
    s.startFehler = true;
  }
}

function sessionAnlegen(
  dir: string,
  name: string,
  machine: string = config.machine,
  wahl?: SitzungsWahl,
  mensch = false,
): { gestartet: boolean; meldung: string; command: string } {
  const pfad = (dir || '').trim();
  if (!pfad) throw new Error('Feld dir fehlt');
  const fern = machine !== config.machine;
  if (fern) {
    if (!pfad.startsWith('/')) throw new Error(`Auf '${machine}' wird ein absoluter Pfad gebraucht: ${pfad}`);
  } else {
    const heim = homedir();
    if (!pfad.startsWith(heim + '/') && pfad !== heim) {
      throw new Error(`Ordner liegt nicht unter ${heim}: ${pfad}`);
    }
  }
  // Seit der Ordner aus dem NATIVEN Dialog (oertlich) oder einem Textfeld
  // (fern) kommt, ist das die einzige Stelle, an der die Ausschlussliste noch
  // greifen kann -- keiner der beiden Wege kennt sie. Deshalb steht der Pfad
  // in der Meldung: sie erscheint erst, wenn die Wahl schon getroffen ist, und
  // ohne ihn wuesste niemand, welcher Ordner gemeint war.
  if (isExcluded(pfad, config.excludeGlobs)) throw new Error(`Ordner ist ausgeschlossen: ${pfad}`);
  if (fern) {
    const p = fernOrdnerPruefen(machine, pfad);
    if (!p.ok) throw new Error(p.meldung);
  } else {
    let verzeichnis = false;
    try {
      verzeichnis = statSync(pfad).isDirectory();
    } catch {
      verzeichnis = false;
    }
    if (!verzeichnis) throw new Error(`kein Verzeichnis: ${pfad}`);
  }

  // Das Modell wird VOR dem Schutz gelesen, nicht danach: seine Frage lautet
  // seit dem 07.08. „ist der vorige Start angekommen?", und die Antwort steht
  // genau hier drin. Es ist derselbe eine Lesevorgang wie bisher, nur frueher.
  sessions = modellLesen();
  // Nach MASCHINE UND Ordner, nicht nur nach Ordner (11.08.): zwei Maschinen
  // koennen denselben Pfad tragen, ohne dieselbe Sitzung zu meinen.
  const bekannte = sessions.filter((x) => x.dir === pfad && x.machine === machine);
  const bekannteSitzungen = bekannte.length;
  const schutzSchluessel = `${machine} ${pfad}`;
  if (!startErlaubt(schutzSchluessel, bekannteSitzungen, Date.now())) {
    return { gestartet: false, meldung: 'Wird schon gestartet -- einen Augenblick.', command: '' };
  }
  // Kennt dieser Ordner ueberhaupt schon eine Sitzung, bekommt die neue einen
  // eigenen Schluessel -- sonst haengt sich `wb-code` an die vorhandene an.
  //
  // HIER STAND BIS ZUM 11.08. `state !== 'stopped'`, also nur die LEBENDEN, mit
  // der Begruendung: steht dort nur eine beendete, ist der Standardplatz des
  // Ordners frei und die Sitzung kehrt unter ihrem gewohnten Namen zurueck. Der
  // Platz ist aber nicht frei. Was ihn belegt, ist nicht der Pane, sondern die
  // Zustandsdatei, und die liegt weiter da: `wb-code` ohne `--key` liest ueber
  // `wb-state session` ihren tmux-Namen, schreibt mit `--name` IHREN Namen um
  // und setzt ueber `recorded_conversation` sogar ihre Unterhaltung fort
  // (shell/wb-code, Abschnitt „Crash recovery"). Wer „Neue Sitzung" drueckt,
  // bekam damit die alte zurueck -- ohne zweite Zeile im Fenster, dafuer mit
  // einem fremden Gespraech und einem ueberschriebenen Namen.
  //
  // Fortsetzen und Neu sind in diesem Fenster zwei Knoepfe nebeneinander. Wer
  // die alte Sitzung will, hat den anderen; also heisst neu hier ab jetzt neu.
  let key = '';
  if (bekannte.length) {
    const k = neuerSitzungsschluessel(pfad, machine);
    if (!k.key) {
      return {
        gestartet: false,
        meldung: `In diesem Ordner ist schon die Sitzung "${bekannte[0].name}" bekannt, und fuer eine `
          + `weitere liess sich kein Schluessel holen -- ${k.fehler}`,
        command: '',
      };
    }
    key = k.key;
  }

  const args = [pfad];
  const sauber = name.trim();
  if (sauber) {
    if (!/^[A-Za-z0-9 _.-]{1,60}$/.test(sauber)) throw new Error('Name enthaelt Zeichen, die hier nicht vorgesehen sind');
    args.push('--name', sauber);
  }
  if (key) args.push('--key', key);
  // Gemerkt wird der Stand VOR dem Start: an ihm erkennt der naechste Versuch,
  // ob dieser hier inzwischen angekommen ist.
  gestarteteOrdner.set(schutzSchluessel, { zeit: Date.now(), sitzungenVorher: bekannteSitzungen });
  // Ab hier laeuft ein Start fuer diesen Ordner, und die Liste soll das sagen
  // statt „beendet". Ein neuer Versuch loescht den alten Fehlschlag: was gerade
  // laeuft, ist die aktuellere Auskunft.
  const startKey = startSchluessel(machine, pfad);
  laufendeStarts.set(startKey, { seit: Date.now(), key });
  gescheiterteStarts.delete(startKey);

  const ort = fern ? `${pfad} auf '${machine}'` : pfad;
  const ort0 = ort;

  // --- Die Wahl fuer diese eine Sitzung (19.08.) ---------------------------
  //
  // Sie steht ZWISCHEN Ordner und Aufrufbau, weil `--kontext` davon abhaengt,
  // WELCHES `wb-code` gleich laeuft: bei einer Fernmaschine ist das ihres, und
  // ob es den Schalter kennt, weiss nur sie selbst.
  let kontextWeggelassen = '';
  for (const [flagge, wert] of [['--harness', wahl?.harness], ['--model', wahl?.model], ['--effort', wahl?.effort]] as const) {
    const w = (wert ?? '').trim();
    if (!w) continue;
    if (!harmlosesArgument(w)) throw new Error(`Wert fuer ${flagge} enthaelt Zeichen, die hier nicht vorgesehen sind: ${w}`);
    args.push(flagge, w);
  }
  const kontext = Math.trunc(Number(wahl?.kontext ?? 0));
  if (kontext > 0) {
    // GEFRAGT WIRD DAS `wb-code`, DAS GLEICH LAEUFT -- oertlich das eigene,
    // fern das der Zielmaschine ueber denselben ssh-Weg. Kennt es den Schalter
    // nicht, bleibt er weg und die Sitzung startet trotzdem; was fehlt, steht
    // danach in der Meldung.
    //
    // DIE PROBE WIRD GANZ GEBAUT, nicht an einen fertigen Aufruf angehaengt:
    // `fernAufruf` faltet den fernen Befehl zu EINER gequoteten Zeichenkette
    // zusammen, an die sich nichts mehr anhaengen laesst (siehe kontext.ts).
    // Aus demselben Grund steht dieser Block VOR dem Bau von bin/kindArgs --
    // `--kontext` gehoert in `args`, nicht dahinter.
    const probe = fern
      ? fernAufruf(machine, ['wb-code', ...KONTEXT_PROBE_ARGS])
      : [config.wbCodeBin, ...KONTEXT_PROBE_ARGS];
    if (wbCodeKenntKontext(probe)) args.push('--kontext', String(kontext));
    else kontextWeggelassen = String(kontext);
  }
  // DER MENSCHEN-NACHWEIS FUER DIESEN EINEN START (21.08.2026, Entscheidung des Nutzers).
  //
  // Der Effort-Deckel bindet den AGENTEN, nicht den Menschen -- er sagt, was ein Orchestrator
  // seinen Workern zugesteht. `wb-code` prueft ihn trotzdem beim Sitzungsstart, und zwar aus
  // einem guten Grund: die HERKUNFT, nicht die Rolle. Ein Aufruf ohne belegten Menschen
  // koennte von einem Agenten kommen, und der soll sich keine teure eigene Sitzung aufmachen.
  // Die Folge war, dass eigener des Nutzers Klick im Plus-Menue wie ein Agentenaufruf behandelt
  // wurde: bei einem Modell, dessen Deckel unter seiner Wahl liegt, brach der Start ab mit
  // "Als MENSCH darueber hinaus starten: --mensch" -- ein Verweis auf einen Weg, den die
  // Oberflaeche selbst nicht ging.
  //
  // WARUM ES HIER TRAEGT UND IM FORTSETZEN-WEG NICHT. `wb-mensch` glaubt die Variablen nicht,
  // es misst: die genannte PID muss ein echter VORFAHRE des Aufrufs sein und wie dieses
  // Programm heissen. Genau hier laeuft `wb-code` als Kind dieses Prozesses, auch abgeloest --
  // dieselbe Ahnenreihe, auf die sich WB_EIGENTUEMER_WERKBANK ein paar Zeilen weiter stuetzt.
  // Der Fortsetzen-Weg in befehle.ts geht ueber eine tmux-Hilfssession, dort ist der
  // tmux-SERVER der Elternprozess und die Huerde traegt nicht. Sie dafuer aufzuweichen hiesse,
  // jedem Agenten den Menschen-Nachweis zu schenken; also bleibt dieser Weg dort aus.
  //
  // ERST PROBIEREN, DANN MITGEBEN. `wb-code` verzeiht einen abgelehnten `--mensch` nicht,
  // sondern bricht mit Exit 1 ab. Ein blind angehaengtes Flag koennte also den ganzen Start
  // verhindern, sobald die Ahnenreihe aus irgendeinem Grund nicht durchgeht. Die Probe laeuft
  // aus DIESEM Prozess und hat damit dieselbe Ahnenreihe wie das Kind gleich darauf.
  //
  // `mensch` kommt aus `isTrusted` im Fenster und wird hier NICHT nachgebessert: ein
  // `el.click()` aus dem Steuerkanal traegt false, und der Steuerkanal-Weg ruft diese
  // Funktion ohnehin ohne das Merkmal. Fern gilt es nie -- dort laeuft `wb-code` auf der
  // anderen Maschine, und dieses Programm ist dort kein Vorfahre von irgendwas.
  const menschUmgebung: Record<string, string> = {};
  let menschBeleg = '';
  if (mensch && !fern) {
    const probeUmgebung = {
      ...process.env,
      WB_MENSCH_QUELLE: 'oberflaeche',
      WB_APP_PID: String(process.pid),
    };
    const probe = spawnSync(config.wbMenschBin, ['pruefen'], { env: probeUmgebung, timeout: 5000 });
    if (probe.status === 0) {
      args.push('--mensch');
      menschUmgebung.WB_MENSCH_QUELLE = 'oberflaeche';
      menschUmgebung.WB_APP_PID = String(process.pid);
      menschBeleg = 'mensch';
    } else {
      // Kein Abbruch: ohne das Flag startet derselbe Aufruf normal, dann greift der Deckel.
      // Gesagt wird es trotzdem, sonst bekaeme er still weniger, als er gewaehlt hat.
      menschBeleg = 'kein-mensch';
    }
  }
  let bin: string; let kindArgs: string[];
  if (fern) {
    const [b, ...rest] = fernAufruf(machine, ['wb-code', ...args]);
    bin = b; kindArgs = rest;
  } else {
    bin = config.wbCodeBin; kindArgs = args;
  }
  // NICHT MEHR `stdio: 'ignore'` (21.08.2026). Genau daran ist des Nutzers
  // 256k-Sitzung unsichtbar gescheitert: `wb-code` schrieb den vollstaendigen
  // Grund auf stderr -- die abgelehnte Speicherbuchung mit Spitze, Verfuegbarem
  // und Halter --, und dieser Prozess warf ihn weg. Im Fenster stand nur
  // "Stopped", also ein Zustand statt eines Fehlschlags, und die Suche lief
  // stundenlang an der falschen Stelle.
  //
  // Die Ausgabe geht in eine DATEI, nicht in eine Pipe: `wb-code` startet
  // Hintergrundprozesse, die stderr erben (record_conversation laeuft bis zu
  // 40 s weiter), und eine Pipe bliebe dann offen, waehrend das Kind laengst
  // beendet ist. Eine Datei hat dieses Problem nicht und bleibt ausserdem
  // liegen -- wer spaeter nachsehen will, findet sie unter dem Pfad, den die
  // Meldung nennt.
  const protokollPfad = join(config.stateDir, 'sitzungsstart',
    `${Date.now()}-${basename(pfad).replace(/[^A-Za-z0-9._-]/g, '_')}.log`);
  // DIESES PROGRAMM ALS EIGENTUEMER (21.08.2026). `wb-nohup` startet keinen
  // abgeloesten Prozess ohne nachweisbaren Eigentuemer -- ohne einen wuerde ein
  // Modellserver von 20 GiB spaeter niemandem gehoeren und niemand koennte
  // sagen, ob ihn noch jemand braucht. Bis heute kannte es zwei Arten, einen
  // tmux-Pane und einen launchd-Job; die Oberflaeche hat weder das eine noch
  // das andere, und deshalb brach jeder Start einer Sitzung mit lokalem Modell
  // ueber das Plus-Menue ab (gemessen 21.08.: "wb-nohup: braucht einen
  // tmux-Pane als Bezugspunkt", danach "wb-code: 'wb-mlx-server ensure' ...
  // fehlgeschlagen -- kein Start").
  //
  // Die dritte Art ist dieses Programm selbst. Weitergereicht wird nur die
  // PID; alles andere misst `wb-nohup` nach -- laeuft der Prozess, heisst er
  // wie die Werkbank, und ist er ein echter VORFAHRE des Aufrufs. Das Letzte
  // traegt genau hier: `wb-code` laeuft als Kind dieses Prozesses, auch
  // abgeloest. Ein Agent, der die Variable selbst setzt, kann sich nicht unter
  // den Electron-Hauptprozess haengen.
  const startUmgebung = { ...process.env, WB_EIGENTUEMER_WERKBANK: String(process.pid), ...menschUmgebung };
  let kind: ReturnType<typeof spawn>;
  try {
    mkdirSync(dirname(protokollPfad), { recursive: true });
    const fd = openSync(protokollPfad, 'a');
    kind = spawn(bin, kindArgs, { stdio: ['ignore', fd, fd], detached: true, env: startUmgebung });
    closeSync(fd);
    startGrundBeobachten(kind, protokollPfad, ort0, startKey, key);
  } catch (e) {
    // Ein Protokoll ist eine Verbesserung, keine Bedingung: laesst es sich nicht
    // anlegen, startet die Sitzung wie bisher -- nur eben wieder stumm.
    process.stderr.write(`Sitzungsstart: kein Protokoll moeglich (${(e as Error).message}) -- Start ohne Mitschrift.\n`);
    kind = spawn(bin, kindArgs, { stdio: 'ignore', detached: true, env: startUmgebung });
    // Ohne Protokoll gibt es keinen Grund zu zeigen -- dass der Start VORBEI
    // ist, laesst sich trotzdem sagen, und die Zeile darf nicht ewig „startet"
    // behaupten.
    kind.once('exit', () => { laufendeStarts.delete(startKey); });
  }
  kind.unref();
  const meldung = (key
    ? `Weitere Session in ${ort} wird gestartet (Schluessel ${key}) -- `
      + `die ${bekannte.length === 1 ? 'bisherige bleibt' : 'bisherigen bleiben'}, wie sie ${bekannte.length === 1 ? 'ist' : 'sind'}.`
    : `Session in ${ort} wird gestartet.`)
    // Was weggelassen wurde, wird gesagt und nicht verschwiegen -- sonst liefe
    // die Sitzung mit einem anderen Fenster, als im Fenster stand.
    + (kontextWeggelassen
      ? ` Das Kontextfenster ${kontextWeggelassen} ging NICHT mit: dieses wb-code kennt --kontext noch nicht.`
      : '')
    // Auch das wird gesagt und nicht verschwiegen: sonst liefe die Sitzung mit einer
    // niedrigeren Denkstufe, als im Fenster stand, und niemand wuesste warum.
    + (menschBeleg === 'kein-mensch'
      ? ' Der Klick zaehlte NICHT als Mensch (wb-mensch hat die Probe abgelehnt) --'
        + ' fuer diesen Start gilt deshalb der Effort-Deckel. Diagnose: wb-mensch beleg.'
      : '');
  return { gestartet: true, meldung, command: `${bin} ${kindArgs.join(' ')}` };
}

/** Liest neu und schickt beides zusammen -- der Aufrufer entscheidet, wann. */
function freigabenAktualisieren(): void {
  freigaben = {
    requests: readRequests(config.requestsDir),
    guardBlocks: readGuardBlocks(config.guardBlocksDir, sessions, config.tmuxSocket),
    // V17: der Verlauf, gruppiert -- welche Muster WIEDERHOLT anschlagen,
    // nicht nur der Momentanwert des laufenden Blocks (das ist guardBlocks).
    guardLog: readGuardLog(config.guardLogFile),
  };
  anOberflaeche('awb:freigaben', freigaben);
  // Benachrichtigung 'freigabeWartet': beide Quellen zaehlen (Antrag UND
  // wartende Rueckfrage), ueber eigene Vorsilben getrennt, damit derselbe
  // Schluessel nie aus zwei verschiedenen Anlaessen kommen kann.
  const wartendeSchluessel = [
    ...freigaben.requests.map((r) => `antrag:${r.path}`),
    ...freigaben.guardBlocks.filter((b) => b.wartet).map((b) => `rueckfrage:${b.schluessel || b.path}`),
  ];
  meldungFreigabe.neue(wartendeSchluessel).forEach(() => {
    melden('freigabeWartet', 'Eine Freigabe wartet auf Entscheidung.', meldungsEinstellungen(config.settingsFile), STANDARD_WEGE);
  });
}

/**
 * Ueber einen wartenden Eintrag der mittleren Stufe entscheiden. Gesucht wird
 * ueber den Schluessel (Befehl+Pane+Verzeichnis), nicht ueber den Dateipfad:
 * der Schluessel ist derselbe Wert, den der Hook beim Einloesen bildet, und
 * damit die einzige Kennung, die auf BEIDEN Seiten dieselbe Sache benennt.
 */
function musterEntscheiden(
  schluessel: string,
  aktion: 'approve' | 'reject',
  grund: string,
  mensch = false,
): FreigabeErgebnis {
  freigabenAktualisieren();
  const eintrag = freigaben.guardBlocks.find((b) => b.wartet && b.schluessel === schluessel);
  if (!eintrag) return { ok: false, output: 'Kein wartender Eintrag mit diesem Schluessel -- schon entschieden oder abgelaufen.' };
  // `mensch` kommt aus `isTrusted` im Fenster und wird hier NICHT nachgebessert:
  // die Vorgabe ist `false`, also gilt jeder Weg, der nichts sagt (Steuerkanal,
  // ein Skript), als Agent. Ablehnen darf jeder -- es nimmt nichts weg.
  const ergebnis = aktion === 'approve'
    ? freigabeErteilen(eintrag, grund, config.askGrantTtlSeconds, {
      bin: config.wbFreigabeBin,
      grantsDir: config.askGrantsDir,
      blocksDir: config.guardBlocksDir,
      logFile: config.guardLogFile,
      appPid: process.pid,
    }, mensch)
    : freigabeVerweigern(config.guardLogFile, eintrag, grund);
  freigabenAktualisieren();
  return ergebnis;
}

/**
 * Der Ordner, bei dem die Ordneransicht anfaengt (4c.2): der Projektordner
 * der Session, in der man gerade ist, sonst das Eigenheimverzeichnis -- so
 * gibt es immer einen sinnvollen Anfang.
 */
function ordnerWurzel(): string {
  return gewaehlte()?.dir || homedir();
}

function ordnerLesen(pfad: string): { root: string; entries: EintragInfo[] } {
  const root = pfad || ordnerWurzel();
  // Ein ausgeschlossener Pfad wird nicht gelistet, auch nicht direkt
  // angefordert -- dieselbe Zusage wie beim Baum selbst, nur am zweiten Weg
  // hinein (der Steuerkanal statt eines Klicks) noch einmal durchgesetzt.
  const entries = isExcluded(root, config.excludeGlobs) ? [] : listDir(root, config.excludeGlobs);
  return { root, entries };
}

/**
 * Eine Datei aus der Ordneransicht oder der Suche oeffnen -- im Programm des
 * Menschen, wie schon bei den Ergebnisdateien (V2). Geprueft wird serverseitig,
 * nicht dem Renderer geglaubt: der Pfad muss unter der aktuellen Wurzel liegen
 * und darf nicht ausgeschlossen sein. Die Wurzel selbst darf auch geoeffnet
 * werden (Klick auf die Wurzelzeile), deshalb der Gleichheitsfall zusaetzlich
 * zum `startsWith`.
 */
async function ordnerOeffnen(pfad: string): Promise<void> {
  const wurzel = ordnerWurzel();
  if (!pfad.startsWith(wurzel + '/') && pfad !== wurzel) {
    throw new Error(`Pfad liegt nicht unter der aktuellen Wurzel: ${pfad}`);
  }
  if (isExcluded(pfad, config.excludeGlobs)) {
    throw new Error('Pfad ist ausgeschlossen');
  }
  await shell.openPath(pfad);
}

/** Zuletzt gezeigte Aktivitaet, um 'aktivitaet-oeffnen' dagegen zu pruefen. */
let letzteAktivitaet: AktivitaetEintrag[] = [];

function aktivitaetLesen(): AktivitaetEintrag[] {
  const sichtbareSessions = sichtbare(sessions).map((s) => ({
    id: s.id,
    name: s.name,
    dir: s.dir,
    workers: s.workers.map((w) => ({ name: w.name, dir: w.dir })),
  }));
  letzteAktivitaet = leseAktivitaet(config.resultsDir, sichtbareSessions, config.excludeGlobs);
  return letzteAktivitaet;
}

/**
 * Der Eintrag, den `pfad` in der zuletzt gelesenen Aktivitaet meint -- oder
 * ein Fehler. EINE Stelle fuer diese Pruefung, statt sie in jeder der drei
 * Aktionen (oeffnen, Diff, Auftrag) einzeln zu wiederholen.
 */
function letzterAktivitaetEintrag(pfad: string): AktivitaetEintrag {
  const e = letzteAktivitaet.find((x) => x.pfad === pfad);
  if (!e) throw new Error(`Pfad steht nicht in der zuletzt gelesenen Aktivitaet: ${pfad}`);
  return e;
}

/**
 * V15/V18 (Schritt 9): der ERSTE Klick auf einen Eintrag -- der Inhalt "in
 * der Mitte" (im eingebauten Editor), nicht mehr extern (`shell.openPath`,
 * bis zum 05.08.). Geprueft wird derselbe Weg wie vorher: der Pfad muss aus
 * der zuletzt gelesenen Aktivitaet stammen, der Renderer bestimmt nicht,
 * was gelesen wird.
 */
function aktivitaetOeffnen(pfad: string): { typ: string; wer: string; content: string } {
  const e = letzterAktivitaetEintrag(pfad);
  return { typ: e.typ, wer: e.wer, content: leseInhalt(pfad) };
}

/** Der ZWEITE Klick auf einen 'aenderung'-Eintrag: die zwei Fassungen fuer Monacos Diff-Editor. */
function aktivitaetDiffLesen(pfad: string): { original: string; modified: string } {
  const e = letzterAktivitaetEintrag(pfad);
  const diff = leseDiffFuerEintrag(e);
  if (!diff) throw new Error(`kein Diff fuer diesen Eintrag (Typ '${e.typ}'): ${pfad}`);
  return diff;
}

/** Der ZWEITE Klick auf einen 'ergebnis'-Eintrag: Auftrag und Ergebnis nebeneinander (V18). */
function aktivitaetAuftragLesen(pfad: string): { auftrag: string; ergebnis: string } {
  const e = letzterAktivitaetEintrag(pfad);
  if (e.typ !== 'ergebnis') throw new Error(`kein Ergebnis-Eintrag: ${pfad}`);
  return leseAuftragFuerErgebnis(pfad);
}

/** Inhaltssuche unter der aktuellen (oder angegebenen) Ordnerwurzel. */
function sucheLesen(query: string, pfad: string): { root: string; query: string; treffer: Treffer[] | null } {
  const root = pfad || ordnerWurzel();
  const treffer = sucheInhalt(root, query, config.excludeGlobs);
  // Doppelt genaeht: selbst wenn eine rg-Glob-Uebersetzung eine Luecke haette,
  // faellt ein ausgeschlossener Treffer hier noch heraus, bevor er den
  // Renderer erreicht.
  const gefiltert = treffer?.filter((t) => !isExcluded(t.pfad, config.excludeGlobs)) ?? treffer;
  // Die Anfrage kommt mit zurueck: bei schnellem Tippen koennen Antworten in
  // anderer Reihenfolge ankommen, als sie losgeschickt wurden -- der Renderer
  // verwirft eine Antwort, die nicht mehr zur aktuellen Eingabe passt.
  return { root, query, treffer: gefiltert };
}

/**
 * V2: Die Ergebnisdatei meldet sich, sobald sie entsteht. Beobachtet werden die
 * Worker, die diese Session KENNT -- nicht der Ergebnisordner als Ganzes: dort
 * liegen auch die Ergebnisse frueherer Worker gleichen Namens, und genau die
 * darf niemand fuer neu halten (siehe results.ts).
 *
 * A14: keine Dauerflaeche im Fenster. Was hier hinausgeht, ist eine Meldung,
 * die von selbst wieder verschwindet; gelesen wird im Worker-Tab oder in der
 * Datei.
 */
const waechterErgebnisse = new ErgebnisWaechter({ resultsDir: config.resultsDir, startedAt: Date.now() });
/** Die letzten Meldungen, damit der Steuerkanal sie belegen kann. */
const gemeldeteErgebnisse: Ergebnis[] = [];

// Benachrichtigungen (SPEC-V4 3.5): die Entprellung je Ereignistyp lebt hier,
// solange dieser Prozess laeuft -- 'freigabeWartet' und 'sitzungTot' sind
// STEHENDE Mengen (ein Antrag bleibt offen, bis er entschieden ist), die ohne
// eigene Entprellung jeden Takt erneut melden wuerden. 'workerFertig' braucht
// keine eigene: ErgebnisWaechter oben meldet je Auftrag ohnehin nur einmal.
const meldungFreigabe = new NeuheitsFilter();
const meldungSitzungTot = new NeuheitsFilter();
const meldungLimit = new SchwellenMelder();

/**
 * Benachrichtigung 'limitFastVoll': BudgetPoller haelt nur den letzten Stand
 * vor (eigener, langsamer Takt, siehe budget.ts) -- hier wird er nur gegen
 * `meldungen.limitSchwelle` geprueft, nicht neu berechnet. SchwellenMelder
 * sorgt fuer den Uebergang statt fuer jeden Takt ueber der Schwelle.
 */
function budgetMeldungPruefen(): void {
  const stand = budgetPoller.aktuell();
  if (!stand) return;
  const einstellungen = meldungsEinstellungen(config.settingsFile);
  const prozent = budgetProzent(stand);
  if (meldungLimit.ueberschritten(prozent, einstellungen.limitSchwelle)) {
    melden('limitFastVoll', `Das Anthropic-Limit ist zu ${Math.round(prozent)} Prozent ausgeschoepft.`, einstellungen, STANDARD_WEGE);
  }
}

function ergebnissePruefen(): Ergebnis[] {
  const namen = sessions.flatMap((s) => s.workers.map((w) => w.name));
  const neu = waechterErgebnisse.durchgang(namen);
  for (const e of neu) {
    gemeldeteErgebnisse.push(e);
    anOberflaeche('awb:ergebnis', e);
    melden('workerFertig', `Worker '${e.name}' ist fertig.`, meldungsEinstellungen(config.settingsFile), STANDARD_WEGE);
  }
  if (gemeldeteErgebnisse.length > 50) gemeldeteErgebnisse.splice(0, gemeldeteErgebnisse.length - 50);
  return neu;
}

function sichtbare(alle: SessionInfo[]): SessionInfo[] {
  const z = ui.get();
  // A12: standardmaessig nur laufende Sessions. Eine unerreichbare Maschine
  // verliert ihre Sessions NICHT -- das ist der Kern von F6.
  //
  // UND EINE VERLORENE AUCH NICHT (11.08.). In der Nacht zum 11.08. riss eine
  // Kernel-Panik den Rechner weg; danach standen vier hiesige Sitzungen als
  // 'stopped' in der Liste und fielen genau hier heraus, sodass in der linken
  // Spalte nur noch die eine Sitzung stand, deren tmux auf der anderen
  // Maschine weiterlief. Mit ihnen ging der Fortsetzen-Knopf, der an dieser
  // Liste haengt. `verloren` unterscheidet die beiden Faelle, die A12 bis
  // dahin gleich behandelt hat: geschlossen (zugesehen, soll weg) und
  // weggebrochen (niemand hat das Ende gesehen, gehoert gezeigt). Die
  // Herleitung steht in lebensspur.ts.
  //
  // UND EIN START AUCH NICHT (21.08.). Zwei weitere Faelle, die 'stopped'
  // heissen und trotzdem nichts mit „erledigt" zu tun haben: eine Sitzung, die
  // GERADE STARTET (die Zustandsdatei ist da, die tmux-Sitzung noch nicht --
  // bei einem lokalen Modell dauert das Minuten), und eine, deren Start
  // GESCHEITERT ist. Der zweite Fall ist der, an dem des Nutzers 256k-Sitzung
  // unsichtbar wurde: `showStopped` steht in seiner ui.json auf false, und
  // `verloren` griff nicht, weil die Sitzung nie lief. Uebrig blieb ein
  // Fehlschlag, den niemand sehen konnte.
  const gefiltert = z.showStopped
    ? alle
    : alle.filter((s) => s.state !== 'stopped' || s.verloren || s.startet || s.startFehler);
  return sortSessions(gefiltert, z.sort, z.order);
}

function gewaehlte(): SessionInfo | null {
  const z = ui.get();
  const liste = sichtbare(sessions);
  return liste.find((s) => s.id === z.selected) ?? liste[0] ?? null;
}

/**
 * Wieviele FREMDE Clients gerade an der gezeichneten Session haengen.
 *
 * Daran haengt seit dem 06.08. die Frage aus F14: umgeraeumt wird eine
 * uebernommene Session NUR, solange niemand sonst an ihr haengt. Die Zahl wird
 * im Takt nachgelesen und vor jedem Umraeumen noch einmal -- ein Client, der
 * sich vor zwei Sekunden angehaengt hat, darf nicht uebergangen werden.
 */
let fremdeClients = 0;
async function clientsNachlesen(): Promise<void> {
  if (!tmux) {
    fremdeClients = 0;
    return;
  }
  fremdeClients = await tmux.fremdeClients().catch(() => fremdeClients);
}

/**
 * Darf an dieser Session die Aufteilung angefasst werden?
 *
 * Eigene Session: immer. Uebernommene Session: nur, solange kein anderer
 * Client an ihr haengt. Bis zum 05.08. war die Antwort schlicht "nur eigene",
 * weil die VSCode-Erweiterung dieselben Fenster umbaute; die ist zu, und
 * damit ist der Grund weggefallen -- nicht aber die Vorsicht. Ein Mensch, der
 * dieselbe Session in einem Terminal offen hat, soll seine Fenster nicht unter
 * den Haenden springen sehen.
 */
function darfUmraeumen(): boolean {
  if (attachState?.sizePolicy === 'owned') return true;
  return fremdeClients === 0;
}

/**
 * Die Maus-Verfolgung der gezeichneten Panes nachfuehren.
 *
 * Die Anwendung im Pane schaltet sie waehrend ihrer Laufzeit um. Was ueber den
 * Strom laeuft, sieht das Terminal im Fenster selbst; was VOR dem Zeichnen
 * geschah, steht nur bei tmux. Deshalb wird sie im Takt nachgelesen und nur
 * geschickt, wenn sich etwas geaendert hat.
 */
let mausStand: Record<string, { an: boolean; sgr: boolean }> = {};
async function mausNachfuehren(): Promise<void> {
  if (!tmux || !gezeichneteLage.length) return;
  const neu: Record<string, { an: boolean; sgr: boolean }> = {};
  for (const p of gezeichneteLage) {
    neu[p.paneId] = await tmux.mausFlags(p.paneId).catch(() => mausStand[p.paneId] ?? { an: false, sgr: true });
  }
  if (JSON.stringify(neu) === JSON.stringify(mausStand)) return;
  mausStand = neu;
  anOberflaeche('awb:maus', neu);
}

/**
 * Fenster und Panes der ANGEHAENGTEN Session, nachgelesen im selben Takt wie
 * alles andere.
 *
 * BEFUND VOM 06.08. Diese Liste entstand bis dahin genau zweimal: beim
 * Anhaengen und beim Waehlen einer Session (`attachTmux`). Ein Worker-Pane, der
 * nach dem Start entsteht, stand deshalb nirgends, bis jemand die Session neu
 * waehlte. An der laufenden Instanz gemessen: `state` fuehrte noch den toten
 * Platzhalter-Pane, waehrend tmux laengst zwei weitere hatte; nach `awb-ctl
 * select` waren sie da. Nachgelesen wird also, was sich aendern kann, statt es
 * einmal zu glauben.
 *
 * DER FINGERABDRUCK TRAEGT BEWUSST KEINE GROESSEN -- nur Fenster, Panes, ihre
 * Zuordnung und wer aktiv ist. Die Groessen wandern zwar in den Zustand (die
 * Auskunft soll stimmen), loesen aber nichts aus: sie sind der Weg in den
 * Kreis, der am 05.08. als Dauerflackern gemessen wurde. Wer sie beantwortet,
 * stellt den Pane, und die neue Groesse waere schon die naechste Aenderung.
 * Fuer Groessen gibt es `lageAbgleichen` mit seinen drei Riegeln und seiner
 * Abklingzeit; hier geht es um die Frage, WELCHE Panes es ueberhaupt gibt.
 *
 * UND ES WIRD NICHTS GESCHICKT, WAS NIEMAND BRAUCHT. Der Renderer liest aus
 * 'awb:session' nur Sessionname, aktiven Pane und Groessenregel -- die
 * Pane-Liste der Oberflaeche kommt aus dem Sessionmodell (`readSessions` liest
 * `tmux list-panes -a` in jedem Takt selbst), und die geht ohnehin gleich
 * darauf hinaus. Eine 'awb:session'-Meldung setzt im Renderer die gemeldete
 * Flaeche zurueck; er misst dann neu, der Pane wird gestellt und dabei GEZOOMT,
 * und ein Zoom macht den Pane in tmux aktiv -- an einer Session, an der ein
 * Mensch mithaengt, spraenge ihm bei jedem neuen Worker die Ansicht um. Also
 * wird der Zustand aufgefrischt und sonst nichts angefasst; das eine, was
 * wirklich nachgezogen werden muss, steht darunter.
 */
function paneFingerabdruck(windows: WindowInfo[], panes: PaneInfo[]): string {
  return [
    windows.map((w) => `${w.windowId}:${w.name}:${w.active ? 1 : 0}`).join(','),
    panes.map((p) => `${p.paneId}@${p.windowId}:${p.active ? 1 : 0}`).join(','),
  ].join(' | ');
}

async function panesNachlesen(): Promise<void> {
  if (!tmux || !attachState) return;
  const windows = await tmux.listWindows().catch(() => null);
  const panes = await tmux.listPanes().catch(() => null);
  // Eine leere Antwort heisst hier NICHT "keine Panes mehr": sie kommt auch,
  // wenn der Steuerclient gerade abgeloest wird. Der alte Stand ist dann die
  // ehrlichere Auskunft als eine leere Liste.
  if (!windows || !panes || panes.length === 0) return;
  const vorher = paneFingerabdruck(attachState.windows, attachState.panes);
  attachState = { ...attachState, windows, panes };
  // DER ZWEITE ANLASS FUER DEN GROESSENABGLEICH (08.09.2026, Auftrag
  // geometrie). Bis heute lief `lageAbgleichen` NUR auf `%layout-change` --
  // und es gibt Aenderungen der Panegroesse, die tmux nicht meldet. GEMESSEN
  // auf tmux 3.7c mit einem Steuerclient am Fenster: ein
  // `set-option -g -w pane-border-status off` macht aus einem Pane von 51
  // Zeilen einen von 52, und ueber den Steuerkanal kam kein `%layout-change`,
  // sondern nur das `%output` der Anwendung, die sich neu zeichnete. Die Buehne
  // stand danach dauerhaft eine Zeile neben ihrem Pane, bis irgendetwas anderes
  // eine Neuzeichnung ausloeste.
  //
  // Die Groessen loesen deshalb weiterhin NICHTS unmittelbar aus -- der
  // Fingerabdruck darueber traegt sie bewusst nicht, und das bleibt so. Sie
  // stellen nur die eine Frage an `lageAbgleichen`, die dieses schon immer
  // beantwortet, mit seinen drei Riegeln und seiner Abklingzeit: hat sich
  // gegenueber dem, was zuletzt GEZEICHNET wurde, wirklich etwas geaendert?
  // Damit ist es derselbe Weg wie beim gemeldeten Layoutwechsel, nur mit einem
  // zweiten Anlass -- und er kostet nichts, weil die Liste hier ohnehin schon
  // gelesen ist.
  const groessenAnders = gezeichneteLage.some((p) => {
    const jetzt = panes.find((q) => q.paneId === p.paneId);
    return !!jetzt && (jetzt.width !== p.cols || jetzt.height !== p.rows);
  });
  if (groessenAnders) lageSpaeter(ABKLINGZEIT_MS);
  if (paneFingerabdruck(windows, panes) === vorher) return;
  process.stderr.write(`Panes nachgelesen: ${panes.map((p) => p.paneId).join(' ')}\n`);
  // Das eine, was wirklich nachgezogen wird: ist der GEZEICHNETE Pane weg,
  // steht im Fenster ein totes Terminal. Dann wird auf den aktiven gewechselt
  // -- ohne Zoom, denn hier hat kein Mensch eine Ansicht gewaehlt.
  if (streamPane && !panes.some((p) => p.paneId === streamPane) && ansicht.art === 'pane') {
    const ersatz = panes.find((p) => p.active) ?? panes[0];
    await paneZeigen(ersatz.paneId, false).catch((e) =>
      process.stderr.write(`Ersatz-Pane nicht gezeichnet: ${(e as Error).message}\n`));
  }
}

/**
 * Drei Einstellungen, die das Menue mit „sofort" anbietet und die bis zum
 * 06.08. aus der EINMAL geladenen `config` kamen: die Schwelle fuer „haengt",
 * die Zahl der Panes je Tab und die Maschinenliste. Wer sie umstellte, sah
 * nichts, bis er das Programm neu startete -- und suchte den Fehler bei der
 * Aufsicht statt bei der Einstellung.
 *
 * Gelesen wird jetzt an der Verbrauchsstelle, im Takt. Teuer ist das nicht:
 * `alleEinstellungen` liest die Datei nur nach, wenn Zeitstempel oder Groesse
 * sich geaendert haben, sonst kostet es ein `stat`.
 *
 * Eine Vorgabe des Aufrufers (Umgebungsvariable) gewinnt weiterhin -- die
 * Suiten setzen sie, und eine Einstellungsdatei darf ihnen nicht dazwischen
 * kommen.
 */
function stallSekundenJetzt(): number {
  if (process.env.AWB_STALL_SECONDS) return config.stallSeconds;
  return zahlAus('stallMinutes', 1, 120, config.settingsFile) * 60;
}

function maxProTabJetzt(): number {
  if (process.env.AWB_MAX_WORKERS_PER_TAB) return config.maxWorkersPerTab;
  return zahlAus('maxWorkerPanesPerTab', 0, 64, config.settingsFile);
}

/**
 * Die Mindestbreite eines Worker-Panes, JETZT gelesen -- aus demselben Grund
 * wie die beiden Zahlen darueber: sie steht seit dem 06.08. im Menue, und eine
 * Einstellung, die erst beim naechsten Start greift, ohne dass es irgendwo
 * steht, ist eine, der man nicht glaubt. Die Umgebungsvariable schlaegt sie
 * weiterhin: Suiten setzen sie, und eine Einstellungsdatei darf ihnen nicht
 * dazwischenkommen.
 */
function minBreiteJetzt(): number {
  if (process.env.AWB_MIN_PANE_COLS) return config.minPaneCols;
  return zahlAus('minWorkerPaneWidth', 20, 1000, config.settingsFile);
}

/**
 * DIE GEMESSENE UNTERGRENZE, unter der zwei Spalten wirklich unlesbar werden:
 * 65 Zeichen (Report `20260804-033646.md`, Messung 4).
 *
 * Dort wurde mit einer echten `claude`-CLI und dem echten Repo-Pfad (32
 * Zeichen) ueber die Pane-Groessen gemessen, die das Kacheln wirklich erzeugt.
 * 65x17 ist der schmalste Fall, in dem die Statuszeile noch etwas zeigt (den
 * Balken in Zehnerschritten); alles Schmalere wurde nur mit KURZEM Pfad
 * gemessen und ist mit einem echten Pfad ungeprueft. 65 ist also nicht die
 * theoretische Grenze (die liegt bei 52), sondern die kleinste Zahl, fuer die
 * ein Beleg existiert -- und genau das soll eine Untergrenze sein.
 */
const ZWEISPALTEN_BODEN = 65;

/**
 * MIT WELCHER MINDESTBREITE GERECHNET WIRD (05.09.2026, Electron-Befund 7).
 *
 * Im Normalfall mit `minWorkerPaneWidth` (Vorgabe 80) -- das ist die Zusage an
 * den Menschen, und sie bleibt.
 *
 * SOLANGE ABER EIN BLATT DES INSPEKTORS OFFEN STEHT, gilt der gemessene Boden.
 * Ein Blatt nimmt der Buehne rund 360 Bildpunkte; bei 1604 Bildpunkten
 * Fensterbreite fiel sie damit von 175 auf 132 Spalten, `floor(132/80)` ergab
 * EINE Spalte statt zweier, und aus vier Workern in einem 2x2 wurden drei in
 * einer Spalte plus ein zweiter Tab. Beim Zuklappen sprang alles zurueck. Ein
 * Nachschlagen, das die Arbeitsflaeche umbaut, ist kein Nachschlagen.
 *
 * Der Boden gilt NUR fuer diesen einen Fall und NUR nach unten: liegt
 * `minWorkerPaneWidth` schon darunter, bleibt der kleinere Wert stehen.
 */
function mindestbreiteFuerRechnung(): number {
  const gesetzt = minBreiteJetzt();
  return blattOffen ? Math.min(gesetzt, ZWEISPALTEN_BODEN) : gesetzt;
}

/**
 * Sitzen die Worker in EIGENEN tmux-Fenstern (`workerLayout: window`, seit dem
 * 03.09.2026 eines je Worker) oder als Panes unter dem Orchestrator (`split`)?
 *
 * Gebraucht wird die Antwort nur fuer die FORM, die die rechte Leiste als
 * Kachelung ankuendigt: bei eigenen Fenstern hat tmux nichts anzuordnen und die
 * Buehne kachelt frei (`gitterFrei`), sonst gilt das Raster, das tmux baut
 * (`gitterFuer`). Die Buehne selbst entscheidet das nicht hier, sondern an den
 * wirklich gezeigten Panes (`tabZeigen`) -- ein Schildchen, das etwas anderes
 * ankuendigt als die Buehne dann legt, waere aber genau die Art Widerspruch,
 * gegen die dieser Abschnitt steht.
 */
function eigeneFensterJeWorker(): boolean {
  const roh = alleEinstellungen(config.settingsFile).workerLayout;
  return typeof roh === 'string' && roh === 'window';
}

/**
 * Kapazitaet und Tabs der gewaehlten Session, abgeleitet aus der Flaeche.
 *
 * WELCHE Flaeche, das war bis zum 07.08. die falsche: gerechnet wurde mit
 * `attachState.cols`, also der Groesse des tmux-CLIENTS. Bei einer eigenen
 * Session faellt das nicht auf, weil das Programm dem Client die Groesse der
 * Buehne gibt und beide Zahlen dieselbe sind. Bei einer UEBERNOMMENEN Session
 * darf es das nicht (`sizePolicy: 'adopted'`, `sizeIgnored`), und dann laufen
 * sie auseinander — gemessen an Gardener-Sitzung des Nutzers: Client 128 Spalten,
 * Buehne 162. Aus 128 folgt `perRow = 1` (128/80), aus 162 folgt `perRow = 2`.
 * Vier Worker lagen deshalb auf ZWEI Tabs uebereinander (1x3 + 1x1), obwohl sie
 * in tmux in EINEM Fenster als 2x2 liegen und auch auf die Buehne gepasst
 * haetten.
 *
 * Die Form kippte damit gleich mit: die Buehne bildet die Aufteilung von tmux
 * nur ab, wenn sie ALLE Panes des Fensters zeigt (siehe `raster` weiter unten).
 * Drei von vier sind nicht alle, also fiel sie auf ihre eigenen Kacheln zurueck.
 * Eine Ursache, zwei sichtbare Folgen.
 *
 * Gerechnet wird jetzt mit der Flaeche, die der Renderer zuletzt gemeldet hat —
 * derselbe Ausdruck, aus dem zehn Zeilen weiter unten die Kachelgroesse folgt.
 * `attachState` bleibt als Rueckfall dahinter, damit ein Aufruf VOR der ersten
 * Meldung des Renderers (kopfloser Start, Tests) dieselbe Zahl bekommt wie
 * bisher.
 */
function kapazitaet(): {
  perRow: number; perColumn: number; perTab: number; cappedBySetting: boolean; tabs: number; workerCount: number;
  spalten: number; zeilen: number;
} {
  const cols = flaeche?.cols ?? attachState?.cols ?? config.ownedCols;
  const rows = flaeche?.rows ?? attachState?.rows ?? config.ownedRows;
  const k = capacity({
    cols, rows, minCols: mindestbreiteFuerRechnung(), minRows: config.minPaneRows, maxPerTab: maxProTabJetzt(),
  });
  const s = gewaehlte();
  // Subagenten sind hier bewusst nicht dabei (V19).
  //
  // Und `alive` ist hier RICHTIG, obwohl es seit dem 07.08. an anderen Stellen
  // durch den Zustand ersetzt ist: gerechnet wird, wieviele PANES nebeneinander
  // gekachelt werden muessen, und ein Worker im Zustand 'unknown' hat keinen,
  // den man kacheln koennte. Er zaehlt hier also nicht mit -- er bekaeme sonst
  // eine leere Kachel, und bei ausgefallenem tmux waere das gleich ein ganzes
  // Gitter aus leeren Kacheln. Dass es ihn gibt, sagt die rechte Leiste.
  const workerCount = s ? s.workers.filter((w) => w.alive).length : 0;
  // `perRow`/`perColumn` sind die rohe FLAECHENKAPAZITAET (wieviele Panes bei
  // dieser Mindestbreite ueberhaupt noch reinpassen wuerden) -- nicht die Form,
  // in der ein voller Tab tatsaechlich gekachelt wird. Die Leiste zeigte bisher
  // `perRow x perColumn` als sei es diese Form; fuer sechs Panes bei perRow=2/
  // perColumn=4 stand dort "(2x4)", waehrend `gitterFuer` (dieselbe Funktion,
  // die `tabZeigen` fuers echte Kacheln benutzt) fuer sechs Panes 2x3 anwendet.
  // `spalten`/`zeilen` ist deshalb das GITTER fuer einen VOLLEN Tab (perTab
  // Panes) -- dieselbe Rechnung, die die Buehne auch fuer die Aufteilung
  // heranzieht, kein zweiter, eigens fuer die Leiste erfundener Wert.
  const gitter = eigeneFensterJeWorker()
    ? gitterFrei(k.perTab, k.perRow, k.perColumn)
    : gitterFuer(k.perTab, k.perRow, k.perColumn);
  return { ...k, tabs: tabsFor(workerCount, k.perTab), workerCount, spalten: gitter.spalten, zeilen: gitter.zeilen };
}

/**
 * Bei einer toten Session steht die Vorschau dabei: WELCHER Harness zurueckkommt
 * und ob seine Unterhaltung mitkommt. Dieselbe Funktion, die den Aufruf baut,
 * faellt auch dieses Urteil -- eine zweite Regel in der Oberflaeche waere die
 * Stelle, an der beide auseinanderlaufen. Bis zum 06.08. stand genau so eine
 * zweite Regel im Renderer, und sie kannte nur claude.
 *
 * `reviveCommand` startet nichts; gerechnet wird nur fuer tote Sessions.
 */
function mitReviveVorschau(liste: SessionInfo[]): unknown[] {
  return liste.map((s) => {
    if (s.state !== 'stopped') return s;
    const v = reviveCommand(s, config.machine, config.wbCodeBin, harnessResume(s.harness), false, reviveKennung(s));
    return { ...s, revive: { conversation: v.conversation, reason: fortsetzenGrund(s, v) } };
  });
}

/**
 * Der Satz, der VOR dem Fortsetzen dabeisteht: was mit der Unterhaltung
 * geschieht, und -- wenn sie wirklich mitkommt -- ob sie gross und alt genug
 * ist, dass die CLI zuerst zurueckfragt (11.08., Grenzen und Herleitung in
 * revive.ts). Gemessen wird nur dann; fuer eine Sitzung, die ohnehin neu
 * anfaengt, gibt es kein Transcript zu befragen.
 *
 * EINE Fassung fuer BEIDE Listen (11.08.). Die Warnung stand bis heute nur an
 * der linken Leiste, und das war gerade herum verkehrt: das Sitzungsfenster ist
 * die Stelle, an der nach einem Absturz fortgesetzt wird, und dort fehlte der
 * Hinweis, dass der Pane gleich an einer Rueckfrage stehen bleibt. Zwei
 * Fassungen desselben Satzes waeren ohnehin die Stelle gewesen, an der beide
 * auseinanderlaufen.
 */
function fortsetzenGrund(s: SessionInfo, v: ReviveCommand): string {
  if (v.conversation !== 'resumed' || !s.claudeSessionId) return v.conversationReason;
  const t = transcriptStand(
    transcriptPfad(config.projectsDir, s.dir, s.claudeSessionId),
    s.model,
    config.modelsFile,
  );
  const alterMinuten = t.mtimeMs > 0 ? (Date.now() - t.mtimeMs) / 60_000 : -1;
  const hinweis = fortsetzenHinweis(alterMinuten, t.tokens);
  return hinweis ? `${v.conversationReason}\n\n${hinweis}` : v.conversationReason;
}

/**
 * DIE MASCHINEN, DIE DIESES PROGRAMM KENNT (03.09.2026, fuer die neue
 * Statusleiste).
 *
 * Warum es das Feld gibt: die Erreichbarkeit einer Maschine liess sich bisher
 * nur aus den Sitzungen ableiten, die zufaellig auf ihr liefen -- eine Maschine
 * ohne Sitzung gab gar keine Auskunft, und „keine Sitzung" sah aus wie „nicht
 * da". Gelesen wird ausschliesslich, was ohnehin schon gemessen ist: die
 * Hostliste aus den Einstellungen (config.ts) und die Momentaufnahmen des
 * Abrufs (remote.ts). Hier entsteht KEINE neue Messung und keine Zahl, die es
 * nicht gibt -- die Auslastung einer Maschine etwa liefert der Abruf nicht, und
 * sie steht deshalb auch nicht hier.
 *
 * Kein bestehendes Feld wird angefasst; `maschinen` kommt neben `machine`
 * (die eigene) und `ampel` (der Pruefstand je Maschine) dazu.
 */
function maschinenStand(sichtbar: SessionInfo[]): {
  name: string; eigen: boolean; erreichbar: boolean | null;
  alter: number; fehler: string; sitzungen: number; worker: number; pausiert: boolean;
}[] {
  const jetzt = Date.now();
  const schnappschuesse = new Map(remotePoller.snapshots().map((x) => [x.machine, x]));
  // EINE PAUSIERTE MASCHINE BLEIBT SICHTBAR (05.09.2026). Sie faellt aus der
  // Hostliste des Abrufs -- das ist ihre ganze Wirkung --, und damit waere sie
  // aus der Statusleiste verschwunden. Verschwinden hiesse aber, dass der
  // Schalter zum Wiedereinschalten dort nicht mehr steht, wo er gerade
  // umgelegt wurde. Sie kommt deshalb aus der EINGETRAGENEN Liste zurueck,
  // gedaempft und mit ihrem eigenen Wort. Ein Name, der nur noch in der
  // Pausenliste steht und nicht mehr in `remoteMachines`, kommt nicht wieder:
  // er ist keine eingetragene Maschine mehr.
  const eingetragen = maschinenliste(config.settingsFile);
  const pausiert = maschinenPausiert(config.settingsFile).filter((n) => eingetragen.includes(n));
  // DIE REIHENFOLGE DER EINGETRAGENEN LISTE BLEIBT. Sonst spraenge eine
  // Maschine ans Ende der Leiste, sobald man sie pausiert -- der Schalter
  // waere dann nicht mehr da, wo er eben noch war. Ein Name, den nur der
  // Abruf kennt (Testlauf mit AWB_REMOTE_MACHINES), haengt hinten an.
  const fern = [...remotePoller.hostliste(), ...pausiert];
  const namen = [
    config.machine,
    ...eingetragen.filter((n) => fern.includes(n)),
    ...fern.filter((n) => !eingetragen.includes(n)),
  ].filter((n, i, alle) => n && alle.indexOf(n) === i);
  return namen.map((name) => {
    const eigen = name === config.machine;
    const snap = schnappschuesse.get(name);
    const drauf = sichtbar.filter((x) => x.machine === name);
    return {
      name,
      eigen,
      pausiert: pausiert.includes(name),
      // Die eigene Maschine wird nie abgefragt -- sie ist erreichbar, sonst
      // liefe dieses Programm nicht. Eine fremde ohne Momentaufnahme ist NICHT
      // unerreichbar, sondern noch nicht nachgesehen: dafuer steht null.
      erreichbar: eigen ? true : (snap ? snap.reachable : null),
      alter: eigen ? 0 : (snap?.fetchedAt ? Math.max(0, Math.round((jetzt - snap.fetchedAt) / 1000)) : -1),
      fehler: eigen ? '' : (snap?.error || snap?.formatFehler || ''),
      sitzungen: drauf.length,
      worker: drauf.reduce((n, x) => n + x.workers.filter((w) => w.state === 'running').length, 0),
    };
  });
}

function modellSenden(): void {
  const z = ui.get();
  const s = gewaehlte();
  // EINMAL gefiltert und sortiert, danach zweimal benutzt: als `sessions` und
  // als Teil der gemeinsamen Reihenfolge `leiste` (Punkt 4). Zweimal
  // `sichtbare()` zu rufen hiesse, zwei Listen zu haben, die nur zufaellig
  // dieselbe sind.
  const sichtbar = sichtbare(sessions);
  anOberflaeche('awb:model', {
    sessions: mitReviveVorschau(sichtbar),
    all: sessions.length,
    ui: z,
    selected: s?.id ?? '',
    machine: config.machine,
    capacity: kapazitaet(),
    maschinen: maschinenStand(sichtbar),
    // Die Schriftgroesse der Terminals gehoert dem Menschen und steht in der
    // geteilten Einstellungsdatei. Gelesen wird sie HIER und nicht beim Start:
    // `alleEinstellungen` liest die Datei nur nach, wenn sie sich geaendert
    // hat, und damit wirkt eine neue Groesse im naechsten Takt statt erst nach
    // einem Neustart.
    schriftgroesse: zahlAus('terminalFontSize', 8, 32, config.settingsFile),
    // Dieselbe Bauart und derselbe Grund: die Zahl gehoert dem Menschen, wird
    // im Takt nachgelesen und wirkt sofort.
    scrollZeilen: zahlAus('terminalScrollLines', 1, 20, config.settingsFile),
    // `agentsBlattVorschau` stand hier bis zum 14.09.2026: der Schalter fuer das
    // Aufgaben-Blatt aus Fassung 26. Seit der Tab „Agents" die Welten zeigt
    // (Auftrag agentsui Nr. 6), gibt es nichts mehr freizuschalten; die
    // Einstellung wird nicht mehr gelesen.
    ampel: ampelStandJetzt(),
    budget: budgetPoller.aktuell(),
    // Die Chat-Sitzungen (12.08.) -- eigene Liste NEBEN `sessions`, nicht
    // hineingemischt: eine Chat-Sitzung hat keinen Pane, keinen Worker und
    // keinen tmux-Zustand, und jede Verzweigung, die `Session` verarbeitet,
    // muesste sonst nachfragen, welche Sorte gerade vorliegt.
    chats: chatRegistry.alle().map((c) => ({
      id: c.id,
      name: c.name,
      ordner: c.ordner,
      zuletzt: c.zuletzt,
      // GEMESSEN, nicht gemerkt: laeuft der Prozess dieser Sitzung gerade?
      laeuft: chatbuehne.laufende().includes(c.id),
      // IHRE WERKSTATT und WAS DARIN STEHT (Punkt 1). Gemessen wird an tmux,
      // aber NUR fuer die Sitzung, die gerade gezeigt wird (Reviewbefund 3):
      // ihre Leiste ist die einzige Stelle, die die Liste zeichnet, und jeder
      // Aufruf ist ein `spawnSync`. Die uebrigen bekommen ihren zuletzt
      // gelesenen Stand (chatbuehne.ts, `workerVon`).
      tmuxSession: chatbuehne.werkstattVon(c.id),
      worker: chatbuehne.workerVon(c.id, c.id === chatbuehne.gezeigter()),
    })),
    /**
     * DIE REIHENFOLGE DER LEISTE -- EINE Liste fuer beide Sorten (Punkt 4,
     * alice am 12.08.: „die session soll links nicht anders behandelt
     * werden als die terminal sessions, das sortieren sollte nicht
     * ansichtsabhaengig sein").
     *
     * Bis heute standen die Chat-Sitzungen in einem eigenen Abschnitt unter den
     * Terminal-Sitzungen, mit einer eigenen Sortierung (`ausJson` sortiert nach
     * `zuletzt`) -- zwei Listen, zwei Regeln, und die Stelle einer Sitzung hing
     * davon ab, welche Sorte sie ist.
     *
     * Sortiert wird jetzt EINMAL, mit `sortSessions` -- derselben Funktion,
     * derselben Voreinstellung (`recent`/`folder`/`name`) und derselben
     * Handreihenfolge, die die Terminal-Sitzungen schon hatten. Die Chat-Sitzung
     * kommt dafuer auf die Felder, die diese Funktion liest; ihr Ordner ist ihr
     * `dir`, ihr `zuletzt` ihr `lastActive`. Was hier herauskommt, ist reine
     * Reihenfolge: WIE eine Zeile aussieht, entscheidet der Renderer an ihrer
     * Sorte, und nur daran.
     */
    leiste: sortProjekte(
      sortSessions(
        [
          ...sichtbar.map((s) => ({
            // `state` reist mit, damit „zuletzt aktiv" Lebendes vor Totes stellt
            // (Kleinigkeit 2, siehe `sortSessions`).
            id: s.id, name: s.name, dir: s.dir, lastActive: s.lastActive, state: s.state, art: 'terminal' as const,
          })),
          ...chatRegistry.alle().map((c) => ({
            id: c.id, name: c.name, dir: c.ordner, lastActive: c.zuletzt, art: 'chat' as const,
          })),
        ],
        z.sort,
        z.order,
      ),
      // DIE PROJEKTE ZULETZT (08.09.2026): erst die Zeilen sortieren, dann die
      // Bloecke stellen. Beides in einem Zug ginge nicht -- `sortSessions`
      // ordnet Zeilen, und ein Projekt hat gar keine eigene Zeile, an der man
      // sortieren koennte. Ohne Handreihenfolge bleibt die Liste, wie sie war.
      z.projektReihenfolge,
    ).map((e) => ({ art: e.art, id: e.id })),
    // WELCHE Chat-Sitzung gerade auf der Buehne liegt (13.08.) -- leer heisst:
    // die Kacheln der gewaehlten Terminal-Sitzung. Die Frage reist im Modell
    // und nicht in einem eigenen Kanal: der Renderer zeichnet die Sessionleiste
    // ohnehin aus dem Modell, und zwei Quellen fuer dieselbe Frage waeren zwei
    // Wahrheiten.
    chatGezeigt: chatbuehne.gezeigter(),
    // Liegt statt des Gespraechs ein WORKER dieser Chat-Sitzung auf der Buehne?
    // Dann bleibt ihre Zeile links hervorgehoben (siehe `chatWerkstattGezeigt`).
    chatWerkstattGezeigt,
    streamPane,
    // F14: nur eigene Sessions duerfen umgeraeumt werden. Die Oberflaeche zeigt
    // es an, damit sichtbar ist, warum nichts umgeraeumt wird.
    // 'mayArrange' heisst jetzt: darf JETZT umgeraeumt werden. Bei einer
    // eigenen Session immer, bei einer uebernommenen nur ohne fremden Client.
    mayArrange: s ? mayArrange(s) || (!!tmux && fremdeClients === 0) : false,
    fremdeClients,
  });
}

// --- tmux ------------------------------------------------------------------

/**
 * Die Maschine der gerade gezeichneten Sitzung -- leer, solange es die eigene
 * ist. Sie steht hier und nicht in `attachState`, weil sie schon VOR dem
 * Anhaengen feststeht und auch dann noch gebraucht wird, wenn das Anhaengen
 * fehlschlaegt: in beiden Faellen gehoert der Maschinenname in den Satz, den
 * der Mensch liest.
 */
let attachMaschine = '';

/**
 * WELCHE CHAT-SITZUNG IHRE WERKSTATT AUF DER BUEHNE HAT (Punkt 1).
 *
 * Leer heisst: keine. Steht hier eine Kennung, laeuft die Buehne gerade auf
 * einem WORKER-Pane dieser Chat-Sitzung -- die Kacheln kommen aus ihrer
 * tmux-Session, das Gespraech selbst ist zugeklappt, und die Zeile in der
 * Leiste bleibt trotzdem hervorgehoben: der Mensch ist bei DIESER Sitzung, nur
 * eben bei einem ihrer Worker. Ohne dieses Feld saehe die Leiste aus, als waere
 * er bei der zuletzt gewaehlten Terminal-Sitzung.
 */
let chatWerkstattGezeigt = '';

/**
 * DIE LEITUNG IST WEG -- und das ist ein Zustand, kein Einfrieren (10.08.).
 *
 * Ein Steuerkanal ueber ssh kann mitten im Betrieb enden: Deckel zu, WLAN weg,
 * die andere Maschine schlafen gelegt. Was dann NICHT passieren darf, ist das
 * Naheliegende -- das letzte Bild stehenzulassen. Es sieht aus wie ein lebendes
 * Terminal, es nimmt Tastendruecke entgegen, und keiner davon kommt an.
 *
 * Also: Buehne raeumen, den Grund hinschreiben, die Maschine nennen. Alles
 * andere an dieser Sitzung bleibt bedienbar -- Fortsetzen, Schliessen,
 * Umbenennen, Loeschen laufen ueber einzelne ssh-Aufrufe und haengen nicht an
 * diesem Kanal (Commit 3450070).
 */
function verbindungVerloren(maschine: string, grund: string): void {
  attachState = null;
  streamPane = '';
  ansicht = { art: 'pane', pane: '' };
  gezeichneteLage = [];
  attachError = `Die Verbindung zu ${maschine} ist abgerissen (${grund}). Das Terminal wird nicht mehr `
    + 'gezeichnet -- ein stehengebliebenes Bild waere hier das Schlimmere. Ein Klick auf die Sitzung '
    + 'baut die Verbindung neu auf; Fortsetzen, Schließen und Löschen laufen weiter drüben.';
  anOberflaeche('awb:session', {
    session: '', cols: 80, rows: 24, sizePolicy: '', windows: [], panes: [],
    activePane: '', initialContent: '',
  });
  lageSenden({ art: 'pane', cols: 80, rows: 24, aktiv: '', panes: [], inhalt: {} });
  melde(attachError);
  process.stderr.write(`Fernverbindung zu ${maschine} verloren: ${grund}\n`);
  modellSenden();
}

/**
 * @param maschine Leer = die Sitzung laeuft hier. Sonst der SSH-Alias der
 *                 Maschine, der sie gehoert; der Steuerkanal geht dann ueber
 *                 `fernAufruf` dorthin (tmux.ts).
 */
/**
 * ZWEI ANHAENGEN GLEICHZEITIG GIBT ES NICHT (17.08.).
 *
 * `attachTmux` loest den vorigen Steuerclient ab, BEVOR es einen neuen
 * aufmacht -- aber es setzt `tmux` erst, wenn das Anhaengen geglueckt ist.
 * Zwei Aufrufe, die sich ueberholen (zwei Klicks in der Sitzungsleiste, ein
 * Klick waehrend eines Wechsels in die Chat-Werkstatt), sehen deshalb beide
 * ein leeres `tmux`, loesen beide nichts ab und lassen zwei Steuerclients an
 * derselben Session stehen. GEMESSEN an Sitzung des Nutzers: zwei
 * Steuerkanal-Clients auf `wb-AI`, angelegt um 21:19:58 und um 22:03:52, beide
 * am Leben. Und jedes Anhaengen ist ein Groessenereignis fuer die Sitzung.
 *
 * Die Reihe hier laesst immer nur eines laufen; das naechste beginnt, wenn das
 * vorige fertig ist -- und findet dann ein gesetztes `tmux` vor, das es
 * ordentlich abloest.
 */
let anhaengenLaeuft: Promise<void> = Promise.resolve();
function attachTmux(sessionName: string, maschine = ''): Promise<void> {
  const dran = anhaengenLaeuft.then(() => attachTmuxJetzt(sessionName, maschine));
  // Die Reihe darf an einem Fehlschlag nicht abreissen: der Aufrufer bekommt
  // ihn, die Reihe laeuft weiter.
  anhaengenLaeuft = dran.catch(() => undefined);
  return dran;
}

async function attachTmuxJetzt(sessionName: string, maschine = ''): Promise<void> {
  if (tmux) {
    // Erst die Zuhoerer weg, dann abloesen: das Abloesen feuert 'closed', und
    // der Zuhoerer aus dem vorigen Durchlauf haette sonst gerade den Fehler
    // gesetzt, den wir hier zuruecknehmen -- danach meldete `attached` fuer
    // immer false, obwohl ein lebendiger Pane im Fenster stand (B5).
    tmux.removeAllListeners();
    await tmux.detach();
    tmux = null;
    // Was von der alten Verbindung noch gesammelt liegt, geht JETZT hinaus --
    // vor der ersten Meldung der neuen. Sonst traegen Pane-Kennungen, die es
    // hier gleich zweimal geben kann (%0 gibt es in jeder Session), Ausgabe der
    // alten Sitzung in die neue.
    ausgabeBuendel.abgeben();
    // UND DAS GEDAECHTNIS DER SCHREIBERLAUBNIS (siehe steuerkanalDarfSchreiben):
    // eine neue Verbindung kann ein neuer Server sein, und dort bedeutet
    // dieselbe Pane-Kennung einen anderen Pane.
    darfGedaechtnisLeeren();
  }
  attachError = null;
  attachMaschine = maschine;
  if (!sessionName) {
    attachState = null;
    return;
  }
  // Der Socket ist der Testhaken fuer den OERTLICHEN Weg; drueben gilt das tmux,
  // das dort im PATH steht. Ihn mitzugeben hiesse, hiesige Testverhaeltnisse auf
  // die andere Maschine zu tragen.
  const t = new TmuxControl(maschine ? '' : config.tmuxSocket, sessionName, maschine);
  try {
    const res = await t.attach({ cols: config.ownedCols, rows: config.ownedRows });
    tmux = t;
    attachState = { session: res.session, windows: res.windows, panes: res.panes, cols: res.cols, rows: res.rows, sizePolicy: res.sizePolicy, sizeIgnored: res.sizeIgnored };

    const active = res.panes.find((p) => p.active) ?? res.panes[0];
    streamPane = active?.paneId ?? '';
    // Die Groesse des PANES, nicht die des Fensters: in einem geteilten
    // Fenster sind das zwei verschiedene Zahlen, und gezeichnet wird der Pane
    // (B11). Sobald der Renderer seine Flaeche meldet, wird beides ohnehin auf
    // dieselbe Zahl gebracht.
    anOberflaeche('awb:session', {
      session: res.session,
      cols: active?.width ?? res.cols,
      rows: active?.height ?? res.rows,
      sizePolicy: res.sizePolicy,
      windows: res.windows,
      panes: res.panes,
      activePane: streamPane,
    });
    // Sofort etwas zeichnen, ohne auf die Flaechenmeldung des Renderers zu
    // warten: der vorhandene Inhalt ist da, und ohne diese Zeile oeffnet jede
    // laufende Session leer (F1).
    if (streamPane) {
      ansicht = { art: 'pane', pane: streamPane };
      lageSenden({
        art: 'pane',
        cols: active?.width ?? res.cols,
        rows: active?.height ?? res.rows,
        aktiv: streamPane,
        panes: [{ paneId: streamPane, x: 0, y: 0, cols: active?.width ?? res.cols, rows: active?.height ?? res.rows }],
        inhalt: { [streamPane]: res.initialContent[streamPane] ?? '' },
      });
    }

    const debug = process.env.AWB_DEBUG === '1';
    t.on('output', (paneId: string, data: Buffer) => {
      if (debug) process.stderr.write(`awb-debug output ${paneId} ${data.length}B\n`);
      // In der Tab-Ansicht laufen mehrere Panes gleichzeitig -- die Ausgabe
      // traegt deshalb ihre Pane-Kennung mit und wird im Renderer verteilt.
      const gezeigt = ansicht.art === 'tab' ? ansicht.panes.includes(paneId) : paneId === streamPane;
      if (!gezeigt) return;
      ausgabeBuendel.nimm(paneId, data);
    });
    // Die Aufteilung eines Fensters kann sich AUSSERHALB dieses Programms
    // aendern: ein Mensch an derselben Session hebt einen Zoom auf, teilt
    // einen Pane oder schliesst einen. Danach liefert tmux fuer den
    // gezeichneten Pane weniger Spalten, als im Fenster stehen -- der Text
    // bricht dann mitten auf der Flaeche um, und die rechte Haelfte bleibt
    // leer. Genau das war an einer uebernommenen Session zu sehen.
    //
    // Neu gezeichnet wird nur, wenn sich WIRKLICH eine Groesse geaendert hat.
    // Sonst antwortete das Programm auf seine eigenen Umstellungen und liefe
    // im Kreis.
    t.on('layout', () => lageSpaeter(300));
    t.on('closed', (code: number | null, signal: string | null) => {
      // Oertlich bleibt es bei dem einen Satz: der tmux-Server steht auf
      // derselben Maschine, und wenn er geht, ist die Sitzung selbst weg -- das
      // sagt die Leiste schon. Fern ist es die LEITUNG, die endet, waehrend die
      // Sitzung drueben weiterlaeuft; das ist ein anderer Satz und ein anderer
      // Umgang damit.
      if (!maschine) {
        attachError = 'Steuerclient beendet';
        return;
      }
      if (tmux !== t) return; // eine abgeloeste Verbindung raeumt nichts mehr weg
      tmux = null;
      const ende = signal ? `ssh endete durch ${signal}` : `ssh beendet mit Code ${code}`;
      verbindungVerloren(maschine, t.fehlertext() || ende);
    });
    t.startStreaming();
    // ERST JETZT die Buehne durchsetzen. Der Wurf oben zeichnet in der Groesse,
    // die tmux gerade hergibt (F1: keine leere Flaeche waehrend des Anhaengens);
    // eine frisch gestartete Sitzung steht dort in der Groesse, die sie beim
    // Anlegen bekommen hat, und hat die Flaeche dieses Programms noch nie
    // gesehen -- „der orchestrator tab ist vollkommen falsch formatiert"
    // (alice, 06.08.). Ein zweites Zeichnen, und sie sitzt richtig.
    //
    // OHNE ZOOM (`false`). Zoom macht den Pane in tmux auch AKTIV, und beim
    // blossen Anhaengen hat niemand eine Ansicht gewaehlt -- der aktive Pane
    // gehoert dem Menschen davor. Die Groesse wird trotzdem gesetzt; genau
    // dafuer gibt es den zweiten Weg (tmux.ts, fensterNachziehen).
    // OHNE die Groesse zu setzen (17.08.). `flaeche` ist hier die Zahl der
    // VORIGEN Ansicht: der Renderer legt sein Terminal fuer diesen Pane erst
    // beim Zeichnen an und kennt seine Zellbreite bis dahin nicht (siehe
    // renderer.ts, nachfordernSpaeter). Wer sie trotzdem an tmux weitergibt,
    // bricht das Fenster auf eine Zahl um, die er 250 ms spaeter selbst
    // korrigiert -- gemessen 147x42, dann 143x42. Zwei Umbrueche statt einem,
    // und zusammen mit der Vorgabegroesse waren es drei: die gemessene
    // Schwelle, ab der eine laufende Oberflaeche ueber ihre eigene alte
    // Zeichnung schreibt (test-app-fenster-umbruch-naht.sh). Gezeichnet wird
    // deshalb in der Groesse, die tmux gerade hat; die eine richtige Zahl
    // kommt gleich darauf vom Renderer.
    if (flaeche && streamPane) await paneZeigen(streamPane, false, false);
    if (maschine) {
      // DER UNTERSCHIED WIRD GESAGT, nicht versteckt. Er ist echt: jede Taste
      // und jedes Zeichen Ausgabe laeuft ueber die Leitung, und die kann enden.
      melde(`Terminal von ${maschine} über ssh – Ausgabe und Tastendrücke laufen über die Verbindung. `
        + 'Reißt sie ab, wird die Bühne geräumt und es steht hier, statt ein totes Bild stehen zu lassen.');
    }
  } catch (e) {
    attachError = maschine
      ? `Das Terminal der Sitzung auf ${maschine} ließ sich nicht öffnen: ${(e as Error).message}`
      : (e as Error).message;
    await t.detach();
    if (maschine) {
      // Kein Bild der VORIGEN Sitzung stehenlassen -- es gehoert nicht zu der,
      // die eben gewaehlt wurde, und niemand koennte den Unterschied sehen.
      attachState = null;
      streamPane = '';
      ansicht = { art: 'pane', pane: '' };
      gezeichneteLage = [];
      anOberflaeche('awb:session', {
        session: '', cols: 80, rows: 24, sizePolicy: '', windows: [], panes: [],
        activePane: '', initialContent: '',
      });
      lageSenden({ art: 'pane', cols: 80, rows: 24, aktiv: '', panes: [], inhalt: {} });
      melde(attachError);
    }
  }
}

/**
 * Einen anderen Pane derselben Session zeichnen (Wechsel in der rechten Leiste).
 * Der Pane bekommt dabei die Groesse der Zeichenflaeche -- beim Wechsel zwischen
 * Orchestrator und Worker aendert sie sich, also wird jedes Mal neu gesetzt.
 */
async function paneZeigen(paneId: string, zoomen = true, groesseSetzen = true): Promise<void> {
  if (PtyVerwaltung.istPty(paneId)) return ptyPaneZeigen(paneId);
  if (!tmux) throw new Error('nicht angehaengt');
  streamPane = paneId;
  ansicht = { art: 'pane', pane: paneId };
  // Ein einzelner Worker wird GEZOOMT gezeigt: nur so fuellt er die Flaeche,
  // auch wenn er im Fenster als eine Zeile von zweiundfuenfzig daliegt.
  //
  // Gezoomt wird nur, wenn ein MENSCH diese Ansicht gewaehlt hat. Zieht das
  // Programm bloss eine Aufteilung nach, die sich draussen geaendert hat,
  // bleibt der Zoom weg: `resize-pane -Z` macht den Pane in tmux auch aktiv,
  // und der aktive Pane einer fremden Session gehoert dem Menschen davor --
  // GEMESSEN daran, dass sonst gleich nach einem `split-window` von aussen
  // wieder der alte Pane aktiv war. Dann wird eben so gross gezeichnet, wie
  // tmux es hergibt; das ist ehrlicher als eine Zahl, die nur wir glauben.
  let groesse = await paneGroesse(paneId);
  // ANHALTEN, BEVOR GESTELLT WIRD (08.09.2026, siehe tmux.ts `anhalten`): die
  // Anwendung im Pane zeichnet sich auf ihr SIGWINCH hin neu, und diese Bytes
  // gelten schon fuer die neue Groesse. Kommen sie beim Fenster an, bevor die
  // neue Lage dort ist, malen sie in ein Terminal der alten Groesse. Das
  // `finally` unten setzt in jedem Fall fort.
  if (flaeche && groesseSetzen) {
    tmux.anhalten(paneId);
    // DIE BUEHNE GIBT DIE ZAHLEN VOR -- auch dann, wenn das Programm bloss eine
    // Aenderung von aussen nachzieht. Vorher stand hier nur der Zoom, und der
    // faellt beim Nachziehen weg; die Groesse fiel damit mit weg, und die
    // Sitzung behielt die Zahl, die von aussen kam. An Sitzung des Nutzers haengt
    // immer sein Terminal: unter `window-size latest` gilt dessen Groesse, also
    // 144 Spalten statt der 180, die auf die Buehne passen -- 287 Bildpunkte
    // blieben dauerhaft leer, und bei einem breiteren Terminal lief es
    // umgekehrt ueber die Buehne hinaus. `fensterNachziehen` setzt deshalb die
    // Groesse, ohne Zoom und ohne den aktiven Pane anzufassen; beim Abloesen
    // wird beides zurueckgestellt (tmux.ts, zustandZurueck).
    groesse = await (zoomen
      ? tmux.zoomPane(paneId, flaeche.cols, flaeche.rows)
      : tmux.fensterNachziehen(paneId, flaeche.cols, flaeche.rows)
    ).catch((e) => {
      // Ein stiller Fehlschlag hier war der Grund, warum sich der leere Rand
      // nicht erklaeren liess: die Flaeche blieb weg, und niemand sagte warum.
      process.stderr.write(`Pane ${paneId} nicht auf die Flaeche gebracht: ${(e as Error).message}\n`);
      return groesse;
    });
  }
  // DAS FORTSETZEN GEHOERT IN EIN `finally` (Befund 4 der Bugjagd, 15.08.).
  // `capturePane` haelt die Ausgabe dieses Panes an; wirft irgendetwas
  // zwischen Aufnahme und Absenden, bliebe er ohne diese Klammer dauerhaft
  // angehalten und wirkte eingefroren, bis das Fenster neu anhaengt.
  try {
    const inhalt = await tmux.capturePane(paneId);
    const historie = await historieHolen(paneId, [paneId]);
    const maus = { [paneId]: await tmux.mausFlags(paneId).catch(() => ({ an: false, sgr: true })) };
    gezeichneteLage = [{ paneId, cols: groesse.cols, rows: groesse.rows }];
    zuletztGezeichnet = Date.now();
    lageSenden({
      art: 'pane',
      vorgegeben: flaecheVorgegeben,
      cols: groesse.cols,
      rows: groesse.rows,
      aktiv: paneId,
      panes: [{ paneId, x: 0, y: 0, cols: groesse.cols, rows: groesse.rows }],
      inhalt: { [paneId]: inhalt },
      historie,
      maus,
    });
  } finally {
    // Erst jetzt darf der Strom weiterlaufen: was seit der Aufnahme kam, setzt
    // auf dem Bild auf, das gerade abgeschickt wurde.
    tmux.fortsetzen(paneId);
  }
}

/**
 * Ein pty-Pane auf die Buehne, ueber genau denselben Weg wie ein tmux-Pane:
 * eine Lage-Meldung mit einem Pane, seiner Groesse und seinem Inhalt.
 *
 * Der ganze Unterschied steht in drei Zeilen -- die Groesse kommt aus der
 * Buehne statt aus tmux, der Inhalt aus dem kopflosen Emulator statt aus
 * `capture-pane`, und es gibt nichts anzuhalten und fortzusetzen (der
 * `try/finally` um `capturePane` oben hat hier kein Gegenstueck, weil der Strom
 * nie unterbrochen wird: der Emulator hat den Inhalt schon).
 *
 * Was hier NICHT steht, ist der eigentliche Gewinn: keine Uebersetzung eines
 * Kachelrasters in tmux-Fenster, keine gemeinsame Ganzzahl-Rasterung, keine
 * drei vorgegebenen Aufteilungen.
 */
async function ptyPaneZeigen(paneId: string): Promise<void> {
  const v = ptyVerwaltung();
  const stand = v.standVon(paneId);
  if (!stand) throw new Error(`kein pty-Pane ${paneId}`);
  streamPane = paneId;
  ansicht = { art: 'pane', pane: paneId };
  if (flaeche) v.groesse(paneId, flaeche.cols, flaeche.rows);
  const cols = flaeche?.cols ?? stand.cols;
  const rows = flaeche?.rows ?? stand.rows;
  const inhalt = v.schirm(paneId);
  const historie = historieGesendet.has(paneId) ? {} : { [paneId]: v.historie(paneId, RUECKBLICK_ZEILEN) };
  if (!historieGesendet.has(paneId)) historieGesendet.add(paneId);
  gezeichneteLage = [{ paneId, cols, rows }];
  zuletztGezeichnet = Date.now();
  lageSenden({
    art: 'pane',
    vorgegeben: flaecheVorgegeben,
    cols,
    rows,
    aktiv: paneId,
    panes: [{ paneId, x: 0, y: 0, cols, rows }],
    inhalt: { [paneId]: inhalt },
    historie,
    maus: { [paneId]: { an: false, sgr: true } },
  });
}

/**
 * Der Rueckblick, aber nur EINMAL je Pane.
 *
 * Der Renderer legt sein Terminal beim ersten Zeichnen eines Panes an und
 * behaelt es, solange der Pane gezeigt wird; sein Rueckblick ueberlebt jedes
 * Neuzeichnen (siehe zeichneLage). Ihn bei jedem Neuzeichnen mitzuschicken
 * waere deshalb nicht nur teuer, sondern falsch -- er stuende doppelt im
 * Puffer. Verschwindet ein Pane aus der Ansicht, wird das Terminal weggeworfen
 * und der Merkposten mit ihm.
 *
 * Der Merkposten bleibt trotzdem eine ANNAHME ueber ein Fenster, das dieser
 * Prozess nicht sieht, und sie kann falsch werden: laedt das Fenster neu,
 * entstehen alle Terminals von vorn, waehrend der Merkposten hier stehen
 * bleibt. Deshalb kann der Renderer widersprechen (awb:rueckblick-fehlt weiter
 * unten) -- er ist die Stelle, die den Puffer wirklich vor sich hat.
 */
const historieGesendet = new Set<string>();
/** So viele Zeilen Rueckblick holen wir je Pane. tmux haelt selbst nicht mehr. */
const RUECKBLICK_ZEILEN = 2000;
async function historieHolen(paneId: string, gezeigt: string[]): Promise<Record<string, string>> {
  for (const id of [...historieGesendet]) if (!gezeigt.includes(id)) historieGesendet.delete(id);
  if (!tmux || historieGesendet.has(paneId)) return {};
  const text = await tmux.capturePaneHistorie(paneId, RUECKBLICK_ZEILEN).catch(() => '');
  // Gemerkt wird nur, was auch WIRKLICH hinausging. Vorher galt schon der
  // Versuch als erledigt: ein Pane, der beim ersten Zeichnen noch nichts ueber
  // seinem Schirm hatte -- ein frisch gestarteter Worker etwa --, bekam seinen
  // Rueckblick danach nie, so lang er auch wurde. Der Preis ist ein
  // tmux-Aufruf je Zeichnung, solange ein Pane leer ist; sobald er etwas hat,
  // geht der Rueckblick einmal hinaus und danach gar nicht mehr.
  if (!text) return {};
  historieGesendet.add(paneId);
  return { [paneId]: text };
}

/**
 * Dieselbe Ansicht noch einmal zeichnen -- was immer gerade gezeigt wird.
 *
 * Steht an zwei Stellen: wenn sich draussen eine Groesse geaendert hat
 * (lageAbgleichen), und wenn der Renderer meldet, dass ihm ein Rueckblick
 * fehlt. Beide wollen dasselbe, und zwei Fassungen davon liefen frueher oder
 * spaeter auseinander.
 */
async function ansichtZeichnen(): Promise<void> {
  if (!tmux) return;
  if (ansicht.art === 'tab') await tabZeigen(ansicht.panes);
  else if (streamPane) await paneZeigen(streamPane, false);
}

/**
 * Der Renderer hat ein gezeichnetes Terminal OHNE Rueckblick -- und er fragt
 * genau einmal je Terminal (renderer.ts, rueckblickAnfordern).
 *
 * Der Merkposten oben wird fuer diesen Pane geloescht und dieselbe Ansicht neu
 * gezeichnet; der Rueckblick kommt dann im naechsten Wurf mit. Mehrere Panes
 * einer Tab-Ansicht fragen unabhaengig voneinander, deshalb wird gesammelt und
 * EINMAL gezeichnet statt je Frage.
 */
let rueckblickUhr: ReturnType<typeof setTimeout> | null = null;
/**
 * DIE FLAECHE DES MANTELS (06.09.2026, mac/PLAN-TERMINAL.md). Im Mantelbetrieb
 * zeichnet der versteckte Electron-Renderer weiter mit und meldet seine eigene
 * Buehne ueber `bedienung flaeche`; die Buehne des Mantels kam ueber denselben
 * Weg, und beide ueberschrieben sich -- gemessen: vier Groessenwechsel in 30 s
 * an einem Fenster mit zwei Zeichnern. Der Mantel meldet deshalb wie der
 * Steuerkanal MIT Vorgabe: danach ignoriert `flaecheSetzen` die Meldungen des
 * Renderers (`flaecheVorgegeben`), und es gibt nur noch eine Buehne je Kern.
 */
ipc.handle('awb:mantel-flaeche', async (_e, cols: number, rows: number) => {
  await flaecheSetzen(Number(cols), Number(rows), true);
  return { cols: flaeche?.cols ?? Number(cols), rows: flaeche?.rows ?? Number(rows) };
});

ipc.on('awb:rueckblick-fehlt', (_e, n: { paneId: string }) => {
  const paneId = String(n?.paneId ?? '');
  if (!paneId || !tmux) return;
  // Nur fuer einen Pane, der auch gezeichnet ist: eine Meldung aus einer
  // vergangenen Ansicht soll nichts anstossen.
  if (!gezeichneteLage.some((p) => p.paneId === paneId)) return;
  historieGesendet.delete(paneId);
  if (rueckblickUhr) return;
  rueckblickUhr = setTimeout(() => {
    rueckblickUhr = null;
    void ansichtZeichnen().catch((e) =>
      process.stderr.write(`Rueckblick nicht nachgereicht: ${(e as Error).message}\n`));
  }, 80);
});

/**
 * ALLE Panes eines Tabs nebeneinander -- so, wie tmux sie im Fenster liegen
 * hat. Das ist die Ansicht, die ein Klick auf einen Tab bringt; ein Klick auf
 * einen einzelnen Worker fuehrt weiter zu paneZeigen().
 */
async function tabZeigen(paneIds: string[]): Promise<void> {
  if (!tmux) throw new Error('nicht angehaengt');
  const erster = paneIds[0];
  if (!erster) return;
  ansicht = { art: 'tab', panes: paneIds };
  streamPane = erster;

  // Das Gitter kommt aus der Kapazitaetsrechnung -- derselben, die auch die
  // Zahl der Tabs bestimmt (capacity.ts). Zwei Regeln nebeneinander waeren
  // zwei Wahrheiten: die Leiste rechts verspraeche vier Panes je Tab, und die
  // Buehne legte sie anders hin.
  const kap = kapazitaet();
  const flaecheJetzt = flaeche ?? { cols: config.ownedCols, rows: config.ownedRows };

  // Die Panes eines Tabs stammen aus VERSCHIEDENEN tmux-Fenstern: ein Worker
  // liegt im Fenster seines Orchestrators, der naechste im Fenster 'workers'.
  // Bisher wurde nur das Fenster des ERSTEN Panes gelesen -- alle anderen
  // fielen ohne ein Wort weg (gemessen: drei angefordert, zwei gezeichnet).
  // Erst nachsehen, wer sonst noch an der Session haengt -- danach steht fest,
  // ob ueberhaupt gestellt werden darf.
  await clientsNachlesen();
  const alle = await tmux.listPanes().catch(() => []);
  const fensterVon = new Map(alle.map((p) => [p.paneId, p.windowId]));
  const kaesten = new Map<string, { paneId: string; x: number; y: number; cols: number; rows: number }>();
  const erledigt = new Set<string>();
  /** Je Fenster: seine Groesse und wieviele Panes tmux darin fuehrt. */
  const fensterLage = new Map<string, { cols: number; rows: number; panes: number }>();

  /**
   * DER TAB UEBER MEHRERE FENSTER (03.09.2026, des Nutzers „die Worker-Panes sind
   * nicht richtig angeordnet").
   *
   * Ueberschreitet ein Tab `maxWorkerPanesPerTab`, laufen seine Panes auf ein
   * zweites tmux-Fenster ueber -- der Live-Fall waren sieben Worker auf den
   * Fenstern `workers` (sechs) und `workers-2` (einer). Bis hierher bekam dann
   * JEDES Fenster die ganze Buehne, und tmux teilte sie unter SEINEN Panes auf:
   * das Fenster mit sechs Panes machte jeden 495 Bildpunkte breit, waehrend die
   * Buehne fuer sieben Panes ein dreispaltiges Raster legte und ihm eine Kachel
   * von 334 gab. Sechs von sieben Panes liefen um 48 Prozent ueber ihre Kachel
   * hinaus, der siebte war um das Dreifache zu hoch (gemessen mit
   * messungen/direktweg-zweifenster.sh, Befund: DIREKTWEG-BEFUND.md).
   *
   * Zwei Geometrien, dieselbe Krankheit wie am 06.08. -- nur lagen sie damals
   * innerhalb eines Fensters und jetzt zwischen zweien. Die zweite faellt weg,
   * indem nicht mehr die BUEHNE, sondern die KACHEL die gemeinsame Groesse ist:
   * jedes Fenster wird so gross gestellt, dass seine eigene Aufteilung genau
   * die Kacheln ergibt, die die Buehne fuer seine Panes legt. Bei einem einzigen
   * Fenster bleibt alles, wie es war -- dort ist die Aufteilung von tmux selbst
   * das Raster (siehe „DAS RASTER" weiter unten).
   */
  const fensterDerAnforderung = new Set(
    paneIds.map((id) => fensterVon.get(id)).filter((w): w is string => !!w),
  );

  /**
   * DARF DIE BUEHNE FREI KACHELN? (03.09.2026, Stufe A)
   *
   * Nur dann, wenn KEIN gezeigtes Fenster mehr als einen Pane traegt. Ein
   * Fenster mit einem Pane hat keine Aufteilung -- seine Groesse ist die
   * Panegroesse, tmux ordnet nichts an, und die Form gehoert der Werkbank.
   * Sitzen dagegen mehrere Panes in einem Fenster (Layout 'split', eine
   * uebernommene fremde Sitzung), teilt `select-layout tiled` sie nach SEINER
   * Ordnung auf, und eine schoenere Verteilung waere wieder eine zweite
   * Geometrie daneben -- genau der Fehler, gegen den diese ganze Rechnung
   * steht. Dann gilt weiter das Raster, das tmux auch baut.
   */
  const frei =
    fensterDerAnforderung.size > 1 &&
    [...fensterDerAnforderung].every((w) => alle.filter((p) => p.windowId === w).length === 1);
  // Das Raster: frei gewaehlt, wo tmux nichts anzuordnen hat, sonst genau das,
  // das tmux zu dieser Zahl von Panes auch BAUT (gitterFuer/tiledRaster).
  // Vorher stand hier `min(perRow, anzahl)` Spalten und `ceil(anzahl / spalten)`
  // Reihen -- eine zweite Form neben der von tmux, und bei sieben Panes wich sie
  // ab: die Buehne verlangte zwei Spalten, tmux legte drei.
  const gitter = frei
    ? gitterFrei(paneIds.length, kap.perRow, kap.perColumn)
    : gitterFuer(paneIds.length, kap.perRow, kap.perColumn);
  const spalten = gitter.spalten;
  const zeilen = gitter.zeilen;
  const kacheln =
    fensterDerAnforderung.size > 1
      ? kachelZellen(paneIds.length, spalten, frei, flaecheJetzt)
      : null;
  /**
   * DIESELBE ORDNUNG WIE DER RENDERER (Pruefer, Befund 1). `kacheln` ist eine
   * flache Liste ohne eigene Paneszugehoerigkeit -- Platz `i` gehoert zu dem
   * Pane, den auch der Renderer an Platz `i` zeichnet. Der Renderer
   * (paneflaeche.ts, `kachelLage`) legt seine Kacheln erst fuer alle
   * VORHANDENEN Panes in Anforderungsreihenfolge, danach fuer alle FEHLENDEN --
   * er kennt `paneIds` selbst nicht, nur die schon getrennten Listen `panes`
   * und `fehlend`. Vorher zaehlte hier die rohe Position in `paneIds`, in der
   * ein fehlender Pane mitten drin seinen Platz behaelt; ab dem naechsten
   * vorhandenen Pane liefen beide Ordnungen dann um eins auseinander. Ob ein
   * Pane fehlt, steht schon hier fest: derselbe Grund, den die Fehlend-Liste
   * unten benutzt (`fensterVon.has`), nur vorgezogen, weil die Kachelindizes
   * VOR der Fensterschleife gebraucht werden.
   */
  const vorabVorhanden = paneIds.filter((id) => fensterVon.has(id));
  const vorabFehlend = paneIds.filter((id) => !fensterVon.has(id));
  const kachelIndexVon = new Map(
    [...vorabVorhanden, ...vorabFehlend].map((id, i) => [id, i]),
  );

  // ANHALTEN, BEVOR AN DEN GROESSEN GEDREHT WIRD (08.09.2026, siehe tmux.ts
  // `anhalten`). Gleich unten stellt `fensterAufKachel` die Fenster; jede
  // Anwendung darin bekommt ihr SIGWINCH und zeichnet sich neu, und diese
  // Bytes gelten schon fuer die neue Groesse. Waeren sie vor der neuen Lage am
  // Fenster, malten sie in ein Terminal der alten -- gemessen als ein Bild,
  // das um eine Zeile verschoben stehenblieb. Angehalten wird fuer JEDEN
  // angeforderten Pane, nicht nur fuer die, die am Ende gezeigt werden: die
  // Liste `gezeigt` gibt es hier noch nicht, und `fortsetzen` auf einen Pane,
  // der nicht angehalten war, tut nichts. Freigegeben wird auf beiden Wegen
  // hinaus: im `finally` der Aufnahmen weiter unten, und -- weil das von hier
  // aus noch nicht erreicht ist -- im `catch` am Stellen selbst.
  for (const id of paneIds) tmux.anhalten(id);

  // Teilen sich mehrere gezeigte Panes ein Fenster, gilt die Kachel des
  // ERSTEN von ihnen: eine Fenstergroesse kann nur eine sein, und tmux teilt
  // sie unter allen Panes des Fensters auf.
  for (const id of paneIds) {
    const fenster = fensterVon.get(id);
    if (!fenster || erledigt.has(fenster)) continue;
    erledigt.add(fenster);
    // WIEVIELE PANES DIESES FENSTER TRAEGT -- nicht, wieviele der Tab zeigt.
    //
    // Im Layout 'split' (die Vorgabe) sitzen die Worker als Panes UNTER dem
    // Orchestrator, also in EINEM Fenster mit ihm. Der Tab zeigt dann vier
    // Panes, das Fenster hat aber fuenf, und tmux teilt seine Flaeche unter
    // allen fuenf auf. Bisher bekam es trotzdem die Groesse fuer vier --
    // gemessen am 19.08. kopflos mit vier Workern: drei Panes standen auf
    // 495x195 Bildpunkten in einer Kachel von 501x319 (unten blieb ein
    // schwarzer Streifen), der vierte auf 998x225 in derselben Kachel und war
    // damit auf halber Breite abgeschnitten.
    const imFenster = alle.filter((p) => p.windowId === fenster).length;
    const ausDiesemFenster = new Set(paneIds.filter((x) => fensterVon.get(x) === fenster));
    // Die KLEINSTE Kachel unter den Panes dieses Fensters, nie die groesste:
    // eine Fenstergroesse gilt fuer alle seine Panes, und lieber bleibt ein
    // schwarzer Rand als dass Text abgeschnitten wird.
    let kachel: { cols: number; rows: number } | undefined;
    if (kacheln) {
      const meine = paneIds
        .map((x) => (fensterVon.get(x) === fenster ? kacheln[kachelIndexVon.get(x)!] : null))
        .filter((k): k is { cols: number; rows: number } => !!k);
      if (meine.length) {
        kachel = {
          cols: Math.min(...meine.map((k) => k.cols)),
          rows: Math.min(...meine.map((k) => k.rows)),
        };
      }
    }
    const lage = await fensterAufKachel(id, spalten, zeilen, imFenster, flaecheJetzt, ausDiesemFenster, kachel)
      .catch((e) => {
        // Bricht das Stellen ab, bleibt kein Pane angehalten stehen (Befund 4
        // der Bugjagd, 15.08.): das `finally` weiter unten wird von hier aus
        // nicht mehr erreicht, also wird hier freigegeben und weitergereicht.
        for (const x of paneIds) tmux!.fortsetzen(x);
        throw e;
      });
    fensterLage.set(fenster, { cols: lage.cols, rows: lage.rows, panes: lage.panes.length });
    for (const b of lage.panes) kaesten.set(b.paneId, b);
  }

  // In der Reihenfolge, in der sie angefordert wurden -- das ist die
  // Reihenfolge der Leiste rechts, und sie soll auf der Buehne wiederkommen.
  const gezeigt = paneIds.map((id) => kaesten.get(id)).filter((b): b is NonNullable<typeof b> => !!b);
  const fehlend = paneIds
    .filter((id) => !kaesten.has(id))
    .map((pane) => ({
      pane,
      grund: fensterVon.has(pane)
        ? 'liegt in keinem Fensterlayout mehr'
        : 'kein Pane dieser Session mehr -- geschlossen oder beendet',
    }));

  /**
   * DAS RASTER: die Fenstergroesse, in der die Kaesten oben stehen.
   *
   * BEFUND VOM 06.08. (Messung des Nutzers an drei Workern): Auf der Buehne lagen
   * drei Kacheln richtig -- zwei halbe oben, eine ganze unten --, aber die
   * Spaltenzahlen der Panes waren dagegen VERSCHOBEN: der Pane in der vollen
   * Kachel stand auf 89 Spalten (halbe Breite, rechts blieb es schwarz), der in
   * einer halben Kachel auf 179 (lief ueber und wurde abgeschnitten).
   *
   * Die Ursache waren ZWEI Geometrien nebeneinander. Die Kachel bekam ein Pane
   * bisher nach seinem PLATZ IN DER ANFORDERUNG (der Reihenfolge der rechten
   * Leiste), seine Groesse aber von tmux, das die Panes nach seiner EIGENEN
   * Ordnung im Fenster aufteilt. Beide Ordnungen stimmen nur zufaellig ueberein,
   * und bei einer ungeraden Zahl von Panes auch die FORM nicht: `select-layout
   * tiled` waehlt seine Spaltenzahl selbst (bei fuenf Panes drei Spalten), die
   * Buehne rechnete mit `perRow` aus der Kapazitaet.
   *
   * Statt eine der beiden Ordnungen nachzubessern, faellt die zweite Geometrie
   * weg: liegen alle gezeigten Panes in EINEM Fenster und ist es GENAU dessen
   * Aufteilung, dann ist die Aufteilung von tmux die Wahrheit, und die Buehne
   * bildet sie ab -- jeder Pane bekommt die Kachel, die seiner Lage im Fenster
   * entspricht. Dann kann die Spaltenzahl gar nicht mehr neben der Kachel
   * liegen: beide kommen aus derselben Zahl.
   *
   * Ohne Raster (Panes aus MEHREREN Fenstern, oder ein Fenster, von dem nur ein
   * Teil gezeigt wird -- workerLayout 'split', wo der Orchestrator im selben
   * Fenster sitzt) bleibt es bei den gleichmaessigen Kacheln des Renderers:
   * dort haben die Koordinaten der Fenster keinen gemeinsamen Ursprung.
   */
  const fensterDerGezeigten = new Set(gezeigt.map((p) => fensterVon.get(p.paneId) ?? ''));
  let raster: { cols: number; rows: number } | undefined;
  // DER TEILFALL, und er ist seit dem 19.08. nicht mehr der Rueckfall auf ein
  // gleichmaessiges Gitter: liegen alle gezeigten Panes in EINEM Fenster, das
  // aber MEHR Panes hat (Layout 'split' -- die Vorgabe --, wo der Orchestrator
  // im selben Fenster sitzt), dann ist die Aufteilung von tmux immer noch die
  // Wahrheit; es fehlen nur Zellen dazwischen. Die Buehne schiebt sie zusammen
  // (kachelnAusTeilraster) statt die Groessen zu erfinden.
  let rasterTeil: { cols: number; rows: number } | undefined;
  if (fensterDerGezeigten.size === 1 && fehlend.length === 0) {
    const lage = fensterLage.get([...fensterDerGezeigten][0]);
    if (lage && lage.cols > 0 && lage.rows > 0) {
      if (lage.panes === gezeigt.length) raster = { cols: lage.cols, rows: lage.rows };
      else rasterTeil = { cols: lage.cols, rows: lage.rows };
    }
  }

  const inhalt: Record<string, string> = {};
  let historie: Record<string, string> = {};
  const maus: Record<string, { an: boolean; sgr: boolean }> = {};
  const ids = gezeigt.map((p) => p.paneId);
  // Dieselbe Klammer wie beim einzelnen Pane (Befund 4 der Bugjagd, 15.08.),
  // und hier trifft ein Fehlschlag mehr als einen: bricht die Schleife beim
  // dritten Pane ab, blieben die ersten beiden angehalten stehen.
  try {
    for (const p of gezeigt) {
      inhalt[p.paneId] = await tmux.capturePane(p.paneId);
      historie = { ...historie, ...(await historieHolen(p.paneId, ids)) };
      maus[p.paneId] = await tmux.mausFlags(p.paneId).catch(() => ({ an: false, sgr: true }));
    }
    gezeichneteLage = gezeigt.map((p) => ({ paneId: p.paneId, cols: p.cols, rows: p.rows }));
    zuletztGezeichnet = Date.now();
    lageSenden({
      art: 'tab',
      vorgegeben: flaecheVorgegeben,
      // Die FLAECHE, nicht die Fenstergroesse: die Fenster koennen jetzt
      // verschieden gross sein, und keins davon ist die Buehne.
      cols: flaecheJetzt.cols,
      rows: flaecheJetzt.rows,
      aktiv: erster,
      panes: gezeigt,
      inhalt,
      historie,
      maus,
      spalten,
      frei,
      raster,
      rasterTeil,
      fehlend,
    });
  } finally {
    // ANGEHALTEN WURDE FUER ALLE ANGEFORDERTEN Panes, nicht nur fuer die
    // gezeigten (08.09.2026) -- also wird auch fuer alle fortgesetzt. Ein Pane,
    // der aus der Anforderung fiel, bliebe sonst dauerhaft stumm.
    for (const id of paneIds) tmux.fortsetzen(id);
  }
}

/**
 * Die Lage der Panes eines Fensters -- gelesen, und nur bei einer EIGENEN
 * Session auch gestellt.
 *
 * F14, und der 05.08. sagt, was das Uebergehen kostet: die Kachelgroessen
 * wurden in die echten tmux-Fenster einer uebernommenen Session geschrieben,
 * ein Fenster stand danach auf 126x10 statt 152x48 und ein laufender Worker auf
 * drei Zeilen. Dazu ein Flackern ohne Ende, weil jede geschriebene Groesse ein
 * `%layout-change` ausloest, das ein Neuzeichnen ausloest, das wieder schreibt.
 *
 * Fuer eine uebernommene Session wird deshalb nur gelesen. Die Kachel bekommt
 * dann den Inhalt in der Groesse, die tmux hergibt -- der Renderer zeichnet den
 * Kasten entsprechend kleiner, und die rechte Leiste sagt es (zeichneRechts).
 *
 * Fuer eine eigene Session wird gestellt, aber IDEMPOTENT: das Ziel folgt
 * allein aus Kachelgroesse und Panezahl des Fensters, nie aus einer Messung des
 * gerade eingestellten Zustands. Genau diese Rueckkopplung -- messen, nachlegen,
 * wieder messen -- war der Motor des Kreises. Steht das Fenster schon richtig,
 * schreibt der zweite Durchgang denselben Wert, tmux meldet nichts, und es ist
 * Ruhe.
 */
/**
 * Die Aufteilung, wie sie danach WIRKLICH dasteht: die Groesse des Fensters und
 * die Kaesten seiner Panes. Die Fenstergroesse kommt seit dem 06.08. mit heraus,
 * weil die Buehne sie braucht -- sie ist das Raster, in dem die Kaesten stehen
 * (siehe `tabZeigen`, Abschnitt „DAS RASTER").
 */
async function fensterAufKachel(
  paneId: string,
  gitterSpalten: number,
  gitterZeilen: number,
  panesImFenster: number,
  flaecheJetzt: { cols: number; rows: number },
  gezeigteIds: Set<string>,
  /**
   * Die Kachel, die jeder Pane DIESES Fensters auf der Buehne bekommt -- gesetzt
   * nur, wenn der Tab ueber mehrere Fenster laeuft (siehe `tabZeigen`). Dann
   * folgt die Fenstergroesse der Kachel statt der Buehne.
   */
  kachelZelle?: { cols: number; rows: number },
): Promise<{ cols: number; rows: number; panes: { paneId: string; x: number; y: number; cols: number; rows: number }[] }> {
  const leer = { cols: 0, rows: 0, panes: [] };
  if (!tmux) return leer;
  // 'owned' ist die Zusage aus F14 selbst. `sizeIgnored` waere die falsche
  // Frage: es sagt nur, ob `refresh-client -f ignore-size` gegriffen hat, und
  // auf einem aelteren tmux ist es auch bei einer fremden Session falsch.
  //
  // GROESSE UND AUFTEILUNG SIND ZWEI FRAGEN (20.08.). Bis heute hingen sie an
  // derselben Erlaubnis, und das war der Fehler hinter „das leere untere
  // Viertel": F14 schuetzt die AUFTEILUNG einer fremden Session -- ein
  // `select-layout` schoebe dem Menschen davor die Panes unter den Haenden
  // herum. Die GROESSE des Fensters setzt dieses Programm dagegen auch bei
  // einer fremden Session schon lange, im Pane-Weg (`fensterNachziehen`), und
  // stellt sie beim Abloesen zurueck. Nur der Tab-Weg liess sie mit der
  // Aufteilung zusammen weg -- und weil eine Werkbank-Sitzung KEIN
  // `@awb_owner` traegt (das setzt nur die Chat-Werkstatt) und an des Nutzers
  // Sitzung immer sein Terminal haengt, war das der Normalfall und nicht die
  // Ausnahme. GEMESSEN am 20.08. auf eigenem Socket, drei Worker im Tab,
  // Buehne 1002x638: das Fenster blieb bei 80x24 und die Panes bei 40x24,
  // 39x12 und 39x11 -- genau Bild des Nutzers.
  //
  // Also wird die Groesse jetzt in BEIDEN Faellen gesetzt und nur das
  // Umraeumen bleibt an der Erlaubnis. Ohne eine Flaeche VON DER BUEHNE bleibt
  // es beim blossen Lesen: `flaecheJetzt` faellt sonst auf ownedCols/ownedRows
  // zurueck, und die Vorgabe aus der Konfiguration in ein fremdes Fenster zu
  // schreiben ist genau der Umbruch ohne Zweck, den der 17.08. entfernt hat.
  const umraeumen = darfUmraeumen();
  if (!umraeumen && !flaeche) {
    const nur = await tmux.leseFensterLage(paneId).catch(() => null);
    return nur ?? leer;
  }
  // Das Fenster bekommt die Groesse des GITTERS, und tmux teilt es nach
  // derselben Form auf, die die Buehne legt: eine Spalte untereinander, eine
  // Zeile nebeneinander, sonst gekachelt. Beides muss zusammenpassen, sonst
  // ist der Inhalt breiter als seine Kachel und wird abgeschnitten.
  // Das Fenster bekommt Platz fuer SEINE Panes, in derselben Kachelgroesse, die
  // der Tab legt. Zeigt der Tab alle Panes des Fensters, ist das genau das
  // Raster des Tabs; traegt das Fenster mehr (Layout 'split': der Orchestrator
  // sitzt mit darin), wird es entsprechend groesser -- und jeder einzelne Pane
  // behaelt trotzdem die Groesse einer Kachel.
  // Die Form richtet sich nach den Panes, die DIESES Fenster traegt: eine
  // Spalte untereinander, eine Reihe nebeneinander, sonst gekachelt. Alles
  // andere waehlt `tiled` selbst -- erzwingen laesst sich nur der erste und der
  // zweite Fall.
  const eigen =
    gitterSpalten === 1
      ? { spalten: 1, zeilen: Math.max(1, panesImFenster) }
      : gitterZeilen === 1
        ? { spalten: Math.max(1, panesImFenster), zeilen: 1 }
        : tiledRaster(panesImFenster);
  const aufteilung = eigen.spalten === 1 ? 'even-vertical' : eigen.zeilen === 1 ? 'even-horizontal' : 'tiled';
  // DAS FENSTER BEKOMMT DIE FLAECHE DER BUEHNE. Nicht mehr, nicht weniger.
  //
  // Vorher wurde eine Kachelgroesse ausgerechnet und mit der Zahl der Spalten
  // und Reihen wieder multipliziert, samt Trennlinien obendrauf. Das ist
  // zweimal gerundet und lag beides Male daneben: mal war das Fenster groesser
  // als die Buehne (gemessen am 19.08. kopflos: 43 Zeilen fuer eine Buehne von
  // 42, die unterste Zeile der unteren Panes war ab), mal um den weggeworfenen
  // Rest kleiner (ein schwarzer Streifen am Rand).
  //
  // Die Flaeche unmittelbar zu nehmen ist genauer und zugleich sicher: tmux
  // verteilt den Rest selbst (66|67 statt 66|66), und weil die Buehne ihre
  // Zellenzahl aus derselben Flaeche ABRUNDET, ist eine Kachel nie schmaler als
  // ihr Inhalt. Traegt das Fenster mehr Panes, als der Tab zeigt (Layout
  // 'split'), werden sie eben kleiner -- die Buehne schiebt sie dann zusammen
  // (kachelnAusTeilraster), und lieber ein schwarzer Rand als abgeschnittener
  // Text.
  //
  // AUSSER, DER TAB LAEUFT UEBER MEHRERE FENSTER. Dann ist die Buehne nicht
  // mehr die Groesse EINES Fensters, und ihr blind zu folgen war der
  // Sieben-Worker-Fehler: jedes Fenster teilte die ganze Buehne unter seinen
  // eigenen Panes auf, waehrend die Buehne fuer die Gesamtzahl kachelte. Das
  // Fenster bekommt dann so viele Kacheln, wie seine eigene Aufteilung breit
  // und hoch ist, plus die Trennlinien dazwischen -- danach ist jeder seiner
  // Panes genau eine Kachel gross.
  let cols = kachelZelle
    ? eigen.spalten * kachelZelle.cols + (eigen.spalten - 1)
    : flaecheJetzt.cols;
  let rows = kachelZelle
    ? eigen.zeilen * kachelZelle.rows + (eigen.zeilen - 1)
    : flaecheJetzt.rows;

  /**
   * ZEIGT DER TAB NUR EINEN TEIL DES FENSTERS, WIRD DAS FENSTER GROESSER.
   *
   * DER BEFUND (alice, 19.08., Bildschirmfoto Fehler8.png): Der zweite
   * Worker-Tab mit EINEM Worker darin zeichnete oben vier Zeilen und darunter
   * zwei Drittel Schwarz -- keine Fusszeile, kein Kontextbalken. Der Grund war
   * nicht die Kachel, sondern der Pane: sein Fenster trug Orchestrator und
   * sieben Worker, es bekam die Groesse der Buehne (57 Zeilen), und
   * `even-vertical` teilte die unter allen acht auf. Der gezeigte Worker stand
   * damit auf SECHS Zeilen und wurde in eine Kachel von 57 gezeichnet. Der
   * erste Tab hatte denselben Fehler in kleinerer Form: sechs von acht Panes,
   * jeder ein Drittel schmaler als seine Kachel.
   *
   * Also wird das Fenster so gross gestellt, dass die GEZEIGTEN Panes zusammen
   * die Buehne fuellen. `R`/`C` ist das Raster des Fensters, `Kr`/`Kc` sind die
   * Reihen und die dichteste Reihe unter den gezeigten Panes -- der Rest ist
   * ein Dreisatz. Genommen wird die DICHTESTE Reihe, nie die duennste: sonst
   * liefe die dichteste ueber ihre Kacheln hinaus, und abgeschnittener Text ist
   * schlimmer als ein schwarzer Rand.
   *
   * Kein zweiter Durchgang mehr, und kein Kreis (05.09., Auftrag tmuxreste):
   * das Ziel folgt allein aus dem Raster und der Buehne, nicht aus einer
   * Messung des eingestellten Zustands. Bis heute wurde das Raster aus dem
   * ERGEBNIS eines ersten `fitWindow` auf die Buehne gelesen und danach ein
   * zweites Mal gestellt -- zwei Groessenwechsel je Neuzeichnung, gemessen
   * mit test-fenster-tab-weg.sh (140x41, dann 140x57; zu zweit 100x30,
   * 100x43, 100x41, 100x43), und zwischen beiden stand die Buehnenzahl in der
   * Anmeldung fuer den anderen Zeichner. Das Raster haengt bei allen drei
   * Aufteilungen nicht von der Groesse ab, also wird ERST die Aufteilung
   * gestellt, dann das Raster gelesen, und die Groesse danach genau einmal
   * geschrieben.
   */
  //
  // NICHT, WENN DIE KACHEL DIE GROESSE VORGIBT: dieser Dreisatz rechnet
  // gegen die BUEHNE, und ueber mehrere Fenster ist die Buehne nicht das Mass
  // eines einzelnen Fensters. Dort ist ohnehin schon jeder Pane genau eine
  // Kachel gross -- auch die, die dieser Tab nicht zeigt.
  if (!kachelZelle) {
    if (umraeumen) await tmux.aufteilungSetzen(paneId, aufteilung).catch(() => undefined);
    const lage = await tmux.leseFensterLage(paneId).catch(() => null);
    const gezeigteBoxen = lage ? lage.panes.filter((p) => gezeigteIds.has(p.paneId)) : [];
    if (lage && gezeigteBoxen.length && gezeigteBoxen.length < lage.panes.length) {
      const R = new Set(lage.panes.map((p) => p.y)).size;
      const C = new Set(lage.panes.map((p) => p.x)).size;
      const reihen = new Set(gezeigteBoxen.map((p) => p.y));
      const Kr = reihen.size;
      const Kc = Math.max(...[...reihen].map((y) => gezeigteBoxen.filter((p) => p.y === y).length));
      // Ist die dichteste gezeigte Reihe schon so dicht wie das Raster, bleibt es
      // bei der Flaeche der Buehne -- die Trennlinien dazuzurechnen machte das
      // Fenster dann um genau sie zu gross, und ein Pane, den tmux ueber die
      // ganze Reihe zieht, liefe um diese Zellen ueber seine Kachel hinaus
      // (gemessen: 1005 gegen 1002 Bildpunkte bei vier Workern, 675 gegen 501 bei
      // sieben).
      cols = Kc >= C ? flaecheJetzt.cols : Math.floor((C * flaecheJetzt.cols) / Kc) + (C - 1);
      rows = Kr >= R ? flaecheJetzt.rows : Math.floor((R * flaecheJetzt.rows) / Kr) + (R - 1);
    }
  }
  const gitter = await tmux.fitWindow(paneId, cols, rows, aufteilung, umraeumen).catch(() => null);
  return gitter ?? leer;
}

/**
 * Was tmux jetzt hat, gegen das, was zuletzt gezeichnet wurde. Weicht die
 * Groesse eines gezeigten Panes ab, wird dieselbe Ansicht noch einmal
 * gezeichnet.
 *
 * DREI Riegel gegen den Kreis, und jeder allein wuerde nicht reichen:
 *
 *   1. Gezeichnet wird nur bei einem WIRKLICHEN Unterschied. Meldungen, die
 *      unser eigenes Stellen ausgeloest hat, laufen damit ins Leere -- aber nur,
 *      solange das Stellen denselben Wert wieder schreibt.
 *   2. Deshalb ist das Stellen idempotent (fensterAufKachel): das Ziel folgt
 *      aus Kachel und Panezahl, nie aus einer Messung. Ohne diesen Punkt trieb
 *      sich der Kreis selbst an -- gemessen am 05.08. als Dauerflackern.
 *   3. Eine Abklingzeit nach jedem Zeichnen. Kommen die Meldungen unseres
 *      eigenen Stellens verspaetet, treffen sie auf eine Sperre und werden
 *      EINMAL nach hinten geschoben statt beantwortet.
 *
 * Und ein Durchgang zur Zeit: laeuft schon einer, wird der naechste verworfen.
 */
const ABKLINGZEIT_MS = 750;
let zuletztGezeichnet = 0;
let gleichtAb = false;

/**
 * Worker-Panes der gezeigten Sitzung, die in der laufenden Tab-Ansicht (noch)
 * nicht vorkommen -- der Fall „ein Worker kommt dazu, waehrend man zusieht".
 *
 * Leer, sobald die Sitzung mehr als EINEN Tab hat: welcher Worker in welchen
 * Tab faellt, entscheidet die Leiste rechts, und diese Regel gehoert genau
 * einmal ins Programm.
 */
function neueWorkerPanes(): string[] {
  if (ansicht.art !== 'tab') return [];
  if (kapazitaet().tabs > 1) return [];
  const s = gewaehlte();
  if (!s) return [];
  const drin = new Set(ansicht.panes);
  return s.workers
    .filter((w) => w.alive && w.paneId && !drin.has(w.paneId))
    .map((w) => w.paneId);
}
async function lageAbgleichen(): Promise<void> {
  if (!tmux || !gezeichneteLage.length || gleichtAb) return;
  if (Date.now() - zuletztGezeichnet < ABKLINGZEIT_MS) {
    lageSpaeter(ABKLINGZEIT_MS - (Date.now() - zuletztGezeichnet) + 50);
    return;
  }
  gleichtAb = true;
  try {
    const jetzt = await tmux.listPanes().catch(() => []);
    const stand = new Map(jetzt.map((p) => [p.paneId, `${p.width}x${p.height}`]));
    const anders = gezeichneteLage.some((p) => {
      const s = stand.get(p.paneId);
      return !!s && s !== `${p.cols}x${p.rows}`;
    });
    // ZWEITER ANLASS (19.08.): die ANZAHL hat sich geaendert. Bis heute stand
    // hier nur die Frage nach der GROESSE, und `!!s &&` liess einen Pane, den
    // es nicht mehr gibt, ausdruecklich durchgehen. Die Folge war am Bild
    // gemessen: schliesst man einen von fuenf Workern, behielt der tote Pane
    // seine Kachel ueber die volle Breite, und die uebrigen vier blieben im
    // alten Zwei-mal-Zwei darueber stehen -- bis jemand den Tab neu oeffnete.
    //
    // Die Kachel MIT GRUND bleibt, wofuer sie gedacht ist: der Pane fehlte
    // schon, als der Tab geoeffnet wurde ("ein Worker, der ohne ein Wort
    // verschwindet, ist schlimmer als einer, der schlecht sitzt"). Verschwindet
    // er, WAEHREND man zusieht, folgt die Ansicht -- dass er weg ist, sagt die
    // Leiste rechts, die ihn dann unter "Fertig" fuehrt.
    const verschwunden = ansicht.art === 'tab'
      ? ansicht.panes.filter((id) => !stand.has(id))
      : [];
    if (verschwunden.length && ansicht.art === 'tab') {
      const bleibt = ansicht.panes.filter((id) => stand.has(id));
      // Bleibt keiner uebrig, wird nichts umgeschrieben: dann ist die Ansicht
      // als Ganzes gegenstandslos, und die Kacheln mit Grund sind das einzige,
      // was ueberhaupt noch etwas sagt.
      if (bleibt.length) ansicht = { art: 'tab', panes: bleibt };
    }
    // DIE GEGENRICHTUNG: ein Worker kommt DAZU. tmux teilt sein Fenster dann
    // neu auf, `anders` schlaegt also an -- aber die Ansicht kennt den neuen
    // Pane nicht, und die Buehne legte N Kacheln fuer N+1 Panes. Genau das ist
    // dieselbe Luecke wie beim Spiegel, nur zeitlich statt raeumlich.
    //
    // ERGAENZT WIRD NUR BEI EINEM EINZIGEN TAB. Wie die Worker auf mehrere
    // Tabs fallen, entscheidet die Leiste rechts (renderer.ts, `imTab`); diese
    // Regel hier ein zweites Mal zu schreiben hiesse, zwei Wahrheiten zu
    // fuehren, von denen eine irgendwann die falsche ist. Bei einem Tab gibt es
    // nichts zu entscheiden: er zeigt alle.
    const dazu = neueWorkerPanes();
    if (dazu.length && ansicht.art === 'tab') {
      ansicht = { art: 'tab', panes: [...ansicht.panes, ...dazu] };
    }
    if (!anders && !verschwunden.length && !dazu.length) return;
    await ansichtZeichnen();
  } catch (e) {
    process.stderr.write(`Aufteilung nicht nachgezogen: ${(e as Error).message}\n`);
  } finally {
    gleichtAb = false;
  }
}

/** Ein Abgleich, angesetzt und zusammengefasst -- der Hoerer setzt ihn auch. */
let lageUhr: ReturnType<typeof setTimeout> | null = null;
function lageSpaeter(ms: number): void {
  if (lageUhr) clearTimeout(lageUhr);
  lageUhr = setTimeout(() => {
    lageUhr = null;
    void lageAbgleichen();
  }, ms);
}

/**
 * Wartet, bis die Fensterflaeche eine halbe Sekunde lang dieselbe bleibt.
 * Waehrend einer Zoom-Animation aendert sie sich in jedem Bild; wer zu frueh
 * misst, bekommt eine Zwischengroesse, die zu keinem der beiden Endzustaende
 * passt. Nach spaetestens fuenf Sekunden wird trotzdem geantwortet -- lieber
 * ein gemeldeter Zwischenstand als ein haengender Steuerkanal.
 */
async function groesseBeruhigt(w: BrowserWindow, ruheMs = 500, maxMs = 5000): Promise<void> {
  const ende = Date.now() + maxMs;
  let letzte = w.getContentSize().join('x');
  let seit = Date.now();
  while (Date.now() < ende) {
    await new Promise((r) => setTimeout(r, 50));
    const jetzt = w.getContentSize().join('x');
    if (jetzt !== letzte) {
      letzte = jetzt;
      seit = Date.now();
      continue;
    }
    if (Date.now() - seit >= ruheMs) return;
  }
}

/** Die tatsaechliche Groesse eines Panes -- sie und nicht die des FENSTERS. */
async function paneGroesse(paneId: string): Promise<{ cols: number; rows: number }> {
  const panes = (await tmux!.listPanes()).find((p) => p.paneId === paneId);
  return { cols: panes?.width ?? 80, rows: panes?.height ?? 24 };
}

/**
 * Der Renderer meldet, wieviele Spalten und Zeilen in seine Flaeche passen.
 * Das ist die Umkehrung der bisherigen Richtung: nicht das Gitter richtet sich
 * nach der Session, sondern die Session nach der Flaeche. Danach wird der Pane
 * neu aufgenommen, weil sein Inhalt in der neuen Breite anders umbricht.
 */
let flaechenWunsch: { cols: number; rows: number } | null = null;
let flaechenLauf: Promise<void> | null = null;
/**
 * OB GERADE EIN DURCHGANG LAEUFT -- und warum das ein eigener Schalter ist und
 * nicht "flaechenLauf ist nicht null".
 *
 * DER FEHLER, den das behebt (gemessen 06.08.): Kommt ein Wunsch an, waehrend
 * das Programm an KEINER Session haengt, laeuft der Durchgang bis zum Ende
 * durch, ohne je zu warten -- `continue` ueberspringt jedes `await`. Sein
 * `finally` setzte `flaechenLauf` dann auf null, BEVOR die Zuweisung
 * `flaechenLauf = (async () => …)()` ueberhaupt fertig war; danach stand dort
 * eine laengst erledigte Zusage, und die ist nie wieder null. Von da an landete
 * jeder weitere Wunsch in `flaechenWunsch` und wurde von niemandem mehr
 * abgeholt: die Buehne meldete ihre Flaeche, das Programm nahm sie entgegen und
 * tat nichts. Genau das ist „die Fläche wird beim Öffnen abgegeben und beim
 * Schließen nicht zurückgeholt" -- und es traf jede Sitzung, die einmal ohne
 * Anhang gewaehlt wurde.
 *
 * Der Schalter wird VOR dem Start gesetzt und im `finally` geloescht; beides
 * in derselben Reihenfolge, in der es auch laeuft.
 */
let flaechenLaeuft = false;

/**
 * WIE LANGE DIE FLAECHE STILLSTEHEN MUSS, BEVOR TMUX SIE ERFAEHRT.
 *
 * Jeder Wunsch, der hier durchkommt, wird zu einem `resize-window`, und jeder
 * Groessenwechsel bricht die Zeichnung des Programms um, das gerade im Pane
 * laeuft. EIN Wechsel bleibt sauber -- das Programm zeichnet danach neu. Zwei
 * kurz hintereinander sind es nicht: der Zeichner ueberschreibt nur so viele
 * Zeilen, wie seine LETZTE Zeichnung hoch war, und was eine fruehere, breitere
 * davon rechts stehen liess, raeumt er nie mehr ab. GEMESSEN am 04.09. gegen
 * den Zeichner aus `test-app-fenster-umbruch-naht.sh`: nach 188 -> 123 -> 143
 * stehen zwei Zeichnungen zugleich im Puffer, und sie stehen dort auch fuenf
 * Sekunden spaeter noch. Der Abstand entscheidet nichts -- dieselbe Folge
 * erzeugt den Salat bei 10 ms Abstand wie bei einer Sekunde. Es ist kein
 * Wettlauf, den Abwarten heilt, sondern ein Rest, den niemand mehr abraeumt.
 *
 * UND DIE ZWEITE MELDUNG KOMMT VON SELBST. Die Buehne haengt an vielen
 * Ausloesern -- am `resize` des Fensters, an `awb:flaeche-geaendert`, an jedem
 * `onSession`/`onLayout`, an `setzeSchrift`. Gemessen am Stand 646a9f3, an dem
 * die Suite unter Last umkippte: beim Anhaengen meldete sie 123x34 und eine
 * Millisekunde spaeter 143x34, und der Hauptprozess machte pflichtschuldig zwei
 * Umbrueche daraus. Die 123 war nie eine Groesse, die jemand sehen sollte; sie
 * entstand, waehrend die Anordnung um die Buehne noch stand.
 *
 * Deshalb wird ein Wunsch nicht sofort ausgefuehrt, sondern erst, wenn
 * `FLAECHE_RUHE_MS` lang kein neuer nachkam -- laengstens aber
 * `FLAECHE_RUHE_MAX_MS`, damit ein durchgehender Strom (jemand zieht das
 * Fenster an der Kante) nicht ewig wartet. Wer eine Flaeche setzt und auf sie
 * wartet, wartet unveraendert bis zum Ende: das Warten liegt INNERHALB des
 * Durchgangs, auf den `flaechenLauf` zeigt.
 */
const FLAECHE_RUHE_MS = 40;
const FLAECHE_RUHE_MAX_MS = 200;

/**
 * WOHER die geltende Flaeche kommt. Meldet sie die Buehne selbst, darf sie sie
 * auch nachfordern, wenn das Gezeichnete nicht dazu passt. Gibt sie ein Skript
 * ueber den Steuerkanal vor (`awb-ctl flaeche 100x30`), dann gilt genau diese
 * Zahl und die Buehne haelt still -- sonst ueberschriebe das Fenster eine
 * Vorgabe, deren Zweck es gerade ist, unabhaengig von der Fenstergroesse zu
 * pruefen.
 */
let flaecheVorgegeben = false;

async function flaecheSetzen(cols: number, rows: number, vorgegeben = false): Promise<void> {
  flaecheVorgegeben = vorgegeben;
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 20 || rows < 5) return;
  // NUR EIN Durchgang zur Zeit, und immer der neueste Wunsch.
  //
  // Vorher lief jede Meldung als eigener asynchroner Durchgang. Beim
  // Maximieren kommen aber Dutzende: macOS zoomt animiert, der Renderer meldet
  // in jedem Bild eine neue Zellenzahl. Jeder Durchgang nimmt seine EIGENE
  // Momentaufnahme des Panes, und die Durchgaenge enden in beliebiger
  // Reihenfolge -- der letzte, der ankommt, ist nicht der juengste. Gemessen
  // mit der echten Agenten-Oberflaeche im Pane: nach dem Maximieren stand im
  // Fenster ein Kasten von 130 Spalten, waehrend tmux laengst 178 gezeichnet
  // hatte; darueber lagen Bruchstuecke der neuen Ausgabe, und die Eingabezeile
  // sass verschoben mit einem Rahmenstueck davor. Die Groesse stimmte dabei die
  // ganze Zeit -- falsch war nur, WELCHE Momentaufnahme zuletzt ankam.
  //
  // Deshalb: der Wunsch wird hinterlegt, ein laufender Durchgang nimmt ihn beim
  // naechsten Umlauf mit, und wer wartet, wartet bis die Reihe leer ist. Damit
  // gibt es keine zwei Momentaufnahmen mehr, die sich ueberholen koennen.
  //
  // SOFORT, nicht erst nach der Ruhefrist: `flaeche` ist die geltende Zahl, an
  // der sich Kachelrechnung, `wb-workers-window` und jede Groessenauskunft
  // ausrichten. Aufgeschoben wird nur der Umbruch in tmux -- wer die Flaeche
  // liest, liest die neue (gemessen an test-app-fenster-zu-klein.sh, deren
  // Zusagen 2 und 6 fielen, solange auch diese Zuweisung wartete).
  flaeche = { cols, rows };
  flaechenWunsch = { cols, rows };
  if (!flaechenLaeuft) {
    flaechenLaeuft = true;
    flaechenLauf = (async () => {
      try {
        while (flaechenWunsch) {
          // ZUERST die Frage, ob ueberhaupt gezeichnet wird -- und erst dann
          // warten. Haengt das Programm an keiner Sitzung, ist eine Meldung nur
          // eine Zahl, die `flaeche` schon aufgenommen hat; sie hier
          // aufzuheben, hiesse eine Groesse von VOR dem Anhaengen aufzubewahren
          // und sie danach nach tmux zu schicken. GEMESSEN am 04.09. am Stand
          // 646a9f3, mit der Wartezeit VOR dieser Frage: die Buehne meldete
          // 123x34, bevor der Pane stand, das Warten hob die Zahl ueber den
          // Augenblick des Anhaengens hinweg, und tmux bekam sie 45 ms spaeter
          // als ersten von zwei Umbruechen zugestellt -- acht von acht Laeufen
          // rot. Mit dieser Reihenfolge faellt sie da, wo sie hingehoert.
          if (!tmux || !streamPane) {
            flaechenWunsch = null;
            continue;
          }
          const spaetestens = Date.now() + FLAECHE_RUHE_MAX_MS;
          do {
            flaechenWunsch = null;
            await new Promise((f) => setTimeout(f, FLAECHE_RUHE_MS));
          } while (flaechenWunsch && Date.now() < spaetestens);
          flaechenWunsch = null;
          // Dieselbe Ansicht noch einmal zeichnen, jetzt in der neuen Flaeche.
          //
          // OHNE ZOOM (`false`). Eine neue Flaeche ist keine neue ANSICHT: sie
          // sagt, wie gross gezeichnet wird, nicht was gezeigt wird. Der Zoom
          // dagegen macht den Pane in tmux auch aktiv, und der aktive Pane
          // gehoert dem Menschen davor -- GEMESSEN am 06.08.: teilt jemand
          // draussen sein Fenster, wird neu gezeichnet, und der Zoom holte den
          // aktiven Pane zurueck auf den, den WIR zeichnen. Wer eine
          // Einzelansicht waehlt, bekommt seinen Zoom weiterhin (paneZeigen aus
          // 'show-pane'), und der bleibt ueber jede Flaechenaenderung stehen.
          if (ansicht.art === 'tab') await tabZeigen(ansicht.panes);
          else await paneZeigen(streamPane, false);
        }
      } finally {
        flaechenLaeuft = false;
      }
    })();
  }
  await flaechenLauf;
}

/**
 * Eingabe in den gezeichneten Pane. Als Hex-Bytes, damit Sondertasten,
 * Steuerzeichen und mehrbytige Zeichen unveraendert ankommen -- `send-keys -H`
 * nimmt genau das entgegen und deutet nichts um.
 */
async function eingabe(bytes: Buffer): Promise<void> {
  if (!tmux) throw new Error('nicht angehaengt');
  if (!streamPane) throw new Error('kein Pane gewaehlt');
  await tmux.sendBytes(streamPane, bytes);
}

ipc.on('awb:input', (_e, n: { paneId: string; base64: string }) => {
  const ziel = n?.paneId || streamPane;
  void (async () => {
    // DERSELBE WEG AUS DEM RENDERER, ZWEI ZIELE (04.09.2026). Der Renderer
    // schickt weiter nur Pane-Kennung und Bytes; woran der Pane haengt,
    // entscheidet sich hier und nirgends sonst. `paneflaeche.ts` ist deshalb
    // unveraendert geblieben.
    if (PtyVerwaltung.istPty(ziel)) {
      streamPane = ziel;
      ptyVerwaltung().schreiben(ziel, Buffer.from(n.base64, 'base64'));
      return;
    }
    if (!tmux) throw new Error('nicht angehaengt');
    if (!ziel) throw new Error('kein Pane gewaehlt');
    // Tippen macht den Pane zum gewaehlten -- sonst tippt man in den einen und
    // die naechste Taste landet im anderen.
    streamPane = ziel;
    await tmux.sendBytes(ziel, Buffer.from(n.base64, 'base64'));
  })().catch((err) => {
    process.stderr.write(`Eingabe nicht zugestellt: ${(err as Error).message}\n`);
  });
});

// Bedienung aus der Oberflaeche. Sie geht denselben Weg wie der Steuerkanal,
// damit es nur eine Fassung jeder Handlung gibt.
ipc.on('awb:bedienung', (_e, nachricht: { aktion: string; wert: unknown }) => {
  void (async () => {
    const { aktion, wert } = nachricht;
    switch (aktion) {
      case 'select':
        await sessionWaehlen(String(wert));
        break;
      // Eine Chat-Sitzung waehlen -- dieselbe Zweiteilung wie beim Plus (siehe
      // 'sitzung-zeigen'/'sitzung-bauen'): der ECHTE Klick legt sie auf die
      // Buehne, jeder unechte (Test, Steuerkanal) startet sie nur. Welcher von
      // beiden vorliegt, entscheidet der Renderer an `isTrusted`; der
      // Hauptprozess kann es einem Ereignis nicht ansehen.
      case 'chat-zeigen':
        chatWerkstattGezeigt = '';
        await chatbuehne.zeigeNachEchtemKlick(String(wert));
        break;
      case 'chat-bauen':
        await chatbuehne.baue(String(wert));
        break;
      // EIN WORKER EINER CHAT-SITZUNG AUF DIE BUEHNE (Punkt 1). Der Wert ist
      // `<chatId>|<paneId>`: WELCHE Sitzung gemeint ist, muss mitreisen, weil
      // ein Pane allein nicht sagt, zu welcher Werkstatt er gehoert.
      case 'chat-worker': {
        const [chatId, paneId] = String(wert).split('|');
        await chatWorkerZeigen(chatId ?? '', paneId ?? '');
        break;
      }
      case 'show-pane':
        await paneZeigen(String(wert));
        break;
      case 'show-tab':
        await tabZeigen((Array.isArray(wert) ? wert : []).map(String));
        break;
      case 'flaeche': {
        // EINE VORGABE HAELT, BIS EINE NEUE KOMMT.
        //
        // `flaecheVorgegeben` sagt seit jeher: gibt ein Skript die Flaeche ueber
        // den Steuerkanal vor, „gilt genau diese Zahl und die Buehne haelt
        // still". Gehalten hat sie nur die Nachforderung im Renderer, und die
        // entscheidet anhand der Lage, mit der sie 250 ms vorher losgeschickt
        // wurde -- kommt die Vorgabe in diesen 250 ms, prueft sie gegen einen
        // Stand, den es nicht mehr gibt, und ueberschreibt die Vorgabe mit der
        // selbst gemessenen Zahl. GEMESSEN auf peer am 21.08.: nach
        // `awb-ctl flaeche 132x40` rechnete die Kapazitaet mit 137x35, und die
        // Zusage A13 in test-app-oberflaeche.sh fiel. Die Sperre gehoert
        // deshalb hierher, wo der Stand WIRKLICH steht, statt in eine
        // Momentaufnahme davon.
        //
        // Zurueckgenommen wird eine Vorgabe durch die naechste Vorgabe (der Weg
        // ueber 'flaeche' im Steuerkanal, der `vorgegeben` selbst setzt) -- kein
        // Produktivpfad setzt sie je.
        if (flaecheVorgegeben) break;
        const f = wert as { cols: number; rows: number };
        await flaecheSetzen(Number(f?.cols), Number(f?.rows));
        break;
      }
      case 'sidebar-width':
        ui.set({ sidebarWidth: Math.max(48, Math.min(480, Number(wert) || 48)) });
        modellSenden();
        break;
      // DIE BREITE DES INSPEKTORS. Seit dem 05.09.2026 (Electron-Befund 1) ist
      // es seine einzige: der vierzig Bildpunkte schmale Reiterstreifen daneben
      // ist weggefallen, zu heisst null. Grenzen: nie unter 280, nie ueber die
      // Haelfte des Fensters; die Obergrenze rechnet der Renderer, der das
      // Fenster kennt.
      case 'blatt-breite':
        ui.set({ blattBreite: Math.max(280, Math.min(1200, Number(wert) || 360)) });
        modellSenden();
        break;
      // OB EIN BLATT OFFEN STEHT. Der Renderer meldet den Wechsel; gerechnet
      // wird damit in `kapazitaet()` (Electron-Befund 7).
      case 'blatt-offen':
        blattOffen = !!wert;
        modellSenden();
        break;
      // OB DER EDITOR EINGEKLAPPT STEHT (05.09.2026). Der Renderer meldet den
      // Wechsel, ui.json merkt ihn wie die uebrigen Ansichtswahlen.
      case 'editor-eingeklappt':
        ui.set({ editorEingeklappt: !!wert });
        modellSenden();
        break;
      case 'show-stopped':
        ui.set({ showStopped: !!wert });
        modellSenden();
        break;
      case 'worker-tab':
        ui.set({ workerTab: Math.max(0, Number(wert) || 0) });
        modellSenden();
        break;
      // WAS DIE FLAECHE DIESER SITZUNG ZEIGT (04.09.): der Orchestrator allein
      // oder die Worker in Tabs. Die Wahl gehoert der Sitzung und wird in
      // ui.json gemerkt -- welcher Pane daraufhin gezeichnet wird, sagt der
      // Renderer im selben Zug ueber 'show-pane'/'show-tab'; hier wird nur
      // gemerkt, nicht gezeichnet.
      case 'flaeche-modus': {
        const w = wert as { id?: string; modus?: string };
        ui.flaecheSetzen(String(w?.id ?? ''), String(w?.modus ?? ''));
        modellSenden();
        break;
      }
      case 'order':
        ui.set({ order: Array.isArray(wert) ? (wert as string[]).map(String) : [] });
        modellSenden();
        break;
      // DIE REIHENFOLGE DER PROJEKTE (08.09.2026, Befund des Nutzers an der
      // Mac-Fassung). Ein Ordner je Eintrag; 'order' daneben ordnet die Zeilen
      // INNERHALB eines Projekts. Beide Fassungen gehen denselben Weg -- der
      // Mac-Mantel ueber `awb:bedienung` durch mantel.ts, der Renderer ueber
      // dieselbe Bruecke.
      case 'projekt-order':
        ui.set({ projektReihenfolge: Array.isArray(wert) ? (wert as string[]).map(String) : [] });
        modellSenden();
        break;
      case 'freigaben-entscheiden': {
        const w = wert as { path: string; action: 'approve' | 'reject'; reason: string };
        decideRequest(config.requestsDir, w.path, w.action, w.reason, config.wbDecideBin);
        freigabenAktualisieren();
        break;
      }
      case 'muster-entscheiden': {
        // `echt` traegt `isTrusted` aus dem Fenster -- nur ein wirklicher Klick
        // gibt frei. Ein `el.click()` traegt false und kommt damit nicht durch.
        const w = wert as { schluessel: string; action: 'approve' | 'reject'; reason: string; echt?: boolean };
        const erg = musterEntscheiden(String(w.schluessel ?? ''), w.action, String(w.reason ?? ''), w.echt === true);
        // Scheitert es, sagt das Fenster es (05.09.2026): die Leiste meldet
        // "erteilt", sobald der Knopf gedrueckt ist -- lief `wb-freigabe`
        // dann ins Leere, stand der Eintrag weiter da, und nirgends stand
        // warum. Der Grund steht schon im Verlauf; hier kommt er auf die Buehne.
        if (!erg.ok) melde(erg.output);
        break;
      }
      // DAS KONTEXTMENUE DER SITZUNG ALS BEDIENUNG (06.09.2026, Auftrag mac21).
      // Der Mac-Mantel baut sein Menue selbst (NSMenu) und loest den Punkt hier
      // aus -- derselbe `menuePunktAusfuehren` wie beim Popup der
      // Electron-Fassung und beim Steuerbefehl 'sitzung-menue-punkt', damit es
      // EINE Fassung jeder Handlung gibt. `echt` traegt, ob ein Mensch geklickt
      // hat; `bestaetigt` sagt, dass die Oberflaeche die Rueckfrage vor dem
      // Loeschen SELBST gestellt hat (NSAlert-Sheet im Mantel) -- dann fragt
      // der Kern nicht ein zweites Mal ueber seinen Electron-Dialog, der im
      // Mantelbetrieb an einem versteckten Fenster hinge.
      case 'sitzung-menue-punkt': {
        const w = (wert ?? {}) as { id?: unknown; punkt?: unknown; echt?: unknown; bestaetigt?: unknown };
        const id = String(w.id ?? '');
        const punkt = String(w.punkt ?? '');
        const echt = w.echt === true;
        const r = istChat(id)
          ? await chatMenuePunktAusfuehren(id, punkt, echt)
          : await menuePunktAusfuehren(id, punkt, echt, w.bestaetigt === true);
        process.stderr.write(`Bedienung 'sitzung-menue-punkt' ${punkt} auf ${id}: ok=${r.ok} ${r.meldung}\n`);
        melde(r.meldung);
        break;
      }
      case 'revive':
        try {
          sessionWiederherstellen(String(wert));
        } catch (e) {
          process.stderr.write(`revive abgelehnt: ${(e as Error).message}\n`);
        }
        break;
      case 'ordner-liste': {
        const antwort = ordnerLesen(String(wert ?? ''));
        anOberflaeche('awb:ordner', antwort);
        break;
      }
      case 'ordner-oeffnen': {
        await ordnerOeffnen(String(wert ?? '')).catch((err) =>
          process.stderr.write(`ordner-oeffnen abgelehnt: ${(err as Error).message}\n`),
        );
        break;
      }
      case 'aktivitaet-lesen': {
        anOberflaeche('awb:aktivitaet', { entries: aktivitaetLesen() });
        break;
      }
      // Der Inhalt eines Eintrags (V15/V18) braucht sofort eine Antwort, um
      // eine Kachel zu zeichnen -- das geht ueber die Bruecke
      // 'awb:aktivitaet-read'/'-diff'/'-auftrag' (invoke/handle weiter unten),
      // nicht ueber diesen Feuern-und-Vergessen-Kanal. Keine eigene Aktion
      // hier dafuer, dieselbe Ueberlegung wie beim Editor.
      case 'suche-lesen': {
        const w = wert as { query: string; pfad?: string };
        anOberflaeche('awb:suche', sucheLesen(String(w?.query ?? ''), String(w?.pfad ?? '')));
        break;
      }
      case 'seite': {
        // Schritt 7: eine der uebernommenen Seiten zeichnen. Die Daten kommen
        // aus demselben Sessionmodell wie die Leiste; das HTML aus den
        // Renderfunktionen der Extension, unveraendert.
        const name = String(wert ?? '') as SeitenName;
        if (name !== 'start' && name !== 'einstellungen') {
          process.stderr.write(`unbekannte Seite: ${name}\n`);
          break;
        }
        sessions = modellLesen();
        seiteOffen = name;
        anOberflaeche('awb:seite', { name });
        break;
      }
      // A9: das Einstellungsfenster. Die beiden Faelle unterscheiden sich in
      // GENAU einem Punkt -- ob show() erreicht wird. Welcher von beiden
      // ankommt, entscheidet `isTrusted` im Renderer, nicht dieser Prozess.
      case 'einstellungen-zeigen':
        await einstellungsfenster.zeigeNachEchtemKlick();
        break;
      case 'einstellungen-bauen':
        await einstellungsfenster.baue();
        break;
      // Das Sitzungsfenster hinter dem Plus. Dieselben zwei Faelle mit
      // demselben einen Unterschied wie oben -- ob show() erreicht wird,
      // entscheidet `isTrusted` im Renderer.
      case 'sitzung-zeigen':
        await sitzungsfenster.zeigeNachEchtemKlick();
        break;
      case 'sitzung-bauen':
        await sitzungsfenster.baue();
        break;
      // Die Verbrauchsseite hinter der Token-Anzeige. Dieselben zwei Faelle mit
      // demselben einen Unterschied -- ob show() erreicht wird, entscheidet
      // `isTrusted` im Renderer (fuss-status.ts), nicht dieser Prozess.
      case 'verbrauch-zeigen':
        await verbrauchsfenster.zeigeNachEchtemKlick();
        break;
      case 'verbrauch-bauen':
        await verbrauchsfenster.baue();
        break;
      // Der geführte erste Start (SPEC-V4 3.8), von Hand wieder aufgerufen. Dieselben zwei
      // Fälle mit demselben einen Unterschied wie oben -- ob show() erreicht wird, entscheidet
      // `isTrusted` im Renderer, nicht dieser Prozess. Das automatische Erscheinen beim ERSTEN
      // Start läuft NICHT über diesen Kanal, siehe app.whenReady() weiter unten.
      case 'erststart-zeigen':
        await erststartfenster.zeigeNachEchtemKlick();
        break;
      case 'erststart-bauen':
        await erststartfenster.baue();
        break;
      case 'seite-schliessen': {
        // Gegenstueck zu 'seite' oben: der Knopf im Fenster (seiten-view.ts,
        // schliesse()) meldet sich hier, weil der Hauptprozess sonst nur vom
        // Oeffnen erfaehrt -- 'refresh' und 'plan-ausfuehren' wuerden die
        // Seite sonst nach der naechsten Handlung wieder aufleben lassen.
        seiteOffen = '';
        break;
      }
      case 'seiten-nachricht': {
        // Was eine Seite ueber ihr `vscode.postMessage` schickt. Daraus wird
        // ein PLAN -- er beschreibt, was geschehen wird, und tut noch nichts.
        // Alles mit Nebenwirkung geht als Rueckfrage an die Oberflaeche; erst
        // eine ausdrueckliche Zustimmung fuehrt es aus.
        letzteSeitenNachricht = wert;
        const plan = plane((wert ?? {}) as Record<string, unknown>, befehlsUmgebung());
        letzterPlan = plan;
        process.stderr.write(`Seiten-Befehl '${plan.command}': ${plan.art}${plan.grund ? ` — ${plan.grund}` : ''}\n`);
        if (plan.art === 'sofort') await planSofort(plan);
        else anOberflaeche('awb:plan', plan);
        break;
      }
    case 'plan-ausfuehren': {
        // Die Zustimmung. Ausgefuehrt wird GENAU der Plan, der gezeigt wurde --
        // er wird nicht neu erzeugt, sonst koennte zwischen Frage und Antwort
        // etwas anderes daraus werden.
        if (!letzterPlan || letzterPlan.art !== 'bestaetigen') {
          process.stderr.write('plan-ausfuehren ohne offenen Plan — abgelehnt\n');
          break;
        }
        const ergebnis = await fuehreAus(letzterPlan, befehlsUmgebung());
        letzterAusgang = { plan: letzterPlan, ...ergebnis };
        process.stderr.write(`Plan '${letzterPlan.command}' ausgefuehrt: ok=${ergebnis.ok} ${ergebnis.ausgabe}\n`);
        anOberflaeche('awb:plan-ergebnis', letzterAusgang);
        // Danach steht die Welt anders da: Sessionmodell und Seite neu lesen.
        sessions = modellLesen();
        modellSenden();
        if (seiteOffen) anOberflaeche('awb:seite', { name: seiteOffen });
        letzterPlan = null;
        break;
      }
      case 'plan-abbrechen':
        letzterPlan = null;
        break;
      case 'ergebnis-oeffnen': {
        // Die Datei selbst, im Programm des Menschen. Nur Pfade, die der
        // Waechter selbst gemeldet hat -- der Renderer bestimmt hier nicht,
        // was geoeffnet wird.
        const pfad = String(wert ?? '');
        if (!gemeldeteErgebnisse.some((e) => e.path === pfad)) {
          process.stderr.write(`ergebnis-oeffnen abgelehnt (unbekannter Pfad): ${pfad}\n`);
          break;
        }
        await shell.openPath(pfad);
        break;
      }
      /**
       * DER MASCHINEN-SCHALTER IN DER STATUSLEISTE (05.09.2026).
       *
       * Anlass des Nutzers war Aufraeumen und Ressourcen sparen, und beides
       * passiert, waehrend er die Werkbank benutzt -- nicht, waehrend er in
       * den Einstellungen sitzt. Der Schalter steht deshalb auch dort, wo die
       * Maschine ohnehin genannt wird.
       *
       * Es ist derselbe Schalter, nicht ein zweiter: geschrieben wird
       * `remoteMachinesPausiert` ueber `einstellungSchreiben()`, also ueber
       * `wb-state settings set` -- genau der Weg, den die Seite „Maschinen"
       * geht. Zwei Bedienwege, eine Wahrheit.
       *
       * Eine Maschine, die gar nicht eingetragen ist, laesst sich hier nicht
       * pausieren: der Renderer bestimmt nicht, welche Namen in die
       * Einstellungsdatei geraten.
       */
      case 'maschine-laden': {
        const w = (wert ?? {}) as { maschine?: unknown; laden?: unknown };
        const name = String(w.maschine ?? '');
        const laden = w.laden === true;
        if (!name || name === config.machine) {
          process.stderr.write(`maschine-laden abgelehnt (kein Fernrechner): '${name}'\n`);
          break;
        }
        if (!maschinenliste(config.settingsFile).includes(name)) {
          process.stderr.write(`maschine-laden abgelehnt (nicht eingetragen): '${name}'\n`);
          break;
        }
        const bisher = maschinenPausiert(config.settingsFile);
        const neu = laden ? bisher.filter((x) => x !== name) : [...new Set([...bisher, name])];
        await einstellungSchreiben('remoteMachinesPausiert', neu);
        // Ohne diese Zeile zoege die Leiste erst mit dem naechsten Takt nach,
        // und der Schalter saehe fuer einen Augenblick unbewegt aus.
        modellSenden();
        break;
      }
      default:
        process.stderr.write(`unbekannte Bedienung: ${aktion}\n`);
    }
  })().catch((err) => process.stderr.write(`Bedienung fehlgeschlagen: ${(err as Error).message}\n`));
});

// --- Editor (Schritt 6, A3) -------------------------------------------------
//
// Anfrage/Antwort statt Feuern-und-Vergessen, deshalb ueber invoke/handle und
// nicht ueber den bestehenden 'awb:bedienung'-Kanal. Die eigentliche Arbeit
// steht in editor.ts; hier nur die Uebersetzung nach { ok, value|error }, das
// Format, das die Bruecke in preload.ts und editor-view.ts erwarten.
function editorFehler(e: unknown): { ok: false; error: string } {
  return { ok: false, error: (e as Error).message ?? String(e) };
}

ipc.handle('awb:editor-list-files', (_e, root: string) => {
  try {
    return { ok: true, value: listFiles(root) };
  } catch (e) {
    return editorFehler(e);
  }
});

ipc.handle('awb:editor-read-file', (_e, root: string, rel: string) => {
  try {
    return { ok: true, value: readFileSafe(root, rel) };
  } catch (e) {
    return editorFehler(e);
  }
});

ipc.handle('awb:editor-write-file', (_e, root: string, rel: string, content: string) => {
  try {
    return { ok: true, value: writeFileSafe(root, rel, content) };
  } catch (e) {
    return editorFehler(e);
  }
});

/**
 * WELCHE DATEIEN DER EDITOR OFFEN HAT (06.09.2026, Auftrag 3.4). Die
 * Oberflaeche schickt die vollstaendige Liste bei jeder Aenderung; der Kern
 * beobachtet genau diese Dateien und meldet eine Aenderung von aussen ueber
 * denselben Kanal wie die Seiten (`awb:datei-geaendert`, hier mit
 * `name: 'editor'` und dem Pfad). Ob daraus ein Hinweis wird oder still neu
 * geladen wird, entscheidet die Oberflaeche.
 */
ipc.on('awb:editor-watch', (_e, root: unknown, pfade: unknown) => {
  const liste = Array.isArray(pfade) ? pfade.map((p) => String(p)) : [];
  if (!editorWaechter) {
    editorWaechter = startEditorWaechter((abs) => anOberflaeche('awb:datei-geaendert', { name: 'editor', pfad: abs }));
  }
  editorWaechter.setzen(String(root ?? ''), liste);
});

ipc.handle('awb:editor-send-selection', async (_e, paneId: string, text: string) => {
  try {
    await sendSelectionToOrchestrator(config.tmuxSocket, paneId, text);
    return { ok: true, value: { sent: true } };
  } catch (e) {
    return editorFehler(e);
  }
});

// --- Aktivitaet: Inhalt, Diff, Auftrag (V15/V18, Schritt 9) -----------------
//
// Dieselbe Bauart wie der Editor oben: Anfrage/Antwort statt Feuern-und-
// Vergessen, weil ein Klick sofort etwas zum Zeichnen braucht. Die Pruefung
// (der Pfad muss aus der zuletzt gelesenen Aktivitaet stammen) steckt in den
// drei Funktionen selbst -- hier nur die Uebersetzung nach { ok, value|error }.

ipc.handle('awb:aktivitaet-read', (_e, pfad: string) => {
  try {
    return { ok: true, value: aktivitaetOeffnen(pfad) };
  } catch (e) {
    return editorFehler(e);
  }
});

ipc.handle('awb:aktivitaet-diff', (_e, pfad: string) => {
  try {
    return { ok: true, value: aktivitaetDiffLesen(pfad) };
  } catch (e) {
    return editorFehler(e);
  }
});

ipc.handle('awb:aktivitaet-auftrag', (_e, pfad: string) => {
  try {
    return { ok: true, value: aktivitaetAuftragLesen(pfad) };
  } catch (e) {
    return editorFehler(e);
  }
});

// --- Protokolle (V16, Schritt 9) --------------------------------------------

ipc.handle('awb:protokolle-list', () => {
  try {
    return { ok: true, value: protokollListe(config.settingsFile) };
  } catch (e) {
    return editorFehler(e);
  }
});

// --- Chat-Ansicht (SPEC-V4 Abschnitt 6) --------------------------------------
//
// Der Renderer FRAGT, statt dass der Hauptprozess bei jedem Takt fuer jeden Pane
// eine Datei liest: gelesen wird nur, was gerade jemand ansieht.
//
// DER ZAEHLER (22.08.), NUR FUER 'pane-chat-takt': wie oft dieser Griff je
// Pane WIRKLICH gefragt hat -- der Beleg, dass `zeigen(false)`
// (chat/anbindung.ts) den Takt tatsaechlich stoppt, gemessen an echten
// IPC-Ankuenften und nicht am Code geschlossen.
const chatStandZaehler = new Map<string, number>();
ipc.handle('awb:chat-stand', async (_e, paneId: string) => {
  try {
    chatStandZaehler.set(paneId, (chatStandZaehler.get(paneId) ?? 0) + 1);
    const anfrage = anfrageFuerPane(paneId, sessions, config.tmuxSocket);
    if (!anfrage) return { ok: false, error: `Zu ${paneId} ist keine laufende Sitzung bekannt.` };
    const stand = await chatStand(anfrage, {
      modelsFile: config.modelsFile,
      settingsFile: config.settingsFile,
      // NUR DER ORCHESTRATOR-PANE (12.08.): der Rechtsklick gilt der Sitzung,
      // und die Sitzung ist ihr Orchestrator. Worker-Panes folgen der
      // Worker-Vorgabe aus den Einstellungen und bekommen deshalb kein
      // Uebersteuern mitgereicht.
      uebersteuerung: anfrage.rolle === 'orchestrator' ? ui.chatUebersteuerung(anfrage.sitzung) : null,
    });
    // sprache() haengt hier an, nicht in chatquelle.ts: die vielen internen Konstruktionen
    // eines ChatStand dort (leererStand, ausOpencode, ausJcode, ...) muessen sie sonst alle
    // kennen, fuer ein Feld, das nur der Grenzuebergang zum Renderer braucht.
    return { ok: true, value: { ...stand, sprache: sprache(config.settingsFile) } };
  } catch (e) {
    return editorFehler(e);
  }
});

/**
 * DER GRIFF AN EINEM PANE UND DIE ANSICHT SELBST WOLLEN DASSELBE SAGEN KOENNEN
 * WIE DER RECHTSKLICK (22.08.): "zeig mir das Gespraech" / "zeig mir das
 * Terminal", jederzeit und verlaesslich (Wortlaut des Nutzers: "ich will, dass
 * man das jederzeit wechseln kann"). Bis heute war der Griff rein oertlich --
 * ein Klick blendete die Ansicht im Renderer ein, ohne je nach ui.json zu
 * schreiben. Stand dort schon eine Sitzungs-Uebersteuerung auf `false` (vom
 * Rechtsklick, oder aus einem frueheren Klick auf "Terminal zeigen" in der
 * Ansicht selbst), blieb sie stehen: der naechste `chat-stand`-Aufruf verweigerte
 * den Zugriff trotz des gerade erst erfolgten Klicks, und die Ansicht zeigte
 * den Grund statt des Gespraechs -- ein Knopf, der etwas verspricht und dann
 * nicht haelt.
 *
 * NUR DER ORCHESTRATOR-PANE schreibt die Uebersteuerung, aus demselben Grund
 * wie oben bei `chat-stand`: sie gilt der Sitzung, und die Sitzung ist ihr
 * Orchestrator. Ein Klick an einem Worker-Pane bleibt lokal (er bekommt seine
 * Antwort ueber den naechsten `chat-stand`); er kann sie nicht erzwingen, das
 * ist keine Regression -- das konnte er vorher auch nicht.
 */
ipc.handle('awb:chat-ansicht-setzen', (_e, paneId: string, an: boolean) => {
  try {
    const anfrage = anfrageFuerPane(paneId, sessions, config.tmuxSocket);
    if (!anfrage) return { ok: false, error: `Zu ${paneId} ist keine laufende Sitzung bekannt.` };
    if (anfrage.rolle === 'orchestrator') ui.chatUebersteuerungSetzen(anfrage.sitzung, an);
    return { ok: true, value: { gesetzt: anfrage.rolle === 'orchestrator' } };
  } catch (e) {
    return editorFehler(e);
  }
});

/**
 * PFADE IM CHAT, ANKLICKBAR (Auftrag chatdatei, 05.09.2026). Der Renderer
 * schickt je Nachricht EINE Liste von Kandidaten; geprueft wird mit `fs.stat`
 * gegen das Arbeitsverzeichnis der Sitzung und gegen `~` (main/chatpfade.ts).
 * `paneId` nennt einen Pane der Lese-Ansicht; ist er leer, gilt die
 * Chat-Sitzung auf der Buehne. Was gefunden wurde, merkt sich dieser Prozess:
 * nur ein gemerkter Pfad laesst sich danach oeffnen -- der Renderer bestimmt
 * nicht, welche Datei gelesen wird (dieselbe Regel wie bei Aktivitaet und
 * Ergebnissen oben).
 */
const chatPfadeGemerkt = new Set<string>();
function chatPfadWurzel(e: Electron.IpcMainInvokeEvent, paneId: string): string {
  if (paneId) {
    const anfrage = anfrageFuerPane(paneId, sessions, config.tmuxSocket);
    const s = anfrage ? sessions.find((x) => x.id === anfrage.sitzung) : null;
    if (s?.dir) return s.dir;
  } else {
    const id = chatIdVon(e);
    const eintrag = id ? chatRegistry.einer(id) : null;
    if (eintrag?.ordner) return eintrag.ordner;
  }
  return ordnerWurzel();
}
ipc.handle('awb:chat-pfade', (e, paneId: string, kandidaten: unknown) => {
  try {
    if (!vomHauptfenster(e)) return { ok: true, value: [] };
    const liste = Array.isArray(kandidaten) ? kandidaten.filter((k): k is string => typeof k === 'string').slice(0, 200) : [];
    const cwd = chatPfadWurzel(e, String(paneId ?? ''));
    const treffer = pfadeAufloesen(liste, cwd, homedir())
      .filter((t) => !isExcluded(t.abs, config.excludeGlobs));
    for (const t of treffer) chatPfadeGemerkt.add(t.abs);
    return { ok: true, value: treffer };
  } catch (err) {
    return editorFehler(err);
  }
});
ipc.handle('awb:chat-pfad-oeffnen', async (e, abs: string) => {
  try {
    const pfad = String(abs ?? '');
    if (!vomHauptfenster(e) || !chatPfadeGemerkt.has(pfad)) {
      throw new Error(`Pfad wurde nicht als Chat-Treffer gemeldet: ${pfad}`);
    }
    const o = oeffnungBestimmen(pfad);
    // Bilder, PDFs und alles Binaere gehen an das System -- hier, nicht im
    // Renderer, der kein `shell` hat.
    if (o.art === 'extern') await shell.openPath(pfad);
    return { ok: true, value: o };
  } catch (err) {
    return editorFehler(err);
  }
});

ipc.handle('awb:protokolle-read', (_e, pfad: string) => {
  try {
    return { ok: true, value: protokollLesen(pfad, config.settingsFile) };
  } catch (e) {
    return editorFehler(e);
  }
});

// --- Einstellungsfenster (A9) ------------------------------------------------
//
// Zwei Bedienungen vom Hauptfenster hierher, und der Unterschied zwischen ihnen
// ist die ganze Sicherung (siehe die Faelle 'einstellungen-zeigen' und
// 'einstellungen-bauen' im Bedienungs-Kanal weiter oben):
//
//   'einstellungen-zeigen'  -- der Renderer schickt ihn NUR, wenn das
//                              Klick-Ereignis `isTrusted` traegt, also von
//                              einem echten Zeigegeraet stammt. Nur dieser Weg
//                              fuehrt zu show().
//   'einstellungen-bauen'   -- alles andere: ein `el.click()` aus einem Test,
//                              aus `awb-ctl klick einstellungen`, aus einem
//                              Skript. Baut und laedt das Fenster, zeigt es
//                              NICHT.
//
// Ein Test bekommt damit alles, was er braucht (das Fenster steht, ist lesbar
// und fotografierbar) und genau das nicht, was ihm nicht zusteht: des Nutzers
// Bildschirm.

/** Wann das Fenster mit seinem ersten Zeichnen fertig war -- fuer den Steuerkanal. */
let einstellungenBereit = false;
ipc.on('awb:ein-bereit', () => {
  einstellungenBereit = true;
});

function einstellungenDatenJetzt(): unknown {
  return einstellungsDaten(
    {
      settingsFile: config.settingsFile,
      configFile: config.configFile,
      modelsFile: config.modelsFile,
      machine: config.machine,
      stateDir: config.stateDir,
      controlSocket: config.controlSocket,
      wbStateBin: befehlsUmgebung().wbStateBin,
    },
    ui.get(),
  );
}

/**
 * Der Pruefknopf der Maschinen-Seite. Er tut GENAU EINEN Handgriff -- `ssh
 * <alias> true` mit Zeitlimit -- und sagt, ob er durchkam. Kein Netzzugriff
 * von selbst: dieser Weg entsteht nur, wenn jemand auf den Knopf drueckt.
 * BatchMode verhindert, dass eine Passwortfrage das Fenster stehen laesst,
 * denn eine Frage, die niemand sieht, ist ein Haenger.
 */
function maschinePruefen(name: string): Promise<{ ok: boolean; ausgabe: string }> {
  return new Promise((fertig) => {
    const p = spawn('ssh', [
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${Math.max(1, Math.round(config.remoteTimeoutMs / 1000))}`,
      name, 'true',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let fehler = '';
    p.stderr.on('data', (b: Buffer) => { fehler += b.toString(); });
    const zeit = setTimeout(() => p.kill('SIGKILL'), config.remoteTimeoutMs + 2000);
    p.on('error', (e) => {
      clearTimeout(zeit);
      fertig({ ok: false, ausgabe: String(e) });
    });
    p.on('close', (code) => {
      clearTimeout(zeit);
      const kurz = fehler.trim().split('\n').pop() ?? '';
      fertig({ ok: code === 0, ausgabe: code === 0 ? 'erreichbar' : (kurz || `ssh endete mit ${code}`) });
    });
  });
}

ipc.handle('awb:ein-daten', () => einstellungenDatenJetzt());

/**
 * DIE TEXTTABELLE DES EINSTELLUNGSFENSTERS, EINMAL FUER BEIDE OBERFLAECHEN
 * (Auftrag 2.6, 06.09.2026). Die Electron-Fassung importiert `texte.ts` direkt
 * in ihren Renderer; der Mac-Mantel kann das nicht und darf keine zweite Kopie
 * der 1100 Schluessel fuehren -- zwei Tabellen laufen eines Tages auseinander.
 * Also liefert der Kern die Tabelle der eingestellten Sprache, ueber Deutsch
 * gelegt (derselbe Rueckfall wie `t()` in texte.ts), als EIN Kanal. Der Mantel
 * setzt Platzhalter selbst ein, mit derselben Regel: `{name}` bleibt stehen,
 * wenn der Wert fehlt.
 */
ipc.handle('awb:ein-texte', () => {
  const s = sprache(config.settingsFile);
  return { sprache: s, tabelle: { ...TEXTE_DE, ...(s === 'en' ? TEXTE_EN : {}) } };
});

/**
 * DIE KONTEXTSTUFEN EINES LOKALEN MODELLS -- ein Kanal fuer ZWEI Fenster
 * (Einstellungen und Erststart), weil beide dieselbe Frage stellen.
 *
 * WARUM NICHT IN `einstellungenDatenJetzt()`. Die Frage haengt am GEWAEHLTEN
 * Modell, und lokal sind heute 220 der 266 Orchestrator-Modelle -- sie alle
 * vorab zu messen waeren 220 Aufrufe fuer eine Zahl, die nur eine einzige
 * Zeile braucht. Im Erststart kommt dazu, dass die Wahl im Fenster selbst
 * umspringt: dort gibt es die Antwort erst, wenn jemand geklickt hat.
 *
 * Der Aufruf misst den FREIEN Speicher und ist deshalb nicht auf Vorrat
 * haltbar -- wer ihn stellt, will den Stand von jetzt. Er wird darum bei jedem
 * neuen Datenstand des Fensters wiederholt und sonst nicht.
 */
const wbKontextBin = process.env.AWB_WB_KONTEXT ?? 'wb-kontext';
ipc.handle('awb:kontext-stufen', (_e, modellId: string) =>
  kontextStufen(wbKontextBin, String(modellId ?? '')));

/**
 * DER SCHREIBWEG DES FENSTERS -- und es ist derselbe wie ueberall sonst:
 * `plane()` erzeugt den Aufruf, `fuehreAus()` fuehrt ihn aus, also
 * `wb-state settings set`. Der Umweg ueber die Rueckfrage entfaellt hier
 * bewusst: In diesem Fenster IST der Weg die Zustimmung -- ein Mensch hat es
 * geoeffnet, die Seite gewaehlt und den Schalter umgelegt, und eine Rueckfrage
 * je Haken machte es unbenutzbar. Was geschehen IST, steht danach wortwoertlich
 * in der Fusszeile, samt Aufruf. Der eine Schalter, der trotzdem fragt
 * (contextGuardAutostart), fragt im Fenster selbst, vor dem Absenden.
 */
/**
 * Der Schreibvorgang selbst, EINMAL. Seit dem 05.09. hat die Einstellung
 * `remoteMachinesPausiert` zwei Bedienwege -- die Seite „Maschinen" und das
 * Aufklappfeld in der Statusleiste --, und zwei Wege duerfen nicht zwei
 * Schreibvorgaenge heissen: sonst laufen sie eines Tages auseinander. Beide
 * rufen diese Funktion, sie ruft `plane()`/`fuehreAus()`, und danach ziehen
 * dieselben Fenster nach.
 */
async function einstellungSchreiben(
  key: string, value: unknown,
): Promise<{ ok: boolean; ausgabe: string; aufruf: string }> {
  const plan = plane({ command: 'set', key, value }, befehlsUmgebung());
  const aufruf = (plan.aufruf ?? []).join(' ');
  if (plan.art !== 'bestaetigen') {
    return { ok: false, ausgabe: plan.grund ?? `abgelehnt (${plan.art})`, aufruf };
  }
  const ergebnis = await fuehreAus(plan, befehlsUmgebung());
  process.stderr.write(`Einstellung '${key}': ok=${ergebnis.ok} ${ergebnis.ausgabe}\n`);
  // Die offene Seite im Hauptfenster zieht nach, falls sie dieselbe Datei zeigt.
  if (seiteOffen) anOberflaeche('awb:seite', { name: seiteOffen });
  anFenster(einstellungsfenster.aktuell(), 'awb:ein-daten-neu', () => einstellungenDatenJetzt());
  return { ...ergebnis, aufruf };
}

ipc.handle('awb:ein-setzen', (_e, key: string, value: unknown) => einstellungSchreiben(key, value));

/**
 * showStopped (A12) und sort (A16) liegen NICHT in settings.json, sondern im
 * Zustand der Oberflaeche (uistate.ts) -- sie gehoeren diesem Programm, nicht
 * den wb-Werkzeugen. Deshalb ein eigener, kurzer Weg statt `wb-state`; die
 * Wirkung ist dieselbe wie bei `awb-ctl set-ui`, und die Sessionleiste zieht
 * sofort nach.
 */
/**
 * Der zweite Schreibweg des Fensters -- und auch er fuehrt ueber `wb-state`,
 * nur ueber andere Unterbefehle. Guard, Wache und Deckel gehen NICHT ueber
 * `settings set`: sie tragen Grund, Datum und Rolle, und wer eine Sicherung
 * lockert, muss ein Mensch sein. Beides prueft `wb-state`, nicht dieses
 * Fenster; hier wird nur der Aufruf gebaut und ausgefuehrt.
 */
ipc.handle('awb:ein-werkzeug', async (_e, nachricht: Record<string, unknown>, echt: boolean) => {
  const plan = plane(nachricht, befehlsUmgebung());
  const aufruf = (plan.aufruf ?? []).join(' ');
  if (plan.art !== 'bestaetigen') {
    return { ok: false, ausgabe: plan.grund ?? `abgelehnt (${plan.art})`, aufruf };
  }
  // `echt` kommt aus `isTrusted` im Fenster und wird hier NICHT nachgebessert:
  // was ohne echten Klick hereinkommt, laeuft ohne Menschen-Merkmal, und
  // `wb-state` weist es mit seiner eigenen Meldung ab.
  const ergebnis = await fuehreAus(plan, befehlsUmgebung(), echt === true);
  process.stderr.write(
    `Werkzeug '${String(nachricht.command ?? '')}' (echter Klick: ${echt === true}): `
    + `ok=${ergebnis.ok} ${ergebnis.ausgabe}\n`,
  );
  anFenster(einstellungsfenster.aktuell(), 'awb:ein-daten-neu', () => einstellungenDatenJetzt());
  return { ...ergebnis, aufruf };
});

ipc.handle('awb:ein-maschine-pruefen', async (_e, name: string) => {
  const ziel = String(name ?? '').trim();
  if (!ziel) return { ok: false, ausgabe: 'kein Name' };
  const r = await maschinePruefen(ziel);
  process.stderr.write(`Maschine '${ziel}' geprueft: ok=${r.ok} ${r.ausgabe}\n`);
  return r;
});

ipc.handle('awb:ein-ui', (_e, key: string, value: unknown) => {
  if (key === 'showStopped') ui.set({ showStopped: value === true });
  else if (key === 'sort' && (value === 'recent' || value === 'folder' || value === 'name')) ui.set({ sort: value });
  else return { ok: false };
  sessions = modellLesen();
  modellSenden();
  anFenster(einstellungsfenster.aktuell(), 'awb:ein-daten-neu', () => einstellungenDatenJetzt());
  return { ok: true };
});

/**
 * Der Schluesselbund-Kanal (A9, 11.08. -- siehe main/schluesselbund.ts). Der
 * Dienstname kommt aus der Registry, nie vom Renderer; der WERT geht in
 * `ein-schluessel-setzen` nur HIN, in keine Richtung zurueck, und in kein
 * Protokoll -- die Zeile unten nennt bewusst nur die Anbieter-ID.
 */
function registryRohGelesen(): string | undefined {
  try {
    return readFileSync(config.modelsFile, 'utf8');
  } catch {
    return undefined;
  }
}

ipc.handle('awb:ein-schluessel-status', () => schluesselStatusAlle(registryRohGelesen()));

ipc.handle('awb:ein-schluessel-setzen', (_e, providerId: unknown, wert: unknown) => {
  const id = String(providerId ?? '');
  const ok = schluesselSetzenFuerAnbieter(registryRohGelesen(), id, String(wert ?? ''));
  process.stderr.write(`Schluessel '${id}': ok=${ok}\n`);
  return { ok };
});

/** Der Testknopf 'Test senden' (12.08., siehe main/melden.ts) -- EINE echte Probe, Rueckmeldung je Weg. */
ipc.handle('awb:ein-meldung-testen', () => (
  meldenTesten(meldungsEinstellungen(config.settingsFile), STANDARD_TEST_WEGE)
));

// --- Sitzungsfenster ---------------------------------------------------------
//
// Zwei Bedienungen vom Hauptfenster hierher ('sitzung-zeigen'/'sitzung-bauen',
// siehe den Bedienungs-Kanal weiter oben), und genau wie beim
// Einstellungsfenster liegt in ihrem Unterschied die ganze Sicherung.
//
// Was das Fenster AUSLOEST, tun die vorhandenen Funktionen: `sessionAnlegen`
// (wb-code) und `sessionWiederherstellen` (wb-code --resume). Beide pruefen
// gegen den JEWEILS AKTUELLEN Sessionstand und nicht gegen das, was das Fenster
// im Klickmoment zeigte -- deshalb wird hier nichts vorgeprueft und nichts
// zwischengespeichert.

/** Wann das Sitzungsfenster mit seinem ersten Zeichnen fertig war -- fuer den Steuerkanal. */
let sitzungBereit = false;
ipc.on('awb:sitz-bereit', () => {
  sitzungBereit = true;
});

/**
 * Der genaue Grund, warum die Sitzungen einer Maschine gerade nicht einsehbar
 * sind -- leer, wenn es keinen genaueren gibt als „sie antwortet nicht"
 * (07.08.). Zwei Quellen, beide schon vorhanden: fuer die eigene Maschine der
 * tmux-Befund dieses Programms, fuer eine Fernmaschine der Format-Befund ihres
 * letzten Abrufs.
 */
function grundFuerMaschine(machine: string): string {
  if (machine === config.machine) return tmuxBefund.fehler;
  return remotePoller.snapshots().find((s) => s.machine === machine)?.formatFehler ?? '';
}

function sitzungsDatenJetzt(): SitzungsDaten {
  sessions = modellLesen();
  return {
    machine: config.machine,
    remoteMachines: config.remoteMachines,
    sprache: sprache(config.settingsFile),
    // ALLE bekannten Sitzungen, nicht `sichtbare()`: der Haken fuer beendete
    // Sitzungen (A12) gehoert der Leiste. Ein Fenster, das gerade die
    // beendeten fortsetzen soll, darf sie nicht wegen einer Einstellung der
    // Leiste verschweigen. Gruppiert nach Ordner wird in der Oberflaeche --
    // hier bleibt die Liste flach, damit es nur EINE Vorstellung davon gibt,
    // was eine Sitzung ist (readSessions).
    sitzungen: sitzungsZeilen(
      sessions,
      // Derselbe Satz wie an der Leiste, samt der Warnung vor der Rueckfrage
      // der CLI -- siehe `fortsetzenGrund`.
      (s) => {
        const v = reviveCommand(s, config.machine, config.wbCodeBin, harnessResume(s.harness), false, reviveKennung(s));
        return { ...v, conversationReason: fortsetzenGrund(s, v) };
      },
      grundFuerMaschine,
    ),
  };
}

/** Das Fenster nachziehen lassen -- nach jeder Handlung, die die Lage aendert. */
function sitzungsfensterAuffrischen(): void {
  anFenster(sitzungsfenster.aktuell(), 'awb:sitz-daten-neu', () => sitzungsDatenJetzt());
}

/**
 * Die System-Akzentfarbe, frisch gelesen -- `getAccentColor()` gibt es erst ab
 * macOS 10.14 und nur unter Electrons `SystemPreferences`; auf jeder anderen
 * Plattform (oder wenn der Aufruf selbst wirft) bleibt das Feld leer, statt
 * das Fenster daran scheitern zu lassen. Nur BEREITGESTELLT hier -- verwendet
 * wird sie vom Worker 'farbsystem'.
 */
function systemAkzentfarbeLesen(): string {
  if (process.platform !== 'darwin') return '';
  try {
    return systemPreferences.getAccentColor() || '';
  } catch {
    return '';
  }
}

/**
 * Thema und Zustandsfarben an JEDES offene Fenster ausser dem
 * Einstellungsfenster senden -- dasselbe Muster wie `sitzungsfensterAuffrischen`
 * darueber, nur fuer vier Fenster auf einmal. Aufgerufen wird sie von zwei
 * Stellen: wenn sich die Einstellungsdatei von aussen aendert (derselbe
 * Dateiwaechter, der auch das Einstellungsfenster und die Startseite nachzieht),
 * und wenn `nativeTheme` ein 'updated' meldet -- ein System-Themawechsel schreibt
 * keine Einstellungsdatei, deshalb der zweite Weg.
 */
function themaSenden(): void {
  const daten = themaPayload(nativeTheme.shouldUseDarkColors, config.settingsFile, systemAkzentfarbeLesen());
  for (const w of [win, sitzungsfenster.aktuell(), verbrauchsfenster.aktuell(), erststartfenster.aktuell()]) {
    if (w && !w.isDestroyed()) w.webContents.send('awb:thema-neu', daten);
  }
  mantel?.push('awb:thema-neu', daten);
}
nativeTheme.on('updated', themaSenden);

/**
 * Nach einem Start braucht `wb-code` einen Augenblick, bis Zustandsdatei und
 * Pane stehen. Zweimal nachlesen deckt beides ab, ohne auf den
 * Zwei-Sekunden-Takt zu warten -- die Leiste UND das Fenster ziehen nach.
 */
function nachStartNachlesen(): void {
  for (const ms of [1200, 3000]) {
    setTimeout(() => {
      sessions = modellLesen();
      modellSenden();
      sitzungsfensterAuffrischen();
    }, ms);
  }
}

ipc.handle('awb:sitz-daten', () => sitzungsDatenJetzt());

/**
 * Die Beschriftungen des Sitzungsfensters in der eingestellten Sprache --
 * dieselbe Bauart wie `awb:ein-texte`: der Mantel (Mac, Auftrag 2.7) fuehrt
 * keine zweite Kopie von `sitzung/texte.ts`, Deutsch als Grundlage, Englisch
 * darueber gelegt.
 */
ipc.handle('awb:sitz-texte', () => {
  const s = sprache(config.settingsFile);
  return { sprache: s, tabelle: { ...SITZ_TEXTE_DE, ...(s === 'en' ? SITZ_TEXTE_EN : {}) } };
});

// Thema und Zustandsfarben, fuer jedes Fenster ausser dem Einstellungsfenster
// (das hat seine eigene Anwendung, siehe thema.ts Kopf). `nativeTheme` wird bei
// JEDER Anfrage frisch gelesen -- kein Rateversuch beim Start.
ipc.handle('awb:thema-daten', () => themaPayload(
  nativeTheme.shouldUseDarkColors, config.settingsFile, systemAkzentfarbeLesen(),
));

// --- Verbrauchsseite ---------------------------------------------------------
//
// Ein einziger Weg hinaus, und er liest nur: `wb-budget --json`. Gerechnet wird
// dort, gezeichnet im Fenster -- dieser Prozess reicht durch. Die Frage kommt aus
// dem Fenster und wird in verbrauchsfenster.ts zu einer ARGUMENTLISTE, nie zu
// einer Befehlszeile.
// Dieselbe SPUR wie beim Bauen und Zeigen des Fensters: wer auf die Token-Anzeige
// drueckt und nichts sieht, liest an den Zeilen mit dem Praefix `Verbrauchsfenster:`
// ab, wie weit es gekommen ist -- bis hierher heisst, die Seite hat gezeichnet.
ipc.on('awb:verbrauch-bereit', () => {
  process.stderr.write('Verbrauchsfenster: erstes Zeichnen fertig\n');
});
ipc.handle('awb:verbrauch-daten', (_e, frage: VerbrauchsFrage) =>
  verbrauchLesen(frage ?? {}, { bin: config.budgetBin }),
);
/**
 * Die Beschriftungen der Verbrauchsseite -- dieselbe Bauart wie `awb:ein-texte`
 * und `awb:sitz-texte`: der Mantel (Mac, Auftrag 3.8) fuehrt keine zweite Kopie
 * von `verbrauch/texte.ts`, Deutsch als Grundlage, Englisch darueber gelegt.
 */
ipc.handle('awb:verbrauch-texte', () => {
  const s = sprache(config.settingsFile);
  return { sprache: s, tabelle: { ...VERB_TEXTE_DE, ...(s === 'en' ? VERB_TEXTE_EN : {}) } };
});
// Dieselbe Sprache wie im Einstellungsfenster (daten.sprache dort) -- fuer Fenster, die keinen
// eigenen Datenabruf mit der Einstellungstabelle teilen. Ein einziger geteilter Kanal statt
// eines je Fenster.
ipc.handle('awb:sprache', () => sprache(config.settingsFile));

// --- Erststart (SPEC-V4 3.8) -------------------------------------------------
//
// Kein zweiter Weg zur Registry: eine reine Projektion von `einstellungenDatenJetzt()` (dieselbe
// Funktion, die auch das Einstellungsfenster fuellt -- Anmeldung, Maschinenliste, Modelle, alles
// bereits gemessen). Geschrieben wird ueber denselben Weg wie dort: `plane()`/`fuehreAus()`, also
// `wb-state settings set`.
ipc.handle('awb:erststart-daten', () => {
  const d = einstellungenDatenJetzt() as EinstellungsDaten;
  return {
    machine: d.machine,
    maschinen: d.maschinen,
    sprache: d.sprache,
    // Ob der Weg schon einmal zu Ende gegangen wurde. Der Kern zeigt sein
    // eigenes Fenster danach nie wieder von selbst (`zeigeAutomatisch`); der
    // Mantel (Mac, 3.8) braucht dieselbe Auskunft fuer sein Sheet und soll sie
    // nicht aus einer zweiten Quelle raten.
    erledigt: erststartErledigt(config.settingsFile),
    harnesses: d.harnesses.map((h) => ({ id: h.id, label: h.label, startbar: h.binaer })),
    // `lokal` faehrt mit, weil der dritte Schritt danach entscheidet, ob unter
    // der Modellwahl das Feld "Kontextfenster" erscheint. Die Stufen selbst
    // kommen erst auf Klick ueber `awb:kontext-stufen` -- siehe dort.
    orchestratorModelle: d.orchestratorModelle.map((m) => ({
      id: m.id, label: m.label, harness: m.harness, lokal: m.lokal,
    })),
    anmeldung: d.anmeldung,
    settings: {
      defaultWorkerMachine: String(d.settings.defaultWorkerMachine ?? ''),
      orchestratorHarness: String(d.settings.orchestratorHarness ?? ''),
      orchestratorModel: String(d.settings.orchestratorModel ?? ''),
    },
    vorgaben: {
      defaultWorkerMachine: String(d.vorgaben.defaultWorkerMachine ?? ''),
      orchestratorHarness: String(d.vorgaben.orchestratorHarness ?? ''),
      orchestratorModel: String(d.vorgaben.orchestratorModel ?? ''),
    },
  };
});

ipc.handle('awb:erststart-setzen', async (_e, key: string, value: unknown) => {
  const plan = plane({ command: 'set', key, value }, befehlsUmgebung());
  if (plan.art !== 'bestaetigen') return { ok: false, ausgabe: plan.grund ?? `abgelehnt (${plan.art})` };
  const ergebnis = await fuehreAus(plan, befehlsUmgebung());
  process.stderr.write(`Erststart '${key}': ok=${ergebnis.ok} ${ergebnis.ausgabe}\n`);
  return ergebnis;
});

ipc.on('awb:erststart-bereit', () => {
  process.stderr.write('Erststartfenster: erstes Zeichnen fertig\n');
});

/**
 * Die Beschriftungen des ersten Starts -- dieselbe Bauart wie `awb:ein-texte`
 * und `awb:sitz-texte`: der Mantel (Mac, Auftrag 3.8) fuehrt keine zweite Kopie
 * von `erststart/texte.ts`, Deutsch als Grundlage, Englisch darueber gelegt.
 */
ipc.handle('awb:erststart-texte', () => {
  const s = sprache(config.settingsFile);
  return { sprache: s, tabelle: { ...ERST_TEXTE_DE, ...(s === 'en' ? ERST_TEXTE_EN : {}) } };
});

// --- Das Kontextmenue an der Sessionleiste -----------------------------------
//
// Ein Rechtsklick auf ein Sitzungssymbol in der linken Leiste des HAUPTfensters.
//
// DREI SACHEN ENTSCHEIDEN SICH HIER, und jede hat schon einmal ein solches
// Menue kaputtgemacht:
//
//   1. ES GILT DER SITZUNG UNTER DEM ZEIGER, nicht der gewaehlten. Der Renderer
//      schickt die Kennung der Zeile mit, auf der das Ereignis entstand; hier
//      wird nichts aus `gewaehlte()` geraten. Wer rechts klickt, meint das, was
//      unter seinem Zeiger liegt.
//   2. JEDER EINTRAG RUFT EIN `wb-*`-WERKZEUG. Was ein Eintrag ausfuehren darf,
//      steht in `befehle.ts` (`plane`) und nirgends sonst -- dieselbe Stelle,
//      an der auch die Seiten und das Einstellungsfenster haengen.
//   3. DAS MENUE SELBST HAENGT AN EINEM ECHTEN KLICK. `Menu.popup` bringt eine
//      Flaeche auf den Bildschirm; ein Steuerbefehl darf das nicht. Der
//      Renderer schickt `isTrusted` mit, und nur damit wird aufgeklappt. Der
//      Steuerkanal bekommt statt dessen die VORLAGE zu lesen und darf einen
//      Punkt ausloesen -- damit ist alles pruefbar ausser dem Aufklappen selbst.

/** Ein Eintrag des Menues, so wie ihn beide Wege sehen: Popup und Steuerkanal. */
interface MenuePunkt {
  id: string;
  label: string;
  /**
   * Immer true (alice, 06.08.: „ich will sie aber immer benutzen können,
   * sie sollen immer verfügbar sein"). Das Feld bleibt, weil beide Wege es
   * lesen und eine Pruefung es nachweisen koennen soll.
   */
  enabled: boolean;
  /** Leer. Ein Grund entsteht erst, wenn ein Griff wirklich fehlschlaegt. */
  grund: string;
  /** Fragt dieser Punkt vorher nach? Nur das Loeschen tut das. */
  rueckfrage: boolean;
}

/**
 * WIE DIE CHAT-ANSICHT FUER EINE SITZUNG GERADE STEHT -- die drei Ebenen aus
 * chat/ansichtsregel.ts, hier fuer den Orchestrator-Pane dieser Sitzung
 * zusammengetragen.
 *
 * REICHWEITE (12.08., ausdruecklich): der Rechtsklick gilt der SITZUNG, und
 * das heisst ihrem Orchestrator-Pane. Worker-Panes folgen weiter der
 * Worker-Vorgabe aus den Einstellungen -- deshalb steht hier `orchestrator`
 * und keine Schleife ueber die Worker.
 */
function chatAnsichtLage(s: SessionInfo): {
  offen: boolean; hindernis: string; grund: string; pane: string;
} {
  const faehig = chatFaehigkeit(s.harness, config.modelsFile);
  // OHNE EXPLIZITE WAHL GILT: an, wo der Harness es kann -- harnessErlaubt()
  // (chat/ansichtsregel.ts), siehe dort fuer den Grund.
  const erlaubt = harnessErlaubt(chatAnsicht(config.settingsFile)[s.harness], faehig.kann);
  const u = ansichtsUrteil({
    kann: faehig.kann,
    erlaubt,
    rolle: 'orchestrator',
    vorgabe: chatAnsichtVorgabe(config.settingsFile),
    uebersteuerung: ui.chatUebersteuerung(s.id),
  });
  let grund = '';
  if (u.hindernis === 'kann') {
    grund = faehig.grund || `Fuer '${s.harness}' steht kein gemessener session-Block in der Registry.`;
  } else if (u.hindernis === 'erlaubt') {
    grund = `Die Chat-Ansicht ist für „${s.harness}“ nicht eingeschaltet – der Schalter dafür steht `
      + 'in den Einstellungen unter „Programme und Modelle“.';
  }
  return { offen: u.offen, hindernis: u.hindernis, grund, pane: s.orchestratorPane };
}

/**
 * Die Vorlage des Menues. Bis auf EINEN Punkt sieht sie fuer jede Sitzung
 * gleich aus: die Chat-Ansicht sagt in ihrer Beschriftung, WOHIN sie schaltet
 * ("Als Gespräch zeigen" / "Als Terminal zeigen"), und das haengt daran, was
 * diese Sitzung gerade zeigt. Deshalb steht die Sitzung wieder im Argument --
 * `null` heisst "keine bekannt", dann steht die unverfaengliche Beschriftung da.
 * Dieselbe Liste im Popup und im Steuerkanal.
 *
 * Was NICHT drinsteht: alles, was die Sitzung selbst steuert -- Modell, Effort,
 * Worker. Dafuer gibt es das Einstellungsfenster und die rechte Leiste; ein
 * Kontextmenue, das alles kann, ist eine zweite Oberflaeche.
 *
 * KEIN EINTRAG IST GESPERRT (06.08., Vorgabe des Nutzers: „ich will sie aber
 * immer benutzen können, sie sollen immer verfügbar sein"). Hier stand bis
 * heute eine Vorhersage: laeuft die Sitzung noch, haengt ein Terminal daran,
 * liegt sie auf der anderen Maschine -- und daraus wurde ein grauer Eintrag mit
 * Begruendung. Die Vorhersage war richtig und trotzdem falsch am Platz: sie
 * nahm die Entscheidung vorweg, statt sie zu ermoeglichen. Jetzt wird jeder
 * Punkt ausgefuehrt, und WENN etwas nicht geht, steht der Grund danach in der
 * Meldung ueber der Buehne -- an derselben Stelle, an der auch das Umbenennen
 * seine Antwort zeigt.
 *
 * Die Rueckfrage vor dem Loeschen bleibt. Sie ist keine Sperre, sondern die
 * einzige Bremse gegen einen Fehlgriff.
 */
function menueVorlage(s: SessionInfo | null = null): MenuePunkt[] {
  const punkt = (id: string, label: string, rueckfrage = false): MenuePunkt =>
    ({ id, label, enabled: true, grund: '', rueckfrage });
  // Die Beschriftung sagt, was der Klick TUT, und richtet sich danach, was
  // gerade zu sehen ist -- nicht danach, was gewuenscht ist. Kann der Harness
  // es nicht, steht das Terminalbild da, und der Punkt heisst weiterhin "Als
  // Gespräch zeigen": er wird ausgefuehrt, der Wunsch wird gemerkt, und der
  // Grund kommt danach in der Meldung. Ein Punkt, dessen Text etwas anderes
  // verspricht als das, was passiert, waere schlimmer als einer, der scheitert.
  const gespraechAn = s ? chatAnsichtLage(s).offen : false;
  return [
    punkt('fortsetzen', 'Fortsetzen'),
    punkt('umbenennen', 'Namen ändern …'),
    punkt('chat-ansicht', gespraechAn ? 'Als Terminal zeigen' : 'Als Gespräch zeigen'),
    punkt('ordner-zeigen', 'Ordner im Finder zeigen'),
    punkt('schliessen', 'Sitzung schließen'),
    punkt('loeschen', 'Endgültig löschen …', true),
  ];
}

/**
 * DAS KONTEXTMENUE EINER CHAT-SITZUNG (Punkt 4 und Luecken 5a/5b).
 *
 * DIESELBE Liste wie bei einer Terminal-Sitzung, „soweit sinnvoll" -- und
 * sinnvoll heisst hier: nur, was es an einer Chat-Sitzung wirklich gibt.
 *
 *   Fortsetzen        startet ihren Prozess wieder (er ist beendbar, siehe
 *                     „Sitzung schließen")
 *   Namen ändern …    schreibt in chats.json, nicht ueber `wb-state`
 *   Ordner im Finder  identisch
 *   Sitzung schließen beendet den Prozess; der Eintrag bleibt, die
 *                     Unterhaltung des Harness auch -- ein spaeterer Start
 *                     setzt sie fort
 *   Endgültig löschen nimmt den Eintrag aus chats.json. Was der HARNESS an
 *                     Mitschnitt fuehrt, bleibt liegen: das ist seine
 *                     Buchfuehrung, nicht unsere, und sie hier mit
 *                     wegzuraeumen waere ein Griff in fremde Dateien.
 *
 * WAS FEHLT UND WARUM: „Als Gespräch zeigen" -- eine Chat-Sitzung IST das
 * Gespraech, ein Umschalter darauf haette kein Gegenueber.
 */
function chatMenueVorlage(): MenuePunkt[] {
  const punkt = (id: string, label: string, rueckfrage = false): MenuePunkt =>
    ({ id, label, enabled: true, grund: '', rueckfrage });
  return [
    punkt('fortsetzen', 'Fortsetzen'),
    punkt('umbenennen', 'Namen ändern …'),
    punkt('ordner-zeigen', 'Ordner im Finder zeigen'),
    punkt('schliessen', 'Sitzung schließen'),
    punkt('loeschen', 'Endgültig löschen …', true),
  ];
}

/**
 * Einen Punkt des Chat-Menues ausfuehren. Dieselbe Bauform wie
 * `menuePunktAusfuehren`: BEIDE Wege enden hier -- der echte Klick und der
 * Steuerbefehl --, und `echt` entscheidet nur ueber die Rueckfrage.
 */
async function chatMenuePunktAusfuehren(
  id: string,
  punkt: string,
  echt: boolean,
): Promise<{ ok: boolean; meldung: string; aufruf: string }> {
  const c = chatRegistry.einer(id);
  if (!c) return { ok: false, meldung: `Diese Chat-Sitzung gibt es nicht mehr: ${id}`, aufruf: '' };
  if (!chatMenueVorlage().some((p) => p.id === punkt)) {
    return { ok: false, meldung: `Unbekannter Menuepunkt: ${punkt}`, aufruf: '' };
  }

  if (punkt === 'ordner-zeigen') {
    shell.showItemInFolder(c.ordner);
    process.stderr.write(`Chatmenue 'ordner-zeigen': ${c.ordner}\n`);
    return { ok: true, meldung: `Im Finder gezeigt: ${c.ordner}`, aufruf: '' };
  }

  if (punkt === 'umbenennen') {
    // Derselbe Weg wie bei einer Terminal-Sitzung: das Hauptfenster macht sein
    // kleines Feld auf, geschrieben wird erst, wenn der Name zurueckkommt.
    anOberflaeche('awb:umbenennen', { id: c.id, name: c.name, dir: c.ordner });
    return { ok: true, meldung: 'Nach dem neuen Namen gefragt.', aufruf: '' };
  }

  if (punkt === 'fortsetzen') {
    if (chatbuehne.laufende().includes(c.id)) {
      return { ok: true, meldung: `„${c.name}“ läuft bereits.`, aufruf: '' };
    }
    const gelungen = await chatbuehne.baue(c.id);
    modellSenden();
    return {
      ok: gelungen,
      meldung: gelungen
        ? `„${c.name}“ läuft wieder.`
        : `„${c.name}“ ließ sich nicht starten – der Grund steht auf stderr.`,
      aufruf: '',
    };
  }

  if (punkt === 'schliessen') {
    if (!chatbuehne.laufende().includes(c.id)) {
      return { ok: true, meldung: `„${c.name}“ lief nicht mehr.`, aufruf: '' };
    }
    chatbuehne.schliesse(c.id);
    return {
      ok: true,
      // EHRLICH BESCHRIFTET: geschlossen ist der Prozess, nicht die
      // Unterhaltung. Wer „geschlossen" liest und annimmt, der Verlauf sei
      // weg, waehlt beim naechsten Mal den falschen Weg.
      meldung: `„${c.name}“ ist beendet. Der Eintrag bleibt; ein Start setzt die Unterhaltung fort.`,
      aufruf: '',
    };
  }

  // loeschen
  const ja = await rueckfrage(
    'Chat-Sitzung endgültig löschen?',
    `„${c.name}“ (${c.ordner}) wird aus der Liste entfernt. Ein laufender Prozess wird beendet. `
    + 'Der Mitschnitt des Harness bleibt liegen – er gehört ihm, nicht diesem Programm.',
    echt,
  );
  if (!ja) return { ok: false, meldung: 'Nicht gelöscht.', aufruf: '' };
  chatbuehne.schliesse(c.id);
  const weg = chatRegistry.loeschen(c.id);
  // DIE WERKSTATT MIT DEM ORDNER, DEN WIR NOCH HABEN (Reviewbefund 1). Nach
  // dem Loeschen fuehrt die Buchfuehrung den Eintrag nicht mehr, und ein Name,
  // der aus ihr gebildet wird, waere leer -- die tmux-Session bliebe fuer immer
  // stehen und waere ueber die Oberflaeche nicht mehr erreichbar. `schliesse()`
  // oben hat sie im Normalfall schon abgeraeumt; dieser Griff faengt den Fall,
  // in dem sie es nicht war. Laufende Worker bleiben auch hier stehen.
  const werkstattWeg = chatbuehne.raeumeWerkstatt(c.id, c.ordner);
  if (werkstattWeg) process.stderr.write(`Chatmenue 'loeschen': Werkstatt abgeraeumt (${c.id})\n`);
  modellSenden();
  return {
    ok: weg,
    meldung: weg ? `„${c.name}“ gelöscht.` : `„${c.name}“ war schon weg.`,
    aufruf: '',
  };
}

/** Ist das die Kennung einer CHAT-Sitzung? `neueId` vergibt genau dieses Muster. */
function istChat(id: string): boolean {
  return id.startsWith('chat-');
}

/**
 * DIE RUECKFRAGE VOR ETWAS UNWIDERRUFLICHEM.
 *
 * Dieselbe Bauform wie beim Ordner-Dialog: `AWB_RUECKFRAGE` ersetzt im Test die
 * eine Stelle, an der das Betriebssystem gefragt wuerde ('ja' oder 'nein'), und
 * ohne echten Klick gibt es weder Dialog noch Ausfuehrung. Ein Test darf nie
 * einen echten Kasten auf den Bildschirm bringen -- er wartet auf einen
 * Menschen, den es dort nicht gibt.
 */
async function rueckfrage(titel: string, text: string, echt: boolean): Promise<boolean> {
  if (config.rueckfrageAttrappe) return config.rueckfrageAttrappe === 'ja';
  if (!echt) return false;
  const optionen: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['Abbrechen', 'Löschen'],
    // Die Vorauswahl liegt auf Abbrechen: die Eingabetaste darf nichts
    // Unwiderrufliches ausloesen.
    defaultId: 0,
    cancelId: 0,
    title: titel,
    message: titel,
    detail: text,
  };
  const antwort = win
    ? await dialog.showMessageBox(win, optionen)
    : await dialog.showMessageBox(optionen);
  return antwort.response === 1;
}

/**
 * Einen Punkt des Menues ausfuehren. Beide Wege enden hier -- der echte Klick
 * im Popup und der Steuerbefehl -- damit es nur EINE Fassung jeder Handlung
 * gibt. `echt` entscheidet nur ueber die Rueckfrage, nicht ueber die Handlung.
 */
async function menuePunktAusfuehren(
  id: string,
  punkt: string,
  echt: boolean,
  // Die Oberflaeche hat die Rueckfrage vor dem Loeschen schon gestellt und
  // ein Ja bekommen (Mac-Mantel, 'sitzung-menue-punkt' in awb:bedienung).
  bestaetigt = false,
): Promise<{ ok: boolean; meldung: string; aufruf: string }> {
  // Gegen den JETZIGEN Stand: zwischen Aufklappen und Klick koennen Sekunden
  // liegen, und in denen kann dieselbe Sitzung enden oder wieder laufen.
  sessions = modellLesen();
  const s = sessions.find((x) => x.id === id);
  if (!s) return { ok: false, meldung: `Diese Sitzung gibt es nicht mehr: ${id}`, aufruf: '' };
  const vorlage = menueVorlage(s).find((p) => p.id === punkt);
  if (!vorlage) return { ok: false, meldung: `Unbekannter Menuepunkt: ${punkt}`, aufruf: '' };

  // Liegt diese Sitzung auf der anderen Maschine? Diese eine Frage entscheidet
  // ueber jeden Punkt darunter -- bis zum 09.08. wurde sie nirgends gestellt,
  // und deshalb liefen alle Griffe hier gegen einen tmux-Namen und einen Pfad,
  // die es auf diesem Rechner nicht gibt.
  const fern = !!s.machine && s.machine !== config.machine;

  // Die zwei Punkte OHNE `wb-*`-Werkzeug: einer zeigt nur etwas an, der andere
  // fragt erst im Fenster nach einem Namen.
  if (punkt === 'ordner-zeigen') {
    // DER EINZIGE PUNKT, DER FERN WIRKLICH NICHT GEHT. Ein Finder zeigt, was
    // auf DIESEM Rechner liegt; `/home/alice/...` gibt es hier nicht. Der
    // Punkt bleibt trotzdem anklickbar (Vorgabe des Nutzers vom 06.08.: kein
    // Eintrag ist gesperrt) und sagt danach, woran es liegt -- bis heute meldete
    // er „Im Finder gezeigt: /home/alice/…", und gezeigt wurde nichts.
    if (fern) {
      const meldung = `Der Ordner liegt auf ${s.machine}: ${s.dir} – der Finder dieses Rechners kann ihn nicht zeigen.`;
      process.stderr.write(`Menue 'ordner-zeigen' fern (${s.machine}): ${s.dir}\n`);
      return { ok: false, meldung, aufruf: '' };
    }
    shell.showItemInFolder(s.dir);
    process.stderr.write(`Menue 'ordner-zeigen': ${s.dir}\n`);
    return { ok: true, meldung: `Im Finder gezeigt: ${s.dir}`, aufruf: '' };
  }
  if (punkt === 'chat-ansicht') {
    // SOFORT WIRKSAM, UND ZWAR NUR FUER DIESE SITZUNG. Geschrieben wird nach
    // ui.json (uistate.ts) und nicht in die geteilten Einstellungen; der Pane
    // wechselt danach seine Darstellung, ohne dass ein Fenster neu entsteht
    // oder die Sitzung angefasst wird -- der Renderer haelt je Pane eine
    // Chat-Ansicht, die sich ein- und ausblenden laesst.
    const ziel = !chatAnsichtLage(s).offen;
    ui.chatUebersteuerungSetzen(s.id, ziel);
    // ERST SETZEN, DANN URTEILEN: die Sitzungs-Uebersteuerung schlaegt seit
    // heute auch den Harness-Schalter (ansichtsregel.ts), und das Urteil davor
    // -- mit dem alten `null`/Gegenwert -- kennt die eben gesetzte
    // Uebersteuerung noch nicht. Ein Urteil von VOR dem Schreiben wuerde hier
    // faelschlich "nicht eingeschaltet" melden, obwohl der Klick es gerade
    // freigeschaltet hat.
    const lage = chatAnsichtLage(s);
    process.stderr.write(`Menue 'chat-ansicht' auf '${s.name}': ziel=${ziel} hindernis='${lage.hindernis}'\n`);
    if (lage.hindernis) {
      // KEIN EINTRAG IST GESPERRT: der Punkt lief, der Wunsch ist gemerkt --
      // und er wirkt, sobald das Hindernis wegfaellt. Was ihn heute aufhaelt,
      // steht im Klartext da, statt dass ein grauer Eintrag es vorwegnimmt.
      return {
        ok: false,
        meldung: `Für „${s.name}“ gemerkt, wirksam wird es noch nicht: ${lage.grund}`,
        aufruf: '',
      };
    }
    if (lage.pane) anOberflaeche('awb:chat-ansicht', { paneId: lage.pane, an: ziel });
    return {
      ok: true,
      meldung: ziel
        ? `„${s.name}“ zeigt jetzt das Gespräch.`
        : `„${s.name}“ zeigt jetzt das Terminal.`,
      aufruf: '',
    };
  }
  if (punkt === 'umbenennen') {
    // Der Name wird IM PROGRAMM eingegeben, nicht in einem Terminal: das
    // Hauptfenster macht dafuer ein kleines Feld auf (renderer.ts). Geschrieben
    // wird erst, wenn es zurueckkommt -- ueber 'sitzung-umbenennen'.
    anOberflaeche('awb:umbenennen', { id: s.id, name: s.name, dir: s.dir });
    return { ok: true, meldung: 'Nach dem neuen Namen gefragt.', aufruf: '' };
  }
  if (punkt === 'fortsetzen') {
    // Derselbe Weg wie im Sitzungsfenster, damit es nicht zwei Fassungen von
    // "fortsetzen" gibt.
    try {
      const r = sessionWiederherstellen(s.id);
      nachStartNachlesen();
      return { ok: true, meldung: r.conversationReason, aufruf: r.command };
    } catch (e) {
      return { ok: false, meldung: (e as Error).message, aufruf: '' };
    }
  }

  // `erzwingen`: der Weg schliesst selbst, was geschlossen werden muss. Beide
  // Punkte kommen aus dem Fenster, und dort steht ein Mensch, der es so meint --
  // vor dem Loeschen fragt zusaetzlich der Kasten. Was die Schalter aufheben,
  // steht in befehle.ts.
  //
  // WAS DIE NACHRICHT SEIT DEM 09.08. ZUSAETZLICH TRAEGT: die Maschine der
  // Sitzung, ihren tmux-Namen, ihren Namen und ob sie laeuft. `plane` kann
  // nichts davon selbst nachsehen, sobald die Sitzung drueben liegt -- weder
  // ihre Zustandsdatei noch ihr tmux sind von hier aus zu erreichen. Alle vier
  // Angaben stammen aus derselben SessionInfo, aus der die Leiste gezeichnet
  // wird, und die ist eine Zeile weiter oben frisch gelesen worden.
  const nachricht: Record<string, unknown> = punkt === 'schliessen'
    ? {
      command: 'session-close',
      tmuxSession: s.tmuxSession,
      machine: s.machine,
      laeuft: s.alive,
      erzwingen: true,
    }
    : {
      command: 'delete',
      dir: s.dir,
      sessionKey: s.sessionKey,
      machine: s.machine,
      tmuxSession: s.tmuxSession,
      name: s.name,
      laeuft: s.alive,
      erzwingen: true,
    };
  const plan = plane(nachricht, befehlsUmgebung());
  const aufruf = (plan.aufruf ?? []).join(' ');
  if (plan.art !== 'bestaetigen') {
    return { ok: false, meldung: plan.grund ?? `abgelehnt (${plan.art})`, aufruf };
  }
  if (vorlage.rueckfrage && !bestaetigt) {
    const ja = await rueckfrage(
      `„${s.name}“ endgültig löschen?`,
      `${plan.beschreibung}\n\nDanach lässt sie sich nicht mehr fortsetzen.`,
      echt,
    );
    if (!ja) {
      process.stderr.write(`Menue 'loeschen' abgebrochen (echter Klick: ${echt})\n`);
      return { ok: false, meldung: 'Abgebrochen -- es wurde nichts geloescht.', aufruf };
    }
  }
  // Trifft es die Sitzung, die GERADE GEZEICHNET wird? Dann haengt das Programm
  // an einem tmux-Server, der ihm unter den Haenden weggeht -- das muss es
  // ueberleben, und zwar sichtbar: die naechste Sitzung ruecken oder leer
  // dastehen. Gemerkt VOR dem Aufruf; danach ist die Session weg und die Frage
  // nicht mehr zu beantworten.
  const gezeichnet = !!s.tmuxSession && attachState?.session === s.tmuxSession;
  const ergebnis = await fuehreAus(plan, befehlsUmgebung());
  process.stderr.write(`Menue '${punkt}' auf '${s.name}': ok=${ergebnis.ok} ${ergebnis.ausgabe}\n`);
  // Die Lage hat sich geaendert: Leiste und Sitzungsfenster ziehen nach.
  sessions = modellLesen();
  // NICHT abwarten. Ob der Griff gelungen ist, steht fest, sobald das Werkzeug
  // durch ist -- das Umschalten auf die naechste Sitzung ist Folgearbeit und
  // dauert mit Abloesen und neuem Anhaengen mehrere Sekunden. Gemessen am
  // 06.08.: der Steuerkanal lief in sein Zeitlimit und meldete „keine Antwort",
  // waehrend das Loeschen laengst erledigt war.
  if (gezeichnet && ergebnis.ok) {
    void weiterOhneDieSitzung(s.id).catch((e) =>
      process.stderr.write(`nach dem Schliessen nicht weitergeschaltet: ${(e as Error).message}\n`));
  }
  modellSenden();
  sitzungsfensterAuffrischen();
  return { ok: ergebnis.ok, meldung: ergebnis.ausgabe, aufruf };
}

/**
 * Ein Satz ins Fenster, ueber die Buehne. Leer heisst: nichts zu sagen.
 * `dauerMs` laesst ihn laenger stehen als die ueblichen vier Sekunden (der
 * Absturz-Hinweis, absturz.ts); ohne Angabe bleibt alles wie bisher.
 */
function melde(text: string, dauerMs?: number): void {
  if (!text) return;
  anOberflaeche('awb:meldung', dauerMs ? { text, dauerMs } : { text });
}

/**
 * Die gezeichnete Sitzung ist eben geschlossen oder geloescht worden -- das
 * Programm bleibt.
 *
 * Es loest sich zuerst von ihr (die Zuhoerer weg, dann abloesen: sonst setzt
 * das 'closed' des sterbenden Steuerclients einen Fehler, den danach niemand
 * mehr zuruecknimmt) und zeigt dann die naechste laufende Sitzung. Gibt es
 * keine, bleibt die Mitte leer statt auf einem Bild zu stehen, das es nicht
 * mehr gibt.
 */
async function weiterOhneDieSitzung(weg: string): Promise<void> {
  if (tmux) {
    // WEGWERFEN, nicht abloesen: die Session ist eben verschwunden, also gibt
    // es weder etwas zurueckzustellen noch jemanden, der antwortet.
    tmux.removeAllListeners();
    tmux.aufgeben();
    tmux = null;
  }
  attachState = null;
  attachError = null;
  attachMaschine = '';
  streamPane = '';
  ansicht = { art: 'pane', pane: '' };
  gezeichneteLage = [];
  const naechste = sichtbare(sessions).find((x) => x.id !== weg && x.alive);
  if (naechste) {
    await sessionWaehlen(naechste.id).catch((e) =>
      process.stderr.write(`naechste Sitzung nicht gewaehlt: ${(e as Error).message}\n`));
    return;
  }
  ui.set({ selected: '' });
  anOberflaeche('awb:session', {
    session: '', cols: 80, rows: 24, sizePolicy: '', windows: [], panes: [],
    activePane: '', initialContent: '',
  });
  lageSenden({ art: 'pane', cols: 80, rows: 24, aktiv: '', panes: [], inhalt: {} });
}

/**
 * Das Popup selbst -- die EINZIGE Stelle, die eine Flaeche auf den Bildschirm
 * bringt, und sie haengt an `isTrusted` aus dem Renderer. Ohne echten Klick
 * passiert hier nichts; die Vorlage laesst sich trotzdem lesen (Steuerkanal).
 */
ipc.on('awb:sitzung-menue', (_e, n: { id: string; echt: boolean }) => {
  const id = String(n?.id ?? '');
  if (n?.echt !== true) {
    process.stderr.write(`Sitzungsmenue: kein echter Klick -- nichts aufgeklappt (${id})\n`);
    return;
  }
  if (!win) return;
  // EINE CHAT-SITZUNG BEKOMMT IHR EIGENES MENUE (Punkt 4). Der Kanal ist
  // derselbe, weil die Leiste eine Liste ist; die Kennung sagt, welche Sorte
  // gemeint ist.
  if (istChat(id)) {
    const c = chatRegistry.einer(id);
    if (!c) return;
    const chatVorlage: Electron.MenuItemConstructorOptions[] = [];
    for (const p of chatMenueVorlage()) {
      if (p.rueckfrage) chatVorlage.push({ type: 'separator' });
      chatVorlage.push({
        label: p.label,
        click: () => void chatMenuePunktAusfuehren(c.id, p.id, true).then((r) => melde(r.meldung)),
      });
    }
    process.stderr.write(`Sitzungsmenue: echter Klick auf Chat '${c.name}' -- popup()\n`);
    Menu.buildFromTemplate(chatVorlage).popup({ window: win });
    return;
  }
  sessions = modellLesen();
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  const vorlage: Electron.MenuItemConstructorOptions[] = [];
  for (const p of menueVorlage(s)) {
    // Vor dem Loeschen ein Trenner: die scharfe Sache steht nicht in einer
    // Reihe mit dem Rest, und ein Fehlgriff um eine Zeile trifft dann nicht sie.
    if (p.rueckfrage) vorlage.push({ type: 'separator' });
    vorlage.push({
      label: p.label,
      enabled: p.enabled,
      // WAS DER GRIFF ERGEBEN HAT, WIRD GESAGT. Bis zum 06.08. fiel die Antwort
      // hier auf den Boden: der Klick rief die Handlung, und ihr Ergebnis las
      // niemand. Ein Punkt, der nicht mehr grau ist, braucht diese Zeile --
      // sonst schweigt ein Fehlschlag ganz.
      click: () => void menuePunktAusfuehren(s.id, p.id, true).then((r) => melde(r.meldung)),
    });
  }
  const menu = Menu.buildFromTemplate(vorlage);
  process.stderr.write(`Sitzungsmenue: echter Klick auf '${s.name}' -- popup()\n`);
  menu.popup({ window: win });
});

/**
 * Der neue Name -- aus dem kleinen Feld im Hauptfenster ODER aus dem
 * Steuerkanal. EINE Fassung fuer beide Wege, damit ein Test denselben Weg
 * prueft, den ein Mensch geht.
 */
async function sitzungUmbenennen(id: string, name: string): Promise<{ ok: boolean; meldung: string; aufruf: string }> {
  // EINE CHAT-SITZUNG WIRD IN IHRER EIGENEN BUCHFUEHRUNG UMBENANNT (Luecke 5b).
  // `wb-state` kennt sie nicht -- sie hat weder tmux-Namen noch Zustandsdatei
  // --, und ein Aufruf dorthin liefe ins Leere und meldete trotzdem Erfolg.
  if (istChat(id)) {
    const neu = String(name ?? '').trim();
    if (!neu) return { ok: false, meldung: 'Kein Name angegeben – nichts geändert.', aufruf: '' };
    const e = chatRegistry.aendern(id, { name: neu });
    modellSenden();
    return e
      ? { ok: true, meldung: `Umbenannt in „${e.name}“.`, aufruf: '' }
      : { ok: false, meldung: `Diese Chat-Sitzung gibt es nicht mehr: ${id}`, aufruf: '' };
  }
  sessions = modellLesen();
  const s = sessions.find((x) => x.id === String(id ?? ''));
  if (!s) return { ok: false, meldung: `Diese Sitzung gibt es nicht mehr: ${id}`, aufruf: '' };
  const plan = plane({
    command: 'session-rename',
    dir: s.dir,
    tmuxSession: s.tmuxSession,
    sessionKey: s.sessionKey,
    // Ohne diese Zeile schrieb das HIESIGE `wb-state` in den fernen Ordner --
    // und legte hier eine Zustandsdatei fuer ein Verzeichnis an, das es auf
    // diesem Rechner nicht gibt (09.08., gemessen).
    machine: s.machine,
    name,
  }, befehlsUmgebung());
  const aufruf = (plan.aufruf ?? []).join(' ');
  if (plan.art !== 'bestaetigen') {
    process.stderr.write(`Umbenennen abgelehnt: ${plan.grund ?? plan.art}\n`);
    return { ok: false, meldung: plan.grund ?? `abgelehnt (${plan.art})`, aufruf };
  }
  const ergebnis = await fuehreAus(plan, befehlsUmgebung());
  process.stderr.write(`Umbenennen '${s.name}' -> '${name}': ok=${ergebnis.ok} ${ergebnis.ausgabe}\n`);
  sessions = modellLesen();
  modellSenden();
  sitzungsfensterAuffrischen();
  return { ok: ergebnis.ok, meldung: ergebnis.ausgabe, aufruf };
}

ipc.handle('awb:sitzung-umbenennen', (_e, id: string, name: string) =>
  sitzungUmbenennen(String(id ?? ''), String(name ?? '')));

/**
 * DIE ORDNERWAHL FUER EINE NEUE SITZUNG -- der native Dialog von macOS.
 *
 * Der eingebaute Ordnerbaum ist damit weg. Er war eine zweite, schlechtere
 * Fassung von etwas, das das Betriebssystem besser kann: Seitenleiste,
 * Suchfeld, zuletzt benutzte Orte, Tippen eines Pfades.
 *
 * ZWEI DINGE HAENGEN AN DIESER EINEN FUNKTION.
 *
 * 1. DER ECHTE KLICK. Ein Dialog ist ein Fenster auf einem Bildschirm, und er
 *    wartet auf einen Menschen. Kein Steuerbefehl und kein Test darf ihn
 *    aufmachen -- dieselbe Auflage, unter der auch das Sitzungsfenster selbst
 *    steht. `echt` kommt aus `isTrusted` im Fenster und wird hier NICHT
 *    nachgebessert; ohne echten Klick gibt es keinen Dialog und keinen Pfad.
 * 2. DIE ATTRAPPE. Steht `AWB_ORDNER_DIALOG` in der Umgebung, liefert diese
 *    Funktion genau diesen Pfad und fragt das Betriebssystem gar nicht erst.
 *    Damit prueft eine Suite, was mit dem gewaehlten Pfad GESCHIEHT
 *    (Ausschlussliste, Aufruf, Meldung) -- und nie den Finder.
 */
/** Der Projektordner einer neuen Welt (Tab Agents); wie `ordnerDialog`, nur mit eigenem Text und ohne Mantel-Weg. */
async function weltOrdnerDialog(echt: boolean): Promise<{ pfad: string; grund: string }> {
  if (config.ordnerDialogAttrappe) return { pfad: config.ordnerDialogAttrappe, grund: '' };
  if (!echt) return { pfad: '', grund: 'Ohne echten Klick wird kein Ordner-Dialog geöffnet.' };
  const optionen: Electron.OpenDialogOptions = {
    title: 'Projektordner für die neue Welt', buttonLabel: 'Welt hier anlegen',
    message: 'Die Welt liegt danach dort unter .werkbank/agents.', properties: ['openDirectory', 'createDirectory'],
  };
  // Mit umgelenktem HOME (Abnahme) beginnt der Dialog dort, wie am Mac.
  if (process.env.HOME && process.env.HOME !== userInfo().homedir) optionen.defaultPath = process.env.HOME;
  const antwort = win ? await dialog.showOpenDialog(win, optionen) : await dialog.showOpenDialog(optionen);
  const pfad = antwort.canceled ? '' : (antwort.filePaths[0] ?? '');
  return { pfad, grund: pfad ? '' : 'Abgebrochen -- es wurde keine Welt angelegt.' };
}

async function ordnerDialog(echt: boolean, vorgewaehlt = ''): Promise<{ pfad: string; grund: string }> {
  if (config.ordnerDialogAttrappe) {
    return { pfad: config.ordnerDialogAttrappe, grund: '' };
  }
  // 3. DER MANTEL (06.09., Auftrag 2.7): die Mac-Oberflaeche zeigt ihren
  //    eigenen NSOpenPanel und reicht den gewaehlten Ordner herein -- der
  //    Electron-Dialog an einem versteckten Fenster waere dort unsichtbar.
  //    Nur bei einem echten Klick, aus demselben Grund wie in 1; die Pruefung
  //    des Pfads (Ausschlussliste, unter HOME, Verzeichnis) bleibt bei
  //    `sessionAnlegen`, wo sie fuer jeden Weg gilt.
  //    ERWEITERT AM 08.09.2026: der Ordner gilt AUCH OHNE echten Klick. Der
  //    Haken `echt` schuetzt den DIALOG -- er soll sich nicht ohne Zutun eines
  //    Menschen oeffnen. Steht der Ordner aber schon fest (Mantel: der
  //    Plusknopf am Projektkopf startet in genau diesem Ordner, ohne Dialog),
  //    gibt es nichts zu schuetzen, und eine Pruefung konnte diesen Weg vorher
  //    gar nicht gehen. Was der Pfad darf, entscheidet weiterhin
  //    `sessionAnlegen`: Ausschlussliste, unter HOME, wirklich ein Verzeichnis.
  if (vorgewaehlt.trim()) {
    return { pfad: vorgewaehlt.trim(), grund: '' };
  }
  if (!echt) {
    return { pfad: '', grund: 'Ohne echten Klick wird kein Ordner-Dialog geoeffnet.' };
  }
  const eltern = sitzungsfenster.aktuell() ?? win ?? undefined;
  const antwort = eltern
    ? await dialog.showOpenDialog(eltern, {
      title: 'Ordner für die neue Sitzung',
      buttonLabel: 'Sitzung hier starten',
      properties: ['openDirectory', 'createDirectory'],
    })
    : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  const pfad = antwort.canceled ? '' : (antwort.filePaths[0] ?? '');
  return { pfad, grund: pfad ? '' : 'Abgebrochen -- es wurde nichts gestartet.' };
}

/**
 * Der Knopf „Neue Sitzung": Ordner waehlen und starten, in einem Zug.
 *
 * DIE AUSSCHLUSSLISTE WIRD HIER GEPRUEFT, nicht mehr beim Blaettern. Der native
 * Dialog kennt `excludeGlobs` nicht und kann sie nicht durchsetzen -- vorher
 * stand ein ausgeschlossener Ordner gar nicht erst zur Wahl. Diese Zusage darf
 * nicht still verschwinden, also faellt sie jetzt an der letzten Stelle, an der
 * sie noch fallen kann: `sessionAnlegen` lehnt ab, und das Fenster sagt, warum.
 *
 * `machine` IST NEU (11.08.). Bei der eigenen Maschine (leer oder gleich
 * `config.machine`) aendert sich nichts -- der native Dialog waehlt den
 * Ordner, wie er es immer tat. Bei jeder anderen Maschine gibt es diesen
 * Dialog nicht (er zeigt, was HIER liegt); der Pfad kommt dann als Text aus
 * dem Fenster (`fernPfad`) und die Echtheit des Klicks spielt keine Rolle --
 * es oeffnet sich kein Fenster des Betriebssystems, das ein Test nicht sehen
 * darf.
 */
ipc.handle('awb:sitz-neu', async (_e, name: string, machine: string, fernPfad: string, echt: boolean, ordner?: string) => {
  const ziel = String(machine ?? '').trim() || config.machine;
  let pfad: string;
  if (ziel !== config.machine) {
    pfad = String(fernPfad ?? '').trim();
    if (!pfad) {
      return { ok: false, meldung: `Erst einen Ordner auf '${ziel}' eintragen.`, command: '' };
    }
  } else {
    const wahl = await ordnerDialog(echt === true, String(ordner ?? ''));
    if (!wahl.pfad) {
      process.stderr.write(`Sitzungsfenster: Ordnerwahl ohne Ergebnis -- ${wahl.grund}\n`);
      return { ok: false, meldung: wahl.grund, command: '' };
    }
    pfad = wahl.pfad;
  }
  try {
    const r = sessionAnlegen(pfad, String(name ?? ''), ziel, undefined, echt === true);
    process.stderr.write(`Sitzungsfenster: neu in '${pfad}' (${ziel}) -- gestartet=${r.gestartet} ${r.meldung}\n`);
    if (r.gestartet) nachStartNachlesen();
    return { ok: r.gestartet, meldung: r.meldung, command: r.command };
  } catch (e) {
    const meldung = (e as Error).message;
    process.stderr.write(`Sitzungsfenster: neu in '${pfad}' (${ziel}) abgelehnt -- ${meldung}\n`);
    return { ok: false, meldung, command: '' };
  }
});

/**
 * DER DRITTE KNOPF: „Modell für diese Sitzung wählen …" (19.08.).
 *
 * Er tut GENAU DASSELBE wie `awb:sitz-neu` -- derselbe Ordnerdialog, dieselbe
 * Maschinenwahl, dieselbe `sessionAnlegen` -- und reicht nur eine Wahl mit
 * durch. Kein zweiter Startweg: zwei Wege, die eine Sitzung anlegen, wären
 * zwei Stellen, an denen die Ausschlussliste, der Doppelklick-Schutz und die
 * Schlüsselvergabe auseinanderlaufen können.
 */
ipc.handle(
  'awb:sitz-neu-wahl',
  async (_e, name: string, machine: string, fernPfad: string, wahl: SitzungsWahl, echt: boolean, ordner?: string) => {
    const ziel = String(machine ?? '').trim() || config.machine;
    let pfad: string;
    if (ziel !== config.machine) {
      pfad = String(fernPfad ?? '').trim();
      if (!pfad) {
        return { ok: false, meldung: `Erst einen Ordner auf '${ziel}' eintragen.`, command: '' };
      }
    } else {
      const w = await ordnerDialog(echt === true, String(ordner ?? ''));
      if (!w.pfad) {
        process.stderr.write(`Sitzungsfenster: Ordnerwahl ohne Ergebnis -- ${w.grund}\n`);
        return { ok: false, meldung: w.grund, command: '' };
      }
      pfad = w.pfad;
    }
    const gewaehlt: SitzungsWahl = {
      harness: String(wahl?.harness ?? ''),
      model: String(wahl?.model ?? ''),
      effort: String(wahl?.effort ?? ''),
      kontext: Number(wahl?.kontext ?? 0),
    };
    try {
      const r = sessionAnlegen(pfad, String(name ?? ''), ziel, gewaehlt, echt === true);
      process.stderr.write(
        `Sitzungsfenster: neu MIT WAHL in '${pfad}' (${ziel}) -- gestartet=${r.gestartet} ${r.command}\n`,
      );
      if (r.gestartet) nachStartNachlesen();
      return { ok: r.gestartet, meldung: r.meldung, command: r.command };
    } catch (e) {
      const meldung = (e as Error).message;
      process.stderr.write(`Sitzungsfenster: neu MIT WAHL in '${pfad}' (${ziel}) abgelehnt -- ${meldung}\n`);
      return { ok: false, meldung, command: '' };
    }
  },
);

/**
 * WAS ZUR WAHL STEHT -- Programme, Modelle und Denkstufen, und was heute in den
 * Einstellungen steht.
 *
 * AUF ABRUF UND NICHT IM DATENSTAND: `sitzungsDatenJetzt()` läuft bei jeder
 * Änderung an den Sitzungen; `einstellungenDatenJetzt()` dagegen ruft mehrfach
 * `wb-state` auf. Beides zusammenzulegen hieße, diese Aufrufe an den Takt der
 * Sitzungsliste zu hängen. Dieser Kanal wird genau einmal befragt: wenn ein
 * Mensch die Wahl aufklappt.
 *
 * Es ist eine reine Projektion von `einstellungenDatenJetzt()` -- dieselbe
 * Quelle wie im Einstellungsfenster und im Erststart, damit es über Modelle,
 * Programme und Stufen genau EINE Auskunft gibt.
 */
ipc.handle('awb:sitz-wahl-daten', () => {
  const d = einstellungenDatenJetzt() as EinstellungsDaten;
  return {
    harnesses: d.harnesses.map((h) => ({ id: h.id, label: h.label, binaer: h.binaer })),
    modelle: d.orchestratorModelle.map((m) => ({
      id: m.id,
      label: m.label,
      harness: m.harness,
      harnessLabel: m.harnessLabel,
      lokal: m.lokal,
      startbar: m.startbar,
      deckelRegistry: m.deckelRegistry,
    })),
    harnessStufen: d.harnessStufen,
    // Der Deckel je Modell, damit die Stufenwahl im Sitzungsfenster ihn nennen
    // kann, ohne eine zweite Tabelle (Mantel, Auftrag 2.7, 06.09.): `deckel`
    // ist die Antwort von `wb-state models cap` fuer die beiden gewaehlten
    // Modelle (einstellungsfenster.ts, mehr Aufrufe waeren eine halbe Minute),
    // `effortCaps` sind die gesetzten Deckel aus der Einstellungsdatei, und
    // `deckelRegistry` je Modell die Auslieferung -- dieselben drei Quellen,
    // aus denen die Modelle-Seite ihre Tabelle zeichnet.
    deckel: d.deckel,
    effortCaps: d.effortCaps,
    einstellung: {
      harness: String(d.settings.orchestratorHarness ?? d.vorgaben.orchestratorHarness ?? ''),
      model: String(d.settings.orchestratorModel ?? d.vorgaben.orchestratorModel ?? ''),
      effort: String(d.settings.orchestratorEffort ?? d.vorgaben.orchestratorEffort ?? ''),
      kontext: Number(d.settings.orchestratorKontext ?? 0),
    },
  };
});

/**
 * DER ZWEITE KNOPF: eine Chat-Sitzung (12.08.).
 *
 * Sie kennt keine Fernmaschine -- sie ist ein Prozess DIESER App und laeuft
 * dort, wo die App laeuft. Deshalb steht hier nur der Ordnerdialog und keine
 * Maschinenwahl, und deshalb geht es auch nicht ueber `wb-code`: es entsteht
 * kein tmux-Fenster, das jemand wiederfinden muesste, sondern ein Eintrag in
 * der eigenen Buchfuehrung und eine Ansicht auf der Buehne dieses Fensters.
 */
ipc.handle('awb:sitz-neu-chat', async (_e, name: string, echt: boolean, ordner?: string) => {
  const wahl = await ordnerDialog(echt === true, String(ordner ?? ''));
  if (!wahl.pfad) {
    process.stderr.write(`Chatbuehne: Ordnerwahl ohne Ergebnis -- ${wahl.grund}\n`);
    return { ok: false, meldung: wahl.grund, command: '' };
  }
  const eintrag = chatRegistry.anlegen({
    id: neueId(Date.now(), Math.random()),
    name: String(name ?? '').trim() || nameAusOrdner(wahl.pfad),
    ordner: wahl.pfad,
    // Das Modell kommt aus den Einstellungen, nicht aus einer festen Zeile
    // hier: die Modellwahl dieses Hauses gehoert der Einstellungsseite.
    modell: chatModellVorgabe(),
    // Der Freigabemodus bleibt LEER -- dann gilt, was die CLI ohnehin tut.
    // Ein hier eingebautes 'acceptEdits' waere eine stille Rechteerweiterung
    // gegenueber dem, was der Mensch im Terminal gewohnt ist.
    modus: '',
    sessionId: '',
    zuletzt: new Date().toISOString(),
  });
  // Der Klick auf diesen Knopf ist die echte Bedienung, an der das Zeigen
  // haengt (siehe chatbuehne.ts, Klassendoc). Ohne sie wird nur gestartet.
  if (echt === true) await chatbuehne.zeigeNachEchtemKlick(eintrag.id);
  else await chatbuehne.baue(eintrag.id);
  nachStartNachlesen();
  return { ok: true, meldung: `Chat-Sitzung '${eintrag.name}' in ${eintrag.ordner}.`, command: '' };
});

// --- Die Bruecke der Chat-Buehne ---------------------------------------------
//
// DIE KENNUNG REIST NICHT UEBER DIE BRUECKE, und der Grund ist derselbe wie zu
// der Zeit, als jede Sitzung ihr eigenes Fenster hatte: waere sie ein Argument,
// koennte die Oberflaeche eine Sitzung bedienen, die gerade nicht zu sehen ist
// -- eine Freigabe in der falschen Sitzung zu erteilen ist genau die Sorte
// Fehler, die niemand bemerkt. Bedient wird deshalb IMMER die Sitzung, die auf
// der Buehne liegt (`gezeigter()`), und nur, wenn die Nachricht auch aus dem
// Hauptfenster kommt.
function vomHauptfenster(e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  // Der Mantel IST das Hauptfenster (06.09., Auftrag 4.1): im Mantelbetrieb
  // gibt es kein `win` mehr, an dem sich die Herkunft ablesen liesse, und ohne
  // diese Zeile faende jede Freigabe und jeder Chat-Griff der Mac-Oberflaeche
  // eine leere Sitzung vor.
  if (e.sender === MANTEL_SENDER) return true;
  return !!win && BrowserWindow.fromWebContents(e.sender) === win;
}

function chatIdVon(e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): string {
  return vomHauptfenster(e) ? chatbuehne.gezeigter() : '';
}

ipc.handle('awb:chat-daten', (e, seit: number) =>
  chatbuehne.stand(chatIdVon(e), Number(seit) || 0));

ipc.handle('awb:chat-senden', (e, text: string) =>
  chatbuehne.senden(chatIdVon(e), String(text ?? '')));

ipc.handle('awb:chat-freigabe', (e, anfrageId: string, erlauben: boolean) =>
  chatbuehne.freigabe(chatIdVon(e), String(anfrageId ?? ''), erlauben === true));

// Frisch starten, nachdem ein `--resume` auf eine verschwundene Unterhaltung
// gescheitert ist (Befund B3, 12.08.).
ipc.handle('awb:chat-neustart', (e) => chatbuehne.neustart(chatIdVon(e)));

// Den Freigabemodus zur LAUFZEIT umstellen (Luecke 5c). Dass das geht, ist
// gemessen -- siehe `Chatsitzung.setzeModus`.
ipc.handle('awb:chat-modus', (e, modus: string) =>
  chatbuehne.setzeModus(chatIdVon(e), String(modus ?? '')));

// Einen laufenden Zug unterbrechen (Punkt 6) -- das Gegenstueck zu Escape im
// Terminal.
ipc.handle('awb:chat-halt', (e) => chatbuehne.halte(chatIdVon(e)));

/**
 * DIE DATEILISTE FUER DAS `@` IM EINGABEFELD (Punkt 3).
 *
 * Gelesen wird EINMAL je Sitzung und dann im Fenster gehalten: die Liste eines
 * grossen Repos hat einige tausend Eintraege, und sie bei jedem Tastendruck neu
 * ueber IPC zu schicken waere derselbe Fehler wie der volle Gespraechsstand je
 * Token (Befund B1). Gefiltert wird im Fenster (chatdateien.ts,
 * `filtereDateien` -- dieselbe reine Funktion, gegen die der Test laeuft).
 *
 * Der Ordner kommt NICHT vom Fenster: sonst koennte die Oberflaeche jeden
 * beliebigen Pfad dieser Maschine auflisten lassen. Er ist der Ordner der
 * Sitzung, die gerade auf der Buehne liegt -- derselbe, in dem ihr Prozess
 * laeuft.
 */
ipc.handle('awb:chat-dateien', async (e) => {
  const id = chatIdVon(e);
  const eintrag = id ? chatRegistry.einer(id) : null;
  if (!eintrag) return { ordner: '', quelle: 'git', dateien: [] };
  const liste = await projektDateien(eintrag.ordner);
  return { ordner: eintrag.ordner, quelle: liste.quelle, dateien: liste.dateien };
});

// Die Buehne hat gezeichnet. Die Kennung kommt MIT: auf sie wartet
// `zeigeAufBuehne()`, und eine Meldung aus einem Wechsel, der ueberholt wurde,
// darf das Warten nicht beenden.
ipc.on('awb:chat-bereit', (e, id: string) => {
  if (!vomHauptfenster(e)) return;
  chatbuehne.bereitGemeldet(String(id ?? ''));
});

/**
 * EINE CHAT-SITZUNG FUER DEN STEUERKANAL: starten, auf die Buehne legen, das
 * Hauptfenster zurueckgeben.
 *
 * Das Warten steckt in `zeigeAufBuehne()` und ist der Grund, warum diese
 * Funktion existiert: Modell-Nachricht und `executeJavaScript` sind zwei
 * verschiedene Wege in denselben Renderer, ihre Reihenfolge ist nicht zugesagt,
 * und ohne das Warten griffe der naechste Befehl in eine Ansicht, die noch
 * nicht steht.
 */
async function chatAufBuehneLegen(id: string): Promise<void> {
  if (!id) throw new Error('Feld id fehlt');
  if (!(await chatbuehne.zeigeAufBuehne(id))) throw new Error(`keine Chat-Sitzung '${id}'`);
}

/**
 * Dasselbe UND das Fenster dazu -- fuer die Griffe, die wirklich in die
 * gezeichnete Buehne fassen. Im Mantelbetrieb gibt es die nicht (Auftrag 4.1);
 * die Sitzung liegt trotzdem auf der Buehne, denn das ist Sache des Kerns.
 * Wer nur das braucht, ruft `chatAufBuehneLegen`.
 */
async function chatAufBuehne(id: string): Promise<BrowserWindow> {
  await chatAufBuehneLegen(id);
  if (!win) throw new Error(KEIN_RENDERER);
  return win;
}

/**
 * Der „Prüfen"-Knopf neben dem Pfadfeld einer Fernmaschine (11.08.). Derselbe
 * Griff, den `sessionAnlegen` selbst vor dem Start noch einmal tut -- hier
 * gibt es die Antwort schon VORHER, ohne dass ein Start dranhaengt. Kein
 * echter Klick noetig: es entsteht kein Fenster des Betriebssystems, nur eine
 * ssh-Verbindung, die derselben Zeitgrenze unterliegt wie jeder andere
 * Fernaufruf.
 */
ipc.handle('awb:sitz-fern-pruefen', (_e, machine: string, pfad: string) =>
  fernOrdnerPruefen(String(machine ?? ''), String(pfad ?? '')));

ipc.handle('awb:sitz-fortsetzen', (_e, id: string, echt: boolean) => {
  try {
    // Gegen den JETZIGEN Stand, nicht gegen den, aus dem die Zeile gezeichnet
    // wurde: zwischen Zeichnen und Klick koennen Sekunden liegen, und in denen
    // kann dieselbe Sitzung wieder laufen. Die Ablehnung dafuer steht in
    // `sessionWiederherstellen`; sie taugt nur, wenn die Liste frisch ist.
    sessions = modellLesen();
    const r = sessionWiederherstellen(String(id ?? ''), echt === true);
    nachStartNachlesen();
    return { ok: true, meldung: r.conversationReason, command: r.command };
  } catch (e) {
    const meldung = (e as Error).message;
    process.stderr.write(`Sitzungsfenster: fortsetzen '${id}' abgelehnt -- ${meldung}\n`);
    return { ok: false, meldung, command: '' };
  }
});

/**
 * „Beenden" je Zeile (11.08., Bauteil 4 -- ergaenzt zur urspruenglichen
 * Aufgabe). WIRD DURCH `menuePunktAusfuehren('schliessen')` AUSGEFUEHRT --
 * derselbe Griff, den das Kontextmenue der Leiste schon hat, samt seiner
 * fern/oertlich-Weiche (`s.machine`) und seinem `wb-session-close`-Aufruf.
 * Kein zweiter Weg, der davon abweichen koennte.
 *
 * DIE RUECKFRAGE STEHT HIER UND NICHT IN `menuePunktAusfuehren`: der Plan
 * fuer 'schliessen' selbst verlangt keine (befehle.ts: die Zustandsdatei
 * bleibt, nichts geht unwiderruflich weg) -- das Kontextmenue fragt darum bis
 * heute nicht, und das soll es weiter nicht. Dieser Knopf im Sitzungsfenster
 * ist trotzdem der ausdrueckliche Auftrag: ein Eingriff in eine LAUFENDE
 * Sitzung soll nicht aus einem Fehlklick geschehen. Dieselbe `rueckfrage()`-
 * Funktion wie beim Loeschen, dieselbe Attrappe (`AWB_RUECKFRAGE`) fuer Tests.
 */
ipc.handle('awb:sitz-beenden', async (_e, id: string, echt: boolean, bestaetigt?: boolean) => {
  const kennung = String(id ?? '');
  sessions = modellLesen();
  const s = sessions.find((x) => x.id === kennung);
  if (!s) return { ok: false, meldung: `Diese Sitzung gibt es nicht mehr: ${kennung}`, command: '' };
  // `bestaetigt` (06.09., Auftrag 2.7): die Oberflaeche hat die Rueckfrage
  // schon selbst gestellt -- der Mantel als NSAlert-Sheet an seinem Fenster,
  // kopflos ueber dieselbe Attrappe `AWB_RUECKFRAGE`. Dann fragt der Kern nicht
  // ein zweites Mal ueber einen Electron-Dialog an seinem versteckten Fenster;
  // derselbe Griff wie `bestaetigt` bei `sitzung-menue-punkt`.
  const ja = bestaetigt === true || await rueckfrage(
    `„${s.name}“ beenden?`,
    'Der Pane schliesst; die Zustandsdatei bleibt, die Sitzung laesst sich danach fortsetzen.',
    echt === true,
  );
  if (!ja) {
    process.stderr.write(`Sitzungsfenster: 'beenden' auf '${s.name}' abgebrochen (echter Klick: ${echt === true})\n`);
    return { ok: false, meldung: 'Abgebrochen -- nichts beendet.', command: '' };
  }
  // `echt: false` hier: die Rueckfrage ist schon beantwortet, und
  // `menuePunktAusfuehren` fragt fuer 'schliessen' ohnehin nicht ein zweites
  // Mal (`vorlage.rueckfrage` ist dort false).
  const r = await menuePunktAusfuehren(kennung, 'schliessen', false);
  return { ok: r.ok, meldung: r.meldung, command: r.aufruf };
});

// --- Steuerkanal -----------------------------------------------------------

async function bufferText(): Promise<string> {
  if (!win) return '';
  return (await win.webContents.executeJavaScript('window.__awb.bufferText()')) as string;
}

async function schirmText(): Promise<string> {
  if (!win) return '';
  return (await win.webContents.executeJavaScript('window.__awb.schirmText()')) as string;
}

async function uiText(): Promise<unknown> {
  if (!win) return {};
  return (await win.webContents.executeJavaScript('window.__awb.uiState()')) as unknown;
}

/**
 * EINE SITZUNG WAEHLEN -- auch eine auf der anderen Maschine (10.08.).
 *
 * Das war der Klick, der alice zuerst auffiel. Bis zum 09.08. lief er in
 * `attachTmux` und damit in ein `tmux -C attach` auf DIESEM Rechner, gegen einen
 * Sessionnamen, den es hier nicht gibt: fuenf Sekunden Warten und der Satz „tmux
 * meldete kein %session-changed in 5000 ms". Am 09.08. wurde daraus die ehrliche
 * Haelfte -- Buehne raeumen und sagen, dass hier nichts gezeichnet wird.
 *
 * Heute wird gezeichnet. Der Steuermodus traegt ueber SSH (gemessen am 05.08.),
 * und `TmuxControl` kann seinen Kanal seit heute auch auf der anderen Maschine
 * oeffnen -- ueber `fernAufruf`, dieselbe eine Stelle, die auch Schliessen,
 * Umbenennen und Fortsetzen dorthin bringt. Von hier aus ist der Unterschied
 * genau ein Argument: der Maschinenname.
 *
 * WAS BLEIBT, ist der Weg fuer eine Sitzung, die NICHT laeuft -- drueben wie
 * hier. Dann gibt es nichts anzuhaengen, und die Buehne bleibt leer; bei einer
 * fernen Sitzung mit einem Satz, der die Maschine nennt, weil „leer" dort auch
 * „die Maschine antwortet gerade nicht" heissen kann.
 */
async function sessionWaehlen(kennung: string): Promise<SessionInfo | null> {
  sessions = modellLesen();
  const treffer = sessions.find((s) => s.id === kennung || s.name === kennung || s.tmuxSession === kennung);
  if (!treffer) throw new Error(`keine Session '${kennung}'`);
  // WER EINE TERMINAL-SITZUNG WAEHLT, WILL IHRE KACHELN SEHEN (13.08.). Lag
  // eine Chat-Sitzung auf der Buehne, geht sie damit zu -- ihr Prozess laeuft
  // weiter, sie ist nur nicht mehr zu sehen.
  chatbuehne.verbergen();
  chatWerkstattGezeigt = '';
  ui.set({ selected: treffer.id, workerTab: 0 });
  const fern = treffer.machine && treffer.machine !== config.machine ? treffer.machine : '';
  if (treffer.alive) await attachTmux(treffer.tmuxSession, fern);
  else {
    // Erst die Zuhoerer weg, dann abloesen -- sonst setzt das 'closed' des
    // sterbenden Steuerclients gleich wieder einen Fehler ueber unseren Satz
    // (dieselbe Reihenfolge und derselbe Grund wie in `attachTmux`).
    if (tmux) {
      tmux.removeAllListeners();
      await tmux.detach();
      tmux = null;
    }
    attachState = null;
    attachMaschine = fern;
    streamPane = '';
    ansicht = { art: 'pane', pane: '' };
    gezeichneteLage = [];
    attachError = fern
      ? `Auf ${fern} läuft diese Sitzung gerade nicht – oder die Maschine antwortet nicht. Deshalb steht hier `
        + 'kein Terminal. Fortsetzen, Umbenennen, Schließen und Löschen wirken trotzdem: sie laufen drüben.'
      : null;
    anOberflaeche('awb:session', {
      session: treffer.tmuxSession, cols: 80, rows: 24, sizePolicy: '', windows: [], panes: [],
      activePane: '', initialContent: '',
    });
    if (fern) {
      lageSenden({ art: 'pane', cols: 80, rows: 24, aktiv: '', panes: [], inhalt: {} });
      process.stderr.write(`Fernsitzung gewaehlt: ${treffer.id} auf ${fern} -- laeuft dort nicht\n`);
      melde(attachError!);
    }
  }
  modellSenden();
  return treffer;
}

/**
 * EINEN WORKER EINER CHAT-SITZUNG AUF DIE BUEHNE HOLEN (Punkt 1).
 *
 * Der Befund war: „ich kann nicht vom orchestrator zu den workern wechseln."
 * Der Weg dorthin ist derselbe wie bei jeder Terminal-Sitzung -- an die
 * tmux-Session anhaengen und den Pane zeichnen --, und das geht jetzt, weil die
 * Chat-Sitzung eine tmux-Session HAT (chatwerkstatt.ts). Das Gespraech klappt
 * dabei zu; sein Prozess laeuft weiter, und ein Klick auf dieselbe Zeile links
 * holt es zurueck.
 */
async function chatWorkerZeigen(chatId: string, paneId: string): Promise<boolean> {
  const werkstatt = chatbuehne.werkstattVon(chatId);
  if (!werkstatt || !paneId) {
    process.stderr.write(`Chatwerkstatt: kein Wechsel -- Werkstatt='${werkstatt}' Pane='${paneId}'\n`);
    return false;
  }
  chatbuehne.verbergen();
  chatWerkstattGezeigt = chatId;
  await attachTmux(werkstatt, '');
  await paneZeigen(paneId);
  process.stderr.write(`Chatwerkstatt: Worker auf der Buehne (${werkstatt} ${paneId})\n`);
  modellSenden();
  return true;
}

/**
 * DER STEUERKANAL TIPPT NICHT MEHR IN EINEN ORCHESTRATOR-PANE (2026-08-06).
 *
 * Regel des Nutzers: in den Orchestrator-Chat schreiben nur er selbst und der
 * context-guard. Der Steuerkanal ist per Bauart das Gegenteil davon -- ueber ihn
 * erreicht ein SKRIPT das laufende Programm. Also gilt fuer `type`, `key` und den
 * Editor-Haken `sendSelection` dieselbe Pruefung wie fuer jeden anderen Schreibweg.
 *
 * Die Regel steht NICHT hier. Gefragt wird `wb-pane-write darf <pane>` -- dasselbe
 * Werkzeug, das der context-guard und pi-worker benutzen. Zwei Fassungen einer
 * Sicherung laufen mit der Zeit auseinander, und die schwaechere gewinnt dann.
 *
 * Das Fenster ist davon UNBERUEHRT: wer im Programm tippt, ist der Mensch aus Regel 1,
 * und sein Weg (`awb:input` aus dem Renderer) laeuft weiter ohne Rueckfrage. Ein
 * Unterprozess je Tastendruck waere dort ohnehin falsch.
 *
 * FAIL-CLOSED: laesst sich das Werkzeug nicht ausfuehren, gilt die Antwort als Nein.
 *
 * UND DIE FRAGE GEHT AN DIE RICHTIGE MASCHINE (10.08.). Eine Pane-Kennung ist
 * nur zusammen mit ihrem tmux-Server eindeutig: `%0` gibt es hier und drueben,
 * und es sind zwei verschiedene Panes. Seit das Terminal einer fernen Sitzung
 * gezeichnet wird, laufen `type` und `key` gegen ferne Kennungen -- die hiesige
 * Frage waere dann im besten Fall ein Nein aus Unkenntnis (der Pane existiert
 * hier nicht) und im schlimmsten die ANTWORT EINES FREMDEN PANES: ein hiesiger
 * Worker-Pane derselben Nummer gaebe ein Ja fuer einen fernen Orchestrator.
 * Also wird drueben gefragt, mit demselben Werkzeug und ueber dieselbe eine
 * Stelle wie jeder andere ferne Griff (`fernAufruf`).
 */
/**
 * NUR DAS JA WIRD GEMERKT, UND NUR FUER SEKUNDEN (16.08.).
 *
 * Die Frage kostet einen Unterprozess -- gemessen 0,16 s oertlich, fern kommt
 * eine ssh-Runde dazu --, und sie steht vor JEDEM Tastendruck ueber den
 * Steuerkanal. Eine Automation, die einen Satz tippt, bezahlt ihn zeichenweise.
 *
 * WARUM DAS DIE ABSCHIRMUNG NICHT AUFWEICHT, Punkt fuer Punkt:
 *   * Das NEIN wird nie gemerkt. Ein Orchestrator-Pane wird bei jedem einzelnen
 *     Tastendruck neu gefragt -- die teure Seite ist genau die, die schuetzt,
 *     und sie bleibt teuer.
 *   * Gemerkt wird nur, was `wb-pane-write darf` fuer DIESEN Pane an DIESEM
 *     Server gesagt hat: der Schluessel traegt Maschine und Socket mit. Die
 *     Haertung vom 10.08. (eine Pane-Kennung ist nur zusammen mit ihrem Server
 *     eindeutig) bleibt damit unangetastet.
 *   * Die Antwort haengt an zwei Dingen: der Rolle des Panes (@wb_role, gesetzt
 *     beim Anlegen) und der Herkunft des Fragenden (dieser Prozess, unveraendert
 *     ueber seine ganze Laufzeit). Ein Worker-Pane wird nicht zum Orchestrator.
 *     Was sich aendern KANN, ist die Bedeutung einer Kennung nach einem
 *     Neustart des tmux-Servers -- dann faengt %0 wieder von vorn an. Genau
 *     dagegen stehen die drei Sekunden UND das Leeren beim Anhaengen
 *     (`attachTmux`): einen Server-Neustart ueberlebt der Steuerclient nicht,
 *     und das Fenster haengt danach neu an.
 */
const DARF_GEDAECHTNIS_MS = 3000;
const darfGedaechtnis = new Map<string, number>();

function darfGedaechtnisLeeren(): void {
  darfGedaechtnis.clear();
}

function steuerkanalDarfSchreiben(paneId: string, was: string): void {
  // Drueben gilt der dortige PATH und nicht unser Testhaken: `wb-pane-write`
  // liegt auf beiden Maschinen in `~/.local/bin` (gemessen am 09.08.), ein
  // hiesiger Pfad zeigte dort ins Leere.
  const argv = attachMaschine
    ? fernAufruf(attachMaschine, ['wb-pane-write', 'darf', paneId])
    : [config.wbPaneWriteBin, ...(config.tmuxSocket ? ['-L', config.tmuxSocket] : []), 'darf', paneId];
  const schluessel = JSON.stringify([attachMaschine, config.tmuxSocket, paneId]);
  const seit = darfGedaechtnis.get(schluessel);
  if (seit !== undefined && Date.now() - seit < DARF_GEDAECHTNIS_MS) return;
  if (seit !== undefined) darfGedaechtnis.delete(schluessel);
  // FRIST (2026-08-20, dieselbe Fehlerklasse wie beim Beenden): dieser Aufruf
  // steht vor JEDEM Tippen in einen Pane -- ohne Grenze haette ein haengendes
  // wb-pane-write (oertlich) oder eine tote Fernmaschine (ssh) den gesamten
  // Hauptprozess angehalten, nicht nur diesen einen Tastendruck. Dieselbe
  // Grenze wie bei den anderen machinenabhaengigen Aufrufen dieser Datei
  // (config.remoteTimeoutMs + 2000 fuer eine Fernmaschine, sonst 2s oertlich).
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: attachMaschine ? config.remoteTimeoutMs + 2000 : 2000 });
  if (r.status === 0) {
    darfGedaechtnis.set(schluessel, Date.now());
    return;
  }
  const wo = attachMaschine ? ` auf ${attachMaschine}` : '';
  const grund = (r.stderr || '').trim() || (r.error ? r.error.message : `Exitcode ${r.status}`);
  throw new Error(
    `'${was}' abgelehnt: der Steuerkanal tippt nicht in Pane ${paneId}${wo}. ${grund}`,
  );
}

interface MenuBaumEintrag {
  label: string;
  role?: string;
  type: string;
  accelerator?: string | null;
  submenu?: MenuBaumEintrag[];
}

/** `Menu.getApplicationMenu()` als reines JSON -- siehe 'menu-dump' unten. */
function menuBaum(menu: Menu | null): MenuBaumEintrag[] {
  if (!menu) return [];
  return menu.items.map((it) => ({
    label: it.label,
    role: it.role,
    type: it.type,
    accelerator: it.accelerator,
    submenu: it.submenu ? menuBaum(it.submenu) : undefined,
  }));
}

async function handle(req: ControlRequest): Promise<unknown> {
  // KEIN BEFEHL GREIFT IN EINEN RENDERER, DER NICHT MEHR DA IST (Prueferbefund
  // vom 05.09.2026). Fast jeder Befehl unter dieser Verzweigung liest oder
  // klickt am Ende ueber `executeJavaScript` im Fenster, und genau dieser Ruf
  // loest sein Versprechen nie mehr auf, wenn der Frame fort ist (Herleitung
  // bei `rendererErreichbar`). Diese eine Zeile fragt vorher -- und wartet
  // kurz, weil der Zuhoerer bei der Fenstererzeugung den Renderer nach einem
  // Absturz von selbst zurueckholt.
  //
  // DREI AUSNAHMEN, jede notwendig: `ping` soll gerade dann antworten, wenn
  // sonst nichts mehr geht -- es ist die Frage „lebst du ueberhaupt noch?" --,
  // `quit` muss ein Programm ohne Renderer erst recht beenden koennen, und
  // `reload` ist der Befehl, der den Renderer ZURUECKHOLT; ihn auf einen
  // lebenden Renderer warten zu lassen waere ein Kreis ohne Ausgang.
  //
  // UND IM MANTELBETRIEB WIRD GAR NICHT GEWARTET (06.09., Auftrag 4.1): dort
  // ist „kein Renderer" der Dauerzustand und kein Ausfall. Fuenf Sekunden auf
  // ein Fenster zu warten, das dieser Prozess nie baut, machte jeden Befehl
  // langsam und die Auskunft am Ende falsch („in 5000 ms nicht
  // wiedergekommen"). Wer trotzdem in den Renderer greift, faellt eine Zeile
  // spaeter auf seine eigene Pruefung (`if (!win) throw KEIN_RENDERER`) --
  // sofort und mit dem richtigen Satz; alles andere (state, sessions, type,
  // select …) lebt im Kern und laeuft weiter.
  if (!mantelBetrieb && !STEUERBEFEHLE_OHNE_RENDERER.has(req.cmd) && !rendererErreichbar()) await rendererZurueck();
  switch (req.cmd) {
    case 'ping':
      return { pong: true };

    case 'state': {
      const text = await bufferText().catch(() => '');
      return {
        pid: process.pid,
        uptimeMs: Date.now() - started,
        headless: config.headless,
        windowVisible: win ? win.isVisible() : false,
        // WIEVIELE Fenster dieses Programm gerade hat (13.08.). Die Zahl ist
        // die Messgroesse fuer „die Chat-Sitzung macht kein eigenes Fenster
        // mehr auf": vorher und nachher gefragt, muss sie dieselbe sein. Sie
        // absolut zu pruefen taeuschte -- ein frischer Start baut den gefuehrten
        // ersten Start immer mit, und der ist ein zweites Fenster, das mit
        // Chat-Sitzungen nichts zu tun hat.
        fenster: BrowserWindow.getAllWindows().length,
        // Muss immer false sein: das Fenster nimmt niemandem den Fokus.
        windowFocused: win ? win.isFocused() : false,
        contentSize: win ? win.getContentSize() : [0, 0],
        // DER FENSTERTITEL (03.09.2026). Die Dev-Fassung haengt „--
        // Entwicklungsfassung" an, damit zwei gleich aussehende Fenster
        // unterscheidbar sind (siehe `page-title-updated` weiter oben). Ohne
        // diese Auskunft liesse sich das kopflos gar nicht pruefen: ein Titel
        // ist nichts, was auf einem Selbstfoto der Zeichenflaeche steht.
        fenstertitel: win ? win.getTitle() : '',
        // Der Ansichtszustand aus ui.json (sidebarWidth, blattBreite, sort …),
        // wie er JETZT gilt -- damit eine Suite den Stand liest, den der Mantel
        // oder der Renderer gemeldet hat (Mac-Auftrag 2.8), ohne die Datei zu oeffnen.
        ui: ui.get(),
        controlSocket: config.controlSocket,
        // Wer diese Antwort liest, hat einen Kanal -- die Angabe steht trotzdem
        // hier, damit `state` eine vollstaendige Auskunft ueber den Start gibt.
        kanalFehler,
        // 07.08.: womit dieses Programm seine Werkzeuge sucht, und ob es die
        // zwei findet, an denen der Finder-Start gescheitert ist. Aus dem
        // Finder heraus gibt es kein Terminal, in dem man das nachsehen
        // koennte -- also steht es in der Auskunft.
        pfad: process.env.PATH ?? '',
        pfadShell: pfadStand.shell,
        pfadDazu: pfadStand.dazu,
        pfadLocale: pfadStand.locale,
        pfadFehler: pfadStand.fehler,
        tmuxBin: findetWerkzeug('tmux'),
        wbCodeBin: findetWerkzeug('wb-code'),
        tmuxAusfuehrbar: tmuxBefund.ausfuehrbar,
        tmuxFehler: tmuxBefund.fehler,
        tmuxSocket: config.tmuxSocket,
        shotDir: config.shotDir,
        machine: config.machine,
        // Im Takt gelesen (06.08.), nicht mehr beim Start: die Auskunft zeigt
        // damit die Schwelle, die JETZT gilt.
        stallSeconds: stallSekundenJetzt(),
        // Die Maschinenliste, mit der der Poller gerade arbeitet -- damit eine
        // Aenderung ohne Neustart messbar ist.
        remoteHosts: remotePoller.hostliste(),
        session: attachState?.session ?? '',
        sizePolicy: attachState?.sizePolicy ?? '',
        // B2: ob tmux unseren Steuerclient aus der Groessenrechnung genommen
        // hat. Steht false, friert eine fremde Session wieder ein.
        sizeIgnored: attachState?.sizeIgnored ?? false,
        cols: attachState?.cols ?? 0,
        rows: attachState?.rows ?? 0,
        windows: attachState?.windows ?? [],
        panes: attachState?.panes ?? [],
        streamPane,
        attached: !!tmux && !attachError,
        attachError,
        // Auf welcher Maschine die gezeichnete Sitzung laeuft (leer: hier) --
        // und ob der Steuerkanal wirklich dorthin geht. Zwei Angaben und nicht
        // eine: die erste sagt, was gewaehlt wurde, die zweite, was steht.
        attachMaschine,
        attachFern: !!tmux?.istFern(),
        bufferText: text,
        // Nur der sichtbare Schirm -- fuer den Vergleich mit `capture-pane -p`.
        schirmText: await schirmText().catch(() => ''),
      };
    }

    // NUR FUER DEN NACHWEIS (Fenster-Auftrag Punkt 2): die Menueleiste laesst
    // sich kopflos nicht ansehen -- `--kopflos` setzt ohnehin `null`, und
    // selbst mit `--show-inaktiv` faellt kein Bildschirmfoto ab, das ein
    // Menue zeigt (es klappt erst nach einem echten Klick auf). Dieser Weg
    // liest stattdessen `Menu.getApplicationMenu()` direkt und gibt sie als
    // Baum zurueck -- dieselbe Auskunft, die eine spaetere Regression prueft.
    case 'menu-dump':
      return { menu: menuBaum(Menu.getApplicationMenu()) };

    case 'seite': {
      // Schritt 7 ueber den Steuerkanal: eine Seite zeichnen und ihren
      // gerenderten Zustand zurueckgeben -- pruefbar ohne Foto.
      const name = String(req.name ?? 'start') as SeitenName;
      if (name !== 'start' && name !== 'einstellungen') throw new Error(`unbekannte Seite: ${name}`);
      sessions = modellLesen();
      const html = seiteHtml(name);
      seiteOffen = name;
      anOberflaeche('awb:seite', { name });
      // Der Rahmen laedt die Seite selbst ueber das Schema; hier wird nur
      // gewartet, bis sie steht.
      await win?.webContents.executeJavaScript(
        'new Promise((r) => setTimeout(() => r(true), 400))',
      );
      await win?.webContents.executeJavaScript(
        'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
      );
      // Optional zu einem Abschnitt rollen -- fuer die Abnahme am Auge an einer
      // Stelle, die nicht am Seitenanfang steht.
      const zu = String(req.zu ?? '');
      if (zu) {
        await win?.webContents.executeJavaScript(`window.__awb.seiteRollen(${JSON.stringify(zu)})`).catch(() => false);
        await win?.webContents.executeJavaScript(
          'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
        );
      }
      const gezeichnet = await win?.webContents.executeJavaScript('window.__awb.seitenState()').catch(() => null);
      return { name, laenge: html.length, gezeichnet, letzteNachricht: letzteSeitenNachricht, letzterPlan, letzterAusgang };
    }

    case 'seiten-fokus': {
      // Nur fuer die Pruefung der Auffrischung: `el.click()` bewegt bei einem
      // Textfeld den Fokus nicht zuverlaessig -- ein eigener, direkter Weg.
      const auswahl = String(req.knopf ?? '');
      if (!auswahl) throw new Error('Feld knopf fehlt');
      if (!win) throw new Error(KEIN_RENDERER);
      const getroffen = (await win.webContents.executeJavaScript(
        `window.__awb.seiteFokus(${JSON.stringify(auswahl)})`,
      )) as boolean;
      return { getroffen };
    }

    case 'seiten-unfokus': {
      // Nur fuer die Pruefung der Auffrischung: ein fokussiertes Feld gezielt
      // verlassen, ohne auf die Nebenwirkungen eines anderen Knopfs angewiesen
      // zu sein.
      if (!win) throw new Error(KEIN_RENDERER);
      const getroffen = (await win.webContents.executeJavaScript('window.__awb.seiteUnfokus()')) as boolean;
      return { getroffen };
    }

    case 'seiten-schliessen-klick': {
      // Nur fuer die Pruefung: die ECHTE Schliessen-Schaltflaeche im Rahmen
      // anklicken (nicht seiteOffen von Hand zuruecksetzen) -- derselbe Weg,
      // den ein Mensch im Fenster geht.
      if (!win) throw new Error(KEIN_RENDERER);
      const getroffen = (await win.webContents.executeJavaScript('window.__awb.seiteSchliessenKlick()')) as boolean;
      return { getroffen };
    }

    case 'seiten-nachricht': {
      // Testgegenstueck zu 'seiten-nachricht' im Live-Kanal (awb:bedienung) --
      // dieselben zwei Funktionen (plane/planSofort), damit sich 'refresh' und
      // die anderen Sofort-Plaene auch ohne eine echte Seite mit eigenem
      // Knopf pruefen lassen.
      const plan = plane({ command: String(req.command ?? '') }, befehlsUmgebung());
      letzterPlan = plan;
      if (plan.art === 'sofort') await planSofort(plan);
      else anOberflaeche('awb:plan', plan);
      return { plan };
    }

    case 'seiten-zustand': {
      // Nur LESEN, was der Rahmen gerade zeigt -- anders als 'seite' wird hier
      // NICHTS neu gezeichnet. Der einzige Weg, eine automatische Auffrischung
      // (Dateiwaechter, Reste-Auftrag Punkt 3) von einer durch den Steuerkanal
      // selbst ausgeloesten zu unterscheiden.
      const gezeichnet = await win?.webContents.executeJavaScript('window.__awb.seitenState()').catch(() => null);
      return { gezeichnet };
    }

    case 'seiten-klick': {
      // Einen Knopf der uebernommenen Seite wirklich anklicken -- ueber seine
      // CSS-Auswahl, im Rahmen. Damit laesst sich die Verdrahtung pruefen wie
      // ein Mensch sie bedient, statt die Nachricht nachzubauen.
      const auswahl = String(req.knopf ?? '');
      if (!auswahl) throw new Error('Feld knopf fehlt');
      if (!win) throw new Error(KEIN_RENDERER);
      const getroffen = (await win.webContents.executeJavaScript(
        `window.__awb.seiteKlick(${JSON.stringify(auswahl)})`,
      )) as boolean;
      await win.webContents.executeJavaScript(
        'new Promise((r) => setTimeout(() => requestAnimationFrame(() => r(true)), 150))',
      );
      const gezeichnet = await win.webContents.executeJavaScript('window.__awb.seitenState()').catch(() => null);
      return { knopf: auswahl, getroffen, plan: letzterPlan, gezeichnet };
    }

    // --- Einstellungsfenster (A9) ------------------------------------------
    //
    // KEIN BEFEHL HIER ERREICHT show(). Das Fenster laesst sich von hier aus
    // bauen, lesen, umblaettern und fotografieren -- sichtbar machen nicht.
    // Genau das ist die Auflage aus diesem Haus: es geht auf, weil ein Mensch
    // geklickt hat (renderer.ts prueft `isTrusted`), nie weil ein Test oder ein
    // Agent es anfordert.
    case 'einstellungen': {
      const w = await einstellungsfenster.baue();
      const seite = String(req.seite ?? '');
      if (seite) {
        const getroffen = (await w.webContents.executeJavaScript(
          `window.__awbEin.zeige(${JSON.stringify(seite)})`,
        )) as boolean;
        if (!getroffen) throw new Error(`unbekannte Seite: ${seite}`);
      }
      await w.webContents.executeJavaScript(
        'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
      );
      const zustand = await w.webContents.executeJavaScript(`({
        seiten: window.__awbEin.seiten(),
        offen: window.__awbEin.offen(),
        text: window.__awbEin.text(),
        status: window.__awbEin.status(),
        modelle: window.__awbEin.modelle(),
        // Die drei Ebenen jeder Einstellung und das, was das Infozeichen
        // gerade zeigt. Beides ist nur ueber diesen Kanal pruefbar: am Bild
        // sieht man einen Kasten, aber nicht, ob er wirklich Hoehe hat.
        felder: window.__awbEin.felder(),
        info: window.__awbEin.info(),
      })`);
      return {
        // Die Auskunft, an der die Auflage haengt: gebaut ja, sichtbar nein.
        sichtbar: w.isVisible(),
        bereit: einstellungenBereit,
        groesse: w.getContentSize(),
        ...(zustand as Record<string, unknown>),
      };
    }

    case 'einstellungen-klick': {
      // Ein Bedienelement IM Einstellungsfenster anklicken, ueber seine
      // CSS-Auswahl -- so, wie ein Mensch es bedient.
      const auswahl = String(req.knopf ?? '');
      if (!auswahl) throw new Error('Feld knopf fehlt');
      const w = await einstellungsfenster.baue();
      const getroffen = (await w.webContents.executeJavaScript(
        `window.__awbEin.klick(${JSON.stringify(auswahl)})`,
      )) as boolean;
      await w.webContents.executeJavaScript(
        'new Promise((r) => setTimeout(() => requestAnimationFrame(() => r(true)), 200))',
      );
      const status = (await w.webContents.executeJavaScript('window.__awbEin.status()')) as string;
      return { knopf: auswahl, getroffen, status, sichtbar: w.isVisible() };
    }

    case 'einstellungen-zustand': {
      // NUR LESEN. Der Unterschied zu 'einstellungen-klick' ist der ganze Zweck:
      // ob ein Haken steht, laesst sich nicht dadurch beantworten, dass man ihn
      // drueckt.
      const auswahl = String(req.knopf ?? '');
      if (!auswahl) throw new Error('Feld knopf fehlt');
      const w = await einstellungsfenster.baue();
      const zustand = await w.webContents.executeJavaScript(
        `window.__awbEin.zustand(${JSON.stringify(auswahl)})`,
      );
      return { knopf: auswahl, ...(zustand as Record<string, unknown>) };
    }

    case 'einstellungen-blaettern': {
      // Eine lange Seite an eine bestimmte Stelle rollen. Gebraucht fuer
      // Belegbilder: ein Fenster von 700 Pixeln Hoehe zeigt die Guard-Liste
      // sonst nie, und ein Beleg, der die untere Haelfte auslaesst, belegt sie
      // auch nicht.
      const auswahl = String(req.knopf ?? '');
      if (!auswahl) throw new Error('Feld knopf fehlt');
      const w = await einstellungsfenster.baue();
      const getroffen = (await w.webContents.executeJavaScript(`(() => {
        const e = document.querySelector(${JSON.stringify(auswahl)});
        if (!e) return false;
        e.scrollIntoView({ block: 'start' });
        return true;
      })()`)) as boolean;
      await w.webContents.executeJavaScript(
        'new Promise((r) => setTimeout(() => requestAnimationFrame(() => r(true)), 150))',
      );
      return { knopf: auswahl, getroffen, sichtbar: w.isVisible() };
    }

    case 'einstellungen-eingabe': {
      // In ein Textfeld oder Zahlenfeld schreiben -- so, wie ein Mensch tippt
      // und das Feld danach verlaesst. Ein `value = …` allein loest nichts
      // aus; das Ereignis 'change' ist der Weg, den auch die Tastatur nimmt.
      const auswahl = String(req.knopf ?? '');
      const wert = String(req.wert ?? '');
      if (!auswahl) throw new Error('Feld knopf fehlt');
      const w = await einstellungsfenster.baue();
      const getroffen = (await w.webContents.executeJavaScript(`(() => {
        const e = document.querySelector(${JSON.stringify(auswahl)});
        if (!e) return false;
        e.value = ${JSON.stringify(wert)};
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`)) as boolean;
      await w.webContents.executeJavaScript(
        'new Promise((r) => setTimeout(() => requestAnimationFrame(() => r(true)), 200))',
      );
      const status = (await w.webContents.executeJavaScript('window.__awbEin.status()')) as string;
      return { knopf: auswahl, wert, getroffen, status, sichtbar: w.isVisible() };
    }

    case 'einstellungen-schuss': {
      // Ein Belegbild des Einstellungsfensters. capturePage() arbeitet auf
      // einem nie gezeigten Fenster -- dieselbe Grundlage wie shot.ts, und der
      // Grund, warum die Bilder entstehen koennen, ohne dass ein Fenster auf
      // einem Bildschirm erscheint.
      const w = await einstellungsfenster.baue();
      const seite = String(req.seite ?? '');
      if (seite) {
        await w.webContents.executeJavaScript(`window.__awbEin.zeige(${JSON.stringify(seite)})`);
      }
      const r = await captureWindow(w, config.shotDir, req.datei ? String(req.datei) : undefined);
      return { ...r, sichtbar: w.isVisible() };
    }

    case 'verbrauch-schuss': {
      // Ein Belegbild des Verbrauchsfensters, nach demselben Muster wie
      // 'einstellungen-schuss' und 'sitzung-schuss': capturePage() auf einem
      // nie gezeigten Fenster. Das Fenster hat EINE Seite, es gibt hier also
      // nichts zu waehlen; hell und dunkel stellt man vorher im
      // Einstellungsfenster ein, wie ein Mensch es auch taete.
      const w = await verbrauchsfenster.baue();
      const auswahl = String(req.knopf ?? '');
      if (auswahl) {
        // Dieselbe Rolle wie 'einstellungen-blaettern': eine lange Seite an die
        // Stelle rollen, die belegt werden soll. Ein Beleg, der nur den Kopf
        // zeigt, belegt auch nur den Kopf.
        await w.webContents.executeJavaScript(`(() => {
          const e = document.querySelector(${JSON.stringify(auswahl)});
          if (!e) return false;
          e.scrollIntoView({ block: 'start' });
          return true;
        })()`);
      }
      await w.webContents.executeJavaScript(
        'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
      );
      const r = await captureWindow(w, config.shotDir, req.datei ? String(req.datei) : undefined);
      return { ...r, sichtbar: w.isVisible() };
    }

    /**
     * EINE STELLE DER VERBRAUCHSSEITE LESEN (08.09.2026). Bisher liess sich
     * dieses Fenster nur fotografieren; damit ist eine Zusage ueber einen
     * WORTLAUT nur aus einem Bild zu holen, und das taugt nicht. Dieselbe
     * Bauart wie 'einstellungen-zustand': bauen, lesen, nichts anfassen --
     * `show()` erreicht auch dieser Befehl nicht.
     *
     * Gelesen werden Text, Hilfeschildchen und `data-grund`. Das Schildchen
     * traegt bei der Kontingent-Meldung den Rohtext des Werkzeugs, der seit
     * dem 08.09. nicht mehr in der Zeile selbst steht.
     */
    case 'verbrauch-lesen': {
      const auswahl = String(req.knopf ?? '');
      if (!auswahl) throw new Error('verbrauch-lesen braucht eine CSS-Auswahl');
      const w = await verbrauchsfenster.baue();
      const r = (await w.webContents.executeJavaScript(`(() => {
        const e = document.querySelector(${JSON.stringify(auswahl)});
        if (!e) return null;
        return { text: (e.textContent || '').trim(), titel: e.title || '', grund: (e.dataset && e.dataset.grund) || '' };
      })()`)) as { text: string; titel: string; grund: string } | null;
      if (!r) throw new Error(`kein Element '${auswahl}' im Verbrauchsfenster`);
      return { auswahl, ...r };
    }

    // --- Sitzungsfenster ---------------------------------------------------
    //
    // Wieder gilt: KEIN BEFEHL HIER ERREICHT show(). Bauen, lesen, tippen,
    // klicken und fotografieren -- sichtbar machen nicht. Ohne diese fuenf
    // Befehle waere das Fenster kopflos nicht pruefbar, und kopflos ist der
    // einzige erlaubte Pruefweg.
    case 'sitzung': {
      const w = await sitzungsfenster.baue();
      await w.webContents.executeJavaScript(
        'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
      );
      const zustand = await w.webContents.executeJavaScript(`({
        text: window.__awbSitzung.text(),
        status: window.__awbSitzung.status(),
        gruppen: window.__awbSitzung.gruppen(),
        sitzungen: window.__awbSitzung.sitzungen(),
      })`);
      return {
        // Die Auskunft, an der die Auflage haengt: gebaut ja, sichtbar nein.
        sichtbar: w.isVisible(),
        bereit: sitzungBereit,
        groesse: w.getContentSize(),
        ...(zustand as Record<string, unknown>),
      };
    }

    case 'sitzung-klick': {
      // Ein Bedienelement IM Sitzungsfenster anklicken, ueber seine CSS-Auswahl
      // -- so, wie ein Mensch es bedient. Der Klick traegt `isTrusted === false`
      // und kann das Fenster deshalb nicht sichtbar machen.
      const auswahl = String(req.knopf ?? '');
      if (!auswahl) throw new Error('Feld knopf fehlt');
      const w = await sitzungsfenster.baue();
      const getroffen = (await w.webContents.executeJavaScript(
        `window.__awbSitzung.klick(${JSON.stringify(auswahl)})`,
      )) as boolean;
      await w.webContents.executeJavaScript(
        'new Promise((r) => setTimeout(() => requestAnimationFrame(() => r(true)), 200))',
      );
      const zustand = await w.webContents.executeJavaScript(`({
        status: window.__awbSitzung.status(),
        gruppen: window.__awbSitzung.gruppen(),
        sitzungen: window.__awbSitzung.sitzungen(),
      })`);
      return { knopf: auswahl, getroffen, sichtbar: w.isVisible(), ...(zustand as Record<string, unknown>) };
    }

    case 'sitzung-zustand': {
      // NUR LESEN. Ob ein Knopf gesperrt ist, laesst sich nicht dadurch
      // beantworten, dass man ihn drueckt.
      const auswahl = String(req.knopf ?? '');
      if (!auswahl) throw new Error('Feld knopf fehlt');
      const w = await sitzungsfenster.baue();
      const zustand = await w.webContents.executeJavaScript(
        `window.__awbSitzung.zustand(${JSON.stringify(auswahl)})`,
      );
      return { knopf: auswahl, ...(zustand as Record<string, unknown>) };
    }

    case 'sitzung-eingabe': {
      // In das Namensfeld schreiben -- so, wie ein Mensch tippt und das Feld
      // danach verlaesst. Ein `value = …` allein loest nichts aus.
      const auswahl = String(req.knopf ?? '');
      const wert = String(req.wert ?? '');
      if (!auswahl) throw new Error('Feld knopf fehlt');
      const w = await sitzungsfenster.baue();
      const getroffen = (await w.webContents.executeJavaScript(`(() => {
        const e = document.querySelector(${JSON.stringify(auswahl)});
        if (!e) return false;
        e.value = ${JSON.stringify(wert)};
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`)) as boolean;
      await w.webContents.executeJavaScript(
        'new Promise((r) => setTimeout(() => requestAnimationFrame(() => r(true)), 150))',
      );
      const status = (await w.webContents.executeJavaScript('window.__awbSitzung.status()')) as string;
      return { knopf: auswahl, wert, getroffen, status, sichtbar: w.isVisible() };
    }

    // --- Das Kontextmenue der Sessionleiste --------------------------------
    //
    // KEIN BEFEHL HIER KLAPPT ETWAS AUF. `Menu.popup` haengt am echten
    // Rechtsklick im Fenster (siehe 'awb:sitzung-menue'); der Steuerkanal darf
    // die Vorlage LESEN und einen Punkt AUSLOESEN. Damit ist alles pruefbar
    // ausser dem Aufklappen selbst -- genau wie beim show()-Zweig der Fenster.
    case 'rechtsklick': {
      // Ein `contextmenu`-Ereignis auf der ECHTEN Zeile der Sessionleiste --
      // so, wie ein Mensch die rechte Maustaste drueckt, nur synthetisch. Genau
      // darum geht es: das Ereignis traegt `isTrusted === false`, und damit
      // laesst sich pruefen, dass KEIN Menue aufklappt. Einen Weg zu einem
      // echten Rechtsklick gibt es hier bewusst nicht.
      const kennung = String(req.session ?? '');
      if (!kennung) throw new Error('Feld session fehlt');
      if (!win) throw new Error(KEIN_RENDERER);
      // BEIDE Sorten: eine Terminal-Zeile traegt `data-id`, eine Chat-Zeile
      // `data-chat` -- seit sie in derselben Liste stehen (Punkt 4), muss auch
      // dieser Griff beide finden.
      const getroffen = (await win.webContents.executeJavaScript(`(() => {
        const k = ${JSON.stringify(kennung)};
        const e = document.querySelector('.eintrag[data-id=' + JSON.stringify(k) + ']')
          || document.querySelector('.eintrag[data-chat=' + JSON.stringify(k) + ']');
        if (!e) return false;
        e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        return true;
      })()`)) as boolean;
      if (!getroffen) throw new Error(`keine Zeile zu '${kennung}' in der Leiste`);
      await new Promise((r) => setTimeout(r, 200));
      return { session: kennung, getroffen };
    }

    case 'sitzung-menue': {
      sessions = modellLesen();
      const kennung = String(req.session ?? '');
      // Eine Chat-Sitzung hat ihre eigene, kuerzere Vorlage (Punkt 4). Sie
      // laeuft ueber denselben Befehl, weil die Leiste EINE Liste ist.
      if (istChat(kennung)) {
        const c = chatRegistry.einer(kennung);
        if (!c) throw new Error(`keine Chat-Sitzung '${kennung}'`);
        return {
          session: c.id,
          name: c.name,
          art: 'chat',
          laeuft: chatbuehne.laufende().includes(c.id),
          punkte: chatMenueVorlage(),
        };
      }
      const s = sessions.find((x) => x.id === kennung || x.name === kennung || x.tmuxSession === kennung);
      if (!s) throw new Error(`keine Session '${kennung}'`);
      // Die Zahl der Clients steht weiter in der Auskunft -- sie sperrt jetzt
      // nichts mehr, aber sie sagt einer Pruefung, in welcher Lage gemessen wurde.
      const clients = gruppeAngehaengt(config.tmuxSocket, s.tmuxSession);
      return { session: s.id, name: s.name, state: s.state, clients, punkte: menueVorlage(s) };
    }

    case 'sitzung-menue-punkt': {
      sessions = modellLesen();
      const kennung = String(req.session ?? '');
      const punkt = String(req.punkt ?? '');
      if (!punkt) throw new Error('Feld punkt fehlt');
      if (istChat(kennung)) {
        const r = await chatMenuePunktAusfuehren(kennung, punkt, false);
        return { session: kennung, punkt, gelungen: r.ok, meldung: r.meldung, aufruf: r.aufruf };
      }
      const s = sessions.find((x) => x.id === kennung || x.name === kennung || x.tmuxSession === kennung);
      if (!s) throw new Error(`keine Session '${kennung}'`);
      // `echt: false` -- ueber diesen Weg steht nie ein Mensch. Eine Rueckfrage
      // faellt damit auf die Attrappe zurueck, und ohne sie wird abgebrochen.
      const r = await menuePunktAusfuehren(s.id, punkt, false);
      // `gelungen` statt `ok`: ein eigenes `ok: false` wuerde die Huelle des
      // Steuerkanals (`{ ok: true, ...ergebnis }`) schlagen, und awb-ctl haelte
      // die Antwort fuer einen Fehler des Kanals -- dieselbe Falle wie bei
      // 'editor', dort steht die lange Fassung.
      return { session: s.id, punkt, gelungen: r.ok, meldung: r.meldung, aufruf: r.aufruf };
    }

    case 'umbenennen': {
      sessions = modellLesen();
      const kennung = String(req.session ?? '');
      if (istChat(kennung)) {
        const r = await sitzungUmbenennen(kennung, String(req.name ?? ''));
        return { session: kennung, gelungen: r.ok, meldung: r.meldung, aufruf: r.aufruf };
      }
      const s = sessions.find((x) => x.id === kennung || x.name === kennung || x.tmuxSession === kennung);
      if (!s) throw new Error(`keine Session '${kennung}'`);
      const r = await sitzungUmbenennen(s.id, String(req.name ?? ''));
      // `gelungen` statt `ok` -- siehe 'sitzung-menue-punkt'.
      return { session: s.id, gelungen: r.ok, meldung: r.meldung, aufruf: r.aufruf };
    }

    // --- Die Chat-Sitzung ueber den Steuerkanal (12.08., umgebaut 13.08.) ----
    //
    // Dieselben Griffe wie beim Sitzungsfenster -- lesen, klicken,
    // fotografieren --, nur zielen sie jetzt auf die Buehne des HAUPTFENSTERS
    // statt auf ein eigenes Fenster (chatbuehne.ts, Klassendoc). Die alte
    // Auflage „`baue()` statt `zeige()`" ist damit hinfaellig: es gibt kein
    // Fenster mehr, das ein Test auf einen Bildschirm bringen koennte. Was
    // bleibt, ist nachpruefbar -- `chat-schuss` meldet die Sichtbarkeit des
    // Hauptfensters UND die Zahl der Fenster mit, und beide Zahlen stehen in
    // shell/tests/test-app-chatsdk-oberflaeche.sh als Zusage.
    //
    // Dazu zwei Griffe, die das Sitzungsfenster nicht braucht: `chat-stand`
    // setzt einen fertigen Gespraechsstand in die Ansicht, ohne dass ein
    // echter Claude-Prozess laeuft (deshalb kostet der Sichtbeleg dieser
    // Ansicht kein Geld und laeuft in jeder Umgebung durch), und `chat-buehne`
    // sagt, WAS gerade auf der Buehne liegt -- die Auskunft, mit der sich
    // belegen laesst, dass eine Terminal-Sitzung danach wieder ihre Kacheln
    // zeigt.
    case 'chat-liste': {
      return {
        chats: chatRegistry.alle().map((c) => ({
          id: c.id, name: c.name, ordner: c.ordner, sessionId: c.sessionId,
          modus: c.modus,
          laeuft: chatbuehne.laufende().includes(c.id),
          // GENAU SO, WIE DAS MODELL ES RECHNET (Reviewbefund 3): frisch nur
          // fuer die gezeigte Sitzung. Damit laesst sich pruefen, dass eine
          // nicht gezeigte Sitzung je Takt KEIN tmux anfasst -- ein eigener,
          // freundlicherer Weg hier wuerde genau das verdecken.
          worker: chatbuehne.workerVon(c.id, c.id === chatbuehne.gezeigter()),
        })),
      };
    }

    case 'chat-anlegen': {
      // Nur fuer Tests und den Steuerkanal: eine Chat-Sitzung OHNE
      // Ordnerdialog anlegen. Der Ordner muss mitkommen -- geraten wird
      // keiner, und ein leerer waere ein Prozess im falschen Verzeichnis.
      const ordner = String(req.ordner ?? '');
      if (!ordner) throw new Error('Feld ordner fehlt');
      const eintrag = chatRegistry.anlegen({
        id: neueId(Date.now(), Math.random()),
        name: String(req.name ?? '') || nameAusOrdner(ordner),
        ordner,
        modell: String(req.modell ?? ''),
        modus: String(req.modus ?? ''),
        sessionId: '',
        zuletzt: new Date().toISOString(),
      });
      modellSenden();
      return { id: eintrag.id, name: eintrag.name, ordner: eintrag.ordner };
    }

    case 'chat-haken': {
      // EINEN TESTHAKEN DER BUEHNE ZIEHEN. Die Griffe stehen in
      // renderer/chatbuehne-view.ts (`haken()`); hier steht nur die Zuordnung
      // von Wort zu Griff, damit ein Test kein eigenes JavaScript einschleusen
      // muss -- was ueber diesen Kanal ohnehin nicht ginge.
      const id = String(req.id ?? '');
      const griff = String(req.griff ?? '');
      if (!griff) throw new Error('Feld griff fehlt');
      const w = await chatAufBuehne(id);
      const [name, ...rest] = griff.split(':');
      const wert = rest.join(':');
      let js: string;
      if (name === 'feld') js = `window.__awbChat.feld(${JSON.stringify(wert)})`;
      else if (name === 'taste') js = `window.__awbChat.taste(${JSON.stringify(wert)})`;
      else if (name === 'vervoll') js = 'window.__awbChat.vervoll()';
      else if (name === 'status') js = 'window.__awbChat.status()';
      // NUR FUER TESTS (chatdatei, 05.09.2026): einen Stand zeichnen, ohne dass ein
      // Harness laeuft -- der Haken `zeichne` bestand schon, hier bekommt er sein Wort.
      else if (name === 'zeichne') js = `window.__awbChat.zeichne(${JSON.stringify(JSON.parse(wert))})`;
      else throw new Error(`unbekannter Griff '${name}'`);
      const antwort = await w.webContents.executeJavaScript(js);
      return typeof antwort === 'object' && antwort !== null
        ? { id, griff, ...(antwort as Record<string, unknown>) }
        : { id, griff, wert: antwort };
    }

    case 'chat-worker': {
      // Die Werkstatt einer Chat-Sitzung LESEN und einen ihrer Worker auf die
      // Buehne holen (Punkt 1) -- der Weg, den der kopflose Sichtbeleg geht.
      // Ohne `pane` wird nur gelesen; das ist die Auskunft „wo landen ihre
      // Worker, und welche gibt es".
      const id = String(req.id ?? '');
      if (!id) throw new Error('Feld id fehlt');
      const werkstatt = chatbuehne.werkstattVon(id);
      // Der Steuerkanal fragt FRISCH: er wird von einem Test gerufen, der eben
      // einen Pane angelegt hat, und der zuletzt gelesene Stand kennt ihn nicht.
      const worker = chatbuehne.workerVon(id, true);
      const pane = String(req.pane ?? '');
      if (!pane) return { id, werkstatt, worker, gewechselt: false };
      const gewechselt = await chatWorkerZeigen(id, pane);
      return { id, werkstatt, worker, gewechselt, gezeigt: streamPane };
    }

    case 'chat-buehne': {
      // Was liegt auf der Buehne -- gefragt an BEIDEN Enden. Der Hauptprozess
      // weiss, was er angeordnet hat; die Oberflaeche zeigt, was daraus
      // geworden ist. Nur wenn beide dasselbe sagen, ist die Auskunft etwas
      // wert (ein Modell unterwegs ist noch keine gezeichnete Buehne).
      if (!win) throw new Error(KEIN_RENDERER);
      const dom = await win.webContents.executeJavaScript(
        '(() => { const b = document.getElementById("chatbuehne");'
        + ' if (!b) return { da: false, an: false, chat: "", anzeige: "" };'
        + ' return { da: true, an: b.classList.contains("an"), chat: b.dataset.chat ?? "",'
        + ' anzeige: getComputedStyle(b).display }; })()',
      );
      return { gezeigt: chatbuehne.gezeigter(), ...(dom as Record<string, unknown>) };
    }

    case 'chat-stand': {
      const id = String(req.id ?? '');
      // DIE BUEHNE IST SACHE DES KERNS, das Zeichnen Sache der Oberflaeche
      // (Auftrag 4.1). Deshalb wird zuerst gelegt und erst danach gefragt, ob
      // es hier ueberhaupt einen Renderer gibt: im Mantelbetrieb ist genau
      // dieser Befehl der Weg, mit dem eine Pruefung eine Chat-Sitzung auf die
      // Buehne der MAC-Oberflaeche holt -- sie zeichnet, dieser Prozess nicht.
      await chatAufBuehneLegen(id);
      if (!win) return { id, gezeigt: chatbuehne.gezeigter(), renderer: false };
      const w = win;
      if (req.gespraech !== undefined) {
        // Einen fertigen Stand einsetzen -- die Bloecke kommen alle auf
        // einmal, deshalb `seit: 0` und die Ordnung aus ihnen selbst.
        const g = req.gespraech as { bloecke?: { id: string }[] } & Record<string, unknown>;
        const bloecke = Array.isArray(g.bloecke) ? g.bloecke : [];
        const { bloecke: _weg, ...kopf } = g;
        await w.webContents.executeJavaScript(
          `window.__awbChat.zeichne(${JSON.stringify({
            kopf,
            geaendert: bloecke,
            ordnung: bloecke.map((b) => b.id),
            seit: 0,
            sprache: String(req.sprache ?? sprache(config.settingsFile)),
            laeuft: req.laeuft !== false,
            neustartMoeglich: req.neustartMoeglich === true,
          })})`,
        );
      }
      const stand = await w.webContents.executeJavaScript('window.__awbChat.stand()');
      return { id, ...(stand as Record<string, unknown>) };
    }

    case 'chat-zeiten': {
      // Die gemessenen Zeichenzeiten der Buehne -- die Zahlen hinter dem
      // Beleg zu Befund B1. `leeren` setzt sie zurueck, damit sich zwei
      // Abschnitte eines Gespraechs vergleichen lassen.
      const id = String(req.id ?? '');
      const w = await chatAufBuehne(id);
      if (req.leeren === true) {
        await w.webContents.executeJavaScript('window.__awbChat.zeitenLeeren()');
        return { id, geleert: true, zeiten: [] };
      }
      const zeiten = await w.webContents.executeJavaScript('window.__awbChat.zeiten()');
      return { id, geleert: false, zeiten: zeiten as number[] };
    }

    case 'chat-text': {
      const id = String(req.id ?? '');
      const w = await chatAufBuehne(id);
      const text = await w.webContents.executeJavaScript(
        'document.querySelector(".chatsdk")?.innerText ?? ""',
      );
      return { id, text: String(text) };
    }

    case 'chat-klick': {
      const id = String(req.id ?? '');
      const auswahl = String(req.knopf ?? '');
      if (!auswahl) throw new Error('Feld knopf fehlt');
      const w = await chatAufBuehne(id);
      // `el.click()` traegt `isTrusted === false` -- genau deshalb kann dieser
      // Weg keine echte Bedienung vortaeuschen. Gesucht wird IM Kasten der
      // Buehne: auf einem Bildschirm mit Kacheln daneben soll ein Griff nie
      // versehentlich einen Knopf des Hauptfensters treffen.
      const gelungen = await w.webContents.executeJavaScript(
        `(() => { const b = document.getElementById("chatbuehne");`
        + ` const e = b && b.querySelector(${JSON.stringify(auswahl)});`
        + ' if (!e) return false; e.click(); return true; })()',
      );
      return { id, knopf: auswahl, gelungen: gelungen === true };
    }

    case 'chat-marke': {
      // Ein Element zeichnen und spaeter wiedererkennen -- der Beleg zu Befund
      // B1, dass ein Teilstueck nur seinen eigenen Block anfasst.
      // Siehe shell/tests/test-app-chatsdk-last.sh.
      const id = String(req.id ?? '');
      const auswahl = String(req.auswahl ?? '');
      if (!auswahl) throw new Error('Feld auswahl fehlt');
      const w = await chatAufBuehne(id);
      const wert = req.wert === undefined ? 'undefined' : JSON.stringify(String(req.wert));
      const marke = await w.webContents.executeJavaScript(
        `window.__awbChat.marke(${JSON.stringify(auswahl)}, ${wert})`,
      );
      return { id, auswahl, marke: String(marke) };
    }

    case 'chat-tippen': {
      const id = String(req.id ?? '');
      // Ohne Renderer gibt es kein Eingabefeld, das man leeren koennte -- also
      // geht der Text denselben Weg, den das Feld am Ende auch nimmt
      // (`awb:chat-senden` -> `chatbuehne.senden`). Der Befehl bleibt damit im
      // Mantelbetrieb brauchbar, statt an einer Bedienung zu scheitern, die
      // die Mac-Oberflaeche selbst mitbringt.
      if (!win) {
        await chatAufBuehneLegen(id);
        const gesendet = chatbuehne.senden(id, String(req.text ?? ''));
        return { id, geleert: false, gesendet, renderer: false };
      }
      const w = await chatAufBuehne(id);
      const geleert = await w.webContents.executeJavaScript(
        `window.__awbChat.tippen(${JSON.stringify(String(req.text ?? ''))})`,
      );
      return { id, geleert: geleert === true };
    }

    case 'chat-schuss': {
      const id = String(req.id ?? '');
      const w = await chatAufBuehne(id);
      const r = await captureWindow(w, config.shotDir, req.datei ? String(req.datei) : undefined);
      // `sichtbar` gilt jetzt fuer das HAUPTFENSTER, und `fenster` sagt, wie
      // viele es ueberhaupt gibt: die zwei Zahlen sind der Nachweis, dass
      // dieser Weg weder ein Fenster zeigt noch ein zweites aufmacht.
      return { ...r, sichtbar: w.isVisible(), fenster: BrowserWindow.getAllWindows().length };
    }

    case 'sitzung-schuss': {
      // Ein Belegbild des Sitzungsfensters. capturePage() arbeitet auf einem
      // nie gezeigten Fenster -- dieselbe Grundlage wie shot.ts. Seit das
      // Fenster EINE Seite hat, gibt es hier nichts mehr zu waehlen; was gezeigt
      // wird, stellt man vorher mit `sitzung-klick` ein (etwa eine Gruppe
      // ausklappen).
      const w = await sitzungsfenster.baue();
      const r = await captureWindow(w, config.shotDir, req.datei ? String(req.datei) : undefined);
      return { ...r, sichtbar: w.isVisible() };
    }

    case 'plan-ausfuehren': {
      // Die Zustimmung ueber den Steuerkanal -- derselbe Weg wie der Knopf
      // "Ausfuehren" in der Rueckfrage, damit nicht zwei Wege entstehen.
      if (!letzterPlan || letzterPlan.art !== 'bestaetigen') {
        throw new Error('kein Plan steht zur Bestaetigung');
      }
      const ergebnis = await fuehreAus(letzterPlan, befehlsUmgebung());
      letzterAusgang = { plan: letzterPlan, ...ergebnis };
      anOberflaeche('awb:plan-ergebnis', letzterAusgang);
      sessions = modellLesen();
      modellSenden();
      if (seiteOffen) anOberflaeche('awb:seite', { name: seiteOffen, html: seiteHtml(seiteOffen) });
      const plan = letzterPlan;
      letzterPlan = null;
      return { plan, ...ergebnis };
    }

    case 'ergebnisse': {
      // Ein Durchgang des Waechters auf Zuruf, mit dem, was dabei NEU war.
      // Damit laesst sich die Meldung pruefen, ohne auf den Takt zu warten.
      sessions = modellLesen();
      const neu = ergebnissePruefen();
      return { neu, gesehen: waechterErgebnisse.stand(), gemeldet: gemeldeteErgebnisse.length };
    }

    case 'sessions': {
      sessions = modellLesen();
      modellSenden();
      return {
        machine: config.machine,
        reachable: erreichbareMaschinen(),
        total: sessions.length,
        // Dieselbe Liste, die der Renderer bekommt -- samt Revive-Vorschau.
        visible: mitReviveVorschau(sichtbare(sessions)),
        capacity: kapazitaet(),
        selected: gewaehlte()?.id ?? '',
        // 07.08.: eine leere Liste hat zwei Bedeutungen, und nur eine davon
        // heisst "es laeuft nichts". Wer diese Antwort auswertet, muss beide
        // unterscheiden koennen.
        tmuxAusfuehrbar: tmuxBefund.ausfuehrbar,
        tmuxFehler: tmuxBefund.fehler,
      };
    }

    case 'select': {
      const treffer = await sessionWaehlen(String(req.session ?? ''));
      return { selected: treffer?.id ?? '', tmuxSession: treffer?.tmuxSession ?? '', attachError };
    }

    case 'show-pane': {
      const pane = String(req.pane ?? '');
      if (!pane) throw new Error('Feld pane fehlt');
      await paneZeigen(pane);
      return { pane };
    }

    case 'show-tab': {
      const panes = String(req.panes ?? '').split(',').filter(Boolean);
      if (!panes.length) throw new Error('Feld panes fehlt');
      await tabZeigen(panes);
      return { panes, gezeigt: ansicht };
    }

    case 'ui': {
      const gezeichnet = await uiText().catch(() => ({}));
      return { state: ui.get(), capacity: kapazitaet(), rendered: gezeichnet };
    }

    // Nur LESEN, wie oft die Leiste rechts seit Fensterstart neu gezeichnet
    // wurde und ueber welche der drei Quellen (renderer.ts, rechtsZaehler) --
    // Messhaken fuer den Befund vom 22.08. ("Worker-Tabs springen Auf und Ab").
    case 'rechts-takt': {
      const takt = await win?.webContents.executeJavaScript('window.__awb.rechtsTakt()').catch(() => null);
      return { takt };
    }

    // Wer an einer Stelle den Zeiger faengt. Ein Foto beweist nicht, welche
    // Schicht einen Klick bekommt; eine zugeklappte Schublade lag unsichtbar
    // ueber dem Ziehgriff und nahm ihm jeden Zug (05.08.).
    case 'treffer': {
      if (!win) throw new Error(KEIN_RENDERER);
      const x = Number(req.x);
      const y = Number(req.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Felder x und y fehlen');
      // DIE KLASSEN WERDEN AUS DEM ATTRIBUT GELESEN, NICHT AUS `className`
      // (Prueferbefund vom 05.09.2026). Bei einem SVG-Element ist `className`
      // kein Text, sondern ein `SVGAnimatedString`; sein `toString()` ergibt
      // die Zeichenkette „[object SVGAnimatedString]". Genau auf einem Symbol
      // war die Schichtprobe damit unlesbar -- und Symbole sind der Fall, fuer
      // den man sie am ehesten braucht. `getAttribute('class')` antwortet fuer
      // HTML und SVG gleich.
      //
      // WARUM HIER UND NICHT IN `window.__awb.trefferBei` (renderer.ts), wo
      // dieselbe Zeile ebenfalls steht: `app/src/renderer/` gehoert derzeit
      // einem anderen Auftrag; diese Fassung ist ausdruecklich die des
      // Steuerkanals. Wer den Renderer wieder anfassen darf, laesst
      // `trefferBei` auf diese Stelle zeigen oder streicht es -- ausser dem
      // Steuerkanal ruft es niemand.
      const treffer = await win.webContents.executeJavaScript(
        `(() => {
          const el = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
          if (!el) return { tag: '', id: '', klassen: '' };
          return { tag: el.tagName.toLowerCase(), id: el.id || '', klassen: el.getAttribute('class') || '' };
        })()`,
      );
      return { x, y, treffer };
    }

    // NUR FUER TESTS (22.08.): den Griff eines Panes wirklich anklicken --
    // dasselbe `<button>.click()`, das auch ein echter Mausklick ausloest, am
    // echten Element im echten, laufenden Fenster. Kein Nachbau der Logik: der
    // Klick durchlaeuft den vollen Weg (chat/anbindung.ts -> IPC
    // 'awb:chat-ansicht-setzen' -> ui.json -> naechster 'awb:chat-stand' ->
    // Neuzeichnung), genau der Beleg, den ein Bildschirmabzug einfordert.
    case 'pane-chat-klick': {
      if (!win) throw new Error(KEIN_RENDERER);
      const paneId = String(req.paneId ?? '');
      const css = String(req.css ?? '.chat-griff');
      if (!paneId) throw new Error('Feld paneId fehlt');
      const geklickt = await win.webContents.executeJavaScript(
        `(() => {
          const kasten = document.querySelector('[data-pane="' + ${JSON.stringify(paneId)} + '"]');
          if (!kasten) return { gefunden: false };
          const el = kasten.querySelector(${JSON.stringify(css)});
          if (!el) return { gefunden: true, elementDa: false };
          el.click();
          return { gefunden: true, elementDa: true };
        })()`,
      );
      return { paneId, css, ...(geklickt as Record<string, unknown>) };
    }

    // NUR FUER TESTS (22.08.): zaehlt echte 'awb:chat-stand'-Aufrufe fuer einen
    // Pane -- der Beleg, dass die Ansicht nur liest, waehrend sie offen ist
    // (chat/anbindung.ts, `zeigen()` startet und stoppt den Takt). Dieselbe
    // Bauart wie 'chat-zeiten <id> [leeren]': lesen oder zuruecksetzen. Gezaehlt
    // wird an der IPC-Ankunft selbst (oben bei 'awb:chat-stand'), nicht ueber
    // einen Nachbau im Renderer -- `contextBridge.exposeInMainWorld()` friert
    // das dort exponierte Objekt ein, ein Ueberschreiben von aussen wirkt still
    // nicht.
    case 'pane-chat-takt': {
      const paneId = String(req.paneId ?? '');
      if (!paneId) throw new Error('Feld paneId fehlt');
      const zuruecksetzen = req.zuruecksetzen === true;
      if (zuruecksetzen) chatStandZaehler.set(paneId, 0);
      return { paneId, zuruecksetzen, zaehler: chatStandZaehler.get(paneId) ?? 0 };
    }

    // Der Weg, den alice am 06.08. gegangen ist: Fenster verliert den
    // Fokus, andere Anwendung, zurueck. Danach war das Hochrollen tot -- also
    // muss dieser Weg PRUEFBAR sein und nicht bloss plausibel. Beide Schichten
    // werden angefasst: das Fenster selbst und die Ereignisse, die eine
    // Oberflaeche davon sieht.
    case 'fokus': {
      if (!win) throw new Error(KEIN_RENDERER);
      const an = req.an !== false;
      if (an) win.focus();
      else win.blur();
      const art = an ? 'focus' : 'blur';
      const gemeldet = await win.webContents.executeJavaScript(
        `(() => { window.dispatchEvent(new FocusEvent(${JSON.stringify(art)}));
          document.dispatchEvent(new Event('visibilitychange'));
          return { sichtbar: document.visibilityState, panes: document.querySelectorAll('.panekasten').length }; })()`,
      );
      return { an, fokus: win.isFocused(), gemeldet };
    }

    // Ein Rad-Ereignis auf einem gezeichneten Pane, und was danach im Puffer
    // steht. "Man kann nicht hochrollen" ist sonst nicht messbar: ein Foto
    // zeigt keinen Bildlauf, und der Puffertext sagt nicht, welcher Ausschnitt
    // gerade sichtbar ist.
    case 'rad': {
      if (!win) throw new Error(KEIN_RENDERER);
      const pane = String(req.pane ?? '');
      const schritte = Number(req.schritte);
      if (!Number.isFinite(schritte)) throw new Error('Feld schritte fehlt');
      const stand = await win.webContents.executeJavaScript(
        `window.__awb.rad(${JSON.stringify(pane)}, ${schritte}, ${req.shift ? 'true' : 'false'})`,
      );
      return { pane, schritte, stand };
    }

    // Wieviele ZEILEN eine Folge von Rad-Ereignissen bewegt. „Zu schnell" ist
    // sonst nicht nachpruefbar: der Puffer sagt, DASS er sich bewegt hat, nicht
    // um wieviel je Ereignis -- und genau das unterscheidet ein Trackpad (viele
    // kleine Wege) von einer Maus (wenige grosse).
    case 'radmass': {
      if (!win) throw new Error(KEIN_RENDERER);
      const deltas = (Array.isArray(req.deltas) ? req.deltas : []).map(Number).filter((n) => Number.isFinite(n));
      if (!deltas.length) throw new Error('Feld deltas fehlt');
      const modus = Number(req.modus ?? 0);
      const zeilen = Number(req.zeilen ?? 40);
      // zellhoehe darf vorgegeben werden (awb-ctl radmass <weg> [modus] [zeilen]
      // [zellhoehe]), damit die Rechenprobe nicht an der Schrift haengt, mit der
      // das Fenster gerade zeichnet -- sonst fiel sie hier auf dem Weg zur Bruecke
      // still weg und der Renderer massass gegen die ECHTE Zellhoehe.
      const zellhoehe = req.zellhoehe !== undefined ? Number(req.zellhoehe) : undefined;
      const mass = await win.webContents.executeJavaScript(
        `window.__awb.radmass(${JSON.stringify({ deltas, modus, zeilen, zellhoehe })})`,
      );
      return { deltas, modus, mass };
    }

    // EIN GANZER WISCH, durch den echten Eingabeweg von Chromium.
    //
    // `window.__awb.rad` baut sein Ereignis mit `new WheelEvent` und schickt es
    // per `dispatchEvent` -- das ueberspringt alles, was Chromium mit einer
    // Radbewegung sonst tut, und es schickt EIN Ereignis mit einem grossen Weg.
    // Ein Trackpad tut das Gegenteil: viele Ereignisse mit wenigen Bildpunkten,
    // dicht hintereinander. Genau darin lag der Fehler, den alice gemeldet
    // hat („reagiert manchmal gar nicht"), und darum geht dieser Weg ueber
    // `sendInputEvent`: Chromium erzeugt daraus dasselbe DOM-Ereignis wie fuer
    // ein echtes Geraet, mit `hasPreciseScrollingDeltas` wie beim Trackpad.
    // Gemessen wird, was am Ende zaehlt: wieviele Zeilen sich der Ausschnitt
    // bewegt hat, und wieviele Ereignisse gar nichts bewirkt haben.
    case 'rad-strom': {
      if (!win) throw new Error(KEIN_RENDERER);
      const pane = String(req.pane ?? '');
      const deltas = (Array.isArray(req.deltas) ? req.deltas : []).map(Number).filter((n) => Number.isFinite(n));
      if (!deltas.length) throw new Error('Feld deltas fehlt');
      const abstand = Math.max(0, Number(req.abstand ?? 8));
      // Mehrere GESTEN in einem Strom: nach je `block` Ereignissen eine Pause
      // von `pause` Millisekunden. Damit laesst sich messen, was eine Pause mit
      // dem angesammelten Bruchteil macht -- der Fall „ich wische kurz, warte,
      // wische wieder", in dem heute gar nichts passiert.
      const block = Math.max(0, Math.floor(Number(req.block ?? 0)));
      const pause = Math.max(0, Number(req.pause ?? 0));
      const start = await win.webContents.executeJavaScript(
        `window.__awb.radAufnahme(${JSON.stringify(pane)}, true)`,
      );
      let seitBlock = 0;
      for (const d of deltas) {
        if (block && seitBlock === block) {
          await new Promise((r) => setTimeout(r, pause));
          seitBlock = 0;
        }
        seitBlock++;
        win.webContents.sendInputEvent({
          type: 'mouseWheel',
          x: start.x,
          y: start.y,
          deltaX: 0,
          deltaY: d,
          wheelTicksX: 0,
          wheelTicksY: d / 120,
          // Steuerbar, weil dieses Feld die Bauart des GERAETS beschreibt und nicht die
          // Geste: `hasPreciseScrollingDeltas` ist das Kennzeichen eines Trackpads. Ob
          // Chromium daraus auf einer Plattform ohne Trackpad ueberhaupt ein
          // DOM-Ereignis macht, ist eine Frage, die sich nur messen laesst -- und dafuer
          // muss man es auch einmal weglassen koennen. Vorgabe bleibt true, also das
          // bisherige Verhalten.
          hasPreciseScrollingDeltas: req.praezise === undefined ? true : Boolean(req.praezise),
          canScroll: true,
        } as Parameters<typeof win.webContents.sendInputEvent>[0]);
        if (abstand) await new Promise((r) => setTimeout(r, abstand));
      }
      // Der weiche Bildlauf (`smoothScrollDuration`) bewegt den Ausschnitt ueber
      // mehrere Bilder; ohne diese Wartezeit laese der Schluss den Stand von
      // vorhin.
      await new Promise((r) => setTimeout(r, 200));
      const ende = await win.webContents.executeJavaScript(
        `window.__awb.radAufnahme(${JSON.stringify(pane)}, false)`,
      );
      return {
        pane,
        gesendet: deltas.length,
        abstand,
        block,
        pause,
        zellhoehe: ende.zellhoehe,
        // Was die Rechnung gesehen und was sie daraus gemacht hat.
        angekommen: ende.ereignisse.length,
        ohneWirkung: ende.null,
        zeilenGerechnet: ende.summe,
        // Und was WIRKLICH passiert ist -- der Ausschnitt bewegt sich, oder er
        // bewegt sich nicht.
        viewportVorher: start.viewportY,
        viewportNachher: ende.viewportY,
        zeilenBewegt: start.viewportY - ende.viewportY,
        baseY: ende.baseY,
        deltas: ende.ereignisse.map((e: { deltaY: number }) => e.deltaY),
        je: ende.ereignisse.map((e: { zeilen: number }) => e.zeilen),
      };
    }

    // Bildzeiten waehrend fortlaufendem Hochrollen -- das Messwerkzeug hinter
    // dem Bericht vom 12.08. Ohne diesen Weg bleibt „haekeliges Scrollen" eine
    // Meinung; siehe window.__awb.scrollLeistung fuer die Rechnung.
    case 'scroll-leistung': {
      if (!win) throw new Error(KEIN_RENDERER);
      const pane = String(req.pane ?? '');
      const bilder = Number(req.bilder ?? 120);
      const raster = Number(req.raster ?? 3);
      const stand = await win.webContents.executeJavaScript(
        `window.__awb.scrollLeistung(${JSON.stringify(pane)}, ${JSON.stringify({ bilder, raster })})`,
      );
      return { pane, stand };
    }

    // Welcher Renderer gerade zeichnet -- ohne Rad-Ereignis, fuer die Zusage
    // "der Zusatz ist wirklich aktiv" getrennt von der Messung selbst.
    case 'renderer-art': {
      if (!win) throw new Error(KEIN_RENDERER);
      const pane = String(req.pane ?? '');
      const art = await win.webContents.executeJavaScript(`window.__awb.rendererArt(${JSON.stringify(pane)})`);
      return { pane, art };
    }

    // NUR FUER TESTS: WebGL fuer diesen Fensterprozess unbrauchbar machen,
    // BEVOR ein Pane angelegt wird -- der einzige zuverlaessige Weg, den
    // Canvas-Rueckfall in ladeRenderer() auszuloesen (siehe __awb.webglSperren).
    case 'webgl-sperren': {
      if (!win) throw new Error(KEIN_RENDERER);
      const ok = await win.webContents.executeJavaScript('window.__awb.webglSperren()');
      return { gesperrt: !!ok };
    }

    // NUR FUER TESTS (clipfixtest): eine Auswahl im Terminal setzen oder
    // loeschen -- die Vorbedingung fuer "Strg+Umschalt+C kopiert nur MIT
    // Auswahl".
    case 'zwischenablage-auswahl': {
      if (!win) throw new Error(KEIN_RENDERER);
      const pane = String(req.pane ?? '');
      if (!pane) throw new Error('Feld pane fehlt');
      const an = req.an === true;
      const hatAuswahl = await win.webContents.executeJavaScript(
        `window.__awb.zwischenablageAuswahl(${JSON.stringify(pane)}, ${JSON.stringify(an)})`,
      );
      return { pane, an, hatAuswahl: hatAuswahl === true };
    }

    // NUR FUER TESTS (clipfixtest): eine echte Tastenkombination auf dem
    // Textfeld des Terminals ausloesen -- derselbe Weg, ueber den xterm.js
    // selbst jede Taste entgegennimmt (siehe __awb.zwischenablageTaste). Bei
    // Strg+Umschalt+V braucht der IPC-Umlauf zur System-Zwischenablage einen
    // Moment, deshalb wird `gesendet` erst NACH einer kurzen Wartezeit erneut
    // gelesen statt aus derselben Antwort wie `verhindert`.
    case 'zwischenablage-taste': {
      if (!win) throw new Error(KEIN_RENDERER);
      const pane = String(req.pane ?? '');
      const taste = String(req.taste ?? '');
      if (!pane || !taste) throw new Error('zwischenablage-taste braucht <%pane> <taste>');
      const shift = req.shift === true;
      const stand = (await win.webContents.executeJavaScript(
        `window.__awb.zwischenablageTaste(${JSON.stringify(pane)}, ${JSON.stringify({ taste, shift })})`,
      )) as { verhindert: boolean };
      await new Promise((r) => setTimeout(r, 150));
      const gesendet = await win.webContents.executeJavaScript('window.__awb.zwischenablageGesendet()');
      return { pane, taste, shift, verhindert: stand?.verhindert === true, gesendet: String(gesendet) };
    }

    // NUR FUER TESTS (clipfixtest): existiert ein Anwendungsmenue, und traegt
    // sein Bearbeiten-Eintrag die Rollen 'copy'/'paste' (siehe die
    // 'editMenu'-Vorlage weiter oben in app.whenReady).
    case 'menu-stand': {
      // Der Rueckweg ueber `getApplicationMenu()` spiegelt auf macOS das
      // native NSMenu -- gemessen kommt `role` dabei durchgehend KLEIN
      // zurueck ('editmenu' statt 'editMenu', wie es in der Vorlage steht).
      // Der Vergleich muss deshalb kleinschreiben, nicht die Vorlage aendern.
      const menu = Menu.getApplicationMenu();
      if (!menu) return { existiert: false, bearbeitenRollen: [] };
      const bearbeiten = menu.items.find((i) => String(i.role).toLowerCase() === 'editmenu');
      const rollen = (bearbeiten?.submenu?.items ?? []).map((i) => String(i.role || i.type || '').toLowerCase());
      return { existiert: true, bearbeitenRollen: rollen };
    }

    // NUR FUER TESTS (clipfixtest): ein ECHTER Rechtsklick per `sendInputEvent`
    // -- derselbe Weg wie bei 'rad-strom'. Ein `dispatchEvent(new MouseEvent
    // ('contextmenu'))` (wie beim bestehenden 'rechtsklick') erreicht zwar
    // Zuhoerer IM Renderer, aber NICHT Electrons browser-seitiges
    // 'context-menu'-Ereignis -- das braucht ein trusted Ereignis, gemessen
    // beim ersten Anlauf dieser Suite (`stand` blieb dabei durchgehend null).
    // Kein natives Menue zeigt sich trotzdem: AWB_TEST_KONTEXTMENUE_STUMM
    // schaltet `.popup()` in app.whenReady stumm.
    case 'kontextmenu-fake': {
      if (!win) throw new Error(KEIN_RENDERER);
      const ziel = String(req.ziel ?? '');
      if (!ziel) throw new Error('Feld ziel fehlt');
      awbLetzterKontextmenu = null;
      const pos = (await win.webContents.executeJavaScript(
        `window.__awb.zwischenablageKontextmenuZiel(${JSON.stringify(ziel)})`,
      )) as { x: number; y: number } | null;
      if (!pos) return { ziel, getroffen: false, stand: null };
      win.webContents.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'right', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'right', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 150));
      return { ziel, getroffen: true, stand: awbLetzterKontextmenu };
    }

    // NUR FUER TESTS (clipfixtest): die click()-Funktion eines Eintrags aus dem
    // ZULETZT gebauten Terminal-Kontextmenue direkt ausloesen. Unter
    // AWB_TEST_KONTEXTMENUE_STUMM=1 zeigt sich nie ein natives Popup, ueber das
    // eine Suite klicken koennte -- die click()-Funktionen selbst sind aber
    // dieselben, die auch ein echtes Popup aufriefe (kein zweiter Weg).
    case 'kontextmenu-klick': {
      const eintrag = String(req.eintrag ?? '');
      if (eintrag !== 'kopieren' && eintrag !== 'einfuegen') {
        throw new Error("kontextmenu-klick braucht <%eintrag> 'kopieren' oder 'einfuegen'");
      }
      const aktion = awbLetzterKontextmenuAktionen?.[eintrag];
      if (!aktion) return { eintrag, vorhanden: false };
      await aktion();
      await new Promise((r) => setTimeout(r, 150));
      return { eintrag, vorhanden: true };
    }

    case 'set-ui': {
      const teil: Record<string, unknown> = {};
      for (const feld of ['sidebarWidth', 'showStopped', 'sort', 'order', 'projektReihenfolge', 'workerTab', 'blattBreite', 'editorEingeklappt'] as const) {
        if (req[feld] !== undefined) teil[feld] = req[feld];
      }
      if (typeof teil.sort === 'string' && !['recent', 'folder', 'name'].includes(teil.sort)) {
        throw new Error(`unbekannte Sortierung: ${teil.sort}`);
      }
      if (teil.blattBreite !== undefined) teil.blattBreite = Math.max(280, Math.min(1200, Number(teil.blattBreite) || 360));
      ui.set(teil as Partial<UiState>);
      sessions = modellLesen();
      modellSenden();
      // Ein Bildwechsel, damit ein Foto danach den neuen Stand zeigt.
      await win?.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
      return { state: ui.get(), capacity: kapazitaet() };
    }

    case 'type': {
      if (!streamPane) throw new Error('kein Pane gewaehlt');
      steuerkanalDarfSchreiben(streamPane, 'type');
      await eingabe(Buffer.from(String(req.text ?? ''), 'utf8'));
      return { sent: String(req.text ?? '').length };
    }

    case 'key': {
      // Benannte Tasten fuer Tests und Tastenkuerzel: send-keys ohne -H deutet
      // Namen wie Enter, C-c oder Escape. Geprueft wird in sendKeyName.
      if (!tmux) throw new Error('nicht angehaengt');
      if (!streamPane) throw new Error('kein Pane gewaehlt');
      steuerkanalDarfSchreiben(streamPane, 'key');
      const name = String(req.name ?? '');
      await tmux.sendKeyName(streamPane, name);
      return { key: name };
    }

    case 'flaeche': {
      // Dieselbe Handlung wie aus der Oberflaeche, damit eine Pruefung die
      // Flaeche vorgeben kann, ohne das Fenster zu vergroessern.
      await flaecheSetzen(Number(req.cols), Number(req.rows), true);
      const p = (await tmux?.listPanes())?.find((x) => x.paneId === streamPane);
      return { pane: streamPane, cols: p?.width ?? 0, rows: p?.height ?? 0 };
    }

    case 'fenster': {
      // Der Groessensprung, den ein Mensch mit einem Doppelklick auf die
      // Titelleiste ausloest. macOS fuehrt ihn ANIMIERT aus: die Flaeche
      // durchlaeuft dabei Dutzende Zwischengroessen, und jede davon meldet der
      // Renderer. Ohne diesen Befehl liesse sich der Fall nur von Hand
      // nachstellen, also genau einmal und nie wieder.
      if (!win) throw new Error(KEIN_RENDERER);
      const was = String(req.was ?? '');
      switch (was) {
        case 'maximieren': win.maximize(); break;
        case 'vollbild':
          // ECHTES Vollbild legt auf macOS IMMER einen eigenen Space an und
          // schaltet dorthin -- auch bei einem Fenster mit show:false
          // (gemessen: es riss alice am 2026-08-09 und 2026-08-10 zweimal
          // mitten in der Arbeit den Bildschirm weg, ausgeloest von
          // test-app-groessensprung.sh). Dieser Zweig ist im ganzen Repo der
          // EINZIGE Aufrufer von 'vollbild' -- kein Produktivpfad haengt
          // daran. Deshalb wird hier verweigert statt nur dokumentiert: ohne
          // das ausdrueckliche Kennzeichen passiert nichts, das sich nicht
          // zurueckdrehen laesst. Siehe regeln/tests-und-eingriffe.md.
          if (process.env.AWB_ERLAUBE_ECHTES_VOLLBILD !== '1') {
            throw new Error(
              "echtes Vollbild ist gesperrt (AWB_ERLAUBE_ECHTES_VOLLBILD=1 setzen -- nur wenn KEIN Mensch grafisch angemeldet ist, siehe regeln/tests-und-eingriffe.md)",
            );
          }
          win.setFullScreen(true);
          break;
        case 'wiederherstellen':
          if (win.isFullScreen()) win.setFullScreen(false);
          else win.unmaximize();
          break;
        default:
          throw new Error(`unbekannte Fensterhandlung: ${was}`);
      }
      // Mit `warten: false` kommt die Antwort SOFORT -- nur so laesst sich
      // waehrend der Animation messen. Sonst wird gewartet, bis die Flaeche
      // eine halbe Sekunde lang dieselbe bleibt; ein festes sleep raet, wie
      // lange die Animation dauert, und rät auf jeder Maschine anders.
      if (req.warten !== false) await groesseBeruhigt(win);
      const [b, h] = win.getContentSize();
      return { was, maximiert: win.isMaximized(), vollbild: win.isFullScreen(), breite: b, hoehe: h, flaeche };
    }

    case 'klick': {
      // Nur die Knoepfe, die noch keine Ansicht haben (data-tot). Damit laesst
      // sich pruefen, dass ein Klick darauf wirklich etwas sagt.
      const knopf = String(req.knopf ?? '');
      if (!/^[a-z-]+$/.test(knopf)) throw new Error(`unzulaessiger Knopf: ${knopf}`);
      if (!win) throw new Error(KEIN_RENDERER);
      // Zwei Bauarten von Knopf: die Werkzeuge tragen `data-tot`, der
      // Plus-Knopf ueber den Sessions eine Kennung. Geklickt wird der ECHTE
      // Knopf, nicht die Nachricht dahinter -- sonst prueft man die Verdrahtung
      // nicht mit.
      const getroffen = (await win.webContents.executeJavaScript(
        `(() => { const k = document.querySelector('.knopf[data-tot="${knopf}"]') || document.getElementById(${JSON.stringify(knopf)}); if (!k) return false; k.click(); return true; })()`,
      )) as boolean;
      if (!getroffen) throw new Error(`kein Knopf '${knopf}'`);
      return { knopf };
    }

    /**
     * DIE MASCHINENANZEIGE IN DER STATUSLEISTE ANKLICKEN (05.09.2026).
     *
     * Zwei Ziele, beide echte Klicks auf das echte Element -- nicht die
     * Nachricht dahinter, sonst prueft man die Verdrahtung nicht mit:
     *   `maschine-klick <name>`        auf den Namen, klappt ihr Feld auf/zu
     *   `maschine-klick <name> laden`  auf den Umschalter IM Feld
     * Der Name reist als JSON-Zeichenkette in die Seite, damit ein Punkt oder
     * ein Bindestrich im Maschinennamen nicht als CSS gelesen wird.
     */
    case 'maschine-klick': {
      if (!win) throw new Error(KEIN_RENDERER);
      const name = String(req.maschine ?? '');
      if (!name) throw new Error('maschine-klick braucht einen Maschinennamen');
      const ziel = req.ziel === 'laden' ? 'laden' : 'name';
      const getroffen = (await win.webContents.executeJavaScript(
        `(() => {
          const n = ${JSON.stringify(name)};
          const stueck = [...document.querySelectorAll('#maschinen .masch')]
            .find((e) => (e.querySelector('.masch-name')?.textContent ?? '').trim() === n);
          if (!stueck) return 'keine Maschine';
          const el = ${JSON.stringify(ziel)} === 'laden'
            ? stueck.querySelector('.masch-schalter input')
            : stueck.querySelector('.masch-name');
          if (!el) return 'kein Bedienelement';
          el.click();
          return '';
        })()`,
      )) as string;
      if (getroffen) throw new Error(`maschine-klick '${name}' (${ziel}): ${getroffen}`);
      return { maschine: name, ziel };
    }

    /**
     * EINE ZEILE DER LINKEN LEISTE AUF EINE ANDERE ZIEHEN -- mit echten
     * Ereignissen, so wie ein Mensch es tut. Beide Kennungen sind entweder
     * Sitzungskennungen oder Projektpfade; welcher Zug daraus wird, entscheidet
     * die Zeile selbst (renderer.ts, `ziehbarGrundform`).
     */
    case 'ziehen': {
      if (!win) throw new Error(KEIN_RENDERER);
      const gezogen = String(req.gezogen ?? '');
      const ziel = String(req.ziel ?? '');
      if (!gezogen || !ziel) throw new Error('Felder gezogen und ziel noetig');
      const ergebnis = await win.webContents.executeJavaScript(
        `window.__awb.ziehprobe(${JSON.stringify({ gezogen, ziel })})`,
      );
      // Der Umbau laeuft ueber 'order' und damit ueber den Hauptprozess; kurz
      // warten, sonst liest der naechste Befehl die Reihenfolge von vorher.
      await new Promise((r) => setTimeout(r, 200));
      return { gezogen, ziel, ...(ergebnis as Record<string, unknown>) };
    }

    case 'editor': {
      // Testzugang zum Editor (E3): dieselbe Bauart wie 'klick' oben, ein
      // Methodenname wird eng geprueft und dann auf window.__awbEditor
      // umgelenkt -- der Testhaken, den editor-view.ts anlegt. Ein Argument
      // geht als EIN JSON-Wert mit, weil jeder Haken genau eins erwartet.
      const method = String(req.method ?? '');
      if (!/^[a-zA-Z]+$/.test(method)) throw new Error(`unzulaessige Editor-Methode: ${method}`);
      // `sendSelection` legt die markierte Stelle in den ORCHESTRATOR-Pane. Ueber den
      // Knopf im Fenster (oder Strg-Umschalt-Eingabe) ist das der Mensch aus Regel 1
      // und bleibt; ueber den Steuerkanal waere es ein Skript, das dem Orchestrator
      // etwas in den Chat schiebt. Der Haken ist der einzige Editor-Haken, der
      // ueberhaupt in einen Pane schreibt -- deshalb genau er und kein zweiter.
      if (method === 'sendSelection') {
        throw new Error(
          "'editor sendSelection' abgelehnt: der Steuerkanal tippt nicht in den Orchestrator-Pane. "
          + 'Diesen Weg geht nur ein Mensch im Fenster (Knopf oder Strg-Umschalt-Eingabe).',
        );
      }
      if (!win) throw new Error(KEIN_RENDERER);
      const argJson = JSON.stringify(req.arg ?? null);
      // { ok, wert } bzw. { ok: false, error } als EIGENE Huelle: der
      // Rueckgabewert eines Hooks kann eine nackte Zahl, ein Boolean oder ein
      // Array sein, und beim Zusammenfuehren mit dem Antwortobjekt des
      // Steuerkanals (`{ ok: true, ...ergebnis }`) verschwindet ein
      // primitiver Wert spurlos (Objekt-Spread ueber ein Primitiv liefert
      // nichts). Die Huelle macht jede Antwort ein Objekt, ok:false schlaegt
      // die aeussere Huelle absichtlich -- damit ein Fehler im Renderer genau
      // wie ueberall sonst in diesem Kanal beim Aufrufer als ok:false
      // ankommt, statt als leise "erfolgreiche" Antwort ohne Wert. Das Feld
      // heisst `error`, nicht `fehler` -- awb-ctl druckt bei ok:false genau
      // dieses Feld (`Fehler: ${reply.error}`), ein anderer Name waere dort
      // fuer immer "undefined" gewesen.
      const ergebnis = await win.webContents.executeJavaScript(
        `(async () => {
           const h = window.__awbEditor;
           if (!h || typeof h.${method} !== 'function') return { ok: false, error: 'kein Hook ${method}' };
           try { return { ok: true, wert: await h.${method}(${argJson}) }; }
           catch (e) { return { ok: false, error: (e && e.message) ? e.message : String(e) }; }
         })()`,
      );
      return ergebnis;
    }

    case 'schreiben': {
      // Dieselbe Bauart wie 'klick', nur fuer ein Eingabefeld statt eines
      // Knopfes -- gebraucht fuer Felder, die kein tmux-Pane sind (die
      // Inhaltssuche) und deshalb nicht ueber 'type' erreichbar sind. Nur
      // Elemente mit einem bekannten data-tipp, kein freier Selektor.
      const ziel = String(req.ziel ?? '');
      const text = String(req.text ?? '');
      if (!/^[a-z-]+$/.test(ziel)) throw new Error(`unzulaessiges Ziel: ${ziel}`);
      if (!win) throw new Error(KEIN_RENDERER);
      const getroffen = (await win.webContents.executeJavaScript(
        `(() => { const el = document.querySelector('[data-tipp="${ziel}"]'); if (!el) return false;
          el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`,
      )) as boolean;
      if (!getroffen) throw new Error(`kein Eingabefeld '${ziel}'`);
      return { ziel };
    }

    case 'reload': {
      rendererReady = false;
      waechter = neuerWaechter();
      win?.webContents.reload();
      await waitForRenderer();
      const s = gewaehlte();
      await attachTmux(s?.alive ? s.tmuxSession : config.session);
      modellSenden();
      return { reloaded: true, attachError };
    }

    case 'focus-pane': {
      const pane = String(req.pane ?? '');
      if (!pane) throw new Error('Feld pane fehlt');
      if (!tmux) throw new Error('nicht angehaengt');
      // Geprueft wird in selectPane -- der Kanal reicht keine Zeile mehr
      // ungeprueft an tmux durch (B4).
      await tmux.selectPane(pane);
      await paneZeigen(pane);
      return { pane };
    }

    case 'freigaben': {
      freigabenAktualisieren();
      return freigaben;
    }

    case 'entscheiden': {
      const pfad = String(req.path ?? '');
      const aktion = String(req.action ?? '');
      const grund = String(req.reason ?? '');
      if (!pfad) throw new Error('Feld path fehlt');
      if (aktion !== 'approve' && aktion !== 'reject') throw new Error("Feld action muss 'approve' oder 'reject' sein");
      // `reason` ist FREIWILLIG (19.08.) -- derselbe Schritt wie im Fenster und
      // in `wb-decide`. Ein fehlendes Feld ist hier kein Fehler mehr, sondern
      // eine leere Begruendung.
      const ergebnis = decideRequest(config.requestsDir, pfad, aktion, grund, config.wbDecideBin);
      freigabenAktualisieren();
      return ergebnis;
    }

    case 'muster-entscheiden': {
      const s = String(req.schluessel ?? '');
      const aktion = String(req.action ?? '');
      const grund = String(req.reason ?? '');
      if (!s) throw new Error('Feld schluessel fehlt');
      if (aktion !== 'approve' && aktion !== 'reject') throw new Error("Feld action muss 'approve' oder 'reject' sein");
      // `reason` ist auch hier freiwillig (19.08.). An der Herkunft aendert das
      // nichts -- die naechsten Zeilen sind unberuehrt.
      // Ueber den Steuerkanal kommt KEIN gemessener Mensch: `musterEntscheiden`
      // bekommt deshalb kein `mensch`, und ein Annehmen endet hier mit einer
      // Absage. Sie wird geworfen statt zurueckgegeben, damit der Aufrufer den
      // Grund im Klartext sieht -- ein `ok: false` ohne Text ist die Antwort,
      // bei der jemand den Fehler bei sich sucht.
      const ergebnis = musterEntscheiden(s, aktion, grund);
      if (!ergebnis.ok) throw new Error(ergebnis.output);
      return ergebnis;
    }

    case 'revive': {
      const id = String(req.id ?? '');
      if (!id) throw new Error('Feld id fehlt');
      const r = sessionWiederherstellen(id);
      // Das Sitzungsfenster steht womoeglich offen und zeigt genau diese Zeile.
      sitzungsfensterAuffrischen();
      return r;
    }

    case 'neue-session': {
      const r = sessionAnlegen(String(req.dir ?? ''), String(req.name ?? ''));
      if (r.gestartet) nachStartNachlesen();
      return r;
    }

    case 'ordner': {
      return ordnerLesen(String(req.pfad ?? ''));
    }

    case 'ordner-oeffnen': {
      const pfad = String(req.pfad ?? '');
      if (!pfad) throw new Error('Feld pfad fehlt');
      await ordnerOeffnen(pfad);
      return { pfad };
    }

    // NUR FUER TESTS: einen Ordner IM Baum aufklappen. Dieselbe Bauart wie
    // 'editor' -- der Steuerkanal ruft einen Haken der Ansicht auf, statt einen
    // Klick an Bildschirmkoordinaten zu raten (die haengen an der
    // Schriftgroesse). Geklickt wird die echte Zeile, also laeuft der Test
    // durch denselben Behandler wie die Maus. Gebraucht fuer die Zusage, dass
    // sich auch ein aufgeklappter UNTERORDNER auffrischt und nicht nur die
    // Wurzel (test-app-ordner-auffrischung.sh).
    case 'ordner-auf': {
      const pfad = String(req.pfad ?? '');
      if (!pfad) throw new Error('Feld pfad fehlt');
      if (!win) throw new Error(KEIN_RENDERER);
      const getroffen = (await win.webContents.executeJavaScript(
        `(() => { const h = window.__awbOrdner; return !!(h && h.auf(${JSON.stringify(pfad)})); })()`,
      )) as boolean;
      if (!getroffen) throw new Error(`keine Baumzeile fuer '${pfad}' -- steht sie ueberhaupt auf dem Schirm?`);
      return { pfad };
    }

    // Der Tab "Agents" (aufgaben.ts, welten.ts): der Stand und eine Handlung
    // `welt:<handlung> <JSON>`. Ueber diesen Weg spricht per Bauart ein Skript --
    // welten.ts schreibt es als `cli-operator` (Herkunft 'steuerkanal').
    case 'aufgaben': {
      // `frisch`: erst einen Takt abwarten -- fuer Pruefungen, die nicht zwei Sekunden raten wollen.
      return req.frisch === true ? aufgabenQuelle.frisch() : aufgabenQuelle.aktuell();
    }

    case 'aufgabe': {
      const befehl = String(req.befehl ?? '');
      if (!befehl) throw new Error('Feld befehl fehlt');
      return aufgabenQuelle.ausfuehren(befehl, 'steuerkanal', { bestaetigt: req.bestaetigt === true, echt: false });
    }

    // Die Sichtbarkeit der Ansicht lesen und (fuer Pruefungen) setzen.
    case 'aufgaben-sichtbar': {
      if (typeof req.sichtbar === 'boolean') aufgabenQuelle.sichtbarSetzen(req.sichtbar);
      return { sichtbar: aufgabenQuelle.istSichtbar() };
    }

    /**
     * DIE WELTEN-ANSICHT IM TAB „AGENTS" (Auftrag agentsui Nr. 4, seit Nr. 6 der Tab).
     * Dieselbe Bauart wie 'editor' und 'ordner-auf': der Steuerkanal ruft einen Haken
     * der Ansicht (`window.__awbWelten`), statt einen Klick an Bildschirmkoordinaten zu
     * raten; `druecke` klickt das gezeichnete Bedienelement, `tippe` setzt ein Feld wie
     * getippt. Ein Testzugang zur Oberflaeche, kein neuer Weg in den Kern. Das
     * Aufgaben-Blatt aus Fassung 26 (`agents`, `window.__awbAgents`) gibt es nicht mehr.
     */
    case 'welten': {
      if (!win) throw new Error(KEIN_RENDERER);
      const was = String(req.was ?? 'zustand');
      if (!/^[a-z]+$/.test(was)) throw new Error(`unzulaessige Welten-Methode: ${was}`);
      const wert = JSON.stringify(String(req.wert ?? ''));
      const ergebnis = (await win.webContents.executeJavaScript(
        `(() => { const h = window.__awbWelten; if (!h) return { ok: false, error: 'keine Welten-Ansicht' };
          if (typeof h[${JSON.stringify(was)}] !== 'function') return { ok: false, error: 'unbekannt: ' + ${JSON.stringify(was)} };
          try { return { ok: true, wert: h[${JSON.stringify(was)}](${wert}) }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; } })()`,
      )) as { ok: boolean; wert?: unknown; error?: string };
      if (!ergebnis.ok) throw new Error(ergebnis.error ?? 'Welten-Ansicht meldete einen Fehler');
      return { was, ...(ergebnis.wert as Record<string, unknown>) };
    }

    /**
     * DEN UMSCHALTER CODE | AGENTS BEDIENEN (08.09.2026). Geklickt wird der
     * ECHTE Knopf in der Titelleiste, nicht die Funktion dahinter -- sonst
     * prueft eine Suite die Verdrahtung nicht mit.
     */
    case 'modus': {
      if (!win) throw new Error(KEIN_RENDERER);
      const modus = String(req.modus ?? '');
      if (modus !== 'code' && modus !== 'agents') throw new Error("modus kennt code|agents");
      const getroffen = (await win.webContents.executeJavaScript(
        `(() => { const k = document.querySelector('#modi [data-modus="${modus}"]'); if (!k) return false; k.click(); return true; })()`,
      )) as boolean;
      if (!getroffen) throw new Error(`kein Umschalter fuer '${modus}'`);
      return { modus };
    }

    case 'aktivitaet': {
      return { entries: aktivitaetLesen() };
    }

    case 'aktivitaet-oeffnen': {
      const pfad = String(req.pfad ?? '');
      if (!pfad) throw new Error('Feld pfad fehlt');
      return { pfad, ...aktivitaetOeffnen(pfad) };
    }

    case 'aktivitaet-diff': {
      const pfad = String(req.pfad ?? '');
      if (!pfad) throw new Error('Feld pfad fehlt');
      return { pfad, ...aktivitaetDiffLesen(pfad) };
    }

    case 'aktivitaet-auftrag': {
      const pfad = String(req.pfad ?? '');
      if (!pfad) throw new Error('Feld pfad fehlt');
      return { pfad, ...aktivitaetAuftragLesen(pfad) };
    }

    case 'protokolle': {
      return { entries: protokollListe(config.settingsFile) };
    }

    case 'protokolle-oeffnen': {
      const pfad = String(req.pfad ?? '');
      if (!pfad) throw new Error('Feld pfad fehlt');
      return { pfad, content: protokollLesen(pfad, config.settingsFile) };
    }

    case 'suche': {
      const query = String(req.query ?? '');
      if (!query) throw new Error('Feld query fehlt');
      return sucheLesen(query, String(req.pfad ?? ''));
    }

    case 'shot': {
      if (!win) throw new Error(KEIN_RENDERER);
      return await captureWindow(win, config.shotDir, req.path ? String(req.path) : undefined);
    }

    // --- DER PROTOTYP AUS pty.ts, UEBER DEN STEUERKANAL --------------------
    //
    // Diese acht Befehle sind das, was von tmux uebrigbleibt, wenn die
    // Anwendung die Pseudo-Terminals selbst haelt. Zum Vergleich: die
    // Kerngruppe der Werkzeuge ruft heute zwanzig tmux-Unterbefehle in 273
    // Aufrufen (DIREKTWEG-BEFUND, Abschnitt 5), davon vierzig reine
    // Fenster-Buchhaltung, die hier ersatzlos entfaellt.
    //
    // Der Kanal bleibt, was er ist: ein Werkzeug fuer die Werkbank, nicht fuer
    // die Agenten in den Panes (control.ts, F17).
    case 'pane-starten': {
      const a = req.auftrag as PtyAuftrag | undefined;
      if (!a || !a.befehl || !a.cwd) throw new Error('pane-starten braucht auftrag mit befehl und cwd');
      const id = ptyVerwaltung().starten({
        name: a.name || 'worker',
        befehl: a.befehl,
        args: Array.isArray(a.args) ? a.args.map(String) : [],
        cwd: a.cwd,
        env: a.env,
        cols: Number(a.cols) > 0 ? Number(a.cols) : 80,
        rows: Number(a.rows) > 0 ? Number(a.rows) : 24,
        harness: a.harness,
        rolle: a.rolle,
        wiederaufnahme: a.wiederaufnahme,
      });
      return { pane: id, stand: ptyVerwaltung().standVon(id) };
    }

    case 'pane-liste':
      return { panes: ptyVerwaltung().liste() };

    case 'pane-info': {
      const stand = ptyVerwaltung().standVon(String(req.pane ?? ''));
      if (!stand) throw new Error(`kein pty-Pane ${req.pane}`);
      return stand;
    }

    // DIE STELLE, AN DER DIE PROBE HAENGT: derselbe Text, den
    // `capture-pane -p` liefert -- alle sichtbaren Zeilen, rechts
    // beschnitten, mit "\n" verbunden, ohne Umbruch am Ende (pty.ts, M1).
    case 'pane-schirm': {
      const pane = String(req.pane ?? '');
      const zeilen = Number(req.zeilen ?? 0);
      const v = ptyVerwaltung();
      return { pane, text: zeilen > 0 ? v.historie(pane, zeilen) : v.schirm(pane) };
    }

    case 'pane-tippen': {
      const pane = String(req.pane ?? '');
      ptyVerwaltung().schreiben(pane, Buffer.from(String(req.text ?? ''), 'utf8'));
      return { pane, getippt: String(req.text ?? '').length };
    }

    // Benannte Tasten, uebersetzt an EINER Stelle. `send-keys` nimmt sie als
    // Namen entgegen; ein Pseudo-Terminal nimmt Bytes, und die Uebersetzung
    // gehoert damit hierher statt in jedes rufende Werkzeug.
    case 'pane-taste': {
      const pane = String(req.pane ?? '');
      const name = String(req.name ?? '');
      const bytes = tastenBytes(name);
      if (bytes === null) throw new Error(`unbekannte Taste '${name}'`);
      ptyVerwaltung().schreiben(pane, Buffer.from(bytes, 'binary'));
      return { pane, taste: name };
    }

    case 'pane-groesse': {
      const pane = String(req.pane ?? '');
      ptyVerwaltung().groesse(pane, Number(req.cols), Number(req.rows));
      return ptyVerwaltung().standVon(pane);
    }

    case 'pane-beenden': {
      const pane = String(req.pane ?? '');
      ptyVerwaltung().beenden(pane);
      return { pane, beendet: true };
    }

    case 'quit':
      setTimeout(() => void shutdown(0), 50);
      return { quitting: true };

    default:
      throw new Error(`unbekannter Befehl: ${req.cmd}`);
  }
}

/**
 * Beim Schliessen des Fensters die Sitzung mit beenden -- oder eben nicht.
 *
 * Der Schluessel `closeSessionOnWindowClose` stand seit V1 in den
 * Einstellungen, wurde im Menue angeboten und von diesem Programm NIE gelesen:
 * umgesetzt war er nur in der VS-Code-Erweiterung, und die ist zu (Befund F1
 * vom 06.08.). Der Grund fuer den Schluessel ist gemessen -- drei vergessene
 * Fenster hielten 6,0 GB.
 *
 * SEIT DEM 07.08. IST DIE VORGABE AUS, und damit beendet das Schliessen des
 * Fensters von sich aus keine Sitzung mehr. Wort des Nutzers: „Ich will nicht,
 * dass die Sessions beendet werden durch Schließen der App, dafür ist der
 * Rechtsklick auf die Session da." Die Messung von oben ist damit NICHT
 * hinfaellig -- die 6,0 GB waren echt --, sie wiegt nur weniger: belegter
 * Speicher laesst sich jederzeit zurueckholen (Rechtsklick, „Sitzung
 * schließen"), eine versehentlich beendete Sitzung samt laufender Arbeit
 * nicht. Der Schalter BLEIBT, weil der gemessene Fall bleibt: wer seine
 * Fenster als Lebensdauer seiner Sitzungen versteht, schaltet ihn ein und
 * bekommt genau das Verhalten von vorher, samt aller vier Bedingungen unten.
 * Weggenommen wurde nur die Vorgabe, nicht die Moeglichkeit.
 *
 * Beendet wird nur, wenn ALLE vier Bedingungen zutreffen. Das hier ist eine
 * zerstoerende Handlung, und jede der vier Bedingungen hat ihren eigenen
 * Grund:
 *
 *   1. Die Einstellung steht auf an (Vorgabe seit dem 07.08.: aus).
 *   2. Die Sitzung gehoert UNS. Woran das haengt: `sizePolicy === 'owned'`,
 *      und das kommt aus der tmux-Benutzeroption `@awb_owner`, die nur
 *      `wb-code` beim Anlegen setzt (tmux.ts, OWNER_OPTION). Dieselbe Frage
 *      entscheidet seit F14, ob wir eine Sitzung ueberhaupt umraeumen duerfen;
 *      zwei Wahrheiten daneben waeren eine zuviel.
 *   3. Es haengt kein FREMDER Client daran (unser Steuerclient zaehlt nicht).
 *      Hinter einem zweiten Client sitzt ein Mensch, der gerade arbeitet.
 *   4. Es laeuft kein Worker mehr. In einem Worker-Pane steht Arbeit, nicht
 *      nur Speicher. Solange einer lebt, bleibt die Sitzung stehen, und der
 *      Grund steht im Protokoll -- stilles Wegraeumen gibt es hier nicht.
 *
 * Entschieden wird VOR dem Abloesen (fuer 3. braucht es den Steuerkanal),
 * beendet wird DANACH: ein `kill-session` unter dem eigenen Steuerclient
 * hinweg waere ein Abbruch statt eines Endes.
 */
async function schlussUrteil(): Promise<{ sitzung: string; grund: string }> {
  const sitzung = attachState?.session ?? '';
  if (!sitzung) return { sitzung: '', grund: 'keine Sitzung angehaengt' };
  if (!schalterAus('closeSessionOnWindowClose', config.settingsFile)) {
    return { sitzung: '', grund: `Einstellung aus -- '${sitzung}' laeuft weiter` };
  }
  if (attachState?.sizePolicy !== 'owned') {
    return { sitzung: '', grund: `'${sitzung}' ist eine uebernommene Sitzung -- sie gehoert uns nicht` };
  }
  const fremde = await tmux?.fremdeClients().catch(() => 1) ?? 1;
  if (fremde > 0) {
    return { sitzung: '', grund: `an '${sitzung}' haengen noch ${fremde} fremde Clients` };
  }
  sessions = modellLesen();
  const s = sessions.find((x) => x.tmuxSession === sitzung);
  // Bedingung 4, und sie faellt in DIE VORSICHTIGE RICHTUNG (07.08.): ein
  // Worker, ueber den nichts bekannt ist ('unknown', die Panes waren nicht
  // abzufragen), zaehlt hier wie ein laufender. Mit `alive` allein haette
  // ausgerechnet ein ausgefallenes tmux die Bedingung erfuellt, die die
  // Sitzung beenden darf -- die Luecke im Wissen haette das Urteil GESTUETZT
  // statt es aufzuhalten. Der Grund nennt beide Zahlen getrennt, damit
  // niemand aus dem Protokoll liest, wir haetten sie laufen SEHEN.
  const laufende = (s?.workers ?? []).filter((w) => w.alive);
  const unbekannte = (s?.workers ?? []).filter((w) => w.state === 'unknown');
  const teile: string[] = [];
  if (laufende.length) {
    teile.push(`laufen noch ${laufende.length} Worker (${laufende.map((w) => w.name).join(', ')})`);
  }
  if (unbekannte.length) {
    teile.push(`sind ${unbekannte.length} Worker nicht einsehbar (${unbekannte.map((w) => w.name).join(', ')})`);
  }
  if (teile.length) return { sitzung: '', grund: `in '${sitzung}' ${teile.join(' und es ')}` };
  return { sitzung, grund: `'${sitzung}' gehoert uns, niemand haengt daran, kein Worker laeuft` };
}

/** Das Ende selbst -- erst nach dem Abloesen, mit geprueftem Namen. */
function sitzungBeenden(sitzung: string): void {
  try {
    assertSessionName(sitzung);
  } catch (e) {
    process.stderr.write(`Sitzung nicht beendet: ${(e as Error).message}\n`);
    return;
  }
  const args = config.tmuxSocket ? ['-L', config.tmuxSocket] : [];
  // FRIST (2026-08-20): derselbe Fehler wie der, der am selben Tag das
  // Beenden ueber before-quit/will-quit haengen liess (zustandZurueckSync()
  // in tmux.ts) -- dieser Aufruf sitzt auf demselben Beenden-Weg
  // (shutdown() -> schlussUrteil() -> sitzungBeenden()), nur oertlich, ohne
  // Maschine. 2s wie zustandZurueckSync()s oertlicher Zweig.
  const r = spawnSync('tmux', [...args, 'kill-session', '-t', `=${sitzung}`], { encoding: 'utf8', timeout: 2000 });
  if (r.status === 0) process.stderr.write(`Sitzung '${sitzung}' mit dem Fenster beendet.\n`);
  else process.stderr.write(`Sitzung '${sitzung}' nicht beendet: ${r.signal ? 'nach 2000ms abgebrochen' : (r.stderr || '').trim()}\n`);
}

/**
 * Ein Schritt beim Beenden bekommt eine Frist (Betriebsbefund 2026-08-20): laeuft
 * er nicht in `ms` durch, wird er uebersprungen, der Grund geht ins Protokoll, und
 * das Beenden macht mit dem naechsten Schritt weiter -- kein Schritt haelt den
 * ganzen Ausstieg unbegrenzt auf. Loest `versprechen` ab, bevor die Frist um ist,
 * verhaelt sich diese Funktion wie ein blosses `await` (ein Fehlschlag geht
 * unveraendert an den Aufrufer durch, dessen eigenes try/catch bleibt zustaendig).
 * Eine SPAETE Ablehnung, die erst nach dem Ueberspringen eintrifft, bekommt hier
 * einen No-op-Faenger -- sonst waere sie eine unbehandelte Ausnahme mitten im
 * Beenden und loeste den eigenen uncaughtException-Riegel aus.
 */
async function mitFrist(versprechen: Promise<void>, ms: number, name: string): Promise<void> {
  let zeitAbgelaufen = false;
  const uhr = new Promise<void>((resolve) => {
    setTimeout(() => { zeitAbgelaufen = true; resolve(); }, ms);
  });
  await Promise.race([versprechen, uhr]);
  if (zeitAbgelaufen) {
    process.stderr.write(`Beenden: Schritt '${name}' antwortete nicht in ${ms}ms -- uebersprungen, weiter mit dem naechsten Schritt.\n`);
    versprechen.catch(() => {});
  }
}

/**
 * DER NOTAUSGANG (2026-08-21, Befund von peer).
 *
 * WAS GEMESSEN WURDE: Auf kopflosem Linux bleibt das Beenden nach dem
 * Abloesen stehen. `detach()` und `zustandZurueck()` laufen bis zur letzten
 * Zeile durch und melden „fertig" -- belegt mit Zeitstempeln aus dem echten,
 * unveraenderten Lauf. Uebrig bleiben genau die letzten fuenf Zeilen dieser
 * Funktion: vier `destroy()` und `app.exit()`. Ein frueherer /proc-Befund passt
 * dazu: der Hauptthread stand in einem `write()` auf eine anonyme Pipe mit
 * beiden Enden im selben Prozess -- Chromiums interne IPC, also genau dort, wo
 * ein `destroy()` ansetzt.
 *
 * WARUM KEINE FRIST DAFUER TAUGT, und das ist der Kern: alle fuenf sind
 * SYNCHRONE native Aufrufe. Eine blockierende native Operation laeuft
 * ausserhalb des Ereignisloops, und kein `setTimeout` erreicht sie -- der
 * Zeitgeber wuerde erst zuenden, wenn der Aufruf zurueckkommt, also genau dann,
 * wenn man ihn nicht mehr braucht. `mitFrist()` weiter oben hilft hier nicht.
 *
 * Was einen blockierten Hauptthread noch erreicht, ist ein SIGNAL von aussen.
 * Deshalb ein losgeloester Wachhund: er wartet, sieht nach, ob es diesen
 * Prozess noch gibt, und beendet ihn hart. Er beendet sich danach selbst; es
 * bleibt kein Prozess auf Vorrat stehen.
 *
 * ER PRUEFT, OB ER NOCH DENSELBEN TRIFFT. Eine PID wird wiederverwendet, und
 * ein `kill -9` auf eine fremde, gleichnamige Nummer waere ein sehr teurer
 * Fehler. Verglichen wird deshalb der `ps -o lstart=`-Wert, den er sich beim
 * Start selbst merkt -- dieselbe Absicherung wie in `wb-nohup`. Passt er nicht
 * mehr oder ist die PID weg, tut er nichts.
 *
 * DASS ER GEFEUERT HAT, DARF NICHT VERLORENGEHEN: stderr dieses Prozesses ist
 * dann tot. Er hinterlaesst deshalb eine Zeile in `stateDir/notausgang.log` --
 * daran ist nachher zu sehen, ob der geordnete Weg durchkam oder nicht.
 *
 * WAS DABEI KAPUTTGEHEN KANN: nichts. Nachgesehen statt angenommen. Die drei
 * Kindfenster haengen nur einen `closed`-Empfaenger an, der ihre eigene
 * Referenz auf null setzt; das Hauptfenster hat gar keinen Empfaenger. Was
 * wirklich gespeichert wird, ist zu diesem Zeitpunkt laengst geschrieben:
 * `UiStore.set()` schreibt bei JEDER Aenderung synchron (uistate.ts), die
 * Zustandsdateien gehoeren `wb-state`, und die Lebensspur ist weiter oben in
 * dieser Funktion abgeraeumt. Zwischen dem letzten Speichern und `app.exit()`
 * steht nichts, was jemand vermissen wuerde. `destroy()` loest ausserdem gar
 * kein `close`-Ereignis aus -- wer es benutzt, hat den geordneten Abbau
 * bereits uebersprungen.
 */
function notausgangScharfstellen(ms: number): void {
  const protokoll = join(config.stateDir, 'notausgang.log');
  const pid = process.pid;
  // Alles in EINEM Skript, ohne Werte von aussen: der Wachhund merkt sich den
  // Startwert selbst, in dem Moment, in dem der Prozess sicher noch lebt.
  const skript = [
    `L0=$(ps -o lstart= -p ${pid} 2>/dev/null)`,
    `sleep ${Math.max(1, Math.round(ms / 1000))}`,
    `L1=$(ps -o lstart= -p ${pid} 2>/dev/null)`,
    `[ -n "$L1" ] && [ "$L0" = "$L1" ] || exit 0`,
    `echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Notausgang: PID ${pid} hing nach dem Abbau der Fenster `
      + `laenger als ${ms}ms -- hart beendet." >> '${protokoll.replace(/'/g, `'\\''`)}'`,
    `kill -9 ${pid} 2>/dev/null`,
  ].join('\n');
  try {
    mkdirSync(dirname(protokoll), { recursive: true });
    const wache = spawn('/bin/sh', ['-c', skript], { detached: true, stdio: 'ignore' });
    wache.unref();
  } catch (e) {
    // Ohne Wachhund bleibt es beim bisherigen Verhalten -- das ist auf dieser
    // Maschine seit jeher in Ordnung; er ist eine Absicherung, keine Bedingung.
    process.stderr.write(`Beenden: kein Notausgang moeglich (${(e as Error).message}).\n`);
  }
}

let shuttingDown = false;
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (uhr) clearInterval(uhr);
  remotePoller.stop();
  budgetPoller.stop();
  aufgabenQuelle.stop();
  // Was diese App gestartet hat, beendet sie auch -- und wartet darauf, dass
  // es wirklich weg ist (Befund B5, 12.08.). Ohne das `await` lief
  // `app.exit()` in aller Regel frueher als das Nachfassen nach zwei
  // Sekunden, und ein Kind, das auf SIGTERM nicht reagiert, ueberlebte die
  // App ohne Fenster. MIT FRIST (2026-08-20): das Nachfassen selbst ist
  // eine eigene Zusage der Chat-Sitzung, keine dieser Funktion hier -- eine
  // Sitzung, die sie bricht, darf trotzdem nicht das GANZE Beenden aufhalten.
  await mitFrist(chatbuehne.alleBeenden(), 5000, 'Chat-Sitzungen beenden');
  // Der Prototyp haelt seine Kinder SELBST -- also beendet er sie auch selbst,
  // und zwar hier, an derselben Stelle wie die Chat-Sitzungen. Genau das ist
  // der Preis von Option E: mit dem Programm geht auch der laufende Zug jedes
  // pty-Workers (DIREKTWEG-BEFUND, Abschnitt 4 -- ein bis zwei Zuege je Woche).
  // Die Unterhaltung bleibt, sie steht in der Sitzungsdatei des Harness, und
  // `wiederaufnehmen()` holt sie beim naechsten Start zurueck.
  ptyPanes?.merken();
  ptyPanes?.allesBeenden();
  chatRegistry.alleFreigeben();
  dateiWaechter?.close();
  dateiWaechter = null;
  editorWaechter?.close();
  editorWaechter = null;
  // Die Lebensspur auch auf DIESEM Weg loeschen (11.08.). `zurueckstellen`
  // haengt an before-quit/will-quit und faengt das Beenden ueber das Menue
  // oder ein Signal; hier faellt das Schliessen des letzten Fensters an, denn
  // `app.exit()` am Ende dieser Funktion meldet keinen Ausstieg mehr. Zweimal
  // geloescht schadet nichts, einmal vergessen kostet die Unterscheidung
  // zwischen Neustart und Absturz.
  try {
    lebensspur.sauberBeendet();
  } catch {
    // Ein nicht schreibbarer Zustand darf das Beenden nicht aufhalten.
  }
  // Erst urteilen, dann abloesen, dann beenden. Die Reihenfolge ist keine
  // Kosmetik: die Frage nach fremden Clients braucht den Steuerkanal.
  let urteil = { sitzung: '', grund: 'nicht geprueft' };
  try {
    urteil = await schlussUrteil();
  } catch (e) {
    urteil = { sitzung: '', grund: `Pruefung fehlgeschlagen (${(e as Error).message})` };
  }
  process.stderr.write(`Fenster schliesst: ${urteil.grund}\n`);
  try {
    await tmux?.detach();
  } catch {
    // ein bereits beendeter Steuerclient ist kein Grund haengenzubleiben
  }
  if (urteil.sitzung) sitzungBeenden(urteil.sitzung);
  try {
    // MIT FRIST (2026-08-20): `server.close()` wartet auf ALLE offenen
    // Verbindungen, nicht nur auf sich selbst -- ein Client, der seinen Socket
    // nicht schliesst, liesse dieses `await` ohne Ende stehen.
    if (channel) await mitFrist(channel.close(), 2000, 'Steuerkanal schliessen');
    if (mantel) await mitFrist(mantel.close(), 2000, 'Mantel-Socket schliessen');
  } catch {
    // dito fuer den Steuerkanal
  }
  // AB HIER KANN NICHTS MEHR SCHIEFGEHEN, OHNE DASS ES AUFFAELLT (21.08.).
  // Alles, was Zeit brauchen darf, ist durch und hatte seine eigene Frist. Was
  // jetzt kommt, sind fuenf synchrone native Aufrufe, und genau dort bleibt das
  // Beenden auf kopflosem Linux stehen. Der Wachhund steht deshalb GENAU hier
  // und nicht frueher: davor gibt es legitime Wartezeiten, danach keine mehr.
  // Die Frist ist ueberschreibbar, damit eine MESSUNG den Wachhund einmal aus dem Weg
  // nehmen kann: solange er bei 5 s zuschlaegt, misst man seine eigene Frist und nicht,
  // wie lange der geordnete Weg wirklich braucht. Im Betrieb setzt das niemand.
  notausgangScharfstellen(Number(process.env.AWB_NOTAUSGANG_MS) || 5000);
  // Was dieses Programm geoeffnet hat, macht es auch wieder zu -- ein
  // Kindfenster, das den Beenden-Weg ueberlebt, haelt den Prozess am Leben.
  //
  // Diese vier Zeilen sind vor `app.exit()` streng genommen entbehrlich: `exit`
  // beendet den Prozess sofort und nimmt jedes Fenster mit, ohne zu fragen (die
  // Sorge im Satz darueber gilt `app.quit()`, nicht `exit`). Sie bleiben
  // trotzdem stehen -- welcher der fuenf Aufrufe drueben blockiert, ist NICHT
  // gemessen, und etwas zu entfernen, dessen Wirkung man nicht kennt, waere
  // geraten. Gefaehrlich sind sie nicht mehr: der Wachhund oben deckt sie ab,
  // gleich ob sie selbst haengen oder `app.exit()` danach.
  einstellungsfenster.aktuell()?.destroy();
  sitzungsfenster.aktuell()?.destroy();
  erststartfenster.aktuell()?.destroy();
  win?.destroy();
  app.exit(code);
}

/**
 * DAS HAUPTFENSTER AUFBAUEN -- alles, was zwischen `createWindow()` und dem
 * geladenen Renderer liegt: die Zuhoerer auf Protokoll, Absturz und
 * Rechtsklick, der gemerkte Rahmen, die Testschalter, das Laden der Seite.
 *
 * Eigene Funktion seit dem 06.09.2026 (Auftrag 4.1), damit der Mantelbetrieb
 * sie SCHLICHT NICHT RUFT: er baut kein Fenster, und ein `if` um 170 Zeilen
 * mitten in `whenReady` haette dieselbe Sache gesagt, nur unlesbar.
 */
async function hauptfensterAufbauen(): Promise<void> {
  win = createWindow(config.ownedCols, config.ownedRows);
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) process.stderr.write(`renderer(${source}:${line}): ${message}\n`);
  });
  win.webContents.on('preload-error', (_e, pfad, error) => {
    process.stderr.write(`preload ${pfad}: ${error.message}\n`);
  });
  // DER RENDERER STIRBT, DAS PROGRAMM BLEIBT (Prueferbefund vom 05.09.2026).
  //
  // Bis heute gab es fuer diesen Fall gar keinen Zuhoerer. Gemessen: wird der
  // Renderer-Prozess des Fensters beendet, laeuft der Hauptprozess weiter, sein
  // Takt schreibt weiter in ein Fenster, das niemand mehr zeichnet, und jeder
  // `executeJavaScript` bleibt fuer immer offen -- `awb-ctl state` bekam keine
  // Antwort mehr, und mit ihm kein weiterer Befehl. Uebrig blieb ein Programm
  // ohne Oberflaeche und ohne Steuerkanal, das aus jeder Entfernung tot
  // aussieht, aber nicht beendet ist.
  //
  // Die Antwort darauf ist derselbe Weg, den `awb-ctl reload` geht: Renderer
  // neu laden, auf seine Bereitschaft warten, wieder anhaengen. Er steht in
  // `handle({ cmd: 'reload' })` und wird hier NICHT nachgebaut -- eine zweite
  // Fassung desselben Weges waere eine zweite Wahrheit darueber, was ein
  // Neuladen bedeutet.
  //
  // MIT ABKUEHLUNG, und zwar aus Erfahrung mit dem umgekehrten Fehler: ein
  // Renderer, der beim Laden zuverlaessig stirbt, ergaebe ohne sie eine
  // Endlosschleife aus Absturz und Neustart, die die Maschine belegt und im
  // Protokoll nicht mehr lesbar ist. Nach `reason: 'clean-exit'` und waehrend
  // des Beendens wird gar nichts unternommen: dann ist der Renderer nicht
  // abgestuerzt, sondern fertig.
  win.webContents.on('render-process-gone', (_e, details) => {
    process.stderr.write(`Renderer des Hauptfensters weg (${details.reason}, exitCode ${details.exitCode})\n`);
    rendererReady = false;
    if (shuttingDown || details.reason === 'clean-exit') return;
    // Der Neustart wird VERZOEGERT, nicht verworfen: ein Renderer, der beim
    // Laden zuverlaessig stirbt, ergaebe sonst eine Endlosschleife aus Absturz
    // und Neustart; ein uebersprungener Neustart dagegen liesse das Programm
    // fuer immer ohne Oberflaeche stehen. Beides ist vermeidbar, indem der
    // naechste Versuch einfach wartet, bis der Abstand voll ist.
    const wartet = Math.max(0, rendererNeustartAm + RENDERER_NEUSTART_ABSTAND_MS - Date.now());
    rendererNeustartAm = Date.now() + wartet;
    if (wartet > 0) process.stderr.write(`Renderer: Neustart in ${wartet} ms -- der letzte liegt noch keine 5 s zurueck.\n`);
    // UND NICHT AUS DIESEM ZUHOERER HERAUS (gemessen am 05.09.2026): ein
    // `webContents.reload()` mitten in der Zustellung von
    // 'render-process-gone' laesst Chromium seine Beobachterliste doppelt
    // fuellen -- „NOTREACHED hit. Observers can only be added once!", und der
    // Hauptprozess endete mit SIGTRAP. Der Absturz des Renderers haette so den
    // ganzen Prozess mitgenommen, also genau das, was dieser Zuhoerer
    // verhindern soll. Deshalb geht der Neustart auch bei `wartet === 0` ueber
    // die Uhr und nicht direkt.
    setTimeout(() => {
      handle({ cmd: 'reload' })
        .then(() => process.stderr.write('Renderer nach Absturz neu geladen.\n'))
        .catch((e) => process.stderr.write(`Renderer nach Absturz NICHT neu geladen: ${(e as Error).message}\n`));
    }, wartet);
  });
  // DAS RECHTSKLICK-MENUE EINES TEXTFELDS ODER EINES TERMINALS (SSH-clipfix,
  // clipmenu 17.08.). Electron zeigt anders als ein gewoehnlicher Browser-Tab
  // von sich aus GAR KEIN Kontextmenue -- das `context-menu`-Ereignis kommt
  // zwar, aber ohne einen Zuhoerer bleibt der Rechtsklick stumm.
  //
  // `params.isEditable` allein entscheidet NICHT mehr, ob das Textfeld-Menue
  // erscheint: es folgt dem FOKUS, nicht der Klickposition. xterms
  // Hilfs-Textarea (`textarea.xterm-helper-textarea`) ist laut node_modules/
  // @xterm/xterm/css/xterm.css nur mit `left: -9999em; width: 0; height: 0`
  // weggeschoben, nicht entfernt, und xterm haelt sie fokussiert -- ein
  // Rechtsklick auf die Zeichenflaeche eines Terminals meldet deshalb
  // `isEditable: true`, obwohl dort gar kein editierbares DOM-Feld unter dem
  // Zeiger liegt (gemessen, clipfixtest: der erste Anlauf dieses Kommentars
  // vertraute genau darauf und lag falsch). Ein `.popup()`, das sich allein
  // auf `isEditable` verliesse, oeffnete im Terminal das Textfeld-Menue
  // (Rueckgaengig/Ausschneiden/Kopieren/Einfuegen) und wirkte auf die
  // unsichtbare Textarea: "Kopieren" kopierte nichts, "Einfuegen" fuegte
  // nichts ein. Deshalb fragt dieser Zuhoerer ZUERST den Renderer, WELCHES
  // DOM-Element unter (x, y) liegt (window.__awb.kontextZiel, derselbe
  // Hit-Test wie trefferBei) -- trifft er ein Terminal-Pane, gewinnt das
  // terminal-taugliche Menue, unabhaengig davon, was `isEditable` behauptet.
  // Erst wenn der Treffer KEIN Terminal ist, greift `isEditable` fuer ein
  // echtes Eingabefeld (Chat, Einstellungen, Umbenennen-Feld). Der Editor
  // bringt seines schon von Monaco mit und taucht hier nie auf.
  win.webContents.on('context-menu', (_e, params) => {
    awbLetzterKontextmenu = { isEditable: params.isEditable, popupAufgerufen: false, art: 'keins', eintraege: [] };
    awbLetzterKontextmenuAktionen = null;
    const fenster = win;
    if (!fenster) return;
    // Der Hit-Test braucht einen IPC-Umlauf, deshalb ist der ganze Zuhoerer
    // async -- ein `.popup()` ein paar Millisekunden nach dem Rechtsklick
    // faellt nicht auf.
    void (async () => {
      const ziel = (await fenster.webContents.executeJavaScript(
        `window.__awb.kontextZiel(${params.x}, ${params.y})`,
      )) as { paneId: string; hatAuswahl: boolean; auswahlText: string } | null;

      if (ziel) {
        // "Kopieren" legt GENAU die Auswahl ab, die beim Oeffnen des Menues
        // bestand -- nicht, was zum Zeitpunkt des Klicks zufaellig markiert
        // ist.
        const kopieren = (): void => {
          clipboard.writeText(ziel.auswahlText);
        };
        // "Einfuegen" liest die Zwischenablage ERST beim Klick: sie kann sich
        // zwischen Rechtsklick und Auswahl im Menue geaendert haben, und
        // genau der aktuelle Inhalt soll ankommen -- derselbe Weg wie
        // Strg+Umschalt+V (terminalZwischenablageHaken), nur ohne den Umweg
        // ueber IPC, weil wir hier schon im Hauptprozess sitzen, der
        // `clipboard` direkt haelt.
        const einfuegen = async (): Promise<void> => {
          const text = clipboard.readText();
          if (!text) return;
          await fenster.webContents.executeJavaScript(
            `window.__awb.kontextEinfuegen(${JSON.stringify(ziel.paneId)}, ${JSON.stringify(text)})`,
          );
        };
        const vorlage: Electron.MenuItemConstructorOptions[] = [
          { label: 'Kopieren', enabled: ziel.hatAuswahl, click: kopieren },
          { label: 'Einfügen', click: () => void einfuegen() },
        ];
        awbLetzterKontextmenu = {
          isEditable: params.isEditable,
          popupAufgerufen: true,
          art: 'terminal',
          eintraege: vorlage.map((v) => ({
            rolle: String(v.role ?? ''),
            label: String(v.label ?? ''),
            aktiv: v.enabled !== false,
          })),
        };
        awbLetzterKontextmenuAktionen = { kopieren, einfuegen };
        if (process.env.AWB_TEST_KONTEXTMENUE_STUMM !== '1') {
          Menu.buildFromTemplate(vorlage).popup({ window: fenster });
        }
        return;
      }

      if (!params.isEditable) return;
      const vorlage: Electron.MenuItemConstructorOptions[] = [
        { role: 'undo', enabled: params.editFlags.canUndo },
        { role: 'redo', enabled: params.editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: params.editFlags.canSelectAll },
      ];
      awbLetzterKontextmenu = {
        isEditable: true,
        popupAufgerufen: true,
        art: 'textfeld',
        eintraege: vorlage
          .filter((v) => v.type !== 'separator')
          .map((v) => ({ rolle: String(v.role ?? ''), label: String(v.label ?? ''), aktiv: v.enabled !== false })),
      };
      // NUR FUER TESTS (clipfixtest): ein echtes .popup() zeigt ein natives
      // Menue auf dem Bildschirm -- in einer automatisierten Suite waere das
      // ein Menue, das ohne Zutun eines Menschen auf seinem Schirm aufklappt.
      // Die Suite setzt AWB_TEST_KONTEXTMENUE_STUMM=1 und prueft stattdessen
      // `popupAufgerufen`.
      if (process.env.AWB_TEST_KONTEXTMENUE_STUMM !== '1') {
        Menu.buildFromTemplate(vorlage).popup({ window: fenster });
      }
    })();
  });
  // NUR FUER TESTS (clipfixtest): `AUF_MAC` in renderer.ts liest
  // `navigator.userAgent` genau einmal beim Laden und schaltet
  // Strg+Umschalt+C/V auf einem echten Mac von vornherein ab (siehe dortiger
  // Kommentar). Auf dieser Maschine laesst sich der Linux-Pfad nur pruefen,
  // wenn der Renderer beim Laden eine fremde Kennung sieht -- unveraendert
  // bleibt jede Zeile Produktionslogik, es aendert sich nur, WELCHE Plattform
  // `navigator.userAgent` behauptet. Ohne die Variable: kein Unterschied.
  if (process.env.AWB_TEST_USERAGENT) {
    win.webContents.setUserAgent(process.env.AWB_TEST_USERAGENT);
  }
  await win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  // DIE SPRACHE DES SYSTEMS, bevor irgendein Fenster entsteht (03.09.2026).
  // Ohne Einstellung fiel die Oberflaeche bisher auf Englisch, und der erste
  // Blick auf ein frisches Programm war englisch, obwohl der Mac auf Deutsch
  // steht. `app.getLocale()` gibt es erst nach `whenReady`; die Einstellung
  // schlaegt diesen Wert weiterhin (einstellungen.ts, `sprache`).
  systemSpracheSetzen(app.getLocale());
  // DAS FENSTER ZUERST. Frueher stand der Steuerkanal davor, und ein belegter
  // Socket liess `listen()` scheitern, BEVOR ueberhaupt ein Fenster entstand --
  // die Ablehnung flog ungefangen aus diesem then(), der Prozess lief weiter,
  // und wer auf das Symbol im Dock drueckte, sah nichts, weil es nichts zu
  // sehen gab. Der Kanal ist nuetzlich, aber er ist keine Bedingung dafuer,
  // dass das Programm erscheint: am Fenster haengt ein Mensch, am Kanal ein
  // Skript, und das Skript kann es noch einmal versuchen.
  // Die Seiten liefert das Programm selbst aus -- kein Server, keine Datei auf
  // der Platte, nichts aus dem Netz. Was hier zurueckgeht, ist genau das, was
  // renderSeite() erzeugt hat; ein anderer Pfad bekommt nichts.
  protocol.handle(SEITEN_SCHEMA, (req) => {
    const name = new URL(req.url).hostname as SeitenName;
    if (name !== 'start' && name !== 'einstellungen') {
      return new Response('unbekannte Seite', { status: 404 });
    }
    sessions = modellLesen();
    return new Response(seiteHtml(name), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  });

  // EIN ANWENDUNGSMENUE MIT DEN STANDARDROLLEN (SSH-clipfix), seit 03.09. mit
  // den eigenen Funktionen darin (Fenster-Auftrag Punkt 2). Ohne eigenes Menue
  // verlaesst sich das Programm auf das, was Electron von sich aus
  // zusammenbaut -- pro Version und Plattform verschieden, und nirgends im
  // Quelltext nachlesbar. Mit den eingebauten Rollen (`editMenu` traegt
  // Rueckgaengig/Wiederholen/Ausschneiden/Kopieren/Einfuegen/Alles waehlen)
  // steht es fest, und dieselben Rollen bedienen auch Screenreader und das
  // Systemwerkzeug fuer Barrierefreiheit -- ein Menuepunkt, der nie existierte,
  // konnte das nicht. Im kopflosen Lauf (kein `--show`/`--show-inaktiv`, siehe
  // Kommentar zu `app.dock?.hide()` oben) bleibt es weg wie Dock und Fenster --
  // das ist unveraendert richtig: ein Messlauf soll kein Fenster UND kein
  // Menue zeigen, beides zusammen ist "unsichtbar", eines von beiden waere es
  // nicht mehr.
  if (zeigen || zeigenInaktiv) {
    const isMac = process.platform === 'darwin';
    // Jeder Punkt mit eigener Handlung geht denselben Weg wie der passende
    // Klick im Fenster (`zeigeNachEchtemKlick`, `case 'reload'` im
    // Steuerkanal weiter unten) -- ein Menuepunkt ist wie ein echter Klick ein
    // Ereignis, das ein Mensch selbst ausgeloest hat, kein synthetisches
    // DOM-Ereignis aus einem Skript, und braucht deshalb keine eigene Pruefung.
    const einstellungenOeffnen = (): void => {
      einstellungsfenster.zeigeNachEchtemKlick()
        .catch((e) => process.stderr.write(`Einstellungen (Menue) abgelehnt: ${(e as Error).message}\n`));
    };
    const neueSitzungOeffnen = (): void => {
      sitzungsfenster.zeigeNachEchtemKlick()
        .catch((e) => process.stderr.write(`Neue Sitzung (Menue) abgelehnt: ${(e as Error).message}\n`));
    };
    const aktualisieren = (): void => {
      handle({ cmd: 'reload' })
        .catch((e) => process.stderr.write(`Aktualisieren (Menue) abgelehnt: ${(e as Error).message}\n`));
    };
    // DER WEG ZUR STARTSEITE (03.09.). Bis heute gab es keinen: `seiteOffen`
    // beginnt leer, und ausser dem Steuerkanal setzte es niemand auf 'start'.
    // Die Seite war fuer einen Menschen also gar nicht erreichbar -- der Reiter
    // im Fenster oeffnete nur die Seite, auf der man ohnehin schon stand, und
    // ist deshalb weggefallen (seiten-view.ts). Ein Mac-Programm haelt so einen
    // Punkt im Menue "Ansicht", also steht er dort.
    const startseiteOeffnen = (): void => {
      handle({ cmd: 'seite', wert: 'start' })
        .catch((e) => process.stderr.write(`Startseite (Menue) abgelehnt: ${(e as Error).message}\n`));
    };
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(isMac ? [{
        // role: 'appMenu' allein baut Ueber/Dienste/Ausblenden/Beenden --
        // "Einstellungen" gehoert NICHT zu dieser Rolle und muss von Hand
        // dazwischen, an der Stelle, an der ein Mac-Nutzer sie erwartet
        // (gleich unter "Ueber ...", mit dem Kuerzel Cmd+,).
        label: app.name,
        submenu: [
          { role: 'about' as const },
          { type: 'separator' as const },
          { label: 'Einstellungen …', accelerator: 'Cmd+,', click: einstellungenOeffnen },
          { type: 'separator' as const },
          { role: 'services' as const },
          { type: 'separator' as const },
          { role: 'hide' as const },
          { role: 'hideOthers' as const },
          { role: 'unhide' as const },
          { type: 'separator' as const },
          { role: 'quit' as const },
        ],
      }] : []),
      {
        role: 'fileMenu' as const,
        submenu: [
          { label: 'Neue Sitzung …', accelerator: 'CmdOrCtrl+N', click: neueSitzungOeffnen },
          { type: 'separator' as const },
          isMac ? { role: 'close' as const } : { role: 'quit' as const },
        ],
      },
      { role: 'editMenu' as const },
      {
        role: 'viewMenu' as const,
        submenu: [
          // Ersetzt die eingebauten Punkte "Reload"/"Force Reload": die riefen
          // nur `webContents.reload()` auf, ohne das Nachziehen von tmux und
          // Sessionmodell, das der Steuerkanal-Fall 'reload' bereits leistet
          // (siehe weiter unten, `case 'reload'` in `handle()`). Derselbe Weg
          // gilt jetzt auch fuer den Menuepunkt und sein Kuerzel.
          { label: 'Startseite', accelerator: 'CmdOrCtrl+Shift+H', click: startseiteOeffnen },
          { label: 'Aktualisieren', accelerator: 'CmdOrCtrl+R', click: aktualisieren },
          { type: 'separator' as const },
          { role: 'toggleDevTools' as const },
          { type: 'separator' as const },
          { role: 'togglefullscreen' as const },
        ],
      },
      { role: 'windowMenu' as const },
      // role: 'help' OHNE eigenes Untermenue: macOS haengt bei dieser Rolle von
      // sich aus das Suchfeld ueber alle Menuepunkte an ("In der Hilfe
      // suchen"). Ein eigener Menuepunkt daneben braeuchte ein Hilfedokument
      // fuer Menschen, das es nicht gibt -- erfunden waere er falscher als ein
      // Menue ohne eigenen Punkt.
      { role: 'help' as const },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }

  // DAS HAUPTFENSTER -- ausser im Mantelbetrieb (Auftrag 4.1). Dort ist die
  // Mac-native Oberflaeche die Buehne, und dieser Prozess bleibt reiner Kern:
  // kein BrowserWindow, kein Renderer, kein Warten auf einen.
  if (!mantelBetrieb) await hauptfensterAufbauen();
  // Die Bruecke fuer Strg+Umschalt+C/V IM TERMINAL (SSH-clipfix, siehe
  // preload.ts). `clipboard` statt `navigator.clipboard`: das eine ist
  // Electrons eigenes Modul und braucht keine Berechtigungsabfrage, das andere
  // schon -- und der Renderer hat unter `contextIsolation: true` ohnehin
  // keinen Zugriff auf Node/Electron-Module ausser ueber genau diesen Kanal.
  ipc.handle('awb:zwischenablage-lesen', () => clipboard.readText());
  ipc.handle('awb:zwischenablage-schreiben', (_e, text: unknown) => {
    clipboard.writeText(String(text ?? ''));
  });
  // Ohne Fenster gibt es niemanden, der sich melden koennte: `waitForRenderer`
  // liefe im Mantelbetrieb in seine 15-Sekunden-Frist und riefe danach
  // „Renderer meldete sich nicht" ueber einen Renderer, den nie jemand
  // bestellt hat (Auftrag 4.1).
  if (!mantelBetrieb) await waitForRenderer();

  // Erst jetzt der Kanal -- und sein Ausfall beendet nichts. Er wird gemeldet,
  // im Fenster angezeigt und steht in `state`, damit niemand raten muss.
  try {
    const kanal = new ControlChannel(config.controlSocket, handle);
    await kanal.listen();
    channel = kanal;
  } catch (e) {
    kanalFehler = (e as Error).message;
    process.stderr.write(`kein Steuerkanal: ${kanalFehler}\n`);
  }
  anOberflaeche('awb:kanal', { pfad: config.controlSocket, fehler: kanalFehler });

  // DER MANTEL-SOCKET (06.09.2026, mantel.ts): nur, wenn ein Startvorgang ihn
  // verlangt. Sein Ausfall beendet ebenfalls nichts -- er steht im Protokoll.
  if (config.mantelSocket) {
    try {
      const m = new MantelKanal(config.mantelSocket, config.mantelToken, {
        // Der Absender ist `MANTEL_SENDER`, nicht mehr das Fenster (Auftrag
        // 4.1): im Mantelbetrieb gibt es keines, und die Bruecke haette sonst
        // jeden Kanal mit „unbekannter Kanal" abgewiesen.
        send: (kanal, args) => {
          const fn = ipcHoerer.get(kanal);
          if (!fn) throw new Error(`unbekannter Kanal ${kanal}`);
          fn({ sender: MANTEL_SENDER } as Electron.IpcMainEvent, ...args);
        },
        invoke: async (kanal, args) => {
          const fn = ipcHandler.get(kanal);
          if (!fn) throw new Error(`unbekannter Kanal ${kanal}`);
          return fn({ sender: MANTEL_SENDER } as Electron.IpcMainInvokeEvent, ...args);
        },
        verbunden: () => {
          // Der Anfangszustand, so wie ihn ein frisch geladener Renderer bekaeme:
          // Kanal, Modell, und -- falls angehaengt -- Sitzung und Lage.
          mantel?.push('awb:kanal', { pfad: config.controlSocket, fehler: kanalFehler });
          modellSenden();
          mantel?.push('awb:aufgaben', aufgabenQuelle.aktuell());
          if (attachState) {
            const active = attachState.panes.find((p) => p.paneId === streamPane) ?? attachState.panes[0];
            mantel?.push('awb:session', {
              session: attachState.session,
              cols: active?.width ?? attachState.cols,
              rows: active?.height ?? attachState.rows,
              sizePolicy: attachState.sizePolicy,
              windows: attachState.windows,
              panes: attachState.panes,
              activePane: streamPane,
            });
            void ansichtZeichnen().catch((e) =>
              process.stderr.write(`Mantel: Lage nicht gezeichnet: ${(e as Error).message}\n`));
          }
        },
      });
      await m.listen();
      mantel = m;
      process.stderr.write(`Mantel-Socket: ${config.mantelSocket}\n`);
    } catch (e) {
      process.stderr.write(`kein Mantel-Socket: ${(e as Error).message}\n`);
    }
  }

  // DIE WIEDERAUFNAHME DER PTY-WORKER (04.09.2026, Probe fuer Option E).
  //
  // Sie steht NACH dem Kanal, weil sie sich melden koennen muss: was
  // wiederaufgenommen wurde und womit, gehoert ins Protokoll und nicht in eine
  // Vermutung. Und sie steht hinter dem Schalter -- ohne `workerTransport:
  // "pty"` wird die Momentaufnahme nicht einmal gelesen, geschweige denn ein
  // Prozess gestartet.
  if (ptyTransport()) {
    try {
      const zurueck = ptyVerwaltung().wiederaufnehmen();
      for (const s of zurueck) {
        process.stderr.write(`pty ${s.id} (${s.name}) wieder da: ${s.herkunft} -- ${s.startbefehl}\n`);
      }
      if (!zurueck.length) process.stderr.write('pty: nichts wiederaufzunehmen\n');
    } catch (e) {
      process.stderr.write(`pty: Wiederaufnahme fehlgeschlagen: ${(e as Error).message}\n`);
    }
  }

  remotePoller.start();
  budgetPoller.start();
  aufgabenQuelle.start();
  // Reste-Auftrag, Punkt 3: die Seiten frischen sich auf, wenn ihre Datei sich
  // von aussen aendert -- gemeldet wird nur die betroffene Seite; ob wirklich
  // neu gezeichnet wird, entscheidet allein der Renderer (aufDateiAendern).
  dateiWaechter = startDateiWaechter({
    settingsFile: config.settingsFile,
    modelsFile: config.modelsFile,
    sessionsDir: config.sessionsDir,
    auf: (seite) => {
      anOberflaeche('awb:datei-geaendert', { name: seite });
      // Das EINSTELLUNGSFENSTER zieht ebenfalls nach (06.08.). Es zeichnet aus
      // Dateien, die auch von aussen beschrieben werden -- von `wb-state` am
      // Terminal, von einem Worker, vom Menschen. Ohne diese Zeile stand darin
      // der Stand von damals, und ein Haken behauptete "an", waehrend das
      // Werkzeug laengst "aus" meldete (am Test gesehen, 06.08.). Gezeichnet
      // wird immer die ganze Seite: dieses Fenster haelt keinen Entwurf, den
      // eine Auffrischung zerstoeren koennte.
      anFenster(einstellungsfenster.aktuell(), 'awb:ein-daten-neu', () => einstellungenDatenJetzt());
      // Das SITZUNGSFENSTER aus demselben Grund, nur an der anderen Datei: seine
      // Liste IST der Inhalt von ~/.claude/workbench/sessions/, und die schreibt
      // `wb-code` von aussen. Ein eingetippter Name ueberlebt die Auffrischung
      // (er liegt im Fenster, nicht im Feld) -- es geht kein Entwurf verloren.
      if (seite === 'start') sitzungsfensterAuffrischen();
      // Farben durchreichen: `thema` und `zustandsfarben` stehen in derselben
      // Datei -- eine Aenderung im Einstellungsfenster faellt hier unter
      // 'einstellungen' und erreicht die uebrigen Fenster ueber denselben Weg.
      if (seite === 'einstellungen') themaSenden();
    },
  });
  sessions = modellLesen();
  const z = ui.get();
  const start = sichtbare(sessions).find((s) => s.id === z.selected) ?? sichtbare(sessions)[0] ?? null;
  // Der Befund gehoert VOR das Anhaengen gelesen: `modellLesen` hat ihn gerade
  // gesetzt, und attachTmux kann ihn nicht mehr aendern.
  startAnhaengenNachholen = !tmuxBefund.ausfuehrbar;
  await attachTmux(start?.alive ? start.tmuxSession : config.session);
  if (start) ui.set({ selected: start.id });
  modellSenden();
  freigabenAktualisieren();

  // Der Zustand kommt aus den Dateien und aus tmux, nicht aus einer eigenen
  // Buchfuehrung -- also wird er nachgelesen statt fortgeschrieben.
  uhr = setInterval(() => {
    void (async () => {
      try {
        sessions = modellLesen();
        // Der Absturz-Hook und seine Zeilen (absturz.ts): nur, solange tmux
        // antwortet -- ohne Server gibt es weder Hook noch Tod zu melden.
        if (tmuxBefund.ausfuehrbar) {
          absturzHookSetzen();
          abstuerzeMelden();
        } else {
          absturzHookGesetztAm = 0;
        }
        // Ferne Abstuerze haengen nicht am oertlichen tmux, sondern am Fernabruf.
        fernAbstuerzeMelden();
        // Das beim Start ausgefallene Anhaengen nachholen -- siehe
        // `startAnhaengenNachholen`. Einmalig, und nur solange nichts anderes
        // angehaengt ist: ein Klick, eine Chat-Werkstatt oder ein reload haben
        // dann laengst entschieden, und diese Stelle hat sich herauszuhalten.
        if (startAnhaengenNachholen && tmuxBefund.ausfuehrbar) {
          startAnhaengenNachholen = false;
          if (!tmux) {
            const nachzuholen = gewaehlte();
            await attachTmux(nachzuholen?.alive ? nachzuholen.tmuxSession : config.session);
            if (nachzuholen) ui.set({ selected: nachzuholen.id });
          }
        }
        // ERST nachsehen, wer an der Session haengt, dann das Modell schicken:
        // an dieser Zahl haengt die Auskunft, ob umgeraeumt werden darf, und
        // eine Auskunft, die einen Takt hinterherhinkt, sagt das Falsche.
        await clientsNachlesen();
        // VOR dem Modell: die Fenster- und Pane-Liste der angehaengten Session.
        // Sie entstand bis zum 06.08. nur beim Anhaengen, und ein Worker-Pane,
        // der danach dazukam, stand deshalb in keiner Auskunft (siehe
        // `panesNachlesen`).
        await panesNachlesen();
        await mausNachfuehren();
        // Die Maschinenliste gehoert zu den drei Werten, die das Menue mit
        // „sofort" anbietet (06.08.). Ohne diese Zeile griffe sie erst beim
        // naechsten Start. `maschinenAktiv()` bereinigt die Liste um die
        // pausierten Maschinen (04.09.) -- fuer sie darf kein ssh-Aufruf mehr
        // entstehen, und `hostsSetzen()` raeumt ihren gemerkten Stand ohnehin
        // schon ab, sobald sie aus der uebergebenen Liste faellt (remote.ts).
        if (!process.env.AWB_REMOTE_MACHINES) remotePoller.hostsSetzen(maschinenAktiv(config.settingsFile));
        // Spiegel-Panes pausierter Maschinen abraeumen (04.09.): rein lokal,
        // aus dem Pane-Stand, den `modellLesen()` eben schon geholt hat (siehe
        // `panesHinweisOderFrisch`) -- kein zusaetzlicher tmux-Aufruf im
        // Regelfall, in dem nichts zu tun ist. Neue Spiegel legt diese
        // Werkbank ohnehin nie selbst an (siehe main.ts weiter oben); dieser
        // Schritt entfernt nur, was von einem frueheren Lauf oder einem
        // von Hand getippten `wb-remote-view` noch steht.
        const pausiert = maschinenPausiert(config.settingsFile);
        if (pausiert.length) {
          const { panes: allePanesJetzt } = panesHinweisOderFrisch(config.tmuxSocket);
          const tmuxArgs = config.tmuxSocket ? ['-L', config.tmuxSocket] : [];
          for (const host of pausiert) {
            for (const paneId of fremdeSpiegelPanes(allePanesJetzt, host)) {
              try {
                spawnSync('tmux', [...tmuxArgs, 'kill-pane', '-t', assertPaneId(paneId)], { encoding: 'utf8', timeout: 2000 });
              } catch (e) {
                process.stderr.write(`Spiegel-Pane von '${host}' nicht abgeraeumt: ${(e as Error).message}\n`);
              }
            }
          }
        }
        modellSenden();
        freigabenAktualisieren();
        ergebnissePruefen();
        budgetMeldungPruefen();
        // Die Kontextwache der Chat-Sitzungen (15.08.). Sie haengt an diesem
        // Takt und nicht an einer eigenen Uhr: ihre Fristen und die Anzeige
        // sollen von derselben Zeit sprechen.
        chatbuehne.wacheTakt();
      } catch {
        // Ein Lesefehler haelt die Oberflaeche nicht an; der naechste Takt kommt.
      }
    })();
  }, 2000);
  // Einmal sofort, nicht erst nach zwei Sekunden: der Altbestand wird dabei
  // still vermerkt (results.ts), und ein Ergebnis, das gerade eben entstanden
  // ist, meldet sich ohne Wartezeit.
  ergebnissePruefen();

  // Sichtbar startet das Fenster nur, wenn ein MENSCH es ausdruecklich
  // verlangt. Kein Automatismus fuehrt hierher.
  if (win && zeigen) win.show();
  else if (win && zeigenInaktiv) win.showInactive();

  // Der geführte erste Start (SPEC-V4 3.8): „beim ersten Start, und danach nie
  // wieder von selbst". `baue()` läuft IMMER (auch --headless), damit ein Test
  // ohne einen einzigen echten Klick prüfen kann, ob der Weg überhaupt anläuft
  // (erststartfenster.ts, Klassendoc) -- `zeigeAutomatisch()` zeigt das
  // Fenster nur, wenn auch das Hauptfenster wirklich sichtbar wird (`zeigen`).
  //
  // Im Mantelbetrieb NICHT (Auftrag 4.1): die Mac-Fassung fuehrt den ersten
  // Start als eigenes Blatt (Erststart.swift), und `baue()` liefe hier gegen
  // die Fenstersperre -- ein geworfener Fehler mitten im Start, fuer ein
  // Fenster, das niemand haben will.
  if (!mantelBetrieb && !erststartErledigt(config.settingsFile)) {
    await erststartfenster.zeigeAutomatisch(zeigen);
  }

  // Das eine Selbstfoto aus --startfoto: der einzige Weg an ein Bild, wenn es
  // keinen Steuerkanal gibt. Ein Fehler daran haelt den Start nicht auf.
  // Ohne Fenster gibt es nichts zu fotografieren -- das Bild der Mac-Fassung
  // macht `awbmac-ctl schuss`.
  if (win && config.startShot) {
    await captureWindow(win, config.shotDir, config.startShot)
      .catch((e) => process.stderr.write(`startfoto fehlgeschlagen: ${(e as Error).message}\n`));
  }

  // Die Bereitschaftszeile nennt beides: dass das Fenster steht, und ob ein
  // Kanal daran haengt. Wer den Kanal braucht, wartet weiter auf 'awb-ready ' --
  // die zweite Zeile matcht das absichtlich nicht. Ohne Fenster steht dort
  // 0x0: der Kern hat keine Groesse, und `mac/bin/starten` liest nur auf das
  // Wort 'awb-ready'.
  const groesse = win ? win.getContentSize() : [0, 0];
  if (kanalFehler) {
    process.stdout.write(`awb-fenster-ohne-kanal ${groesse[0]}x${groesse[1]} ${config.controlSocket}: ${kanalFehler}\n`);
  } else {
    process.stdout.write(`awb-ready ${config.controlSocket}\n`);
  }
}).catch((e) => {
  // Kein ungefangener Fehlschlag mehr aus diesem then(): was das Fenster
  // wirklich verhindert, endet laut und lesbar statt als Geisterprozess ohne
  // Fenster und ohne Kanal.
  process.stderr.write(`Start fehlgeschlagen: ${(e as Error)?.stack ?? e}\n`);
  void shutdown(1);
});

// Electron beendet den Prozess bei SIGTERM selbst und laesst die
// Signalhandler von Node NICHT laufen -- gemessen: kein Handler-Ausdruck im
// Protokoll, und die Session blieb auf der Fuellgroesse stehen. Diese beiden
// Ereignisse sind der Weg, auf dem Electron seinen eigenen Ausstieg meldet.
function zurueckstellen(): void {
  try {
    tmux?.zustandZurueckSync();
  } catch {
    // Ein Fehler beim Zurueckstellen darf das Beenden nicht aufhalten.
  }
  // UND DIE LEBENSSPUR LOESCHEN (11.08.). Wer ordentlich zumacht, hat kein
  // Ende verpasst -- er hoert auf hinzusehen. Ohne diesen Schritt stuenden
  // nach jedem gewoehnlichen Neustart des Rechners saemtliche Sitzungen als
  // verloren in der linken Spalte, weil der Neustart den tmux-Server
  // mitnimmt: genau die Menge, die A12 verbergen soll. Ein Absturz kommt an
  // diese Stelle nicht, und das ist der ganze Unterschied. Die Kehrseite
  // steht im Kopf von lebensspur.ts.
  try {
    lebensspur.sauberBeendet();
  } catch {
    // dito -- ein nicht schreibbarer Zustand haelt das Beenden nicht auf.
  }
  // UND DIE KINDER DER CHAT-SITZUNGEN, synchron (Befund B5, gemessen 12.08.).
  // Sie gehoeren aus demselben Grund hierher wie das Zurueckstellen: auf einem
  // Signal laeuft von Node nichts mehr -- gemessen wurde weder der
  // SIGTERM-Handler noch ein `exit`-Haken erreicht, der Prozess war nach rund
  // 500 ms weg. Diese beiden Ereignisse sind der einzige Weg, auf dem Electron
  // seinen Ausstieg vorher meldet, und `beendeKinderSynchron()` haelt ihn so
  // lange auf, wie das Ende der Kinder dauert -- hoechstens zwei Sekunden,
  // dann faellt der Rest hart.
  try {
    const uebrig = chatbuehne.beendeKinderSynchron();
    if (uebrig > 0) process.stderr.write(`Chatbuehne: ${uebrig} Kind(er) ueberlebten das Beenden\n`);
  } catch {
    // Ein Fehler beim Beenden der Kinder darf den Ausstieg nicht aufhalten.
  }
  // UND WIRKLICH BEENDEN (Betriebsbefund 2026-08-20): bis heute endete diese
  // Funktion hier, in der Annahme, Electrons eigene Weiterfuehrung des
  // Ausstiegs erledige den Rest zuverlaessig. Gemessen war das falsch --
  // `osascript` zeigte schon eine LEERE Fensterliste (Electrons native
  // Aufraeumung lief also), waehrend der Prozess selbst noch 45+ Sekunden bei
  // 0,0% CPU weiterlief, bis nur noch SIGKILL half. Jeder Schritt oben ist
  // jetzt selbst mit einer Frist versehen (siehe zustandZurueckSync() in
  // tmux.ts), also kommt diese Stelle garantiert an -- und beendet den
  // Prozess jetzt SELBST, statt auf Electrons Fortsetzung zu hoffen. Zweimal
  // aufgerufen (before-quit UND will-quit feuern beide hierher) schadet
  // nicht: der erste Aufruf beendet den Prozess, der zweite findet keinen
  // mehr vor.
  app.exit(0);
}
app.on('before-quit', zurueckstellen);
app.on('will-quit', zurueckstellen);

app.on('window-all-closed', () => void shutdown(0));
// Bei einem Signal bleibt fuer asynchrone Arbeit keine Zeit mehr -- gemessen
// blieb die fremde Session dann auf der Fuellgroesse stehen. Das
// Zurueckstellen laeuft deshalb hier synchron, bevor der Rest folgt.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    try {
      tmux?.zustandZurueckSync();
    } catch {
      // Ein Fehler beim Zurueckstellen darf das Beenden nicht aufhalten.
    }
    // DIE KINDER GEHEN UEBER `shutdown()`, und das reicht -- nachgemessen in der Nacht
    // zum 16.08. (Befund 8 der Bugjagd, der genau das Gegenteil vermutete).
    // Der Kommentar an dieser Stelle behauptete bis dahin, die Kinder bekaemen
    // ihr SIGTERM HIER, synchron; `chatbuehne.beendeKinderSynchron()` steht
    // aber nur in `zurueckstellen()` an before-quit/will-quit, nicht hier.
    // GEMESSEN mit einer offenen Chat-Sitzung auf eigenem Socket: ein
    // Kindprozess, der SIGTERM ueberhoert UND an seinem stdin festhaelt, war
    // vier Sekunden nach `kill -TERM` auf die App weg -- der Weg ueber
    // `shutdown()` -> `alleBeenden()` kommt also bis zu seinem SIGKILL. Ohne
    // reproduzierten Fehlschlag bleibt der synchrone Aufruf hier draussen; er
    // haenge den Ausstieg nur um bis zu zwei Sekunden auf.
    void shutdown(0);
  });
}
