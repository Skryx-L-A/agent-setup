// Read-only info for the "System" section (Nachtrag priority 4): named paths
// (existence + size) and the five launchd jobs CLAUDE.md names. Both are pure
// lookups against the real filesystem/launchctl — no write path, matching the
// same "honest gap over a switch that risks something" stance as hooksInfo.ts.
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PathInfo {
  label: string;
  path: string;
  exists: boolean;
  sizeHuman?: string;
}

export function namedPaths(home: string = homedir()): { label: string; path: string }[] {
  return [
    { label: 'Vault', path: join(home, 'Knowledge') },
    { label: 'Worker-Ergebnisse', path: join(home, '.pi-workers') },
    { label: 'Snapshot-Ordner', path: join(home, '.local', 'trash-snapshots') },
  ];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** `du -sh` can be slow on a large tree — bounded, and a timeout is reported honestly, not left blank. */
function duHuman(path: string, timeoutMs = 8_000): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('du', ['-sh', path], { timeout: timeoutMs }, (err, stdout) => {
      resolve(err ? undefined : stdout.trim().split(/\s+/)[0] || undefined);
    });
  });
}

/** Runs the (up to 8s each) du checks in parallel — a settings panel render must not stack three of them. */
export function collectPathInfo(home: string = homedir()): Promise<PathInfo[]> {
  return Promise.all(namedPaths(home).map(async ({ label, path }) => {
    const exists = await pathExists(path);
    return { label, path, exists, sizeHuman: exists ? await duHuman(path) : undefined };
  }));
}

export interface LaunchdJob {
  label: string;
  loaded: boolean;
  pid?: number;
  lastExit?: number;
}

/** The five jobs CLAUDE.md names under "Automationen (launchd)". */
export const LAUNCHD_LABELS: readonly string[] = [
  'agent-workbench.mcp-basic-memory',
  'agent-workbench.mcp-playwright',
  'agent-workbench.mcp-reaper',
  'agent-workbench.limit-survivor',
  'agent-workbench.<ein eigenes Mailwerkzeug>',
];

/** `launchctl list` prints `PID  LastExitStatus  Label`, one per line, '-' for "not running"/"n/a". */
export function parseLaunchctlList(output: string): Map<string, { pid?: number; lastExit?: number }> {
  const map = new Map<string, { pid?: number; lastExit?: number }>();
  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) {
      continue;
    }
    const [pidStr, exitStr, label] = parts;
    map.set(label, {
      pid: pidStr === '-' ? undefined : Number(pidStr),
      lastExit: exitStr === '-' ? undefined : Number(exitStr),
    });
  }
  return map;
}

export function collectLaunchdJobs(): Promise<LaunchdJob[]> {
  return new Promise((resolve) => {
    execFile('launchctl', ['list'], { timeout: 5_000, maxBuffer: 1 << 20 }, (err, stdout) => {
      const map = err ? new Map<string, { pid?: number; lastExit?: number }>() : parseLaunchctlList(stdout);
      resolve(LAUNCHD_LABELS.map((label) => {
        const entry = map.get(label);
        return { label, loaded: entry !== undefined, pid: entry?.pid, lastExit: entry?.lastExit };
      }));
    });
  });
}
