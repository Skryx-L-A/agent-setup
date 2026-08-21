// Die Oberflaeche des Sitzungsfensters: EINE Seite.
//
// UMBAU VOM 06.08. Die Fassung davor hatte zwei Seiten -- „Neu" mit einem
// eigenen Ordnerbaum und „Fortsetzen" mit einer flachen Liste. Beides ist weg:
//
//   * Die Liste ist nach PROJEKTORDNER gruppiert, denn danach sucht man eine
//     Sitzung.
//
// JEDE SITZUNG STEHT DA, IMMER (11.08.). Bis heute war je Ordner nur die
// juengste sichtbar; die aelteren standen hinter einem Knopf „N weitere". Der
// Grund dafuer war die Uebersicht -- ein Ordner mit sechs Versuchen sollte nicht
// sechs Zeilen belegen und die anderen Projekte verdraengen.
//
// Er traegt fuer dieses Fenster nicht, und zwar gemessen: am laufenden Programm
// waren 9 von 30 bekannten Sitzungen nicht gezeichnet, darunter alle vier
// weiteren des Ordners ~/AI. Eine davon war die Sitzung, die alice nach der
// Kernel-Panik vom 10.08. gesucht hat; sie hatte kein Element im Fenster
// (`awb-ctl sitzung-zustand '.listenzeile[data-sitzung="…__7bd64a"]'` -> da:
// false), war also weder zu sehen noch anzuklicken. Wer eine Sitzung SUCHT,
// sucht sie an ihrem Namen -- und der Gruppenkopf zeigt den Ordner, nicht den
// Namen. Eine zweite Sitzung desselben Ordners war damit unauffindbar, obwohl
// genau sie der Fall ist, fuer den es dieses Fenster gibt.
//
// Die Uebersicht kostet das wenig: die Gruppen stehen nach Aktualitaet, wer
// nach einem Absturz sucht, findet oben. Und eine lange Liste laesst sich
// rollen; eine verborgene Zeile laesst sich nicht finden.
//   * Der Ordnerbaum ist durch den nativen Dialog von macOS ersetzt (main.ts,
//     `ordnerDialog`). Er kann alles, was der eigene Baum nicht konnte:
//     Seitenleiste, Suche, zuletzt benutzte Orte, einen Pfad tippen.
//
// DER NAME BLEIBT ALS FELD. Er ist der einzige Weg, zwei Sitzungen im selben
// Ordner auseinanderzuhalten (`wb-code --name`), und er kostet eine Zeile in
// der Fusszeile -- ihn wegzulassen haette gerade die Gruppen unlesbar gemacht,
// die es ohne ihn gar nicht erst gaebe.
//
// ES WIRD NICHTS GERECHNET. Ob eine Sitzung zurueckkommen kann und was mit ihrer
// Unterhaltung geschieht, entscheidet der Hauptprozess mit denselben Funktionen,
// die den Aufruf bauen (revive.ts). Gruppiert und sortiert wird hier, weil das
// eine Frage der Anzeige ist; was eine Sitzung IST, sagt weiter `readSessions`.
//
// BAUTEIL 1+2 VOM 11.08.: Maschinenwahl, Suche, Filter und Umschalter.
//
//   * NEUE SITZUNG kennt jetzt eine Maschine. Ohne eine einzige Fernmaschine
//     in den Einstellungen (`daten.remoteMachines`) aendert sich nichts -- der
//     native Dialog bleibt der einzige Weg. Mit einer oder mehreren steht vor
//     dem Knopf ein Waehler; die eigene Maschine bleibt beim Dialog, jede
//     andere bekommt ein Pfadfeld samt „Pruefen"-Knopf (`#neu-fern`), weil
//     der native Dialog nur zeigen kann, was HIER liegt.
//   * FORTSETZEN bekommt eine Suche (Name, Ordner, Maschine) und zwei
//     Chip-Reihen -- Maschine und Zustand --, beide ERZEUGT aus den Werten,
//     die in `daten.sitzungen` tatsaechlich vorkommen (app/src/sitzung/filter.ts,
//     `chipsAus`), NIE aus einer mitgebrachten Liste. Eine Reihe mit hoechstens
//     einem Wert entfaellt -- ein Umschalter mit einer Stellung ist keiner.
//     Vorbild fuer Suche und Chips: einstellungen.ts, `modellwahl` (Zeilen
//     546-614) -- dieselbe Bedienlogik, damit sich das Programm einheitlich
//     anfuehlt.
//   * DIE FILTERUNG AENDERT NICHTS AM 11.08.-SCHUTZ GEGEN VERBORGENE ZEILEN:
//     ohne Suchtext und mit beiden Umschaltern auf 'alle' (die Vorgabe) zeigt
//     die Liste weiter JEDE bekannte Sitzung -- der Testhaken `gruppen()`
//     misst das weiter gegen `daten.sitzungen` und bleibt bei 0 Verborgenen,
//     solange kein Filter aktiv ist.
import { chipsAus, zeilePasstMaschine, zeilePasstSuche, zeilePasstZustand } from './filter';
import { setzeSprache, sprache, t } from './texte';

interface SitzungsZeile {
  id: string;
  name: string;
  dir: string;
  machine: string;
  harness: string;
  model: string;
  state: string;
  lastActive: string;
  fortsetzbar: boolean;
  grund: string;
  unterhaltung: string;
  /** Fuer diesen Ordner laeuft gerade ein Start (21.08.). */
  startet?: boolean;
  /** Der letzte Start fuer diesen Ordner ist gescheitert (21.08.). */
  startFehler?: boolean;
}

interface Daten {
  machine: string;
  /** Fuer welche Maschinen sich eine neue Sitzung anlegen laesst -- leer bei einem Ein-Rechner-Nutzer. */
  remoteMachines: string[];
  /** Die Sprache der Oberflaeche -- dieselbe Ableitung wie im Einstellungsfenster. */
  sprache: string;
  sitzungen: SitzungsZeile[];
}

interface Antwort {
  ok: boolean;
  meldung: string;
  /** Der Aufruf, der wirklich abgesetzt wurde -- leer, wenn nichts lief. */
  command: string;
}

// --- Der dritte Weg (19.08.): eine Wahl nur fuer diese Sitzung -------------

interface WahlHarness { id: string; label: string; binaer: boolean }
interface WahlModell {
  id: string;
  label: string;
  harness: string;
  harnessLabel: string;
  /** Laeuft hier auf der Maschine -- nur dann gibt es ein Kontextfenster zu waehlen. */
  lokal: boolean;
  startbar: boolean;
}
interface WahlDaten {
  harnesses: WahlHarness[];
  modelle: WahlModell[];
  harnessStufen: Record<string, string[]>;
  einstellung: { harness: string; model: string; effort: string; kontext: number };
}

/** Eine waehlbare Kontextstufe -- dieselbe Form wie in main/kontext.ts. */
interface KontextStufe {
  tokens: number;
  label: string;
  bedarfGib: number;
  passt: boolean;
  hinweis: string | null;
}
interface KontextSicht { vorgabe: number; empfehlung: number; stufen: KontextStufe[] }
type KontextAntwort = { ok: true; sicht: KontextSicht } | { ok: false; fehler: string };

/** Die Wahl, so wie sie an `wb-code` geht. Ein leeres Feld erzeugt keinen Schalter. */
interface Wahl { harness: string; model: string; effort: string; kontext: number }

declare global {
  interface Window {
    awbSitzung: {
      daten(): Promise<Daten>;
      neu(name: string, machine: string, fernPfad: string, echt: boolean): Promise<Antwort>;
      neuChat(name: string, echt: boolean): Promise<Antwort>;
      /** Was zur Wahl steht -- auf Abruf, siehe main.ts bei 'awb:sitz-wahl-daten'. */
      wahlDaten(): Promise<WahlDaten>;
      /** Die waehlbaren Kontextfenster EINES lokalen Modells. Nur Lesen. */
      kontextStufen(modellId: string): Promise<KontextAntwort>;
      /** Wie `neu()`, nur mit der Wahl im Gepaeck. Schreibt keine Einstellung. */
      neuMitWahl(name: string, machine: string, fernPfad: string, wahl: Wahl, echt: boolean): Promise<Antwort>;
      fernPruefen(machine: string, pfad: string): Promise<{ ok: boolean; meldung: string }>;
      fortsetzen(id: string): Promise<Antwort>;
      beenden(id: string, echt: boolean): Promise<Antwort>;
      onDaten(fn: (d: Daten) => void): void;
      onStartfehler(fn: (p: { ort: string; kurz: string; grund: string; protokoll: string }) => void): void;
      bereit(): void;
    };
    /** Testhaken: was steht gerade da, und was ist gewaehlt. Nur Lesen und Klicken. */
    __awbSitzung: {
      text(): string;
      status(): string;
      klick(auswahl: string): boolean;
      /** Ein Bedienelement LESEN, ohne es anzufassen. */
      zustand(auswahl: string): {
        da: boolean;
        gesperrt: boolean;
        wert: string;
        text: string;
        optionen: string[];
        angezeigt: boolean;
      };
      /**
       * Die Gruppen, so wie sie gezeichnet sind. `verborgen` wird GEMESSEN --
       * bekannte Sitzungen dieser Gruppe minus gezeichnete Zeilen -- und ist
       * damit die Wache gegen den Fehler vom 11.08.: sie steht auf 0, solange
       * das Fenster wirklich alles zeigt, und niemand kann sie auf 0 lassen,
       * indem er das Verbergen wieder einbaut.
       */
      gruppen(): { schluessel: string; kopf: string; sichtbar: string[]; verborgen: number }[];
      /** Die gezeichneten Sitzungszeilen. */
      sitzungen(): { id: string; text: string; gewaehlt: boolean; fortsetzbar: boolean }[];
    };
  }
}

interface Gruppe {
  /** Maschine und Ordner zusammen -- derselbe Pfad auf zwei Rechnern ist nicht derselbe Ort. */
  schluessel: string;
  dir: string;
  machine: string;
  /** Absteigend nach letzter Aktivitaet; die erste ist die sichtbare. */
  zeilen: SitzungsZeile[];
}

let daten: Daten | null = null;
/** Welche Sitzung gewaehlt ist (leer = keine). */
let gewaehlteSitzung = '';
/**
 * Der eingetippte Name. Er lebt hier und nicht im Feld, weil jede Antwort das
 * Fenster neu zeichnet -- ein Name, der dabei verschwindet, wird kein zweites
 * Mal eingetippt.
 */
let nameWert = '';
/** Laeuft gerade ein Start? Dann ist kein zweiter erlaubt. */
let beschaeftigt = false;
/**
 * Auf welcher Maschine die naechste „Neue Sitzung" entstehen soll -- leer, bis
 * die ersten Daten da sind, danach immer eine gueltige Wahl (die eigene
 * Maschine oder eine aus `daten.remoteMachines`). `zeichneMaschinenwahl`
 * faengt eine Wahl ab, die es nicht mehr gibt (z.B. eine aus den
 * Einstellungen entfernte Fernmaschine).
 */
let maschineWert = '';
/** Der eingetippte Fernpfad, aus demselben Grund gemerkt wie `nameWert`. */
let fernPfadWert = '';
/** Antwort des letzten „Pruefen"-Klicks -- leer, solange keiner stattfand. */
let fernStatus = '';
let fernStatusArt: 'gut' | 'fehler' | '' = '';
/** Laeuft gerade eine Fernpruefung? Verhindert einen zweiten Klick waehrenddessen. */
let fernPrueftGerade = false;
/** Der eingetippte Suchtext, aus demselben Grund gemerkt wie `nameWert`. */
let sucheWert = '';
/** Gewaehlter Maschinen-Chip ('alle' = kein Filter). */
let maschineFilter = 'alle';
/** Gewaehlter Zustands-Chip ('alle' = kein Filter). */
let zustandFilter = 'alle';

// --- Zustand des dritten Weges (19.08.) ------------------------------------
//
// Er lebt neben dem uebrigen Zustand und nicht darin: die Wahl gilt einem
// STARTVORGANG, nicht der Liste, und sie verschwindet mit dem Zuklappen.
/** Steht die Wahl offen? Zu heisst: der schnelle Weg ist der einzige sichtbare. */
let wahlOffen = false;
/** Was zur Wahl steht -- null, solange es noch nicht geholt ist. */
let wahlDaten: WahlDaten | null = null;
/** Warum das Holen scheiterte -- leer, solange nichts scheiterte. */
let wahlFehler = '';
/** Laeuft das Holen gerade? Verhindert einen zweiten Aufruf beim Neuzeichnen. */
let wahlLaedt = false;
/**
 * Wurde schon einmal geholt? Ein GESCHEITERTER Versuch wird genauso gemerkt wie
 * ein gelungener -- sonst versuchte es jedes Neuzeichnen erneut, und ein
 * dauerhaft scheiternder Aufruf haenge sich in eine Endlosschleife aus Holen
 * und Zeichnen. Dieselbe Sicherung wie im Einstellungsfenster.
 */
let wahlVersucht = false;
/** Die getroffene Wahl. Vorbelegt aus den Einstellungen, sobald `wahlDaten` da ist. */
const wahl: Wahl = { harness: '', model: '', effort: '', kontext: 0 };
/** Der Suchtext der Modellliste, aus demselben Grund gemerkt wie `nameWert`. */
let wahlSuche = '';
/** Die Kontextstufen je Modell-Kennung, geholt auf Abruf. */
const kontextStand: Record<string, KontextAntwort> = {};
const kontextLaeuft = new Set<string>();

const gruppenEl = document.getElementById('gruppen') as HTMLElement;
const statusEl = document.getElementById('statuszeile') as HTMLElement;
const grundEl = document.getElementById('fort-grund') as HTMLElement;
const fortKnopf = document.getElementById('fort-start') as HTMLButtonElement;
const beendenKnopf = document.getElementById('beenden-start') as HTMLButtonElement;
const neuKnopf = document.getElementById('neu-start') as HTMLButtonElement;
const neuChatKnopf = document.getElementById('neu-chat') as HTMLButtonElement;
const neuWahlKnopf = document.getElementById('neu-wahl') as HTMLButtonElement;
const wahlBlockEl = document.getElementById('neu-wahl-block') as HTMLElement;
const nameFeld = document.getElementById('neu-name') as HTMLInputElement;
const kopfStartEl = document.getElementById('kopf-start') as HTMLElement;
const fernEl = document.getElementById('neu-fern') as HTMLElement;
const fernPfadFeld = document.getElementById('neu-fern-pfad') as HTMLInputElement;
const fernOrdnerListe = document.getElementById('neu-fern-ordner') as HTMLDataListElement;
const fernPruefenKnopf = document.getElementById('neu-fern-pruefen') as HTMLButtonElement;
const fernStatusEl = document.getElementById('neu-fern-status') as HTMLElement;
const maschineChipsEl = document.getElementById('maschine-chips') as HTMLElement;
const zustandChipsEl = document.getElementById('zustand-chips') as HTMLElement;
const suchFeld = document.getElementById('such-feld') as HTMLInputElement;
const titelEl = document.getElementById('kopf-titel') as HTMLElement;
const unterzeileEl = document.getElementById('kopf-unterzeile') as HTMLElement;

/**
 * Die Texte, die sich waehrend der Laufzeit dieses Fensters nicht mehr aendern -- die Sprache
 * steht fest, sobald die ersten Daten da sind (`onDaten`/der Anlauf unten). Alles, was sich JE
 * ZEICHNEN neu ergibt (Zustandsmarken, Chip-Beschriftungen, der Fern-Platzhalter), fragt `t()`
 * direkt in `zeichne()` ab.
 */
function beschriften(): void {
  document.documentElement.lang = sprache();
  document.title = t('fenster.titel');
  titelEl.textContent = t('kopf.titel');
  unterzeileEl.textContent = t('kopf.unterzeile');
  nameFeld.placeholder = t('platzhalter.name');
  neuKnopf.textContent = t('knopf.neu');
  neuChatKnopf.textContent = t('knopf.neuChat');
  fernPfadFeld.placeholder = t('platzhalter.fernpfadVorgabe');
  fernPruefenKnopf.textContent = t('knopf.pruefen');
  suchFeld.placeholder = t('platzhalter.suche');
  beendenKnopf.textContent = t('knopf.beenden');
  fortKnopf.textContent = t('knopf.fortsetzen');
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  klasse?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (klasse) e.className = klasse;
  if (text !== undefined) e.textContent = text;
  return e;
}

function melde(text: string, art: 'gut' | 'fehler' | '' = ''): void {
  statusEl.textContent = text;
  statusEl.className = art;
}

/**
 * Der Zeitpunkt der letzten Aktivitaet, kurz. Er entscheidet die Wahl mit --
 * deshalb Tag und Uhrzeit und nicht "vor 3 Tagen": eine Sitzung von gestern
 * abend und eine von gestern frueh sehen sonst gleich aus.
 */
function wann(iso: string): string {
  if (!iso) return t('zeit.nieAktiv');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}. ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Der Zustand als kurzes Wort samt Farbe -- dieselben vier wie in der Leiste,
 * und seit dem 21.08. zwei Faelle davor.
 *
 * WARUM DIE BEIDEN VORNE STEHEN: Ihr `state` ist 'stopped', und das Wort dazu
 * hiess bis heute "beendet". Genau dieses Wort hat alice gelesen, waehrend
 * sein Modell noch geladen wurde -- eine Sitzung, die gerade entsteht, sah aus
 * wie eine, die vorbei ist. Beendet, noch-nicht-da und gescheitert sind drei
 * verschiedene Auskuenfte, und nur die erste darf "beendet" heissen.
 */
function zustandMarke(state: string, startet = false, startFehler = false): { text: string; klasse: string } {
  if (startet) return { text: t('zustand.startet'), klasse: 'marke wartet' };
  if (startFehler) return { text: t('zustand.startFehler'), klasse: 'marke' };
  if (state === 'running') return { text: t('zustand.laeuft'), klasse: 'marke laeuft' };
  if (state === 'attention') return { text: t('zustand.wartet'), klasse: 'marke wartet' };
  if (state === 'unreachable') return { text: t('zustand.fern'), klasse: 'marke fern' };
  return { text: t('zustand.beendet'), klasse: 'marke' };
}

/** Der letzte Teil des Pfades -- der Name, unter dem man ein Projekt kennt. */
function ordnerName(dir: string): string {
  const teile = dir.split('/').filter(Boolean);
  return teile.length ? teile[teile.length - 1] : dir || t('satz.ohneOrdner');
}

/**
 * Aus der flachen Liste die Gruppen.
 *
 * Die Liste kommt bereits absteigend nach letzter Aktivitaet herein (main.ts,
 * `sitzungsZeilen`). Eine Map behaelt die Einfuegereihenfolge -- damit steht
 * jede Gruppe genau dort, wo ihre JUENGSTE Sitzung stuende, und die Zeilen
 * innerhalb einer Gruppe stehen aus demselben Grund richtig. Zweimal zu
 * sortieren waere eine zweite Vorstellung von "aktuell".
 */
function gruppiere(zeilen: SitzungsZeile[]): Gruppe[] {
  const map = new Map<string, Gruppe>();
  for (const z of zeilen) {
    const schluessel = `${z.machine} ${z.dir}`;
    const da = map.get(schluessel);
    if (da) da.zeilen.push(z);
    else map.set(schluessel, { schluessel, dir: z.dir, machine: z.machine, zeilen: [z] });
  }
  return [...map.values()];
}

function zeileBauen(z: SitzungsZeile): HTMLButtonElement {
  const klassen = ['listenzeile'];
  if (!z.fortsetzbar) klassen.push('tot');
  if (z.id === gewaehlteSitzung) klassen.push('gewaehlt');
  const zeile = el('button', klassen.join(' ')) as HTMLButtonElement;
  zeile.type = 'button';
  zeile.dataset.sitzung = z.id;
  zeile.dataset.fortsetzbar = z.fortsetzbar ? '1' : '0';

  const z1 = el('div', 'zeile1');
  z1.appendChild(el('span', undefined, z.name));
  const marke = zustandMarke(z.state, z.startet, z.startFehler);
  z1.appendChild(el('span', marke.klasse, marke.text));
  zeile.appendChild(z1);

  // Der Ordner steht im Gruppenkopf und fehlt hier absichtlich. Uebrig bleibt,
  // was zwei Sitzungen DESSELBEN Ordners unterscheidet: womit sie lief und wann
  // sie zuletzt etwas getan hat.
  const womit = z.model ? `${z.harness} · ${z.model}` : (z.harness || 'claude');
  zeile.appendChild(el('div', 'zeile2', `${womit} — ${wann(z.lastActive)}`));

  zeile.addEventListener('click', () => {
    gewaehlteSitzung = z.id;
    zeichne();
  });
  return zeile;
}

/**
 * Der Waehler vor „Neue Sitzung …". Er ENTSTEHT nur, wenn `remoteMachines`
 * wenigstens einen Eintrag traegt -- sonst bliebe ein Waehler mit einer
 * einzigen Stellung stehen, und genau das soll ein Ein-Rechner-Nutzer nie
 * sehen (Auftrag: „kein leerer Waehler"). Das Element selbst wird
 * WIEDERVERWENDET, nur seine Optionen werden nachgezogen -- damit ein Klick
 * mitten in einer offenen Liste sie nicht unter der Maus wegzieht.
 */
function zeichneMaschinenwahl(): void {
  if (!daten || daten.remoteMachines.length === 0) {
    document.getElementById('neu-maschine')?.remove();
    maschineWert = daten?.machine ?? '';
    return;
  }
  const optionen = [daten.machine, ...daten.remoteMachines];
  if (!optionen.includes(maschineWert)) maschineWert = daten.machine;

  let sel = document.getElementById('neu-maschine') as HTMLSelectElement | null;
  if (!sel) {
    sel = el('select') as HTMLSelectElement;
    sel.id = 'neu-maschine';
    sel.addEventListener('change', () => {
      maschineWert = sel!.value;
      fernStatus = '';
      fernStatusArt = '';
      zeichne();
    });
    kopfStartEl.insertBefore(sel, neuKnopf);
  }
  sel.textContent = '';
  for (const m of optionen) {
    const o = el('option') as HTMLOptionElement;
    o.value = m;
    o.textContent = m === daten.machine ? t('satz.dieseMaschine', { maschine: m }) : m;
    sel.appendChild(o);
  }
  sel.value = maschineWert;
  sel.disabled = beschaeftigt;
}

/**
 * Der Pfad auf einer FERNEN Maschine. Der native Ordner-Dialog zeigt nur, was
 * HIER liegt -- fuer jede andere Maschine bleibt nur ein Textfeld samt einem
 * eigenen „Pruefen"-Knopf, der GENAU DIE Pruefung vorwegnimmt, die
 * `sessionAnlegen` sonst erst beim Start selbst durchfuehrt (main.ts,
 * `fernOrdnerPruefen`). Die Elemente stehen FEST im HTML und werden nur
 * ein-/ausgeblendet -- kein Neuaufbau, sonst risse jedes Zeichnen den Fokus
 * aus dem Feld, waehrend jemand noch tippt.
 */
function zeichneFernZeile(): void {
  const zeigen = !!daten && maschineWert !== daten.machine;
  fernEl.style.display = zeigen ? 'flex' : 'none';
  if (!zeigen) return;
  fernPfadFeld.placeholder = t('platzhalter.fernpfad', { maschine: maschineWert });
  if (fernPfadFeld.value !== fernPfadWert) fernPfadFeld.value = fernPfadWert;
  fernPruefenKnopf.disabled = beschaeftigt || fernPrueftGerade;
  fernStatusEl.textContent = fernStatus;
  fernStatusEl.style.color = fernStatusArt === 'fehler' ? 'var(--aus)' : (fernStatusArt === 'gut' ? 'var(--laeuft)' : '');

  // Vorschlaege fuer das Pfadfeld: die Ordner, die fuer GENAU diese Maschine
  // schon als Sitzung bekannt sind -- nichts geraten, nur was schon einmal
  // getippt wurde (Ergaenzung des Nutzers vom 11.08.). Eine Menge, weil derselbe
  // Ordner mehrere Sitzungen tragen kann.
  const bekannt = [...new Set(
    (daten?.sitzungen ?? []).filter((z) => z.machine === maschineWert).map((z) => z.dir),
  )];
  fernOrdnerListe.textContent = '';
  for (const dir of bekannt) {
    const o = el('option') as HTMLOptionElement;
    o.value = dir;
    fernOrdnerListe.appendChild(o);
  }
}

/**
 * Eine Chip-Reihe zeichnen -- dieselbe Bauform wie `modellwahl` in
 * einstellungen.ts, nur einmal geschrieben statt zweimal (Maschine UND
 * Zustand brauchen sie). Leer bleibt die Reihe leer: `chipsAus` liefert dann
 * selbst nichts, siehe app/src/sitzung/filter.ts.
 */
function zeichneChipZeile(
  el2: HTMLElement,
  chips: { wert: string; label: string }[],
  gewaehlt: string,
  auf: (wert: string) => void,
): void {
  el2.textContent = '';
  for (const c of chips) {
    const b = el('button') as HTMLButtonElement;
    b.type = 'button';
    b.textContent = c.label;
    b.dataset.filter = c.wert;
    if (c.wert === gewaehlt) b.classList.add('gewaehlt');
    b.addEventListener('click', () => auf(c.wert));
    el2.appendChild(b);
  }
}

// --- Die Wahl fuer genau diese Sitzung (19.08.) ----------------------------
//
// VIER FRAGEN UNTEREINANDER, und jede ist vorbelegt mit dem, was in den
// Einstellungen steht. Wer nur eine Sache anders will, aendert eine Sache --
// das ist der ganze Zweck dieses Weges (Wort des Nutzers: „damit man … nicht
// erst in die Einstellungen muss und sie danach wieder zurueckstellt").
//
// GESCHRIEBEN WIRD HIER NICHTS. Es gibt in diesem ganzen Block keinen Aufruf,
// der eine Einstellung setzt; die Wahl reist als Befehlszeile mit und endet mit
// der Sitzung. Nachgewiesen wird das an der Datei selbst, nicht an dieser
// Zusage.
//
// DIE KONTEXTSTUFEN kommen ueber denselben Kanal wie im Einstellungsfenster
// und tragen dieselbe Regel: alle Stufen sichtbar, auch die, fuer die der
// Speicher nicht reicht -- mit Hinweis, nie mit Sperre.

function wahlHolen(): void {
  if (wahlLaedt || wahlVersucht) return;
  wahlLaedt = true;
  wahlVersucht = true;
  wahlFehler = '';
  void window.awbSitzung.wahlDaten()
    .then((d) => {
      wahlDaten = d;
      // Vorbelegen -- aber nur, was noch nicht von Hand gesetzt wurde.
      if (!wahl.harness) wahl.harness = d.einstellung.harness;
      if (!wahl.model) wahl.model = d.einstellung.model;
      if (!wahl.effort) wahl.effort = d.einstellung.effort;
      if (!wahl.kontext) wahl.kontext = d.einstellung.kontext;
    })
    .catch((e: unknown) => { wahlFehler = String((e as Error)?.message ?? e); })
    .then(() => { wahlLaedt = false; zeichne(); });
}

function kontextHolen(modellId: string): void {
  if (!modellId || kontextLaeuft.has(modellId) || kontextStand[modellId]) return;
  kontextLaeuft.add(modellId);
  void window.awbSitzung.kontextStufen(modellId)
    .then((a) => { kontextStand[modellId] = a; })
    .catch((e: unknown) => { kontextStand[modellId] = { ok: false, fehler: String(e) }; })
    .then(() => { kontextLaeuft.delete(modellId); zeichne(); });
}

/** Eine Zeile des Wahlblocks: Name, Steuerelement, optional ein Hinweis darunter. */
function wahlZeile(name: string, steuer: HTMLElement, hinweis?: string): HTMLElement {
  const z = el('div', 'wahlzeile');
  z.dataset.wahl = name;
  z.appendChild(el('div', 'wahlname', name));
  z.appendChild(steuer);
  if (hinweis) z.appendChild(el('div', 'wahlhinweis', hinweis));
  return z;
}

/** Ein zweizeiliger Listeneintrag -- dieselbe Bauform wie die Modellliste der Einstellungen. */
function wahlEintrag(
  zeile1: HTMLElement,
  zeile2: HTMLElement | undefined,
  gewaehlt: boolean,
  auf: () => void,
): HTMLButtonElement {
  const b = el('button', gewaehlt ? 'wahleintrag gewaehlt' : 'wahleintrag') as HTMLButtonElement;
  b.type = 'button';
  b.appendChild(zeile1);
  if (zeile2) b.appendChild(zeile2);
  b.addEventListener('click', auf);
  return b;
}

/** Die Flaggen, die beim Start wirklich mitgehen -- wortwoertlich, VOR dem Klick. */
function wahlFlaggen(modell: WahlModell | undefined, stufen: string[]): string[] {
  const f: string[] = [];
  if (wahl.harness) f.push('--harness', wahl.harness);
  if (wahl.model) f.push('--model', wahl.model);
  if (wahl.effort && stufen.includes(wahl.effort)) f.push('--effort', wahl.effort);
  if (modell?.lokal && wahl.kontext > 0) f.push('--kontext', String(wahl.kontext));
  return f;
}

function zeichneWahlblock(): void {
  neuWahlKnopf.textContent = wahlOffen ? t('knopf.neuWahlZu') : t('knopf.neuWahl');
  neuWahlKnopf.disabled = beschaeftigt;
  wahlBlockEl.style.display = wahlOffen ? 'block' : 'none';
  // Die Gewichtung des Platzes haengt an dieser einen Klasse (index.html):
  // solange die Wahl offen ist, gehoert ihr der Raum, die Sitzungsliste
  // behaelt einen Rest.
  document.body.classList.toggle('wahl-offen', wahlOffen);
  if (!wahlOffen) return;
  wahlBlockEl.textContent = '';

  if (!wahlDaten) {
    wahlHolen();
    wahlBlockEl.appendChild(el('div', 'wahlhinweis',
      wahlFehler ? t('wahl.ladefehler', { grund: wahlFehler }) : t('wahl.laedt')));
    return;
  }
  const d = wahlDaten;
  wahlBlockEl.appendChild(el('div', 'wahlname', t('wahl.titel')));
  wahlBlockEl.appendChild(el('div', 'wahlhinweis', t('wahl.unterzeile')));

  // --- Programm ------------------------------------------------------------
  const harnessReihe = el('div', 'filterzeile');
  for (const h of d.harnesses) {
    const b = el('button') as HTMLButtonElement;
    b.type = 'button';
    b.textContent = h.binaer ? h.label : `${h.label} · ${t('wahl.nichtStartbar')}`;
    b.dataset.wahlHarness = h.id;
    if (h.id === wahl.harness) b.classList.add('gewaehlt');
    b.addEventListener('click', () => {
      if (wahl.harness === h.id) return;
      wahl.harness = h.id;
      // Ein Modell eines anderen Programms waere nach dem Wechsel nicht mehr
      // waehlbar -- also faellt es weg, und die erste Wahl des neuen Programms
      // tritt an seine Stelle. Ein Modell stehen zu lassen, das zum gewaehlten
      // Programm nicht gehoert, ergaebe eine Startzeile, die nicht laeuft.
      const passend = d.modelle.filter((m) => m.harness === h.id);
      wahl.model = passend.some((m) => m.id === wahl.model) ? wahl.model : (passend[0]?.id ?? '');
      const stufen = d.harnessStufen[h.id] ?? [];
      if (!stufen.includes(wahl.effort)) wahl.effort = stufen[stufen.length - 1] ?? '';
      wahl.kontext = 0;
      wahlSuche = '';
      zeichne();
    });
    harnessReihe.appendChild(b);
  }
  wahlBlockEl.appendChild(wahlZeile(t('wahl.harness'), harnessReihe));

  // --- Modell --------------------------------------------------------------
  const eigene = d.modelle.filter((m) => m.harness === wahl.harness);
  const modellKasten = el('div');
  if (eigene.length === 0) {
    modellKasten.appendChild(el('div', 'wahlhinweis', t('wahl.keinModell')));
  } else {
    const suchfeld = el('input', 'modellsuche') as HTMLInputElement;
    suchfeld.type = 'text';
    suchfeld.placeholder = t('wahl.platzhalterSuche');
    suchfeld.value = wahlSuche;
    suchfeld.dataset.wahlSuche = '1';
    suchfeld.spellcheck = false;
    suchfeld.addEventListener('input', () => {
      wahlSuche = suchfeld.value;
      zeichne();
      // Nach dem Neuzeichnen steht ein neues Feld da -- der Fokus muss mit,
      // sonst reisst das Tippen nach dem ersten Zeichen ab (derselbe Befund
      // wie im Einstellungsfenster).
      const neu = wahlBlockEl.querySelector<HTMLInputElement>('input[data-wahl-suche="1"]');
      if (neu) {
        neu.focus();
        neu.setSelectionRange(neu.value.length, neu.value.length);
      }
    });
    modellKasten.appendChild(suchfeld);

    const suche = wahlSuche.trim().toLowerCase();
    const passt = (m: WahlModell): boolean => !suche
      || m.label.toLowerCase().includes(suche) || m.id.toLowerCase().includes(suche);
    // Das Gewaehlte steht immer oben, auch wenn die Suche es sonst wegnaehme --
    // sonst sieht man nicht mehr, was gerade gilt.
    const dasGewaehlte = eigene.find((m) => m.id === wahl.model);
    const zeigen = [
      ...(dasGewaehlte ? [dasGewaehlte] : []),
      ...eigene.filter((m) => m.id !== wahl.model && passt(m)),
    ];
    const liste = el('div', 'wahlliste');
    if (zeigen.length === 0) liste.appendChild(el('div', 'wahlhinweis', t('wahl.keinTreffer')));
    for (const m of zeigen) {
      const z1 = el('div', 'zeile1');
      z1.appendChild(el('span', undefined, `${m.id === wahl.model ? '● ' : '○ '}${m.label}`));
      z1.appendChild(el('span', 'kennung', m.id));
      const z2 = el('div', 'zeile2', m.startbar
        ? m.harnessLabel
        : `${m.harnessLabel} · ${t('wahl.nichtStartbar')}`);
      const b = wahlEintrag(z1, z2, m.id === wahl.model, () => {
        if (wahl.model === m.id) return;
        wahl.model = m.id;
        // Das Kontextfenster gehoert dem Modell -- ein Wechsel nimmt die alte
        // Tokenzahl mit, sonst ginge eine Stufe mit, die dieses Modell gar
        // nicht anbietet.
        wahl.kontext = 0;
        zeichne();
      });
      b.dataset.wahlModell = m.id;
      liste.appendChild(b);
    }
    modellKasten.appendChild(liste);
  }
  wahlBlockEl.appendChild(wahlZeile(t('wahl.modell'), modellKasten));

  // --- Denkstufe -----------------------------------------------------------
  const stufen = d.harnessStufen[wahl.harness] ?? [];
  if (stufen.length === 0) {
    wahlBlockEl.appendChild(wahlZeile(t('wahl.effort'), el('div', 'wahlhinweis', t('wahl.keineStufen'))));
  } else {
    const stufenReihe = el('div', 'filterzeile');
    for (const s of stufen) {
      const b = el('button') as HTMLButtonElement;
      b.type = 'button';
      b.textContent = s;
      b.dataset.wahlEffort = s;
      if (s === wahl.effort) b.classList.add('gewaehlt');
      b.addEventListener('click', () => {
        wahl.effort = s;
        zeichne();
      });
      stufenReihe.appendChild(b);
    }
    wahlBlockEl.appendChild(wahlZeile(t('wahl.effort'), stufenReihe));
  }

  // --- Kontextfenster, nur bei einem lokalen Modell ------------------------
  const modell = d.modelle.find((m) => m.id === wahl.model);
  if (modell?.lokal) {
    const antwort = kontextStand[modell.id];
    if (!antwort) {
      kontextHolen(modell.id);
      wahlBlockEl.appendChild(wahlZeile(
        t('wahl.kontext'), el('div', 'wahlhinweis', t('wahl.kontextWirdErmittelt')),
      ));
    } else if (!antwort.ok) {
      wahlBlockEl.appendChild(wahlZeile(
        t('wahl.kontext'),
        el('div', 'wahlhinweis', t('wahl.kontextNichtErmittelt', { grund: antwort.fehler })),
      ));
    } else {
      const s = antwort.sicht;
      if (!wahl.kontext) wahl.kontext = s.vorgabe;
      const liste = el('div', 'wahlliste');
      for (const stufe of s.stufen) {
        const z1 = el('div', 'zeile1');
        z1.appendChild(el('span', undefined,
          `${stufe.tokens === wahl.kontext ? '● ' : '○ '}${stufe.label}`));
        if (stufe.tokens === s.empfehlung) {
          z1.appendChild(el('span', 'marke', t('wahl.kontextEmpfohlen')));
        }
        z1.appendChild(el('span', 'kennung', t('wahl.kontextToken', { tokens: stufe.tokens })));
        // Wo der Speicher nicht reicht, steht der HINWEIS statt der knappen
        // Bedarfszeile: er nennt den Bedarf bereits samt dem, was frei ist.
        const eng = !stufe.passt && !!stufe.hinweis;
        const z2 = el('div', eng ? 'zeile2 knapp' : 'zeile2',
          eng ? String(stufe.hinweis) : t('wahl.kontextBedarf', { bedarf: stufe.bedarfGib.toFixed(1) }));
        const b = wahlEintrag(z1, z2, stufe.tokens === wahl.kontext, () => {
          wahl.kontext = stufe.tokens;
          zeichne();
        });
        b.dataset.wahlKontext = String(stufe.tokens);
        b.dataset.passt = stufe.passt ? 'ja' : 'nein';
        liste.appendChild(b);
      }
      wahlBlockEl.appendChild(wahlZeile(t('wahl.kontext'), liste));
    }
  } else {
    wahlBlockEl.appendChild(wahlZeile(
      t('wahl.kontext'), el('div', 'wahlhinweis', t('wahl.kontextNurLokal')),
    ));
  }

  // --- Die Startzeile, wortwoertlich ---------------------------------------
  const flaggen = wahlFlaggen(modell, stufen);
  const startzeile = el('div', 'startzeile');
  const flaggenEl = el('div', 'flaggen', flaggen.length ? flaggen.join(' ') : t('wahl.flaggenLeer'));
  flaggenEl.id = 'neu-wahl-flaggen';
  startzeile.appendChild(flaggenEl);
  const startKnopf = el('button', 'knopf haupt', t('knopf.neuWahlStart')) as HTMLButtonElement;
  startKnopf.type = 'button';
  startKnopf.id = 'neu-wahl-start';
  startKnopf.disabled = beschaeftigt || !wahl.model;
  startKnopf.addEventListener('click', (ereignis) => void neueSitzungMitWahl(ereignis.isTrusted));
  startzeile.appendChild(startKnopf);
  wahlBlockEl.appendChild(startzeile);
}

function zeichne(): void {
  if (!daten) return;
  zeichneMaschinenwahl();
  zeichneFernZeile();
  zeichneWahlblock();

  // Chips ERZEUGT aus den tatsaechlich vorkommenden Werten -- vor der
  // Filterung berechnet, sonst wuerde jeder gewaehlte Filter die uebrigen
  // Chips zum Verschwinden bringen, sobald nur noch ein Wert sichtbar ist.
  const maschinenChips = chipsAus(
    daten.sitzungen,
    (z) => z.machine,
    (m, n) => `${m} ${n}`,
    (gesamt) => t('wort.alle', { n: gesamt }),
  );
  if (!maschinenChips.some((c) => c.wert === maschineFilter)) maschineFilter = 'alle';
  zeichneChipZeile(maschineChipsEl, maschinenChips, maschineFilter, (wert) => {
    maschineFilter = wert;
    zeichne();
  });

  const zustandChips = chipsAus(
    daten.sitzungen,
    (z) => z.state,
    (state, n) => `${zustandMarke(state).text} ${n}`,
    (gesamt) => t('wort.alle', { n: gesamt }),
  );
  if (!zustandChips.some((c) => c.wert === zustandFilter)) zustandFilter = 'alle';
  zeichneChipZeile(zustandChipsEl, zustandChips, zustandFilter, (wert) => {
    zustandFilter = wert;
    zeichne();
  });
  if (suchFeld.value !== sucheWert) suchFeld.value = sucheWert;

  const sichtbareSitzungen = daten.sitzungen.filter(
    (z) => zeilePasstSuche(z, sucheWert)
      && zeilePasstMaschine(z, maschineFilter)
      && zeilePasstZustand(z, zustandFilter),
  );

  gruppenEl.textContent = '';
  const gruppen = gruppiere(sichtbareSitzungen);
  for (const g of gruppen) {
    const kasten = el('div', 'gruppe');
    kasten.dataset.gruppe = g.schluessel;

    const kopf = el('div', 'gruppenkopf');
    kopf.appendChild(el('span', 'ordner', ordnerName(g.dir)));
    // Die Maschine steht nur dann davor, wenn es NICHT diese ist -- sonst
    // schriebe jede Zeile denselben Rechnernamen mit.
    const pfad = g.machine && g.machine !== daten.machine ? `${g.machine}:${g.dir}` : g.dir;
    kopf.appendChild(el('span', 'pfad', pfad));

    // Wieviele Sitzungen dieser Ordner traegt. Bei einer einzigen sagt die Zahl
    // nichts, was die Zeile darunter nicht schon sagt -- sie steht deshalb erst
    // ab der zweiten da, und dann als AUSKUNFT, nicht als Knopf: es gibt nichts
    // mehr aufzuklappen.
    if (g.zeilen.length > 1) kopf.appendChild(el('span', 'anzahl', t('wort.sitzungenAnzahl', { n: g.zeilen.length })));
    kasten.appendChild(kopf);

    g.zeilen.forEach((z) => kasten.appendChild(zeileBauen(z)));
    gruppenEl.appendChild(kasten);
  }
  if (gruppen.length === 0) {
    gruppenEl.appendChild(el('div', 'leerhinweis', t('satz.keineSitzungBekannt')));
  }

  const gewaehlt = daten.sitzungen.find((s) => s.id === gewaehlteSitzung);
  grundEl.textContent = gewaehlt
    ? gewaehlt.grund
    : t('satz.waehleSitzung');
  fortKnopf.disabled = beschaeftigt || !gewaehlt || !gewaehlt.fortsetzbar;
  // Beenden geht nur, solange wirklich ein Pane laeuft -- 'running' oder
  // 'attention'. Eine bereits gestoppte oder unerreichbare Sitzung hat nichts,
  // was sich schliessen liesse; der Hauptprozess lehnt das zwar ohnehin ab
  // (befehle.ts, 'session-close'), aber ein Knopf, der sichtbar nichts tun
  // KANN, soll das auch zeigen, statt es erst nach dem Klick zu sagen.
  const laeuftGerade = !!gewaehlt && (gewaehlt.state === 'running' || gewaehlt.state === 'attention');
  beendenKnopf.disabled = beschaeftigt || !laeuftGerade;
  neuKnopf.disabled = beschaeftigt;
  // BEFUND 19.08.: Der Chat-Knopf blieb waehrend eines laufenden Starts
  // anklickbar, obwohl `neueChatSitzung()` ihn mit `if (beschaeftigt) return`
  // gleich wieder abweist -- ein Knopf, der sichtbar nichts tun KANN, soll das
  // auch zeigen, statt es erst nach dem Klick zu verschweigen. Dieselbe Regel,
  // nach der drei Zeilen weiter oben der Beenden-Knopf gesperrt wird.
  neuChatKnopf.disabled = beschaeftigt;
  if (nameFeld.value !== nameWert) nameFeld.value = nameWert;
}

// --- Die Handlungen ----------------------------------------------------------

/**
 * DIE ECHTHEIT DES KLICKS reist mit, und zwar bis in den Dialog hinein: nur ein
 * Ereignis mit `isTrusted === true` bringt den nativen Ordner-Dialog auf den
 * Bildschirm. Ein `el.click()` aus dem Steuerkanal -- der Weg jedes Tests --
 * traegt false; dann entscheidet der Hauptprozess, ob eine Attrappe einspringt
 * (im Test) oder ob gar nichts geschieht. Das gilt nur fuer die EIGENE
 * Maschine -- bei jeder anderen entsteht ohnehin kein Dialog des
 * Betriebssystems, `echt` reist trotzdem mit, weil derselbe Aufruf beide
 * Faelle bedient.
 */
async function neueSitzung(echt: boolean): Promise<void> {
  if (beschaeftigt) return;
  if (daten && maschineWert !== daten.machine && !fernPfadWert.trim()) {
    melde(t('satz.erstOrdnerEintragen', { maschine: maschineWert }), 'fehler');
    return;
  }
  beschaeftigt = true;
  zeichne();
  try {
    const a = await window.awbSitzung.neu(nameWert, maschineWert, fernPfadWert, echt);
    melde(a.command ? `${a.meldung}\n${a.command}` : a.meldung, a.ok ? 'gut' : 'fehler');
    if (a.ok) {
      nameWert = '';
      fernPfadWert = '';
    }
  } catch (e) {
    melde(String((e as Error).message ?? e), 'fehler');
  } finally {
    beschaeftigt = false;
    zeichne();
  }
}

/**
 * DER DRITTE WEG (19.08.): dieselbe neue Sitzung, aber mit einer Wahl, die nur
 * fuer sie gilt.
 *
 * Bis auf die Wahl im Gepaeck ist er Zeile fuer Zeile `neueSitzung()` -- und
 * das mit Absicht: derselbe Ordnerdialog, dieselbe Fernpruefung, dieselbe
 * Echtheit des Klicks. Was er NICHT tut, ist eine Einstellung schreiben.
 */
async function neueSitzungMitWahl(echt: boolean): Promise<void> {
  if (beschaeftigt) return;
  if (daten && maschineWert !== daten.machine && !fernPfadWert.trim()) {
    melde(t('satz.erstOrdnerEintragen', { maschine: maschineWert }), 'fehler');
    return;
  }
  const modell = wahlDaten?.modelle.find((m) => m.id === wahl.model);
  const stufen = wahlDaten?.harnessStufen[wahl.harness] ?? [];
  // Genau die Flaggen, die im Fenster standen -- nicht mehr und nicht weniger.
  // Ein Feld, das leer bleibt, erzeugt keinen Schalter; dann gilt dafuer
  // weiter, was in den Einstellungen steht.
  const mit: Wahl = {
    harness: wahl.harness,
    model: wahl.model,
    effort: stufen.includes(wahl.effort) ? wahl.effort : '',
    kontext: modell?.lokal ? wahl.kontext : 0,
  };
  beschaeftigt = true;
  zeichne();
  try {
    const a = await window.awbSitzung.neuMitWahl(nameWert, maschineWert, fernPfadWert, mit, echt);
    melde(a.command ? `${a.meldung}\n${a.command}` : a.meldung, a.ok ? 'gut' : 'fehler');
    if (a.ok) {
      nameWert = '';
      fernPfadWert = '';
      // Die Wahl gilt EINER Sitzung. Sie bleibt danach nicht stehen -- sonst
      // startete der naechste Klick unbemerkt wieder mit ihr.
      //
      // `wahlDaten` und `wahlVersucht` gehen MIT zurueck, und das ist kein
      // Beiwerk: die Vorbelegung geschieht nur beim Holen (`wahlHolen`). Blieben
      // die Daten stehen, faende das naechste Aufklappen leere Felder statt der
      // Einstellungen -- kein gewaehltes Programm, keine Modellliste, ein
      // gesperrter Startknopf. Nebenbei ist es das Richtige: die Einstellungen
      // koennen sich zwischen zwei Starts geaendert haben.
      wahlOffen = false;
      wahlDaten = null;
      wahlVersucht = false;
      wahl.harness = '';
      wahl.model = '';
      wahl.effort = '';
      wahl.kontext = 0;
      wahlSuche = '';
    }
  } catch (e) {
    melde(String((e as Error).message ?? e), 'fehler');
  } finally {
    beschaeftigt = false;
    zeichne();
  }
}

/**
 * DER ZWEITE WEG: eine Chat-Sitzung (12.08.). Sie kennt keine Fernmaschine --
 * sie ist ein Prozess DIESER App und laeuft dort, wo die App laeuft. Deshalb
 * reist hier weder `machine` noch `fernPfad` mit, nur der Name und die
 * Echtheit des Klicks: ohne die gibt es keinen Ordnerdialog (main.ts).
 */
async function neueChatSitzung(echt: boolean): Promise<void> {
  if (beschaeftigt) return;
  beschaeftigt = true;
  zeichne();
  try {
    const a = await window.awbSitzung.neuChat(nameWert, echt);
    melde(a.meldung, a.ok ? 'gut' : 'fehler');
    if (a.ok) nameWert = '';
  } catch (e) {
    melde(String((e as Error).message ?? e), 'fehler');
  } finally {
    beschaeftigt = false;
    zeichne();
  }
}

/** Der „Pruefen"-Knopf neben dem Fernpfad -- dieselbe Pruefung, die der Start selbst noch einmal tut. */
async function fernPruefen(): Promise<void> {
  if (fernPrueftGerade || !daten || maschineWert === daten.machine) return;
  const pfad = fernPfadWert.trim();
  if (!pfad) {
    fernStatus = t('satz.erstPfadEintragen');
    fernStatusArt = 'fehler';
    zeichne();
    return;
  }
  fernPrueftGerade = true;
  fernStatus = t('satz.pruefeGerade');
  fernStatusArt = '';
  zeichne();
  try {
    const a = await window.awbSitzung.fernPruefen(maschineWert, pfad);
    fernStatus = a.meldung;
    fernStatusArt = a.ok ? 'gut' : 'fehler';
  } catch (e) {
    fernStatus = String((e as Error).message ?? e);
    fernStatusArt = 'fehler';
  } finally {
    fernPrueftGerade = false;
    zeichne();
  }
}

async function setzeFort(id: string): Promise<void> {
  if (beschaeftigt || !id) return;
  beschaeftigt = true;
  zeichne();
  melde(t('satz.holeZurueck'));
  try {
    const a = await window.awbSitzung.fortsetzen(id);
    melde(a.command ? `${a.meldung}\n${a.command}` : a.meldung, a.ok ? 'gut' : 'fehler');
  } catch (e) {
    melde(String((e as Error).message ?? e), 'fehler');
  } finally {
    beschaeftigt = false;
    zeichne();
  }
}

/**
 * BEENDEN, JE ZEILE (11.08., Bauteil 4 -- ergaenzt zur urspruenglichen
 * Aufgabe). Wirkt auf die GEWAEHLTE Zeile, genau wie Fortsetzen: eine Zeile
 * waehlen, dann den Knopf in der Fusszeile druecken -- kein zweiter Knopf IN
 * jeder Zeile, denn die Zeile selbst IST schon ein Knopf (die Auswahl), und
 * ein Knopf im Knopf geht in HTML nicht.
 *
 * DIE RUECKFRAGE IST HIER BEWUSST, obwohl `menuePunktAusfuehren`/`plane()`
 * fuer 'schliessen' selbst keine verlangen (befehle.ts: „er nimmt nichts weg,
 * was sich nicht zurueckholen liesse" -- die Zustandsdatei bleibt). Diese
 * Zeile hier ist trotzdem der Auftrag: ein Eingriff in eine LAUFENDE Sitzung
 * soll nicht aus einem Fehlklick geschehen. Die Rueckfrage kommt ueber
 * dieselbe `rueckfrage()`-Funktion, die auch das Loeschen fragt (main.ts) --
 * kein zweiter Weg, keine zweite Attrappe.
 */
async function sitzungBeenden(id: string, echt: boolean): Promise<void> {
  if (beschaeftigt || !id) return;
  beschaeftigt = true;
  zeichne();
  try {
    const a = await window.awbSitzung.beenden(id, echt);
    melde(a.command ? `${a.meldung}\n${a.command}` : a.meldung, a.ok ? 'gut' : 'fehler');
  } catch (e) {
    melde(String((e as Error).message ?? e), 'fehler');
  } finally {
    beschaeftigt = false;
    zeichne();
  }
}

nameFeld.addEventListener('input', () => {
  nameWert = nameFeld.value;
});
fernPfadFeld.addEventListener('input', () => {
  fernPfadWert = fernPfadFeld.value;
});
let sucheZeichnenUhr: ReturnType<typeof setTimeout> | undefined;
suchFeld.addEventListener('input', () => {
  sucheWert = suchFeld.value;
  // Entprellt (Befund 9, 15.08.): ohne das zeichnete jeder einzelne
  // Tastendruck das ganze Fenster neu -- die Liste ist zwar klein, aber ein
  // Tastendruck ist kein Anlass fuer ein Neuzeichnen des ganzen Fensters.
  if (sucheZeichnenUhr !== undefined) clearTimeout(sucheZeichnenUhr);
  sucheZeichnenUhr = setTimeout(() => {
    sucheZeichnenUhr = undefined;
    zeichne();
  }, 150);
});
neuKnopf.addEventListener('click', (ereignis) => void neueSitzung(ereignis.isTrusted));
neuChatKnopf.addEventListener('click', (ereignis) => void neueChatSitzung(ereignis.isTrusted));
// Auf- und zuklappen ist eine Sache der Ansicht -- die Echtheit des Klicks
// entscheidet hier nichts, sie entscheidet erst am Startknopf darin.
neuWahlKnopf.addEventListener('click', () => {
  if (beschaeftigt) return;
  wahlOffen = !wahlOffen;
  zeichne();
});
fernPruefenKnopf.addEventListener('click', () => void fernPruefen());
fortKnopf.addEventListener('click', () => void setzeFort(gewaehlteSitzung));
beendenKnopf.addEventListener('click', (ereignis) => void sitzungBeenden(gewaehlteSitzung, ereignis.isTrusted));

// --- Anlauf -----------------------------------------------------------------

window.__awbSitzung = {
  text: () => document.body.innerText,
  status: () => statusEl.textContent ?? '',
  klick: (auswahl: string) => {
    const e = document.querySelector<HTMLElement>(auswahl);
    if (!e) return false;
    e.click();
    return true;
  },
  // Lesen statt klicken. Ohne diesen Haken liesse sich "der Knopf ist gesperrt"
  // nur pruefen, indem man ihn drueckt -- und damit ausloest.
  zustand: (auswahl: string) => {
    const e = document.querySelector<HTMLElement>(auswahl);
    if (!e) return { da: false, gesperrt: false, wert: '', text: '', optionen: [], angezeigt: false };
    const i = e as HTMLInputElement;
    // `<select>` UND `<datalist>` tragen beide `.options` -- ein Feld genuegt
    // fuer die Maschinenwahl (11.08.) und die Ordner-Vorschlaege am Fernpfad.
    const mitOptionen = e as unknown as { options?: HTMLCollectionOf<HTMLOptionElement> };
    const optionen = mitOptionen.options ? [...mitOptionen.options].map((o) => o.value) : [];
    // NICHT `text` fuer „ist es versteckt?": `innerText` faellt bei einem
    // `display:none`-Element per Spezifikation auf `textContent` zurueck --
    // ein Kind-Knopf bleibt darin lesbar, obwohl nichts davon zu sehen ist
    // (gemessen an `#neu-fern`, 11.08.). `getComputedStyle` fragt die
    // tatsaechliche Darstellung, nicht die geerbte Textmenge -- aber nur fuer
    // das Element SELBST: liegt `display:none` an einem Vorfahren, bleibt der
    // eigene Wert `block`. Deshalb zusaetzlich die Hoehe pruefen, wie im
    // Einstellungsfenster (app/src/einstellungen/einstellungen.ts, `info()`).
    const angezeigt = getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0;
    return {
      da: true,
      gesperrt: i.disabled === true,
      wert: typeof i.value === 'string' ? i.value : '',
      text: (e.innerText ?? '').replace(/\s+/g, ' ').trim(),
      optionen,
      angezeigt,
    };
  },
  gruppen: () => [...gruppenEl.querySelectorAll<HTMLElement>('.gruppe')].map((g) => {
    const schluessel = g.dataset.gruppe ?? '';
    const sichtbar = [...g.querySelectorAll<HTMLElement>('.listenzeile')].map((z) => z.dataset.sitzung ?? '');
    const alle = daten?.sitzungen.filter((s) => `${s.machine} ${s.dir}` === schluessel).length ?? sichtbar.length;
    return {
      schluessel,
      kopf: (g.querySelector<HTMLElement>('.gruppenkopf')?.innerText ?? '').replace(/\s+/g, ' ').trim(),
      sichtbar,
      // Bekannt minus gezeichnet. Steht hier etwas anderes als 0, verschweigt
      // das Fenster eine Sitzung -- genau der Fehler vom 11.08.
      verborgen: alle - sichtbar.length,
    };
  }),
  sitzungen: () => [...gruppenEl.querySelectorAll<HTMLElement>('.listenzeile')].map((b) => ({
    id: b.dataset.sitzung ?? '',
    text: b.innerText.replace(/\s+/g, ' ').trim(),
    gewaehlt: b.classList.contains('gewaehlt'),
    fortsetzbar: b.dataset.fortsetzbar === '1',
  })),
};

// Der Grund, wenn ein Start spaeter scheitert. Er steht in der Statuszeile, wo
// auch die Startmeldung stand -- die Zeile "Session wird gestartet" wird damit
// von der Wahrheit abgeloest, statt stehenzubleiben.
window.awbSitzung.onStartfehler((p) => {
  const zeilen = [p.kurz || 'Die Sitzung ist nicht gestartet.', p.grund, `Protokoll: ${p.protokoll}`];
  melde(zeilen.filter(Boolean).join('\n'), 'fehler');
});

window.awbSitzung.onDaten((d) => {
  daten = d;
  setzeSprache(d.sprache);
  beschriften();
  // Eine Sitzung, die es nicht mehr gibt, bleibt nicht gewaehlt -- sonst zeigte
  // die Fusszeile einen Grund zu einer Zeile, die niemand mehr sieht.
  if (gewaehlteSitzung && !d.sitzungen.some((s) => s.id === gewaehlteSitzung)) gewaehlteSitzung = '';
  zeichne();
});

void (async () => {
  daten = await window.awbSitzung.daten();
  setzeSprache(daten.sprache);
  beschriften();
  zeichne();
  window.awbSitzung.bereit();
})();

// Macht diese Datei zu einem Modul -- ohne das gilt sie als Skript, und die
// `declare global`-Erweiterung oben waere unzulaessig.
export {};
