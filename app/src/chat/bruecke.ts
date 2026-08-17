// DIE DREI DINGE, DIE IN KEINEM PROTOKOLL STEHEN (SPEC-V4 6.2).
//
// Erstens Freigabedialoge: in keinem der achtzehn Protokolle taucht eine
// Ja/Nein-Frage als eigener Eintrag auf -- `context-guard` erkennt sie
// ausschliesslich am Bildschirmtext. Zweitens die Kontextauslastung, die bei
// sieben Harnesses nur auf dem Bildschirm steht. Drittens jedes Zeichen dafuer,
// dass das Programm gerade arbeitet: Spinner und Fortschrittstexte sind reine
// Oberflaeche.
//
// EINE CHAT-ANSICHT OHNE DIESE BRUECKE IST HUEBSCHER UND SCHLECHTER. Sie liesse
// den Menschen vor einer Frage sitzen, die er nicht sieht -- deshalb steht die
// Bruecke im Datentyp (typen.ts) und wird hier gefuellt, bevor irgendetwas
// gezeichnet wird.
//
// WOHER DIE ZAHLEN KOMMEN, und warum hier kein zweiter Bildschirmleser steht:
// Die Werkbank wertet den Pane laengst aus. `app/src/main/sessions.ts` fuehrt je
// Worker `contextPercent`, `contextTokens`, `contextWindow`, `state`,
// `blockedReason` und `idleSeconds`; die Freigabeantraege zaehlt
// `pendingApprovals` je Sitzung. Diese Datei formt daraus die Bruecke -- ein
// eigener Leser waere eine zweite Wahrheit ueber denselben Bildschirm, und
// genau diese Fehlerklasse hat der Werkbank am 06.08. sieben tote Schalter
// gekostet.
import type { Bruecke } from './typen';
import { LEERE_BRUECKE } from './typen';

/** Was die Werkbank ueber einen Pane ohnehin schon weiss. */
export interface PaneLage {
  /** 'running' | 'blocked' | 'stalled' | 'done' | 'unknown' aus WorkerInfo. */
  zustand: string;
  /** '' | 'request' | 'guard' aus WorkerInfo.blockedReason. */
  blockGrund: string;
  /** Kontextauslastung in Prozent, -1 = unbekannt. Nie geschaetzt. */
  auslastung: number;
  tokens: number;
  fenster: number;
  /** Sekunden ohne Bewegung im Protokoll, -1 = unbekannt. */
  ruheSekunden: number;
  /** Offene Freigabeantraege der SITZUNG, in der dieser Pane sitzt. */
  antraegeOffen: number;
}

/**
 * Wie lange nach der letzten Bewegung im Protokoll noch "arbeitet" gilt.
 *
 * Gemessen ist die Gegenprobe, nicht diese Schwelle: `cpu` taugt dafuer NICHT --
 * `ps` mittelt ueber die Lebenszeit, und 1,3 Sekunden CPU in 82 Minuten
 * durchgehender Arbeit stehen als Messung im Kopf von `WorkerInfo.cpu`. Bleibt
 * die Bewegung im Protokoll, und die ist grob: sie sagt "es tut sich etwas",
 * nicht "der Spinner dreht". Genau so steht es auch in der Anzeige.
 */
export const ARBEITET_SEKUNDEN = 45;

/**
 * DIE BRUECKE. Rein: sie rechnet, sie sieht nicht nach.
 *
 * Der Freigabefall ist bewusst weit gefasst -- ein Antrag der Sitzung ODER ein
 * blockierter Worker genuegt. Lieber einmal zu viel darauf hinweisen, dass
 * jemand gefragt wird, als einen Menschen vor einer unsichtbaren Frage sitzen
 * zu lassen; die Ansicht liegt UEBER dem Pane, ein Blick dahinter kostet einen
 * Tastendruck.
 */
export function bruecke(lage: PaneLage | null): Bruecke {
  if (!lage) return { ...LEERE_BRUECKE };
  const blockiert = lage.zustand === 'blocked';
  const freigabeOffen = blockiert || lage.antraegeOffen > 0;
  let freigabeText = '';
  if (blockiert && lage.blockGrund === 'guard') {
    freigabeText = 'Ein Guard hat einen Befehl verweigert — der Pane wartet auf eine Entscheidung.';
  } else if (blockiert && lage.blockGrund === 'request') {
    freigabeText = 'Ein Antrag wartet auf die Entscheidung des Orchestrators.';
  } else if (freigabeOffen) {
    freigabeText = 'Diese Sitzung hat offene Freigaben.';
  }
  return {
    freigabeOffen,
    freigabeText,
    auslastung: lage.auslastung >= 0 ? Math.min(100, Math.round(lage.auslastung)) : -1,
    tokens: lage.tokens > 0 ? lage.tokens : 0,
    fenster: lage.fenster > 0 ? lage.fenster : 0,
    arbeitet: lage.zustand === 'running'
      && lage.ruheSekunden >= 0
      && lage.ruheSekunden <= ARBEITET_SEKUNDEN,
  };
}

/**
 * Sagt die Bruecke etwas, das der session-Block als `zeigtNicht` angekuendigt
 * hat? Damit laesst sich in der Ansicht die Herkunft benennen ("vom Bildschirm,
 * nicht aus dem Protokoll") -- eine Zahl ohne Herkunft ist in diesem Haus eine
 * Behauptung.
 */
export function vomBildschirm(zeigtNicht: string[], was: 'freigabedialog' | 'kontextauslastung' | 'arbeits-anzeige'): boolean {
  return zeigtNicht.includes(was);
}
