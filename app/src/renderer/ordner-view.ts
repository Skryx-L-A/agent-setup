// Die Ordneransicht (4c.2): der Projektordner der aktiven Session, sonst das
// Eigenheimverzeichnis. `~/Knowledge/90-secrets/` und `~/.ssh/` sind
// AUSGELASSEN, nicht nur verborgen -- das entscheidet main/folder.ts, diese
// Datei zeichnet nur, was sie bekommt.
//
// Die Inhaltssuche (4c.1, zweiter Rueckfallweg) sitzt oben im selben Panel:
// eine Eingabe, die bei nicht-leerem Text den Baum durch Treffer ersetzt --
// "die Treffer erscheinen in derselben Leiste", nicht in einer eigenen.
import './ordner-view.css';
import { registriere, umschalten } from './flaeche';

interface EintragInfo { name: string; path: string; isDir: boolean; size: number; mtimeMs: number }
interface OrdnerPayload { root: string; entries: EintragInfo[] }
interface Treffer { pfad: string; zeile: number; text: string }
interface SuchePayload { root: string; query: string; treffer: Treffer[] | null }

export function ordnerUiState(): { offen: boolean; wurzel: string; zeilen: number; sucheAktiv: boolean } {
  const panel = document.getElementById('or-panel');
  const offen = !!panel?.classList.contains('offen');
  const zeilen = [...(panel?.querySelectorAll('.or-zeile') ?? [])];
  const eingabe = panel?.querySelector<HTMLInputElement>('.or-suche-eingabe');
  return {
    offen,
    wurzel: panel?.querySelector('.or-wurzel')?.textContent ?? '',
    zeilen: zeilen.length,
    sucheAktiv: !!eingabe?.value.trim(),
  };
}

export function initOrdnerView(): void {
  const knopf = document.querySelector<HTMLButtonElement>('.knopf[data-tot="ordner"]');
  if (!knopf) return;

  const panel = document.createElement('div');
  panel.id = 'or-panel';
  panel.className = 'or-panel';
  panel.innerHTML = `
    <div class="or-kopf">
      <div class="or-titel">Ordner</div>
      <button type="button" class="or-schliessen" title="Schliessen">&times;</button>
    </div>
    <div class="or-suchleiste">
      <input type="text" class="or-suche-eingabe" data-tipp="suche" placeholder="Inhalt durchsuchen (rg) …" />
    </div>
    <div class="or-inhalt">
      <div class="or-wurzel"></div>
      <div class="or-baum"></div>
      <div class="or-treffer"></div>
    </div>`;
  // Die Schublade haengt in der Reihe zwischen Sessionleiste und Buehne,
  // nicht am Rumpf: nur dort nimmt sie Platz weg, statt sich darueber zu
  // legen. Fehlt der Platzhalter, bleibt der Rumpf die Notloesung.
  (document.getElementById('schublade') ?? document.body).appendChild(panel);

  const wurzelEl = panel.querySelector<HTMLDivElement>('.or-wurzel')!;
  const baumEl = panel.querySelector<HTMLDivElement>('.or-baum')!;
  const trefferEl = panel.querySelector<HTMLDivElement>('.or-treffer')!;
  const sucheEl = panel.querySelector<HTMLInputElement>('.or-suche-eingabe')!;

  let offen = false;
  let wurzel = '';
  const kinder = new Map<string, EintragInfo[]>();
  const aufgeklappt = new Set<string>();
  let letzteAnfrage = '';

  function schliessen(): void {
    offen = false;
    panel.classList.remove('offen');
    // Die Buehne ist jetzt anders breit: melden, damit der Pane darauf passt.
    document.dispatchEvent(new CustomEvent('awb:flaeche-geaendert'));
  }

  function zeile(opt: { klasse: string; einrueckung: number; pfeil: string; name: string; zusatz?: string; onClick: () => void }): HTMLDivElement {
    const el = document.createElement('div');
    el.className = `or-zeile ${opt.klasse}`;
    el.style.paddingLeft = `${10 + opt.einrueckung * 14}px`;
    el.innerHTML = `<span class="or-pfeil">${opt.pfeil}</span><span class="or-name"></span>${opt.zusatz ? '<span class="or-zzusatz"></span>' : ''}`;
    el.querySelector('.or-name')!.textContent = opt.name;
    if (opt.zusatz) el.querySelector('.or-zzusatz')!.textContent = opt.zusatz;
    el.addEventListener('click', opt.onClick);
    return el;
  }

  function knotenZeichnen(ziel: HTMLElement, pfad: string, tiefe: number): void {
    const eintraege = kinder.get(pfad);
    if (!eintraege) return;
    for (const e of eintraege) {
      if (e.isDir) {
        const klapp = aufgeklappt.has(e.path);
        ziel.appendChild(zeile({
          klasse: 'or-ordner', einrueckung: tiefe, pfeil: klapp ? '▾' : '▸', name: e.name,
          onClick: () => {
            if (aufgeklappt.has(e.path)) aufgeklappt.delete(e.path);
            else {
              aufgeklappt.add(e.path);
              if (!kinder.has(e.path)) window.awbBridge.bedienung('ordner-liste', e.path);
            }
            zeichneBaum();
          },
        }));
        if (klapp) knotenZeichnen(ziel, e.path, tiefe + 1);
      } else {
        ziel.appendChild(zeile({
          klasse: 'or-datei', einrueckung: tiefe, pfeil: ' ', name: e.name, zusatz: `${e.size} B`,
          onClick: () => window.awbBridge.bedienung('ordner-oeffnen', e.path),
        }));
      }
    }
  }

  function zeichneBaum(): void {
    trefferEl.replaceChildren();
    trefferEl.style.display = 'none';
    baumEl.style.display = '';
    baumEl.replaceChildren();
    if (!wurzel) return;
    knotenZeichnen(baumEl, wurzel, 0);
    if (!(kinder.get(wurzel) ?? []).length) {
      const leer = document.createElement('div');
      leer.className = 'or-leer';
      leer.textContent = 'Leer, oder alles hier ist ausgeschlossen.';
      baumEl.appendChild(leer);
    }
  }

  function zeichneTreffer(p: SuchePayload): void {
    if (p.query !== letzteAnfrage) return; // ueberholt -- verwerfen
    baumEl.style.display = 'none';
    trefferEl.style.display = '';
    trefferEl.replaceChildren();
    if (p.treffer === null) {
      const fehler = document.createElement('div');
      fehler.className = 'or-leer';
      fehler.textContent = 'Suche nicht verfuegbar (rg fehlt oder abgebrochen).';
      trefferEl.appendChild(fehler);
      return;
    }
    if (!p.treffer.length) {
      const leer = document.createElement('div');
      leer.className = 'or-leer';
      leer.textContent = 'Kein Treffer.';
      trefferEl.appendChild(leer);
      return;
    }
    for (const t of p.treffer) {
      const el = document.createElement('div');
      el.className = 'or-treffer-zeile';
      const name = t.pfad.split('/').pop() ?? t.pfad;
      el.innerHTML = `<div class="or-treffer-kopf"><span class="or-name"></span><span class="or-zeilennr"></span></div><div class="or-treffer-text"></div>`;
      el.querySelector('.or-name')!.textContent = name;
      el.querySelector('.or-zeilennr')!.textContent = `Zeile ${t.zeile}`;
      el.querySelector('.or-treffer-text')!.textContent = t.text;
      el.title = t.pfad;
      el.addEventListener('click', () => window.awbBridge.bedienung('ordner-oeffnen', t.pfad));
      trefferEl.appendChild(el);
    }
  }

  let sucheZeit: number | undefined;
  sucheEl.addEventListener('input', () => {
    if (sucheZeit !== undefined) clearTimeout(sucheZeit);
    const query = sucheEl.value.trim();
    if (!query) {
      letzteAnfrage = '';
      zeichneBaum();
      return;
    }
    sucheZeit = setTimeout(() => {
      letzteAnfrage = query;
      window.awbBridge.bedienung('suche-lesen', { query, pfad: wurzel });
    }, 300) as unknown as number;
  });

  // Ob die naechste 'awb:ordner'-Antwort die (moeglicherweise NEUE) Wurzel
  // beantwortet, statt eine aufgeklappte Unterordner-Anfrage. Ohne das bliebe
  // der Baum nach einem Sessionwechsel auf der alten Wurzel stehen.
  let wurzelAngefragt = false;

  function oeffnen(): void {
    offen = true;
    panel.classList.add('offen');
    // Die Buehne ist jetzt anders breit: melden, damit der Pane darauf passt.
    document.dispatchEvent(new CustomEvent('awb:flaeche-geaendert'));
    wurzelAngefragt = true;
    window.awbBridge.bedienung('ordner-liste', '');
  }

  registriere({ name: 'ordner', offen: () => offen, oeffnen, schliessen });
  knopf.addEventListener('click', () => umschalten('ordner'));
  panel.querySelector('.or-schliessen')!.addEventListener('click', schliessen);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && offen) schliessen();
  });

  window.awbBridge.onOrdner((roh) => {
    const p = roh as OrdnerPayload;
    if (wurzelAngefragt) {
      wurzelAngefragt = false;
      if (p.root !== wurzel) {
        wurzel = p.root;
        kinder.clear();
        aufgeklappt.clear();
        aufgeklappt.add(wurzel);
        wurzelEl.textContent = wurzel;
        wurzelEl.title = wurzel;
      }
    }
    kinder.set(p.root, p.entries);
    if (!letzteAnfrage) zeichneBaum();
  });
  window.awbBridge.onSuche((p) => zeichneTreffer(p as SuchePayload));
}
