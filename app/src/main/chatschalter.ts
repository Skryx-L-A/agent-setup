// DER SCHALTER FUER DIE CHAT-ANSICHT im Einstellungsfenster (SPEC-V4 Abschnitt
// 6.3) -- eigene, electron-freie Datei, aus einstellungsfenster.ts
// herausgeloest, damit `chatQuellen` ohne ein Fenster und ohne die echte
// `electron`-Bibliothek gegen die ausgelieferte Registry laufen kann
// (`shell/tests/test-app-chatschalter.sh`). Derselbe Grund wie bei
// `chat/registry.ts` und `main/chatquelle.ts`.
//
// Der `session`-Block wird ROH aus der Registry-Datei gelesen und nicht durch
// `parseModelsRegistry` -- der typisierte Leser kennt das Feld (noch) nicht
// und wuerfe es weg. Fehlt der Block, heisst das "kann es nicht": ein Harness
// ohne gemessenen Weg zum Gespraechsverlauf bekommt keinen Schalter, sondern
// den Grund im Klartext.
export interface ChatQuelle {
  /** 'http-sse' | 'sessionFile' | 'acp' | '' -- leer heisst: kein Weg. */
  via: string;
  /** Warum es nicht geht, im Klartext. Steht dort, wo sonst ein graues Feld waere. */
  grund: string;
  /** Liest die Ansicht mit, waehrend die Sitzung laeuft? */
  live: boolean;
  /** Was die Ansicht NICHT zeigen kann -- Freigabedialoge, Kontextstand, Fortschritt. */
  zeigtNicht: string[];
  /** Messdatum, aus dem Objekt `{datum, beleg}` der Registry gelesen. Ohne
   *  Messdatum zaehlt der Eintrag nicht (SPEC-V4 6.3, Punkt 1). */
  probe: string;
}

/**
 * Alle `session`-Bloecke einer Registry-Datei, gegen SPEC-V4 6.3 gedeutet.
 *
 * Der typisierte Leser (`parseModelsRegistry`) kennt das Feld nicht und wuerfe
 * es weg -- deshalb hier ein eigener, sehr enger Zugriff auf dieselbe Datei.
 * Er baut gegen genau das Schema aus SPEC-V4 6.3 und behandelt JEDE Abweichung
 * wie "kann es nicht": lieber ein Harness ohne Schalter als einer, dessen
 * Schalter auf eine Faehigkeit zeigt, die niemand gemessen hat.
 */
export function chatQuellen(roh: string | undefined): Record<string, ChatQuelle> {
  const raus: Record<string, ChatQuelle> = {};
  if (!roh) return raus;
  let daten: unknown;
  try {
    daten = JSON.parse(roh);
  } catch {
    return raus;
  }
  const liste = (daten as { harnesses?: unknown })?.harnesses;
  if (!Array.isArray(liste)) return raus;
  for (const eintrag of liste) {
    if (!eintrag || typeof eintrag !== 'object') continue;
    const h = eintrag as Record<string, unknown>;
    const id = typeof h.id === 'string' ? h.id : '';
    if (!id) continue;
    const s = h.session;
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
    const o = s as Record<string, unknown>;
    const via = typeof o.via === 'string' ? o.via : '';
    const probeBlock =
      o.probe && typeof o.probe === 'object' && !Array.isArray(o.probe)
        ? (o.probe as Record<string, unknown>)
        : null;
    raus[id] = {
      via: ['http-sse', 'sessionFile', 'acp'].includes(via) ? via : '',
      grund: typeof o.grund === 'string' ? o.grund : '',
      live: o.live === true,
      zeigtNicht: Array.isArray(o.zeigtNicht)
        ? (o.zeigtNicht as unknown[]).filter((x): x is string => typeof x === 'string')
        : [],
      probe: probeBlock && typeof probeBlock.datum === 'string' ? probeBlock.datum : '',
    };
  }
  return raus;
}
