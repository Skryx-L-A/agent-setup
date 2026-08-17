// DAS AGENT CLIENT PROTOCOL -- und zwar genau so weit, wie es an einem echten
// Harness belegt ist (SPEC-V4 6.3, vierte Anschlussart).
//
// WAS AM 11.08. GEMESSEN WURDE, auf dieser Maschine, mit eigenem HOME und
// eigenem TMPDIR, gegen goose 1.45.0:
//
//   Anfrage   {"jsonrpc":"2.0","id":1,"method":"initialize",
//              "params":{"protocolVersion":1,"clientCapabilities":{…}}}
//   Antwort   {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,
//              "agentCapabilities":{"loadSession":true,
//              "sessionCapabilities":{"list":{},"close":{}},…},
//              "agentInfo":{"name":"goose","version":"1.45.0"}}}
//
//   Anfrage   {"jsonrpc":"2.0","id":2,"method":"session/list","params":{}}
//   Antwort   {"jsonrpc":"2.0","id":2,"result":{"sessions":[]}}
//
// Das ist der ganze Beleg, und deshalb ist das hier der ganze Adapter: Rahmen
// (zeilengetrenntes JSON-RPC), Handschlag, Faehigkeiten, Sitzungsliste.
//
// WAS BEWUSST NICHT GEBAUT IST, weil es an keinem Harness belegt werden konnte:
//
//   * `session/load` als Wiedergabe eines Gespraechs. Die Fassung meldet zwar
//     `loadSession: true`, aber ob ueber diesen Weg das Gespraech eines im PANE
//     laufenden TUI herauskommt, ist NICHT gemessen -- unter einem frischen HOME
//     lieferte `session/list` eine leere Liste, und ein ACP-Agent ist ein
//     EIGENER Prozess neben dem TUI, kein Fenster in dessen Sitzung.
//   * Jede Form von Eingabe (`session/prompt`). Die Eingabe bleibt am Pane, das
//     ist gemessen und zwingend (SPEC-V4 6.2); ein zweiter Weg hinein waere
//     genau der Fehler, den der Abschnitt verbietet.
//
// Keiner der neun ACP-faehigen Harnesses ist heute ueber ACP angebunden, und
// dieser Adapter aendert daran nichts -- er stellt die Naht bereit, an der es
// weitergeht, sobald jemand die fehlende Messung nachholt.
//
// REIN: kein Kindprozess, kein Netz. Diese Datei baut Anfragen und deutet
// Antworten; wer die beiden Roehren haelt, steht anderswo.

export interface AcpAnfrage {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

/** Der Handschlag, wortgleich zu dem, der gemessen wurde. */
export function initialisieren(id: number): AcpAnfrage {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      // Die Werkbank liest, sie stellt dem Agenten kein Dateisystem zur
      // Verfuegung: beide Faehigkeiten stehen auf false, und zwar ausdruecklich.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    },
  };
}

export function sitzungenAbfragen(id: number): AcpAnfrage {
  return { jsonrpc: '2.0', id, method: 'session/list', params: {} };
}

/** Eine Zeile des Stroms wird zu einer Antwort -- oder zu nichts. */
export interface AcpAntwort {
  id: number;
  ergebnis: Record<string, unknown> | null;
  fehler: string;
}

/**
 * ZEILENGETRENNTES JSON-RPC. Wie bei SSE kommt der Strom in Haeppchen an, und
 * die letzte Zeile kann unfertig sein -- deshalb der Rest.
 */
export function antwortenZerlegen(puffer: string): { antworten: AcpAntwort[]; rest: string } {
  const zeilen = puffer.split('\n');
  const rest = zeilen.pop() ?? '';
  const antworten: AcpAntwort[] = [];
  for (const z of zeilen) {
    const t = z.trim();
    if (!t) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof d.id !== 'number') continue;      // Benachrichtigungen ohne id
    const fehler = (d.error ?? null) as Record<string, unknown> | null;
    antworten.push({
      id: d.id,
      ergebnis: (d.result ?? null) as Record<string, unknown> | null,
      fehler: fehler ? String(fehler.message ?? 'Fehler ohne Text') : '',
    });
  }
  return { antworten, rest };
}

export interface AcpAgent {
  name: string;
  version: string;
  protokoll: number;
  /** Kann der Agent eine bestehende Sitzung laden? Gemeldet, nicht geprueft. */
  ladenMoeglich: boolean;
  /** Kann er seine Sitzungen aufzaehlen? Ohne das gibt es keine Zuordnung. */
  auflistenMoeglich: boolean;
}

/** Deutet das Ergebnis von `initialize`. */
export function agentAus(ergebnis: Record<string, unknown> | null): AcpAgent | null {
  if (!ergebnis) return null;
  const faehig = (ergebnis.agentCapabilities ?? {}) as Record<string, unknown>;
  const sitzung = (faehig.sessionCapabilities ?? {}) as Record<string, unknown>;
  const info = (ergebnis.agentInfo ?? {}) as Record<string, unknown>;
  return {
    name: String(info.name ?? ''),
    version: String(info.version ?? ''),
    protokoll: typeof ergebnis.protocolVersion === 'number' ? ergebnis.protocolVersion : 0,
    ladenMoeglich: faehig.loadSession === true,
    auflistenMoeglich: sitzung.list !== undefined,
  };
}

export interface AcpSitzung {
  id: string;
  /** Das Arbeitsverzeichnis, wenn der Agent eines nennt. */
  verzeichnis: string;
}

/**
 * Deutet das Ergebnis von `session/list`. Gemessen ist nur der leere Fall
 * (`{"sessions":[]}`); die Feldnamen einer gefuellten Liste sind daher
 * TOLERANT gelesen und nicht als gemessen ausgegeben -- wer eine echte Liste
 * misst, schreibt sie hier fest.
 */
export function sitzungenAus(ergebnis: Record<string, unknown> | null): AcpSitzung[] {
  if (!ergebnis) return [];
  const liste = Array.isArray(ergebnis.sessions) ? (ergebnis.sessions as Record<string, unknown>[]) : [];
  return liste.map((s) => ({
    id: String(s.sessionId ?? s.id ?? ''),
    verzeichnis: String(s.cwd ?? s.workingDirectory ?? s.directory ?? ''),
  })).filter((s) => s.id);
}

/**
 * Was die Ansicht ueber einen ACP-Agenten sagen kann. Sie sagt bewusst NICHT
 * "geht", solange nur der Handschlag steht: ein Gespraech, das niemand aus dem
 * Pane herausgemessen hat, gibt es fuer diese Ansicht nicht.
 */
export function acpUrteil(agent: AcpAgent | null): { moeglich: boolean; grund: string } {
  if (!agent) return { moeglich: false, grund: 'Der Harness hat auf den ACP-Handschlag nicht geantwortet.' };
  if (!agent.auflistenMoeglich) {
    return { moeglich: false, grund: `${agent.name || 'Der Harness'} kann seine Sitzungen ueber ACP nicht aufzaehlen.` };
  }
  return {
    moeglich: false,
    grund: `${agent.name || 'Der Harness'} spricht ACP (Handschlag und Sitzungsliste gemessen), aber dass darueber das Gespraech eines im Pane laufenden TUI herauskommt, ist an keinem Harness gemessen — deshalb zeichnet die Ansicht daraus nichts.`,
  };
}
