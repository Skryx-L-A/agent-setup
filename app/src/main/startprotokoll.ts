// Warum eine Sitzung NICHT gestartet ist -- und wie diese Antwort aus dem
// Terminal in ein Fenster kommt.
//
// DER ANLASS (21.08.2026). alice waehlte im Plus-Menue eine Sitzung mit
// qwen38-27b, pi und 256k Kontext. Sie startete nie; das Fenster zeigte
// "Stopped" und sonst nichts. Die Begruendung gab es die ganze Zeit, sie war
// nur nirgends zu sehen -- `wb-code` hatte sie vollstaendig auf stderr
// geschrieben:
//
//     NEIN — 33,9 GiB Spitze angefragt, nur 21,4 GiB verfuegbar, nichts eingetragen.
//     wb-mlx-server: wb-belegung lehnt die Belegung ab — kein Start.
//     wb-code: 'wb-mlx-server ensure' fuer Kontext 131072 fehlgeschlagen — kein Start.
//
// und `sessionAnlegen` startete das Werkzeug mit `stdio: 'ignore'`. Ein
// Fehlschlag, der wie ein Zustand aussieht: wer nicht sieht, WARUM nichts
// passiert, sucht an der falschen Stelle, und genau das ist an diesem Abend
// passiert.
//
// WORAN "NICHT GESTARTET" ERKANNT WIRD, und warum nicht am Exit-Code: `wb-code`
// endet mit `exec tmux attach`. Ohne Terminal scheitert dieser letzte Schritt
// immer -- ein GELUNGENER Start aus der Oberflaeche heraus liefert deshalb
// genauso einen Exit-Code ungleich null wie ein misslungener. Der Unterschied
// liegt woanders: ob die tmux-Sitzung entstanden ist. `wb-code` sagt das jetzt
// selbst, mit einer Zeile unmittelbar vor dem Anhaengen (MARKE unten). Steht sie
// im Protokoll, stand die Sitzung; fehlt sie, ist es unterwegs gescheitert.
//
// GELESEN WIRD DIE GANZE AUSGABE, nicht nur die letzte Zeile: der Grund steht
// oft mehrere Zeilen ueber der Abbruchmeldung (die Zahlen der Buchung), und
// genau die will man sehen.

/**
 * Die Zeile, mit der `wb-code` meldet, dass seine tmux-Sitzung steht. Sie wird
 * unmittelbar vor dem Anhaengen geschrieben, also auf JEDEM erfolgreichen Weg --
 * beim frischen Start wie beim Anhaengen an eine schon laufende Sitzung.
 */
export const SITZUNG_STEHT = 'wb-code: SITZUNG-STEHT';

/** Zeilen, die nichts erklaeren und in einer Meldung nur Platz kosten. */
const RAUSCHEN = [
  /^\s*$/,
  /^\s*Offene Belegungen:/,
  /^\s*Ollama-Ladungen/,
  /^\s*\(keine Ladung gemeldet\)/,
];

/** Zeilen, die den Grund tragen. Die erste Liste gewinnt, wenn sie etwas findet. */
const GRUNDZEILEN = [
  /^\s*(JA|NEIN)\s+—/,
  /^\s*Spitze\s/,
  /^\s*KV-Cache\s/,
  /^\s*Prompt-Cache\s/,
  /^\s*Frei\s/,
  /^\s*Grenze [AB]\s/,
  /^\s*Verfuegbar\s/,
  /^\s*WIDERSPRUCH\s/,
  /kein Start/,
  /fehlgeschlagen/,
  /nicht gefunden/,
  /abgelehnt/,
  /^\s*Sprich den Halter an/,
  /^\s*Niemand haelt etwas/,
  /^\s*Im Buch haelt niemand etwas/,
];

export interface StartBefund {
  /** Ist die tmux-Sitzung entstanden? */
  gestartet: boolean;
  /** Der Grund im Klartext, mehrzeilig. Leer, wenn es keinen gibt. */
  grund: string;
}

/**
 * Das Protokoll eines `wb-code`-Aufrufs auswerten.
 *
 * `hoechstens` begrenzt die Zeilenzahl des Grundes -- eine Meldung im Fenster
 * soll lesbar bleiben. Was weggelassen wurde, steht weiter in der Protokolldatei,
 * und deren Pfad nennt der Aufrufer dazu.
 */
export function startBefund(protokoll: string, hoechstens = 14): StartBefund {
  const text = protokoll ?? '';
  if (text.includes(SITZUNG_STEHT)) return { gestartet: true, grund: '' };

  const zeilen = text.split('\n').filter((z) => !RAUSCHEN.some((r) => r.test(z)));
  const treffer = zeilen.filter((z) => GRUNDZEILEN.some((r) => r.test(z)));
  // Findet die Auswahl nichts, ist der Fehler einer, den hier niemand
  // vorhergesehen hat -- dann sind die letzten Zeilen die beste Auskunft, die es
  // gibt. Eine leere Meldung waere genau der Zustand, gegen den diese Datei
  // gebaut ist.
  const auswahl = (treffer.length ? treffer : zeilen).slice(-hoechstens);
  return { gestartet: false, grund: auswahl.map((z) => z.replace(/\s+$/, '')).join('\n').trim() };
}

/**
 * Ein Satz fuer die Statuszeile, aus dem Grund gebaut. Die erste Zeile, die eine
 * Zahl oder ein Urteil traegt, ist fast immer die, die man sehen will.
 */
export function kurzfassung(grund: string): string {
  const zeilen = grund.split('\n').map((z) => z.trim()).filter(Boolean);
  const nein = zeilen.find((z) => /^(JA|NEIN)\s+—/.test(z));
  if (nein) return nein;
  const start = zeilen.find((z) => /kein Start|fehlgeschlagen/.test(z));
  return start ?? zeilen[0] ?? '';
}
