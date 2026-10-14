/**
 * wb-hooks fuer opencode -- Hooks-Bruecke der Werkbank (Plan werkzeug-plan-2026-10-13, Spur S4).
 *
 * Gehoert nach ~/.config/opencode/plugin/wb-hooks.ts (Quelle: shell/opencode-wb-hooks.ts im Repo
 * claude-workbench). Die Hook-Skripte der Werkbank (~/.claude/hooks/*.sh) sprechen das Claude-Protokoll:
 * ein JSON auf stdin, Exit 2 (oder eine Ablehnung im stdout-JSON) blockiert. Diese Bruecke uebersetzt
 * opencodes Plugin-Ereignisse in dieses Protokoll, damit dieselben Skripte laufen.
 *
 * TABELLE: ~/.config/opencode/wb-hooks.json (oder $WB_HOOKS_TABELLE), Form
 *   {"schema": "wb-hooks/1", "hooks": [{"name": "...", "ereignisse": ["PreToolUse:Write|Edit"],
 *                                        "befehl": "bash ...", "timeout": 10}]}
 * Das sind die Felder des Abschnitts "hooks" in shell/werkzeuge.default.json. Fehlt die Tabelle,
 * tut die Bruecke nichts. Die Datei wird bei jedem Ereignis neu gelesen (klein, kein Neustart noetig).
 *
 * ABBILDUNG (Typen: @opencode-ai/plugin, Hooks-Schnittstelle der installierten Fassung):
 *   PreToolUse        tool.execute.before   Ablehnung wirft einen Fehler: das Werkzeug laeuft nicht
 *   PostToolUse       tool.execute.after    nur Aufruf, Ausgabe ignoriert
 *   UserPromptSubmit  chat.message          nur Aufruf, Ausgabe ignoriert
 *   Stop              event session.idle    nur Aufruf, Ausgabe ignoriert
 * Werkzeugnamen werden auf die Claude-Namen abgebildet (bash -> Bash, edit -> Edit ...), damit die
 * Matcher der Quelle ("Write|Edit", "Read|Grep|Glob", "*") unveraendert gelten.
 *
 * NUR EIN EXPORT: opencode ruft jeden Export einer Plugin-Datei als Plugin auf; Hilfsfunktionen bleiben
 * deshalb unexportiert.
 *
 * FEHLERVERHALTEN wie Claude Code: nur Exit 2 oder eine ausdrueckliche Ablehnung blockiert. Ein
 * Hook, der abstuerzt, die Frist ueberschreitet oder nicht startet, blockiert nichts.
 *
 * NICHT ABGEBILDET (OPEN): Hook-Ausgaben, die Kontext in die Unterhaltung geben (z.B. inbox-einspielen:
 * additionalContext). opencode hat dafuer keinen belegten Weg im PostToolUse/chat.message-Ausgang;
 * die Inbox von opencode laeuft ueber plugin/wb-inbox.ts.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const NAMEN: Record<string, string> = {
  bash: "Bash", edit: "Edit", write: "Write", read: "Read", grep: "Grep", glob: "Glob",
  patch: "Edit", multiedit: "MultiEdit", webfetch: "WebFetch", task: "Task", skill: "Skill",
  todowrite: "TodoWrite", list: "LS",
};

function claudeName(tool: string): string {
  return NAMEN[tool] || (tool ? tool[0].toUpperCase() + tool.slice(1) : tool);
}

function tabellenPfad(): string {
  return process.env.WB_HOOKS_TABELLE || path.join(os.homedir(), ".config", "opencode", "wb-hooks.json");
}

type Hook = { ereignisse: string[]; befehl: string; timeout?: number };

function hooksLesen(): Hook[] {
  try {
    const d = JSON.parse(fs.readFileSync(tabellenPfad(), "utf8"));
    return Array.isArray(d?.hooks) ? d.hooks.filter((h: any) => typeof h?.befehl === "string" && Array.isArray(h?.ereignisse)) : [];
  } catch {
    return [];
  }
}

/** Ereignis "PreToolUse:Write|Edit" passt auf (PreToolUse, Write); ohne Matcher oder mit "*" passt jeder Name. */
function passt(ereignis: string, art: string, tool: string | null): boolean {
  const i = ereignis.indexOf(":");
  const a = i < 0 ? ereignis : ereignis.slice(0, i);
  if (a !== art) return false;
  const m = i < 0 ? "*" : ereignis.slice(i + 1);
  if (m === "*" || m === "" || tool === null) return true;
  return m.split("|").includes(tool);
}

/** Fuehrt die passenden Hooks aus; gibt die Ablehnung (Text) des ersten ablehnenden Hooks zurueck. */
function ausfuehren(art: string, tool: string | null, nutzlast: Record<string, unknown>): string | null {
  for (const h of hooksLesen()) {
    if (!h.ereignisse.some((e) => passt(e, art, tool))) continue;
    const r = spawnSync("bash", ["-c", h.befehl], {
      input: JSON.stringify({ hook_event_name: art, ...nutzlast }),
      encoding: "utf8",
      timeout: Math.max(1, h.timeout || 10) * 1000,
    });
    if (r.error || r.status === null) continue; // nicht gestartet / Frist: blockiert nichts
    if (r.status === 2) return (r.stderr || "").trim() || "von einem Werkbank-Hook blockiert";
    try {
      const o = JSON.parse(r.stdout || "{}");
      if (o?.decision === "block" || o?.hookSpecificOutput?.permissionDecision === "deny") {
        return String(o.reason || o?.hookSpecificOutput?.permissionDecisionReason || "von einem Werkbank-Hook blockiert");
      }
    } catch {
      /* kein JSON: ohne Bedeutung */
    }
  }
  return null;
}

export const WbHooks = async ({ directory }: any) => {
  const cwd = directory || process.cwd();
  return {
    "tool.execute.before": async (input: any, output: any) => {
      const grund = ausfuehren("PreToolUse", claudeName(input.tool), {
        session_id: input.sessionID, cwd, tool_name: claudeName(input.tool), tool_input: output?.args ?? {},
      });
      if (grund !== null) throw new Error(grund);
    },
    "tool.execute.after": async (input: any, output: any) => {
      ausfuehren("PostToolUse", claudeName(input.tool), {
        session_id: input.sessionID, cwd, tool_name: claudeName(input.tool), tool_input: input.args ?? {},
        tool_response: { output: output?.output ?? "" },
      });
    },
    "chat.message": async (input: any, output: any) => {
      const prompt = (output?.parts || []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
      ausfuehren("UserPromptSubmit", null, { session_id: input.sessionID, cwd, prompt });
    },
    event: async ({ event }: any) => {
      if (event?.type === "session.idle") {
        ausfuehren("Stop", null, { session_id: event.properties?.sessionID, cwd });
      }
    },
  };
};
