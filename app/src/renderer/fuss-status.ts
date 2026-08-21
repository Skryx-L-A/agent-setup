// V12 (Ampel) und V13 (Budget): zwei kleine, immer sichtbare Zeilen im Fuss
// der linken Leiste, keine Dauerflaeche (A14) -- Farbe und Kuerzel reichen im
// Vorbeigehen, der Klick zeigt den ganzen Satz kurz ueber der Buehne (dieselbe
// `#notiz`, die auch anderswo im Programm schon "kommt spaeter"-Hinweise
// zeigt). Diese Datei zeichnet nur, was main.ts schon fertig ausgewertet hat
// (ampel.ts, budget.ts) -- keine zweite Bewertung hier.
import './fuss-status.css';

interface AmpelBefund { quelle: string; vorhanden: boolean; rot: boolean; ueberfaellig: boolean; ueberholt: boolean; ageDays: number; text: string }
interface AmpelStand { machine: string; befunde: AmpelBefund[]; farbe: 'rot' | 'gelb' | 'gruen' | 'unbekannt' }
interface BudgetStand { ok: boolean; heuteTokens: number; heuteStunden: number; hochrechnung24h: number; text: string }

// Die Farbe sitzt als SCHRIFTFARBE auf der Marke, nicht als Flaeche: den
// Streifen an ihrer Kante zeichnet `currentColor`, und die zwei Zeichen darin
// bleiben lesbar hell. Mit den -bg-Klassen waere die ganze Kachel eingefaerbt
// gewesen und die Zeichen darauf zu schwach.
const FARBKLASSE: Record<AmpelStand['farbe'], string> = {
  rot: 'aus',
  gelb: 'will',
  gruen: 'laeuft',
  unbekannt: 'ruhig',
};

/**
 * Zwei Zeichen fuer eine Maschine. Eingeklappt ist die Marke alles, was von
 * der Zeile bleibt -- ein blosser Punkt sagte nur eine Farbe, und drei
 * gleiche Punkte untereinander sagten gar nichts (alice am 05.08.).
 * Dieselbe Abkuerzungsregel wie in der Workerleiste: die Anfangsbuchstaben
 * der ersten beiden Wortteile, sonst die ersten zwei Zeichen.
 */
function maschinenkuerzel(name: string): string {
  const teile = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (teile.length >= 2) return (teile[0][0] + teile[1][0]).toUpperCase();
  return (teile[0] ?? name).slice(0, 2).toUpperCase();
}

function kompakt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

let notizUhr: number | undefined;
function kurzHinweis(text: string): void {
  const el = document.getElementById('notiz');
  if (!el) return;
  if (notizUhr !== undefined) clearTimeout(notizUhr);
  el.textContent = text;
  el.classList.toggle('sichtbar', !!text);
  if (text) {
    notizUhr = setTimeout(() => {
      el.classList.remove('sichtbar');
      el.textContent = '';
    }, 4000) as unknown as number;
  }
}

export function initFussStatus(): HTMLDivElement | null {
  const fuss = document.getElementById('fuss');
  if (!fuss) return null;
  const el = document.createElement('div');
  el.id = 'statuszeile';
  fuss.insertBefore(el, fuss.firstChild);
  return el;
}

function zeile(klasse: string, farbklasse: string, marke: string, beschriftung: string, titel: string, klick: (ereignis: MouseEvent) => void): HTMLDivElement {
  const z = document.createElement('div');
  z.className = `sz-zeile ${klasse}`;
  z.title = titel;
  const kachel = document.createElement('span');
  kachel.className = `sz-marke ${farbklasse}`;
  kachel.textContent = marke;
  z.appendChild(kachel);
  const label = document.createElement('span');
  label.className = 'sz-beschriftung';
  label.textContent = beschriftung;
  z.appendChild(label);
  z.addEventListener('click', klick);
  return z;
}

export function zeichneStatuszeile(el: HTMLDivElement, ampel: AmpelStand[], budget: BudgetStand | null): void {
  el.replaceChildren();
  for (const a of ampel) {
    // Der Titel sagt eingeklappt, WAS die Marke ueberhaupt ist -- ohne ihn
    // stuende dort ein Kuerzel ohne Gegenstand.
    const titel = `Pruefstand ${a.machine}: ${a.befunde.map((b) => b.text).join(' | ')}`;
    el.appendChild(zeile('sz-ampel', FARBKLASSE[a.farbe], maschinenkuerzel(a.machine), a.machine, titel, () => kurzHinweis(titel)));
  }
  if (budget) {
    const beschriftung = budget.ok ? `${kompakt(budget.heuteTokens)} heute` : 'Budget: n/v';
    const titel = budget.ok ? `Budget — ${budget.text}` : 'Budget: wb-budget nicht verfuegbar';
    // Sigma statt zweier Buchstaben: die Zeile ist die einzige, die keine
    // Maschine meint, sondern eine Summe. Der Unterschied soll schon an der
    // Form auffallen, nicht erst an der Aufschrift.
    //
    // DER KLICK OEFFNET DIE VERBRAUCHSSEITE. Bis zum 11.08. zeigte er denselben
    // einen Satz noch einmal, den der Titel schon trug -- eine Bedienung ohne
    // Gewinn. Der ganze Satz bleibt als Titel stehen, wo er im Vorbeigehen
    // reicht; wer mehr wissen will, kommt jetzt zu allen Zahlen.
    //
    // Unterschieden wird an `isTrusted`, nicht an einem Namen -- dieselbe
    // Auflage wie am Zahnrad und am Plus (renderer.ts, main/verbrauchsfenster.ts):
    // ein echter Klick schickt 'verbrauch-zeigen' und macht das Fenster
    // sichtbar, ein programmatischer schickt 'verbrauch-bauen' und kann es nur
    // bauen lassen.
    el.appendChild(
      zeile('sz-budget', 'ruhig', 'Σ', beschriftung, titel, (ereignis) => {
        window.awbBridge.bedienung(ereignis.isTrusted ? 'verbrauch-zeigen' : 'verbrauch-bauen', null);
      }),
    );
  }
}
