/**
 * wb-hub fuer pi — die Werkzeuge des zentralen Hub-Endpunkts als pi-Werkzeuge.
 *
 * Installiert von `wb-hub` nach ~/.pi/agent/extensions/wb-hub.ts (Quelle: shell/pi-wb-hub.ts im
 * Repo claude-workbench). Nicht von Hand aendern. Spur H4 des Hub-Entwurfs (pi: Extension mit
 * pi.registerTool()).
 *
 * Beim Laden fragt die Erweiterung tools/list am Hub ab (http://127.0.0.1:<port>/mcp?harness=pi)
 * und registriert je Werkzeug ein pi-Werkzeug mit demselben Namen (<server>-<tool>), Beschreibung
 * und Schema. Ein Aufruf geht als tools/call an den Hub; ein isError-Ergebnis wird zu einem
 * fehlgeschlagenen Werkzeugergebnis.
 *
 * Port: $WB_HUB_PORT, sonst 8790. Token: $WB_HUB_TOKEN_DATEI, sonst ~/.local/state/wb-hub/token.
 * Ist der Hub nicht erreichbar, registriert die Erweiterung keine Werkzeuge, zeigt eine Zeile
 * Hinweis und laesst pi trotzdem starten. Geheimnisse sieht sie nicht: der Hub liefert nur Ergebnisse.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PORT = Number(process.env.WB_HUB_PORT || 8790);
const TOKEN_DATEI = process.env.WB_HUB_TOKEN_DATEI || path.join(os.homedir(), ".local", "state", "wb-hub", "token");
const ENDPUNKT = `http://127.0.0.1:${PORT}/mcp?harness=pi`;
const PROTOKOLL = "2025-06-18";
const LADEZEIT_MS = 5000;

class HubFehler extends Error {}

let sitzung: string | undefined;
let nummer = 0;

async function post(body: object, sid: string | undefined, signal?: AbortSignal): Promise<Response> {
  const token = fs.readFileSync(TOKEN_DATEI, "utf8").trim();
  const kopf: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "MCP-Protocol-Version": PROTOKOLL,
  };
  if (sid) kopf["Mcp-Session-Id"] = sid;
  return fetch(ENDPUNKT, { method: "POST", headers: kopf, body: JSON.stringify(body), signal });
}

// initialize, dann notifications/initialized; die Sitzungs-Id merkt sich die Erweiterung.
async function sitzungOeffnen(signal?: AbortSignal): Promise<string> {
  const antw = await post({
    jsonrpc: "2.0",
    id: ++nummer,
    method: "initialize",
    params: { protocolVersion: PROTOKOLL, capabilities: {}, clientInfo: { name: "pi-wb-hub", version: "1" } },
  }, undefined, signal);
  const sid = antw.headers.get("Mcp-Session-Id");
  await antw.text();
  if (!antw.ok || !sid) throw new HubFehler(`initialize: HTTP ${antw.status}`);
  (await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sid, signal)).body?.cancel();
  return sid;
}

// Eine Anfrage mit einer Wiederholung: Verliert der Hub die Sitzung (Neustart), 404 -> neu anmelden.
async function anfrage(methode: string, params: unknown, signal?: AbortSignal): Promise<any> {
  for (let versuch = 0; versuch < 2; versuch++) {
    if (!sitzung) sitzung = await sitzungOeffnen(signal);
    const antw = await post({ jsonrpc: "2.0", id: ++nummer, method: methode, params }, sitzung, signal);
    if (antw.status === 404 && versuch === 0) {
      sitzung = undefined;
      await antw.text();
      continue;
    }
    const json: any = await antw.json();
    if (json.error) throw new HubFehler(String(json.error.message));
    if (!antw.ok) throw new HubFehler(`HTTP ${antw.status}`);
    return json.result;
  }
  throw new HubFehler("Sitzung unbekannt");
}

function fehlertext(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default async function (pi: ExtensionAPI) {
  let werkzeuge: any[];
  try {
    const r = await anfrage("tools/list", {}, AbortSignal.timeout(LADEZEIT_MS));
    werkzeuge = Array.isArray(r?.tools) ? r.tools : [];
  } catch (e) {
    const grund = fehlertext(e);
    pi.on("session_start", async (_ev: any, ctx: any) => {
      ctx?.ui?.notify?.(`wb-hub nicht erreichbar, keine Werkbank-Werkzeuge: ${grund}`, "warning");
    });
    return;
  }

  for (const t of werkzeuge) {
    pi.registerTool({
      name: t.name,
      label: t.name,
      description: t.description || t.name,
      parameters: t.inputSchema || { type: "object", properties: {} },
      async execute(_id: string, params: any, signal?: AbortSignal) {
        const r = await anfrage("tools/call", { name: t.name, arguments: params ?? {} }, signal);
        if (r?.isError) {
          const text = (r.content ?? []).map((c: any) => c?.text ?? "").join("\n").trim();
          throw new Error(text || "Hub-Werkzeug meldet einen Fehler");
        }
        return { content: r?.content ?? [], details: undefined };
      },
    });
  }
}
