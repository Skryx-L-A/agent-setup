// Ein Ort fuer die Protokolle (V16, Schritt 9): Guard-Log, Hygiene-Bericht,
// Testlauf-Bericht, SESSION-STATE.md -- vier Pfade, die man heute einzeln
// kennen muss. Eine Liste, ein Klick oeffnet die Datei "in der Mitte"
// (schreibgeschuetzter Tab, derselbe Weg wie bei einem Aktivitaets-Eintrag).
// Der billigste der vier Punkte -- bleibt bewusst der kleinste: keine
// Suche, keine Vorschau, kein eigenes Formular. Die Liste selbst steht in
// den Einstellungen (`logPaths`), das aendert dieses Modul nicht.
import './protokolle-view.css';
import { registriere, umschalten } from './flaeche';
import { openAbsoluteTab } from './editor-view';

interface ProtokollEintrag { label: string; path: string; exists: boolean; size: number; mtimeMs: number }

export function protokolleUiState(): { offen: boolean; eintraege: number; texte: string[] } {
  const panel = document.getElementById('pl-panel');
  const offen = !!panel?.classList.contains('offen');
  const zeilen = [...(panel?.querySelectorAll('.pl-eintrag') ?? [])];
  return { offen, eintraege: zeilen.length, texte: zeilen.map((e) => (e.textContent ?? '').trim()) };
}

export function initProtokolleView(): void {
  const knopf = document.querySelector<HTMLButtonElement>('.knopf[data-tot="protokolle"]');
  if (!knopf) return;

  const panel = document.createElement('div');
  panel.id = 'pl-panel';
  panel.className = 'pl-panel';
  panel.innerHTML = `
    <div class="pl-kopf">
      <div class="pl-titel">Protokolle</div>
      <button type="button" class="pl-schliessen" title="Schliessen">&times;</button>
    </div>
    <div class="pl-inhalt"><div class="pl-liste"></div><div class="pl-status"></div></div>`;
  // Die Schublade haengt in der Reihe zwischen Sessionleiste und Buehne,
  // nicht am Rumpf: nur dort nimmt sie Platz weg, statt sich darueber zu
  // legen. Fehlt der Platzhalter, bleibt der Rumpf die Notloesung.
  (document.getElementById('schublade') ?? document.body).appendChild(panel);

  const liste = panel.querySelector<HTMLDivElement>('.pl-liste')!;
  const statusEl = panel.querySelector<HTMLDivElement>('.pl-status')!;
  let offen = false;

  function schliessen(): void {
    offen = false;
    panel.classList.remove('offen');
    // Die Buehne ist jetzt anders breit: melden, damit der Pane darauf passt.
    document.dispatchEvent(new CustomEvent('awb:flaeche-geaendert'));
  }

  function status(text: string): void {
    statusEl.textContent = text;
  }

  async function klick(e: ProtokollEintrag): Promise<void> {
    if (!e.exists) {
      status(`Diese Datei gibt es noch nicht: ${e.path}`);
      return;
    }
    const res = await window.awbEditorBridge.protokolleRead(e.path);
    if (!res.ok) { status(res.error); return; }
    await openAbsoluteTab(`protokoll:${e.path}`, e.label, e.path, res.value);
    status('');
  }

  function zeichnen(eintraege: ProtokollEintrag[]): void {
    liste.replaceChildren();
    for (const e of eintraege) {
      const el = document.createElement('div');
      el.className = `pl-eintrag${e.exists ? '' : ' pl-fehlt'}`;
      el.innerHTML = `
        <div class="pl-eintrag-kopf">
          <span class="pl-label"></span>
          <span class="pl-groesse"></span>
        </div>
        <div class="pl-pfad"></div>`;
      el.querySelector('.pl-label')!.textContent = e.label;
      el.querySelector('.pl-groesse')!.textContent = e.exists ? `${e.size} B` : 'fehlt';
      el.querySelector('.pl-pfad')!.textContent = e.path;
      el.title = e.exists ? `${e.path} oeffnen` : `${e.path} -- gibt es noch nicht`;
      el.addEventListener('click', () => void klick(e));
      liste.appendChild(el);
    }
  }

  async function oeffnen(): Promise<void> {
    offen = true;
    panel.classList.add('offen');
    // Die Buehne ist jetzt anders breit: melden, damit der Pane darauf passt.
    document.dispatchEvent(new CustomEvent('awb:flaeche-geaendert'));
    const res = await window.awbEditorBridge.protokolleList();
    if (!res.ok) { status(res.error); return; }
    zeichnen(res.value);
  }

  registriere({ name: 'protokolle', offen: () => offen, oeffnen: () => void oeffnen(), schliessen });
  knopf.addEventListener('click', () => umschalten('protokolle'));
  panel.querySelector('.pl-schliessen')!.addEventListener('click', schliessen);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && offen) schliessen();
  });
}
