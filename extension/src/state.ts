// State files are the contract between the extension and the shell layer:
// ~/.claude/workbench/sessions/<slug>.json — see SPEC.md.
//
// V2: a folder can hold SEVERAL sessions. The first one keeps the plain
// <slug>.json name (legacy files stay valid and are never renamed); every
// further session lives in <slug>__<sessionKey>.json. `name` and `sessionKey`
// are optional — a file written by V1 parses unchanged and is the folder's
// default session, displayed under basename(dir). See SPEC-V2.md, section B.
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export interface StateWorker {
  name: string;
  kind?: string;
  model?: string;
  dir?: string;
  spawnedAt?: string;
  /**
   * Machine the worker actually runs on ('mac' | 'peer'), written by
   * `wb-state add-worker --machine` for a worker spawned with
   * `claude-worker --on <machine>`. Absent = local (every V1 entry).
   */
  machine?: string;
}

export interface SessionState {
  dir: string;
  /** Display name alice gave the session; missing = basename(dir). */
  name?: string;
  /** 6 hex chars; missing = the folder's default session. */
  sessionKey?: string;
  /** Informative (SPEC-V2 F): what runs in the orchestrator pane, and with which model. */
  harness?: string;
  model?: string;
  /**
   * PROPOSED contract extension — nothing writes it today (see the result file).
   * The Claude session id belonging to THIS workbench session. As soon as wb-code
   * records it, the start page resumes exactly that conversation instead of
   * inferring it from the transcript title; it is read here already so ratifying
   * the proposal costs no extension change.
   */
  claudeSessionId?: string;
  tmuxSession?: string;
  lastActive?: string;
  workers?: StateWorker[];
}

/** State-file slug: project path with '/' replaced by '-'. Must match wb-state. */
export function slugForDir(dir: string): string {
  return dir.replace(/\//g, '-');
}

/** A session key is exactly 6 hex characters (SPEC-V2 B). */
export const SESSION_KEY_PATTERN = /^[0-9a-f]{6}$/;

export function isSessionKey(value: unknown): value is string {
  return typeof value === 'string' && SESSION_KEY_PATTERN.test(value);
}

/** '<slug>.json' for the default session, '<slug>__<key>.json' for the others. */
export function stateFileName(dir: string, sessionKey?: string): string {
  const slug = slugForDir(dir);
  return isSessionKey(sessionKey) ? `${slug}__${sessionKey}.json` : `${slug}.json`;
}

/**
 * Session key encoded in a state-file name, if any. Split at the LAST '__' so a
 * project folder that itself contains '__' cannot be mistaken for a key, and
 * accept only a well-formed key.
 */
export function sessionKeyFromFileName(file: string): string | undefined {
  const stem = file.replace(/\.json$/, '');
  const at = stem.lastIndexOf('__');
  if (at < 0) {
    return undefined;
  }
  const key = stem.slice(at + 2);
  return isSessionKey(key) ? key : undefined;
}

/** Heading for a session card / picker entry. */
export function sessionDisplayName(state: SessionState): string {
  return state.name && state.name.trim().length > 0 ? state.name : basename(state.dir);
}

/**
 * Default name for the NEXT session of a folder (SPEC-V2 B, part B of the
 * 2026-08-04 repair): the folder name, then the folder name with a running
 * number — 'AI', 'AI2', 'AI3', …
 *
 * The first session keeps the bare folder name and the numbering starts at 2.
 * That is a decision, and the reason is that the alternative would have to
 * RENAME what already exists: every session on disk today is stored under the
 * bare folder name, the start page shows it, and `latestTranscript(dir, name)`
 * matches a Claude transcript by exactly that name. Turning 'AI' into 'AI1' would
 * break that match for every existing session and rewrite state files nobody
 * asked to touch. With the numbering starting at 2 the number always reads as
 * "the n-th session of this folder", and nothing that exists has to move.
 *
 * A name alice types himself always wins — this is the suggestion in the
 * input box, not a rule.
 */
export function nextSessionName(dir: string, existingNames: Iterable<string>): string {
  const folder = basename(dir);
  const taken = new Set<string>();
  for (const name of existingNames) {
    const trimmed = name.trim();
    if (trimmed.length > 0) {
      taken.add(trimmed);
    }
  }
  if (!taken.has(folder)) {
    return folder;
  }
  // Continue above the highest number in use instead of filling gaps: after
  // deleting 'AI2' the next session is 'AI4', never a second 'AI2' whose
  // transcripts would be mixed up with the deleted one's.
  let highest = 1;
  for (const name of taken) {
    const match = new RegExp(`^${escapeRegExp(folder)}(\\d+)$`).exec(name);
    if (match) {
      highest = Math.max(highest, Number(match[1]));
    }
  }
  return `${folder}${highest + 1}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The sessions of each folder, folders ordered by their most recent session. */
export function groupByFolder(states: SessionState[]): { dir: string; states: SessionState[] }[] {
  const groups: { dir: string; states: SessionState[] }[] = [];
  const index = new Map<string, number>();
  for (const state of states) {
    const at = index.get(state.dir);
    if (at === undefined) {
      index.set(state.dir, groups.length);
      groups.push({ dir: state.dir, states: [state] });
    } else {
      groups[at].states.push(state);
    }
  }
  return groups;
}

/** A free 6-hex key for `dir`, avoiding the keys already taken in that folder. */
export function pickFreeKey(usedKeys: Iterable<string>, random: () => string): string {
  const used = new Set(usedKeys);
  for (let attempt = 0; attempt < 100; attempt++) {
    const key = random();
    if (isSessionKey(key) && !used.has(key)) {
      return key;
    }
  }
  throw new Error('no free session key found');
}

/**
 * Slug of Claude Code's own transcript directory (~/.claude/projects/<slug>).
 * Claude sanitises every non-alphanumeric character, not just the slash:
 * /Users/alice/.pi/agent  ->  -Users-alice--pi-agent
 */
export function claudeProjectSlug(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-');
}

export function sessionsDir(): string {
  return join(homedir(), '.claude', 'workbench', 'sessions');
}

export function stateFileForDir(dir: string, sessionKey?: string): string {
  return join(sessionsDir(), stateFileName(dir, sessionKey));
}

/** Accepts only entries that carry a project dir; malformed files are ignored. */
export function parseState(raw: string): SessionState | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  const state = data as SessionState;
  if (typeof state.dir !== 'string' || state.dir.length === 0) {
    return undefined;
  }
  return {
    dir: state.dir,
    name: typeof state.name === 'string' && state.name.length > 0 ? state.name : undefined,
    sessionKey: isSessionKey(state.sessionKey) ? state.sessionKey : undefined,
    harness: typeof state.harness === 'string' && state.harness.length > 0
      ? state.harness
      : undefined,
    model: typeof state.model === 'string' && state.model.length > 0 ? state.model : undefined,
    claudeSessionId: typeof state.claudeSessionId === 'string' && state.claudeSessionId.length > 0
      ? state.claudeSessionId
      : undefined,
    tmuxSession: typeof state.tmuxSession === 'string' ? state.tmuxSession : undefined,
    lastActive: typeof state.lastActive === 'string' ? state.lastActive : undefined,
    workers: Array.isArray(state.workers)
      ? state.workers.filter((w): w is StateWorker => typeof w?.name === 'string')
      : [],
  };
}

export function sortByLastActive(states: SessionState[]): SessionState[] {
  return [...states].sort((a, b) => {
    const ta = a.lastActive ? Date.parse(a.lastActive) : 0;
    const tb = b.lastActive ? Date.parse(b.lastActive) : 0;
    return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
  });
}

export async function readState(
  dir: string,
  sessionKey?: string,
): Promise<SessionState | undefined> {
  try {
    const state = parseState(await readFile(stateFileForDir(dir, sessionKey), 'utf8'));
    return state && { ...state, sessionKey: state.sessionKey ?? sessionKey };
  } catch {
    return undefined;
  }
}

export async function readAllStates(): Promise<SessionState[]> {
  let files: string[];
  try {
    files = await readdir(sessionsDir());
  } catch {
    return [];
  }
  const states: SessionState[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }
    try {
      const state = parseState(await readFile(join(sessionsDir(), file), 'utf8'));
      if (state) {
        // The file name carries the key too; it stands in for a state file that
        // was written without the field.
        states.push({ ...state, sessionKey: state.sessionKey ?? sessionKeyFromFileName(file) });
      }
    } catch {
      // unreadable state file — skip
    }
  }
  return sortByLastActive(states);
}

export interface FolderSessions {
  /** The folder's default session (<slug>.json) exists. */
  hasDefault: boolean;
  /** Keys of the further sessions (<slug>__<key>.json). */
  keys: string[];
}

/** Which sessions a folder has, given the file names in the state directory. */
export function folderSessions(fileNames: string[], dir: string): FolderSessions {
  const slug = slugForDir(dir);
  const result: FolderSessions = { hasDefault: false, keys: [] };
  for (const file of fileNames) {
    if (file === `${slug}.json`) {
      result.hasDefault = true;
      continue;
    }
    if (file.startsWith(`${slug}__`) && file.endsWith('.json')) {
      const key = sessionKeyFromFileName(file);
      if (key) {
        result.keys.push(key);
      }
    }
  }
  return result;
}

/** Identity of a session inside the state directory: its folder plus its key. */
export function sessionIdentity(state: SessionState): string {
  return `${state.dir}\u0000${state.sessionKey ?? ''}`;
}

export interface TranscriptRisk {
  /** Sessions sharing a folder with another session — the newest transcript is a guess there. */
  contested: Set<string>;
  /** Sessions whose (folder, name) pair is not unique — even the name cannot resolve them. */
  duplicateName: Set<string>;
}

/**
 * Which sessions cannot get their transcript assigned reliably. One session per
 * folder is never at risk (the newest transcript is the right one, V1 rule);
 * from the second session on, only the session NAME can tell them apart, and two
 * sessions with the same name in the same folder cannot be told apart at all.
 */
export function transcriptRisk(states: SessionState[]): TranscriptRisk {
  const perDir = new Map<string, number>();
  const perName = new Map<string, number>();
  for (const state of states) {
    perDir.set(state.dir, (perDir.get(state.dir) ?? 0) + 1);
    const nameKey = `${state.dir}\u0000${state.name ?? ''}`;
    perName.set(nameKey, (perName.get(nameKey) ?? 0) + 1);
  }
  const risk: TranscriptRisk = { contested: new Set(), duplicateName: new Set() };
  for (const state of states) {
    if ((perDir.get(state.dir) ?? 0) < 2) {
      continue;
    }
    const identity = sessionIdentity(state);
    risk.contested.add(identity);
    if ((perName.get(`${state.dir}\u0000${state.name ?? ''}`) ?? 0) > 1) {
      risk.duplicateName.add(identity);
    }
  }
  return risk;
}

/**
 * Is the transcript shown for this session only a guess? True when the folder
 * holds several sessions and the transcript was not matched by name (or the name
 * is not unique). A recorded claudeSessionId would settle it — see the proposal
 * on that field.
 */
export function isTranscriptUncertain(
  state: SessionState,
  risk: TranscriptRisk,
  nameMatched: boolean,
): boolean {
  if (state.claudeSessionId) {
    return false;
  }
  const identity = sessionIdentity(state);
  if (!risk.contested.has(identity)) {
    return false;
  }
  return !nameMatched || risk.duplicateName.has(identity);
}

export async function readFolderSessions(dir: string): Promise<FolderSessions> {
  try {
    return folderSessions(await readdir(sessionsDir()), dir);
  } catch {
    return { hasDefault: false, keys: [] };
  }
}
