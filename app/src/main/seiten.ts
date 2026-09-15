// Schritt 7: Startseite, Einstellungen und Modelle wandern herueber.
//
// UNVERAENDERT heisst hier woertlich unveraendert: Diese Datei erzeugt kein
// eigenes HTML. Sie ruft dieselben Renderfunktionen auf, die die Extension
// benutzt (`extension/src/homeHtml.ts`, `settingsHtml.ts`, `modelsHtml.ts`),
// und sammelt nur die Daten dafuer ein. Der Plan hat vorher nachgemessen, dass
// keine dieser Dateien `vscode` importiert -- sie sind reine Funktionen von
// Daten nach HTML, und genau deshalb ueberlebt der Umzug sie vollstaendig.
//
// EIN EINZIGES GEBORGTES STUECK bleibt: Kopiert wird nicht, importiert wird.
// Solange die Extension parallel laeuft (Plan: "Die Extension bleibt
// unangetastet, bis V2 einen ganzen Arbeitstag getragen hat"), gaebe eine Kopie
// zwei Fassungen, die auseinanderlaufen. Wenn die Extension geht, ziehen die
// Dateien um; der Aufruf hier bleibt derselbe.
//
// WAS SICH AENDERT, ist genau das, was der Plan nennt: das URI-Schema der
// Ressourcen. Im Webview kam das Symbol-Stylesheet ueber `vscode-resource:`;
// hier gibt es keinen Host, der so etwas ausliefert. Statt eines neuen Schemas
// bekommt die Seite ihre Ressourcen als `data:`-URI mitgegeben -- damit gibt es
// gar keine externe Anfrage mehr, und die eingebaute CSP der Seite
// (`default-src 'none'`) bleibt so streng, wie sie war.
import { readFileSync, existsSync, accessSync, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  renderHtml as renderHomeHtml, DEFAULT_TEXTE as STARTSEITE_DE,
  type HomeTexte, type SessionCard,
} from '../../../extension/src/homeHtml.ts';
import { renderSettingsHtml } from '../../../extension/src/settingsHtml.ts';
import { parseModelsRegistry, effectiveHarnesses } from '../../../extension/src/models.ts';
import { parseSettings } from '../../../extension/src/settings.ts';
import { ausschlussOrdner, ausschlussMuster, sprache } from './einstellungen';
import { protokollListe } from './protokolle';
import { rollenCss } from './thema';
import type { WorkerView } from '../../../extension/src/workers.ts';
import type { SessionInfo } from './sessions';

export type SeitenName = 'start' | 'einstellungen';

/**
 * Das Schema, unter dem die Seiten ausgeliefert werden. Sie brauchen eine
 * EIGENE Herkunft: ein Rahmen mit `about:blank` erbt die CSP des Fensters, und
 * die laesst nur das eigene Buendel als Skript zu -- die Seiten stuenden dann
 * da, ohne dass ein Knopf etwas taete (gemessen 05.08.: der Knopf war da, sein
 * Ereignis nie). Mit eigenem Schema gilt ihre eigene CSP, wie im Webview.
 */
export const SEITEN_SCHEMA = 'awb-seite';

/**
 * Der Steg zwischen Seite und Wirt. VS Code legt in JEDES Webview-Dokument ein
 * solches Stueck: die Seite ruft `acquireVsCodeApi()` und schickt danach
 * Nachrichten. Hier fuehrt der Weg ueber `window.parent`, weil die Seite in
 * einem Rahmen dieses Fensters liegt.
 *
 * Es traegt die NONCE der Seite -- ohne sie wuerde ihre eigene CSP es abweisen,
 * und das ist richtig so: Auch der Wirt bekommt keinen Freibrief.
 */
function bootstrap(nonceWert: string): string {
  return `<script nonce="${nonceWert}">
(function () {
  // 1. Der Steg, den die Seite erwartet.
  window.acquireVsCodeApi = function () {
    var zustand;
    return {
      postMessage: function (daten) { window.parent.postMessage({ __awbSeite: true, daten: daten }, '*'); },
      getState: function () { return zustand; },
      setState: function (s) { zustand = s; return s; }
    };
  };

  // 2. Das Thema. Im Webview setzt es der Wirt in das Dokument; hier tut es
  //    dieses Stueck, weil der Wirt wegen der eigenen Herkunft nicht mehr
  //    hineingreifen kann. Die Rollen (main/thema.ts, ROLLEN) stehen fuer
  //    HELL UND DUNKEL im Dokument; welches gilt, entscheidet data-thema
  //    unten -- als VORGABE dunkel (wie jedes andere Fenster startet), bis
  //    seiten-view.ts das echte Thema durchreicht (Punkt 3b).
  document.addEventListener('DOMContentLoaded', function () {
    var st = document.createElement('style');
    st.id = 'awb-thema';
    st.textContent = ${JSON.stringify(VSCODE_FARBEN)};
    (document.head || document.documentElement).appendChild(st);
  });

  // 3a. Die Auskunft an den Wirt. Er kann das Dokument nicht mehr lesen, also
  //    beantwortet die Seite seine Fragen selbst -- dieselben drei, die eine
  //    Pruefung und die Abnahme am Auge brauchen: was steht da, klick das,
  //    roll dorthin.
  // 3b. Thema und Akzent VOM Wirt: kein main.ts-Eingriff traegt sie in dieses
  //    Dokument (main/seiten.ts liefert nur einmalig aus, ohne das lebende
  //    Thema zu kennen -- siehe OFFEN-farbsystem.md), also schickt
  //    seiten-view.ts sie per Botschaft, bei jedem Laden und bei jedem
  //    spaeteren Wechsel. Keine Antwort noetig, deshalb fruehes 'return'.
  window.addEventListener('message', function (e) {
    var f = e.data;
    if (f && f.__awbThema === true) {
      document.documentElement.dataset.thema = f.wirksam;
      if (f.akzent) document.documentElement.style.setProperty('--akzent', f.akzent);
      if (f.akzentTinte) document.documentElement.style.setProperty('--akzent-tinte', f.akzentTinte);
      if (f.akzentText) document.documentElement.style.setProperty('--akzent-text', f.akzentText);
      return;
    }
    if (!f || f.__awbAn !== true) return;
    var antwort = null;
    try {
      if (f.was === 'zustand') {
        var text = (document.body && document.body.innerText) || '';
        antwort = {
          textAnfang: text.split('\\n').filter(function (z) { return z.trim(); }).slice(0, 12),
          laenge: text.length,
          knoepfe: document.querySelectorAll('button').length,
          nichtStartbar: [].slice.call(document.querySelectorAll('[data-status="binary-missing"]'))
            .map(function (el) { return el.getAttribute('data-model') || ''; })
            .filter(Boolean),
          nichtStartbarText: [].slice.call(document.querySelectorAll('[data-status="binary-missing"] .statusLabel'))
            .map(function (el) { return (el.textContent || '').trim(); })
            .filter(Boolean),
          ausschluss: {
            ordner: ((document.querySelector('#secretExcludeDirs') || {}).textContent || '').trim(),
            muster: ((document.querySelector('#secretExcludePatterns') || {}).textContent || '').trim()
          },
          logPaths: ((document.querySelector('#logPaths') || {}).textContent || '').trim(),
          // Reste-Auftrag Punkt 3: gezielt GELESEN statt ueber ein 'focusin'-
          // Ereignis gemeldet -- dieses Fenster bekommt nie programmatisch den
          // Fokus (main.ts: "kein win.focus()"), und in einem Dokument ohne
          // eigenen Fokus (document.hasFocus() === false, gemessen) unterdrueckt
          // Chromium die Fokus-EREIGNISSE, obwohl activeElement stimmt. Ein
          // Lesen des aktuellen Standes bleibt davon unberuehrt.
          feldFokussiert: !!document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(document.activeElement.tagName) !== -1
        };
      } else if (f.was === 'klick') {
        var el = document.querySelector(f.auswahl);
        if (el) { el.click(); antwort = true; } else { antwort = false; }
      } else if (f.was === 'rolle') {
        var z = document.querySelector(f.auswahl);
        if (z) { z.scrollIntoView({ block: 'start' }); antwort = true; } else { antwort = false; }
      } else if (f.was === 'fokus') {
        // Nur fuer die Pruefung der Auffrischung: el.click() bewegt den
        // Fokus bei einem Textfeld NICHT zuverlaessig (das ist ein Nebeneffekt
        // des echten Mousedown, nicht des click()-Aufrufs) -- deshalb ein
        // eigener Weg statt 'klick' zu ueberladen.
        var fel = document.querySelector(f.auswahl);
        if (fel && fel.focus) { fel.focus(); antwort = true; } else { antwort = false; }
      } else if (f.was === 'unfokus') {
        // Nur fuer die Pruefung der Auffrischung (Reste-Auftrag, Punkt 3):
        // ein Feld gezielt verlassen, ohne auf Klick-Nebenwirkungen eines
        // ANDEREN Elements angewiesen zu sein.
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        antwort = true;
      }
    } catch (err) {
      antwort = { fehler: String(err) };
    }
    window.parent.postMessage({ __awbAntwort: true, nr: f.nr, antwort: antwort }, '*');
  });
}());
</script>`;
}

/** Den Steg vor dem Skript der Seite einsetzen -- der Rest bleibt unberuehrt. */
function mitBootstrap(html: string, nonceWert: string): string {
  const i = html.indexOf('</head>');
  return i < 0 ? bootstrap(nonceWert) + html : html.slice(0, i) + bootstrap(nonceWert) + html.slice(i);
}

/** Wo die Symbole der Seiten liegen. Im Paket neben der Extension, wie bisher. */
function medienOrdner(): string {
  // dist/main/main.js -> ../../../extension/media, und im Quellbaum genauso.
  const kandidaten = [
    join(__dirname, '..', '..', '..', 'extension', 'media'),
    join(__dirname, '..', '..', 'extension', 'media'),
  ];
  for (const k of kandidaten) if (existsSync(join(k, 'codicon.css'))) return k;
  return kandidaten[0];
}

/**
 * Das Symbol-Stylesheet als `data:`-URI, mit der Schriftdatei darin. Der
 * Webview lud beides ueber zwei Anfragen an einen Host; hier gibt es keinen,
 * also reist alles im Dokument mit. Die `url(...)`-Angabe in codicon.css zeigt
 * danach auf eine `data:`-URI statt auf eine Datei.
 *
 * Einmal gebaut und behalten: 110 KB, und die Seite wird bei jeder Aenderung
 * neu gezeichnet.
 */
let symboleCache: string | null = null;
function symbolStylesheet(): string {
  if (symboleCache !== null) return symboleCache;
  const ordner = medienOrdner();
  let css = '';
  try {
    css = readFileSync(join(ordner, 'codicon.css'), 'utf8');
    const ttf = readFileSync(join(ordner, 'codicon.ttf')).toString('base64');
    css = css.replace(/url\(["']?\.\/codicon\.ttf[^)]*\)/g, `url("data:font/ttf;base64,${ttf}")`);
  } catch {
    // Ohne Symbole ist die Seite lesbar, nur schmuckloser -- das ist kein Grund,
    // sie gar nicht zu zeigen.
    css = '';
  }
  symboleCache = `data:text/css;base64,${Buffer.from(css + VSCODE_FARBEN, 'utf8').toString('base64')}`;
  return symboleCache;
}

/**
 * Die Seiten sind in den Farbvariablen von VS Code geschrieben
 * (`var(--vscode-foreground)` und rund dreissig weitere). Ohne einen Host, der
 * sie setzt, waeren sie unlesbar -- schwarze Schrift auf schwarzem Grund.
 *
 * JEDER `--vscode-*`-Name ist hier ein VERWEIS auf eine ROLLE aus main/thema.ts
 * (`rollenCss()`, dieselbe Quelle wie `thema/tokens.css` fuer die fuenf echten
 * Fenster) -- kein einziger Hex-Wert steht mehr eigens hier. `--vscode-button-*`
 * zeigt auf `--akzent` statt auf eine eigene gruene Markenfarbe: der Knopf
 * dieser Seiten fuehrt dieselbe Farbe wie der Hauptknopf jedes anderen
 * Fensters. HELL UND DUNKEL tragen beide vollstaendig -- welches gilt,
 * entscheidet `data-thema` auf diesem Dokument (bootstrap() oben, Punkt 3b).
 *
 * `FARBEN_SHIM` und `THEMA` waren bis 03.09. zwei fast identische, leicht
 * auseinandergelaufene Kopien derselben Werte (verschiedene Rotoene fuer
 * Link/Fehler/Diagramm) -- genau die Art Drift, die ein Token-System
 * verhindern soll. Jetzt ist es eine Konstante, zweimal gebraucht.
 */
const VSCODE_FARBEN = `
${rollenCss()}
:root {
  --vscode-font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui;
  --vscode-font-size: 13px;
  --vscode-foreground: var(--schrift);
  --vscode-descriptionForeground: var(--gedaempft);
  --vscode-editor-background: var(--grund);
  --vscode-editor-foreground: var(--schrift);
  --vscode-panel-border: var(--linie);
  --vscode-widget-border: var(--linie);
  --vscode-focusBorder: var(--akzent);
  --vscode-button-background: var(--akzent);
  --vscode-button-foreground: var(--akzent-tinte);
  /* NEUTRAL, nicht --akzent: homeHtml.ts gibt diesen Rahmen JEDEM Knopf, auch
     den zweitrangigen ("Einstellungen", "Aktualisieren"). Mit dem Akzent darin
     sahen alle drei Knoepfe gleich wichtig aus -- auf einem Mac traegt genau
     EIN Knopf je Bereich die Akzentfarbe, die uebrigen einen grauen Rand. */
  --vscode-button-border: var(--linie);
  /* Heller/dunkler statt einer zweiten fest verdrahteten Farbe: --akzent kommt
     live vom System und kann jeder Farbton sein -- color-mix() Richtung der
     eigenen Tinte wirkt auf jeden Farbton gleich (dunkle Tinte: abdunkeln;
     helle Tinte: aufhellen), dasselbe Prinzip wie filter: brightness() beim
     Hauptknopf des Sitzungsfensters. */
  --vscode-button-hoverBackground: color-mix(in srgb, var(--akzent) 85%, var(--akzent-tinte) 15%);
  --vscode-button-secondaryBackground: var(--erhoben);
  --vscode-button-secondaryForeground: var(--schrift);
  --vscode-button-secondaryHoverBackground: var(--linie);
  --vscode-input-background: var(--leiste);
  --vscode-input-foreground: var(--schrift);
  --vscode-input-border: var(--linie);
  --vscode-inputOption-activeBorder: var(--akzent);
  --vscode-dropdown-background: var(--leiste);
  --vscode-dropdown-foreground: var(--schrift);
  --vscode-dropdown-border: var(--linie);
  --vscode-list-hoverBackground: var(--erhoben);
  --vscode-list-activeSelectionBackground: var(--wahl);
  /* SCHRIFT auf dem Grund, nicht Flaeche: deshalb --akzent-text (kontrast-
     angepasst), nicht --akzent. Siehe akzentAufloesen() in main/thema.ts. */
  --vscode-textLink-foreground: var(--akzent-text);
  --vscode-textPreformat-foreground: var(--schrift);
  --vscode-textBlockQuote-background: var(--leiste);
  --vscode-editorWidget-background: var(--leiste);
  --vscode-badge-background: var(--linie);
  --vscode-badge-foreground: var(--schrift);
  --vscode-errorForeground: var(--aus);
  --vscode-editorWarning-foreground: var(--will);
  --vscode-charts-orange: var(--will);
  --vscode-testing-iconPassed: var(--laeuft);
  --vscode-charts-green: var(--laeuft);
  --vscode-charts-red: var(--aus);
  --vscode-charts-blue: var(--akzent);
  --vscode-scrollbarSlider-background: var(--linie);
  --vscode-scrollbarSlider-hoverBackground: var(--erhoben);
}
html, body { background: var(--vscode-editor-background); color: var(--vscode-foreground); }
`;


/**
 * Die Quelle, die die CSP der Seiten fuer Stylesheet und Schrift zulaesst. Im
 * Webview stand hier `vscode-resource:`; jetzt reist beides als `data:` mit.
 */
const CSP_QUELLE = 'data:';


function nonce(): string {
  return randomBytes(16).toString('base64');
}

// --- Daten fuer die Startseite ---------------------------------------------

/**
 * Die Karten der Startseite aus dem Sessionmodell, das die Anwendung ohnehin
 * schon liest (sessions.ts). Kein zweiter Weg zu denselben Dateien: was die
 * Seitenleiste zeigt, zeigt auch die Startseite, und ein Unterschied zwischen
 * beiden waere ein Fehler.
 */
export function startseitenKarten(sessions: SessionInfo[]): SessionCard[] {
  return sessions.map((s) => {
    const workers: WorkerView[] = s.workers.map((w) => ({
      name: w.name,
      kind: w.kind || 'claude',
      model: w.model,
      // DURCHGEREICHT, nicht neu gebildet (07.08.). Bis dahin stand hier
      // `w.alive ? 'running' : 'done'` -- zwei eigene Woerter neben den fuenf,
      // die das Programm ohnehin fuehrt, und 'done' kannte das Vokabular der
      // Anzeige gar nicht: im Etikett stand `undefined`. Gemerkt hat es
      // niemand, weil ein `as WorkerView` die Zuweisung dem Typpruefer entzog.
      // OHNE CAST ist genau diese Zeile die Bindung zwischen `WorkerState`
      // (sessions.ts) und `WorkerStatus` (extension/src/workers.ts): bekommt
      // eine der beiden Listen ein Wort, das die andere nicht kennt, faellt
      // die Typpruefung hier -- und nicht erst der Leser vor dem leeren
      // Etikett. Wer den Cast wieder einbaut, hebt sie wieder auf.
      status: w.state,
    }));
    const teile = s.dir.split('/').filter(Boolean);
    return {
      dir: s.dir,
      name: s.name,
      folderName: teile[teile.length - 1] ?? s.name,
      harness: 'claude',
      tmuxSession: s.tmuxSession,
      lastActive: s.lastActive,
      workers,
      tmuxAlive: s.alive,
    } satisfies SessionCard;
  });
}

/**
 * DIE STARTSEITE AUF ENGLISCH. `homeHtml.ts` traegt die deutschen Worte selbst
 * (`DEFAULT_TEXTE`) -- sie sind die Vorgabe, damit die VSCode-Erweiterung, die
 * dieselbe Datei benutzt, unveraendert dieselbe Seite bekommt. Die englische
 * Fassung braucht nur die Werkbank, deshalb steht sie hier und nicht dort.
 */
const STARTSEITE_EN: HomeTexte = {
  titel: 'Claude Workbench',
  neu: 'New session',
  einstellungen: 'Settings',
  aktualisieren: 'Refresh',
  fortsetzenUeberschrift: 'Resume a session',
  leer: 'No sessions yet. Start one in a project folder.',
  laedt: 'Loading the Peer sessions over SSH …',
  unerreichbar: 'Peer cannot be reached. Check the SSH connection (ssh peer) and refresh.',
  weitere: 'Another session',
  laeuft: 'running',
  beendet: 'stopped',
  eineSitzung: '1 session',
  mehrereSitzungen: '{n} sessions',
  ohneNachricht: 'No message found.',
  loeschen: 'Delete',
  fortsetzen: 'Resume',
  loeschenTipp: 'Remove this session — project files and the vault stay untouched',
  unsicherTipp: 'Several sessions in this folder; the transcript could not be matched to this one '
    + 'for certain. What is shown is the folder\'s most recently used transcript.',
  unsicher: 'Uncertain match — the preview and Resume may belong to another session in this folder.',
};

export function renderStartseite(
  sessions: SessionInfo[],
  machine: string,
  remoteMachines: readonly string[] = [],
  sprachwahl = 'de',
): string {
  const n = nonce();
  // Die Seite kennt zwei Reiter ('mac' | 'peer'). WELCHER Rechnername die
  // zweite Maschine ist, steht nicht mehr hier: die Liste kommt aus der
  // Konfiguration (AWB_REMOTE_MACHINES oder `remoteMachines` in den
  // Einstellungen, config.ts) und wird von main.ts durchgereicht. Frueher
  // stand der Name als Literal in dieser Zeile -- die einzige Stelle im
  // ganzen app/-Baum, die einen echten Rechnernamen vergleicht, und damit
  // die einzige, die eine Installation mit anderen Namen still falsch
  // beantwortet haette: dort faellt jeder Rechner auf 'mac' zurueck.
  //
  // Rechnernamen werden ohne Ruecksicht auf Gross- und Kleinschreibung
  // verglichen, weil sie das auch im Netz sind. Ein Name, der in keiner Liste
  // steht (ein fremdes Notebook, ein Test), faellt weiterhin auf 'mac'
  // zurueck, statt die Seite an einer Typpruefung scheitern zu lassen.
  const gleich = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const m = remoteMachines.some((r) => gleich(r, machine)) ? 'peer' : 'mac';
  // Kein Maschinen-Reiter hier (anders als in der Extension): `sessions` ist
  // bereits die ZUSAMMENGEFUEHRTE Liste beider Maschinen (V10,
  // app/src/main/sessions.ts) -- ein Reiter, der nichts filtert, waere ein
  // Knopf ohne Wirkung (05.08. gemessen: `switchMachine` hing an einem Stub,
  // der Reiter aenderte an der gezeigten Liste nichts).
  return mitBootstrap(renderHomeHtml(startseitenKarten(sessions), symbolStylesheet(), CSP_QUELLE, n, {
    machine: m,
    reachable: true,
    loading: false,
  }, false, sprachwahl === 'de' ? STARTSEITE_DE : STARTSEITE_EN), n);
}

// --- Daten fuer Einstellungen und Modelle ----------------------------------

function lies(pfad: string): string | undefined {
  try {
    return readFileSync(pfad, 'utf8');
  } catch {
    return undefined;
  }
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/**
 * V11 -- die Maschinen-Wahrheit. Genau die Pruefung, die auch `wb-state` vor
 * einem Spawn anwendet (`binary_missing`, dort ausdruecklich als "the exact gate
 * cmd_resolve applies" bezeichnet) und die die Routing-Tabelle als "NICHT
 * STARTBAR auf <maschine>" ausgibt: Ein Pfad mit Trenner muss ausfuehrbar sein,
 * ein blosser Name muss im PATH liegen.
 *
 * Zweimal dieselbe Regel waere Drift in Wartestellung -- deshalb steht hier
 * dieselbe Formulierung und nicht eine zweite, eigene Idee davon. Auf peer
 * betrifft das elf Modelle, auf dem Mac eines.
 */
export function harnessBinaerVorhanden(command: string): boolean {
  const expanded = expandHome(command || '');
  if (!expanded) return false;
  if (expanded.includes('/')) {
    try {
      accessSync(expanded, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  try {
    execFileSync('which', [expanded], { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Je Harness EINE Pruefung, nie je Modell. */
export function binaerVorhandenJeHarness(registryRaw: string | undefined): Record<string, boolean> {
  const registry = parseModelsRegistry(registryRaw);
  const raus: Record<string, boolean> = {};
  for (const h of effectiveHarnesses(registry)) raus[h.id] = harnessBinaerVorhanden(h.command ?? '');
  return raus;
}

export interface SeitenQuellen {
  settingsFile: string;
  modelsFile: string;
  /**
   * Die Fernmaschinen, schon aufgeloest (config.ts: AWB_REMOTE_MACHINES oder
   * `remoteMachines` aus den Einstellungen). Sie kommen fertig herein, damit
   * hier kein zweiter Leser derselben Einstellung entsteht.
   */
  remoteMachines?: readonly string[];
}

export function renderEinstellungen(q: SeitenQuellen, machine: string): string {
  const settings = parseSettings(lies(q.settingsFile));
  const registryRaw = lies(q.modelsFile);
  const registry = parseModelsRegistry(registryRaw);
  const n = nonce();
  return mitBootstrap(renderSettingsHtml(
    settings,
    symbolStylesheet(),
    CSP_QUELLE,
    n,
    registry,
    // Anbieter-Schluessel werden hier NICHT geprueft: Das ginge ins Netz und in
    // den Schluesselbund, und beides gehoert nicht in einen Zeichenvorgang.
    // Ohne Eintrag zeigt die Seite "unbekannt" statt "kaputt" -- so ist sie
    // ausdruecklich gebaut (siehe modelStatusDot).
    {},
    undefined,
    binaerVorhandenJeHarness(registryRaw),
    undefined,   // mcp-shared status: nicht abgefragt (Netz/Fremdprozess)
    [],          // hooks
    [],          // Pfadangaben
    [],          // launchd-Jobs
    machine,     // V11: WO ein Modell nicht anlaeuft
    // Plan 4c.2/A9: die Ausschlussliste, gelesen aus derselben Datei, die auch
    // der Editor fragt -- eine Quelle, zwei Leser, kein zweiter Vorrat.
    ausschlussOrdner(q.settingsFile),
    ausschlussMuster(q.settingsFile),
    // Schritt 9 (V16) nachgetragen: dieselbe Liste, die auch die Protokolle-
    // Ansicht liest -- eine Quelle, zwei Leser.
    protokollListe(q.settingsFile).map((p) => ({ label: p.label, path: p.path })),
    sprache(q.settingsFile),
  ), n);
}

export function renderSeite(name: SeitenName, sessions: SessionInfo[], machine: string, q: SeitenQuellen): string {
  return name === 'start'
    ? renderStartseite(sessions, machine, q.remoteMachines ?? [], sprache(q.settingsFile))
    : renderEinstellungen(q, machine);
}
