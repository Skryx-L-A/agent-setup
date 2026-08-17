// All tmux interaction lives here. Commands are exactly the ones from SPEC.md.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

export interface WorkerPane {
  paneId: string;
  worker: string;
  dead: boolean;
}

export interface RolePane {
  paneId: string;
  role: string;
  dead: boolean;
}

export type OrchestratorLookup =
  | { status: 'ok'; paneId: string }
  | { status: 'dead' }
  | { status: 'missing' };

/**
 * Session name for a project dir when no state file exists yet:
 * wb-<sanitized basename>-<md5-6 of the full path>, plus '-<sessionKey>' for
 * every session beyond the folder's default one (SPEC-V2 B). Special characters
 * are REPLACED (not dropped), and the path hash keeps two projects with the same
 * basename apart. Must stay identical to wb-code — see SPEC.md, V1.1.
 *
 * The state file's `tmuxSession` always wins over this; callers pass it in.
 */
export function sessionName(dir: string, sessionKey?: string): string {
  const name = basename(dir).replace(/[^a-zA-Z0-9-]/g, '-');
  const hash = createHash('md5').update(dir).digest('hex').slice(0, 6);
  const key = sessionKey ? `-${sessionKey}` : '';
  return `wb-${name}-${hash}${key}`;
}

/**
 * The BASE session behind a name: every '-view' suffix is stripped, however often
 * it occurs. 'wb-X-view-view-view' -> 'wb-X'.
 *
 * A view is never the base of another view (measured 2026-08-04): the worker tab
 * ran with the name of the VIEW instead of the base, and tmux happily grouped a
 * view onto a view — 'wb-a project-view-view' and 'wb-a project-view-view-view' stood
 * in the live server, three links showing the same windows. Session names are
 * built as 'wb-<folder>-<hash>[-key]', so a real base can never end in '-view'
 * and stripping is safe.
 */
export function baseSessionName(session: string): string {
  let name = session;
  while (name.endsWith('-view')) {
    name = name.slice(0, -'-view'.length);
  }
  return name;
}

/**
 * Grouped session the worker terminal attaches to (SPEC-V2 C). Clients of the
 * SAME tmux session always see the same window, so a second view needs its own
 * session that shares the windows. Always derived from the BASE, so calling it
 * with a view name gives that view back instead of stacking another one.
 */
export function viewSessionName(session: string): string {
  return `${baseSessionName(session)}-view`;
}

/**
 * tmux falls back to PREFIX matching when a target does not exist verbatim, so
 * '-t wb-Vox' would happily hit a running 'wb-a project'. '=' anchors the name.
 *
 * It anchors reliably for has-session. For 'list-panes -s' it does NOT (tmux
 * 3.7b resolves the target as a WINDOW there and still prefix-matches the
 * session, verified on this machine) — that is why the pane listings below go
 * through 'list-panes -a' and filter on #{session_name} instead of a target.
 */
export function exact(session: string): string {
  return '=' + session;
}

function run(args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('tmux', args, { timeout: 5000 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });
}

/** Runs tmux, returning '' instead of throwing (missing session, tmux not running, ...). */
async function runQuiet(args: string[], stdin?: string): Promise<string> {
  try {
    return await run(args, stdin);
  } catch {
    return '';
  }
}

export function hasSessionArgs(session: string): string[] {
  return ['has-session', '-t', exact(session)];
}

/** Pane options are empty when unset, so fields are pipe-separated, not space-separated. */
export const WORKER_FORMAT = '#{session_name}|#{pane_id}|#{@wb_worker}|#{pane_dead}';
export const ROLE_FORMAT = '#{session_name}|#{pane_id}|#{@wb_role}|#{pane_dead}';

export function listPanesArgs(format: string): string[] {
  return ['list-panes', '-a', '-F', format];
}

export function listWindowsArgs(session: string): string[] {
  return ['list-windows', '-t', exact(session), '-F', '#{window_name}'];
}

/** A worker-tab window name: 'workers' is tab 1, 'workers-<N>' is tab N (N>=2). */
const WORKER_TAB_WINDOW = /^workers(?:-([0-9]+))?$/;

/** The tab number a window name stands for, or undefined when it is not a worker tab. */
export function workerTabNumber(windowName: string): number | undefined {
  const match = WORKER_TAB_WINDOW.exec(windowName);
  if (!match) {
    return undefined;
  }
  return match[1] ? Number(match[1]) : 1;
}

/** Parses `list-windows -F '#{window_name}'`, keeping only worker-tab windows, ordered by tab number. */
export function parseWorkerTabWindows(out: string): string[] {
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => workerTabNumber(name) !== undefined)
    .sort((a, b) => workerTabNumber(a)! - workerTabNumber(b)!);
}

/**
 * Worker-tab windows that exist right now for a session (workers, workers-2,
 * ... — 2026-08-04, multi-tab overflow once wb-grid's maxWorkerPanesPerTab is
 * exceeded). Always queried against the BASE, never a view: windows belong to
 * the tmux session GROUP, so base and every view of it see the identical set,
 * and the base is the one guaranteed to exist even before any view has ever
 * attached. This is how the extension tells whether a `workers-2` tab is
 * still owed a terminal, or whether one it opened earlier must close because
 * wb-grid has since folded that window away again.
 */
export async function listWorkerTabWindows(session: string): Promise<string[]> {
  return parseWorkerTabWindows(await runQuiet(listWindowsArgs(baseSessionName(session))));
}

/**
 * 'missing' = tmux answered and the session is not there. 'unavailable' = tmux
 * itself could not be run (not on PATH — a GUI-launched VSCode inherits none of
 * the login shell's PATH unless the shell-env resolution succeeded).
 */
export type SessionStatus = 'alive' | 'missing' | 'unavailable';

/**
 * Why a `has-session` call failed. The two cases must not be merged: the whole
 * restore path stays quiet when a session is 'missing' (alice closed it —
 * nothing to resurrect), while 'unavailable' means the extension is blind and
 * has to say so instead of concluding "no session".
 */
export function statusFromError(error: unknown): SessionStatus {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' ? 'unavailable' : 'missing';
}

export async function sessionStatus(session: string): Promise<SessionStatus> {
  try {
    await run(hasSessionArgs(session));
    return 'alive';
  } catch (error) {
    return statusFromError(error);
  }
}

export async function hasSession(session: string): Promise<boolean> {
  return (await sessionStatus(session)) === 'alive';
}

export async function listWorkerPanes(session: string): Promise<WorkerPane[]> {
  return parseWorkerPanes(await runQuiet(listPanesArgs(WORKER_FORMAT)), session);
}

export function parseWorkerPanes(out: string, session: string): WorkerPane[] {
  const panes: WorkerPane[] = [];
  for (const line of out.split('\n')) {
    const [name, paneId, worker, dead] = line.replace(/\r?$/, '').split('|');
    if (name !== session || !paneId || !worker) {
      continue;
    }
    panes.push({ paneId, worker, dead: dead === '1' });
  }
  return panes;
}

export async function listRolePanes(session: string): Promise<RolePane[]> {
  return parseRolePanes(await runQuiet(listPanesArgs(ROLE_FORMAT)), session);
}

export function parseRolePanes(out: string, session: string): RolePane[] {
  const panes: RolePane[] = [];
  for (const line of out.split('\n')) {
    const [name, paneId, role, dead] = line.replace(/\r?$/, '').split('|');
    if (name !== session || !paneId || !role) {
      continue;
    }
    panes.push({ paneId, role, dead: dead === '1' });
  }
  return panes;
}

/** wb-code sets remain-on-exit, so a crashed orchestrator stays listed as a dead pane. */
export function pickOrchestrator(panes: RolePane[]): OrchestratorLookup {
  const orchestrators = panes.filter((p) => p.role === 'orchestrator');
  if (orchestrators.length === 0) {
    return { status: 'missing' };
  }
  const alive = orchestrators.find((p) => !p.dead);
  return alive ? { status: 'ok', paneId: alive.paneId } : { status: 'dead' };
}

export async function findOrchestratorPane(session: string): Promise<OrchestratorLookup> {
  return pickOrchestrator(await listRolePanes(session));
}

export function killSessionArgs(session: string): string[] {
  return ['kill-session', '-t', exact(session)];
}

/**
 * Drops the grouped view session behind the worker tab (SPEC-V2 C). Sessions of
 * a group SHARE their windows, so killing this one destroys no window and no
 * pane — the orchestrator session keeps them. Quiet: if it is already gone,
 * there is nothing to report.
 */
export async function killViewSession(session: string): Promise<void> {
  await runQuiet(killSessionArgs(viewSessionName(session)));
}

/** Brings a pane into view: select its window, then the pane itself. */
export async function focusPane(paneId: string): Promise<void> {
  await run(['select-window', '-t', paneId]);
  await run(['select-pane', '-t', paneId]);
}

/**
 * Types text into a pane WITHOUT pressing Enter — the user completes the
 * prompt and submits it. Multi-line text goes through a paste buffer with
 * bracketed paste so the receiving app does not treat newlines as submits.
 */
export async function sendText(paneId: string, text: string): Promise<void> {
  if (text.includes('\n')) {
    // Unique buffer: a second send must not overwrite ours before we paste it.
    const buffer = `wb-send-${process.pid}-${Date.now()}`;
    await run(['load-buffer', '-b', buffer, '-'], text);
    await run(['paste-buffer', '-d', '-p', '-b', buffer, '-t', paneId]);
    return;
  }
  await run(['send-keys', '-t', paneId, '-l', '--', text]);
}
