// Die Ordneransicht (4c.2): der Projektordner der aktiven Session, sonst das
// Eigenheimverzeichnis. `~/Knowledge/90-secrets/` und `~/.ssh/` sind
// AUSGELASSEN, nicht nur verborgen -- das entscheidet main/folder.ts, diese
// Datei zeichnet nur, was sie bekommt.
//
// Die Inhaltssuche (4c.1, zweiter Rueckfallweg) sitzt oben im selben Panel:
// eine Eingabe, die bei nicht-leerem Text den Baum durch Treffer ersetzt --
// "die Treffer erscheinen in derselben Leiste", nicht in einer eigenen.
//
// AUFFRISCHUNG (21.08.). Bis heute wurde der Baum genau einmal gelesen -- beim
// Aufklappen der Schublade -- und danach nie wieder; ein aufgeklappter
// Unterordner nicht einmal das, er behielt seine erste Antwort fuer immer. In
// einer laufenden Sitzung stand deshalb der Stand vom Sitzungsbeginn auf dem
// Schirm, waehrend die Worker Dateien schrieben.
//
// Nachgesehen wird jetzt im Takt, aber NUR solange die Schublade offen ist,
// und nur fuer die Ordner, die gerade wirklich auf dem Schirm stehen (Wurzel
// plus aufgeklappte). Ein Dateisystem-Beobachter waere der andere Weg gewesen;
// dagegen sprach die Hausregel, dass nichts auf Vorrat laeuft, und die Messung:
// ein Ordner kostet 0,04 ms (29 Eintraege) bis 0,29 ms (247 Eintraege), also
// liegt eine Runde ueber zwei, drei offene Ordner unter einer Millisekunde --
// billiger als ein Beobachter, der fuer jeden Ordner eine Ressource haelt und
// beim Schliessen wieder abgeraeumt werden muss.
//
// Gezeichnet wird nur, wenn sich wirklich etwas geaendert hat: die Antwort
// wird gegen den Stand verglichen, den die Ansicht schon hat. Ohne diesen
// Vergleich wuerde der Baum alle zwei Sekunden neu aufgebaut, mit Flackern
// und verlorener Rollposition, obwohl sich nichts getan hat.
import './ordner-view.css';
import { registriere, umschalten } from './flaeche';

interface EintragInfo { name: string; path: string; isDir: boolean; size: number; mtimeMs: number }
interface OrdnerPayload { root: string; entries: EintragInfo[] }
interface Treffer { pfad: string; zeile: number; text: string }
interface SuchePayload { root: string; query: string; treffer: Treffer[] | null }

/**
 * Wieviele Ordner-Antworten diese Ansicht seit dem Start verarbeitet hat.
 * Steht hier, nicht in der Ansicht selbst, weil `ordnerUiState` auch dann
 * lesbar sein muss, wenn `initOrdnerView` nie lief (kein Ordnerknopf).
 *
 * Die Zahl ist die MESSGROESSE hinter der Zusage „nichts laeuft auf Vorrat":
 * bei geschlossener Schublade darf sie stehenbleiben, egal was auf der Platte
 * geschieht.
 */
let lesungen = 0;

export function ordnerUiState(): {
  offen: boolean; wurzel: string; zeilen: number; sucheAktiv: boolean;
  namen: string[]; treffer: number; lesungen: number; beobachtet: number;
} {
  const panel = document.getElementById('or-panel');
  const offen = !!panel?.classList.contains('offen');
  const zeilen = [...(panel?.querySelectorAll('.or-zeile') ?? [])];
  const eingabe = panel?.querySelector<HTMLInputElement>('.or-suche-eingabe');
  return {
    offen,
    wurzel: panel?.querySelector('.or-wurzel')?.textContent ?? '',
    zeilen: zeilen.length,
    sucheAktiv: !!eingabe?.value.trim(),
    // Die Namen in der Reihenfolge, in der sie stehen. Eine blosse Anzahl
    // beantwortet „was steht da" nicht: eine gleichzeitig entstandene und
    // verschwundene Datei laesst sie unveraendert.
    namen: zeilen.map((z) => z.querySelector('.or-name')?.textContent ?? ''),
    treffer: (panel?.querySelectorAll('.or-treffer-zeile') ?? []).length,
    lesungen,
    // Wieviele Ordner gerade nachgesehen werden. Zu ist zu: geschlossen 0.
    beobachtet: beobachteteOrdner(),
  };
}

/** Von `initOrdnerView` gesetzt; ohne Ansicht wird nichts nachgesehen. */
let beobachteteOrdner: () => number = () => 0;

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
    // Zu ist zu: ab hier wird nichts mehr nachgesehen (Hausregel -- kein
    // Prozess laeuft auf Vorrat).
    taktBeenden();
    panel.classList.remove('offen');
    // Die Buehne ist jetzt anders breit: melden, damit der Pane darauf passt.
    document.dispatchEvent(new CustomEvent('awb:flaeche-geaendert'));
  }

  function zeile(opt: { klasse: string; einrueckung: number; pfeil: string; name: string; pfad: string; zusatz?: string; onClick: () => void }): HTMLDivElement {
    const el = document.createElement('div');
    el.className = `or-zeile ${opt.klasse}`;
    // Der Pfad steht am Element, damit ein Test eine bestimmte Zeile anklicken
    // kann, ohne ihre Bildschirmkoordinaten auszurechnen (die haengen an der
    // Schriftgroesse). Gezeichnet wird er nicht.
    el.dataset.pfad = opt.pfad;
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
          klasse: 'or-ordner', einrueckung: tiefe, pfeil: klapp ? '▾' : '▸', name: e.name, pfad: e.path,
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
          klasse: 'or-datei', einrueckung: tiefe, pfeil: ' ', name: e.name, pfad: e.path, zusatz: `${e.size} B`,
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

  /**
   * Die Ordner, die gerade wirklich auf dem Schirm stehen: die Wurzel und
   * jeder aufgeklappte Ordner, der von ihr aus erreichbar ist. Genau diese
   * werden nachgesehen -- ein Ordner, dessen Elternteil zugeklappt ist, ist
   * nicht zu sehen und kostet deshalb auch nichts.
   *
   * Der `gesehen`-Wall faengt einen Symlink-Ring ab: `listDir` folgt Symlinks,
   * also kann ein Ordner sich selbst enthalten.
   */
  function offeneOrdner(): string[] {
    if (!wurzel) return [];
    const raus: string[] = [];
    const gesehen = new Set<string>();
    const gehe = (pfad: string): void => {
      if (gesehen.has(pfad)) return;
      gesehen.add(pfad);
      raus.push(pfad);
      for (const e of kinder.get(pfad) ?? []) {
        if (e.isDir && aufgeklappt.has(e.path)) gehe(e.path);
      }
    };
    gehe(wurzel);
    return raus;
  }

  /**
   * Was von der Wurzel aus ueberhaupt noch erreichbar ist. Ein Ordner, den
   * jemand von aussen geloescht hat, steht sonst fuer immer im Zwischenspeicher
   * und wird bei jeder Runde erneut nachgesehen.
   */
  function erreichbar(): Set<string> {
    const raus = new Set<string>();
    if (!wurzel) return raus;
    const gehe = (pfad: string): void => {
      if (raus.has(pfad)) return;
      raus.add(pfad);
      for (const e of kinder.get(pfad) ?? []) if (e.isDir) gehe(e.path);
    };
    gehe(wurzel);
    return raus;
  }

  function aufraeumen(): void {
    const lebt = erreichbar();
    for (const pfad of [...kinder.keys()]) if (!lebt.has(pfad)) kinder.delete(pfad);
    for (const pfad of [...aufgeklappt]) if (!lebt.has(pfad)) aufgeklappt.delete(pfad);
  }

  /** Ob eine Antwort denselben Stand traegt wie der, den die Ansicht schon hat. */
  function gleich(alt: EintragInfo[] | undefined, neu: EintragInfo[]): boolean {
    if (!alt || alt.length !== neu.length) return false;
    return alt.every((a, i) =>
      a.name === neu[i].name && a.isDir === neu[i].isDir
      && a.size === neu[i].size && a.mtimeMs === neu[i].mtimeMs);
  }

  /** Eine Runde: jeden sichtbaren Ordner neu anfordern. */
  function nachsehen(): void {
    for (const pfad of offeneOrdner()) window.awbBridge.bedienung('ordner-liste', pfad);
  }

  // Der Takt. Zwei Sekunden: schnell genug, dass eine Datei „gleich" auftaucht,
  // langsam genug, dass die Runde (unter 1 ms) im Rauschen verschwindet.
  const TAKT_MS = 2000;
  let takt: number | undefined;

  function taktStarten(): void {
    if (takt !== undefined) return;
    takt = setInterval(nachsehen, TAKT_MS) as unknown as number;
  }

  function taktBeenden(): void {
    if (takt === undefined) return;
    clearInterval(takt);
    takt = undefined;
  }

  // Was `ordnerUiState` als `beobachtet` meldet: wieviele Ordner gerade
  // nachgesehen werden. Bei geschlossener Schublade sind es null -- das ist die
  // pruefbare Fassung der Zusage, dass hier nichts auf Vorrat laeuft.
  beobachteteOrdner = () => (takt === undefined ? 0 : offeneOrdner().length);

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
    taktStarten();
  }

  registriere({ name: 'ordner', offen: () => offen, oeffnen, schliessen });
  knopf.addEventListener('click', () => umschalten('ordner'));
  panel.querySelector('.or-schliessen')!.addEventListener('click', schliessen);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && offen) schliessen();
  });

  window.awbBridge.onOrdner((roh) => {
    const p = roh as OrdnerPayload;
    lesungen += 1;
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
    const unveraendert = gleich(kinder.get(p.root), p.entries);
    kinder.set(p.root, p.entries);
    // Waehrend einer Suche steht der Baum nicht auf dem Schirm -- der Stand
    // wird trotzdem nachgefuehrt, gezeichnet wird er erst, wenn die Eingabe
    // wieder leer ist. Ohne diesen Wall wuerde jede Runde die Trefferliste
    // durch den Baum ersetzen.
    if (letzteAnfrage || unveraendert) return;
    aufraeumen();
    zeichneBaum();
  });
  window.awbBridge.onSuche((p) => zeichneTreffer(p as SuchePayload));

  // NUR FUER TESTS: eine Baumzeile ueber ihren Pfad anklicken. Ein echter Klick
  // braucht Bildschirmkoordinaten, und die haengen an der Schriftgroesse -- der
  // Haken klickt dieselbe Zeile, die auch die Maus traefe, und laeuft dabei
  // durch denselben Behandler. Erreichbar ist er allein ueber den Steuerkanal
  // ('ordner-auf'), nicht aus der Seite heraus.
  (window as unknown as { __awbOrdner: unknown }).__awbOrdner = {
    auf(pfad: string): boolean {
      const zeileEl = [...panel.querySelectorAll<HTMLDivElement>('.or-zeile')]
        .find((el) => el.dataset.pfad === pfad);
      if (!zeileEl) return false;
      zeileEl.click();
      return true;
    },
  };
}
