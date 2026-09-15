// Pure rendering for the Startseite webview (no vscode import — unit-testable).
import { escapeHtml, previewText, relativeTime } from './format.ts';
import { type Machine, MACHINE_LABEL, MACHINES } from './machine.ts';
import { HARNESS_LABEL } from './settings.ts';
import { STATUS_LABEL, type WorkerView } from './workers.ts';

/**
 * One card per SESSION, not per folder (SPEC-V2 D): `name` is the session name
 * alice gave it, `folderName`/`dir` locate it. Several cards of the same
 * folder are normal — they are told apart by name, session key and tmux session.
 */
export interface SessionCard {
  dir: string;
  /** Session name; falls back to the folder name when none was given. */
  name: string;
  folderName: string;
  /** Missing for the folder's default session. */
  sessionKey?: string;
  /** What orchestrates this session, informative (SPEC-V2 F); may be missing. */
  harness?: string;
  model?: string;
  tmuxSession?: string;
  lastActive?: string;
  sessionId?: string;
  lastUserMessage?: string;
  /**
   * The transcript behind sessionId/lastUserMessage could not be pinned to this
   * session (several sessions in the folder, name did not resolve it). Said out
   * loud on the card instead of silently showing the newest one.
   */
  transcriptUncertain?: boolean;
  workers: WorkerView[];
  tmuxAlive: boolean;
}

/** View state layered on top of the cards: which machine, and its reachability. */
export interface HomeView {
  machine: Machine;
  /** false only for a remote machine that could not be reached over SSH. */
  reachable: boolean;
  /** true while the remote state is still being fetched. */
  loading: boolean;
  error?: string;
}

const DEFAULT_VIEW: HomeView = { machine: 'mac', reachable: true, loading: false };

/**
 * DIE BESCHRIFTUNGEN DIESER SEITE, herausgezogen am 03.09.
 *
 * Diese Datei wird von ZWEI Programmen benutzt: von der VSCode-Erweiterung und,
 * ueber `app/src/main/seiten.ts`, von der Werkbank selbst. In der Werkbank steht
 * sie in einem Rahmen mitten im Hauptfenster -- und dessen uebrige Oberflaeche
 * hat seit dem 03.09. eine Sprachschicht. Ohne diesen Parameter blieb die Seite
 * deutsch, waehrend der Rahmen um sie herum englisch wurde.
 *
 * Der Parameter ist OPTIONAL und seine Vorgabe ist Wort fuer Wort das, was
 * vorher fest im Aufbau stand: die Erweiterung ruft `renderHtml` unveraendert
 * auf und bekommt unveraendert dieselbe Seite. Nur die Werkbank reicht ihre
 * eigene Tabelle durch.
 */
export interface HomeTexte {
  titel: string;
  neu: string;
  einstellungen: string;
  aktualisieren: string;
  fortsetzenUeberschrift: string;
  leer: string;
  laedt: string;
  unerreichbar: string;
  weitere: string;
  laeuft: string;
  beendet: string;
  eineSitzung: string;
  mehrereSitzungen: string;
  ohneNachricht: string;
  loeschen: string;
  fortsetzen: string;
  loeschenTipp: string;
  unsicherTipp: string;
  unsicher: string;
}

export const DEFAULT_TEXTE: HomeTexte = {
  titel: 'Claude Workbench',
  neu: 'Neue Session',
  einstellungen: 'Einstellungen',
  aktualisieren: 'Aktualisieren',
  fortsetzenUeberschrift: 'Sessions fortsetzen',
  leer: 'Noch keine Sessions. Starte eine neue Session in einem Projektordner.',
  laedt: 'Peer-Sessions werden über SSH geladen …',
  unerreichbar: 'Peer ist nicht erreichbar. SSH-Verbindung prüfen (ssh peer) und erneut aktualisieren.',
  weitere: 'Weitere Session',
  laeuft: 'läuft',
  beendet: 'beendet',
  eineSitzung: '1 Session',
  mehrereSitzungen: '{n} Sessions',
  ohneNachricht: 'Keine Nachricht gefunden.',
  loeschen: 'Löschen',
  fortsetzen: 'Fortsetzen',
  loeschenTipp: 'Diese Session entfernen — Projektdateien und Vault bleiben unberührt',
  unsicherTipp: 'Mehrere Sessions in diesem Ordner; das Transkript ließ sich dieser Session nicht '
    + 'eindeutig zuordnen. Gezeigt wird das zuletzt benutzte Transkript des Ordners.',
  unsicher: 'Zuordnung unsicher — Vorschau und Fortsetzen können zu einer anderen Session dieses Ordners gehören.',
};

export function renderHtml(
  cards: SessionCard[],
  codiconHref: string,
  cspSource: string,
  nonce: string,
  view: HomeView = DEFAULT_VIEW,
  /**
   * Die Extension holt je Maschine eine EIGENE Kartenliste (SSH-Rundreise fuer
   * peer, siehe homeView.ts) -- dort schaltet der Reiter also wirklich um, und
   * bleibt deshalb an (Vorgabe). Die App (V2) uebergibt bereits die
   * ZUSAMMENGEFUEHRTE Liste beider Maschinen (V10, sessions.ts:
   * `raus.push(...remoteSessions(...))`); ein Reiter, der nichts filtert, waere
   * dort nur ein Knopf ohne Wirkung -- deshalb blendet sie ihn aus.
   */
  machineSwitch = true,
  /** Die Beschriftungen. Ohne Angabe die deutschen aus `DEFAULT_TEXTE`. */
  texte: HomeTexte = DEFAULT_TEXTE,
): string {
  const body = renderBody(cards, view, texte);

  return `<!DOCTYPE html>
<html lang="${texte === DEFAULT_TEXTE ? 'de' : ''}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${codiconHref}">
<title>Claude Workbench</title>
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
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 24px; margin-bottom: 28px; }
  h1 { font-size: 1.5rem; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
  h2 { font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
       color: var(--vscode-descriptionForeground); margin: 32px 0 12px; }
  .actions { display: flex; gap: 8px; }
  button {
    display: inline-flex; align-items: center; gap: 6px;
    font-family: inherit; font-size: 0.85rem;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 4px; padding: 6px 12px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  /* DAS RASTER LIEGT UM DIE ORDNER, nicht um die Sitzungen (03.09.). Vorher
     war jeder Ordner ein Band ueber die volle Breite mit einem eigenen Raster
     darin: ein Ordner mit einer Sitzung liess damit eine ganze Spalte leer, und
     bei sieben Projekten wurde daraus ein langes duennes Band (gemessen: 2348
     Pixel hoch bei 1100 Pixel Fensterbreite, halbe Flaeche ungenutzt). Jetzt
     ist der Ordner selbst die Kachel und liegt im Raster; seine Sitzungen
     stehen als Zeilen darin. Dieselbe Bauform wie die Gruppen in den
     Systemeinstellungen: gleich breite Kaesten nebeneinander, jeder eine Liste.
     align-items:start haelt kurze Kaesten kurz, statt sie auf die Hoehe des
     hoechsten in derselben Reihe zu ziehen.
     KEINE ACCENT GRAVES IN DIESEM BLOCK: der ganze CSS-Text steht in einem
     JS-Template-String, ein Zitatzeichen darin schliesst ihn vorzeitig, und der
     Uebersetzer meldet das als "';' expected" an einer voellig anderen Zeile. */
  .ordner-raster {
    display: grid; gap: 16px; align-items: start;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  }
  /* EINE SITZUNG IST EINE ZEILE IM KASTEN IHRES ORDNERS, keine eigene Karte
     mehr. Die Karte war rund 400 Pixel hoch und wiederholte dabei dreimal
     denselben Ordner: einmal als Name, einmal als Ordnername, einmal als Pfad.
     Alle drei stehen jetzt oben im Kopf des Kastens, und die Zeile sagt nur
     noch, was diese eine Sitzung von den anderen desselben Ordners
     unterscheidet. */
  .card {
    display: flex; flex-direction: column; gap: 6px;
    padding: 10px 14px;
  }
  .card + .card { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); }
  .card:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.08)); }
  .card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .project { font-weight: 600; font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .when { color: var(--vscode-descriptionForeground); font-size: 0.75rem; white-space: nowrap; }
  .path { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family);
          font-size: 0.75rem; word-break: break-all; }
  .harness { color: var(--vscode-descriptionForeground); font-size: 0.75rem; }
  .card-foot .tmux { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .uncertain {
    display: flex; align-items: flex-start; gap: 6px; font-size: 0.75rem;
    color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(200,150,0,0.5));
    background: var(--vscode-inputValidation-warningBackground, rgba(200,150,0,0.1));
    border-radius: 4px; padding: 6px 8px;
  }
  .uncertain .codicon { font-size: 13px; line-height: 1.2; }
  .message {
    border-left: 2px solid var(--vscode-textBlockQuote-border, rgba(128,128,128,0.4));
    padding-left: 10px; color: var(--vscode-foreground);
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    font-size: 0.8rem;
  }
  .message.none { color: var(--vscode-descriptionForeground); font-style: italic; border-left-color: transparent; }
  .workers { display: flex; flex-wrap: wrap; gap: 6px; }
  .badge {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 0.75rem; padding: 2px 8px; border-radius: 10px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
  /* Die Farben der fuenf Zustaende, in denselben Rollen wie in der Seitenleiste
     des Programms (app/src/renderer/index.html): gruen laeuft, gelb verlangt
     eine Handlung, blau heisst "niemand konnte nachsehen", grau ist fertig --
     der Grundwert von .dot, deshalb steht fuer 'done' hier keine Zeile. */
  .badge.running .dot { background: var(--vscode-testing-iconPassed, #3fb950); }
  .badge.blocked .dot, .badge.stalled .dot { background: var(--vscode-editorWarning-foreground, #e0a020); }
  .badge.unknown .dot { background: var(--vscode-charts-blue, #6a7fd0); }
  /* WRAP: in einem 320 Pixel breiten Kasten passen Werkzeugname, Zustand und
     zwei Knoepfe nicht in eine Zeile -- ohne Umbruch blieb vom Zustand ein
     "be..." uebrig (am Bild gesehen, 03.09.). Die Knoepfe ruecken jetzt in eine
     zweite Zeile, statt den Text abzuschneiden. */
  .card-foot { display: flex; align-items: center; justify-content: space-between;
               gap: 6px 12px; margin-top: 2px; flex-wrap: wrap; }
  .card-foot .tmux { flex: 1 1 auto; min-width: 0; }
  .foot-actions { margin-left: auto; }
  .foot-actions { display: flex; align-items: center; gap: 6px; }
  button.ghost { background: transparent; color: var(--vscode-descriptionForeground);
                 border-color: var(--vscode-panel-border, rgba(128,128,128,0.3)); }
  button.ghost:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
  button.ghost.danger:hover { color: var(--vscode-errorForeground, #f85149);
                              border-color: var(--vscode-errorForeground, #f85149); }
  .folder-group {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
    border-radius: 8px; background: var(--vscode-editorWidget-background, transparent);
    overflow: hidden;
  }
  .folder-head {
    display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
    padding: 12px 14px 10px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
  }
  .folder-title { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1 1 auto; }
  .folder-name { font-weight: 600; font-size: 0.95rem; }
  .folder-count { color: var(--vscode-descriptionForeground); font-size: 0.75rem; white-space: nowrap; }
  /* Der Pfad steht EINMAL, hier oben. Vorher trug ihn zusaetzlich jede Karte,
     also bis zu dreimal dasselbe Verzeichnis untereinander. */
  /* Kein direction:rtl fuer den Abschnitt am Anfang: das schiebt den fuehrenden
     Schraegstrich ans Ende und macht aus /Users/alice/AI/x ein
     "Users/alice/AI/x/" (am Bild gesehen, 03.09.). Der Pfad wird deshalb hinten
     gekuerzt, und der volle steht im Schildchen. */
  .folder-head .path {
    flex: 1 1 100%; order: 3; margin: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .folder-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
  /* Der Knopf traegt nur noch das Pluszeichen: er steht in der Kopfzeile seines
     eigenen Ordners, also sagt der Ordnername schon, wofuer er gilt. Was er tut,
     steht in seinem Schildchen. */
  .folder-actions button.nur-zeichen { padding: 2px 8px; font-size: 0.9rem; line-height: 1.2; }
  .tmux { color: var(--vscode-descriptionForeground); font-size: 0.75rem; }
  .empty { color: var(--vscode-descriptionForeground); }
  .codicon { font-size: 14px; }
  .machine-switch { display: inline-flex; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
                    border-radius: 6px; overflow: hidden; }
  .machine-switch button {
    border: none; border-radius: 0; background: transparent; color: var(--vscode-foreground);
    padding: 5px 12px; font-size: 0.8rem;
  }
  .machine-switch button.active {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  .machine-switch button:not(.active):hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
  .notice {
    border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(200,150,0,0.5));
    background: var(--vscode-inputValidation-warningBackground, rgba(200,150,0,0.1));
    border-radius: 6px; padding: 14px 16px; color: var(--vscode-foreground);
  }
  .notice .detail { color: var(--vscode-descriptionForeground); font-size: 0.8rem; margin-top: 6px;
                    font-family: var(--vscode-editor-font-family); word-break: break-all; }
  .loading { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<header>
  <div>
    <h1>${escapeHtml(texte.titel)}</h1>
${machineSwitch ? `    <div class="machine-switch">
${MACHINES.map((m) => `      <button class="machine${m === view.machine ? ' active' : ''}" data-machine="${m}">${escapeHtml(MACHINE_LABEL[m])}</button>`).join('\n')}
    </div>` : ''}
  </div>
  <div class="actions">
    <button id="new"><span class="codicon codicon-add"></span>${escapeHtml(texte.neu)}</button>
    <button id="settings" class="secondary"><span class="codicon codicon-settings-gear"></span>${escapeHtml(texte.einstellungen)}</button>
    <button id="refresh" class="secondary"><span class="codicon codicon-refresh"></span>${escapeHtml(texte.aktualisieren)}</button>
  </div>
</header>
<h2>${machineSwitch
  ? `${escapeHtml(texte.fortsetzenUeberschrift)} — ${escapeHtml(MACHINE_LABEL[view.machine])}`
  : escapeHtml(texte.fortsetzenUeberschrift)}</h2>
${body}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('new').addEventListener('click', () => vscode.postMessage({ command: 'new' }));
  document.getElementById('settings').addEventListener('click', () => vscode.postMessage({ command: 'settings' }));
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
  for (const button of document.querySelectorAll('button.machine')) {
    button.addEventListener('click', () => vscode.postMessage({ command: 'switchMachine', machine: button.dataset.machine }));
  }
  for (const button of document.querySelectorAll('button[data-dir]')) {
    button.addEventListener('click', () => vscode.postMessage({
      command: 'resume',
      dir: button.dataset.dir,
      sessionId: button.dataset.session || undefined,
      sessionKey: button.dataset.key || undefined,
      name: button.dataset.name || undefined,
    }));
  }
  for (const button of document.querySelectorAll('button[data-newdir]')) {
    button.addEventListener('click', () => vscode.postMessage({
      command: 'newInFolder',
      dir: button.dataset.newdir,
    }));
  }
  for (const button of document.querySelectorAll('button[data-deletedir]')) {
    button.addEventListener('click', () => vscode.postMessage({
      command: 'delete',
      dir: button.dataset.deletedir,
      sessionKey: button.dataset.deletekey || undefined,
      name: button.dataset.deletename || undefined,
    }));
  }
</script>
</body>
</html>`;
}

function renderBody(cards: SessionCard[], view: HomeView, texte: HomeTexte): string {
  if (view.loading) {
    return `<p class="loading">${escapeHtml(texte.laedt)}</p>`;
  }
  if (!view.reachable) {
    const detail = view.error ? `<div class="detail">${escapeHtml(view.error)}</div>` : '';
    return `<div class="notice">${escapeHtml(texte.unerreichbar)}${detail}</div>`;
  }
  if (cards.length === 0) {
    return `<p class="empty">${escapeHtml(texte.leer)}</p>`;
  }
  return `<div class="ordner-raster">\n${groupCards(cards).map((g) => renderFolder(g, texte)).join('\n')}\n</div>`;
}

/**
 * Cards grouped by folder, folders in the order of their most recent session
 * (the cards arrive sorted by lastActive). Part B of the 2026-08-04 repair: the
 * sessions of one folder used to be loose cards among all the others, told apart
 * only by their tmux name in small print — with several sessions per folder that
 * is not a list one can act on.
 */
export function groupCards(cards: SessionCard[]): { dir: string; cards: SessionCard[] }[] {
  const groups: { dir: string; cards: SessionCard[] }[] = [];
  const index = new Map<string, number>();
  for (const card of cards) {
    const at = index.get(card.dir);
    if (at === undefined) {
      index.set(card.dir, groups.length);
      groups.push({ dir: card.dir, cards: [card] });
    } else {
      groups[at].cards.push(card);
    }
  }
  return groups;
}

/**
 * One folder with its sessions. The button starts a FURTHER session in exactly
 * this folder — the folder picker is skipped, because the folder is already
 * decided by where the button sits.
 */
function renderFolder(group: { dir: string; cards: SessionCard[] }, texte: HomeTexte): string {
  const count = group.cards.length === 1 ? texte.eineSitzung
    : texte.mehrereSitzungen.replace('{n}', String(group.cards.length));
  return `<section class="folder-group">
  <div class="folder-head">
    <div class="folder-title">
      <span class="folder-name">${escapeHtml(group.cards[0].folderName)}</span>
      <span class="folder-count">${escapeHtml(count)}</span>
    </div>
    <div class="folder-actions">
      <button class="secondary nur-zeichen" title="${escapeHtml(texte.weitere)}"
              aria-label="${escapeHtml(texte.weitere)}" data-newdir="${escapeHtml(group.dir)}">+</button>
    </div>
    <span class="path" title="${escapeHtml(group.dir)}">${escapeHtml(group.dir)}</span>
  </div>
  <div class="sitzungen">
${group.cards.map((c) => renderCard(c, texte)).join('\n')}
  </div>
</section>`;
}

function renderCard(card: SessionCard, texte: HomeTexte): string {
  const message = card.lastUserMessage
    ? `<div class="message">${escapeHtml(previewText(card.lastUserMessage, 200))}</div>`
    : `<div class="message none">${escapeHtml(texte.ohneNachricht)}</div>`;
  const uncertain = card.transcriptUncertain
    ? `<div class="uncertain" title="${escapeHtml(texte.unsicherTipp)}"><span class="codicon codicon-warning"></span>${escapeHtml(texte.unsicher)}</div>`
    : '';
  const workers = card.workers.length > 0
    ? `<div class="workers">${card.workers.map(renderBadge).join('')}</div>`
    : '';
  const state = card.tmuxAlive ? texte.laeuft : texte.beendet;
  // The tmux session name is unique per session, so it is what tells two cards
  // of the same folder apart even when they share a name.
  //
  // SICHTBAR ist seit dem 03.09. nur noch der Zustand: "wb-claude-workbench-0"
  // ist eine Kennung fuer das Programm, kein Satz fuer einen Menschen, und in
  // einem Kasten von 320 Pixeln blieb davon ohnehin nur "w..." uebrig. Wer die
  // Kennung braucht, findet sie im Schildchen der Zeile.
  const tmux = card.tmuxSession ? `${escapeHtml(card.tmuxSession)} — ${state}` : `tmux ${state}`;
  // Harness und Modell stehen in DERSELBEN Fusszeile wie der Zustand, nicht
  // mehr in einer eigenen Zeile darueber: dieselbe Auskunft, eine Zeile weniger
  // je Sitzung. In einem Kasten mit drei Sitzungen sind das drei Zeilen.
  const werkzeug = harnessText(card);

  return `<div class="card">
  <div class="card-head">
    <span class="project">${escapeHtml(card.name)}</span>
    <span class="when">${escapeHtml(relativeTime(card.lastActive))}</span>
  </div>
  ${message}
  ${uncertain}
  ${workers}
  <div class="card-foot">
    <span class="tmux" title="${tmux}">${werkzeug ? `${escapeHtml(werkzeug)} · ` : ''}${escapeHtml(state)}</span>
    <span class="foot-actions">
      <button class="ghost danger" title="${escapeHtml(texte.loeschenTipp)}"
              data-deletedir="${escapeHtml(card.dir)}" data-deletekey="${escapeHtml(card.sessionKey ?? '')}"
              data-deletename="${escapeHtml(card.name)}">
        <span class="codicon codicon-trash"></span>${escapeHtml(texte.loeschen)}
      </button>
      <button data-dir="${escapeHtml(card.dir)}" data-session="${escapeHtml(card.sessionId ?? '')}"
              data-key="${escapeHtml(card.sessionKey ?? '')}" data-name="${escapeHtml(card.name)}">
        <span class="codicon codicon-debug-continue"></span>${escapeHtml(texte.fortsetzen)}
      </button>
    </span>
  </div>
</div>`;
}

/**
 * Harness and model of the session, small (SPEC-V2 F). Both fields are optional
 * in the state file — a session written before V2 simply shows nothing here.
 */
function harnessText(card: SessionCard): string {
  const labels: Record<string, string> = HARNESS_LABEL;
  const parts = [
    card.harness ? (labels[card.harness] ?? card.harness) : undefined,
    card.model,
  ].filter((part): part is string => part !== undefined && part.length > 0);
  return parts.join(' · ');
}

function renderBadge(worker: WorkerView): string {
  // A remote worker (claude-worker --on <machine>) carries its machine, so the
  // badge shows where it actually runs; local workers look exactly as in V1.
  const machine = worker.machine ? ` · ${worker.machine}` : '';
  const label = `${worker.name} — ${STATUS_LABEL[worker.status]}${machine}`;
  return `<span class="badge ${worker.status}" title="${escapeHtml(worker.model ?? worker.kind ?? '')}">
    <span class="dot"></span>${escapeHtml(label)}</span>`;
}
