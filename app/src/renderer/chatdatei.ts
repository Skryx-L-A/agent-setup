// DIE NAHT ZWISCHEN DEN CHAT-ANSICHTEN UND DEM OEFFNEN (Auftrag chatdatei, 05.09.2026).
//
// Beide Ansichten (chat/ansicht.ts, chatbuehne/ansicht.ts) sind reines DOM
// ohne Bruecke; sie bekommen einen `PfadHaken` hereingereicht. Hier steht die
// eine Fassung davon: pruefen ueber die Bruecke, oeffnen ueber den Editor der
// Werkbank (editor-view.ts, dieselbe Funktion wie Ordner-Blatt und
// Schnelloeffner), Verzeichnisse ueber das Ordner-Blatt, Binaeres hat der
// Hauptprozess schon dem System gegeben.
import type { PfadHaken, PfadTreffer } from '../chat/pfadlinks';
import { editorNotiz, oeffneChatDatei } from './editor-view';
import { ordnerBlattZeigen } from './ordner-view';

type Oeffnung =
  | { art: 'ordner'; abs: string }
  | { art: 'extern'; abs: string }
  | { art: 'text'; abs: string; name: string; content: string };

function alsOeffnung(w: unknown): Oeffnung | null {
  if (!w || typeof w !== 'object') return null;
  const d = w as Record<string, unknown>;
  if (typeof d.abs !== 'string') return null;
  if (d.art === 'ordner' || d.art === 'extern') return { art: d.art, abs: d.abs };
  if (d.art === 'text' && typeof d.content === 'string') {
    return { art: 'text', abs: d.abs, name: String(d.name ?? ''), content: d.content };
  }
  return null;
}

function alsTreffer(w: unknown): PfadTreffer[] {
  if (!Array.isArray(w)) return [];
  return w.filter((t): t is PfadTreffer =>
    !!t && typeof t === 'object' && typeof (t as PfadTreffer).abs === 'string'
    && typeof (t as PfadTreffer).kandidat === 'string');
}

async function oeffnen(t: PfadTreffer): Promise<void> {
  const r = await window.awbEditorBridge.chatPfadOeffnen(t.abs);
  if (!r.ok) {
    editorNotiz(r.error);
    return;
  }
  const o = alsOeffnung(r.value);
  if (!o) return;
  if (o.art === 'ordner') ordnerBlattZeigen(o.abs);
  else if (o.art === 'text') await oeffneChatDatei(o.abs, o.name, o.content, t.zeile, t.spalte);
  // 'extern': der Hauptprozess hat den Pfad bereits an `shell.openPath` gegeben.
}

/** Der Haken fuer eine Ansicht. `paneId` leer heisst: die Chat-Sitzung auf der Buehne. */
export function chatPfadHaken(paneId: string): PfadHaken {
  return {
    async pruefen(kandidaten: string[]): Promise<PfadTreffer[]> {
      const r = await window.awbEditorBridge.chatPfade(paneId, kandidaten);
      return r.ok ? alsTreffer(r.value) : [];
    },
    oeffnen(t: PfadTreffer): void {
      void oeffnen(t);
    },
  };
}
