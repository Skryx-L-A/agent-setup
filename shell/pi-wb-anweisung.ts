/**
 * wb-anweisung fuer pi -- die Erinnerungszeile der Werkbank-Anweisungen je Nachricht.
 *
 * Installiert von `wb-werkzeuge apply pi` nach ~/.pi/agent/extensions/wb-anweisung.ts (Quelle:
 * shell/pi-wb-anweisung.ts im Repo claude-workbench; Registry toolAdapter.anweisungen.erinnerung).
 * Nicht von Hand aendern. Werkzeuge zentral, Spur W2c (der Nutzer 13.10.: Stilregel in jedem Harness).
 *
 * Der Volltext kommt am Sitzungsbeginn aus ~/.pi/agent/AGENTS.md (wb-instructions sync). Diese
 * Erweiterung holt vor jedem Zug die Erinnerungen mit Anlass nachricht ueber
 * `wb-anweisung --anlass nachricht --harness pi erinnerung --sitzung <id>` (Befehl: $WB_ANWEISUNG,
 * sonst PATH). wb-anweisung zaehlt je Sitzungskennung (takt.nachricht.alle) und gibt nur bei jeder
 * N-ten Nachricht Text aus. Beleg pi 0.87.1 (docs/extensions.md, dist/core/extensions/types.d.ts):
 * `before_agent_start` darf `{ message: { customType, content, display } }` zurueckgeben; die
 * Nachricht wird gespeichert und geht mit dem Zug an das Modell, der System-Prompt bleibt
 * unveraendert (Prompt-Cache lokaler Modelle). Sitzungskennung: ctx.sessionManager.getSessionId().
 *
 * Die Erweiterung haelt keinen Zustand und startet nichts beim Laden. Fehlt wb-anweisung, scheitert
 * es oder gilt nichts, bleibt alles wie ohne sie: pi laeuft weiter, es kommt nur keine Erinnerung.
 * Geheimnisse sieht sie nicht.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";

function erinnerungHolen(harness: string, sitzung: string | undefined): string {
  const args = ["--anlass", "nachricht", "--harness", harness, "erinnerung"];
  if (sitzung) args.push("--sitzung", sitzung);
  const r = spawnSync(process.env.WB_ANWEISUNG || "wb-anweisung", args, { encoding: "utf8", timeout: 5000 });
  if (r.error || r.status !== 0) return "";
  return (r.stdout || "").trim();
}

export default function (pi: ExtensionAPI) {
  const harness = process.env.WB_HARNESS || "pi";
  pi.on("before_agent_start", async (_ev: any, ctx: any) => {
    let sitzung: string | undefined;
    try {
      sitzung = ctx?.sessionManager?.getSessionId?.();
    } catch {
      sitzung = undefined;
    }
    const text = erinnerungHolen(harness, sitzung ? String(sitzung) : undefined);
    if (!text) return;
    return { message: { customType: "wb-anweisung", content: text, display: false } };
  });
}
