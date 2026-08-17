// wb-state (models add|set|remove|check) and wb-harness-probe invocations.
//
// Arbeitsteilung (SPEC-V3 D): this extension reads models.json directly, but
// writes ONLY through `wb-state models …` — one validator, one lock, one change
// log, on the shell side. The argument builders below are pure and tested
// against the real CLI (see modelsCli.test.ts); the execFile calls themselves
// are a thin, untested wrapper — same split as tmux.ts's `run()` (never
// unit-tested) vs. its arg builders (are).
import { execFile } from 'node:child_process';
import { access, constants as fsConstants } from 'node:fs/promises';
import type { Provider, RegistryHarness, RegistryModel } from './models.ts';
import { expandHome } from './settings.ts';

export interface CliResult {
  ok: boolean;
  message: string;
}

export type RegistryKind = 'model' | 'harness' | 'provider';

/**
 * `wb-state models add` embeds its Python body in a `<<'PY'` heredoc, which
 * consumes the shell process's OWN stdin to feed the interpreter its source —
 * so `sys.stdin.read()` inside `cmd_add` can never see anything piped into
 * `wb-state` from outside (verified: piping JSON at `models add --kind model -`
 * always fails with "kein gueltiges JSON", stdin is empty by the time Python
 * reads it). The JSON body is passed as a plain positional argument instead —
 * the path `shell/tests/test-registry.sh` itself uses, and the only one that
 * actually reaches `cmd_add`.
 */
export function addArgs(kind: RegistryKind, json: string): string[] {
  return ['models', 'add', '--kind', kind, json];
}

/**
 * `wb-state models set` takes id/field/value as positionals, in that order,
 * after `--kind` — it never reads the value from stdin (only `add` does).
 * `value` is JSON-encoded here because `cmd_set` tries `json.loads(value)`
 * first and falls back to the raw string on failure: encoding it makes
 * booleans/numbers/strings round-trip the same way on the Python side.
 */
export function setFieldArgs(kind: RegistryKind, id: string, field: string, value: unknown): string[] {
  return ['models', 'set', '--kind', kind, id, field, JSON.stringify(value)];
}

export function removeArgs(kind: RegistryKind, id: string): string[] {
  return ['models', 'remove', '--kind', kind, id];
}

export function checkModelArgs(id: string): string[] {
  return ['models', 'check', id];
}

export function probeHarnessArgs(id: string): string[] {
  return [id];
}

export interface DiscoverOpts {
  ifStale?: boolean;
  /**
   * Vertrag Teil 2 §5 (`modelDiscoveryAuto`, off by default from the AUTOMATIC
   * trigger path only): `false` appends `--no-network`, meant to make wb-state
   * skip provider-level network catalog fetches while local sources (ollama/
   * command-lines/file-json) keep running. This flag is an assumption on this
   * side of the Vertrag boundary — the shell side ("die Shell-Seite mache ich
   * selbst") has not implemented `discover` at all yet, so the exact flag name
   * is not yet confirmed against real code; see the result file's OPEN section.
   * Defaults to `true` (full discovery, unaffected) — the explicit "Kataloge
   * jetzt aktualisieren" button always calls this at its default, regardless
   * of `modelDiscoveryAuto`.
   */
  network?: boolean;
}

/**
 * `wb-state models discover [--all | <harnessId> ...] [--if-stale] [--no-network] [--json]`
 * (Vertrag discover.md §1 + Vertrag Teil 2 §5). Explicit ids replace `--all`;
 * `--json` is always appended so the caller gets a machine-readable report,
 * never just prose.
 */
export function discoverArgs(harnessIds?: string[], opts: DiscoverOpts = {}): string[] {
  const args = ['models', 'discover'];
  if (harnessIds && harnessIds.length > 0) {
    args.push(...harnessIds);
  } else {
    args.push('--all');
  }
  if (opts.ifStale) {
    args.push('--if-stale');
  }
  if (opts.network === false) {
    args.push('--no-network');
  }
  args.push('--json');
  return args;
}

/** One harness's outcome from a discover run (Vertrag discover.md §1's `--json` shape). */
export interface DiscoverResult {
  added: string[];
  removed: string[];
  updated: string[];
  kept: number;
  error: string | null;
}

export type DiscoverReport = Record<string, DiscoverResult>;

/**
 * Human-readable one-liner for the settings panel's status line — "was dazukam/
 * wegfiel" per harness, never the raw JSON. A harness whose source failed keeps
 * its models (Vertrag §1: "ein fehlender CLI löscht nicht alle seine Modelle")
 * and shows the error instead of a (misleading) diff count.
 */
export function summarizeDiscoverReport(report: DiscoverReport): string {
  const parts = Object.entries(report).map(([harnessId, r]) => {
    if (r.error) {
      return `${harnessId}: Fehler (${r.error})`;
    }
    const bits: string[] = [];
    if (r.added.length > 0) {
      bits.push(`+${r.added.length}`);
    }
    if (r.removed.length > 0) {
      bits.push(`-${r.removed.length}`);
    }
    if (r.updated.length > 0) {
      bits.push(`${r.updated.length} aktualisiert`);
    }
    if (bits.length === 0) {
      bits.push('unverändert');
    }
    return `${harnessId}: ${bits.join(', ')}`;
  });
  return parts.length > 0 ? parts.join(' · ') : 'Keine Harnesses geprüft.';
}

interface ExecError {
  code?: string;
  stderr?: string;
  stdout?: string;
  message?: string;
}

/**
 * Turns an execFile failure into a panel-safe message. ENOENT (the command is
 * not installed yet — the shell side of SPEC-V3 may still be in progress) gets
 * `missingHint`; anything else surfaces the command's own stderr/stdout instead
 * of a generic "failed", because a swallowed error is exactly what SPEC-V3 D
 * forbids ("Fehler des Kommandos werden im Panel sichtbar gemacht, nie
 * verschluckt").
 */
export function describeCliError(error: ExecError, missingHint: string): string {
  if (error.code === 'ENOENT') {
    return missingHint;
  }
  const detail = (error.stderr || error.stdout || error.message || '').trim();
  return detail.length > 0 ? detail : 'Kommando fehlgeschlagen (keine weitere Ausgabe).';
}

// No wb-state registry subcommand can read stdin (see addArgs above), so every
// argument that write/read paths need is passed on argv — never piped in.
function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 4 << 20 },
      (err, stdout, stderr) => {
        if (err) {
          reject(Object.assign(err, { stderr, stdout }));
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.end();
  });
}

async function runWbState(args: string[], timeoutMs = 15_000): Promise<CliResult> {
  try {
    const stdout = await run('wb-state', args, timeoutMs);
    return { ok: true, message: stdout.trim() || 'OK.' };
  } catch (error) {
    return { ok: false, message: describeCliError(error as ExecError, 'wb-state nicht gefunden (~/.local/bin im PATH?).') };
  }
}

export async function addModel(model: RegistryModel): Promise<CliResult> {
  return runWbState(addArgs('model', JSON.stringify(model)));
}

export async function addHarness(harness: RegistryHarness): Promise<CliResult> {
  return runWbState(addArgs('harness', JSON.stringify(harness)));
}

/** `provider` never carries a key (SPEC-V3 A.1: a key never lives in models.json). */
export async function addProvider(provider: Provider): Promise<CliResult> {
  return runWbState(addArgs('provider', JSON.stringify(provider)));
}

export async function setField(kind: RegistryKind, id: string, field: string, value: unknown): Promise<CliResult> {
  return runWbState(setFieldArgs(kind, id, field, value));
}

export async function removeEntry(kind: RegistryKind, id: string): Promise<CliResult> {
  return runWbState(removeArgs(kind, id));
}

export async function checkModel(id: string): Promise<CliResult> {
  return runWbState(checkModelArgs(id), 30_000);
}

/**
 * Real presence check for the "Binary fehlt" status state (SPEC-V3 D item 2) —
 * mirrors `wb-state`'s own gate (`shutil.which(binp) or (os.path.sep in binp and
 * os.access(binp, X_OK))`): a bare command name is looked up on PATH, a `~/`- or
 * `/`-rooted one is checked for its executable bit directly. Never throws — an
 * unreadable/missing `which` resolves to "not present", same as the shell side.
 */
export function harnessBinaryPresent(command: string): Promise<boolean> {
  const expanded = expandHome(command);
  if (expanded.includes('/')) {
    return access(expanded, fsConstants.X_OK).then(() => true).catch(() => false);
  }
  return new Promise((resolve) => {
    execFile('which', [expanded], { timeout: 5_000 }, (err) => resolve(!err));
  });
}

/**
 * Runs a discovery pass and folds `--json`'s report into a human-readable
 * status message (summarizeDiscoverReport) — the settings panel shows that
 * directly, never the raw JSON. `report` stays attached for callers that want
 * the structured shape too. Generous timeout (60s, Vertrag §1: 20s per source,
 * several sources per run) — never thrown, same contract as every function here.
 */
export async function discoverModels(
  harnessIds?: string[],
  opts: DiscoverOpts = {},
): Promise<CliResult & { report?: DiscoverReport }> {
  try {
    const stdout = await run('wb-state', discoverArgs(harnessIds, opts), 60_000);
    const trimmed = stdout.trim();
    let report: DiscoverReport | undefined;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        report = parsed as DiscoverReport;
      }
    } catch {
      report = undefined;
    }
    return { ok: true, message: report ? summarizeDiscoverReport(report) : (trimmed || 'OK.'), report };
  } catch (error) {
    return {
      ok: false,
      message: describeCliError(error as ExecError, 'wb-state nicht gefunden (~/.local/bin im PATH?).'),
    };
  }
}

export async function probeHarness(id: string): Promise<CliResult> {
  try {
    const stdout = await run('wb-harness-probe', probeHarnessArgs(id), 30_000);
    return { ok: true, message: stdout.trim() || 'OK.' };
  } catch (error) {
    return {
      ok: false,
      message: describeCliError(error as ExecError, 'wb-harness-probe nicht gefunden — noch nicht gebaut?'),
    };
  }
}
