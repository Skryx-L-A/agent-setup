// DER VERTEILER DER SITZUNGSDATEIEN -- ein Leser je Format, wie heute in
// `session_load()` von shell/context-guard (SPEC-V4 6.3 Punkt 3).
//
// DER UNTERSCHIED ZUR KONTEXTWACHE, und er ist der ganze Grund fuer eine zweite
// Liste von Formatnamen: Die Wache sucht in derselben Datei eine TOKENZAHL,
// diese Datei sucht ROLLE UND TEXT. Beides steckt selten in denselben Zeilen und
// bei manchen Harnesses ist genau eines davon gemessen und das andere nicht --
// `crush` etwa traegt seine Tokenzahlen nachgewiesen in `.crush/crush.db`,
// waehrend niemand gemessen hat, ob dieselbe Datenbank Rolle und Text im
// Klartext fuehrt (Registry-Probe vom 11.08.). Deshalb liest die Wache crush und
// diese Ansicht nicht.
//
// WAS HIER STEHT, IST GEMESSEN. Ein Leser wird nur gebaut, wo Rolle und Text an
// einer echten Datei dieser Maschine belegt sind; die Belege stehen je Leser im
// Kopf seiner Funktion. Ein Formatname ohne Leser liefert NICHTS und wird im
// Urteil begruendet (registry.ts) -- er wird nicht geraten, und aus einer
// Dateigroesse wird kein Gespraech geschaetzt.
//
// REIN: keine Datei, kein Netz, kein Kindprozess. Was diese Funktionen bekommen,
// ist Text -- bei den JSONL-Formaten der Dateiinhalt, bei den Datenbanken die
// JSON-Ausgabe von `sqlite3 -readonly -json`. Wer den Text besorgt, steht in
// app/src/main/chatquelle.ts.
import type { ChatNachricht, Rolle } from './typen';

/**
 * Die Formatnamen, fuer die es hier einen Leser gibt. ZWEITE STELLE: dieselben
 * Namen stehen im `format`-Feld der Registry; `shell/tests/test-app-chat.sh`
 * haelt beide gegeneinander, damit kein Leser auf einen Namen wartet, den kein
 * Harness traegt (und kein Harness auf einen Leser, den es nicht gibt).
 */
export const CHAT_FORMATE = [
  'claude-transcript',
  'pi-jsonl',
  'codex-rollout',
  'qwen-chat-jsonl',
  'copilot-sqlite',
] as const;

export type ChatFormat = typeof CHAT_FORMATE[number];

export function leserVorhanden(format: string): boolean {
  return (CHAT_FORMATE as readonly string[]).includes(format);
}

/** Obergrenze je Nachricht. Ein 400-kB-Werkzeugergebnis ist kein Gespraechsbeitrag. */
const MAX_TEXT = 8000;

function kuerzen(t: string): string {
  // Nullbytes fliegen raus, bevor der Text in die Oberflaeche geht: sie kommen
  // aus halb geschriebenen Zeilen und schneiden im DOM den Rest ab.
  const sauber = t.replace(/\u0000/g, '');
  return sauber.length > MAX_TEXT ? `${sauber.slice(0, MAX_TEXT)}\n[…gekuerzt]` : sauber;
}

function zeitAus(w: unknown): number {
  if (typeof w === 'number' && Number.isFinite(w)) return w > 1e12 ? w : w * 1000;
  if (typeof w === 'string') {
    const ms = Date.parse(w);
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

function zeilenJson(roh: string): Record<string, unknown>[] {
  const raus: Record<string, unknown>[] = [];
  for (const z of roh.split('\n')) {
    const t = z.trim();
    if (!t || t[0] !== '{') continue;
    try {
      const d = JSON.parse(t) as unknown;
      if (d && typeof d === 'object' && !Array.isArray(d)) raus.push(d as Record<string, unknown>);
    } catch {
      // Halbe Zeile am Anfang eines Ausschnitts oder eine gerade geschriebene
      // Zeile am Ende: uebergehen, nicht abbrechen. Dieselbe Haltung wie in
      // session_load() der Kontextwache.
    }
  }
  return raus;
}

function schreibe(
  raus: ChatNachricht[],
  rolle: Rolle,
  text: string,
  zeit: number,
  art: ChatNachricht['art'] = 'text',
): void {
  const t = text.trim();
  if (!t) return;
  raus.push({ rolle, text: kuerzen(t), zeit, art });
}

/**
 * claude-transcript -- ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl.
 *
 * GEMESSEN an der eigenen laufenden Sitzung (11.08., 246 Zeilen): jede Zeile
 * traegt `type`; `user` und `assistant` tragen `message`. Bei `user` ist
 * `message.content` eine Zeichenkette ODER eine Liste (Werkzeugergebnisse), bei
 * `assistant` immer eine Liste mit `type` text | thinking | tool_use |
 * tool_result. Die uebrigen Typen (`mode`, `permission-mode`, `ai-title`,
 * `attachment`, `last-prompt`, `bridge-session`, `file-history-snapshot`) sind
 * Buchhaltung und kein Gespraech.
 *
 * FREIGABEDIALOGE stehen NICHT darin: `permission-mode` traegt nur den
 * Gesamtmodus, nie die einzelne Frage (SPEC-V4 6.2). Sie kommen ueber die
 * Bruecke herein, nicht ueber diesen Leser.
 */
function claudeTranscript(roh: string): ChatNachricht[] {
  const raus: ChatNachricht[] = [];
  for (const d of zeilenJson(roh)) {
    const typ = d.type;
    if (typ !== 'user' && typ !== 'assistant') continue;
    const m = (d.message ?? {}) as Record<string, unknown>;
    const zeit = zeitAus(d.timestamp);
    const rolle: Rolle = typ === 'user' ? 'mensch' : 'agent';
    const inhalt = m.content;
    if (typeof inhalt === 'string') {
      schreibe(raus, rolle, inhalt, zeit);
      continue;
    }
    if (!Array.isArray(inhalt)) continue;
    for (const teil of inhalt as Record<string, unknown>[]) {
      if (!teil || typeof teil !== 'object') continue;
      if (teil.type === 'text') schreibe(raus, rolle, String(teil.text ?? ''), zeit);
      else if (teil.type === 'thinking') schreibe(raus, 'agent', String(teil.thinking ?? ''), zeit, 'denken');
      else if (teil.type === 'tool_use') schreibe(raus, 'werkzeug', String(teil.name ?? 'Werkzeug'), zeit, 'werkzeug');
      else if (teil.type === 'tool_result') {
        const c = teil.content;
        const t = typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? (c as Record<string, unknown>[]).map((x) => String(x?.text ?? '')).join('\n')
            : '';
        schreibe(raus, 'werkzeug', t, zeit, 'werkzeug');
      }
    }
  }
  return raus;
}

/**
 * pi-jsonl -- ~/.pi-workers/sessions/<name>/<zeit>_<id>.jsonl.
 *
 * GEMESSEN (11.08., Registry-Probe und hier an einer echten Datei nachgesehen):
 * Zeile 1 `{"type":"session","cwd":…}`, danach je Zug `{"type":"message",
 * "message":{"role":…,"content":[{"type":"text"|"thinking"|"toolCall",…}]}}`.
 */
function piJsonl(roh: string): ChatNachricht[] {
  const raus: ChatNachricht[] = [];
  for (const d of zeilenJson(roh)) {
    if (d.type !== 'message') continue;
    const m = (d.message ?? {}) as Record<string, unknown>;
    const zeit = zeitAus(d.timestamp);
    const rolle: Rolle = m.role === 'user' ? 'mensch' : m.role === 'assistant' ? 'agent' : 'system';
    const inhalt = m.content;
    if (typeof inhalt === 'string') {
      schreibe(raus, rolle, inhalt, zeit);
      continue;
    }
    if (!Array.isArray(inhalt)) continue;
    for (const teil of inhalt as Record<string, unknown>[]) {
      if (!teil || typeof teil !== 'object') continue;
      if (teil.type === 'text') schreibe(raus, rolle, String(teil.text ?? ''), zeit);
      else if (teil.type === 'thinking') schreibe(raus, 'agent', String(teil.text ?? teil.thinking ?? ''), zeit, 'denken');
      else if (teil.type === 'toolCall') schreibe(raus, 'werkzeug', String(teil.name ?? teil.toolName ?? 'Werkzeug'), zeit, 'werkzeug');
    }
  }
  return raus;
}

/**
 * codex-rollout -- ~/.codex/sessions/<jahr>/<monat>/<tag>/rollout-*.jsonl.
 *
 * GEMESSEN an den Rollout-Dateien dieser Maschine (11.08.): das Gespraech steht
 * in `type:"response_item"` mit `payload.type:"message"`, `payload.role`
 * (developer | user | assistant) und `payload.content[]` mit `input_text` bzw.
 * `output_text`. `event_msg` daneben ist die Ereignisspur derselben Zuege
 * (`agent_message`, `token_count`, `web_search_end`) -- sie wird uebergangen,
 * sonst stuende jede Antwort doppelt da.
 *
 * `developer` ist der eingespielte Systemtext (Sandbox-Regeln, AGENTS.md) und
 * kommt als 'system' herein, damit die Ansicht ihn abtrennen kann.
 */
function codexRollout(roh: string): ChatNachricht[] {
  const raus: ChatNachricht[] = [];
  for (const d of zeilenJson(roh)) {
    if (d.type !== 'response_item') continue;
    const p = (d.payload ?? {}) as Record<string, unknown>;
    const zeit = zeitAus(d.timestamp);
    if (p.type === 'reasoning') {
      const zusammen = Array.isArray(p.summary)
        ? (p.summary as Record<string, unknown>[]).map((x) => String(x?.text ?? '')).join('\n')
        : '';
      schreibe(raus, 'agent', zusammen, zeit, 'denken');
      continue;
    }
    if (p.type === 'custom_tool_call') {
      schreibe(raus, 'werkzeug', String(p.name ?? 'Werkzeug'), zeit, 'werkzeug');
      continue;
    }
    if (p.type !== 'message') continue;
    const rolle: Rolle = p.role === 'user' ? 'mensch' : p.role === 'assistant' ? 'agent' : 'system';
    const inhalt = p.content;
    if (typeof inhalt === 'string') {
      schreibe(raus, rolle, inhalt, zeit);
      continue;
    }
    if (!Array.isArray(inhalt)) continue;
    for (const teil of inhalt as Record<string, unknown>[]) {
      if (!teil || typeof teil !== 'object') continue;
      if (teil.type === 'input_text' || teil.type === 'output_text' || teil.type === 'text') {
        schreibe(raus, rolle, String(teil.text ?? ''), zeit);
      }
    }
  }
  return raus;
}

/**
 * qwen-chat-jsonl -- ~/.qwen/projects/<cwd-slug>/chats/<sessionId>.jsonl.
 *
 * GEMESSEN am 11.08. (Registry-Probe, qwen 0.21.8, eigener Socket, eigenes
 * HOME): Zeilen mit `type` user | assistant | system, darin `message.role`
 * (user | model) und `message.parts[].text` im Klartext. Tokenzahlen stehen
 * nicht darin -- deshalb traegt der Eintrag `kontextauslastung` in `zeigtNicht`,
 * und dieser Leser liefert sie auch nicht.
 */
function qwenChatJsonl(roh: string): ChatNachricht[] {
  const raus: ChatNachricht[] = [];
  for (const d of zeilenJson(roh)) {
    const typ = d.type;
    if (typ !== 'user' && typ !== 'assistant' && typ !== 'system') continue;
    const m = (d.message ?? {}) as Record<string, unknown>;
    const zeit = zeitAus(d.timestamp);
    const rollenWort = String(m.role ?? typ);
    const rolle: Rolle = rollenWort === 'user' ? 'mensch' : rollenWort === 'model' || rollenWort === 'assistant' ? 'agent' : 'system';
    const teile = m.parts;
    if (Array.isArray(teile)) {
      for (const teil of teile as Record<string, unknown>[]) {
        if (teil && typeof teil === 'object' && typeof teil.text === 'string') schreibe(raus, rolle, teil.text, zeit);
      }
    } else if (typeof m.content === 'string') {
      schreibe(raus, rolle, m.content, zeit);
    }
  }
  return raus;
}

/**
 * copilot-sqlite -- ~/.copilot/session-store.db, Tabelle `turns`.
 *
 * GEMESSEN am 11.08. an echten Zeilen: `turns` traegt `session_id`,
 * `turn_index`, `user_message`, `assistant_response` und `timestamp`, die
 * Tabelle `sessions` daneben die Spalte `cwd` fuer die Zuordnung. Von allen
 * achtzehn Harnesses ist das das am klarsten mit Rolle und Volltext belegte
 * Protokoll.
 *
 * Der Text, den diese Funktion bekommt, ist die Ausgabe von
 * `sqlite3 -readonly -json` -- eine Liste von Objekten mit genau diesen Spalten.
 * Warum ueber das Werkzeug und nicht ueber eine Bibliothek: die Datei gehoert
 * einem laufenden Prozess, `-readonly` ist die Zusage, dass wir ihr weder
 * Journal noch WAL anlegen (dieselbe Vorsicht wie `mode=ro` in der
 * Kontextwache), und eine zweite Abhaengigkeit im Programm waere dafuer teuer.
 */
function copilotSqlite(roh: string): ChatNachricht[] {
  let zeilen: Record<string, unknown>[];
  try {
    const d = JSON.parse(roh.trim() || '[]') as unknown;
    zeilen = Array.isArray(d) ? (d as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
  const raus: ChatNachricht[] = [];
  for (const z of zeilen) {
    const zeit = zeitAus(z.timestamp);
    schreibe(raus, 'mensch', String(z.user_message ?? ''), zeit);
    schreibe(raus, 'agent', String(z.assistant_response ?? ''), zeit);
  }
  return raus;
}

const VERTEILER: Record<ChatFormat, (roh: string) => ChatNachricht[]> = {
  'claude-transcript': claudeTranscript,
  'pi-jsonl': piJsonl,
  'codex-rollout': codexRollout,
  'qwen-chat-jsonl': qwenChatJsonl,
  'copilot-sqlite': copilotSqlite,
};

/**
 * DIE EINE ABFRAGE. Ein unbekannter Formatname liefert eine leere Liste --
 * dieselbe Haltung wie in der Kontextwache: lieber nichts als etwas Geratenes.
 */
export function nachrichtenAus(format: string, roh: string): ChatNachricht[] {
  const leser = VERTEILER[format as ChatFormat];
  return leser ? leser(roh) : [];
}

/**
 * DER KOPF EINER SITZUNGSDATEI: das Arbeitsverzeichnis, das sie selbst nennt.
 * Ohne diese Angabe ist keine Zuordnung ueber `cwd` moeglich -- und geraten wird
 * sie nicht, ein leeres Feld heisst "diese Datei sagt es nicht".
 *
 * Gemessen an echten Dateien dieser Maschine (11.08.):
 *   claude-transcript  jede Zeile traegt `cwd`; die ERSTEN Zeilen sind
 *                      Buchhaltung ohne cwd, deshalb wird bis zum ersten Treffer
 *                      gesucht statt nur Zeile 1 gelesen.
 *   pi-jsonl           Zeile 1: {"type":"session","cwd":…}
 *   codex-rollout      Zeile 1: {"type":"session_meta","payload":{"cwd":…}}
 *   qwen-chat-jsonl    jede Zeile traegt `cwd` (Registry-Probe vom 11.08.).
 * `copilot-sqlite` steht nicht dabei: dort kommt das Arbeitsverzeichnis aus der
 * Spalte `cwd` der Tabelle `sessions` und nicht aus einer Datei.
 */
export function kopfAus(format: string, roh: string): { cwd: string } {
  if (!leserVorhanden(format)) return { cwd: '' };
  let gelesen = 0;
  for (const d of zeilenJson(roh)) {
    if (++gelesen > 50) break;          // der Kopf steht vorn oder gar nicht
    if (format === 'codex-rollout') {
      const p = (d.payload ?? {}) as Record<string, unknown>;
      if (d.type === 'session_meta' && typeof p.cwd === 'string') return { cwd: p.cwd };
      continue;
    }
    if (typeof d.cwd === 'string' && d.cwd) return { cwd: d.cwd };
  }
  return { cwd: '' };
}
