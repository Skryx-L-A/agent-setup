// Die Aktivitaetsliste (4c.1): was Worker und Sessions erzeugt haben, nach
// WER und WANN geordnet -- kein Dateibaum, weil man einen Namen vergisst,
// aber nicht, wer etwas gemacht hat und ungefaehr wann.
//
// V15/V18 (Schritt 9): der erste Klick auf einen Eintrag oeffnet ihn "in der
// Mitte" (im geteilten Editor-Bereich aus editor-view.ts); ein ZWEITER Klick
// auf DENSELBEN Eintrag zeigt mehr -- den Diff bei einer Aenderung, Auftrag
// neben Ergebnis bei einem Worker-Ergebnis. Beides zusammen ersetzt vier
// fruehere Einzelvorschlaege durch eine Ansicht (SESSION-STATE, Zeile 892).
import './aktivitaet-view.css';
import { registriere, umschalten } from './flaeche';
import { openAbsoluteTab, openDiffTab, openAuftragTab } from './editor-view';

interface AktivitaetEintrag {
  typ: 'ergebnis' | 'aenderung';
  wer: string;
  wannMs: number;
  pfad: string;
  groesse: number;
  kommentar: string;
  sessionId: string;
}
interface AktivitaetPayload { entries: AktivitaetEintrag[] }

function seitHer(wannMs: number): string {
  const min = Math.max(0, Math.round((Date.now() - wannMs) / 60000));
  if (min < 1) return 'gerade eben';
  if (min < 60) return `seit ${min} Min.`;
  const std = Math.floor(min / 60);
  if (std < 24) return `seit ${std} Std.`;
  return `seit ${Math.floor(std / 24)} Tg.`;
}

function dateiname(pfad: string): string {
  return pfad.split('/').pop() ?? pfad;
}

export function aktivitaetUiState(): { offen: boolean; eintraege: number; texte: string[] } {
  const panel = document.getElementById('ak-panel');
  const offen = !!panel?.classList.contains('offen');
  const zeilen = [...(panel?.querySelectorAll('.ak-eintrag') ?? [])];
  return { offen, eintraege: zeilen.length, texte: zeilen.map((e) => (e.textContent ?? '').trim()) };
}

export function initAktivitaetView(): void {
  const knopf = document.querySelector<HTMLButtonElement>('.knopf[data-tot="aktivitaet"]');
  if (!knopf) return;

  const panel = document.createElement('div');
  panel.id = 'ak-panel';
  panel.className = 'ak-panel';
  panel.innerHTML = `
    <div class="ak-kopf">
      <div class="ak-titel">Aktivität</div>
      <button type="button" class="ak-schliessen" title="Schliessen">&times;</button>
    </div>
    <div class="ak-inhalt"><div class="ak-liste"></div><div class="ak-status"></div></div>`;
  // Die Schublade haengt in der Reihe zwischen Sessionleiste und Buehne,
  // nicht am Rumpf: nur dort nimmt sie Platz weg, statt sich darueber zu
  // legen. Fehlt der Platzhalter, bleibt der Rumpf die Notloesung.
  (document.getElementById('schublade') ?? document.body).appendChild(panel);

  const liste = panel.querySelector<HTMLDivElement>('.ak-liste')!;
  const statusEl = panel.querySelector<HTMLDivElement>('.ak-status')!;
  let offen = false;
  let letzte: AktivitaetPayload = { entries: [] };
  /** Der Eintrag, dessen Inhalt gerade offen ist -- ein zweiter Klick DARAUF zeigt mehr. */
  let aktiverPfad = '';

  function schliessen(): void {
    offen = false;
    panel.classList.remove('offen');
    // Die Buehne ist jetzt anders breit: melden, damit der Pane darauf passt.
    document.dispatchEvent(new CustomEvent('awb:flaeche-geaendert'));
  }

  function status(text: string): void {
    statusEl.textContent = text;
  }

  /**
   * Der erste Klick auf einen Eintrag: Inhalt "in der Mitte" (editor-view.ts,
   * schreibgeschuetzter Tab). Der zweite Klick auf DENSELBEN Eintrag zeigt
   * mehr -- den Diff (Aenderung) oder Auftrag neben Ergebnis (Ergebnis).
   */
  async function klick(e: AktivitaetEintrag): Promise<void> {
    const name = dateiname(e.pfad);
    if (e.pfad === aktiverPfad) {
      if (e.typ === 'aenderung') {
        const res = await window.awbEditorBridge.aktivitaetDiff(e.pfad);
        if (!res.ok) { status(res.error); return; }
        await openDiffTab(`diff:${e.pfad}`, `Diff: ${name}`, res.value.original, res.value.modified);
      } else {
        const res = await window.awbEditorBridge.aktivitaetAuftrag(e.pfad);
        if (!res.ok) { status(res.error); return; }
        openAuftragTab(`auftrag:${e.pfad}`, `Auftrag: ${name}`, res.value.auftrag, res.value.ergebnis);
      }
      status('');
      return;
    }
    const res = await window.awbEditorBridge.aktivitaetRead(e.pfad);
    if (!res.ok) { status(res.error); return; }
    await openAbsoluteTab(e.pfad, name, e.pfad, res.value.content);
    aktiverPfad = e.pfad;
    status('');
    zeichnen(letzte);
  }

  function zeichnen(p: AktivitaetPayload): void {
    letzte = p;
    liste.replaceChildren();
    if (!p.entries.length) {
      const leer = document.createElement('div');
      leer.className = 'ak-leer';
      leer.textContent = 'Noch nichts fuer die sichtbaren Sessions.';
      liste.appendChild(leer);
      return;
    }
    for (const e of p.entries) {
      const el = document.createElement('div');
      el.className = `ak-eintrag ak-${e.typ}${e.pfad === aktiverPfad ? ' ak-offen' : ''}`;
      const name = dateiname(e.pfad);
      const zusatz = e.typ === 'ergebnis' ? `${e.groesse} B` : e.kommentar;
      el.innerHTML = `
        <div class="ak-eintrag-kopf">
          <span class="ak-wer">${e.wer}</span>
          <span class="ak-wann">${seitHer(e.wannMs)}</span>
        </div>
        <div class="ak-datei"></div>
        <div class="ak-zusatz"></div>`;
      el.querySelector('.ak-datei')!.textContent = name;
      el.querySelector('.ak-zusatz')!.textContent = zusatz;
      el.title = e.pfad === aktiverPfad
        ? `${e.pfad} -- noch einmal klicken fuer ${e.typ === 'aenderung' ? 'den Diff' : 'Auftrag und Ergebnis'}`
        : e.pfad;
      el.addEventListener('click', () => void klick(e));
      liste.appendChild(el);
    }
  }

  function oeffnen(): void {
    offen = true;
    panel.classList.add('offen');
    // Die Buehne ist jetzt anders breit: melden, damit der Pane darauf passt.
    document.dispatchEvent(new CustomEvent('awb:flaeche-geaendert'));
    window.awbBridge.bedienung('aktivitaet-lesen', null);
  }

  registriere({ name: 'aktivitaet', offen: () => offen, oeffnen, schliessen });
  knopf.addEventListener('click', () => umschalten('aktivitaet'));
  panel.querySelector('.ak-schliessen')!.addEventListener('click', schliessen);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && offen) schliessen();
  });

  window.awbBridge.onAktivitaet((p) => zeichnen(p as AktivitaetPayload));
}
