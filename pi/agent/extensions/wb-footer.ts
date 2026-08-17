/**
 * wb-footer — workbench footer for local pi agents:
 *   <model> · <cwd> (branch) · ↑in ↓out tokens · ctx-%
 * Set automatically at session start; `/footer` toggles back to the default.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const fmt = (n: number) => (n < 1000 ? `${n}` : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`);

export default function (pi: ExtensionAPI) {
  let enabled = true;

  const apply = (ctx: any) => {
    if (!enabled) { ctx.ui.setFooter(undefined); return; }
    ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      // tokens/sec sampling: compare output-token totals between renders
      let lastT = 0, lastOut = 0, rate = 0;
      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          let input = 0, output = 0;
          let lastUsed = 0;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && e.message.role === "assistant") {
              const m = e.message as AssistantMessage;
              input += m.usage.input;
              output += m.usage.output;
              lastUsed = m.usage.input + m.usage.output;
            }
          }
          const branch = footerData.getGitBranch();
          const home = process.env.HOME ?? "";
          let dir = String(ctx.cwd ?? "").replace(home, "~");
          if (dir.length > 32) dir = "…/" + dir.split("/").slice(-2).join("/");
          if (dir.length > 32) dir = "…/" + dir.split("/").slice(-1).join("/");
          const ctxWin = ctx.model?.contextWindow;

          // same look as the Claude statusline: model · dir branch · ▓▓░░░ tokens
          const left =
            theme.fg("accent", `● ${ctx.model?.id ?? "local"}`) +
            theme.fg("dim", " · ") +
            `${dir}${branch ? " " + branch : ""}`;

          const now = Date.now();
          if (lastT && output > lastOut && now - lastT >= 300) {
            const inst = ((output - lastOut) * 1000) / (now - lastT);
            rate = rate ? rate * 0.6 + inst * 0.4 : inst; // smoothed
          }
          if (output !== lastOut || !lastT) { lastT = now; lastOut = output; }

          let right = theme.fg("dim", `↑${fmt(input)} ↓${fmt(output)}`);
          if (rate >= 1) right += theme.fg("dim", " · ") + theme.fg("accent", `${Math.round(rate)} tok/s`);
          if (ctxWin) {
            const pct = Math.min(100, Math.round((lastUsed / ctxWin) * 100));
            const color = pct >= 85 ? "error" : pct >= 60 ? "warning" : "success";
            const filled = Math.min(10, Math.floor(pct / 10));
            const bar = "▓".repeat(filled) + "░".repeat(10 - filled);
            right += theme.fg("dim", " · ") + theme.fg(color, `${bar} ${fmt(lastUsed)}/${fmt(ctxWin)}`);
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
