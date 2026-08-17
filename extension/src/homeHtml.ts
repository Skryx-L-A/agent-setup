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
): string {
  const body = renderBody(cards, view);

  return `<!DOCTYPE html>
<html lang="de">
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
  .cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); }
  .card {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
    border-radius: 6px; padding: 16px 18px;
    background: var(--vscode-editorWidget-background, transparent);
    display: flex; flex-direction: column; gap: 10px;
  }
  .card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .project { font-weight: 600; font-size: 1rem; }
  .when { color: var(--vscode-descriptionForeground); font-size: 0.8rem; white-space: nowrap; }
  .where { display: flex; flex-direction: column; gap: 2px; margin-top: -4px; }
  .folder { color: var(--vscode-foreground); font-size: 0.8rem; }
  .path { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family);
          font-size: 0.75rem; word-break: break-all; }
  .harness { color: var(--vscode-descriptionForeground); font-size: 0.75rem; }
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
  .card-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 2px; }
  .foot-actions { display: flex; align-items: center; gap: 6px; }
  button.ghost { background: transparent; color: var(--vscode-descriptionForeground);
                 border-color: var(--vscode-panel-border, rgba(128,128,128,0.3)); }
  button.ghost:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
  button.ghost.danger:hover { color: var(--vscode-errorForeground, #f85149);
                              border-color: var(--vscode-errorForeground, #f85149); }
  .folder-group { margin-bottom: 28px; }
  .folder-head { display: flex; align-items: baseline; justify-content: space-between;
                 gap: 16px; flex-wrap: wrap; margin-bottom: 10px;
                 border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
                 padding-bottom: 6px; }
  .folder-title { display: flex; align-items: baseline; gap: 10px; }
  .folder-name { font-weight: 600; font-size: 0.95rem; }
  .folder-count { color: var(--vscode-descriptionForeground); font-size: 0.75rem; }
  .folder-actions { display: flex; align-items: center; gap: 12px; }
  .folder-actions .path { max-width: 46ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
    <h1>Claude Workbench</h1>
${machineSwitch ? `    <div class="machine-switch">
${MACHINES.map((m) => `      <button class="machine${m === view.machine ? ' active' : ''}" data-machine="${m}">${escapeHtml(MACHINE_LABEL[m])}</button>`).join('\n')}
    </div>` : ''}
  </div>
  <div class="actions">
    <button id="new"><span class="codicon codicon-add"></span>Neue Session</button>
    <button id="settings" class="secondary"><span class="codicon codicon-settings-gear"></span>Einstellungen</button>
    <button id="refresh" class="secondary"><span class="codicon codicon-refresh"></span>Aktualisieren</button>
  </div>
</header>
<h2>${machineSwitch ? `Sessions fortsetzen — ${escapeHtml(MACHINE_LABEL[view.machine])}` : 'Sessions fortsetzen'}</h2>
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

function renderBody(cards: SessionCard[], view: HomeView): string {
  if (view.loading) {
    return `<p class="loading">Peer-Sessions werden über SSH geladen …</p>`;
  }
  if (!view.reachable) {
    const detail = view.error ? `<div class="detail">${escapeHtml(view.error)}</div>` : '';
    return `<div class="notice">Peer ist nicht erreichbar. SSH-Verbindung prüfen (ssh peer) und erneut aktualisieren.${detail}</div>`;
  }
  if (cards.length === 0) {
    return `<p class="empty">Noch keine Sessions. Starte eine neue Session in einem Projektordner.</p>`;
  }
  return groupCards(cards).map(renderFolder).join('\n');
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
function renderFolder(group: { dir: string; cards: SessionCard[] }): string {
  const count = group.cards.length === 1 ? '1 Session' : `${group.cards.length} Sessions`;
  return `<section class="folder-group">
  <div class="folder-head">
    <div class="folder-title">
      <span class="folder-name">${escapeHtml(group.cards[0].folderName)}</span>
      <span class="folder-count">${escapeHtml(count)}</span>
    </div>
    <div class="folder-actions">
      <span class="path">${escapeHtml(group.dir)}</span>
      <button class="secondary" data-newdir="${escapeHtml(group.dir)}">
        <span class="codicon codicon-add"></span>Weitere Session
      </button>
    </div>
  </div>
  <div class="cards">
${group.cards.map(renderCard).join('\n')}
  </div>
</section>`;
}

function renderCard(card: SessionCard): string {
  const message = card.lastUserMessage
    ? `<div class="message">${escapeHtml(previewText(card.lastUserMessage, 200))}</div>`
    : `<div class="message none">Keine Nachricht gefunden.</div>`;
  const uncertain = card.transcriptUncertain
    ? `<div class="uncertain" title="Mehrere Sessions in diesem Ordner; das Transkript ließ sich dieser Session nicht eindeutig zuordnen. Gezeigt wird das zuletzt benutzte Transkript des Ordners."><span class="codicon codicon-warning"></span>Zuordnung unsicher — Vorschau und Fortsetzen können zu einer anderen Session dieses Ordners gehören.</div>`
    : '';
  const workers = card.workers.length > 0
    ? `<div class="workers">${card.workers.map(renderBadge).join('')}</div>`
    : '';
  const state = card.tmuxAlive ? 'läuft' : 'beendet';
  // The tmux session name is unique per session, so it is what tells two cards
  // of the same folder apart even when they share a name.
  const tmux = card.tmuxSession ? `${escapeHtml(card.tmuxSession)} — ${state}` : `tmux-Session ${state}`;

  return `<div class="card">
  <div class="card-head">
    <span class="project">${escapeHtml(card.name)}</span>
    <span class="when">${escapeHtml(relativeTime(card.lastActive))}</span>
  </div>
  <div class="where">
    <span class="folder">${escapeHtml(card.folderName)}</span>
    <span class="path">${escapeHtml(card.dir)}</span>
  </div>
  ${renderHarness(card)}
  ${message}
  ${uncertain}
  ${workers}
  <div class="card-foot">
    <span class="tmux">${tmux}</span>
    <span class="foot-actions">
      <button class="ghost danger" title="Diese Session entfernen — Projektdateien und Vault bleiben unberührt"
              data-deletedir="${escapeHtml(card.dir)}" data-deletekey="${escapeHtml(card.sessionKey ?? '')}"
              data-deletename="${escapeHtml(card.name)}">
        <span class="codicon codicon-trash"></span>Löschen
      </button>
      <button data-dir="${escapeHtml(card.dir)}" data-session="${escapeHtml(card.sessionId ?? '')}"
              data-key="${escapeHtml(card.sessionKey ?? '')}" data-name="${escapeHtml(card.name)}">
        <span class="codicon codicon-debug-continue"></span>Fortsetzen
      </button>
    </span>
  </div>
</div>`;
}

/**
 * Harness and model of the session, small (SPEC-V2 F). Both fields are optional
 * in the state file — a session written before V2 simply shows nothing here.
 */
function renderHarness(card: SessionCard): string {
  const labels: Record<string, string> = HARNESS_LABEL;
  const parts = [
    card.harness ? (labels[card.harness] ?? card.harness) : undefined,
    card.model,
  ].filter((part): part is string => part !== undefined && part.length > 0);
  return parts.length > 0
    ? `<div class="harness">${escapeHtml(parts.join(' · '))}</div>`
    : '';
}

function renderBadge(worker: WorkerView): string {
  // A remote worker (claude-worker --on <machine>) carries its machine, so the
  // badge shows where it actually runs; local workers look exactly as in V1.
  const machine = worker.machine ? ` · ${worker.machine}` : '';
  const label = `${worker.name} — ${STATUS_LABEL[worker.status]}${machine}`;
  return `<span class="badge ${worker.status}" title="${escapeHtml(worker.model ?? worker.kind ?? '')}">
    <span class="dot"></span>${escapeHtml(label)}</span>`;
}
