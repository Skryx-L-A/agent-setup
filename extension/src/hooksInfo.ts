// Read-only view of ~/.claude/settings.json's `hooks` section (Nachtrag
// priority 3). Deliberately READ-ONLY: a hook entry is `{matcher?, hooks:
// [{type, command, timeout?}]}` per event, and writing one back safely means
// preserving that exact shape (plus every OTHER top-level key in the same
// file — env, permissions, model, statusLine, enabledPlugins, …) without a
// round-trip test against the real schema. That risk is not worth taking for
// a settings PANEL when `update-config` (the skill built for this file) can
// already do it safely — see the "Hooks toggle" OPEN item in the result.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface HookEntry {
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
  /** True for one of the three hooks CLAUDE.md names explicitly (secrets/kill-pattern/push-gate). */
  isDenyHook: boolean;
  denyHookReason?: string;
}

/**
 * The three deny-hooks CLAUDE.md names explicitly ("Die drei Deny-Hooks
 * (Secrets, Kill-Muster, Push-Gate)... existieren wegen echter Vorfälle") —
 * matched against the real filenames in ~/.claude/hooks/.
 */
const DENY_HOOK_REASON: Record<string, string> = {
  'bash-guard-secrets.sh': 'Verhindert, dass ein Secret im Klartext in einen Bash-Befehl gerät.',
  'bash-guard-kill-pattern.sh': 'Verhindert ein zu breites Kill-Muster (Vorfall 2026-07-25: ein Muster wie "wb-" traf einen laufenden Live-Client).',
  'push-gate-worker.sh': 'Verhindert, dass ein Worker git push/PR/Publish selbst ausführt — das bleibt Orchestrator-Sache.',
};

export function claudeSettingsFile(home: string = homedir()): string {
  return join(home, '.claude', 'settings.json');
}

function denyHookReasonFor(command: string): string | undefined {
  const marker = Object.keys(DENY_HOOK_REASON).find((m) => command.includes(m));
  return marker ? DENY_HOOK_REASON[marker] : undefined;
}

/**
 * Never throws: missing file, broken JSON, a missing/malformed `hooks` key, or
 * one malformed entry inside it all fall back to "skip that entry", same fault
 * tolerance as models.ts/settings.ts.
 */
export function parseHooks(raw: string | undefined): HookEntry[] {
  let data: Record<string, unknown> = {};
  try {
    const parsed = raw === undefined ? undefined : JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // broken JSON — the empty list below is the answer, never an error
  }
  const out: HookEntry[] = [];
  const hooksSection = data.hooks;
  if (typeof hooksSection !== 'object' || hooksSection === null || Array.isArray(hooksSection)) {
    return out;
  }
  for (const [event, groups] of Object.entries(hooksSection as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      continue;
    }
    for (const group of groups) {
      if (typeof group !== 'object' || group === null) {
        continue;
      }
      const g = group as Record<string, unknown>;
      const matcher = typeof g.matcher === 'string' ? g.matcher : undefined;
      if (!Array.isArray(g.hooks)) {
        continue;
      }
      for (const hook of g.hooks) {
        if (typeof hook !== 'object' || hook === null) {
          continue;
        }
        const h = hook as Record<string, unknown>;
        if (typeof h.command !== 'string') {
          continue;
        }
        const denyHookReason = denyHookReasonFor(h.command);
        out.push({
          event,
          matcher,
          command: h.command,
          timeout: typeof h.timeout === 'number' ? h.timeout : undefined,
          isDenyHook: denyHookReason !== undefined,
          denyHookReason,
        });
      }
    }
  }
  return out;
}

export async function readHooks(): Promise<HookEntry[]> {
  try {
    return parseHooks(await readFile(claudeSettingsFile(), 'utf8'));
  } catch {
    return [];
  }
}
