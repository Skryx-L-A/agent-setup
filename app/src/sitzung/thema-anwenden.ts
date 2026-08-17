// Farben durchreichen (11.08.), NUR fuer dieses Fenster. Eigene, winzige Datei
// statt eines Zusatzes in sitzung.ts: an sitzung.ts arbeitet parallel die
// Sprachschicht (Auftragslage), und die CSP dieses Fensters ('script-src
// self', kein 'unsafe-inline' fuer Skripte) laesst in index.html ohnehin kein
// Inline-<script> zu -- nur ein zweites <script src> vom eigenen Ursprung.
//
// Dieselbe Mechanik wie im Einstellungsfenster (einstellungen.ts,
// `themaAnwenden`) und im Hauptfenster (renderer.ts): `data-thema` traegt den
// von main/thema.ts AUFGELOESTEN Wert ('hell'/'dunkel'), nie 'system' -- kein
// Fenster hier rät selbst. Von den vier Zustandsfarben zeigt dieses Fenster
// nur zwei als eigene Marke (`.marke.laeuft`, `.marke.wartet`), siehe
// index.html.
//
// Die Bruecke (`window.awbSitzung`) deklariert sitzung.ts bereits global;
// hier wird bewusst NICHT dieselbe `declare global`-Erweiterung wiederholt --
// zwei Deklarationen derselben Eigenschaft in zwei Dateien muessten exakt
// gleich bleiben, sonst meldet der Typprüfer einen Widerspruch, sobald eine
// von beiden sich aendert. Ein enger, lokaler Typ fuer genau die zwei
// gebrauchten Methoden reicht.

interface ThemaPayload {
  thema: string;
  wirksam: 'hell' | 'dunkel';
  zustandsfarben: Record<string, string>;
  zustandsfarbenLesbar: Record<string, string>;
  zustandsfarbenTinte: Record<string, string>;
}

interface ThemaBruecke {
  thema(): Promise<ThemaPayload>;
  onThema(fn: (p: ThemaPayload) => void): void;
}

const bruecke = (window as unknown as { awbSitzung: ThemaBruecke }).awbSitzung;

// Testsonde: ein verstecktes Feld, dessen Wert der bestehende, unveraenderte
// Testhaken `window.__awbSitzung.zustand(auswahl)` (sitzung.ts) ohnehin lesen
// kann -- `.value` einer beliebigen Auswahl, ohne dass sitzung.ts einen
// eigenen Weg fuer Thema-Daten braucht. shell/tests/test-app-thema.sh liest
// darueber, ob eine Aenderung wirklich ankommt.
const sondeEl = document.getElementById('thema-testsonde') as HTMLInputElement | null;

function themaAnwenden(d: ThemaPayload): void {
  document.documentElement.dataset.thema = d.wirksam;
  document.documentElement.style.setProperty('--zustand-laeuft', d.zustandsfarbenLesbar.laeuft ?? '');
  document.documentElement.style.setProperty('--zustand-wartet', d.zustandsfarbenLesbar.wartet ?? '');
  if (sondeEl) {
    const stil = getComputedStyle(document.documentElement);
    sondeEl.value = JSON.stringify({
      dataThema: document.documentElement.dataset.thema ?? '',
      zustandLaeuft: stil.getPropertyValue('--zustand-laeuft').trim(),
      zustandWartet: stil.getPropertyValue('--zustand-wartet').trim(),
      grund: stil.getPropertyValue('--grund').trim(),
    });
  }
}

bruecke.onThema(themaAnwenden);
void bruecke.thema().then(themaAnwenden);
