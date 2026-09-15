// Die Meldung, dass eine Ergebnisdatei entstanden ist (V2).
//
// A14 bestimmt die Bauform: Ergebnisse bekommen KEINE Dauerflaeche im Fenster.
// Also eine Meldung, die von selbst wieder geht -- gelesen wird im Worker-Tab
// oder in der Datei. Zwei Wege dorthin, beide mit einem Klick:
//
//   auf die Meldung      der Pane dieses Workers wird gezeigt, wenn er noch
//                        lebt (der uebliche Fall: das Ergebnis ist da, der
//                        Pane steht noch offen)
//   auf "Datei"          die Ergebnisdatei im Programm des Menschen
//
// ZWEI REGELN, die aus einem Vorfall vom 05.08. stammen. Der Kontext-Guard
// meldete "Worker schrift ist fertig ... schliesse den Pane mit `wb-close
// schrift`", waehrend der Worker seit fuenf Minuten an der NAECHSTEN Aufgabe
// sass. Die Meldung war sachlich richtig -- Auftrag 1 war fertig -- und
// trotzdem gefaehrlich: sie war nur zu spaet, und sie forderte zu einer
// Handlung auf, deren Voraussetzung sie nie geprueft hatte.
//
//   1. Eine Meldung traegt die Kennung des Auftrags, auf den sie sich bezieht,
//      und wird als UEBERHOLT gekennzeichnet, sobald dieser Auftrag nicht mehr
//      der laufende ist (`abgleich()`). Eine Meldung, die nur die Datei kennt,
//      kann nicht wissen, ob sie noch aktuell ist.
//   2. Keine Handlungsanweisung, deren Voraussetzung die Meldung nicht selbst
//      geprueft hat. Deshalb steht hier NICHTS ueber das Schliessen eines
//      Panes. Was angeboten wird, ist geprueft: die Datei existiert (sonst gaebe
//      es die Meldung nicht), und der Pane wird erst in dem Moment nachgesehen,
//      in dem jemand darauf klickt.
//
// Eigene Datei statt noch ein Stueck renderer.ts: Es ist eine eigene Ansicht
// mit eigenem Aufbau, eigenem Aussehen und eigener Lebensdauer. Auch das
// Aussehen bringt sie selbst mit -- ein eigener <style>-Block statt eines
// Eingriffs in index.html, an der gerade andere arbeiten.

import { t } from './texte';

export interface ErgebnisMeldung {
  name: string;
  path: string;
  mtimeMs: number;
  size: number;
}

/**
 * Wie lange eine Meldung steht, bevor sie von selbst geht (05.09.2026,
 * Regelbruch 2: von 30 auf 8 Sekunden). Eine Meldung ist ein Hinweis im
 * Vorbeigehen -- gelesen wird im Worker-Tab oder in der Datei, und beide Wege
 * bleiben nach ihrem Verschwinden offen.
 */
const STANDZEIT_MS = 8_000;

const STIL = `
/* SIE LIEGT UEBER DER BUEHNE, NIE UEBER DER STATUSLEISTE (05.09.2026,
   Regelbruch 2). Bei 1004 Bildpunkten Fensterbreite standen zwei Meldungen von
   je 415 Bildpunkten und deckten „7 Worker laufen" samt Zahnrad zu -- die
   Statusleiste ist der eine Ort, an dem immer steht, was gerade laeuft, und
   den darf nichts verdecken. Der Abstand unten ist deshalb die Hoehe der
   Statusleiste plus die Fuge darum. Und schmaler: 320 statt 420, hoechstens
   ein Drittel des Fensters. */
#meldungen {
  position: fixed; right: calc(var(--fuge) + 8px); z-index: 40;
  bottom: calc(var(--fuge) + var(--statushoehe) + var(--fuge) + 4px);
  display: flex; flex-direction: column; gap: 6px;
  max-width: min(320px, 34vw); pointer-events: none;
}
/* Karte statt Kasten, wie ueberall sonst: keine Umrandung, die Flaeche traegt.
   Die farbige Kante links bleibt -- sie ist eine Marke, keine Umrandung. */
#meldungen .meldung {
  pointer-events: auto;
  background: var(--erhoben); border: 0;
  border-left: 3px solid var(--laeuft);
  border-radius: var(--r-mittel); padding: 6px 8px;
  display: flex; align-items: center; gap: 8px;
  box-shadow: 0 6px 18px color-mix(in srgb, var(--tinte) 34%, transparent);
}
#meldungen .meldung .text { flex: 1 1 auto; overflow: hidden; cursor: pointer; }
#meldungen .meldung .kopf { display: flex; gap: 6px; align-items: baseline; }
#meldungen .meldung .kopf b { font-weight: 600; }
#meldungen .meldung .was { color: var(--laeuft); }
#meldungen .meldung .pfad {
  color: var(--gedaempft); font-size: 10px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  direction: rtl; text-align: left;
}
/* Dieselbe Knopfsprache wie im uebrigen Fenster: eine graue Pille, kein
   umrandeter Kasten (Electron-Befund 10). */
#meldungen .meldung button {
  flex: 0 0 auto; background: var(--linie); color: var(--schrift);
  border: 0; border-radius: var(--r-klein);
  font: inherit; font-size: 11px; padding: 3px 9px; cursor: pointer;
}
#meldungen .meldung button:hover { background: var(--wahl); }
#meldungen .meldung .zu { border: 0; color: var(--gedaempft); padding: 2px 4px; }
/* Ueberholt: derselbe Text, aber sichtbar entwertet -- und nicht nur ueber die
   Farbe, damit die Aussage auch ohne Farbe traegt. */
#meldungen .meldung.veraltet { border-left-color: var(--gedaempft); opacity: .72; }
#meldungen .meldung.veraltet .was { color: var(--gedaempft); text-decoration: line-through; }
#meldungen .meldung .ueberholt { color: var(--will); }
`;

export interface MeldungsWege {
  /** Den Pane dieses Workers zeigen. Leer = es gibt keinen mehr. */
  paneZeigen(paneId: string): void;
  /** Die Ergebnisdatei im Programm des Menschen oeffnen. */
  dateiOeffnen(pfad: string): void;
  /** Der Pane des Workers, oder '' wenn er nicht mehr laeuft. */
  paneVon(name: string): string;
}

/** Eine stehende Meldung samt der Auftragskennung, auf die sie sich bezieht. */
interface Stehend {
  worker: string;
  /** Die Ergebnisdatei DIESES Auftrags. Sie ist die Kennung, nicht der Name. */
  pfad: string;
  el: HTMLElement;
  veraltet: boolean;
  /** Wann sie erschienen ist -- die Standzeit haengt an dieser Zahl, nicht allein am Wecker. */
  seit: number;
}

export class Meldungen {
  private wurzel: HTMLElement;
  private stehende: Stehend[] = [];

  constructor(private wege: MeldungsWege, ziel: HTMLElement = document.body) {
    const stil = document.createElement('style');
    stil.id = 'meldungen-stil';
    stil.textContent = STIL;
    document.head.appendChild(stil);
    this.wurzel = document.createElement('div');
    this.wurzel.id = 'meldungen';
    ziel.appendChild(this.wurzel);
  }

  /** Wieviele Meldungen gerade stehen -- fuer Pruefungen der Oberflaeche. */
  anzahl(): number {
    return this.wurzel.childElementCount;
  }

  zeigen(e: ErgebnisMeldung): void {
    const el = document.createElement('div');
    el.className = 'meldung';
    el.dataset.worker = e.name;
    el.dataset.pfad = e.path;

    const text = document.createElement('div');
    text.className = 'text';
    const kopf = document.createElement('div');
    kopf.className = 'kopf';
    const name = document.createElement('b');
    name.textContent = e.name;
    const was = document.createElement('span');
    was.className = 'was';
    was.textContent = t('meldung.ergebnisDa');
    kopf.append(name, was);
    const pfad = document.createElement('div');
    pfad.className = 'pfad';
    // Von rechts gelesen: bei einem zu langen Pfad soll der DATEINAME stehen
    // bleiben und der Anfang wegfallen, nicht umgekehrt.
    pfad.textContent = e.path;
    pfad.title = e.path;
    text.append(kopf, pfad);
    text.addEventListener('click', () => {
      const pane = this.wege.paneVon(e.name);
      if (pane) this.wege.paneZeigen(pane);
      else this.wege.dateiOeffnen(e.path);
      el.remove();
    });

    const datei = document.createElement('button');
    datei.textContent = t('meldung.datei');
    datei.addEventListener('click', () => {
      this.wege.dateiOeffnen(e.path);
      el.remove();
    });

    const zu = document.createElement('button');
    zu.className = 'zu';
    zu.textContent = '✕';
    zu.title = t('meldung.schliessen');
    zu.addEventListener('click', () => el.remove());

    el.append(text, datei, zu);
    el.title = t('meldung.ergebnisUnter', { name: e.name, pfad: e.path });
    this.wurzel.appendChild(el);
    const stehend: Stehend = { worker: e.name, pfad: e.path, el, veraltet: false, seit: Date.now() };
    this.stehende.push(stehend);
    const wegnehmen = (): void => {
      el.remove();
      this.stehende = this.stehende.filter((s) => s !== stehend);
    };
    zu.addEventListener('click', wegnehmen);
    text.addEventListener('click', wegnehmen);
    datei.addEventListener('click', wegnehmen);
    setTimeout(wegnehmen, STANDZEIT_MS);
  }

  /**
   * Jede stehende Meldung gegen den laufenden Zustand halten. `aktuell` sagt je
   * Worker, welche Ergebnisdatei zu seinem LAUFENDEN Auftrag gehoert -- leer,
   * solange er an etwas Neuem sitzt und noch nichts geschrieben hat. Stimmt das
   * nicht mehr mit der Meldung ueberein, ist die Meldung ueberholt: der Auftrag,
   * von dem sie spricht, ist nicht mehr der laufende.
   *
   * Sie wird gekennzeichnet und nicht entfernt. Das Ergebnis GAB es ja, und wer
   * gerade hinsieht, soll nicht ein verschwindendes Fenster erklaeren muessen --
   * er soll lesen, dass es ueberholt ist.
   */
  abgleich(aktuell: Map<string, string>): void {
    // ZUERST DIE ABGELAUFENEN (05.09.2026, Regelbruch 2). Die Standzeit hing
    // allein an einem `setTimeout`, und ein Wecker ist kein verlaesslicher
    // Weg: Electron drosselt die Zeitgeber eines Fensters, das nicht im
    // Vordergrund steht (`backgroundThrottling`), und kopflos steht es nie im
    // Vordergrund. Gemessen hat der Kritiker dieselben zwei Meldungen ueber
    // mehr als zehn Minuten in jedem seiner neunzig Bilder. Der Wecker bleibt
    // -- er ist der Weg, auf dem eine Meldung im Normalfall verschwindet --,
    // aber die Zeit wird hier zusaetzlich an der Uhr geprueft, und dieser
    // Abgleich laeuft bei jeder Modellmeldung.
    this.abgelaufeneWegnehmen();
    for (const s of this.stehende) {
      if (s.veraltet) continue;
      if (!aktuell.has(s.worker)) continue;   // Worker unbekannt: nichts zu sagen
      if (aktuell.get(s.worker) === s.pfad) continue;
      s.veraltet = true;
      s.el.classList.add('veraltet');
      const hinweis = document.createElement('div');
      hinweis.className = 'ueberholt';
      hinweis.textContent = t('meldung.ueberholt');
      s.el.querySelector('.text')?.appendChild(hinweis);
      s.el.dataset.veraltet = '1';
      s.el.title = t('meldung.ergebnisUeberholt', { name: s.worker, pfad: s.pfad });
    }
  }

  /** Was laenger steht als die Standzeit, geht -- gemessen an der Uhr. */
  private abgelaufeneWegnehmen(): void {
    const jetzt = Date.now();
    for (const s of [...this.stehende]) {
      if (jetzt - s.seit < STANDZEIT_MS) continue;
      s.el.remove();
      this.stehende = this.stehende.filter((x) => x !== s);
    }
  }
}
