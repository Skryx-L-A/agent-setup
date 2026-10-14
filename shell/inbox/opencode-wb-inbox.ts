/**
 * wb-inbox fuer opencode — Nachrichten an eine laufende opencode-Sitzung, ohne die
 * Eingabezeile.
 *
 * Installiert von `wb-inbox einrichten opencode` nach ~/.config/opencode/plugin/wb-inbox.ts
 * (Quelle: shell/inbox/opencode-wb-inbox.ts im Repo claude-workbench). Nicht von Hand aendern.
 *
 * Anlass (der Nutzer, 29.09.2026): "ich will nicht das bei der freigabe automatisch in den
 * pane getippt wird" und "der message weg muss für alle harrnesse funktionieren".
 *
 * Protokoll: die gemeinsame Datei-Inbox aus shell/wb-inbox (Abschnitt "DATEI-INBOX").
 * Das Plugin laeuft im opencode-Prozess, meldet ihn unter <inbox>/<pid>.json an und holt
 * jede Datei aus <inbox>/<pid>/neu/ ab. Zugestellt wird ueber den eingebauten Server des
 * Prozesses, nicht ueber die Eingabezeile:
 *   - Ziel ist die Sitzung, in der dieser Prozess zuletzt gearbeitet hat (Ereignisse
 *     session.status / message.updated, nur Hauptsitzungen ohne parentID). Gibt es noch
 *     keine, legt das Plugin eine an und laesst die TUI zu ihr wechseln
 *     (tui.session.select), damit der Mensch sieht, was ankommt.
 *   - Ist die Sitzung beschaeftigt, wartet die Nachricht bis session.idle: sie kommt an
 *     der Zuggrenze an. Ist sie untaetig, startet `session.promptAsync` sofort einen Zug.
 *   - Modell und Agent kommen aus der letzten Nutzer-Nachricht der Sitzung, damit eine
 *     Nachricht nicht still auf ein anderes Modell wechselt (vgl. Harness-Matrix K4).
 *   - Traegt die Sitzung noch keine Nutzer-Nachricht (der Normalfall beim ERSTEN Auftrag
 *     eines frisch gestarteten Workers), gilt das Modell aus $WB_HARNESS_MODEL, das
 *     wb-harness-run aus der aufgeloesten Startzeile setzt. Ohne diese Angabe nahm der
 *     Server sein eigenes Standardmodell: `--model` der TUI erreicht eine per API
 *     angelegte Sitzung nicht (opencode.log 01.10. und 06.10.2026: Sitzung mit
 *     `model=undefined` angelegt, danach `providerID=ollama modelID=ornith:9b`, obwohl
 *     `--model cline-pass/cline-pass/glm-5.3-flash` bestellt war).
 * Danach wandert die Datei nach <inbox>/<pid>/zugestellt/.
 *
 * <inbox> ist $WB_INBOX_DIR, sonst ~/.claude/workbench/inbox. Ohne $TMUX_PANE meldet sich
 * das Plugin nicht an.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const BASIS = process.env.WB_INBOX_DIR || path.join(os.homedir(), ".claude", "workbench", "inbox");
const PID = process.pid;
const ANMELDUNG = path.join(BASIS, `${PID}.json`);
const ORDNER = path.join(BASIS, String(PID));
const NEU = path.join(ORDNER, "neu");
const FERTIG = path.join(ORDNER, "zugestellt");

// Ein Prozess, ein Beobachter: opencode laedt Plugins je Projektinstanz, die Inbox
// gehoert aber dem Prozess.
const g = globalThis as any;

export const WbInbox = async ({ client }: any) => {
  const pane = process.env.TMUX_PANE || "";
  if (!pane || g.__wbInboxAktiv) return {};
  g.__wbInboxAktiv = true;

  let sitzung = "";
  const beschaeftigt = new Set<string>();
  const warteschlange: string[] = [];
  let laeuft = false;

  const anmelden = () => {
    const daten = {
      version: 1,
      pid: PID,
      harness: "opencode",
      pane,
      tmux: process.env.TMUX || "",
      cwd: process.cwd(),
      status: sitzung && beschaeftigt.has(sitzung) ? "busy" : "idle",
      seit: new Date().toISOString(),
      sitzung,
    };
    const tmp = `${ANMELDUNG}.${PID}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(daten) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, ANMELDUNG);
    } catch {}
  };

  const abmelden = () => {
    try { fs.rmSync(ANMELDUNG, { force: true }); } catch {}
    try { fs.rmSync(ORDNER, { recursive: true, force: true }); } catch {}
  };

  // "<provider>/<modell>" -- der Provider endet am ERSTEN Schraegstrich, die Modellkennung
  // darf selbst welche tragen ("cline-pass/cline-pass/glm-5.3-flash").
  const bestellt = (() => {
    const ref = (process.env.WB_HARNESS_MODEL || "").trim();
    const i = ref.indexOf("/");
    return i > 0 && i < ref.length - 1 ? { providerID: ref.slice(0, i), modelID: ref.slice(i + 1) } : undefined;
  })();

  const letztesModell = async (id: string) => {
    try {
      const r = await client.session.messages({ path: { id } });
      const liste: any[] = r?.data ?? [];
      for (let i = liste.length - 1; i >= 0; i--) {
        const info = liste[i]?.info;
        if (info?.role === "user") {
          const m = info.model ?? (info.providerID ? { providerID: info.providerID, modelID: info.modelID } : undefined);
          return { model: m?.providerID && m?.modelID ? m : undefined, agent: info.agent };
        }
      }
    } catch {}
    return { model: undefined, agent: undefined };
  };

  const zustellen = async () => {
    if (laeuft) return;
    laeuft = true;
    try {
      while (warteschlange.length) {
        if (sitzung && beschaeftigt.has(sitzung)) return; // Zuggrenze abwarten
        if (!sitzung) {
          const neu = await client.session.create({ body: {} });
          sitzung = neu?.data?.id ?? "";
          if (!sitzung) return;
          try {
            await client.tui.publish({ body: { type: "tui.session.select", properties: { sessionID: sitzung } } });
          } catch {}
        }
        const text = warteschlange.shift()!;
        const { model, agent } = await letztesModell(sitzung);
        beschaeftigt.add(sitzung);
        anmelden();
        const body: any = { parts: [{ type: "text", text }] };
        if (model) body.model = model;
        else if (bestellt) body.model = bestellt;
        if (agent) body.agent = agent;
        await client.session.promptAsync({ path: { id: sitzung }, body });
      }
    } catch {
      // Beim naechsten Takt erneut; die Datei ist schon abgeholt, der Text steht in der Schlange.
    } finally {
      laeuft = false;
    }
  };

  const abholen = () => {
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
        continue;
      }
      try { fs.mkdirSync(FERTIG, { recursive: true, mode: 0o700 }); } catch {}
      try {
        fs.renameSync(quelle, path.join(FERTIG, n));
      } catch {
        continue;
      }
      if (text.trim()) warteschlange.push(text);
    }
    if (warteschlange.length) void zustellen();
  };

  try { fs.mkdirSync(NEU, { recursive: true, mode: 0o700 }); } catch {}
  anmelden();
  try { fs.watch(NEU, () => abholen()); } catch {}
  const takt = setInterval(abholen, 1000);
  (takt as any).unref?.();
  process.on("exit", abmelden);
  abholen();

  return {
    event: async ({ event }: any) => {
      const p = event?.properties ?? {};
      if (event?.type === "session.status") {
        const id = p.sessionID;
        if (!id) return;
        if (p.status?.type === "busy" || p.status?.type === "retry") beschaeftigt.add(id);
        else beschaeftigt.delete(id);
        if (!sitzung || id === sitzung) anmelden();
        if (id === sitzung && !beschaeftigt.has(id)) void zustellen();
      } else if (event?.type === "session.idle") {
        if (p.sessionID) beschaeftigt.delete(p.sessionID);
        if (p.sessionID === sitzung) {
          anmelden();
          void zustellen();
        }
      } else if (event?.type === "message.updated") {
        const info = p.info;
        if (info?.role === "user" && info.sessionID && info.sessionID !== sitzung) {
          try {
            const s = await client.session.get({ path: { id: info.sessionID } });
            if (!s?.data?.parentID) {
              sitzung = info.sessionID;
              anmelden();
            }
          } catch {}
        }
      }
    },
  };
};
