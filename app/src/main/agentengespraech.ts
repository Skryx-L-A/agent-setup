// DAS GESPRAECH UEBER EINEN NEUEN AGENTEN (15.09.2026, Auftrag agentschat).
//
// Der zweite Weg neben dem Formular: Der Mensch schreibt in Alltagssprache, was
// der Agent tun soll, und ein Modell fragt knapp nach, schlaegt Werte vor und
// fuellt dabei denselben Entwurf wie das Formular. Jeder Zug ist ein einzelner
// kopfloser Harness-Aufruf wie der Vorschlag (agentenentwurf.ts): ohne Werkzeuge,
// in einem leeren Ordner, ohne gespeicherte Sitzung.
//
// DER VERLAUF lebt im Kern, je Welt, nur im Speicher (`GespraechSpeicher`), und
// geht als Vorgeschichte in den Prompt jedes Zuges. Ein `--resume` des Harness
// geht nicht: `--no-session-persistence` speichert die Sitzung nicht, und genau
// das soll der Zug (claude --help: „sessions will not be saved to disk and cannot
// be resumed"); Codex laeuft ebenso `--ephemeral`. „Abbrechen", ein neuer Entwurf
// (`neu`) und ein erfolgreiches „Anlegen" verwerfen den Verlauf.
//
// DIE ANTWORT des Modells ist Prosa an den Menschen, danach ein ```json-Block
// `{"entwurf": {<nur geaenderte Felder>}, "fragen": [...], "fertig": false}`. Der
// Kern trennt beides, bringt die Felder auf die Positivliste (`felderAusObjekt`)
// und mischt sie in den Entwurf; was der Mensch selbst gesetzt hat (`vorgaben`),
// gilt vor dem Modell. Geprueft wird danach in der Bibliothek wie bei `welt:entwurf`.
import {
  ENTWURF_FELDER, FIGUR_ANLEITUNG, feldRegeln, felderAusObjekt, freieKennungAus, gesetzterWert,
  type EntwurfWelt, type ModellZeile,
} from './agentenentwurf';

export interface GespraechZug {
  rolle: 'mensch' | 'modell';
  text: string;
  /** Beim Modell: die Felder, die dieser Zug im Entwurf gesetzt hat. */
  felder: string[];
  zeit: string;
  /** Beim Modell: der Pruefbefund der Bibliothek zum Entwurf nach diesem Zug, leer = bestanden. */
  pruefung?: string;
}

/** Wie viele Zuege in den Prompt gehen, wie viele der Speicher haelt, wie lang eine Nachricht sein darf. */
export const GESPRAECH_GRENZEN = { imPrompt: 40, imSpeicher: 200, zeichen: 6000, fragen: 2 };

export const GESPRAECH_SYSTEM = 'Du entwirfst mit einem Menschen im Gespräch einen neuen Agenten. Jede Antwort besteht aus kurzer deutscher Prosa an den Menschen und danach genau einem ```json-Block mit dem Stand des Entwurfs; nach dem Block steht nichts.';

/** Nur die Felder der Positivliste aus einem beliebigen Wert (Entwurf oder Vorgaben der Oberflaeche). */
export function entwurfsFelder(roh: unknown): Record<string, unknown> {
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) return {};
  return Object.fromEntries(Object.entries(roh as Record<string, unknown>).filter(([k]) => (ENTWURF_FELDER as readonly string[]).includes(k)));
}

export function gespraechPrompt(text: string, welt: EntwurfWelt, entwurf: Record<string, unknown>, vorgaben: Record<string, unknown>,
  modelle: ModellZeile[], verlauf: GespraechZug[]): string {
  const teams = welt.teams.length ? welt.teams.map((t) => `${t.name}${t.leiter ? ` (Leiter ${t.leiter})` : ''}`).join(', ') : 'noch keine';
  const liste = modelle.slice(0, 60).map((m) => `${m.kennung} (${m.harness}; ${m.aufgabe})`).join('\n');
  const gesetzt = Object.entries(vorgaben).filter(([k, v]) => gesetzterWert(k, v));
  const frueher = verlauf.slice(-GESPRAECH_GRENZEN.imPrompt);
  const zeilen = frueher.map((z) => (z.rolle === 'mensch'
    ? `Mensch: ${z.text}`
    : `Du: ${z.text}${z.felder.length ? `\n(Im Entwurf gesetzt: ${z.felder.join(', ')})` : ''}${z.pruefung ? `\n(Prüfung der Bibliothek danach: ${z.pruefung})` : ''}`));
  return [
    'Du führst ein Gespräch mit einem Menschen, um einen neuen Agenten für die Agents-Welt einer Werkbank zu entwerfen. Neben dem Gespräch steht das Formular mit dem Entwurf; was du im JSON-Block lieferst, steht danach dort, und der Mensch kann es jederzeit selbst ändern.',
    '',
    `Welt: „${welt.name}“. Hauptagent: ${welt.hauptagent ?? 'noch keiner'}. Teams: ${teams}. Belegte Kennungen: ${welt.agenten.join(', ') || 'keine'}.`,
    '',
    'So führst du das Gespräch:',
    '- Kläre der Reihe nach, was noch fehlt: Zweck, Persönlichkeit (Ton und Arbeitsstil; abgebildet in "specialty" und im Abschnitt "## Arbeitsweise" von "instructions"), Aufgaben, Grenzen ("context_limit", "bash"), Werkzeuge ("tools") und Modellwahl ("model", "fallback_model").',
    `- Höchstens ${GESPRAECH_GRENZEN.fragen} Fragen je Antwort. Knapp und sachlich, ohne Einleitung, ohne Lob, ohne Wiederholung dessen, was im Entwurf schon steht.`,
    '- Schlage konkrete Werte vor, statt nur zu fragen, und trage sie gleich in den Entwurf ein; der Mensch korrigiert, was nicht passt.',
    '- Nutze keine Pronomen für den neuen Agenten und für andere Agenten, auch nicht in der Prosa; nenne sie mit Stufe und Kennung.',
    '- Änderst du "tools", liefere "bash" im selben Block mit, und umgekehrt: Bash braucht mindestens ein Muster, Muster brauchen Bash.',
    '- Steht unter deinem letzten Zug ein Prüfbefund der Bibliothek, behebe ihn im nächsten Block oder sag, was der Mensch dafür entscheiden muss.',
    '- Werte, die der Mensch selbst festgelegt hat, änderst du nicht. Will der Mensch im Gespräch etwas anderes, sag in der Prosa, dass es im Formular zu ändern ist.',
    '- Stehen Kennung, Stufe, Team (wo nötig), Spezialgebiet, Modell, Werkzeuge, Grenzen und Figur und bleibt keine offene Frage, schreibe die Anweisungsdatei in "instructions", sag in einem Satz, dass der Entwurf aus deiner Sicht vollständig ist und mit „Anlegen“ angelegt werden kann, und setze "fertig": true. Vorher bleibt "instructions" leer, außer der Mensch verlangt sie.',
    '',
    'Antwortform: zuerst die Prosa an den Menschen (höchstens etwa 120 Wörter), dann genau dieser Block und nichts danach:',
    '```json',
    '{"entwurf": {<nur die Felder, die sich in diesem Zug ändern>}, "fragen": ["<offene Frage>"], "fertig": false}',
    '```',
    '',
    'Felder in "entwurf" (keine anderen):',
    ...feldRegeln('das Gespräch'),
    '',
    FIGUR_ANLEITUNG,
    '',
    'Modellliste (Kennung, Harness, Aufgabe):',
    liste,
    '',
    `Aktueller Entwurf im Formular: ${JSON.stringify(entwurf)}`,
    gesetzt.length ? `Vom Menschen selbst festgelegt (unverändert lassen): ${JSON.stringify(Object.fromEntries(gesetzt))}` : 'Der Mensch hat im Formular noch nichts selbst festgelegt.',
    '',
    frueher.length ? 'Bisheriges Gespräch:' : 'Das Gespräch beginnt mit dieser Nachricht.',
    ...(verlauf.length > frueher.length ? ['(Frühere Züge sind gekürzt; ihr Stand steht im Entwurf oben.)'] : []),
    ...zeilen,
    ...(frueher.length ? [''] : []),
    'Neue Nachricht des Menschen:',
    text.trim(),
  ].join('\n');
}

/**
 * Prosa und JSON-Block trennen. Genommen wird der letzte ```-Block, der ein Objekt
 * ist; ohne Zaun ein Objekt am Ende des Textes. Ohne Block bleibt alles Prosa.
 */
export function antwortTrennen(text: string): { prosa: string; block: Record<string, unknown> | null } {
  const objekt = (roh: string): Record<string, unknown> | null => {
    try {
      const j = JSON.parse(roh) as unknown;
      return j && typeof j === 'object' && !Array.isArray(j) ? j as Record<string, unknown> : null;
    } catch {
      return null;
    }
  };
  const zaeune = [...text.matchAll(/```[a-zA-Z]*[ \t]*\n?([\s\S]*?)```/g)];
  for (const z of zaeune.reverse()) {
    const j = objekt(z[1].trim());
    if (j) {
      const prosa = `${text.slice(0, z.index)}${text.slice((z.index ?? 0) + z[0].length)}`.trim();
      return { prosa, block: j };
    }
  }
  const ende = text.lastIndexOf('}');
  if (ende >= 0 && !text.slice(ende + 1).trim()) {
    for (let i = text.indexOf('{'); i >= 0 && i < ende; i = text.indexOf('{', i + 1)) {
      const j = objekt(text.slice(i, ende + 1));
      if (j) return { prosa: text.slice(0, i).trim(), block: j };
    }
  }
  return { prosa: text.trim(), block: null };
}

/** Der Block des Modells: Teilstand des Entwurfs, offene Fragen (hoechstens zwei), fertig. Ein flacher Block gilt als Entwurf. */
export function blockLesen(block: Record<string, unknown>): { teil: Record<string, unknown>; fragen: string[]; fertig: boolean } {
  const innen = block.entwurf && typeof block.entwurf === 'object' && !Array.isArray(block.entwurf) ? block.entwurf as Record<string, unknown> : block;
  const fragen = Array.isArray(block.fragen)
    ? block.fragen.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()).slice(0, GESPRAECH_GRENZEN.fragen)
    : [];
  return { teil: felderAusObjekt(innen), fragen, fertig: block.fertig === true };
}

/**
 * Den Teilstand des Modells in den Entwurf mischen. Vorgaben des Menschen gelten
 * vor dem Modell; eine belegte Kennung wird abgewandelt; ein Modell mit Suffix
 * ohne eigene Denkstufe bringt die Stufe mit. `felder` nennt, was sich geaendert hat.
 */
export function gespraechMischen(basis: Record<string, unknown>, teil: Record<string, unknown>, vorgaben: Record<string, unknown>,
  belegt: string[]): { entwurf: Record<string, unknown>; felder: string[] } {
  const entwurf = entwurfsFelder(basis);
  const neu = { ...teil };
  for (const [modell, stufe] of [['model', 'effort'], ['fallback_model', 'fallback_effort']] as const) {
    const m = neu[modell];
    if (typeof m === 'string' && m.includes(':') && neu[stufe] === undefined) neu[stufe] = m.split(':')[1];
  }
  if (typeof neu.id === 'string') neu.id = freieKennungAus(neu.id, belegt);
  const felder: string[] = [];
  for (const [k, v] of Object.entries(neu)) {
    if (gesetzterWert(k, vorgaben[k])) continue;
    if (JSON.stringify(entwurf[k]) === JSON.stringify(v)) continue;
    entwurf[k] = v;
    felder.push(k);
  }
  for (const [k, v] of Object.entries(vorgaben)) if (gesetzterWert(k, v)) entwurf[k] = v;
  return { entwurf, felder };
}

/** Die Verlaeufe je Welt, nur im Speicher des Kerns; je Welt laeuft hoechstens ein Zug. */
export class GespraechSpeicher {
  private verlaeufe = new Map<string, GespraechZug[]>();
  private laufend = new Set<string>();

  verlauf(welt: string): GespraechZug[] {
    return [...(this.verlaeufe.get(welt) ?? [])];
  }

  verwerfen(welt: string): void {
    this.verlaeufe.delete(welt);
  }

  anhaengen(welt: string, ...zuege: GespraechZug[]): void {
    this.verlaeufe.set(welt, [...(this.verlaeufe.get(welt) ?? []), ...zuege].slice(-GESPRAECH_GRENZEN.imSpeicher));
  }

  /** false, wenn in dieser Welt schon ein Zug laeuft. */
  beginnen(welt: string): boolean {
    if (this.laufend.has(welt)) return false;
    this.laufend.add(welt);
    return true;
  }

  beenden(welt: string): void {
    this.laufend.delete(welt);
  }
}
