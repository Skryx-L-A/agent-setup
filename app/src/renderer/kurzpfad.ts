// Ein Pfad, wie ihn ein Mensch liest: das Heimatverzeichnis als `~`.
//
// EIGENE DATEI, WEIL ZWEI SEITEN IHN BRAUCHEN (05.09.2026, Electron-Befund 2).
// Derselbe Vollpfad stand bis zu fuenfmal im Fenster -- im Inhaltskopf, im
// Kopf des Inspektors, in der Sitzungskarte, im Freigabe-Banner, in der
// Antragskarte und im Fuss der Chat-Buehne --, monospace und ueberall
// abgeschnitten. Voll steht er jetzt nur noch in der Sitzungskarte; sonst
// gilt entweder der Projektname oder diese Kuerzung.
//
// Sie steht nicht in renderer.ts: freigaben-view.ts wird VON renderer.ts
// eingelesen, ein Rueckgriff waere ein Ring.

/** `/Users/jemand/…` und `/home/jemand/…` werden zu `~/…`; alles andere bleibt. */
export function kurzerPfad(pfad: string): string {
  const treffer = /^(\/Users\/[^/]+|\/home\/[^/]+)(\/.*)?$/.exec(pfad);
  return treffer ? `~${treffer[2] ?? ''}` : pfad;
}
