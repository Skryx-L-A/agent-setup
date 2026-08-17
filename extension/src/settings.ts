// ~/.claude/workbench/settings.json — the single source of truth for defaults
// (SPEC-V2, section A). The extension writes it, the shell layer reads it via
// `wb-state settings get <key>`.
//
// Every key is optional: a missing file, a missing key or broken JSON falls back
// to the built-in defaults below and never raises. Writes are atomic (tmp +
// rename) and read-modify-write, so keys this version does not know about
// survive untouched.
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendChangeLog, changeLines } from './settingsLog.ts';

export const MODELS = [
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'claude-fable-5',
] as const;

export type Model = (typeof MODELS)[number];

export const MODEL_LABEL: Record<Model, string> = {
  'claude-opus-5': 'Opus 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-fable-5': 'Fable 5',
};

/**
 * The orchestrator does not have to be Claude Code (SPEC-V2 F): 'pi' runs a
 * local model in the orchestrator pane. Only the pane's process changes — state,
 * workers, sidebar and layout stay the same.
 *
 * SPEC-V3 D: a harness is now DATA, not a fixed enum — any id registered in
 * `models.json` (`codex`, `agy`, `aider`, `opencode`, …) is just as valid an
 * orchestratorHarness as the two built-ins. `HARNESSES`/`Harness` stay around
 * for the two code-level defaults (labels, the pi-specific "Thinking-Level"
 * wording, the pi fallback model) — they are no longer the exhaustive set.
 */
export const HARNESSES = ['claude', 'pi'] as const;

export type Harness = string;

export const HARNESS_LABEL: Record<(typeof HARNESSES)[number], string> = {
  claude: 'Claude Code',
  pi: 'pi (lokal)',
};

/** pi model aliases; wb-code/pi-worker resolve them to the Ollama ids. */
export const PI_MODELS = ['ornith', 'qwen', 'ornith9'] as const;

export const PI_MODEL_LABEL: Record<string, string> = {
  ornith: 'ornith — ornith:35b (Default-Coder)',
  qwen: 'qwen — qwen3.6:35b-a3b-coding-nvfp4',
  ornith9: 'ornith9 — ornith:9b (günstig)',
};

/**
 * Shape of an id this layer is willing to store: a model id ('gpt-5-codex'), a
 * full Ollama reference ('ornith:35b', 'huihui_ai/foo:q6_k') or a harness id
 * ('codex'). Not a registry membership check — that needs `models.json`, which
 * this module never reads (settings.ts stays pure/synchronous, mirroring
 * `wb-state settings set`'s own ENUM=None "free, but a plain string" rule for
 * these same keys). Real gatekeeping (does this harness/model actually exist,
 * does the pair even match) happens where the registry is loaded: the settings
 * webview's dropdowns only ever offer real ids, and `wb-code`/`wb-state models
 * resolve` refuse a bad pair at spawn time with a precise error.
 */
const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}(:[A-Za-z0-9._-]+)?$/;

export function isHarness(value: unknown): value is Harness {
  return typeof value === 'string' && ID_SHAPE.test(value.trim());
}

/** Same id-shape check as isHarness, named for its use on model ids (workerModel, SPEC-V3 D). */
export function isPlausibleModelId(value: unknown): value is string {
  return typeof value === 'string' && ID_SHAPE.test(value);
}

/** Is `model` usable with `harness`? pi also accepts any full Ollama id. */
export function isModelForHarness(harness: Harness, model: unknown): model is string {
  if (typeof model !== 'string') {
    return false;
  }
  if (harness === 'claude') {
    return MODELS.includes(model as Model);
  }
  if (harness === 'pi') {
    // A Claude id would pass as an Ollama reference by shape, but pi cannot run
    // one — reject it so switching the harness falls back to a usable model.
    return !MODELS.includes(model as Model)
      && ((PI_MODELS as readonly string[]).includes(model) || ID_SHAPE.test(model));
  }
  // SPEC-V3 D: any other harness is a registered adapter — id-shape here, real
  // membership is a job for the registry (see ID_SHAPE's doc comment above).
  return ID_SHAPE.test(model.trim());
}

export function defaultModelFor(harness: Harness): string {
  return harness === 'pi' ? 'ornith' : DEFAULT_SETTINGS.orchestratorModel;
}

/** UI wording: Claude Code calls it effort, pi calls it thinking level. */
export function effortLabel(harness: Harness): string {
  return harness === 'pi' ? 'Thinking-Level' : 'Effort';
}

/**
 * 'max' exists in Claude Code but is above the policy ceiling (CLAUDE.md), so it
 * is never offered here; Fable is capped at 'medium' by the same rule.
 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;

export type Effort = (typeof EFFORTS)[number];

/**
 * How long a closed window's tmux session is only MARKED as orphaned before the
 * watcher acts on it (2026-08-04). Lives here, not in sessionClose.ts, so the
 * settings page can name the number without pulling the file-system module in.
 * The measurement behind the value is documented in sessionClose.ts.
 */
export const ORPHAN_GRACE_SECONDS = 90;

export type WorkerLayout = 'split' | 'window';

export const WORKER_LAYOUT_LABEL: Record<WorkerLayout, string> = {
  split: 'Panes neben dem Orchestrator',
  window: 'Eigener Tab, alle Worker zusammen',
};

/** Where a plain `claude-worker`/`pi-worker` call (no --on, no SSH-name) spawns. */
export type WorkerMachine = 'local' | 'mac' | 'peer';

export const WORKER_MACHINES: readonly WorkerMachine[] = ['local', 'mac', 'peer'];

export const WORKER_MACHINE_LABEL: Record<WorkerMachine, string> = {
  local: 'Diese Maschine (Default)',
  mac: 'Immer Mac',
  peer: 'Immer Peer',
};

export function isWorkerMachine(value: unknown): value is WorkerMachine {
  return value === 'local' || value === 'mac' || value === 'peer';
}

export interface Settings {
  orchestratorHarness: Harness;
  /** Claude model id, or a pi alias / full Ollama id / registered model id — per harness (SPEC-V2 F, SPEC-V3 D). */
  orchestratorModel: string;
  orchestratorEffort: Effort;
  workerLayout: WorkerLayout;
  /** Default for `claude-worker <name> default …` — any registered model id, not just a Claude one (SPEC-V3 D, Reviewer-Befund M6). */
  workerModel: string;
  workerEffort: Effort;
  terminalStartMaximized: boolean;
  newSessionDefaultDir: string;
  workerPollSeconds: number;
  /**
   * Whether `wb-code` starts `context-guard --auto` on its own (SPEC-V2 A). Off
   * by default on purpose (alice 2026-07-27): the orchestrator starts its own
   * guard once workers exist, and a second, silently-started one would type
   * `/compact` twice. The UI surfaces this reasoning instead of a bare switch.
   */
  contextGuardAutostart: boolean;
  /**
   * Vertrag Teil 2 §5: gates the AUTOMATIC catalog discovery `wb-code` (session
   * start) and the settings page (on open) trigger — `discover --all --if-stale`
   * including network catalog fetches (OpenRouter/OpenAI/…). On by default. Off
   * only stops the automatic NETWORK part; local sources (ollama/command-lines/
   * file-json) keep discovering on their own regardless — they cost nothing and
   * never leave the machine. The explicit "Kataloge jetzt aktualisieren" button
   * always runs the full thing, independent of this switch.
   */
  modelDiscoveryAuto: boolean;
  /** context-guard thresholds (SPEC-V2 A) — replace the old ORCH_PCT/WARN_PCT constants. */
  guardOrchWarnPct: number;
  guardWorkerWarnPct: number;
  /**
   * wb-grid's floor for a worker column, in terminal columns (SPEC-V2 A).
   * 80 (2026-08-04, measured, report 20260804-033646.md): a real Claude CLI
   * status line needs at least this much width to render the EXACT context
   * figures for a realistic project path — narrower degrades to the 10%-step
   * bar or, below ~52, to nothing readable at all.
   */
  minWorkerPaneWidth: number;
  /** claude-worker/pi-worker refuse a new spawn once a session holds this many. */
  maxWorkers: number;
  /**
   * How many worker panes ONE `workers` tab holds before wb-grid opens
   * `workers-2`, `workers-3`, ... (2026-08-04, alice: past a certain count
   * a human cannot overview the panes anymore, regardless of readability).
   * 0 = unlimited, everything in one tab. Default 6 is measured, not guessed:
   * on the reference 197x54 window, 2 columns of minWorkerPaneWidth=80 x 3
   * rows of >=17 readable rows is what wb-grid's own grid produces before a
   * row gets too short for the real Claude CLI footer to render at all.
   */
  maxWorkerPanesPerTab: number;
  /** claude-worker's routing default when no machine/SSH-name says otherwise. */
  defaultWorkerMachine: WorkerMachine;
  /**
   * Whether closing a workbench WINDOW also closes its tmux session (2026-08-04).
   * A closed window that leaves its session running keeps the whole Claude
   * process in memory, which is how 27 orphans held 7,5 GB on 2026-08-03. Off
   * leaves the old behaviour, where only `wb-session-sweep` ever cleans up. A
   * window RELOAD never closes anything either way — see sessionClose.ts for
   * the measurement that separates the two.
   *
   * OFF BY DEFAULT SINCE 2026-08-07 (was on). alice: "Ich will nicht, dass
   * die Sessions beendet werden durch Schließen der App, dafür ist der
   * Rechtsklick auf die Session da." The measurement above still stands, it
   * just weighs less: memory can be reclaimed at any time, a session ended by
   * accident — with its running work — cannot. This key lives in the SHARED
   * settings file, so its default must match the one the app ships
   * (`VORGABEN` in app/src/main/einstellungen.ts, `DEFAULTS` in shell/wb-state);
   * two defaults for one key would mean the same file reads differently
   * depending on who opened it.
   */
  closeSessionOnWindowClose: boolean;
  /**
   * Whether every worker gets its own git worktree and branch (2026-08-04).
   * On by default: `claude-worker`/`pi-worker` run the agent in
   * `~/.pi-workers/worktrees/<worker>` on branch `wb/<worker>` instead of the
   * shared working tree, so two workers in one repo cannot overwrite each
   * other's files any more. Off restores the old behaviour (everyone in the
   * directory the task named). Outside a git repository nothing changes either
   * way — `wb-worktree` falls back to the given directory and says so.
   */
  workerWorktrees: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  orchestratorHarness: 'claude',
  orchestratorModel: 'claude-opus-5',
  orchestratorEffort: 'xhigh',
  workerLayout: 'split',
  workerModel: 'claude-sonnet-5',
  workerEffort: 'high',
  terminalStartMaximized: true,
  newSessionDefaultDir: '~/AI',
  workerPollSeconds: 5,
  // 2026-08-06, Entscheidung des Nutzers: die Kontextwache startet das Programm
  // selbst -- "Wenn jemand ein schwaecheres Modell als Orchestrator nimmt, das
  // nicht so zuverlaessig ist, soll die Kontextwache ja immer noch zuverlaessig
  // sein." Vorher false, weil der Orchestrator sie selbst startete. Dieselbe
  // Vorgabe steht in shell/wb-state (DEFAULTS) und app/src/main/einstellungen.ts
  // (VORGABEN); wer sie aendert, aendert alle drei.
  contextGuardAutostart: true,
  modelDiscoveryAuto: true,
  guardOrchWarnPct: 75,
  guardWorkerWarnPct: 80,
  minWorkerPaneWidth: 80,
  maxWorkers: 8,
  maxWorkerPanesPerTab: 6,
  defaultWorkerMachine: 'local',
  closeSessionOnWindowClose: false,
  workerWorktrees: true,
};

/**
 * Only a real number or a numeric-looking string may become a setting's number.
 * `Number(true) === 1` and `Number([5]) === 5` would otherwise let a stored boolean
 * or single-element array sneak through as a valid percentage/width/count
 * (Reviewer-Befund 7) — reject the type before Number() ever sees it.
 */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    // Mirrors the shell side exactly (context-guard's validate_pct, wb-grid/pi-worker's
    // `[ -ge ]` guards all key off `^[0-9]+$`): digits only, no sign, no decimal point,
    // no surrounding whitespace. `Number(" 50") === 50` used to let a value with
    // whitespace through here while the same string failed the shell's regex, so the
    // settings UI and the guard showed different thresholds for the identical stored
    // value (Reviewer-Befund 7, rest).
    return /^[0-9]+$/.test(value) ? Number(value) : undefined;
  }
  return undefined;
}

/** 1..99: 0 and 100 are meaningless thresholds for an early-warning percentage. */
function isPct(value: unknown): value is number {
  const n = toFiniteNumber(value);
  return n !== undefined && n >= 1 && n <= 99;
}

/** wb-grid's floor for a worker column, in terminal columns — at least 20. */
function isPaneWidth(value: unknown): value is number {
  const n = toFiniteNumber(value);
  return n !== undefined && n >= 20;
}

/** How many workers a session may hold before claude-worker/pi-worker refuse a spawn. */
function isWorkerCount(value: unknown): value is number {
  const n = toFiniteNumber(value);
  return n !== undefined && n >= 1;
}

/** How many worker panes fit in one `workers` tab before wb-grid opens the next — 0 (unlimited) or more. */
function isTabCapacity(value: unknown): value is number {
  const n = toFiniteNumber(value);
  return n !== undefined && n >= 0;
}

/** Efforts a model may be run at — Fable stops at medium (CLAUDE.md hard cap). */
export function effortsForModel(model: string): Effort[] {
  return model === 'claude-fable-5' ? ['low', 'medium'] : [...EFFORTS];
}

/**
 * Clamps an effort into what the model allows; used when the model changes.
 * `efforts` defaults to the legacy Claude/fable rule (effortsForModel) — pass a
 * registry-aware resolver (models.ts's allowedEfforts) for a non-built-in model,
 * see applyChange.
 */
export function clampEffort(
  model: string,
  effort: Effort,
  efforts: (model: string) => Effort[] = effortsForModel,
): Effort {
  const allowed = efforts(model);
  return allowed.includes(effort) ? effort : (allowed[allowed.length - 1] ?? effort);
}

function isModel(value: unknown): value is Model {
  return MODELS.includes(value as Model);
}

function isEffort(value: unknown): value is Effort {
  return EFFORTS.includes(value as Effort);
}

/** Merges stored values over the defaults; anything unusable falls back. */
export function parseSettings(raw: string | undefined): Settings {
  let data: Record<string, unknown> = {};
  try {
    const parsed = raw === undefined ? undefined : JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // broken JSON — the defaults below are the answer, never an error
  }
  const poll = Number(data.workerPollSeconds);
  const harness = isHarness(data.orchestratorHarness)
    ? data.orchestratorHarness
    : DEFAULT_SETTINGS.orchestratorHarness;
  return {
    orchestratorHarness: harness,
    orchestratorModel: isModelForHarness(harness, data.orchestratorModel)
      ? data.orchestratorModel
      : defaultModelFor(harness),
    orchestratorEffort: isEffort(data.orchestratorEffort)
      ? data.orchestratorEffort
      : DEFAULT_SETTINGS.orchestratorEffort,
    workerLayout: data.workerLayout === 'window' || data.workerLayout === 'split'
      ? data.workerLayout
      : DEFAULT_SETTINGS.workerLayout,
    workerModel: isPlausibleModelId(data.workerModel) ? data.workerModel : DEFAULT_SETTINGS.workerModel,
    workerEffort: isEffort(data.workerEffort) ? data.workerEffort : DEFAULT_SETTINGS.workerEffort,
    terminalStartMaximized: typeof data.terminalStartMaximized === 'boolean'
      ? data.terminalStartMaximized
      : DEFAULT_SETTINGS.terminalStartMaximized,
    contextGuardAutostart: typeof data.contextGuardAutostart === 'boolean'
      ? data.contextGuardAutostart
      : DEFAULT_SETTINGS.contextGuardAutostart,
    modelDiscoveryAuto: typeof data.modelDiscoveryAuto === 'boolean'
      ? data.modelDiscoveryAuto
      : DEFAULT_SETTINGS.modelDiscoveryAuto,
    newSessionDefaultDir: typeof data.newSessionDefaultDir === 'string'
      && data.newSessionDefaultDir.trim().length > 0
      ? data.newSessionDefaultDir.trim()
      : DEFAULT_SETTINGS.newSessionDefaultDir,
    workerPollSeconds: Number.isFinite(poll) && poll >= 1 && poll <= 300
      ? Math.round(poll)
      : DEFAULT_SETTINGS.workerPollSeconds,
    guardOrchWarnPct: isPct(data.guardOrchWarnPct)
      ? Math.round(Number(data.guardOrchWarnPct))
      : DEFAULT_SETTINGS.guardOrchWarnPct,
    guardWorkerWarnPct: isPct(data.guardWorkerWarnPct)
      ? Math.round(Number(data.guardWorkerWarnPct))
      : DEFAULT_SETTINGS.guardWorkerWarnPct,
    minWorkerPaneWidth: isPaneWidth(data.minWorkerPaneWidth)
      ? Math.round(Number(data.minWorkerPaneWidth))
      : DEFAULT_SETTINGS.minWorkerPaneWidth,
    maxWorkers: isWorkerCount(data.maxWorkers)
      ? Math.round(Number(data.maxWorkers))
      : DEFAULT_SETTINGS.maxWorkers,
    maxWorkerPanesPerTab: isTabCapacity(data.maxWorkerPanesPerTab)
      ? Math.round(Number(data.maxWorkerPanesPerTab))
      : DEFAULT_SETTINGS.maxWorkerPanesPerTab,
    defaultWorkerMachine: isWorkerMachine(data.defaultWorkerMachine)
      ? data.defaultWorkerMachine
      : DEFAULT_SETTINGS.defaultWorkerMachine,
    closeSessionOnWindowClose: typeof data.closeSessionOnWindowClose === 'boolean'
      ? data.closeSessionOnWindowClose
      : DEFAULT_SETTINGS.closeSessionOnWindowClose,
    workerWorktrees: typeof data.workerWorktrees === 'boolean'
      ? data.workerWorktrees
      : DEFAULT_SETTINGS.workerWorktrees,
  };
}

/**
 * Validates one incoming change from the settings webview. Returns the value to
 * store, or undefined when the key/value pair is not acceptable (the panel then
 * keeps showing the old value). `harness` is the currently stored orchestrator
 * harness — it decides which model ids are valid (SPEC-V2 F).
 */
export function coerceSetting(
  key: string,
  value: unknown,
  harness: Harness = 'claude',
): string | boolean | number | undefined {
  switch (key) {
    case 'orchestratorHarness':
      return isHarness(value) ? value : undefined;
    case 'orchestratorModel':
      return isModelForHarness(harness, value) ? value : undefined;
    // Not harness-scoped: a worker's default model can come from ANY registered
    // harness regardless of what the orchestrator itself runs (SPEC-V3 D, Reviewer-
    // Befund M6) — isModelForHarness ties a model to the CURRENT orchestrator
    // harness, which is the wrong gate here.
    case 'workerModel':
      return isModel(value) || isPlausibleModelId(value) ? value : undefined;
    case 'orchestratorEffort':
    case 'workerEffort':
      return isEffort(value) ? value : undefined;
    case 'workerLayout':
      return value === 'split' || value === 'window' ? value : undefined;
    case 'terminalStartMaximized':
    case 'contextGuardAutostart':
    case 'modelDiscoveryAuto':
    case 'closeSessionOnWindowClose':
    case 'workerWorktrees':
      return typeof value === 'boolean' ? value : undefined;
    case 'newSessionDefaultDir': {
      if (typeof value !== 'string') {
        return undefined;
      }
      const dir = value.trim();
      return dir.length > 0 ? dir : undefined;
    }
    case 'workerPollSeconds': {
      const seconds = Number(value);
      return Number.isFinite(seconds) && seconds >= 1 && seconds <= 300
        ? Math.round(seconds)
        : undefined;
    }
    case 'guardOrchWarnPct':
    case 'guardWorkerWarnPct':
      return isPct(value) ? Math.round(Number(value)) : undefined;
    case 'minWorkerPaneWidth':
      return isPaneWidth(value) ? Math.round(Number(value)) : undefined;
    case 'maxWorkers':
      return isWorkerCount(value) ? Math.round(Number(value)) : undefined;
    case 'maxWorkerPanesPerTab':
      return isTabCapacity(value) ? Math.round(Number(value)) : undefined;
    case 'defaultWorkerMachine':
      return isWorkerMachine(value) ? value : undefined;
    default:
      return undefined;
  }
}

/**
 * Registry-aware hooks for applyChange/writeSetting. settings.ts stays pure and
 * synchronous (it never reads models.json), so the caller who DOES have the
 * registry loaded (settingsView.ts) can hand in real resolvers; both default to
 * the legacy claude/pi-only behaviour, so every existing caller (and its tests)
 * is unaffected.
 */
export interface RegistryHooks {
  /** Picks a sensible orchestratorModel default for a freshly selected harness. */
  defaultModelFor?: (harness: string) => string;
  /** Efforts a given model id actually allows — models.ts's allowedEfforts for a registry model. */
  effortsForModel?: (model: string) => Effort[];
  /**
   * Does `model` actually belong to `harness`? Defaults to isModelForHarness,
   * whose id-SHAPE check for a non-claude/pi harness is deliberately permissive
   * (settings.ts has no registry access) — permissive enough that a stale
   * Claude id would "fit" any custom harness by shape alone and never get reset
   * on switch. A real membership check (registry lookup) closes that gap.
   */
  modelFitsHarness?: (harness: string, model: unknown) => boolean;
}

/** Applies a change to the raw stored object, keeping unknown keys (SPEC-V2 A). */
export function applyChange(
  stored: Record<string, unknown>,
  key: string,
  value: string | boolean | number,
  hooks: RegistryHooks = {},
): Record<string, unknown> {
  const next = { ...stored, [key]: value };
  const resolveDefaultModel = hooks.defaultModelFor ?? defaultModelFor;
  const resolveEfforts = hooks.effortsForModel ?? effortsForModel;
  const modelFits = hooks.modelFitsHarness ?? isModelForHarness;
  // Switching the harness reinterprets orchestratorModel — a Claude id is
  // meaningless for pi and vice versa, so the model falls back to the new
  // harness's default whenever it does not fit.
  if (key === 'orchestratorHarness') {
    const harness = isHarness(value) ? value : DEFAULT_SETTINGS.orchestratorHarness;
    if (!modelFits(harness, next.orchestratorModel)) {
      next.orchestratorModel = resolveDefaultModel(harness);
    }
  }
  // A model change can push its effort above the model's ceiling — clamp both
  // pairs so the file never claims fable:xhigh (or, for a registry model, above
  // its own maxEffort).
  if (key === 'orchestratorModel' || key === 'orchestratorEffort' || key === 'orchestratorHarness') {
    next.orchestratorEffort = clampEffort(
      String(next.orchestratorModel ?? DEFAULT_SETTINGS.orchestratorModel),
      isEffort(next.orchestratorEffort) ? next.orchestratorEffort : DEFAULT_SETTINGS.orchestratorEffort,
      resolveEfforts,
    );
  }
  if (key === 'workerModel' || key === 'workerEffort') {
    next.workerEffort = clampEffort(
      String(next.workerModel ?? DEFAULT_SETTINGS.workerModel),
      isEffort(next.workerEffort) ? next.workerEffort : DEFAULT_SETTINGS.workerEffort,
      resolveEfforts,
    );
  }
  return next;
}

/** '~/AI' in the settings file is a path for humans, not for the file system. */
export function expandHome(dir: string, home: string = homedir()): string {
  if (dir === '~') {
    return home;
  }
  return dir.startsWith('~/') ? join(home, dir.slice(2)) : dir;
}

export function workbenchDir(): string {
  return join(homedir(), '.claude', 'workbench');
}

export function settingsFile(): string {
  return join(workbenchDir(), 'settings.json');
}

export function locksDir(): string {
  return join(workbenchDir(), 'locks');
}

function lockPath(): string {
  return join(locksDir(), 'settings.json.lock.d');
}

/** A lock older than this is treated as abandoned (crashed writer). */
export const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 50;
const LOCK_TRIES = 100;

/**
 * Directory-based lock in the same lock directory the state files use. mkdir is
 * atomic on every filesystem we care about; a lock left behind by a crashed
 * write is taken over after LOCK_STALE_MS.
 */
async function withLock<T>(action: () => Promise<T>): Promise<T> {
  const lock = lockPath();
  await mkdir(locksDir(), { recursive: true });
  for (let attempt = 0; attempt < LOCK_TRIES; attempt++) {
    try {
      await mkdir(lock);
      try {
        return await action();
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        throw error;
      }
      await takeOverIfStale(lock);
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  throw new Error('settings.json ist gesperrt — Schreiben nicht möglich.');
}

async function takeOverIfStale(lock: string): Promise<void> {
  try {
    const info = await stat(lock);
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
      await rm(lock, { recursive: true, force: true });
    }
  } catch {
    // gone already, or unreadable — the next mkdir attempt decides
  }
}

/** Raw stored object (unknown keys included), {} when there is nothing usable. */
export async function readRawSettings(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(settingsFile(), 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // missing or broken file — start from an empty object
  }
  return {};
}

export async function readSettings(): Promise<Settings> {
  try {
    return parseSettings(await readFile(settingsFile(), 'utf8'));
  } catch {
    return parseSettings(undefined);
  }
}

export interface WriteOptions {
  /** Actor column of the change log; defaults to a plain 'extension'. */
  actor?: string;
  /** Called when the change log could not be written — the write itself stands. */
  onLogError?: (message: string) => void;
  /** Registry-aware default-model/effort resolvers (see RegistryHooks); defaults to legacy claude/pi behaviour. */
  registryHooks?: RegistryHooks;
}

/**
 * Writes one key, preserving everything else in the file. Returns the effective
 * settings after the write.
 *
 * The change log is appended INSIDE the lock, after the settings file is safely
 * in place — same order and same lock as wb-state, so the two sources cannot
 * interleave a line with a half-written file. A failing log never fails the
 * write (it is reported through onLogError instead).
 */
export async function writeSetting(
  key: string,
  value: string | boolean | number,
  options: WriteOptions = {},
): Promise<Settings> {
  return withLock(async () => {
    const stored = await readRawSettings();
    const next = applyChange(stored, key, value, options.registryHooks);
    const file = settingsFile();
    const tmp = `${file}.${process.pid}.tmp`;
    await mkdir(workbenchDir(), { recursive: true });
    await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    await rename(tmp, file);
    const failure = await appendChangeLog(changeLines(stored, next, options.actor ?? 'extension'));
    if (failure) {
      options.onLogError?.(failure);
    }
    return parseSettings(JSON.stringify(next));
  });
}
