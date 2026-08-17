// Die Einstellungs-Seite der VS-Code-Erweiterung -- seit dem 11.08. eine DUENNE
// Seite, die auf das Programm zeigt und es oeffnet.
//
// WARUM SIE NICHT MEHR EINSTELLT. Bis heute gab es ZWEI gepflegte Oberflaechen
// fuer dieselbe Datei (~/.claude/workbench/settings.json): diese hier und das
// Menue der Werkbank-App. Die Inventur vom 11.08. hat gezeigt, was daraus
// geworden ist:
//
//   * Fuenf Schluessel standen NUR hier (workerLayout, terminalStartMaximized,
//     newSessionDefaultDir, workerPollSeconds, modelDiscoveryAuto). Wer nur die
//     App benutzte, sah sie nie.
//   * Zwei Schreibwege fuehrten auf dieselbe Wirkung: `guardOrchWarnPct` und
//     `guardWorkerWarnPct` hier, `kontextwache.mahnenAb` dort -- und im Code
//     gewinnt `kontextwache` (shell/context-guard, resolve_pct). Ein Mensch,
//     der beide Oberflaechen benutzt, kann das nicht wissen.
//
// Zwei Orte fuer dieselbe Entscheidung sind zwei Wahrheiten, von denen eine
// irgendwann die falsche ist. Entscheidung des Nutzers dazu (11.08.): die
// Erweiterung behaelt ihre Oberflaeche NICHT als zweiten Einstellungsweg. Was
// hier gebraucht wurde, ist vorher in das Menue der App gewandert; die beiden
// toten Doppelwege sind ersatzlos weg.
//
// WAS BLEIBT. Der Aufruf `renderSettingsHtml(...)` behaelt seine Signatur, denn
// zwei Stellen rufen ihn: `settingsView.ts` in der Erweiterung und
// `app/src/main/seiten.ts` in der App. Die Parameter werden nicht mehr
// ausgewertet -- die Seite haengt an keinem von ihnen, und genau das ist der
// Punkt. Die Registry-Ansicht ("Modelle & Harnesses") ist mit der Seite
// gegangen: sie schrieb nie in die Einstellungen, sondern rief `wb-state`, und
// dieselben Tabellen stehen jetzt im Menue der App auf der Seite "Programme und
// Modelle".
import { escapeHtml } from './format.ts';
import type { ModelsRegistry } from './models.ts';
import { parseModelsRegistry } from './models.ts';
import type { HookEntry } from './hooksInfo.ts';
import type { ProviderKeyStatus } from './providerSecrets.ts';
import type { LaunchdJob, PathInfo } from './systemInfo.ts';
import { type Settings, settingsFile } from './settings.ts';

/** Wo das Programm liegt, das die Einstellungen fuehrt. */
const APP_PFAD = '/Applications/Agent Workbench.app';

/**
 * Die Handvoll Saetze dieser duennen Seite, DE und EN (SPEC-V4 Abschnitt 4, Englisch als
 * Vorgabe). Keine eigene `t()`-Tabellendatei fuer sieben Zeilen -- die Seite ist absichtlich
 * duenn geblieben (siehe den Kopf dieser Datei), eine zweite Datei dafuer waere mehr Bauform als
 * Inhalt.
 */
const TEXTE: Record<'de' | 'en', {
  titel: string;
  stand: (harness: string) => string;
  einleitung: string;
  oeffnenKnopf: string;
  oeffnenHinweis: (pfad: string) => string;
  findestDu: string;
  seiten: [string, string][];
  dateiSatz: (pfad: string) => string;
  statusOeffnet: string;
}> = {
  de: {
    titel: 'Einstellungen',
    stand: (harness) => `Im Hauptfenster läuft gerade <span class="file" id="harness">${harness || '—'}</span>. Geändert wird das im Programm.`,
    einleitung: 'Die Einstellungen der Werkbank stehen seit dem 11. August im Programm selbst — auf sieben '
      + 'Seiten, jede Option mit einer Erklärung daneben. Diese Seite stellt nichts mehr ein: zwei '
      + 'Oberflächen für dieselbe Datei hießen zwei Wahrheiten, und einige Schalter gab es nur hier, '
      + 'andere nur dort.',
    oeffnenKnopf: 'Einstellungen im Programm öffnen',
    oeffnenHinweis: (pfad) => `Öffnet <span class="file">${pfad}</span>. Dort führt das Zahnrad unten links zum Menü.`,
    findestDu: 'Was du dort findest:',
    seiten: [
      ['Sitzung', 'womit eine neue Sitzung anfängt: Programm, Modell, Denkstufe, Startordner.'],
      ['Erlaubnisse', 'was die Agenten dürfen: Sicherungen, Rückfragen, ausgelassene Pfade.'],
      ['Programme und Modelle', 'anmelden, lokale Modelle anbinden, Deckel je Modell.'],
      ['Maschinen', 'welche Rechner mitarbeiten und wie viel jeder trägt.'],
      ['Aufsicht und Meldungen', 'die Kontextwache und wovon du erfahren willst.'],
      ['Aussehen', 'hell und dunkel, Schrift, Sprache.'],
      ['Programm', 'Pfade, Abweichungen von der Auslieferung, Sichern und Zurücksetzen.'],
    ],
    dateiSatz: (pfad) => `Die Datei, um die es geht: <span class="file">${pfad}</span>. `
      + `Geschrieben wird sie ausschließlich über <span class="file">wb-state settings set</span> — auch vom Programm.`,
    statusOeffnet: 'Öffne das Programm …',
  },
  en: {
    titel: 'Settings',
    stand: (harness) => `The main window is currently running <span class="file" id="harness">${harness || '—'}</span>. Change that in the program.`,
    einleitung: 'The workbench\'s settings have lived in the program itself since August 11 — across seven '
      + 'pages, every option with an explanation next to it. This page no longer sets anything: two '
      + 'interfaces for the same file meant two truths, and some switches only existed here, others only there.',
    oeffnenKnopf: 'Open settings in the program',
    oeffnenHinweis: (pfad) => `Opens <span class="file">${pfad}</span>. The gear icon at the bottom left leads to the menu.`,
    findestDu: 'What you\'ll find there:',
    seiten: [
      ['Session', 'what a new session starts with: program, model, effort level, starting folder.'],
      ['Permissions', 'what agents are allowed to do: safeguards, ask-first prompts, skipped paths.'],
      ['Programs and models', 'sign in, connect local models, per-model caps.'],
      ['Machines', 'which machines work along, and how much each of them carries.'],
      ['Oversight and notifications', 'the context guard and what you want to hear about.'],
      ['Appearance', 'light and dark, font, language.'],
      ['Program', 'paths, deviations from the shipped defaults, backup and reset.'],
    ],
    dateiSatz: (pfad) => `The file this is all about: <span class="file">${pfad}</span>. `
      + `It is written to exclusively via <span class="file">wb-state settings set</span> — the program included.`,
    statusOeffnet: 'Opening the program …',
  },
};

export function renderSettingsHtml(
  settings: Settings,
  codiconHref: string,
  cspSource: string,
  nonce: string,
  // Ab hier wird nichts mehr ausgewertet. Die Parameter stehen, damit die
  // beiden Aufrufstellen unveraendert bleiben; sie beschreiben, was die Seite
  // frueher zeichnete.
  _modelsRegistry: ModelsRegistry = parseModelsRegistry(undefined),
  _providerKeyStatus: Record<string, ProviderKeyStatus> = {},
  _modelsStatusText?: string,
  _harnessBinaryPresence: Record<string, boolean> = {},
  _mcpSharedStatusText?: string,
  _hooks: HookEntry[] = [],
  _pathInfo: PathInfo[] = [],
  _launchdJobs: LaunchdJob[] = [],
  _machine?: string,
  _secretExcludeDirs: string[] = [],
  _secretExcludePatterns: string[] = [],
  _logPaths: { label: string; path: string }[] = [],
  // Die Sprache der Oberflaeche (SPEC-V4 Abschnitt 4). Beide Aufrufstellen
  // kennen sie: die App ueber `sprache()` (einstellungen.ts), die Erweiterung
  // ueber das rohe `sprache`-Feld aus `readRawSettings()` -- der Schluessel
  // steht nicht im Settings-Typ dieser Datei, weil die Erweiterung ihn nie
  // schreibt, nur anzeigt. Englisch ist die Auslieferungssprache.
  sprache: string = 'en',
): string {
  // Der einzige Wert, den die Seite noch zeigt: wo die Datei liegt, um die es
  // geht. Er kommt aus derselben Quelle wie zuvor, damit hier keine zweite
  // Vorstellung davon entsteht, wo die Einstellungen wohnen.
  const datei = settingsFile();
  const harness = escapeHtml(settings.orchestratorHarness ?? '');
  const sp = sprache === 'de' ? 'de' : 'en';
  const x = TEXTE[sp];
  const titelTag = sp === 'de' ? 'Claude Workbench — Einstellungen' : 'Claude Workbench — Settings';
  const seitenListe = x.seiten.map(([name, satz]) => `  <li><b>${escapeHtml(name)}</b> — ${escapeHtml(satz)}</li>`).join('\n');
  return `<!DOCTYPE html>
<html lang="${sp}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${codiconHref}">
<title>${titelTag}</title>
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    padding: 32px 40px 48px;
    line-height: 1.5;
  }
  h1 { font-size: 1.5rem; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.01em; }
  p { max-width: 68ch; }
  .file { color: var(--vscode-descriptionForeground); font-size: 0.8rem;
          font-family: var(--vscode-editor-font-family); word-break: break-all; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 0.85rem; max-width: 68ch; }
  .stand { margin: 0 0 12px; }
  button.oeffnen {
    font-family: inherit; font-size: 0.9rem; border: none; border-radius: 4px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    padding: 8px 18px; margin: 16px 0 4px;
  }
  button.oeffnen:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  ul { max-width: 68ch; padding-left: 20px; }
  li { margin: 4px 0; }
  .status { margin-top: 20px; color: var(--vscode-descriptionForeground); font-size: 0.8rem;
            min-height: 1.2em; }
</style>
</head>
<body>
<h1>${escapeHtml(x.titel)}</h1>
<p class="stand">${x.stand(harness)}</p>
<p>${escapeHtml(x.einleitung)}</p>

<button type="button" class="oeffnen" id="oeffnen">${escapeHtml(x.oeffnenKnopf)}</button>
<div class="hint">${x.oeffnenHinweis(escapeHtml(APP_PFAD))}</div>

<p class="hint">${escapeHtml(x.findestDu)}</p>
<ul class="hint">
${seitenListe}
</ul>

<p class="hint">${x.dateiSatz(escapeHtml(datei))}</p>

<div class="status" id="status"></div>

<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const status = document.getElementById('status');
  document.getElementById('oeffnen').addEventListener('click', () => {
    status.textContent = ${JSON.stringify(x.statusOeffnet)};
    vscodeApi.postMessage({ command: 'open-app' });
  });
  window.addEventListener('message', (event) => {
    const nachricht = event.data;
    if (nachricht && nachricht.type === 'status') status.textContent = nachricht.text || '';
  });
</script>
</body>
</html>`;
}
