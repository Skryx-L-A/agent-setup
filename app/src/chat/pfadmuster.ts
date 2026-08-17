// PFADMUSTER DER REGISTRY -- die reine Haelfte.
//
// Der `ort` eines session-Blocks ist selten ein fertiger Pfad. Er traegt
// Platzhalter (`{cwdSlug}`, `{sessionId}`, `{name}`) und Sterne
// (`~/.codex/sessions/*/*/*/rollout-*.jsonl`). Diese Datei setzt die
// Platzhalter ein und sagt, ob ein Namensteil auf ein Muster passt; das Laufen
// durch die Verzeichnisse steht in app/src/main/chatquelle.ts -- hier wird
// keine Datei angefasst.
//
// KEIN allgemeiner Glob. Nur `*` innerhalb eines Namensteils, kein `**`, keine
// Zeichenklassen: mehr braucht keiner der achtzehn Eintraege, und ein
// selbstgebauter Mustervergleich, der mehr kann, als jemand braucht, ist eine
// Fehlerquelle ohne Nutzen.

/** Der Ordnername, den claude und qwen aus einem Arbeitsverzeichnis machen. */
export function cwdSlug(cwd: string): string {
  // GEMESSEN am eigenen Transcript-Ordner (11.08.):
  // /Users/alice/.pi-workers/worktrees/chatansicht wird zu
  // -Users-alice--pi-workers-worktrees-chatansicht -- jeder Schraegstrich UND
  // jeder Punkt wird zum Strich, der fuehrende Schraegstrich bleibt als Strich
  // stehen (deshalb der doppelte Strich vor 'pi-workers').
  return cwd.replace(/[/.]/g, '-');
}

export interface Werte {
  cwd?: string;
  sessionId?: string;
  /** Der Name der Sitzung, wie ihn `pi` fuer sein Sitzungsverzeichnis nimmt. */
  name?: string;
  home?: string;
  tmpdir?: string;
}

/** Setzt die Platzhalter eines `ort` ein. Unbekannte bleiben stehen und fallen auf. */
export function ortFuellen(ort: string, w: Werte): string {
  let raus = ort;
  if (w.home) raus = raus.replace(/^~(?=\/|$)/, w.home);
  return raus.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (ganz, schluessel: string) => {
    switch (schluessel) {
      case 'cwdSlug': return w.cwd ? cwdSlug(w.cwd) : ganz;
      case 'cwd': return w.cwd ?? ganz;
      case 'sessionId': return w.sessionId || '*';
      case 'name': return w.name || '*';
      case 'TMPDIR': return w.tmpdir ?? ganz;
      default: return ganz;
    }
  });
}

/** Passt ein einzelner Namensteil auf ein Muster mit `*`? */
export function segmentPasst(name: string, muster: string): boolean {
  if (muster === '*') return true;
  if (!muster.includes('*')) return name === muster;
  const teile = muster.split('*');
  let pos = 0;
  for (const [i, teil] of teile.entries()) {
    if (!teil) continue;
    if (i === 0) {
      if (!name.startsWith(teil)) return false;
      pos = teil.length;
      continue;
    }
    if (i === teile.length - 1) {
      return name.length - teil.length >= pos && name.endsWith(teil);
    }
    const gefunden = name.indexOf(teil, pos);
    if (gefunden < 0) return false;
    pos = gefunden + teil.length;
  }
  return true;
}

/** Enthaelt der Pfad ueberhaupt ein Muster? Dann muss gesucht werden. */
export function istMuster(pfad: string): boolean {
  return pfad.includes('*');
}
