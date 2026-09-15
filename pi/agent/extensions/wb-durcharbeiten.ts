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

const MAX_OHNE_WERKZEUG = 12;
const PROTOKOLL = ".pi-workers/results/";
const STOPPWORTE = /^\s*(stop|halt|warte|stopp|pause)\b/i;
const ANSTOSS =
  "[wb-durcharbeiten] Weiter. Du hast den Zug ohne Werkzeugaufruf beendet und der Auftrag " +
  "ist nicht fertig. Arbeite den Auftrag ohne Halt durch: nächster Schritt jetzt ausführen, " +
  "nicht ankündigen. Melde erst mit DONE, wenn die Ergebnisdatei geschrieben ist.";

export default function (pi: ExtensionAPI) {
  let auftragLaeuft = false;
  let anstoesseOhneWerkzeug = 0;
  let menschHatGestoppt = false;
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
      letzteAssistentin = { text: t, hatteWerkzeug, done };
      if (hatteWerkzeug) anstoesseOhneWerkzeug = 0;
      if (done) auftragLaeuft = false;
    }
  });

  pi.on("agent_settled", async (_ev: any, ctx: any) => {
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
    description: "Zeigt, ob wb-durcharbeiten einen Auftrag verfolgt, und setzt den Stopp eines Menschen zurück",
    handler: async (_args: string, ctx: any) => {
      menschHatGestoppt = false;
      ctx.ui?.notify?.(
        `wb-durcharbeiten: Auftrag ${auftragLaeuft ? "läuft" : "keiner"}, Anstöße ohne Werkzeug ${anstoesseOhneWerkzeug}/${MAX_OHNE_WERKZEUG}`,
        "info",
      );
    },
  });
}
