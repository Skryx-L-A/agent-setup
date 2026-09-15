/**
 * wb-footer — workbench footer for local pi agents:
 *   <model> · <cwd> (branch) · ↑in ↓out tokens · N tok/s (prefill Xs) · ctx-%
 * Set automatically at session start; `/footer` toggles back to the default.
 *
 * tok/s is the DECODE rate: output tokens of the last assistant message divided by
 * the time between its first streamed token and its end. The previous footer divided
 * output tokens by wall-clock time between renders, which includes prompt processing
 * and tool execution -- a 27B model that decodes at 23 tok/s showed 3 to 8 tok/s
 * during real work (measured 2026-09-09). Prefill (time to first token) is shown on
 * its own so a slow prompt is visible as what it is. While a message streams, the
 * rate is estimated from streamed characters (about 4 per token) since the first token.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const fmt = (n: number) => (n < 1000 ? `${n}` : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`);

export default function (pi: ExtensionAPI) {
  let enabled = true;

  // Decode-rate bookkeeping per assistant message (see header comment).
  let msgStart = 0;      // message_start of the current assistant message
  let firstTok = 0;      // first streamed text/thinking/toolcall delta
  let streamedChars = 0; // characters streamed so far (live estimate only)
  let streaming = false;
  let last: { rate: number; prefillS: number } | undefined; // finalized last message
  const rateInfo = (): { rate: number; prefillS: number; live: boolean } | undefined => {
    if (streaming && firstTok) {
      const dt = (Date.now() - firstTok) / 1000;
      if (dt < 0.5) return last ? { ...last, live: false } : undefined;
      return { rate: streamedChars / 4 / dt, prefillS: (firstTok - msgStart) / 1000, live: true };
    }
    return last ? { ...last, live: false } : undefined;
  };
  pi.on("message_start", async (ev: any) => {
    if (ev.message?.role !== "assistant") return;
    msgStart = Date.now(); firstTok = 0; streamedChars = 0; streaming = true;
  });
  pi.on("message_update", async (ev: any) => {
    const e = ev.assistantMessageEvent;
    if (!e) return;
    if (e.type === "text_delta" || e.type === "thinking_delta" || e.type === "toolcall_delta") {
      if (!firstTok) firstTok = Date.now();
      streamedChars += (e.delta ?? "").length;
    }
  });
  pi.on("message_end", async (ev: any) => {
    if (ev.message?.role !== "assistant") return;
    streaming = false;
    const out = ev.message.usage?.output ?? 0;
    const end = Date.now();
    const decodeS = firstTok ? (end - firstTok) / 1000 : 0;
    if (out > 0 && decodeS > 0.2) last = { rate: out / decodeS, prefillS: firstTok ? (firstTok - msgStart) / 1000 : 0 };
  });

  const apply = (ctx: any) => {
    if (!enabled) { ctx.ui.setFooter(undefined); return; }
    ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          let input = 0, output = 0;
          let lastUsed = 0;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && e.message.role === "assistant") {
              const m = e.message as AssistantMessage;
              // cacheRead counts too: with a prefix cache (APC on mlx_vlm.server) the
              // provider reports only the uncached part as input, so a 37k conversation
              // showed "1k/131k" in the context bar (seen 2026-09-10 on a real worker).
              const cached = m.usage.cacheRead ?? 0;
              input += m.usage.input + cached;
              output += m.usage.output;
              lastUsed = m.usage.input + cached + m.usage.output;
            }
          }
          const branch = footerData.getGitBranch();
          const home = process.env.HOME ?? "";
          let dir = String(ctx.cwd ?? "").replace(home, "~");
          if (dir.length > 32) dir = "…/" + dir.split("/").slice(-2).join("/");
          if (dir.length > 32) dir = "…/" + dir.split("/").slice(-1).join("/");
          const ctxWin = ctx.model?.contextWindow;

          // same look as the Claude statusline: model · dir branch · ▓▓░░░ tokens
          // Modellkennung nur als Basisname: ein MLX-Pfad wie
          // $HOME/AI/mlx-models/qwen38-27b-mlx-4bit frass in einem 99 Spalten
          // breiten Pane die ganze Zeile, truncateToWidth schnitt rechts den
          // Kontextwert ab, und der Kontext-Guard meldete den Pane als BLIND
          // (gemessen 2026-09-10, Worker stophook). Der Kontextwert steht rechts
          // und ist das, was die Wache liest -- er bleibt, der Pfad weicht.
          const modelId = String(ctx.model?.id ?? "local").split("/").filter(Boolean).pop() ?? "local";
          const leftPlain = (d: string) => `● ${modelId} · ${d}${branch ? " " + branch : ""}`;
          const leftFor = (d: string) =>
            theme.fg("accent", `● ${modelId}`) + theme.fg("dim", " · ") + `${d}${branch ? " " + branch : ""}`;
          let left = leftFor(dir);

          let right = theme.fg("dim", `↑${fmt(input)} ↓${fmt(output)}`);
          const r = rateInfo();
          if (r) {
            right += theme.fg("dim", " · ") + theme.fg("accent", `${Math.round(r.rate)} tok/s`);
            if (r.prefillS >= 1) right += theme.fg("dim", ` (prefill ${r.prefillS.toFixed(0)}s)`);
            if (r.live) right += theme.fg("dim", " ~");
          }
          if (ctxWin) {
            const pct = Math.min(100, Math.round((lastUsed / ctxWin) * 100));
            const color = pct >= 85 ? "error" : pct >= 60 ? "warning" : "success";
            const filled = Math.min(10, Math.floor(pct / 10));
            const bar = "▓".repeat(filled) + "░".repeat(10 - filled);
            right += theme.fg("dim", " · ") + theme.fg(color, `${bar} ${fmt(lastUsed)}/${fmt(ctxWin)}`);
          }
          // Passt es nicht: erst das Verzeichnis kuerzen, dann weglassen; nie den
          // rechten Teil mit dem Kontextwert abschneiden.
          const rightPlain = right.replace(/\x1b\[[0-9;]*m/g, "");
          const need = (d: string) => leftPlain(d).length + 3 + rightPlain.length;
          if (need(dir) > width) {
            const kurz = "…/" + dir.split("/").slice(-1).join("/");
            left = need(kurz) <= width ? leftFor(kurz) : theme.fg("accent", `● ${modelId}`);
          }
          return [truncateToWidth(left + theme.fg("dim", " · ") + right, width)];
        },
      };
    });
  };

  pi.on("session_start", async (_ev: any, ctx: any) => apply(ctx));

  pi.registerCommand("footer", {
    description: "Toggle workbench footer",
    handler: async (_args: any, ctx: any) => {
      enabled = !enabled;
      apply(ctx);
      ctx.ui.notify(enabled ? "Workbench footer on" : "Default footer restored", "info");
    },
  });
}
