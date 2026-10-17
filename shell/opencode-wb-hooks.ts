/**
 * wb-hooks fuer opencode -- Hooks-Bruecke der Werkbank (Plan werkzeug-plan-2026-10-13, Spur S4).
 *
 * Gehoert nach ~/.config/opencode/plugin/wb-hooks.ts (Quelle: shell/opencode-wb-hooks.ts im Repo
 * claude-workbench). Die Hook-Skripte der Werkbank (~/.claude/hooks/*.sh) sprechen das Claude-Protokoll:
 * ein JSON auf stdin, Exit 2 (oder eine Ablehnung im stdout-JSON) blockiert. Diese Bruecke uebersetzt
 * opencodes Plugin-Ereignisse in dieses Protokoll, damit dieselben Skripte laufen.
 *
 * QUELLE-HOOKS (W2b, 14.10.): Ohne Tabelle ruft die Bruecke je Ereignis `wb-hook-bruecke opencode <Ereignis>`
 * ($WB_HOOK_BRUECKE, sonst ~/.local/bin/wb-hook-bruecke) mit der Claude-Nutzlast. Das Programm liest die
 * Hooks der Quelle (shell/werkzeuge.default.json) selbst; ein neuer Quell-Hook wirkt ohne neues Ausrollen.
 * Zuordnung (Werkzeugnamen) steht in der Registry toolAdapter.hooks.bruecke von opencode. Antwortet das
 * Programm bei PreToolUse nicht (Start gescheitert, Frist, Exit ausser 0/2), BLOCKIERT die Bruecke
 * (fail-closed: die Gates ergebnis-beleg-gate, reviewer-sperre, testschutz-gate duerfen nicht still
 * entfallen); bei den uebrigen Ereignissen laeuft opencode weiter. Fehlt das Programm ganz (nicht
 * ausgerollt), tut die Bruecke nichts, wie ein Claude-Hook, dessen Skript fehlt.
 *
 * TABELLE (alter Weg, nur wenn $WB_HOOKS_TABELLE gesetzt ist oder ~/.config/opencode/wb-hooks.json existiert):
 * ~/.config/opencode/wb-hooks.json (oder $WB_HOOKS_TABELLE), Form
 *   {"schema": "wb-hooks/1", "hooks": [{"name": "...", "ereignisse": ["PreToolUse:Write|Edit"],
 *                                        "befehl": "bash ...", "timeout": 10}]}
 * Das sind die Felder des Abschnitts "hooks" in shell/werkzeuge.default.json. Fehlt die Tabelle,
 * tut die Bruecke nichts. Die Datei wird bei jedem Ereignis neu gelesen (klein, kein Neustart noetig).
 *
 * ABBILDUNG (Typen: @opencode-ai/plugin, Hooks-Schnittstelle der installierten Fassung):
 *   PreToolUse        tool.execute.before   Ablehnung wirft einen Fehler: das Werkzeug laeuft nicht
 *   PostToolUse       tool.execute.after    nur Aufruf, Ausgabe ignoriert
 *   UserPromptSubmit  chat.message          nur Aufruf, Ausgabe ignoriert (dazu die Erinnerung, unten)
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
 * ANWEISUNGEN (Werkzeug-Quelle, Abschnitt anweisungen; zuerst die Stilregel kurz-und-knackig, der Nutzer
 * 13.10.): Bei jeder Nutzernachricht (chat.message) holt die Bruecke die Erinnerungen mit Anlass nachricht
 * ueber `wb-anweisung --anlass nachricht --harness opencode erinnerung` (Befehl: $WB_ANWEISUNG, sonst
 * PATH) und haengt sie als eigenen Textteil (synthetic) an `output.parts` DIESER Nachricht an, nicht an
 * den System-Prompt: der bleibt Byte fuer Byte gleich, der Prompt-Cache lokaler Modelle haelt (Review
 * wz-integ2, M2). Beleg installierte Fassung (opencode 1.19.0, Binary; Typen @opencode-ai/plugin 1.18.9
 * index.d.ts:187-199): SessionPrompt ruft trigger("chat.message", {sessionID,...}, {message, parts})
 * und speichert danach jedes Element von `parts` (updatePart); IDs vergibt es VOR dem Hook
 * (`id: Y.id ? make(Y.id) : ascending()`), ein angehaengter Teil bringt seine ID deshalb selbst mit.
 * Der Takt (takt.nachricht.alle) zaehlt je Sitzung: input.sessionID geht als --sitzung an wb-anweisung,
 * das in ~/.local/state/wb-anweisung/takt.json je Kennung zaehlt. Die Bruecke selbst haelt keinen
 * Zustand, ein opencode-Prozess mit mehreren Sitzungen vermischt also nichts. Der Volltext kommt am
 * Sitzungsbeginn ueber AGENTS.md (wb-instructions). Fehlt wb-anweisung, bleibt alles wie bisher.
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

function tabellenModus(): boolean {
  return !!process.env.WB_HOOKS_TABELLE || fs.existsSync(tabellenPfad());
}

function brueckenPfad(): string {
  return process.env.WB_HOOK_BRUECKE || path.join(os.homedir(), ".local", "bin", "wb-hook-bruecke");
}

/** Quelle-Hooks ueber wb-hook-bruecke; Ablehnung als Text oder null. Fail-closed nur fuer PreToolUse. */
function ueberBruecke(art: string, nutzlast: Record<string, unknown>): string | null {
  const prog = brueckenPfad();
  if (!fs.existsSync(prog)) return null;
  const r = spawnSync(prog, ["opencode", art], {
    input: JSON.stringify({ hook_event_name: art, ...nutzlast }), encoding: "utf8", timeout: 60000,
  });
  const gate = art === "PreToolUse";
  if (r.error || r.status === null || (r.status !== 0 && r.status !== 2)) {
    return gate ? "wb-hook-bruecke ohne Antwort (fail-closed)" : null;
  }
  if (r.status === 2) return (r.stderr || "").trim() || "von einem Werkbank-Hook blockiert";
  try {
    const o = JSON.parse(r.stdout || "{}");
    if (o?.decision === "block" || o?.hookSpecificOutput?.permissionDecision === "deny") {
      return String(o.reason || o?.hookSpecificOutput?.permissionDecisionReason || "von einem Werkbank-Hook blockiert");
    }
  } catch {
    if (gate && (r.stdout || "").trim()) return "wb-hook-bruecke: Antwort ist kein JSON (fail-closed)";
  }
  return null;
}

/** Fuehrt die passenden Hooks aus; gibt die Ablehnung (Text) des ersten ablehnenden Hooks zurueck. */
function ausfuehren(art: string, nativ: string | null, roh: Record<string, unknown>): string | null {
  // Bruecke: nativer Werkzeugname, die Abbildung steht in der Registry (toolAdapter.hooks.bruecke.werkzeuge).
  if (!tabellenModus()) return ueberBruecke(art, nativ === null ? roh : { ...roh, tool_name: nativ });
  const tool = nativ === null ? null : claudeName(nativ);
  const nutzlast = tool === null ? roh : { ...roh, tool_name: tool };
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

/** Erinnerungszeilen der Anweisungen mit Anlass nachricht; leer, wenn wb-anweisung fehlt oder nichts gilt. */
function erinnerungHolen(sitzung: string | undefined): string {
  const args = ["--anlass", "nachricht", "--harness", "opencode", "erinnerung"];
  if (sitzung) args.push("--sitzung", String(sitzung));
  const r = spawnSync(process.env.WB_ANWEISUNG || "wb-anweisung", args, { encoding: "utf8", timeout: 5000 });
  if (r.error || r.status !== 0) return "";
  return (r.stdout || "").trim();
}

let teilZaehler = 0;

/** Teil-ID in opencodes Form (prt_ + 12 Hex Zeit + 14 Zeichen Zufall), aufsteigend nach den vorhandenen. */
function teilId(): string {
  const zeit = (BigInt(Date.now()) * 0x1000n + BigInt(teilZaehler++ & 0xfff)).toString(16).padStart(12, "0").slice(-12);
  const z = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let r = "";
  for (let i = 0; i < 14; i++) r += z[Math.floor(Math.random() * z.length)];
  return "prt_" + zeit + r;
}

export const WbHooks = async ({ directory }: any) => {
  const cwd = directory || process.cwd();
  return {
    "tool.execute.before": async (input: any, output: any) => {
      const grund = ausfuehren("PreToolUse", input.tool, {
        session_id: input.sessionID, cwd, tool_input: output?.args ?? {},
      });
      if (grund !== null) throw new Error(grund);
    },
    "tool.execute.after": async (input: any, output: any) => {
      ausfuehren("PostToolUse", input.tool, {
        session_id: input.sessionID, cwd, tool_input: input.args ?? {},
        tool_response: { output: output?.output ?? "" },
      });
    },
    "chat.message": async (input: any, output: any) => {
      const prompt = (output?.parts || []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
      const erinnerung = erinnerungHolen(input.sessionID);
      if (erinnerung && Array.isArray(output?.parts)) {
        output.parts.push({
          id: teilId(), sessionID: input.sessionID, messageID: output.message?.id ?? input.messageID,
          type: "text", text: erinnerung, synthetic: true,
        });
      }
      ausfuehren("UserPromptSubmit", null, { session_id: input.sessionID, cwd, prompt });
    },
    event: async ({ event }: any) => {
      if (event?.type === "session.idle") {
        ausfuehren("Stop", null, { session_id: event.properties?.sessionID, cwd });
      }
    },
  };
};
