// DIE OBERFLAECHE DER CHAT-SITZUNG -- gebaut nach dem Foto vom 12.08.
// (VS-Code-Claude-Panel): Punktspalte links, Werkzeugaufrufe mit Titelzeile
// und je einer Zeile EIN/AUS, gedimmte Denk-Zeile, unten ein umrandetes
// Eingabefeld mit Modus-Marke.
//
// REINES DOM. Kein `window.awb*`, keine Bruecke, kein Electron: was gezeigt
// wird, kommt herein; was der Mensch drueckt, geht als Rueckruf hinaus. So
// laesst sich die Ansicht kopflos zeichnen und fotografieren, ohne dass ein
// echter Claude-Prozess laufen muss -- genau das tut
// shell/tests/test-app-chatsdk-oberflaeche.sh.
//
// UNTERSCHIED ZUR LESE-ANSICHT (chat/ansicht.ts): jene hat bewusst KEIN
// Eingabefeld, weil die Eingabe dort am Pane bleibt. Hier ist das Feld der
// Kern -- die Sitzung gehoert der App.
import { markdownZuHtml } from '../chat/markdown';
import type {
  Block, FreigabeBlock, Gespraech, Slashbefehl, TextBlock, WerkzeugBlock,
} from '../chat/sdkstrom';
import { setzeSprache, t } from './texte';
import {
  Vervollstaendigung, ausloeser, einsetzen, filtereBefehle, filtereDateien,
  type Vorschlag,
} from './vervollstaendigung';

/** Was die Statusleiste unten zeigt -- gefuellt in main/chatbuehne.ts. */
export interface ChatStatus {
  ordner: string;
  zweig: string;
  modell: string;
  tokens: number;
  fenster: number;
  kosten: number;
  fuenfStunden: number;
  siebenTage: number;
  zurueck: string;
}

/** Ein Worker in der Werkstatt dieser Chat-Sitzung (Punkt 1). */
export interface Werkstattworker {
  name: string;
  paneId: string;
  laeuft: boolean;
}

/** Ein Eintrag der `@`-Liste, wie ihn main/chatdateien.ts liefert. */
export interface Dateivorschlag {
  pfad: string;
  ordner: boolean;
}

/** Was hereinkommt -- der Kopf immer, die Bloecke nur, soweit geaendert. */
export interface Stand {
  kopf: Omit<Gespraech, 'bloecke' | 'befehle'>;
  /**
   * Die Slash-Befehle -- nur, wenn sie NEU sind. `undefined` heisst
   * „unveraendert", und die Ansicht behaelt, was sie hat (siehe
   * `ChatStandNachricht.befehle`).
   */
  befehle?: Slashbefehl[];
  geaendert: Block[];
  ordnung: string[];
  seit: number;
  sprache: string;
  laeuft: boolean;
  neustartMoeglich: boolean;
  status?: ChatStatus;
}

export interface AnsichtHaken {
  /** Der Mensch schickt einen Text ab. */
  aufSenden(text: string): void;
  /** Der Mensch hat ueber eine Freigabe entschieden. */
  aufFreigabe(anfrageId: string, erlauben: boolean): void;
  /** Der Mensch will die Sitzung frisch starten (Befund B3). */
  aufNeustart(): void;
  /** Der Mensch stellt den Freigabemodus um (Luecke 5c). */
  aufModus(modus: string): void;
  /** Der Mensch unterbricht den laufenden Zug (Punkt 6). */
  aufHalt(): void;
  /** Die Dateiliste des Projektordners fuer das `@` (Punkt 3), mit ihrer Herkunft. */
  dateien(): Promise<{ quelle: 'git' | 'dateisystem'; dateien: Dateivorschlag[] }>;
  /** Der Mensch will zu einem Worker dieser Sitzung wechseln (Punkt 1). */
  aufWorker(paneId: string): void;
}

/** Eine Zahl kurz: 46k, 1.0M -- dieselbe Form wie in der Statuszeile des Terminals. */
function kompakt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * DER BALKEN DER KONTEXTAUSLASTUNG -- zehn Bloecke, gefuellt und leer, genau
 * wie ihn `~/.claude/statusline-command.sh` im Terminal zeichnet. Gezeichnete
 * Zeichen, kein Emoji.
 */
export function balken(anteil: number): string {
  const voll = Math.max(0, Math.min(10, Math.round(anteil * 10)));
  return '▓'.repeat(voll) + '░'.repeat(10 - voll);
}

/**
 * DIE FARBSTUFE EINER PROZENTZAHL -- dieselben Schwellen wie im Terminal
 * (statusline-command.sh, `col_pct`): ab 60 gelb, ab 85 rot.
 */
export function stufe(prozent: number): 'ruhig' | 'will' | 'aus' {
  if (prozent >= 85) return 'aus';
  if (prozent >= 60) return 'will';
  return 'ruhig';
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  klasse: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = klasse;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Eine Zahl mit Tausenderpunkten, so wie der Rest des Hauses sie schreibt. */
function zahl(n: number): string {
  return n.toLocaleString('de-DE');
}

/** Ein Feld der Statusleiste: ein Wert, ein Titel, eine Klasse fuer die Farbe. */
function feldchen(klasse: string, wert: string, titel: string): HTMLSpanElement {
  const s = el('span', `csdk-statusfeld ${klasse}`);
  s.appendChild(el('span', 'csdk-statuswert', wert));
  s.title = titel;
  return s;
}

export class Chatansicht {
  private readonly wurzel: HTMLDivElement;

  private readonly kopf: HTMLDivElement;

  private readonly verlauf: HTMLDivElement;

  private readonly feld: HTMLTextAreaElement;

  private readonly senden: HTMLButtonElement;

  private readonly modusMarke: HTMLButtonElement;

  private readonly haltKnopf: HTMLButtonElement;

  private readonly hinweis: HTMLDivElement;

  /** Die Statusleiste unten (Punkt 2). */
  private readonly statusleiste: HTMLDivElement;

  /** Die Worker-Kacheln dieser Sitzung (Punkt 1) -- oben, unter dem Kopf. */
  private readonly workerleiste: HTMLDivElement;

  /** Die Vervollstaendigungsliste ueber dem Feld (Punkt 3). */
  private readonly vervoll: Vervollstaendigung;

  /** Die Slash-Befehle des Harness. Sie kommen einmal und bleiben. */
  private befehle: Slashbefehl[] = [];

  /** Die Dateiliste des Projektordners -- einmal geholt, dann im Fenster gefiltert. */
  private dateiliste: Dateivorschlag[] = [];

  /** Laeuft die Abfrage der Dateiliste gerade? Zweimal fragen bringt nichts. */
  private dateienUnterwegs = false;

  /**
   * Woher die Dateiliste kam. Der Rueckfallweg ohne git kennt nur die
   * `.gitignore` der Wurzel -- die Kopfzeile der Liste sagt das, statt eine
   * Verlaesslichkeit zu behaupten, die sie nicht hat (Reviewbefund 10).
   */
  private dateiquelle: 'git' | 'dateisystem' = 'git';

  /** Die Freigabemodi, die der Harness annimmt -- aus dem Stand. */
  private modi: string[] = [];

  /** Klebt die Ansicht unten? Dann folgt sie neuen Zeilen. */
  private amEnde = true;

  /** Welche Bloecke der Mensch aufgeklappt hat -- ueberlebt das Neuzeichnen. */
  private readonly offen = new Set<string>();

  /**
   * DER GEZEICHNETE STAND, je Block (Befund B1, 12.08.).
   *
   * Vorher warf `zeichne()` mit `replaceChildren()` den ganzen Verlauf weg und
   * baute ihn neu auf -- bei JEDEM Stueck, das aus stdout kam, also ungefaehr
   * je Token. Der Aufwand wuchs damit mit der Laenge des Gespraechs, die
   * Auswahl des Menschen im Text verschwand bei jedem Token, und die
   * Rollposition eines aufgeklappten `<pre>` sprang zurueck.
   *
   * Jetzt merkt sich die Ansicht je Kennung das Element und die Fassung, die
   * darin steht. Neu gebaut wird nur, was sich wirklich geaendert hat.
   */
  private readonly gezeichnet = new Map<string, { el: HTMLElement; rev: number }>();


  constructor(private readonly haken: AnsichtHaken) {
    this.wurzel = el('div', 'chatsdk');
    this.kopf = el('div', 'csdk-kopf');
    this.verlauf = el('div', 'csdk-verlauf');

    const fuss = el('div', 'csdk-fuss');
    const kasten = el('div', 'csdk-eingabekasten');
    this.feld = document.createElement('textarea');
    this.feld.className = 'csdk-feld';
    this.feld.rows = 1;
    this.feld.spellcheck = false;

    const leiste = el('div', 'csdk-eingabeleiste');
    // DIE MODUS-MARKE IST EIN KNOPF (Luecke 5c). Bis zum 12.08. zeigte sie den
    // Freigabemodus nur an; dass er sich zur Laufzeit umstellen laesst, ist
    // gemessen (main/chatsitzung.ts, `setzeModus`), und eine Anzeige neben
    // einer Faehigkeit, die niemand erreicht, ist eine halbe Auskunft.
    this.modusMarke = el('button', 'csdk-modus');
    this.modusMarke.type = 'button';
    this.modusMarke.addEventListener('click', () => this.modusWeiter());
    // DER STOP-KNOPF (Punkt 6). Er steht nur da, solange wirklich etwas laeuft
    // -- ein Knopf, der nichts zu unterbrechen hat, laedt zum Ausprobieren ein.
    this.haltKnopf = el('button', 'csdk-halt');
    this.haltKnopf.type = 'button';
    // Ein gezeichnetes Quadrat, kein Emoji.
    this.haltKnopf.textContent = '■';
    this.haltKnopf.hidden = true;
    this.haltKnopf.addEventListener('click', () => this.haken.aufHalt());
    this.senden = el('button', 'csdk-senden');
    this.senden.type = 'button';
    // Ein gezeichneter Pfeil, kein Emoji -- dieselbe Auflage wie im Rest des Hauses.
    this.senden.textContent = '↑';
    leiste.append(this.modusMarke, this.haltKnopf, this.senden);

    this.vervoll = new Vervollstaendigung((v) => this.einsetzen(v));
    kasten.append(this.vervoll.element(), this.feld, leiste);
    this.hinweis = el('div', 'csdk-hinweis');
    this.statusleiste = el('div', 'csdk-status');
    fuss.append(kasten, this.hinweis);

    this.workerleiste = el('div', 'csdk-worker');
    this.workerleiste.hidden = true;
    this.wurzel.append(this.kopf, this.workerleiste, this.verlauf, fuss, this.statusleiste);

    this.verlauf.addEventListener('scroll', () => {
      const rest = this.verlauf.scrollHeight - this.verlauf.scrollTop - this.verlauf.clientHeight;
      this.amEnde = rest < 40;
      // DAS ABSCHALTEN SICHTBAR MACHEN (Punkt 6). Dass die Ansicht dem Ende
      // nicht mehr folgt, weil jemand hochgerollt hat, sieht man ihr sonst
      // nicht an -- man haelt sie fuer stehengeblieben.
      this.wurzel.classList.toggle('haengt-nach', !this.amEnde);
    });

    // EINGABE SENDET, UMSCHALT+EINGABE BRICHT UM -- die Sitte, die das Foto
    // zeigt und die jeder aus dem Chat kennt. VOR beidem hat aber die
    // Vervollstaendigung das Wort: steht sie offen, waehlen Pfeiltasten,
    // setzen Eingabe und Tabulator ein, und Escape schliesst sie.
    this.feld.addEventListener('keydown', (ev) => {
      if (ev.isComposing) return;
      if (this.vervoll.taste(ev.key, ev.shiftKey)) {
        ev.preventDefault();
        return;
      }
      // ESCAPE UNTERBRICHT (Punkt 6) -- dieselbe Taste wie im Terminal, und
      // erst, wenn keine Liste mehr offen ist, die sie schliessen koennte.
      // NUR, WENN ETWAS LAEUFT: sonst legte jeder Escape eine Zeile „Der Zug
      // wurde unterbrochen" in einen Verlauf, in dem gerade nichts lief.
      if (ev.key === 'Escape') {
        ev.preventDefault();
        if (!this.haltKnopf.hidden) this.haken.aufHalt();
        return;
      }
      if (ev.key !== 'Enter' || ev.shiftKey) return;
      ev.preventDefault();
      this.abschicken();
    });
    this.feld.addEventListener('input', () => {
      this.hoeheAnpassen();
      this.vervollstaendigen();
    });
    // Die Marke wandert mit dem Schreibstrich: ein Klick mitten in den Text
    // beendet einen Vorschlag, der zu einer anderen Stelle gehoerte.
    this.feld.addEventListener('click', () => this.vervollstaendigen());
    this.feld.addEventListener('blur', () => this.vervoll.zu());
    this.senden.addEventListener('click', () => this.abschicken());
  }

  element(): HTMLDivElement {
    return this.wurzel;
  }

  /** Das Feld waechst mit dem Text, bis zu einer Grenze -- danach rollt es. */
  private hoeheAnpassen(): void {
    this.feld.style.height = 'auto';
    this.feld.style.height = `${Math.min(this.feld.scrollHeight, 220)}px`;
  }

  /**
   * DAS FELD LEERT SICH SOFORT. Nicht erst, wenn der Hauptprozess bestaetigt:
   * ein Feld, das nach dem Absenden noch den alten Text zeigt, laedt zum
   * zweiten Absenden ein.
   */
  private abschicken(): void {
    const text = this.feld.value.trim();
    if (!text) return;
    this.feld.value = '';
    this.hoeheAnpassen();
    this.amEnde = true;
    this.haken.aufSenden(text);
  }

  fokus(): void {
    this.feld.focus();
  }

  /**
   * DIE WORKER DIESER SITZUNG ZEIGEN (Punkt 1).
   *
   * Sie kommen aus dem MODELL, nicht aus dem Gespraechsstand: der Stand laeuft
   * je Stueck aus stdout, also ungefaehr je Token, und eine tmux-Abfrage in
   * diesem Takt waere derselbe Fehler wie der volle Stand je Token (Befund B1).
   * Das Modell tickt ohnehin alle zwei Sekunden -- schnell genug, um einen
   * neuen Worker zu bemerken, und billig.
   *
   * Ohne Worker ist die Leiste WEG, nicht leer: eine Zeile, die dauerhaft
   * „keine Worker" sagt, nimmt Platz und sagt nichts.
   */
  setzeWorker(liste: Werkstattworker[]): void {
    this.workerleiste.replaceChildren();
    this.workerleiste.hidden = liste.length === 0;
    if (!liste.length) return;
    this.workerleiste.appendChild(el('span', 'csdk-workermarke', t('worker.titel')));
    for (const w of liste) {
      const k = el('button', `csdk-workerkachel${w.laeuft ? ' laeuft' : ''}`);
      k.type = 'button';
      k.dataset.pane = w.paneId;
      k.appendChild(el('span', `csdk-workerpunkt ${w.laeuft ? 'laeuft' : 'ruhig'}-bg`));
      k.appendChild(el('span', 'csdk-workername', w.name));
      k.title = w.laeuft
        ? t('worker.wechseln', { name: w.name })
        : t('worker.beendet', { name: w.name });
      k.addEventListener('click', () => this.haken.aufWorker(w.paneId));
      this.workerleiste.appendChild(k);
    }
  }

  // --- Vervollstaendigung (Punkt 3) --------------------------------------

  /**
   * NACHSEHEN, WAS AN DER SCHREIBMARKE STEHT, und die Liste danach richten.
   * Die Entscheidung selbst faellt in `ausloeser()` -- rein und getrennt
   * geprueft; hier steht nur, was daraus folgt.
   */
  private vervollstaendigen(): void {
    const a = ausloeser(this.feld.value, this.feld.selectionStart ?? 0);
    if (!a) {
      this.vervoll.zu();
      return;
    }
    if (a.art === 'befehl') {
      const treffer = filtereBefehle(this.befehle, a.muster);
      this.vervoll.zeige(
        'befehl',
        treffer.map((b) => ({
          wert: b.name,
          satz: [b.argumente, b.beschreibung].filter(Boolean).join(' — '),
          ordner: false,
        })),
        t('vervoll.befehle'),
      );
      return;
    }
    // Die Dateiliste kommt vom Hauptprozess und wird EINMAL geholt. Bis sie da
    // ist, bleibt die Liste zu: ein leerer Kasten waere die falsche Auskunft.
    if (!this.dateiliste.length && !this.dateienUnterwegs) {
      this.dateienUnterwegs = true;
      void this.haken.dateien().then((antwort) => {
        this.dateienUnterwegs = false;
        this.dateiliste = antwort.dateien;
        this.dateiquelle = antwort.quelle;
        // Steht der Auslöser noch? Dann jetzt zeigen -- sonst hat der Mensch
        // in der Zwischenzeit weitergeschrieben, und die Liste gehoert nicht
        // mehr dahin.
        if (document.activeElement === this.feld) this.vervollstaendigen();
      });
    }
    this.vervoll.zeige(
      'datei',
      filtereDateien(this.dateiliste, a.muster).map((d) => ({
        wert: d.pfad, satz: '', ordner: d.ordner,
      })),
      this.dateiquelle === 'git' ? t('vervoll.dateien') : t('vervoll.dateien.ohneGit'),
    );
  }

  private einsetzen(v: Vorschlag): void {
    const a = ausloeser(this.feld.value, this.feld.selectionStart ?? 0);
    if (!a) {
      this.vervoll.zu();
      return;
    }
    const neu = einsetzen(this.feld.value, a, v.wert, v.ordner);
    this.feld.value = neu.text;
    this.feld.setSelectionRange(neu.marke, neu.marke);
    this.hoeheAnpassen();
    this.vervoll.zu();
    this.feld.focus();
    // Ein Ordner geht gleich eine Ebene tiefer weiter -- der Schraegstrich
    // steht schon da, die Liste zeigt jetzt seinen Inhalt.
    if (v.ordner) this.vervollstaendigen();
  }

  // --- Freigabemodus (Luecke 5c) -----------------------------------------

  /**
   * EINEN SCHRITT WEITER IN DER MODUSLISTE. Ein Klick, ein Schritt: ein Menue
   * waere fuer sechs Werte zuviel Oberflaeche, und die Marke sagt nach jedem
   * Klick, was jetzt gilt. Was WIRKLICH gilt, sagt danach der Harness -- die
   * Marke wird aus seiner Antwort neu gezeichnet, nicht aus dem Wunsch.
   */
  private modusWeiter(): void {
    if (!this.modi.length) return;
    const jetzt = this.modusMarke.dataset.modus ?? '';
    const i = this.modi.indexOf(jetzt);
    this.haken.aufModus(this.modi[(i + 1) % this.modi.length]);
  }

  /**
   * ZEICHNEN -- INKREMENTELL (Befund B1, 12.08.). Der Kopf ist klein und wird
   * jedes Mal gebaut; im Verlauf wird nur angefasst, was sich geaendert hat.
   */
  zeichne(stand: Stand): void {
    setzeSprache(stand.sprache);
    // Die Befehlsliste kommt nur, WENN sie neu ist -- fehlt sie, bleibt die
    // vorhandene stehen (siehe `Stand.befehle`).
    if (stand.befehle) this.befehle = stand.befehle;
    this.modi = stand.kopf.modi ?? [];
    this.zeichneKopf(stand);

    // 1. Was hereinkam, ersetzt seine bisherige Fassung.
    for (const b of stand.geaendert) {
      const alt = this.gezeichnet.get(b.id);
      const neu = this.block(b);
      if (alt) {
        alt.el.replaceWith(neu);
      }
      this.gezeichnet.set(b.id, { el: neu, rev: b.rev });
    }

    // 2. Was nicht mehr in der Ordnung steht, ist weg.
    const bekannt = new Set(stand.ordnung);
    for (const [id, eintrag] of [...this.gezeichnet]) {
      if (bekannt.has(id)) continue;
      eintrag.el.remove();
      this.gezeichnet.delete(id);
    }

    // 3. Die Reihenfolge herstellen. Angefasst wird nur, was an der falschen
    //    Stelle steht -- ein `appendChild` auf ein Element, das ohnehin schon
    //    dort haengt, verschoebe es sonst und liesse die Auswahl fallen.
    const leer = this.verlauf.querySelector('.csdk-leer');
    if (stand.ordnung.length && leer) leer.remove();
    let vorher: HTMLElement | null = null;
    for (const id of stand.ordnung) {
      const eintrag = this.gezeichnet.get(id);
      if (!eintrag) continue;
      const soll: Element | null = vorher ? vorher.nextElementSibling : this.verlauf.firstElementChild;
      if (soll !== eintrag.el) {
        this.verlauf.insertBefore(eintrag.el, vorher ? vorher.nextSibling : this.verlauf.firstChild);
      }
      vorher = eintrag.el;
    }

    if (!stand.ordnung.length && !this.verlauf.querySelector('.csdk-leer')) {
      this.verlauf.replaceChildren();
      const kasten = el('div', 'csdk-leer');
      kasten.append(
        el('div', 'csdk-leer-titel', t('leer.titel')),
        el('div', 'csdk-leer-satz', t('leer.satz')),
      );
      this.verlauf.appendChild(kasten);
    }

    this.feld.placeholder = t('eingabe.platzhalter');
    this.feld.disabled = !stand.laeuft;
    this.senden.disabled = !stand.laeuft;
    this.senden.title = t('eingabe.senden');
    const modus = stand.kopf.modus || '';
    this.modusMarke.textContent = modus || '—';
    this.modusMarke.dataset.modus = modus;
    // Die Marke sagt jetzt auch, was ein Klick TUT -- und wenn der Harness
    // eine Umschaltung abgelehnt hat, steht sein Wortlaut daneben statt einer
    // stillen Nichtwirkung.
    this.modusMarke.disabled = !stand.laeuft || !this.modi.length;
    this.modusMarke.title = stand.kopf.modusFehler
      ? t('modus.abgelehnt', { grund: stand.kopf.modusFehler })
      : t('modus.wechseln', { modus: modus || '—' });
    this.modusMarke.classList.toggle('fehler', !!stand.kopf.modusFehler);

    // DER STOP-KNOPF steht nur, solange wirklich etwas laeuft.
    const arbeitet = stand.laeuft && stand.kopf.arbeitet && !stand.kopf.wartetAufFreigabe;
    this.haltKnopf.hidden = !arbeitet;
    this.haltKnopf.title = t('knopf.halt');

    this.hinweis.textContent = this.amEnde ? t('eingabe.hinweis') : t('eingabe.haengtNach');
    this.zeichneStatus(stand);

    if (this.amEnde) this.verlauf.scrollTop = this.verlauf.scrollHeight;
  }

  /**
   * DIE STATUSLEISTE (Punkt 2) -- dieselben Groessen wie die Zeile unter einer
   * Terminal-Sitzung, in derselben Reihenfolge: Modell, Ordner und Zweig, der
   * Balken „belegt/Fenster", 5h und 7d. Die Quellen stehen im Klassendoc von
   * `ChatStatus` (main/chatbuehne.ts); hier wird nur gezeichnet.
   *
   * WAS UNBEKANNT IST, STEHT NICHT DA. Eine Fenstergroesse, die die Registry
   * nicht kennt, ergibt keinen Balken -- ein Balken bei 0 % saehe aus wie eine
   * gemessene Auslastung.
   */
  private zeichneStatus(stand: Stand): void {
    const s = stand.status;
    this.statusleiste.replaceChildren();
    if (!s) return;

    if (s.modell) {
      this.statusleiste.appendChild(feldchen('modell', s.modell, t('status.modell')));
    }
    if (s.ordner) {
      const kurz = s.ordner.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
      const p = feldchen('ordner', kurz, t('kopf.ordner', { ordner: s.ordner }));
      if (s.zweig) p.appendChild(el('span', 'csdk-zweig', s.zweig));
      this.statusleiste.appendChild(p);
    }
    if (s.tokens > 0 && s.fenster > 0) {
      const anteil = s.tokens / s.fenster;
      const prozent = Math.round(anteil * 100);
      this.statusleiste.appendChild(feldchen(
        `kontext ${stufe(prozent)}`,
        `${balken(anteil)} ${kompakt(s.tokens)}/${kompakt(s.fenster)}`,
        t('status.kontext', { prozent: String(prozent) }),
      ));
    } else if (s.tokens > 0) {
      // Tokens ja, Fenstergroesse nein: die Zahl steht da, der Balken nicht --
      // und sie sagt, WAS sie zaehlt, sonst stuende dort eine nackte Zahl.
      this.statusleiste.appendChild(feldchen(
        'kontext', t('kopf.tokens', { tokens: zahl(s.tokens) }), t('status.kontext.ohneFenster'),
      ));
    }
    if (s.fuenfStunden >= 0) {
      const wo = s.zurueck ? ` → ${s.zurueck}` : '';
      this.statusleiste.appendChild(feldchen(
        `limit ${stufe(s.fuenfStunden)}`,
        `5h ${Math.round(s.fuenfStunden)}%`,
        t('status.5h', { reset: wo }),
      ));
    }
    if (s.siebenTage >= 0) {
      this.statusleiste.appendChild(feldchen(
        `limit ${stufe(s.siebenTage)}`,
        `7d ${Math.round(s.siebenTage)}%`,
        t('status.7d'),
      ));
    }
    // Kosten nur, wenn der Harness sie GENANNT hat -- eine geschaetzte Zahl
    // saehe aus wie eine gemessene.
    if (s.kosten >= 0) {
      this.statusleiste.appendChild(feldchen(
        'kosten', t('kopf.kosten', { kosten: s.kosten.toFixed(4) }), t('status.kosten'),
      ));
    }
  }

  /**
   * DER KOPF SAGT NUR NOCH, WORAN DIE SITZUNG IST (Punkt 2, 12.08.).
   *
   * Bis heute standen hier ausserdem Ordner, Modell, Tokens und Kosten -- und
   * seit es die Statusleiste unten gibt, stuenden sie ZWEIMAL im Bild. Zwei
   * Stellen fuer dieselbe Zahl sind zwei Stellen, die auseinanderlaufen
   * koennen; die Zahlen gehoeren nach unten, wo sie auch im Terminal stehen.
   * Oben bleibt, was die Statusleiste NICHT traegt: der Zustand, ein Fehler und
   * das Angebot eines frischen Starts.
   */
  private zeichneKopf(stand: Stand): void {
    const g = stand.kopf;
    this.kopf.replaceChildren();

    let zustand: string;
    let klasse: string;
    if (!stand.laeuft) {
      zustand = t('zustand.beendet');
      klasse = 'beendet';
    } else if (g.wartetAufFreigabe) {
      zustand = t('zustand.freigabe');
      klasse = 'freigabe';
    } else if (g.arbeitet) {
      zustand = t('zustand.arbeitet');
      klasse = 'arbeitet';
    } else {
      zustand = t('zustand.wartet');
      klasse = 'ruhig';
    }
    this.kopf.appendChild(el('span', `csdk-marke zustand ${klasse}`, zustand));

    // EIN FEHLER GEHOERT IN DEN KOPF (Befund B2, 12.08.). Er steht ausserdem
    // als eigene Zeile im Verlauf; hier oben faellt er auch dann auf, wenn
    // der Verlauf weit oben steht.
    if (g.fehler) {
      const f = el('span', 'csdk-marke fehler', t('zustand.fehler'));
      f.title = g.fehler;
      this.kopf.appendChild(f);
    }

    // FRISCH STARTEN (Befund B3): nur, wenn es wirklich etwas zu starten gibt.
    if (stand.neustartMoeglich && !stand.laeuft) {
      const k = el('button', 'csdk-neustart', t('knopf.neustart'));
      k.type = 'button';
      k.addEventListener('click', () => this.haken.aufNeustart());
      this.kopf.appendChild(k);
    }
  }

  private block(b: Block): HTMLElement {
    if (b.art === 'werkzeug') return this.werkzeug(b);
    if (b.art === 'freigabe') return this.freigabe(b);
    return this.text(b);
  }

  /**
   * TEXT. Die Nachricht des Menschen steht im umrandeten Kasten, der Text des
   * Programms fliesst -- genau der Unterschied, den das Foto zeigt. Markdown
   * nur fuer diese beiden; chat/markdown.ts escaped erst und setzt dann
   * Muster ein, gibt also nie ungepruefter Text an innerHTML.
   */
  private text(b: TextBlock): HTMLElement {
    if (b.art === 'denken') {
      const zeile = el('div', 'csdk-zeile denken');
      zeile.appendChild(el('span', 'csdk-punkt'));
      const koerper = el('div', 'csdk-koerper');
      const kopf = el('button', 'csdk-klapp');
      kopf.type = 'button';
      kopf.textContent = t('wort.denken');
      const inhalt = el('div', 'csdk-denkentext');
      inhalt.textContent = b.text;
      this.klappbar(kopf, inhalt, b.id);
      koerper.append(kopf, inhalt);
      zeile.appendChild(koerper);
      return zeile;
    }

    if (b.art === 'mensch') {
      const kasten = el('div', 'csdk-mensch');
      kasten.innerHTML = markdownZuHtml(b.text);
      return kasten;
    }

    if (b.art === 'system') {
      const zeile = el('div', 'csdk-zeile system');
      zeile.appendChild(el('span', 'csdk-punkt'));
      zeile.appendChild(el('div', 'csdk-koerper csdk-systemtext', b.text));
      return zeile;
    }

    const zeile = el('div', `csdk-zeile agent${b.offen ? ' offen' : ''}`);
    zeile.appendChild(el('span', 'csdk-punkt'));
    const koerper = el('div', 'csdk-koerper csdk-agenttext');
    koerper.innerHTML = markdownZuHtml(b.text);
    zeile.appendChild(koerper);
    return zeile;
  }

  /** Klick klappt auf und zu; der Stand ueberlebt das naechste Zeichnen. */
  private klappbar(kopf: HTMLElement, inhalt: HTMLElement, id: string): void {
    const setzen = (auf: boolean): void => {
      inhalt.classList.toggle('auf', auf);
      kopf.classList.toggle('auf', auf);
    };
    setzen(this.offen.has(id));
    kopf.addEventListener('click', () => {
      const auf = !this.offen.has(id);
      if (auf) this.offen.add(id);
      else this.offen.delete(id);
      setzen(auf);
    });
  }

  /**
   * EIN WERKZEUGAUFRUF, wie im Foto: „Bash — <description>", darunter EIN und
   * AUS je in einer Zeile. Der Klick auf die Titelzeile klappt die volle
   * Eingabe und die volle Ausgabe auf.
   */
  private werkzeug(b: WerkzeugBlock): HTMLElement {
    const zeile = el('div', `csdk-zeile werkzeug${b.laeuft ? ' laeuft' : ''}${b.fehler ? ' fehler' : ''}`);
    zeile.appendChild(el('span', 'csdk-punkt'));
    const koerper = el('div', 'csdk-koerper');

    const kopf = el('button', 'csdk-klapp csdk-werkzeugkopf');
    kopf.type = 'button';
    kopf.appendChild(el('span', 'csdk-werkzeugname', b.name));
    if (b.beschreibung) kopf.appendChild(el('span', 'csdk-werkzeugsatz', b.beschreibung));
    if (b.laeuft) kopf.appendChild(el('span', 'csdk-lauf', t('wort.laeuft')));
    koerper.appendChild(kopf);

    const kurz = el('div', 'csdk-kurz');
    kurz.appendChild(this.paar(t('wort.ein'), b.ein));
    if (!b.laeuft) kurz.appendChild(this.paar(t('wort.aus'), this.eineZeile(b.aus), b.fehler));
    koerper.appendChild(kurz);

    const voll = el('div', 'csdk-voll');
    voll.appendChild(this.feldVoll(t('wort.ein'), b.einVoll));
    if (b.aus) voll.appendChild(this.feldVoll(t('wort.aus'), b.aus));
    koerper.appendChild(voll);
    this.klappbar(kopf, voll, b.id);

    zeile.appendChild(koerper);
    return zeile;
  }

  /** Die erste Zeile einer Ausgabe -- mehr passt nicht in eine Zeile. */
  private eineZeile(s: string): string {
    const zeilen = s.split('\n').filter((z) => z.trim());
    if (!zeilen.length) return '';
    const erste = zeilen[0].trim();
    return zeilen.length > 1 ? `${erste} …` : erste;
  }

  private paar(marke: string, wert: string, fehler = false): HTMLElement {
    const p = el('div', `csdk-paar${fehler ? ' fehler' : ''}`);
    p.appendChild(el('span', 'csdk-marke-klein', marke));
    p.appendChild(el('span', 'csdk-wert', wert));
    return p;
  }

  private feldVoll(marke: string, wert: string): HTMLElement {
    const f = el('div', 'csdk-vollfeld');
    f.appendChild(el('div', 'csdk-marke-klein', marke));
    const pre = el('pre', 'csdk-pre');
    pre.textContent = wert;
    f.appendChild(pre);
    return f;
  }

  /**
   * DIE FREIGABEFRAGE. Sie ist der Grund, warum diese Ansicht ein eigenes
   * Fenster verdient: eine Frage, die niemand sieht, haelt die Sitzung an,
   * ohne zu sagen warum.
   */
  private freigabe(b: FreigabeBlock): HTMLElement {
    const kasten = el('div', `csdk-freigabe${b.offen ? ' offen' : ' entschieden'}${b.defekt ? ' defekt' : ''}`);
    kasten.appendChild(el('div', 'csdk-freigabe-titel', t('freigabe.frage', { name: b.name })));
    if (b.beschreibung) kasten.appendChild(el('div', 'csdk-freigabe-satz', b.beschreibung));
    const pre = el('pre', 'csdk-pre');
    pre.textContent = b.einVoll;
    kasten.appendChild(pre);

    // OHNE KENNUNG KEINE KNOEPFE (Befund B7, 12.08.). Eine Antwort mit leerer
    // `request_id` ordnet die CLI keiner Frage zu: die Sitzung stuende weiter,
    // waehrend hier „erlaubt" stuende. Und ein Klick schloesse jede andere
    // kennungslose Frage gleich mit. Ehrlicher ist, den Kasten als defekt zu
    // kennzeichnen.
    if (b.defekt) {
      kasten.appendChild(el('div', 'csdk-freigabe-stand defekt', t('freigabe.defekt')));
      return kasten;
    }

    if (b.offen) {
      const knoepfe = el('div', 'csdk-freigabe-knoepfe');
      const ja = el('button', 'csdk-ja', t('freigabe.erlauben'));
      ja.type = 'button';
      ja.addEventListener('click', () => this.haken.aufFreigabe(b.anfrageId, true));
      const nein = el('button', 'csdk-nein', t('freigabe.ablehnen'));
      nein.type = 'button';
      nein.addEventListener('click', () => this.haken.aufFreigabe(b.anfrageId, false));
      knoepfe.append(ja, nein);
      kasten.appendChild(knoepfe);
      return kasten;
    }

    // Drei Ausgaenge: erlaubt, abgelehnt -- oder der Harness hat die Frage
    // zurueckgezogen (Befund B6).
    let wort: string;
    if (b.entschieden === 'erlaubt') wort = t('freigabe.erlaubt');
    else if (b.entschieden === 'zurueckgezogen') wort = t('freigabe.zurueckgezogen');
    else wort = t('freigabe.abgelehnt');
    kasten.appendChild(el('div', `csdk-freigabe-stand ${b.entschieden}`, wort));
    return kasten;
  }
}
