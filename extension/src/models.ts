// ~/.claude/workbench/models.json — the model/harness/provider registry (SPEC-V3 A).
//
// Rein funktional, ohne vscode-Import (wie settings.ts): eine kaputte oder fehlende
// Datei liefert eine leere Registry statt zu werfen, jeder Eintrag wird EINZELN
// validiert (ein kaputtes Modell reißt nicht die ganze Liste mit), und unbekannte
// Modell-IDs, die mit eingebauten Aliassen kollidieren, werden verworfen — der
// eingebaute Alias gewinnt immer (SPEC-V3 A.3).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EFFORTS,
  type Effort,
  effortsForModel,
  HARNESS_LABEL,
  MODEL_LABEL,
  MODELS,
  PI_MODEL_LABEL,
  PI_MODELS,
  workbenchDir,
} from './settings.ts';

export type ProviderKind = 'cloud' | 'local' | 'subscription';

/**
 * Vertrag Teil 2 §1/§2 — a provider's network catalog fetch, written by
 * `wb-state models discover` once it lands. Purely a READ/DISPLAY concern here
 * (task item 6: "sobald die Felder da sind … wo sie noch fehlen, zeigst du
 * sauber 'unbekannt'"): no code path in this extension writes these fields,
 * and every one of them is optional so a registry from before the shell side
 * ships them still parses and renders honestly as "unbekannt" instead of a
 * made-up number.
 */
export interface ProviderCatalogStatus {
  count: number;
  fetchedAt?: string;
}

/** `amount: null` means unlimited/no cap ("unbegrenzt") — Vertrag §2's `freeWhenEmpty`. */
export interface ProviderBalanceStatus {
  amount: number | null;
  currency?: string;
  fetchedAt?: string;
}

export interface Provider {
  id: string;
  label: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  keychainService?: string;
  kind: ProviderKind;
  /** Explicit override of the data-locality default (`kind === 'local'`) — SPEC-V3 supplement 2026-07-28. */
  dataStaysLocal?: boolean;
  /**
   * Path (may start with `~/`) whose existence indicates a `subscription` login
   * happened — e.g. `~/.codex/auth.json` for the ChatGPT/codex account. Optional
   * and honest: without it the UI shows "nicht automatisch prüfbar" instead of
   * guessing a per-CLI convention it cannot verify.
   */
  loginCheckPath?: string;
  /** Vertrag Teil 2 §1/§2 — see ProviderCatalogStatus/ProviderBalanceStatus above. */
  catalogStatus?: ProviderCatalogStatus;
  balanceStatus?: ProviderBalanceStatus;
  /** True only for one of the ten preconfigured providers (SPEC-V3 A.1), never for a file entry. */
  builtin?: boolean;
}

export interface HarnessEffortConfig {
  style: 'arg' | 'none';
  args?: string[];
  map?: Record<string, string>;
}

export type SystemPromptStyle = 'flag-content' | 'flag-path' | 'file' | 'none';

export interface HarnessSystemPrompt {
  style: SystemPromptStyle;
  path?: string;
}

export interface HarnessAutonomy {
  args?: string[];
}

export interface HarnessResume {
  args?: string[];
  probe?: string;
}

export type HarnessDiscoverSource = 'ollama' | 'command-lines' | 'file-json';

export interface HarnessDiscoverFilter {
  field: string;
  equals: string;
}

/**
 * `wb-state models discover`'s per-harness config (Vertrag discover.md §2) — how
 * to ask a harness what models it already knows about ("automatisch importieren,
 * wo der CLI seine Modelle selbst nennt"). This extension only READS and EDITS
 * the block; the discovery run itself is `wb-state`'s job (modelsCli.ts).
 */
export interface HarnessDiscover {
  source: HarnessDiscoverSource;
  command?: string[];
  file?: string;
  jsonPath?: string;
  filter?: HarnessDiscoverFilter;
  refTemplate?: string;
  provider?: string;
  providerByPrefix?: [string, string][];
  idPrefix?: string;
  roles?: RegistryRole[];
  supportsEffort?: boolean;
  ttlHours?: number;
}

export interface RegistryHarness {
  id: string;
  label: string;
  command: string;
  args?: string[];
  cwdMode?: string;
  env?: Record<string, string>;
  effort?: HarnessEffortConfig;
  systemPrompt?: HarnessSystemPrompt;
  autonomy?: HarnessAutonomy;
  resume?: HarnessResume;
  discover?: HarnessDiscover;
  sessionDir?: string;
  readyPattern?: string;
  /** Pattern of the INPUT line itself (SPEC-V3 supplement, Reviewer-Befund H1/H2) — separate
   *  from readyPattern: "the TUI is up" and "my text is still in the line" are different questions. */
  promptPattern?: string;
  /** Placeholder text a harness shows in an EMPTY input line (e.g. codex' suggestion row) — a
   *  paste-verification must not mistake it for hung text (SPEC-V3 supplement, Reviewer-Befund N4). */
  promptIgnore?: string;
  compactCommand?: string | null;
  contextPattern?: string;
  instructionFiles?: string[];
  supportsPaste?: boolean;
  notes?: string;
  /** True only for the code-level 'claude'/'pi' defaults, never for a file entry. */
  builtin?: boolean;
}

export type RegistryRole = 'worker' | 'orchestrator';
export type WorkerClass =
  | 'mechanisch'
  | 'coding-kurz'
  | 'coding-lang'
  | 'reasoning'
  | 'review'
  | 'bulk'
  | 'visuell';
export type RegistryMachine = 'mac' | 'peer';

export interface RegistryCost {
  inPerMTok?: number;
  outPerMTok?: number;
}

export interface RegistryModel {
  id: string;
  label: string;
  harness: string;
  provider: string;
  modelRef: string;
  /** The spelling a spawner's fast alias path already understands (SPEC-V3 A.3), e.g. 'ornith'
   *  for the registered id 'ornith-35b'. Display-only here — the registry does not resolve it. */
  alias?: string;
  roles: RegistryRole[];
  efforts: Effort[];
  maxEffort: Effort;
  defaultEffort: Effort;
  contextWindow?: number;
  cost?: RegistryCost;
  machines?: RegistryMachine[];
  workerClass?: WorkerClass;
  goodFor?: string;
  notFor?: string;
  enabled: boolean;
  /** Does this MODEL understand an effort/reasoning flag? Explicit field wins; see modelSupportsEffort(). */
  supportsEffort?: boolean;
  /** Explicit override of the data-locality default; see modelDataStaysLocal(). */
  dataStaysLocal?: boolean;
  /** True only for the built-in Claude/pi models, never for a file entry. */
  builtin?: boolean;
  /** Written by `wb-state models discover` (Vertrag discover.md §3) — 'auto' entries are
   *  selectable but never recommended (no workerClass, no routing-table row). */
  source?: 'auto' | 'manual';
  /** ISO timestamp of the last successful discovery run that touched this entry. */
  discoveredAt?: string;
}

export interface ModelsRegistry {
  version: number;
  providers: Provider[];
  harnesses: RegistryHarness[];
  models: RegistryModel[];
}

export const EMPTY_REGISTRY: ModelsRegistry = { version: 1, providers: [], harnesses: [], models: [] };

/**
 * Placeholders a harness command template may use (SPEC-V3 A.2). `secret:<provider>`
 * and `baseUrl:<provider>` take a provider id as suffix — any provider id is
 * syntactically valid here, cross-referencing whether that provider exists is a
 * job for `wb-state` at write time, not this reader.
 */
export const FIXED_PLACEHOLDERS = [
  'model',
  'effort',
  'workdir',
  'sessionDir',
  'systemPromptFile',
  'name',
] as const;

const PLACEHOLDER_RE = /\{([^}]*)\}/g;

export function extractPlaceholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
}

export function isKnownPlaceholder(token: string): boolean {
  return (FIXED_PLACEHOLDERS as readonly string[]).includes(token)
    || /^secret:[A-Za-z0-9_-]+$/.test(token)
    || /^baseUrl:[A-Za-z0-9_-]+$/.test(token);
}

/** Every `{…}` token in `text` that is not one of the placeholders the spawner replaces. */
export function unknownPlaceholders(text: string): string[] {
  return extractPlaceholders(text).filter((token) => !isKnownPlaceholder(token));
}

/** Scans every template surface of a harness (args, env values, effort/resume/autonomy args). */
export function unknownPlaceholdersInHarness(harness: RegistryHarness): string[] {
  const texts = [
    ...(harness.args ?? []),
    ...Object.values(harness.env ?? {}),
    ...(harness.effort?.args ?? []),
    ...(harness.autonomy?.args ?? []),
    ...(harness.resume?.args ?? []),
  ];
  const found = new Set<string>();
  for (const text of texts) {
    for (const bad of unknownPlaceholders(text)) {
      found.add(bad);
    }
  }
  return [...found];
}

/** Model ids that already mean something — a registry entry may never claim one. */
export const RESERVED_MODEL_IDS: readonly string[] = [...MODELS, ...PI_MODELS];

export function isReservedModelId(id: string): boolean {
  return RESERVED_MODEL_IDS.includes(id);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((v): v is string => typeof v === 'string');
  return strings.length > 0 ? strings : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out[key] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Keeps only the values of `value` (an array) that are one of `allowed`. */
function asEnumArray<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is T => typeof v === 'string' && (allowed as readonly string[]).includes(v));
}

const PROVIDER_KINDS: readonly ProviderKind[] = ['cloud', 'local', 'subscription'];

function validateCatalogStatus(raw: unknown): ProviderCatalogStatus | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const count = typeof r.count === 'number' && Number.isFinite(r.count) && r.count >= 0 ? r.count : undefined;
  if (count === undefined) {
    return undefined;
  }
  return { count, fetchedAt: asString(r.fetchedAt) };
}

function validateBalanceStatus(raw: unknown): ProviderBalanceStatus | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const amount = r.amount === null
    ? null
    : (typeof r.amount === 'number' && Number.isFinite(r.amount) ? r.amount : undefined);
  if (amount === undefined) {
    return undefined;
  }
  return { amount, currency: asString(r.currency), fetchedAt: asString(r.fetchedAt) };
}

function validateProvider(raw: unknown): Provider | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const id = asString(r.id);
  const label = asString(r.label);
  const kind = typeof r.kind === 'string' && (PROVIDER_KINDS as readonly string[]).includes(r.kind)
    ? (r.kind as ProviderKind)
    : undefined;
  if (!id || !label || !kind) {
    return undefined;
  }
  return {
    id,
    label,
    kind,
    baseUrl: asString(r.baseUrl),
    apiKeyEnv: asString(r.apiKeyEnv),
    keychainService: asString(r.keychainService),
    dataStaysLocal: typeof r.dataStaysLocal === 'boolean' ? r.dataStaysLocal : undefined,
    loginCheckPath: asString(r.loginCheckPath),
    catalogStatus: validateCatalogStatus(r.catalogStatus),
    balanceStatus: validateBalanceStatus(r.balanceStatus),
  };
}

const SYSTEM_PROMPT_STYLES: readonly SystemPromptStyle[] = ['flag-content', 'flag-path', 'file', 'none'];

function validateSystemPrompt(raw: unknown): HarnessSystemPrompt | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.style !== 'string' || !(SYSTEM_PROMPT_STYLES as readonly string[]).includes(r.style)) {
    return undefined;
  }
  const style = r.style as SystemPromptStyle;
  const path = asString(r.path);
  // 'file' names a fixed instructions file the harness reads — without a path it
  // cannot work, so the whole field is dropped rather than kept half-configured.
  if (style === 'file' && !path) {
    return undefined;
  }
  return { style, path };
}

function validateEffortConfig(raw: unknown): HarnessEffortConfig | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  if (r.style !== 'arg' && r.style !== 'none') {
    return undefined;
  }
  return {
    style: r.style,
    args: asStringArray(r.args),
    map: asStringRecord(r.map),
  };
}

function validateAutonomy(raw: unknown): HarnessAutonomy | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const args = asStringArray((raw as Record<string, unknown>).args);
  return args ? { args } : undefined;
}

function validateResume(raw: unknown): HarnessResume | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const args = asStringArray(r.args);
  const probe = asString(r.probe);
  return args || probe ? { args, probe } : undefined;
}

const DISCOVER_SOURCES: readonly HarnessDiscoverSource[] = ['ollama', 'command-lines', 'file-json'];

function validateDiscoverFilter(raw: unknown): HarnessDiscoverFilter | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const field = asString(r.field);
  const equals = asString(r.equals);
  return field && equals ? { field, equals } : undefined;
}

function asProviderByPrefix(value: unknown): [string, string][] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const pairs: [string, string][] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      continue;
    }
    const prefix = asString(entry[0]);
    const provider = asString(entry[1]);
    if (prefix && provider) {
      pairs.push([prefix, provider]);
    }
  }
  return pairs.length > 0 ? pairs : undefined;
}

/**
 * Vertrag discover.md §2 — a harness with no `discover` block (or a broken one,
 * e.g. an unknown `source`) simply has no auto-discovery, same "drop the field,
 * keep the harness" fault tolerance as every other validate* here.
 */
function validateDiscover(raw: unknown): HarnessDiscover | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const source = typeof r.source === 'string' && (DISCOVER_SOURCES as readonly string[]).includes(r.source)
    ? (r.source as HarnessDiscoverSource)
    : undefined;
  if (!source) {
    return undefined;
  }
  const roles = asEnumArray(r.roles, ROLES);
  return {
    source,
    command: asStringArray(r.command),
    file: asString(r.file),
    jsonPath: asString(r.jsonPath),
    filter: validateDiscoverFilter(r.filter),
    refTemplate: asString(r.refTemplate),
    provider: asString(r.provider),
    providerByPrefix: asProviderByPrefix(r.providerByPrefix),
    idPrefix: asString(r.idPrefix),
    roles: roles.length > 0 ? roles : undefined,
    supportsEffort: typeof r.supportsEffort === 'boolean' ? r.supportsEffort : undefined,
    ttlHours: asPositiveNumber(r.ttlHours),
  };
}

function validateHarness(raw: unknown): RegistryHarness | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const id = asString(r.id);
  const label = asString(r.label);
  const command = asString(r.command);
  if (!id || !label || !command) {
    return undefined;
  }
  return {
    id,
    label,
    command,
    args: asStringArray(r.args),
    cwdMode: asString(r.cwdMode) ?? 'cd',
    env: asStringRecord(r.env),
    effort: validateEffortConfig(r.effort),
    systemPrompt: validateSystemPrompt(r.systemPrompt),
    autonomy: validateAutonomy(r.autonomy),
    resume: validateResume(r.resume),
    discover: validateDiscover(r.discover),
    sessionDir: asString(r.sessionDir),
    readyPattern: asString(r.readyPattern),
    promptPattern: asString(r.promptPattern),
    promptIgnore: asString(r.promptIgnore),
    compactCommand: r.compactCommand === null ? null : asString(r.compactCommand),
    contextPattern: asString(r.contextPattern),
    instructionFiles: asStringArray(r.instructionFiles),
    supportsPaste: typeof r.supportsPaste === 'boolean' ? r.supportsPaste : undefined,
    notes: asString(r.notes),
  };
}

const ROLES: readonly RegistryRole[] = ['worker', 'orchestrator'];
const WORKER_CLASSES: readonly WorkerClass[] = [
  'mechanisch',
  'coding-kurz',
  'coding-lang',
  'reasoning',
  'review',
  'bulk',
  'visuell',
];
const REGISTRY_MACHINES: readonly RegistryMachine[] = ['mac', 'peer'];

function validateCost(raw: unknown): RegistryCost | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const inPerMTok = typeof r.inPerMTok === 'number' && Number.isFinite(r.inPerMTok) ? r.inPerMTok : undefined;
  const outPerMTok = typeof r.outPerMTok === 'number' && Number.isFinite(r.outPerMTok) ? r.outPerMTok : undefined;
  return inPerMTok !== undefined || outPerMTok !== undefined ? { inPerMTok, outPerMTok } : undefined;
}

/**
 * A single model entry. `maxEffort` deckelt jeden Spawn (SPEC-V3 A.3, Policy-Caps
 * bleiben scharf): `efforts` wird auf alles <= `maxEffort` beschnitten, und ein
 * `maxEffort` außerhalb der bekannten Effort-Stufen (also insbesondere `"max"`,
 * das nirgends existiert) macht den ganzen Eintrag ungültig.
 */
function validateModel(raw: unknown): RegistryModel | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const id = asString(r.id);
  const label = asString(r.label);
  const harness = asString(r.harness);
  const provider = asString(r.provider);
  const modelRef = asString(r.modelRef);
  if (!id || !label || !harness || !provider || !modelRef) {
    return undefined;
  }
  if (isReservedModelId(id)) {
    return undefined;
  }
  const roles = asEnumArray(r.roles, ROLES);
  if (roles.length === 0) {
    return undefined;
  }
  const supportsEffort = typeof r.supportsEffort === 'boolean' ? r.supportsEffort : undefined;
  const maxEffortRaw = typeof r.maxEffort === 'string' && (EFFORTS as readonly string[]).includes(r.maxEffort)
    ? (r.maxEffort as Effort)
    : undefined;
  // A discovered model behind a harness with no effort concept at all (e.g.
  // opencode: effort.style "none") omits maxEffort/efforts/defaultEffort
  // entirely (Vertrag discover.md §3) — `supportsEffort: false` is the signal
  // that there is no real ceiling to speak of, so a harmless synthetic 'high'
  // stands in rather than dropping the whole entry (nothing ever reads it: the
  // UI hides the effort control whenever modelSupportsEffort() is false).
  const maxEffort = maxEffortRaw ?? (supportsEffort === false ? 'high' : undefined);
  if (!maxEffort) {
    return undefined;
  }
  const maxIndex = EFFORTS.indexOf(maxEffort);
  let efforts = asEnumArray(r.efforts, EFFORTS).filter((e) => EFFORTS.indexOf(e) <= maxIndex);
  if (efforts.length === 0) {
    efforts = [maxEffort];
  }
  const requestedDefault = typeof r.defaultEffort === 'string' && (EFFORTS as readonly string[]).includes(r.defaultEffort)
    ? (r.defaultEffort as Effort)
    : undefined;
  const defaultEffort = requestedDefault && efforts.includes(requestedDefault)
    ? requestedDefault
    : efforts[efforts.length - 1];
  const machines = asEnumArray(r.machines, REGISTRY_MACHINES);
  return {
    id,
    label,
    harness,
    provider,
    modelRef,
    alias: asString(r.alias),
    roles,
    efforts,
    maxEffort,
    defaultEffort,
    contextWindow: asPositiveNumber(r.contextWindow),
    cost: validateCost(r.cost),
    machines: machines.length > 0 ? machines : undefined,
    workerClass: typeof r.workerClass === 'string' && (WORKER_CLASSES as readonly string[]).includes(r.workerClass)
      ? (r.workerClass as WorkerClass)
      : undefined,
    goodFor: asString(r.goodFor),
    notFor: asString(r.notFor),
    enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
    supportsEffort,
    dataStaysLocal: typeof r.dataStaysLocal === 'boolean' ? r.dataStaysLocal : undefined,
    source: r.source === 'auto' || r.source === 'manual' ? r.source : undefined,
    discoveredAt: asString(r.discoveredAt),
  };
}

/**
 * Parses raw `models.json` content. Never throws: missing/broken/empty input, a
 * non-array `providers`/`harnesses`/`models`, or an individual malformed entry
 * all fall back to "not present" rather than aborting the whole file — one bad
 * entry must not hide every other one (same fault tolerance as settings.ts).
 */
export function parseModelsRegistry(raw: string | undefined): ModelsRegistry {
  let data: Record<string, unknown> = {};
  try {
    const parsed = raw === undefined ? undefined : JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // broken JSON — the empty registry below is the answer, never an error
  }
  const providers = Array.isArray(data.providers) ? data.providers.map(validateProvider).filter(isDefined) : [];
  const harnesses = Array.isArray(data.harnesses) ? data.harnesses.map(validateHarness).filter(isDefined) : [];
  const models = Array.isArray(data.models) ? data.models.map(validateModel).filter(isDefined) : [];
  return {
    version: typeof data.version === 'number' ? data.version : 1,
    providers,
    harnesses,
    models,
  };
}

export function modelsFile(): string {
  return join(workbenchDir(), 'models.json');
}

export async function readModelsRegistry(): Promise<ModelsRegistry> {
  try {
    return parseModelsRegistry(await readFile(modelsFile(), 'utf8'));
  } catch {
    return parseModelsRegistry(undefined);
  }
}

// --- Built-ins: exactly today's behaviour when models.json is missing (SPEC-V3 D) ---

// Real measured fields (SPEC-V3-MODELS A.2, `shell/wb-state`'s BUILTIN_HARNESSES) —
// without them the Modelle-&-Harnesses table showed "nicht gemessen" for two
// adapters that have been production-proven since V1.
export const BUILTIN_HARNESSES: readonly RegistryHarness[] = [
  {
    id: 'claude', label: HARNESS_LABEL.claude, command: 'claude', builtin: true,
    readyPattern: '❯|░|●', promptPattern: '^❯', compactCommand: '/compact',
    effort: { style: 'arg', args: ['--effort', '{effort}'] },
  },
  {
    id: 'pi', label: HARNESS_LABEL.pi, command: 'pi', builtin: true,
    readyPattern: '❯|░|●', promptPattern: '^❯', compactCommand: null,
    effort: { style: 'arg', args: ['--thinking', '{effort}'] },
  },
];

const CLAUDE_WORKER_CLASS: Record<string, WorkerClass> = {
  'claude-haiku-4-5': 'mechanisch',
  'claude-sonnet-5': 'coding-kurz',
  'claude-opus-5': 'reasoning',
  'claude-opus-4-8': 'review',
  'claude-fable-5': 'visuell',
};

const CLAUDE_GOOD_FOR: Record<string, string> = {
  'claude-haiku-4-5': 'Mechanische Tasks: rename, config tweak, format, offensichtlicher Fix.',
  'claude-sonnet-5': 'Kurz spezifizierte Coding-Tasks; bei xhigh auch größere Cross-File-Refactors.',
  'claude-opus-5': 'Lang/mehrstufige Aufgaben, Debugging, Design-Entscheidungen, Ambiguität.',
  'claude-opus-4-8': 'Zweitmeinung, unabhängiger Reviewer-Pass, A/B-Vergleich.',
  'claude-fable-5': 'Kundengerichtetes visuelles Deliverable (Landing-Page, Kundenpräsentation).',
};

const CLAUDE_NOT_FOR: Record<string, string> = {
  'claude-haiku-4-5': 'Ambiguität, Design-Entscheidungen.',
  'claude-sonnet-5': 'Offene Ambiguität, Architektur-Entscheidungen.',
  'claude-opus-5': 'Mechanische Bulk-Arbeit, die günstiger geht.',
  'claude-opus-4-8': 'Erststart einer Aufgabe ohne Kontext.',
  'claude-fable-5': 'Internes/Standard-Coding — dafür gesperrt (FABLE-SPERRE).',
};

const PI_GOOD_FOR: Record<string, string> = {
  ornith: 'Lokaler Default-Coder für Bulk/Inventur/Overnight-Arbeit, token-frei.',
  qwen: 'Zweitmeinung lokal, token-frei.',
  ornith9: 'Günstiger lokaler Bulk-Lauf, kleineres Modell.',
};

const PI_NOT_FOR: Record<string, string> = {
  ornith: 'Harte Architektur-Entscheidungen.',
  qwen: 'Kundengerichtete Deliverables.',
  ornith9: 'Komplexe Coding-Tasks.',
};

export const BUILTIN_MODELS: readonly RegistryModel[] = [
  ...MODELS.map((id): RegistryModel => {
    const efforts = effortsForModel(id);
    return {
      id,
      label: MODEL_LABEL[id],
      harness: 'claude',
      provider: 'claude-subscription',
      modelRef: id,
      roles: ['worker', 'orchestrator'],
      efforts,
      maxEffort: efforts[efforts.length - 1],
      defaultEffort: id === 'claude-fable-5' ? 'medium' : 'high',
      workerClass: CLAUDE_WORKER_CLASS[id],
      goodFor: CLAUDE_GOOD_FOR[id],
      notFor: CLAUDE_NOT_FOR[id],
      enabled: true,
      builtin: true,
    };
  }),
  ...PI_MODELS.map((id): RegistryModel => ({
    id,
    label: PI_MODEL_LABEL[id],
    harness: 'pi',
    provider: 'ollama',
    modelRef: id,
    roles: ['worker', 'orchestrator'],
    efforts: [...EFFORTS],
    maxEffort: 'xhigh',
    defaultEffort: 'high',
    workerClass: 'bulk',
    goodFor: PI_GOOD_FOR[id],
    notFor: PI_NOT_FOR[id],
    enabled: true,
    // pi forwards --thinking to these models despite the local provider — the
    // default (data-stays-local implies no effort) would be wrong here, exactly
    // the case the field exists for (real ornith-35b/-9b registry entries
    // declare the same override, SPEC-V3 supplement 2026-07-28).
    supportsEffort: true,
    builtin: true,
  })),
];

export const BUILTIN_HARNESS_IDS: readonly string[] = BUILTIN_HARNESSES.map((h) => h.id);

/**
 * Whether `id` names one of the code-level defaults ('claude'/'pi') — true
 * regardless of whether a file entry currently overrides its fields, since a
 * file override REPLACES the object (and with it a mutable `builtin` flag
 * would be lost) but the id itself is still permanent: claude/pi are baked
 * into the spawner (SPEC-V3 A.2), so the UI must never offer to remove them.
 */
export function isBuiltinHarnessId(id: string): boolean {
  return BUILTIN_HARNESS_IDS.includes(id);
}

/** Built-ins first, file harnesses override a matching id (SPEC-V3 A.2), rest appended. */
export function effectiveHarnesses(registry: ModelsRegistry): RegistryHarness[] {
  const byId = new Map(BUILTIN_HARNESSES.map((h) => [h.id, h]));
  for (const harness of registry.harnesses) {
    byId.set(harness.id, harness);
  }
  return [...byId.values()];
}

/**
 * Built-ins plus every valid file model. A file model whose id collides with a
 * built-in alias was already dropped by validateModel (isReservedModelId), so
 * there is nothing left to reconcile here — the built-in simply always wins.
 */
export function effectiveModels(registry: ModelsRegistry): RegistryModel[] {
  return [...BUILTIN_MODELS, ...registry.models];
}

export interface ModelFilter {
  role?: RegistryRole;
  machine?: RegistryMachine;
  harness?: string;
  enabledOnly?: boolean;
}

export function modelsForRole(registry: ModelsRegistry, filter: ModelFilter = {}): RegistryModel[] {
  const { role, machine, harness, enabledOnly = true } = filter;
  return effectiveModels(registry).filter((model) => {
    if (enabledOnly && !model.enabled) {
      return false;
    }
    if (role && !model.roles.includes(role)) {
      return false;
    }
    if (harness && model.harness !== harness) {
      return false;
    }
    if (machine && model.machines && !model.machines.includes(machine)) {
      return false;
    }
    return true;
  });
}

/**
 * Stays the data on this machine? Explicit field wins (model before provider),
 * otherwise it follows provider.kind === 'local'. Mirrors wb-state's
 * data_stays_local() (SPEC-V3 supplement 2026-07-28) — `subscription` and
 * `cloud` are never local by default, that is the whole point of the field.
 */
export function modelDataStaysLocal(model: RegistryModel, provider: Provider | undefined): boolean {
  if (typeof model.dataStaysLocal === 'boolean') {
    return model.dataStaysLocal;
  }
  if (provider && typeof provider.dataStaysLocal === 'boolean') {
    return provider.dataStaysLocal;
  }
  return provider?.kind === 'local';
}

/**
 * Does this MODEL understand an effort/reasoning flag? Mirrors wb-state's
 * model_takes_effort(): the HARNESS only says HOW effort is passed
 * (effort.style), not whether the model behind it accepts one — a harness with
 * `style: 'none'` (opencode) never shows it, an explicit `supportsEffort` field
 * wins next, and without either a local model defaults to "no" (SPEC-V3
 * supplement: aider warned on every start passing --reasoning-effort to a local
 * Ollama model that does not know it).
 */
export function modelSupportsEffort(
  model: RegistryModel,
  harness: RegistryHarness | undefined,
  provider: Provider | undefined,
): boolean {
  if ((harness?.effort?.style ?? 'none') === 'none') {
    return false;
  }
  if (typeof model.supportsEffort === 'boolean') {
    return model.supportsEffort;
  }
  return !modelDataStaysLocal(model, provider);
}

/** Efforts a model may actually run at: its own list, already capped at maxEffort. */
export function allowedEfforts(model: RegistryModel): Effort[] {
  const maxIndex = EFFORTS.indexOf(model.maxEffort);
  return EFFORTS.filter((e) => model.efforts.includes(e) && EFFORTS.indexOf(e) <= maxIndex);
}

/** Clamps `effort` into what `model` allows — mirrors settings.ts's clampEffort for registry models. */
export function clampEffortForModel(model: RegistryModel, effort: Effort): Effort {
  const allowed = allowedEfforts(model);
  if (allowed.includes(effort)) {
    return effort;
  }
  return allowed[allowed.length - 1] ?? model.defaultEffort;
}

/**
 * Vorkonfiguriert, aber ohne Key und damit inaktiv (SPEC-V3 A.1) — present in the
 * UI from the first render, before `models.json` exists or wb-state has ever
 * written a provider entry. A file entry with the same id overrides one of
 * these (e.g. a custom baseUrl), exactly like a built-in harness.
 */
export const BUILTIN_PROVIDERS: readonly Provider[] = [
  { id: 'openai', label: 'OpenAI', kind: 'cloud', apiKeyEnv: 'OPENAI_API_KEY', keychainService: 'wb-openai', builtin: true },
  { id: 'google', label: 'Google', kind: 'cloud', apiKeyEnv: 'GOOGLE_API_KEY', keychainService: 'wb-google', builtin: true },
  {
    id: 'openrouter', label: 'OpenRouter', kind: 'cloud', baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY', keychainService: 'wb-openrouter', builtin: true,
  },
  {
    id: 'deepseek', label: 'DeepSeek', kind: 'cloud',
    apiKeyEnv: 'DEEPSEEK_API_KEY', keychainService: 'wb-deepseek', builtin: true,
  },
  { id: 'groq', label: 'Groq', kind: 'cloud', apiKeyEnv: 'GROQ_API_KEY', keychainService: 'wb-groq', builtin: true },
  {
    id: 'mistral', label: 'Mistral', kind: 'cloud',
    apiKeyEnv: 'MISTRAL_API_KEY', keychainService: 'wb-mistral', builtin: true,
  },
  { id: 'xai', label: 'xAI', kind: 'cloud', apiKeyEnv: 'XAI_API_KEY', keychainService: 'wb-xai', builtin: true },
  {
    id: 'anthropic-api', label: 'Anthropic API', kind: 'cloud',
    apiKeyEnv: 'ANTHROPIC_API_KEY', keychainService: 'wb-anthropic-api', builtin: true,
  },
  {
    id: 'ollama', label: 'Ollama (lokal)', kind: 'local', baseUrl: 'http://127.0.0.1:11434', builtin: true,
  },
  { id: 'llamacpp', label: 'llama.cpp (lokal)', kind: 'local', builtin: true },
];

export const BUILTIN_PROVIDER_IDS: readonly string[] = BUILTIN_PROVIDERS.map((p) => p.id);

/** Same reasoning as isBuiltinHarnessId: an id-based check survives a file override. */
export function isBuiltinProviderId(id: string): boolean {
  return BUILTIN_PROVIDER_IDS.includes(id);
}

/** Built-in providers first, a file entry with the same id overrides it, rest appended. */
export function effectiveProviders(registry: ModelsRegistry): Provider[] {
  const byId = new Map(BUILTIN_PROVIDERS.map((p) => [p.id, p]));
  for (const provider of registry.providers) {
    byId.set(provider.id, provider);
  }
  return [...byId.values()];
}

export function findProvider(registry: ModelsRegistry, id: string): Provider | undefined {
  return effectiveProviders(registry).find((p) => p.id === id);
}

export function findHarness(registry: ModelsRegistry, id: string): RegistryHarness | undefined {
  return effectiveHarnesses(registry).find((h) => h.id === id);
}

/**
 * Harnesses whose CLI performs `provider`'s login — found via any registered
 * model that pairs this provider with a harness (a `subscription` provider has
 * no key of its own, SPEC-V3 H0: "codex und agy melden sich über ein KONTO an").
 * Running that harness's bare command IS the login flow (`codex`, `agy` — both
 * drop into an interactive terminal login on first use). Empty when no model
 * references the provider yet — the caller shows an honest "noch kein Harness
 * verknüpft" instead of guessing a command.
 */
export function harnessesForProvider(registry: ModelsRegistry, providerId: string): RegistryHarness[] {
  const harnessIds = new Set(
    effectiveModels(registry).filter((m) => m.provider === providerId).map((m) => m.harness),
  );
  return effectiveHarnesses(registry).filter((h) => harnessIds.has(h.id));
}

/**
 * The mirror of harnessesForProvider (task item 3, Vertrag Teil 2 §0.2): every
 * `cloud` provider a harness actually runs models from — that is exactly the
 * set of API keys the "API-Keys je Harness" section needs to show under this
 * harness. `local`/`subscription` providers are excluded: a local provider
 * needs no key, a subscription one logs in via its harness command, not a key
 * field (same distinction providerRow already draws).
 */
export function providersForHarness(registry: ModelsRegistry, harnessId: string): Provider[] {
  const providerIds = new Set(
    effectiveModels(registry).filter((m) => m.harness === harnessId).map((m) => m.provider),
  );
  return effectiveProviders(registry).filter((p) => providerIds.has(p.id) && p.kind === 'cloud');
}

/**
 * Vertrag Teil 2 §2: "kostenlos heisst Preisfelder … sind 0". A model with no
 * cost info at all is NOT free — it is unknown, and defaulting unknown-to-free
 * would misclassify an ordinary paid API model that just has not had its price
 * recorded yet. `validateCost` already guarantees at least one of in/out is a
 * real number whenever `cost` is present, so `?? 0` here only ever fills the
 * OTHER, genuinely absent side.
 */
export function isFreeModel(model: RegistryModel): boolean {
  if (!model.cost) {
    return false;
  }
  return (model.cost.inPerMTok ?? 0) === 0 && (model.cost.outPerMTok ?? 0) === 0;
}
