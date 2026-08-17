// DAS BILD-PLATZHALTER-MUSTER DES HARNESS (SPEC-V4 Abschnitt 6, 12.08.).
//
// GEMESSEN (12.08., echte Sitzungsdatei ~/.claude/projects/…): fuegt ein
// Mensch ein Bild ein, legt Claude Code daneben einen eigenen `user`-Eintrag
// an -- `isMeta:true`, `message.content` ein reiner String. ZWEI Formen sind
// gemessen (Reviewer-Pass 12.08., 251 Platzhalter aus allen Sitzungsdateien
// dieser Maschine durchgesehen):
//
//   1  `[Image: original WxH, displayed at wxh. Multiply coordinates by f to
//      map to original image.]` -- 246 von 251. Harness-Buchfuehrung fuer die
//      eigene Bildschirmauswertung, kein Gespraechsbeitrag: Anzeigegroesse und
//      Umrechnungsfaktor sagen nichts ueber das Bild, nur etwas ueber die
//      Fenstergroesse in DIESEM Moment. Nur die Originalgroesse ist eine
//      Auskunft ueber das Bild selbst.
//   2  `[Image: source: /pfad/zur/datei.png]` -- die uebrigen 5. Traegt keine
//      Groesse, dafuer einen ABSOLUTEN PFAD in Dateisystem des Nutzers -- der
//      darf die Ansicht nie erreichen (Standing rule: Geheimnis-Wege nie nach
//      aussen dokumentieren gilt sinngemaess auch fuer lokale Pfade in einer
//      Chat-Ansicht, die irgendwann geteilt werden koennte).
const MUSTER_MASS = /^\[Image: original (\d+)x(\d+), displayed at \d+x\d+\. Multiply coordinates by [\d.]+ to map to original image\.\]$/;
const MUSTER_QUELLE = /^\[Image: source: .+\]$/;

/**
 * `breite`/`hoehe` sind `null`, wenn der Platzhalter erkannt wurde, aber KEINE
 * Groesse traegt (Form 2) -- das ist ein anderer Zustand als "kein
 * Platzhalter" (dafuer liefert `bildmass()` selbst `null`, nicht dieses
 * Objekt).
 */
export interface Bildmass {
  breite: number | null;
  hoehe: number | null;
}

/**
 * Erkennt beide gemessenen Formen des Platzhalters. `null`, wenn der Text
 * keine von beiden ist -- geraten wird hier nichts, nur die EXAKT gemessenen
 * Muster werden erkannt.
 */
export function bildmass(text: string): Bildmass | null {
  const t = text.trim();
  const treffer = MUSTER_MASS.exec(t);
  if (treffer) return { breite: Number(treffer[1]), hoehe: Number(treffer[2]) };
  if (MUSTER_QUELLE.test(t)) return { breite: null, hoehe: null };
  return null;
}
