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

/**
 * Das Home DIESES Laufs (preload.ts, `awbBridge.heim`), wie die Mac-Fassung
 * (Freigaben.swift, `kurzerPfad`): ein Lauf mit umgelenktem HOME -- Suiten, die
 * Vorschaubilder (publish/tools/vorschau.sh) -- kuerzt seine eigenen Ordner auch.
 */
function heim(): string {
  const h = (globalThis as { awbBridge?: { heim?: string } }).awbBridge?.heim ?? '';
  return h.length > 1 ? h.replace(/\/+$/, '') : '';
}

/** Das Home des Laufs, `/Users/jemand/…` und `/home/jemand/…` werden zu `~/…`; alles andere bleibt. */
export function kurzerPfad(pfad: string): string {
  const h = heim();
  if (h && pfad === h) return '~';
  if (h && pfad.startsWith(h + '/')) return `~${pfad.slice(h.length)}`;
  const treffer = /^(\/Users\/[^/]+|\/home\/[^/]+)(\/.*)?$/.exec(pfad);
  return treffer ? `~${treffer[2] ?? ''}` : pfad;
}
