// DER SERVER NEBEN DEM LAUFENDEN TUI (SPEC-V4 6.3, erste Anschlussart).
//
// GEMESSEN, und das bestimmt den Umfang dieser Datei: ZWEI Harnesses koennen es,
// nicht vier. `opencode` bedient seine HTTP-Schnittstelle, waehrend sein TUI im
// Pane zeichnet (gemessen 11.08. auf eigenem Socket und eigenem HOME), und
// `jcode` haelt einen Unix-Socket im TMPDIR seiner Sitzung. `crush` und `qwen`
// koennen es NACHWEISLICH NICHT: waehrend ihr TUI zeichnete, hielt keiner ihrer
// Prozesse einen lauschenden Port oder Socket (beide am 11.08. nachgemessen).
//
// WAS HIER REIN IST: das Deuten. Der Port wird aus der Ausgabe von `lsof`
// gelesen, die Ereignisse aus dem SSE-Strom, die Nachrichten aus der Antwort
// von `/api/session/{id}/message`. Wer `lsof` startet und wer die Adresse
// abruft, steht in app/src/main/chatquelle.ts -- kein Netz in dieser Datei.
//
// DIE AUFLAGE (SPEC-V4 6.3 Punkt 5) steht im Registry-Eintrag und wird hier
// GEPRUEFT und nicht angenommen: `opencode` meldet beim Start selbst
// "OPENCODE_SERVER_PASSWORD is not set; server is unsecured", und ein offener
// lokaler Server ist eine Fernsteuerung fuer jeden Prozess auf der Maschine.
// `adresseErlaubt()` laesst deshalb nur 127.0.0.1 durch.
import type { ChatNachricht, Rolle } from './typen';

/** Ein Ereignis aus einem SSE-Strom. */
export interface SseEreignis {
  /** Der Wert von `event:`, leer wenn keiner dabeistand. */
  name: string;
  /** Die zusammengesetzten `data:`-Zeilen. */
  daten: string;
}

/**
 * SSE-ZERLEGUNG, stueckweise. Der Strom kommt in Haeppchen an, die mitten in
 * einer Zeile enden koennen -- deshalb gibt diese Funktion den REST zurueck, den
 * der Aufrufer beim naechsten Haeppchen wieder vorne anhaengt.
 *
 * GEMESSEN am eigenen Lauf (11.08., `opencode serve` auf freiem Port):
 *   data: {"id":"evt_…","type":"server.connected","data":{}}
 *   <leerzeile>
 *   : heartbeat
 * Kommentarzeilen (`:` am Anfang) sind der Herzschlag und tragen keine Daten;
 * sie zaehlen trotzdem als Lebenszeichen und werden hier verworfen, nicht
 * gemeldet.
 */
export function sseZerlegen(puffer: string): { ereignisse: SseEreignis[]; rest: string } {
  const ereignisse: SseEreignis[] = [];
  // Ein Ereignis endet an einer Leerzeile. Alles nach der letzten Leerzeile ist
  // unfertig und bleibt Rest.
  const teile = puffer.split(/\r?\n\r?\n/);
  const rest = teile.pop() ?? '';
  for (const block of teile) {
    let name = '';
    const daten: string[] = [];
    for (const zeile of block.split(/\r?\n/)) {
      if (!zeile || zeile.startsWith(':')) continue;
      if (zeile.startsWith('event:')) name = zeile.slice(6).trim();
      else if (zeile.startsWith('data:')) daten.push(zeile.slice(5).replace(/^ /, ''));
    }
    if (name || daten.length) ereignisse.push({ name, daten: daten.join('\n') });
  }
  return { ereignisse, rest };
}

/**
 * Sagt ein Ereignis, dass sich am Gespraech etwas geaendert hat? Gemessen an der
 * Ereignisliste von opencode 1.18.15 (`/doc`, 11.08.): `message.updated`,
 * `message.part.updated`, `message.part.delta`, `session.updated`.
 *
 * Der Strom wird als WECKER benutzt und nicht als Quelle des Textes: was
 * dasteht, wird danach einmal ueber `/api/session/{id}/message` gelesen. Aus
 * Bruchstuecken (`delta`) einen Verlauf zusammenzusetzen hiesse, den Zustand des
 * Servers ein zweites Mal nachzubauen -- und die zweite Fassung liefe
 * auseinander, sobald der Server etwas anders macht als wir denken.
 */
export function ereignisBetrifftGespraech(name: string): boolean {
  return name.startsWith('message.') || name === 'session.updated' || name === 'session.idle';
}

/** Der `type` aus einem SSE-Datenblock, wenn er JSON ist -- sonst leer. */
export function ereignisTyp(daten: string): string {
  try {
    const d = JSON.parse(daten) as Record<string, unknown>;
    return typeof d.type === 'string' ? d.type : '';
  } catch {
    return '';
  }
}

/**
 * PORT AUS `lsof -a -p <pid> -iTCP -sTCP:LISTEN -Fn`. Die Ausgabe ist
 * feldweise, eine Zeile je Feld; uns interessieren die `n`-Zeilen
 * ("127.0.0.1:4603"). Warum ueberhaupt suchen und nicht in der Registry
 * nachschlagen: `opencode serve --port` hat die Vorgabe 0, der Server sucht sich
 * also selbst einen freien Port (am Hilfetext von 1.18.15 belegt). Ein fester
 * Port in der Registry waere eine Zusage, die beim zweiten gleichzeitigen Worker
 * bricht.
 *
 * NUR 127.0.0.1 wird genommen: ein Server, der auf 0.0.0.0 lauscht, ist die
 * Fernsteuerung aus der Auflage, und die Ansicht macht sich nicht zu ihrem
 * ersten Benutzer.
 */
export function portAusLsof(roh: string): number {
  for (const zeile of roh.split('\n')) {
    if (!zeile.startsWith('n')) continue;
    const m = zeile.slice(1).match(/^(?:\[::1\]|127\.0\.0\.1|localhost):(\d+)$/);
    if (m) return Number(m[1]);
  }
  return 0;
}

/** Adressen, die die Ansicht anfassen darf. Alles andere ist ein Fehler, kein Sonderfall. */
export function adresseErlaubt(adresse: string): boolean {
  try {
    const u = new URL(adresse);
    return (u.protocol === 'http:' || u.protocol === 'https:')
      && (u.hostname === '127.0.0.1' || u.hostname === '::1' || u.hostname === 'localhost');
  } catch {
    return false;
  }
}

interface OcSitzung {
  id: string;
  /** Das Arbeitsverzeichnis, das die Sitzung selbst nennt. */
  verzeichnis: string;
  aktualisiert: number;
}

/**
 * Die Sitzungsliste von `GET /api/session`. GEMESSEN am 11.08. gegen opencode
 * 1.18.15: `{"data":[{"id":"ses_…","location":{"directory":"…"},
 * "time":{"created":…,"updated":…},"title":"…"}],"cursor":{…}}`.
 */
export function opencodeSitzungen(roh: string): OcSitzung[] {
  try {
    const d = JSON.parse(roh) as Record<string, unknown>;
    const liste = Array.isArray(d.data) ? (d.data as Record<string, unknown>[]) : [];
    return liste.map((s) => {
      const ort = (s.location ?? {}) as Record<string, unknown>;
      const zeit = (s.time ?? {}) as Record<string, unknown>;
      return {
        id: String(s.id ?? ''),
        verzeichnis: String(ort.directory ?? ''),
        aktualisiert: typeof zeit.updated === 'number' ? zeit.updated : 0,
      };
    }).filter((s) => s.id);
  } catch {
    return [];
  }
}

/**
 * Der Verlauf aus `GET /api/session/{id}/message`. GEMESSEN am 11.08. gegen die
 * OpenAPI-Beschreibung derselben Fassung (`/doc`, Schema `SessionMessage`):
 *   {"type":"user","id":"msg_…","time":{"created":…},"text":"…"}
 *   {"type":"assistant","id":"msg_…","time":{…},"content":[
 *      {"type":"text","id":"…","text":"…"},
 *      {"type":"reasoning","id":"…","text":"…"},
 *      {"type":"tool","id":"…","name":"…"}]}
 *   {"type":"system","id":"msg_…","time":{…},"text":"…"}
 * Die uebrigen Formen (`agent-switched`, `model-switched`, `compaction`,
 * `shell`, `synthetic`) sind Buchhaltung und kein Gespraech.
 */
export function opencodeNachrichten(roh: string): ChatNachricht[] {
  let liste: Record<string, unknown>[];
  try {
    const d = JSON.parse(roh) as Record<string, unknown>;
    liste = Array.isArray(d.data) ? (d.data as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
  const raus: ChatNachricht[] = [];
  const schreibe = (rolle: Rolle, text: unknown, zeit: number, art: ChatNachricht['art'] = 'text'): void => {
    const t = String(text ?? '').trim();
    if (t) raus.push({ rolle, text: t, zeit, art });
  };
  for (const m of liste) {
    const zeitObj = (m.time ?? {}) as Record<string, unknown>;
    const zeit = typeof zeitObj.created === 'number' ? zeitObj.created : 0;
    if (m.type === 'user') schreibe('mensch', m.text, zeit);
    else if (m.type === 'system') schreibe('system', m.text, zeit);
    else if (m.type === 'assistant') {
      const inhalt = Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [];
      for (const teil of inhalt) {
        if (teil?.type === 'text') schreibe('agent', teil.text, zeit);
        else if (teil?.type === 'reasoning') schreibe('agent', teil.text, zeit, 'denken');
        else if (teil?.type === 'tool') schreibe('werkzeug', teil.name, zeit, 'werkzeug');
      }
    }
  }
  return raus;
}

/**
 * Die Sitzungsliste von `jcode debug --socket <TMPDIR>/jcode.sock sessions`.
 * GEMESSEN am 11.08. mit jcode v0.72.0: die Antwort traegt je Sitzung
 * `session_id`, `status`, `is_processing`, `model`, `provider`, `token_usage`
 * und `swarm_id` (das Arbeitsverzeichnis).
 *
 * WAS DAMIT GEHT UND WAS NICHT: Zustand ja, Gespraech nein. In dieser Antwort
 * steht keine einzige Nachricht -- `is_processing` beantwortet die dritte der
 * drei Bruecken-Fragen ("arbeitet das Programm gerade?"), und mehr ist an
 * diesem Kanal nicht gemessen. Ein Leser fuer den Text von jcode waere heute
 * geraten, und geraten wird hier nichts.
 */
export interface JcodeSitzung {
  id: string;
  verzeichnis: string;
  arbeitet: boolean;
  status: string;
}

export function jcodeSitzungen(roh: string): JcodeSitzung[] {
  let liste: Record<string, unknown>[];
  try {
    const d = JSON.parse(roh) as unknown;
    liste = Array.isArray(d)
      ? (d as Record<string, unknown>[])
      : Array.isArray((d as Record<string, unknown>)?.sessions)
        ? ((d as Record<string, unknown>).sessions as Record<string, unknown>[])
        : [];
  } catch {
    return [];
  }
  return liste.map((s) => ({
    id: String(s.session_id ?? ''),
    verzeichnis: String(s.swarm_id ?? ''),
    arbeitet: s.is_processing === true,
    status: String(s.status ?? ''),
  })).filter((s) => s.id);
}
