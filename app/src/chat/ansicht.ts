// DIE ANSICHT -- das Gespraech statt des Terminalbilds (SPEC-V4 Abschnitt 6).
//
// SIE LEGT SICH UEBER DEN PANE, sie ersetzt ihn nicht. Der Pane laeuft weiter
// und wird weiter ausgewertet; sichtbar ist nur die andere Darstellung. Das ist
// kein Schoenheitsfehler, sondern die Bedingung dafuer, dass die Ansicht
// funktioniert: ohne den Pane weiss nichts im Haus, ob das Programm gerade
// fragt, antwortet oder wartet (SPEC-V4 6.2).
//
// GETIPPT WIRD WEITERHIN IM TERMINAL. Diese Datei hat kein Eingabefeld und
// keinen Weg, einen Text abzuschicken -- die Eingabe bleibt am Pane, zwingend.
//
// DREI DINGE AUS DER BILDSCHIRMAUSWERTUNG stehen oben in der Leiste, weil sie in
// keinem Protokoll stehen: eine wartende Freigabe, die Kontextauslastung und ob
// das Programm gerade arbeitet. Eine Ansicht ohne sie waere huebscher und
// schlechter.
//
// Reines DOM, keine Bruecke, kein Zugriff auf `window.awb*`: was gezeigt wird,
// kommt herein; was der Mensch drueckt, geht als Rueckruf hinaus. So laesst sich
// die Ansicht ohne Electron zeichnen und pruefen.
import type { ChatNachricht, ChatStand } from './typen';
import { setzeSprache, t } from './texte';
import { markdownZuHtml } from './markdown';
import { bildmass } from './bildplatzhalter';

export interface AnsichtHaken {
  /** Der Mensch will zurueck zum Terminal. */
  aufTerminal(): void;
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

function uhrzeit(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const zwei = (n: number): string => String(n).padStart(2, '0');
  return `${zwei(d.getHours())}:${zwei(d.getMinutes())}`;
}

/** Zwei Nachrichten flach vergleichen -- die Grundlage des Anhaenge-Vergleichs unten. */
function gleicheNachricht(a: ChatNachricht, b: ChatNachricht): boolean {
  return a.rolle === b.rolle && a.text === b.text && a.zeit === b.zeit && a.art === b.art;
}

/**
 * EINE Ansicht je Pane. Sie haengt in dem Kasten, in dem sonst das Terminal
 * zeichnet, und wird sichtbar oder unsichtbar geschaltet -- das Terminal
 * darunter bleibt, wie es ist.
 */
export class ChatAnsicht {
  private readonly wurzel: HTMLDivElement;

  private readonly leiste: HTMLDivElement;

  private readonly verlauf: HTMLDivElement;

  private readonly fuss: HTMLDivElement;

  /** Stand des Bildlaufs: klebt die Ansicht unten, folgt sie neuen Zeilen. */
  private amEnde = true;

  /**
   * DER ZULETZT GEZEICHNETE VERLAUF (Befund 8, 15.08.). Bis dahin warf
   * `zeichne()` bei JEDEM Poll (alle zwei Sekunden, unabhaengig davon, ob sich
   * etwas geaendert hatte) den ganzen Verlauf mit `replaceChildren()` weg und
   * baute ihn neu auf -- die Textauswahl im Verlauf sprang darum alle zwei
   * Sekunden weg. Die Chatbuehne macht es mit rev-Nummern je Block richtig vor
   * (chatbuehne/ansicht.ts); hier gibt es keine Bloecke mit eigener Kennung,
   * nur eine Liste von Nachrichten, die fast immer am ALTEN Anfang weiterwaechst.
   * Deshalb genuegt der einfachere Vergleich: bleibt der alte Anfang
   * wortgleich stehen, werden nur die neuen Zeilen angehaengt, die
   * bestehenden DOM-Knoten -- und mit ihnen eine offene Textauswahl -- bleiben
   * unangetastet. Nur wenn sich auch nur eine alte Zeile aendert (seltener
   * Fall: das Protokoll wurde umgeschrieben oder gekuerzt), wird komplett neu
   * gezeichnet.
   */
  private letzteNachrichten: ChatNachricht[] = [];

  /** Zeigt der Verlauf gerade Nachrichten (statt eines Grund-/Leertexts)? */
  private verlaufMitNachrichten = false;

  constructor(private readonly haken: AnsichtHaken) {
    this.wurzel = el('div', 'chatansicht');
    this.leiste = el('div', 'chat-leiste');
    this.verlauf = el('div', 'chat-verlauf');
    this.fuss = el('div', 'chat-fuss');
    this.wurzel.append(this.leiste, this.verlauf, this.fuss);
    this.verlauf.addEventListener('scroll', () => {
      const rest = this.verlauf.scrollHeight - this.verlauf.scrollTop - this.verlauf.clientHeight;
      this.amEnde = rest < 40;
    });
  }

  /** Der Kasten, den der Aufrufer irgendwo einhaengt. */
  element(): HTMLDivElement {
    return this.wurzel;
  }

  sichtbar(an: boolean): void {
    this.wurzel.classList.toggle('an', an);
  }

  istSichtbar(): boolean {
    return this.wurzel.classList.contains('an');
  }

  /** Neu zeichnen. Billig genug fuer den Takt der Oberflaeche: 200 Zeilen DOM. */
  zeichne(stand: ChatStand): void {
    // Kommt mit jedem Stand herein (main.ts, IPC `awb:chat-stand`) -- diese Datei bleibt damit
    // frei von einem eigenen Zugriff auf `window.awb*`, wie der Kopfkommentar es verlangt.
    setzeSprache(stand.sprache);
    this.zeichneLeiste(stand);
    this.zeichneVerlauf(stand);
    this.fuss.replaceChildren();
    this.fuss.appendChild(el('span', 'chat-quelle', stand.quelle ? t('kopf.quelle', { quelle: stand.quelle }) : ''));
    this.fuss.appendChild(el('span', 'chat-hinweis', t('kopf.hinweis')));
    if (this.amEnde) this.verlauf.scrollTop = this.verlauf.scrollHeight;
  }

  /** Siehe `letzteNachrichten` oben: anhaengen statt neu bauen, wo es geht. */
  private zeichneVerlauf(stand: ChatStand): void {
    const neu = stand.moeglich ? stand.nachrichten : [];
    if (!neu.length) {
      this.letzteNachrichten = [];
      this.verlaufMitNachrichten = false;
      this.verlauf.replaceChildren();
      this.verlauf.appendChild(el('div', 'chat-grund',
        stand.moeglich ? t('grund.leer') : (stand.grund || t('grund.keinBlock'))));
      return;
    }
    const alt = this.letzteNachrichten;
    const gleicherAnfang = this.verlaufMitNachrichten
      && neu.length >= alt.length
      && alt.every((n, i) => gleicheNachricht(n, neu[i]));
    if (gleicherAnfang) {
      for (let i = alt.length; i < neu.length; i++) this.verlauf.appendChild(this.zeile(neu[i]));
    } else {
      this.verlauf.replaceChildren();
      for (const n of neu) this.verlauf.appendChild(this.zeile(n));
    }
    this.letzteNachrichten = neu;
    this.verlaufMitNachrichten = true;
  }

  private zeile(n: ChatNachricht): HTMLDivElement {
    const kasten = el('div', `chat-zeile rolle-${n.rolle} art-${n.art}`);
    const kopf = el('div', 'chat-kopf');
    kopf.appendChild(el('span', 'chat-sprecher', t(`rolle.${n.rolle}`)));
    if (n.art === 'denken') kopf.appendChild(el('span', 'chat-art', t('wort.denken')));
    const zeit = uhrzeit(n.zeit);
    if (zeit) kopf.appendChild(el('span', 'chat-zeit', zeit));
    kasten.append(kopf, this.text(n));
    return kasten;
  }

  /**
   * DER TEXT EINER ZEILE. Der Bild-Platzhalter des Harness
   * (chat/bildplatzhalter.ts) geht vor -- er ist keine Nachricht, die
   * formatiert werden soll, sondern Harness-Buchfuehrung, die durch einen
   * eigenen, knappen Satz ersetzt wird; der Koordinaten-Satz erscheint nie,
   * und bei der Form OHNE Groesse (nur ein Dateipfad) erscheint auch der Pfad
   * nie (Reviewer-Befund B3, 12.08.). Danach: Markdown nur fuer You/Program
   * (mensch/agent) -- REIN, weil chat/markdown.ts erst HTML-escaped und dann
   * Muster einsetzt, nie ungeprueften Text an innerHTML uebergibt. Werkzeug-
   * und Systemzeilen bleiben rohes Monospace, wie das Protokoll sie liefert.
   */
  private text(n: ChatNachricht): HTMLDivElement {
    if (n.rolle === 'mensch') {
      const mass = bildmass(n.text);
      if (mass) {
        const beschriftung = mass.breite !== null && mass.hoehe !== null
          ? t('bild.mass', { breite: mass.breite, hoehe: mass.hoehe })
          : t('bild.ohneMass');
        return el('div', 'chat-text chat-bild', beschriftung);
      }
    }
    const feld = el('div', 'chat-text');
    if (n.rolle === 'mensch' || n.rolle === 'agent') feld.innerHTML = markdownZuHtml(n.text);
    else feld.textContent = n.text;
    return feld;
  }

  /**
   * Die Leiste traegt genau das, was NICHT aus dem Protokoll kommt -- und sie
   * sagt es auch: eine Zahl ohne Herkunft ist in diesem Haus eine Behauptung.
   */
  private zeichneLeiste(stand: ChatStand): void {
    this.leiste.replaceChildren();
    this.leiste.appendChild(el('span', 'chat-titel', t('kopf.titel')));

    const b = stand.bruecke;
    if (b.freigabeOffen) {
      const f = el('span', 'chat-marke freigabe', b.freigabeText || t('bruecke.freigabe'));
      f.title = t('bruecke.freigabe.herkunft');
      this.leiste.appendChild(f);
    }
    // WORAUF DIE ZUORDNUNG BERUHT -- neben den drei Bruecken-Marken, und aus
    // demselben Grund wie sie: eine Angabe ohne Herkunft ist in diesem Haus eine
    // Behauptung. Nur gezeigt, wenn wirklich ein Gespraech dasteht; bei einem
    // Nein steht der Grund ohnehin im Klartext in der Flaeche.
    if (stand.moeglich && stand.herkunft) {
      const h = el('span', `chat-marke herkunft ${stand.herkunft}`, t(`herkunft.${stand.herkunft}`));
      h.title = t(`herkunft.${stand.herkunft}.titel`);
      this.leiste.appendChild(h);
    }

    const last = b.auslastung >= 0
      ? el('span', 'chat-marke last', t('bruecke.auslastung', { prozent: b.auslastung }))
      : el('span', 'chat-marke last unbekannt', t('bruecke.auslastung.fehlt'));
    if (b.tokens && b.fenster) last.title = t('bruecke.auslastung.zahlen', { tokens: b.tokens, fenster: b.fenster });
    this.leiste.appendChild(last);
    this.leiste.appendChild(
      el('span', `chat-marke ${b.arbeitet ? 'arbeitet' : 'ruhig'}`, b.arbeitet ? t('bruecke.arbeitet') : t('bruecke.ruhig')),
    );

    const knopf = el('button', 'chat-knopf', t('kopf.terminal'));
    knopf.addEventListener('click', () => this.haken.aufTerminal());
    this.leiste.appendChild(knopf);
  }
}
