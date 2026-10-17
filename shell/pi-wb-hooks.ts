/**
 * wb-hooks fuer pi -- Hook-Bruecke der Werkbank (Spur W2b).
 *
 * Gehoert nach ~/.pi/agent/extensions/wb-hooks.ts (Registry pi toolAdapter.hooks.ziel; Quelle:
 * shell/pi-wb-hooks.ts im Repo claude-workbench). Die Extension uebersetzt nichts selbst: sie reicht
 * jedes pi-Ereignis mit seiner nativen Nutzlast an `wb-hook-bruecke pi <natives Ereignis>`
 * ($WB_HOOK_BRUECKE, sonst ~/.local/bin/wb-hook-bruecke). Das Programm bildet nach der Registry
 * (toolAdapter.hooks.bruecke von pi) auf die Claude-Form ab, ruft die Hooks der Quelle und antwortet
 * in Claude-Form (stdout-JSON, Exit 2 = blockiert).
 *
 * ABBILDUNG (Typen: @earendil-works/pi-coding-agent dist/core/extensions/types.d.ts):
 *   tool_call          -> PreToolUse        Ablehnung: {block: true, reason}
 *   tool_result        -> PostToolUse       nur Aufruf
 *   before_agent_start -> UserPromptSubmit  Kontext als Nachricht (customType wb-hooks, nicht angezeigt)
 *   agent_end          -> Stop              nur Aufruf
 *
 * SCHUTZ: Bei tool_call blockiert die Extension, wenn das Programm nicht antwortet (Start gescheitert,
 * Frist, Exit ausser 0/2, Antwort kein JSON) -- fail-closed fuer die Gates. pi selbst blockiert ein
 * Werkzeug, wenn ein tool_call-Handler wirft (docs/extensions.md). Fehlt das Programm ganz (nicht
 * ausgerollt), tut die Extension nichts. Alle anderen Ereignisse laufen fail-open.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function brueckenPfad(): string {
  return process.env.WB_HOOK_BRUECKE || path.join(os.homedir(), ".local", "bin", "wb-hook-bruecke");
}

type Antwort = { block: string | null; kontext: string | null };

function rufen(ereignis: string, gate: boolean, nutzlast: Record<string, unknown>): Antwort {
  const prog = brueckenPfad();
  if (!fs.existsSync(prog)) return { block: null, kontext: null };
  const r = spawnSync(prog, ["pi", ereignis], { input: JSON.stringify(nutzlast), encoding: "utf8", timeout: 60000 });
  if (r.error || r.status === null || (r.status !== 0 && r.status !== 2)) {
    return { block: gate ? "wb-hook-bruecke ohne Antwort (fail-closed)" : null, kontext: null };
  }
  if (r.status === 2) return { block: (r.stderr || "").trim() || "von einem Werkbank-Hook blockiert", kontext: null };
  const aus = (r.stdout || "").trim();
  if (!aus) return { block: null, kontext: null };
  try {
    const o = JSON.parse(aus);
    const h = o?.hookSpecificOutput || {};
    if (o?.decision === "block" || h.permissionDecision === "deny") {
      return { block: String(o.reason || h.permissionDecisionReason || "von einem Werkbank-Hook blockiert"), kontext: null };
    }
    return { block: null, kontext: typeof h.additionalContext === "string" ? h.additionalContext : null };
  } catch {
    return { block: gate ? "wb-hook-bruecke: Antwort ist kein JSON (fail-closed)" : null, kontext: null };
  }
}

export default function (pi: any) {
  const cwd = () => process.cwd();
  const sitzung = (ctx: any) => {
    try {
      return ctx?.sessionManager?.getSessionId?.() ?? null;
    } catch {
      return null;
    }
  };
  pi.on("tool_call", async (ev: any, ctx: any) => {
    const a = rufen("tool_call", true, { toolName: ev.toolName, input: ev.input ?? {}, cwd: cwd(), sessionId: sitzung(ctx) });
    if (a.block !== null) return { block: true, reason: a.block };
    return undefined;
  });
  pi.on("tool_result", async (ev: any, ctx: any) => {
    rufen("tool_result", false, { toolName: ev.toolName, input: ev.input ?? {}, cwd: cwd(), sessionId: sitzung(ctx) });
    return undefined;
  });
  pi.on("before_agent_start", async (ev: any, ctx: any) => {
    const a = rufen("before_agent_start", false, { prompt: ev.prompt ?? "", cwd: cwd(), sessionId: sitzung(ctx) });
    if (a.kontext) return { message: { customType: "wb-hooks", content: a.kontext, display: false } };
    return undefined;
  });
  pi.on("agent_end", async (_ev: any, ctx: any) => {
    rufen("agent_end", false, { cwd: cwd(), sessionId: sitzung(ctx) });
    return undefined;
  });
}
