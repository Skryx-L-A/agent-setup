// Die Oberfläche des geführten ersten Starts (SPEC-V4 3.8). Vier Schritte, jeder überspringbar --
// entschieden wird in ablauf.ts, hier wird nur gezeichnet und geklickt.
//
// WAS HIER NICHT GESCHIEHT: kein Fenster wird hier gezeigt. Dieses Skript läuft IM Fenster, das
// der Hauptprozess bereits mit `show:false` gebaut hat (erststartfenster.ts) -- ob es sichtbar
// wird, entscheidet ausschließlich der Hauptprozess.
import {
  anfang, mitKontext, schrittName, ueberspringen, weiter, SCHRITTE,
  type ErststartZustand, type SettingsSchreibung,
} from './ablauf';
import { setzeSprache, sprache, t } from './texte';

interface HarnessZeile { id: string; label: string; startbar: boolean }
/** `lokal`: läuft das Modell auf dieser Maschine? Nur dann gibt es ein Kontextfenster zu wählen. */
interface ModellZeile { id: string; label: string; harness: string; lokal: boolean }
interface AnmeldeZeile { stand: 'ja' | 'nein' | 'unbekannt'; grund: string }

/** Eine wählbare Kontextstufe -- dieselbe Form wie in main/kontext.ts. */
interface KontextStufe {
  tokens: number;
  label: string;
  bedarfGib: number;
  passt: boolean;
  hinweis: string | null;
}
interface KontextSicht { vorgabe: number; empfehlung: number; stufen: KontextStufe[] }
type KontextAntwort = { ok: true; sicht: KontextSicht } | { ok: false; fehler: string };

interface ErststartDaten {
  machine: string;
  maschinen: string[];
  /** Die Sprache der Oberflaeche -- dieselbe Ableitung wie im Einstellungsfenster. */
  sprache: string;
  harnesses: HarnessZeile[];
  orchestratorModelle: ModellZeile[];
  anmeldung: Record<string, AnmeldeZeile>;
  settings: { defaultWorkerMachine: string; orchestratorHarness: string; orchestratorModel: string };
  vorgaben: { defaultWorkerMachine: string; orchestratorHarness: string; orchestratorModel: string };
}

/** Farben durchreichen (11.08.): dieselbe Form wie in main/thema.ts. */
interface ThemaPayload {
  thema: string;
  wirksam: 'hell' | 'dunkel';
  zustandsfarben: Record<string, string>;
  zustandsfarbenLesbar: Record<string, string>;
  zustandsfarbenTinte: Record<string, string>;
}

declare global {
  interface Window {
    awbErststart: {
      daten(): Promise<ErststartDaten>;
      setzen(key: string, value: unknown): Promise<{ ok: boolean; ausgabe: string }>;
      bereit(): void;
      /** Die wählbaren Kontextfenster EINES lokalen Modells. Nur Lesen. */
      kontextStufen(modellId: string): Promise<KontextAntwort>;
      /** Farben durchreichen (11.08.): einmal alles, aus main/thema.ts. */
      thema(): Promise<ThemaPayload>;
      onThema(fn: (p: ThemaPayload) => void): void;
    };
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, klasse?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (klasse) e.className = klasse;
  if (text !== undefined) e.textContent = text;
  return e;
}

const titelEl = document.getElementById('titel') as HTMLElement;
const kopfUnterzeileEl = document.getElementById('kopf-unterzeile') as HTMLElement;
const fortschrittEl = document.getElementById('fortschritt') as HTMLElement;
const inhaltEl = document.getElementById('inhalt') as HTMLElement;
const weiterKnopf = document.getElementById('knopf-weiter') as HTMLButtonElement;
const ueberspringenKnopf = document.getElementById('knopf-ueberspringen') as HTMLButtonElement;

/** Die Texte, die sich nach dem ersten Zeichnen nicht mehr aendern -- die Sprache steht fest,
 * sobald die ersten Daten da sind. */
function kopfzeileBeschriften(): void {
  document.documentElement.lang = sprache();
  document.title = t('fenster.titel');
  titelEl.textContent = t('kopf.titel');
  kopfUnterzeileEl.textContent = t('kopf.unterzeile');
}

let zustand: ErststartZustand = anfang();
let daten: ErststartDaten | null = null;
/** Die gerade im aktuellen Schritt hervorgehobene Wahl -- lokal, bis "Weiter" sie einreicht. */
let laufendeWahl = '';

function schreibungenAusfuehren(schreibungen: SettingsSchreibung[]): Promise<void> {
  return schreibungen.reduce(
    (p, s) => p.then(() => window.awbErststart.setzen(s.key, s.value)).then(() => undefined),
    Promise.resolve(),
  );
}

function weiterKlick(): void {
  const { zustand: neu, schreibungen } = weiter(zustand, laufendeWahl);
  zustand = neu;
  void schreibungenAusfuehren(schreibungen).then(() => {
    if (zustand.abgeschlossen) window.close();
    else zeichnen();
  });
}

function ueberspringenKlick(): void {
  const { zustand: neu, schreibungen } = ueberspringen(zustand);
  zustand = neu;
  void schreibungenAusfuehren(schreibungen).then(() => {
    if (zustand.abgeschlossen) window.close();
    else zeichnen();
  });
}

weiterKnopf.addEventListener('click', weiterKlick);
ueberspringenKnopf.addEventListener('click', ueberspringenKlick);

function chipReihe(
  eintraege: { wert: string; label: string; zeichen?: string; zeichenKlasse?: string }[],
  vorbelegung: string,
  onWahl?: (wert: string) => void,
): HTMLElement {
  laufendeWahl = eintraege.some((e) => e.wert === vorbelegung) ? vorbelegung : (eintraege[0]?.wert ?? '');
  const reihe = el('div', 'chips');
  for (const eintrag of eintraege) {
    const knopf = el('button', 'chip') as HTMLButtonElement;
    knopf.type = 'button';
    if (eintrag.zeichen) {
      const z = el('span', `zeichen ${eintrag.zeichenKlasse ?? ''}`.trim(), eintrag.zeichen);
      knopf.appendChild(z);
    }
    knopf.appendChild(document.createTextNode(eintrag.label));
    if (eintrag.wert === laufendeWahl) knopf.classList.add('gewaehlt');
    knopf.addEventListener('click', () => {
      laufendeWahl = eintrag.wert;
      for (const k of reihe.querySelectorAll('.chip')) k.classList.remove('gewaehlt');
      knopf.classList.add('gewaehlt');
      onWahl?.(eintrag.wert);
    });
    reihe.appendChild(knopf);
  }
  return reihe;
}

function harnessZeichen(stand: AnmeldeZeile['stand']): { zeichen: string; klasse: string } {
  if (stand === 'ja') return { zeichen: t('harness.zeichen.ja'), klasse: 'ja' };
  if (stand === 'nein') return { zeichen: t('harness.zeichen.nein'), klasse: 'nein' };
  return { zeichen: t('harness.zeichen.unbekannt'), klasse: '' };
}

function schrittMaschine(d: ErststartDaten): HTMLElement {
  const frag = document.createDocumentFragment() as unknown as HTMLElement;
  frag.appendChild(el('h2', undefined, t('maschine.titel')));
  frag.appendChild(el('p', 'unterzeile', t('maschine.unterzeile')));
  const alle = ['local', ...d.maschinen];
  if (d.maschinen.length === 0) {
    frag.appendChild(el('p', 'hinweis', t('maschine.nurEine', d.machine)));
    laufendeWahl = 'local';
  } else {
    const eintraege = alle.map((m) => ({
      wert: m,
      label: m === 'local' ? t('maschine.diese', d.machine) : m,
    }));
    frag.appendChild(chipReihe(eintraege, d.settings.defaultWorkerMachine || d.vorgaben.defaultWorkerMachine));
  }
  return frag;
}

function schrittHarness(d: ErststartDaten): HTMLElement {
  const frag = document.createDocumentFragment() as unknown as HTMLElement;
  frag.appendChild(el('h2', undefined, t('harness.titel')));
  frag.appendChild(el('p', 'unterzeile', t('harness.unterzeile')));
  if (d.harnesses.length === 0) {
    frag.appendChild(el('p', 'hinweis', t('harness.keine')));
    return frag;
  }
  const eintraege = d.harnesses.map((h) => {
    const a = d.anmeldung[h.id];
    const z = harnessZeichen(a?.stand ?? 'unbekannt');
    return { wert: h.id, label: h.label, zeichen: z.zeichen, zeichenKlasse: z.klasse };
  });
  const vorbelegung = d.settings.orchestratorHarness || d.vorgaben.orchestratorHarness;
  const grundEl = el('p', 'grund');
  const grundSetzen = (harnessId: string) => { grundEl.textContent = d.anmeldung[harnessId]?.grund ?? ''; };
  frag.appendChild(chipReihe(eintraege, vorbelegung, grundSetzen));
  grundSetzen(laufendeWahl);
  frag.appendChild(grundEl);
  return frag;
}

/**
 * DAS KONTEXTFENSTER IM DRITTEN SCHRITT -- die zweite Frage derselben Seite.
 *
 * Sie erscheint nur, wenn das gerade gewählte Modell auf DIESER Maschine läuft:
 * bei einem Modell aus der Cloud gehört die Zahl dem Anbieter, und ein Feld
 * dafür wäre ein Schalter ohne Wirkung. Wer das Modell wechselt, sieht den
 * Block deshalb kommen und gehen.
 *
 * JEDE STUFE BLEIBT WÄHLBAR, auch die, für die der Speicher gerade nicht
 * reicht -- sie trägt ihren Hinweis und sonst nichts. Das ist des Nutzers
 * ausdrückliche Vorgabe und dieselbe Regel wie im Einstellungsfenster.
 */
const kontextStand: Record<string, KontextAntwort> = {};
const kontextLaeuft = new Set<string>();
/** Der Kasten unter den Modell-Chips. Er wird neu gefüllt, wenn die Wahl umspringt. */
let kontextKasten: HTMLElement | null = null;

function kontextFuellen(modellId: string, modelle: ModellZeile[]): void {
  const kasten = kontextKasten;
  if (!kasten) return;
  kasten.textContent = '';
  const modell = modelle.find((m) => m.id === modellId);
  if (!modell?.lokal) {
    // Kein lokales Modell: kein Feld, und eine etwaige frühere Antwort geht
    // wieder weg -- sonst schriebe der Abschluss eine Tokenzahl für ein Modell,
    // das gar kein wählbares Fenster hat.
    zustand = mitKontext(zustand, 0);
    return;
  }
  const antwort = kontextStand[modellId];
  if (!antwort) {
    kasten.appendChild(el('p', 'hinweis', t('kontext.wirdErmittelt')));
    if (!kontextLaeuft.has(modellId)) {
      kontextLaeuft.add(modellId);
      void window.awbErststart.kontextStufen(modellId)
        .then((a) => { kontextStand[modellId] = a; })
        .catch((e: unknown) => { kontextStand[modellId] = { ok: false, fehler: String(e) }; })
        .then(() => {
          kontextLaeuft.delete(modellId);
          // Nur nachziehen, wenn die Wahl inzwischen nicht weitergesprungen ist.
          if (laufendeWahl === modellId) kontextFuellen(modellId, modelle);
        });
    }
    return;
  }
  if (!antwort.ok) {
    kasten.appendChild(el('p', 'hinweis', t('kontext.nichtErmittelt', antwort.fehler)));
    zustand = mitKontext(zustand, 0);
    return;
  }
  const s = antwort.sicht;
  const bisher = zustand.antworten.kontext;
  const wert = typeof bisher === 'number' && s.stufen.some((x) => x.tokens === bisher)
    ? bisher
    : s.vorgabe;
  zustand = mitKontext(zustand, wert);

  kasten.appendChild(el('h3', undefined, t('kontext.titel')));
  kasten.appendChild(el('p', 'unterzeile', t('kontext.unterzeile')));
  const liste = el('div', 'kontextliste');
  for (const stufe of s.stufen) {
    const b = el('button', 'kontexteintrag') as HTMLButtonElement;
    b.type = 'button';
    b.dataset.kontext = String(stufe.tokens);
    b.dataset.passt = stufe.passt ? 'ja' : 'nein';
    if (stufe.tokens === (zustand.antworten.kontext ?? s.vorgabe)) b.classList.add('gewaehlt');
    const z1 = el('div', 'zeile1');
    z1.appendChild(el('span', undefined, stufe.label));
    if (stufe.tokens === s.empfehlung) {
      b.dataset.empfohlen = 'ja';
      // Ein knappes Kennwort statt eines Symbols -- die stehende Regel dieses
      // Hauses: keine Emojis, und der Rang ist ein Wort wert.
      z1.appendChild(el('span', 'marke', t('kontext.empfohlen')));
    }
    z1.appendChild(el('span', 'kennung', t('kontext.token', stufe.tokens)));
    b.appendChild(z1);
    // Wo der Speicher nicht reicht, steht der HINWEIS statt der knappen
    // Bedarfszeile: er nennt den Bedarf bereits samt dem, was frei ist.
    const eng = !stufe.passt && !!stufe.hinweis;
    const z2 = el('div', eng ? 'zeile2 kontexthinweis' : 'zeile2');
    z2.textContent = eng ? String(stufe.hinweis) : t('kontext.bedarf', stufe.bedarfGib.toFixed(1));
    b.appendChild(z2);
    b.addEventListener('click', () => {
      zustand = mitKontext(zustand, stufe.tokens);
      kontextFuellen(modellId, modelle);
    });
    liste.appendChild(b);
  }
  kasten.appendChild(liste);
}

function schrittModell(d: ErststartDaten): HTMLElement {
  const frag = document.createDocumentFragment() as unknown as HTMLElement;
  frag.appendChild(el('h2', undefined, t('modell.titel')));
  frag.appendChild(el('p', 'unterzeile', t('modell.unterzeile')));
  const harness = String(
    zustand.antworten.harness || d.settings.orchestratorHarness || d.vorgaben.orchestratorHarness,
  );
  const modelle = d.orchestratorModelle.filter((m) => m.harness === harness);
  kontextKasten = null;
  if (modelle.length === 0) {
    frag.appendChild(el('p', 'hinweis', t('modell.keine')));
    return frag;
  }
  const eintraege = modelle.map((m) => ({ wert: m.id, label: m.label }));
  frag.appendChild(chipReihe(
    eintraege,
    d.settings.orchestratorModel || d.vorgaben.orchestratorModel,
    (wert) => kontextFuellen(wert, modelle),
  ));
  const kasten = el('div', 'kontextblock');
  frag.appendChild(kasten);
  kontextKasten = kasten;
  // Auch die VORBELEGUNG ist eine Wahl -- der Block muss stehen, bevor jemand
  // etwas angeklickt hat.
  kontextFuellen(laufendeWahl, modelle);
  return frag;
}

const FERTIG_LABEL: Record<'maschine' | 'harness' | 'modell' | 'kontext', string> = {
  maschine: 'fertig.eintrag.maschine',
  harness: 'fertig.eintrag.harness',
  modell: 'fertig.eintrag.modell',
  kontext: 'fertig.eintrag.kontext',
};

function schrittFertig(): HTMLElement {
  const frag = document.createDocumentFragment() as unknown as HTMLElement;
  frag.appendChild(el('h2', undefined, t('fertig.titel')));
  frag.appendChild(el('p', 'unterzeile', t('fertig.unterzeile')));
  const eintraege = (Object.keys(zustand.antworten) as (keyof typeof FERTIG_LABEL)[])
    .filter((k) => zustand.antworten[k] !== undefined)
    .map((k) => t(FERTIG_LABEL[k], String(zustand.antworten[k])));
  if (eintraege.length === 0) {
    frag.appendChild(el('p', undefined, t('fertig.satz.nichtsGesetzt')));
  } else {
    frag.appendChild(el('p', undefined, t('fertig.satz.gesetzt', eintraege.join(', '))));
  }
  frag.appendChild(el('p', 'hinweis', t('fertig.satz.aendernWo')));
  return frag;
}

function zeichnen(): void {
  if (!daten) return;
  inhaltEl.textContent = '';
  const name = schrittName(zustand);
  const index = SCHRITTE.indexOf(name);
  fortschrittEl.textContent = t('fortschritt.schritt', index + 1, SCHRITTE.length);
  if (name === 'maschine') inhaltEl.appendChild(schrittMaschine(daten));
  else if (name === 'harness') inhaltEl.appendChild(schrittHarness(daten));
  else if (name === 'modell') inhaltEl.appendChild(schrittModell(daten));
  else inhaltEl.appendChild(schrittFertig());

  if (name === 'fertig') {
    weiterKnopf.textContent = t('knopf.fertig');
    ueberspringenKnopf.style.display = 'none';
  } else {
    weiterKnopf.textContent = t('knopf.weiter');
    ueberspringenKnopf.style.display = '';
    ueberspringenKnopf.textContent = t('knopf.ueberspringen');
  }
}

/**
 * Farben durchreichen (11.08.): dieselbe Mechanik wie in den anderen
 * Fenstern -- `data-thema` traegt den aufgeloesten Wert, nie 'system'.
 */
function themaAnwenden(d: ThemaPayload): void {
  document.documentElement.dataset.thema = d.wirksam;
}
window.awbErststart.onThema(themaAnwenden);
void window.awbErststart.thema().then(themaAnwenden);

void window.awbErststart.daten().then((d) => {
  daten = d;
  setzeSprache(d.sprache);
  kopfzeileBeschriften();
  zeichnen();
  window.awbErststart.bereit();
});
