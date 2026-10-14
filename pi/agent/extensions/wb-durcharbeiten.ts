/**
 * wb-durcharbeiten — ein pi-Worker arbeitet seinen Auftrag durch, statt nach einem
 * Text ohne Werkzeugaufruf stehen zu bleiben.
 *
 * Anlass (2026-09-10, der Nutzer): „der qwen worker stoppt immer wieder obwohl keine
 * fehlermeldung da ist und immer wenn ich schreibe das er weitermachen soll dann macht
 * er das auch … der fehler liegt nicht beim modell." Gemessen in der Sitzungsdatei des
 * Workers `stophook`: der Zug endete mit stopReason `stop` und einer Nachricht aus
 * Denken plus Text („Now the shell wrapper (H2) …"), ohne toolCall. pi beendet die
 * Agentenschleife, sobald eine Assistentennachricht keinen Werkzeugaufruf enthält —
 * das ist das Verhalten des Harness, und ein lokales Modell, das seinen nächsten
 * Schritt erst ankündigt und dann auf das nächste Wort wartet, bleibt so stehen. Ein
 * getipptes „weiter" reichte jedes Mal.
 *
 * Was diese Erweiterung tut: Sie merkt sich, ob in dieser Sitzung ein Auftrag nach dem
 * Ergebnis-Protokoll von pi-worker läuft (die Nutzer-Nachricht trägt das Protokoll mit
 * `~/.pi-workers/results/` und der Schlusszeile DONE). Endet danach ein Lauf
 * (`agent_settled`), ohne dass die letzte Assistentennachricht DONE meldet, schickt
 * sie selbst „weiter" als Nutzer-Nachricht. Höchstens ZWOELF Mal hintereinander ohne
 * einen Werkzeugaufruf dazwischen (ein Modell, das zwölfmal nur redet, arbeitet nicht,
 * dann soll der Orchestrator es sehen), und nie, wenn ein Mensch „stop", „halt" oder
 * „warte" getippt hat. Ein Werkzeugaufruf setzt den Zähler zurück. Ohne Auftrag nach
 * dem Protokoll (interaktive Sitzung eines Menschen) tut sie nichts.
 *
 * Sichtbar bleibt jeder Anstoß im Verlauf als Nutzer-Nachricht mit dem Vorspann
 * „[wb-durcharbeiten]", damit niemand ihn für Wort des Nutzers hält.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";

const MAX_OHNE_WERKZEUG = 12;
const PROTOKOLL = ".pi-workers/results/";
const STOPPWORTE = /^\s*(stop|halt|warte|stopp|pause)\b/i;

/**
 * NACHTRAG 2026-09-21, nach einem Befund vom Nutzer: „ich habe gerade versucht
 * den qwen zu stoppen, es geht aber nicht weil sofort ein Wächterprompt zum
 * weiterarbeiten kommt, das darf nicht passieren."
 *
 * Zwei Fehler steckten darin, und beide verletzen dieselbe Hausregel — ein
 * Werkzeug überstimmt nie einen Menschen.
 *
 * ERSTENS kannte diese Erweiterung als Stopp nur ein GETIPPTES Wort. Ein Abbruch
 * per Escape schickt keine Nachricht: der Zug endet, `agent_settled` feuert, die
 * letzte Assistentennachricht hat weder Werkzeugaufruf noch DONE — also stieß sie
 * sofort wieder an. Der Mensch drückte Escape, und das Werkzeug tippte weiter.
 *
 * GEMESSEN statt geraten (21.09., eigene Ereignisprobe in einem Worker-Pane,
 * Protokoll ~/.local/state/wb-ereignisprobe.log): ein abgebrochener Zug liefert
 * ein `message_end` mit `role: "assistant"` und `stopReason: "aborted"`; das
 * Ereignis `agent_end` trägt dazu nichts (nur `type` und `messages`), und ein
 * eigenes Abbruch-Ereignis gibt es nicht. `stopReason` ist also die einzige
 * verlässliche Spur — genau 1,5 ms später stand im Protokoll der Anstoß dieser
 * Erweiterung als Nutzer-Nachricht.
 *
 * ZWEITENS lief sie überhaupt in einer Orchestrator-Sitzung, weil deren
 * Auftragstext zufällig den Pfad `.pi-workers/results/` enthielt. Gedacht war sie
 * für WORKER, die nach dem Ergebnisprotokoll arbeiten. In einem Pane der Rolle
 * `orchestrator` sitzt ein Mensch; dort bleibt sie ab jetzt stumm, außer er
 * schaltet sie ausdrücklich ein (`/durcharbeiten an`).
 */
const ABGEBROCHEN = "aborted";

/** Rolle des eigenen Panes, einmal beim Laden. Fehler heißt „unbekannt", nie „Worker". */
function paneRolle(): string {
  const pane = process.env.TMUX_PANE;
  if (!pane) return "";
  try {
    return execFileSync("tmux", ["show", "-p", "-t", pane, "-v", "@wb_role"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}
const ANSTOSS =
  "[wb-durcharbeiten] Weiter. Du hast den Zug ohne Werkzeugaufruf beendet und der Auftrag " +
  "ist nicht fertig. Arbeite den Auftrag ohne Halt durch: nächster Schritt jetzt ausführen, " +
  "nicht ankündigen. Melde erst mit DONE, wenn die Ergebnisdatei geschrieben ist.";

export default function (pi: ExtensionAPI) {
  let auftragLaeuft = false;
  let anstoesseOhneWerkzeug = 0;
  let menschHatGestoppt = false;
  // In einem Orchestrator-Pane von Anfang an stumm; `/durcharbeiten an` hebt das auf.
  let stummImOrchestrator = paneRolle() === "orchestrator";
  let letzteAssistentin: { text: string; hatteWerkzeug: boolean; done: boolean } | undefined;

  const textAus = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((c: any) => (c && typeof c === "object" && c.type === "text" ? String(c.text ?? "") : ""))
      .join("\n");
  };

  pi.on("message_end", async (ev: any) => {
    const m = ev?.message;
    if (!m) return;
    if (m.role === "user") {
      const t = textAus(m.content);
      if (t.startsWith("[wb-durcharbeiten]")) return; // eigener Anstoß, zählt nicht als Mensch
      if (t.includes(PROTOKOLL)) {
        auftragLaeuft = true;
        anstoesseOhneWerkzeug = 0;
        menschHatGestoppt = false;
      } else if (STOPPWORTE.test(t)) {
        menschHatGestoppt = true;
      } else if (auftragLaeuft) {
        // Ein getipptes „weiter" eines Menschen zählt wie ein eigener Anstoß nicht gegen
        // den Deckel, setzt ihn aber auch nicht zurück.
      }
      return;
    }
    if (m.role === "assistant") {
      const t = textAus(m.content);
      const hatteWerkzeug = Array.isArray(m.content) && m.content.some((c: any) => c?.type === "toolCall");
      const done = /(^|\n)\s*DONE\s*$/.test(t.trimEnd());
      // Ein abgebrochener Zug ist der Wille eines Menschen, kein steckengebliebenes
      // Modell. Ab hier kein Anstoss mehr, bis der Mensch selbst wieder schreibt
      // oder `/durcharbeiten` ruft.
      if (m.stopReason === ABGEBROCHEN) {
        menschHatGestoppt = true;
        letzteAssistentin = { text: t, hatteWerkzeug, done };
        return;
      }
      letzteAssistentin = { text: t, hatteWerkzeug, done };
      if (hatteWerkzeug) anstoesseOhneWerkzeug = 0;
      if (done) auftragLaeuft = false;
    }
  });

  pi.on("agent_settled", async (_ev: any, ctx: any) => {
    if (stummImOrchestrator) return;
    if (!auftragLaeuft || menschHatGestoppt) return;
    if (!ctx.isIdle?.()) return;
    if (ctx.hasPendingMessages?.()) return;
    const a = letzteAssistentin;
    if (!a || a.hatteWerkzeug || a.done) return;
    if (anstoesseOhneWerkzeug >= MAX_OHNE_WERKZEUG) {
      ctx.ui?.notify?.(
        `wb-durcharbeiten: ${MAX_OHNE_WERKZEUG} Anstöße ohne Werkzeugaufruf, Worker steht — Orchestrator ansehen.`,
        "warning",
      );
      return;
    }
    anstoesseOhneWerkzeug += 1;
    pi.sendUserMessage(ANSTOSS);
  });

  pi.registerCommand("durcharbeiten", {
    description:
      "Zeigt den Stand; 'an'/'aus' schaltet die Anstoesse in diesem Pane ein oder aus. Ohne Argument wird ein Stopp zurueckgesetzt.",
    handler: async (args: string, ctx: any) => {
      const wort = (args || "").trim().toLowerCase();
      if (wort === "an") {
        stummImOrchestrator = false;
        menschHatGestoppt = false;
      } else if (wort === "aus") {
        stummImOrchestrator = true;
      } else {
        menschHatGestoppt = false;
      }
      ctx.ui?.notify?.(
        `wb-durcharbeiten: ${stummImOrchestrator ? "STUMM (Orchestrator-Pane; '/durcharbeiten an' schaltet ein)" : "aktiv"}, ` +
          `Auftrag ${auftragLaeuft ? "läuft" : "keiner"}, Anstöße ohne Werkzeug ${anstoesseOhneWerkzeug}/${MAX_OHNE_WERKZEUG}`,
        "info",
      );
    },
  });
}
