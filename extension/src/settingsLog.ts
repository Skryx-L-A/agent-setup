// Append-only change log for ~/.claude/workbench/settings.json.
//
// `wb-state settings set` logs every change to ~/.local/state/wb-settings-changes.log;
// the extension writes the settings file directly, so without this its changes
// were invisible there. One unobserved layout switch made four running workers
// invisible to alice (2026-07-25) — the log is the one-second answer to
// "who changed this?", and it must not have a blind spot.
//
// The line format is taken CHARACTER-FOR-CHARACTER from wb-state's python
// section, so `tail` over both sources looks the same:
//
//   <ts>\t<actor>\t<key>\t<old JSON> -> <new JSON>\n
//   ts    = UTC, "%Y-%m-%dT%H:%M:%SZ"
//   old   = the JSON-encoded previous value, or the STRING "<unset>" (quoted!)
//           when the key did not exist — python: cfg.get(key, "<unset>")
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export function changeLogPath(): string {
  return join(homedir(), '.local', 'state', 'wb-settings-changes.log');
}

/** What wb-state logs for a key that had no value yet. */
export const UNSET = '<unset>';

/** UTC timestamp in wb-state's format (no milliseconds, trailing Z). */
export function logTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Actor column. The shell writes the worker name or the pane title, so the
 * extension writes something that names itself as the source and says WHICH
 * window it was: 'extension:<sessionKey>' or 'extension:<folder name>'.
 */
export function extensionActor(sessionKey?: string, folder?: string): string {
  const which = sessionKey ?? (folder ? basename(folder) : undefined);
  return which ? `extension:${which}` : 'extension';
}

export function formatChangeLine(
  timestamp: string,
  actor: string,
  key: string,
  oldValue: unknown,
  newValue: unknown,
): string {
  const before = oldValue === undefined ? UNSET : oldValue;
  return `${timestamp}\t${actor}\t${key}\t${JSON.stringify(before)} -> ${JSON.stringify(newValue)}\n`;
}

/**
 * Keys whose value really changed. A write that sets a value to what it already
 * was produces no line; a write that touches several keys (a model change that
 * clamps its effort, a harness switch) produces one line per changed key.
 */
export function changedKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort();
}

export function changeLines(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  actor: string,
  timestamp: string = logTimestamp(),
): string {
  return changedKeys(before, after)
    .map((key) => formatChangeLine(timestamp, actor, key, before[key], after[key]))
    .join('');
}

/**
 * Appends the change lines. NEVER throws: the settings write has already
 * happened and must stand even when the log cannot be written (permissions,
 * full disk). Returns the error text for the output channel instead.
 */
export async function appendChangeLog(
  lines: string,
  file: string = changeLogPath(),
): Promise<string | undefined> {
  if (lines.length === 0) {
    return undefined;
  }
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, lines, 'utf8');
    return undefined;
  } catch (error) {
    return `Settings-Änderungslog nicht schreibbar (${(error as Error)?.message ?? error})`;
  }
}
