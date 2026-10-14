/**
 * wb-inbox fuer pi — Nachrichten an eine laufende pi-Sitzung, ohne die Eingabezeile.
 *
 * Installiert von `wb-inbox einrichten pi` nach ~/.pi/agent/extensions/wb-inbox.ts
 * (Quelle: shell/inbox/pi-wb-inbox.ts im Repo claude-workbench). Nicht von Hand aendern.
 *
 * Anlass (der Nutzer, 29.09.2026): "ich will nicht das bei der freigabe automatisch in den
 * pane getippt wird, das kann nachrichten von mir abschneiden oder ungewollt mitsenden"
 * und "der message weg muss für alle harrnesse funktionieren".
 *
 * Das Protokoll ist die gemeinsame Datei-Inbox aus shell/wb-inbox (Abschnitt
 * "DATEI-INBOX"): Diese Erweiterung meldet ihren Prozess unter
 * <inbox>/<pid>.json an (pid, Harness, $TMUX_PANE, $TMUX, Arbeitsverzeichnis, Zustand)
 * und holt jede Datei aus <inbox>/<pid>/neu/ ab. Der Text geht ueber die Erweiterungs-API
 * als Nutzer-Nachricht in die Sitzung:
 *   - untaetig: `sendUserMessage(text)` startet sofort einen Zug (weckt die Sitzung);
 *   - mitten im Zug: `sendUserMessage(text, {deliverAs: "followUp"})` — pi haengt sie
 *     an, und sie kommt an der Zuggrenze an.
 * Danach wandert die Datei nach <inbox>/<pid>/zugestellt/. Die Eingabezeile wird nie
 * beruehrt: was ein Mensch halb getippt hat, bleibt stehen.
 *
 * <inbox> ist $WB_INBOX_DIR, sonst ~/.claude/workbench/inbox. Ohne $TMUX_PANE (pi
 * ausserhalb von tmux) meldet sie sich nicht an: `wb-inbox sende` adressiert ueber den
 * Pane, eine Anmeldung ohne Pane waere unerreichbar.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const BASIS = process.env.WB_INBOX_DIR || path.join(os.homedir(), ".claude", "workbench", "inbox");
const PID = process.pid;
const ANMELDUNG = path.join(BASIS, `${PID}.json`);
const ORDNER = path.join(BASIS, String(PID));
const NEU = path.join(ORDNER, "neu");
const FERTIG = path.join(ORDNER, "zugestellt");

export default function (pi: ExtensionAPI) {
  const pane = process.env.TMUX_PANE || "";
  if (!pane) return;

  let ctx: any = undefined;
  let zustand: "idle" | "busy" = "idle";
  let beobachter: fs.FSWatcher | undefined;
  let takt: ReturnType<typeof setInterval> | undefined;
  let laeuft = false;

  const anmelden = () => {
    const daten = {
      version: 1,
      pid: PID,
      harness: "pi",
      pane,
      tmux: process.env.TMUX || "",
      cwd: process.cwd(),
      status: zustand,
      seit: new Date().toISOString(),
      transcript: ctx?.sessionManager?.getSessionFile?.() || "",
    };
    const tmp = `${ANMELDUNG}.${PID}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(daten) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, ANMELDUNG);
    } catch {
      // Ohne Anmeldung ist die Sitzung nur nicht erreichbar; pi laeuft weiter.
    }
  };

  const abmelden = () => {
    try { beobachter?.close(); } catch {}
    if (takt) clearInterval(takt);
    try { fs.rmSync(ANMELDUNG, { force: true }); } catch {}
    try { fs.rmSync(ORDNER, { recursive: true, force: true }); } catch {}
  };

  const abholen = () => {
    if (laeuft) return;
    laeuft = true;
    try {
      let namen: string[] = [];
      try {
        namen = fs.readdirSync(NEU).filter((n) => n.endsWith(".json")).sort();
      } catch {
        return;
      }
      for (const n of namen) {
        const quelle = path.join(NEU, n);
        let text = "";
        try {
          const d = JSON.parse(fs.readFileSync(quelle, "utf8"));
          text = typeof d?.text === "string" ? d.text : "";
        } catch {
          continue; // halb geschrieben: der Sender benennt erst nach dem Schreiben um
        }
        try { fs.mkdirSync(FERTIG, { recursive: true, mode: 0o700 }); } catch {}
        try {
          fs.renameSync(quelle, path.join(FERTIG, n));
        } catch {
          continue; // schon abgeholt
        }
        if (!text.trim()) continue;
        const untaetig = ctx?.isIdle ? ctx.isIdle() : zustand === "idle";
        if (untaetig) pi.sendUserMessage(text);
        else pi.sendUserMessage(text, { deliverAs: "followUp" });
      }
    } finally {
      laeuft = false;
    }
  };

  pi.on("session_start", async (_ev: any, c: any) => {
    ctx = c;
    try { fs.mkdirSync(NEU, { recursive: true, mode: 0o700 }); } catch {}
    anmelden();
    try {
      beobachter = fs.watch(NEU, () => abholen());
    } catch {
      beobachter = undefined;
    }
    // Rueckfall und Sicherheitsnetz: fs.watch verpasst unter Last einzelne Ereignisse.
    takt = setInterval(abholen, 1000);
    (takt as any).unref?.();
    abholen();
  });

  pi.on("agent_start", async () => {
    zustand = "busy";
    anmelden();
  });

  pi.on("agent_settled", async () => {
    zustand = "idle";
    anmelden();
    abholen();
  });

  pi.on("session_shutdown", async () => abmelden());
  process.on("exit", abmelden);
}
