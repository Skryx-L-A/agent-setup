// Schritt 7, Oberflaechenseite: die uebernommenen Seiten anzeigen.
//
// Die Seiten sind vollstaendige HTML-Dokumente mit eigener CSP, eigenem
// Stylesheet und eigenen Skripten. Sie kommen deshalb in einen `<iframe>` und
// nicht in ein `<div>`: Ihre Regeln (`body { margin: 0 }`, eigene Schriftgroesse,
// dreissig Farbvariablen) wuerden sich sonst mit denen der Anwendung schlagen,
// und ihre CSP waere wirkungslos. Im Rahmen bleibt jede Seite genau das
// Dokument, das die Extension ausliefert -- unveraendert, wie der Plan verlangt.
//
// DER EINE UEBERSETZUNGSPUNKT ist `acquireVsCodeApi`. Die Seiten rufen es auf
// und schicken danach Nachrichten (`vscode.postMessage({command: 'neu'})`).
// Diese Funktion gibt es hier nicht -- also wird sie gestellt, mit demselben
// Vertrag: `postMessage`, `getState`, `setState`. Was hinausgeht, landet im
// Hauptprozess.
//
// Sie muss stehen, BEVOR das Skript der Seite laeuft. Deshalb `about:blank`
// plus `document.write` statt `srcdoc`: Beim Schreiben in ein bestehendes
// Dokument bleibt dessen `window` dasselbe Objekt, und was vorher darauf
// gesetzt wurde, ist beim Parsen schon da. Mit `srcdoc` entstuende ein neues
// `window`, und die Seite liefe in ihr eigenes `acquireVsCodeApi is not
// defined`.

export interface SeitenWege {
  /** Eine Nachricht der Seite an den Hauptprozess. */
  nachricht(seite: string, daten: unknown): void;
  /** Die Zustimmung zu einem gezeigten Plan. */
  ausfuehren(): void;
  /** Der Mensch will doch nicht. */
  abbrechen(): void;
}

/** Was der Hauptprozess vor einer Handlung zeigt (siehe main/befehle.ts). */
export interface PlanAnzeige {
  art: 'sofort' | 'bestaetigen' | 'abgelehnt' | 'offen';
  command: string;
  beschreibung: string;
  aufruf?: string[];
  grund?: string;
}

const STIL = `
#seiten {
  position: absolute; inset: 0; z-index: 30;
  display: none; flex-direction: column;
  background: var(--grund);
}
#seiten.offen { display: flex; }
#seiten .kopf {
  flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
  padding: 4px 8px; border-bottom: 1px solid var(--linie); background: var(--leiste);
}
#seiten .kopf .titel { font-weight: 600; }
#seiten .kopf .weg { color: var(--gedaempft); font-size: 10px; }
#seiten .kopf .fueller { flex: 1 1 auto; }
#seiten .kopf button {
  background: transparent; color: var(--schrift); border: 1px solid var(--linie);
  border-radius: 3px; font: inherit; font-size: 11px; padding: 2px 8px; cursor: pointer;
}
#seiten .kopf button:hover { background: #222833; }
#seiten .kopf button.gewaehlt { background: #222833; border-color: var(--fern); }
#seiten iframe { flex: 1 1 auto; width: 100%; border: 0; background: var(--grund); }
/* Die Rueckfrage vor jeder Handlung mit Nebenwirkung. Sie liegt UEBER der
   Seite und nimmt ihr die Bedienung ab, solange sie steht -- ein zweiter Klick
   auf denselben Knopf soll nicht zwei Handlungen ausloesen. */
#seiten .rueckfrage {
  position: absolute; inset: 0; z-index: 40;
  display: flex; align-items: center; justify-content: center;
  background: #0b0d11cc;
}
#seiten .rueckfrage .kasten {
  background: var(--leiste); border: 1px solid var(--linie); border-radius: 6px;
  padding: 14px 16px; max-width: 620px; display: flex; flex-direction: column; gap: 10px;
  box-shadow: 0 10px 30px rgba(0,0,0,.5);
}
#seiten .rueckfrage .was { font-weight: 600; }
#seiten .rueckfrage .aufruf {
  color: var(--gedaempft); font-size: 11px; background: var(--grund);
  border: 1px solid var(--linie); border-radius: 3px; padding: 6px 8px;
  white-space: pre-wrap; word-break: break-all;
}
#seiten .rueckfrage .grund { color: var(--will); }
#seiten .rueckfrage .reihe { display: flex; gap: 8px; justify-content: flex-end; }
#seiten .rueckfrage button.tun { border-color: var(--laeuft); }
`;

/**
 * Die Reiter dieser Flaeche. 'einstellungen' steht hier seit dem 05.08. NICHT
 * mehr: Die Einstellungen haben ein eigenes Fenster (A9,
 * main/einstellungsfenster.ts), und Vorgabe des Nutzers dazu ist woertlich "nur
 * die Settings" -- keine Reiterzeile, kein geteilter Platz.
 *
 * Die Renderfunktion der alten Seite bleibt trotzdem erreichbar
 * (main/seiten.ts, `renderSeite('einstellungen')`): Die Erweiterung benutzt sie
 * weiter, und shell/tests/test-app-seiten.sh prueft sie ueber den Steuerkanal.
 * Was verschwunden ist, ist der Weg eines MENSCHEN dorthin.
 */
const TITEL: Record<string, string> = {
  start: 'Startseite',
};

/** Muss mit SEITEN_SCHEMA in main/seiten.ts uebereinstimmen. */
const SCHEMA = 'awb-seite';

export class Seiten {
  private wurzel: HTMLElement;
  private zaehler = 0;
  private rahmen: HTMLIFrameElement;
  private titelEl: HTMLElement;
  private knoepfe = new Map<string, HTMLButtonElement>();
  private aktuell = '';
  /**
   * Seiten, die auf eine Auffrischung warten, weil ein Feld im Fokus stand,
   * als die Datei sich aenderte -- und der Zeitgeber, der es kurz erneut
   * versucht (siehe aufDateiAendern). Ein FOKUS-EREIGNIS waere die sauberere
   * Quelle, aber dieses Fenster bekommt nie programmatisch den Fokus
   * (main.ts: "kein win.focus()"), und ohne eigenen Fokus unterdrueckt
   * Chromium 'focusin'/'focusout' vollstaendig (gemessen: activeElement
   * stimmt, das Ereignis bleibt aus) -- deshalb wird GEFRAGT statt gemeldet.
   */
  private ausstehend = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private wege: SeitenWege, ziel: HTMLElement = document.body) {
    const stil = document.createElement('style');
    stil.id = 'seiten-stil';
    stil.textContent = STIL;
    document.head.appendChild(stil);

    this.wurzel = document.createElement('div');
    this.wurzel.id = 'seiten';

    const kopf = document.createElement('div');
    kopf.className = 'kopf';
    // Kein eigener Titel neben den Reitern -- der gewaehlte Reiter sagt es
    // bereits, und zweimal dasselbe Wort nebeneinander liest sich wie ein Fehler
    // (am Bild gesehen).
    this.titelEl = document.createElement('span');
    this.titelEl.className = 'titel';
    this.titelEl.hidden = true;
    kopf.appendChild(this.titelEl);
    for (const name of Object.keys(TITEL)) {
      const b = document.createElement('button');
      b.textContent = TITEL[name];
      b.dataset.seite = name;
      b.addEventListener('click', () => this.oeffne(name));
      kopf.appendChild(b);
      this.knoepfe.set(name, b);
    }
    const fueller = document.createElement('div');
    fueller.className = 'fueller';
    kopf.appendChild(fueller);
    const zu = document.createElement('button');
    zu.className = 'schliessen';
    zu.textContent = 'Schliessen';
    zu.addEventListener('click', () => this.schliesse());
    kopf.appendChild(zu);

    this.rahmen = document.createElement('iframe');
    this.rahmen.setAttribute('title', 'uebernommene Seite');
    // about:blank, damit das window schon existiert, bevor geschrieben wird.
    // Die Seite kommt ueber ihr eigenes Schema (siehe zeige()).
    // Antworten der Seite auf unsere Fragen einsammeln (siehe bootstrap()).
    window.addEventListener('message', (e) => {
      const d = e.data as { __awbAntwort?: boolean; nr?: number; antwort?: unknown } | null;
      if (!d || d.__awbAntwort !== true || typeof d.nr !== 'number') return;
      const warten = this.offeneFragen.get(d.nr);
      if (!warten) return;
      this.offeneFragen.delete(d.nr);
      warten(d.antwort);
    });

    this.wurzel.append(kopf, this.rahmen);
    ziel.appendChild(this.wurzel);
  }

  /** Welche Seite gerade offen ist -- leer, wenn keine. */
  offen(): string {
    return this.wurzel.classList.contains('offen') ? this.aktuell : '';
  }

  /** Ein Klick auf einen Reiter: das HTML holen. Gezeigt wird es in `zeige`. */
  oeffne(name: string): void {
    this.wege.nachricht('__oeffnen', name);
  }

  schliesse(): void {
    // Der Hauptprozess fuehrt dieselbe Buchfuehrung (seiteOffen in main.ts) --
    // ohne diese Nachricht wuesste er nur vom Oeffnen (oeffne() unten), nie
    // vom Schliessen ueber diesen Knopf.
    if (this.aktuell) this.wege.nachricht('__schliessen', this.aktuell);
    this.wurzel.classList.remove('offen');
    this.wiederholungAbbrechen(this.aktuell);
    this.aktuell = '';
    for (const b of this.knoepfe.values()) b.classList.remove('gewaehlt');
  }

  /** Nur fuer die Pruefung: die echte Schliessen-Schaltflaeche im Rahmen anklicken. */
  schliessenKlick(): boolean {
    const btn = this.wurzel.querySelector<HTMLButtonElement>('.kopf button.schliessen');
    if (!btn) return false;
    btn.click();
    return true;
  }

  /**
   * Die Datei hinter `name` hat sich von aussen geaendert (Reste-Auftrag,
   * Punkt 3 -- `wb-state settings set`, die Modell-Registry oder eine neue
   * Sessiondatei schreiben sie dauernd). `offen()` ist hier die einzige
   * Wahrheit, ob wirklich neu gezeichnet wird: eine Seite, die nicht offen
   * ist (oder eine ANDERE Seite zeigt), wird nicht gezeichnet -- und auch die
   * offene nicht, solange sie noch auf eine Zustimmung wartet oder ein Feld in
   * ihr gerade den Fokus haelt (die Eingabe darf nicht verschwinden). Ob ein
   * Feld den Fokus haelt, wird bei JEDEM Aufruf frisch GEFRAGT (activeElement
   * ist immer aktuell), nicht aus einem zuvor gemeldeten Zustand geraten.
   */
  async aufDateiAendern(name: string): Promise<void> {
    if (this.offen() !== name) return;
    if (this.wurzel.querySelector('.rueckfrage')) return;
    const zustand = await this.frageAnSeite<{ feldFokussiert?: boolean }>('zustand');
    // Zwischen dem Abschicken der Frage und der Antwort kann sich die Seite
    // geschlossen oder gewechselt haben -- dann gilt dieselbe Regel wie oben.
    if (this.offen() !== name) return;
    if (zustand?.feldFokussiert) {
      this.wiederholungPlanen(name);
      return;
    }
    this.wiederholungAbbrechen(name);
    this.zeige(name);
  }

  /**
   * Kein Ereignis meldet zuverlaessig, wann ein Feld den Fokus wieder
   * verlaesst (siehe Klassendoc zu `ausstehend`) -- deshalb ein kurzer,
   * SELBST BEGRENZTER Versuch: in einer Sekunde erneut fragen. Kein Dauer-Takt
   * fuer die Seite selbst, nur das Warten auf das Ende einer bereits
   * ausgeloesten, noch nicht zustellbaren Auffrischung -- er laeuft nur,
   * solange wirklich eine aussteht, und stoppt von selbst, sobald sie zustellt
   * oder die Seite schliesst.
   */
  private wiederholungPlanen(name: string): void {
    if (this.ausstehend.has(name)) return;
    const timer = setTimeout(() => {
      this.ausstehend.delete(name);
      void this.aufDateiAendern(name);
    }, 1000);
    this.ausstehend.set(name, timer);
  }

  private wiederholungAbbrechen(name: string): void {
    const timer = this.ausstehend.get(name);
    if (timer) {
      clearTimeout(timer);
      this.ausstehend.delete(name);
    }
  }

  /**
   * Das fertige Dokument in den Rahmen schreiben. `acquireVsCodeApi` wird
   * vorher auf dessen `window` gesetzt -- danach laufen die Skripte der Seite
   * und finden es vor.
   */
  zeige(name: string): void {
    // Wer eine Seite schickt, will sie sehen. Der Hauptprozess zeichnet nur auf
    // Anforderung -- also ist das Eintreffen die Anforderung, ganz gleich ob sie
    // vom Knopf kam oder ueber den Steuerkanal.
    if (this.aktuell !== name) {
      this.aktuell = name;
      this.wurzel.classList.add('offen');
      this.titelEl.textContent = TITEL[name] ?? name;
      for (const [n, b] of this.knoepfe) b.classList.toggle('gewaehlt', n === name);
    }
    // Eine wartende Auffrischung ist mit diesem Zeichnen ohnehin erledigt.
    this.wiederholungAbbrechen(name);
    // Der Rahmen HOLT die Seite ueber das eigene Schema, statt sie geschrieben
    // zu bekommen. Nur so hat sie eine eigene Herkunft und damit ihre eigene
    // CSP -- und nur dann laufen ihre Skripte und ihre Knoepfe tun etwas.
    // Der Zaehler haengt an, damit ein erneutes Zeichen auch wirklich neu laedt.
    this.zaehler += 1;
    this.rahmen.src = `${SCHEMA}://${name}/?v=${this.zaehler}`;
  }

  /**
   * Eine Frage an die Seite. Sie liegt in einem Rahmen mit EIGENER Herkunft --
   * ihr Dokument ist von hier aus nicht lesbar, und das ist der Preis dafuer,
   * dass ihre eigene CSP gilt und ihre Knoepfe ueberhaupt etwas tun. Also wird
   * gefragt statt hineingegriffen; geantwortet wird im Bootstrap der Seite.
   *
   * Mit Frist: eine Seite, die nicht antwortet, darf niemanden haengen lassen.
   */
  private frageAnSeite<T>(was: string, auswahl?: string): Promise<T | null> {
    const nr = ++this.fragenNr;
    return new Promise<T | null>((auf) => {
      const uhr = setTimeout(() => {
        this.offeneFragen.delete(nr);
        auf(null);
      }, 3000);
      this.offeneFragen.set(nr, (antwort) => {
        clearTimeout(uhr);
        auf(antwort as T);
      });
      this.rahmen.contentWindow?.postMessage({ __awbAn: true, nr, was, auswahl }, '*');
    });
  }

  /**
   * Zu einem Abschnitt der Seite rollen. Gebraucht fuer die Abnahme am Auge:
   * Die Modelltabelle steht weit unten, und ein Bild vom Seitenanfang zeigt
   * genau das nicht, worauf es bei V11 ankommt.
   */
  rolleZu(auswahl: string): Promise<boolean> {
    return this.frageAnSeite<boolean>('rolle', auswahl).then((r) => r === true);
  }

  /**
   * Die Rueckfrage vor einer Handlung mit Nebenwirkung -- und die Auskunft,
   * wenn ein Knopf keinen Empfaenger hat. Beides steht sichtbar da, statt
   * still zu geschehen oder still zu unterbleiben.
   */
  frage(plan: PlanAnzeige): void {
    this.wurzel.querySelector('.rueckfrage')?.remove();
    const huelle = document.createElement('div');
    huelle.className = 'rueckfrage';
    huelle.dataset.art = plan.art;
    huelle.dataset.command = plan.command;
    const kasten = document.createElement('div');
    kasten.className = 'kasten';

    const was = document.createElement('div');
    was.className = 'was';
    was.textContent = plan.art === 'bestaetigen'
      ? plan.beschreibung
      : plan.art === 'offen'
        ? `'${plan.command}' hat hier noch keinen Empfaenger.`
        : plan.command === 'ergebnis'
          ? plan.beschreibung
          : `'${plan.command}' wird nicht ausgefuehrt.`;
    kasten.appendChild(was);

    if (plan.grund) {
      const g = document.createElement('div');
      g.className = 'grund';
      g.textContent = plan.grund;
      kasten.appendChild(g);
    }
    if (plan.aufruf?.length) {
      const a = document.createElement('div');
      a.className = 'aufruf';
      // Wortwoertlich das, was laufen wird -- nicht eine Beschreibung davon.
      a.textContent = plan.aufruf.join(' ');
      kasten.appendChild(a);
    }

    const reihe = document.createElement('div');
    reihe.className = 'reihe';
    const zu = document.createElement('button');
    zu.textContent = plan.art === 'bestaetigen' ? 'Abbrechen' : 'Verstanden';
    zu.addEventListener('click', () => {
      huelle.remove();
      this.wege.abbrechen();
    });
    reihe.appendChild(zu);
    if (plan.art === 'bestaetigen') {
      const tun = document.createElement('button');
      tun.className = 'tun';
      tun.textContent = 'Ausfuehren';
      tun.addEventListener('click', () => {
        huelle.remove();
        this.wege.ausfuehren();
      });
      reihe.appendChild(tun);
    }
    kasten.appendChild(reihe);
    huelle.appendChild(kasten);
    this.wurzel.appendChild(huelle);
  }

  /** Das Ergebnis einer ausgefuehrten Handlung, kurz sichtbar. */
  ergebnis(text: string, ok: boolean): void {
    this.frage({ art: ok ? 'sofort' : 'abgelehnt', command: 'ergebnis', beschreibung: text, grund: ok ? undefined : text });
  }

  /** Einen Knopf IM RAHMEN anklicken. Gibt zurueck, ob es ihn gab. */
  klick(auswahl: string): Promise<boolean> {
    return this.frageAnSeite<boolean>('klick', auswahl).then((r) => r === true);
  }

  /** Nur fuer die Pruefung der Auffrischung: ein Feld gezielt fokussieren. */
  fokussiere(auswahl: string): Promise<boolean> {
    return this.frageAnSeite<boolean>('fokus', auswahl).then((r) => r === true);
  }

  /** Nur fuer die Pruefung der Auffrischung: ein fokussiertes Feld gezielt verlassen. */
  entfokussiere(): Promise<boolean> {
    return this.frageAnSeite<boolean>('unfokus').then((r) => r === true);
  }

  /** Was gerade im Rahmen steht -- fuer Pruefungen ohne Foto. */
  async zustand(): Promise<unknown> {
    const frage = this.wurzel.querySelector<HTMLElement>('.rueckfrage');
    const seite = (await this.frageAnSeite<Record<string, unknown>>('zustand')) ?? {};
    return {
      offen: this.offen(),
      titel: this.titelEl.textContent ?? '',
      // Die Rueckfrage gehoert dem WIRT und ist deshalb von hier lesbar.
      rueckfrage: frage
        ? {
            art: frage.dataset.art ?? '',
            command: frage.dataset.command ?? '',
            text: (frage.textContent ?? '').trim(),
            aufruf: (frage.querySelector('.aufruf')?.textContent ?? '').trim(),
            hatAusfuehren: !!frage.querySelector('button.tun'),
          }
        : null,
      // Alles aus dem Dokument der Seite kommt aus ihrer eigenen Auskunft.
      ...seite,
    };
  }

  private fragenNr = 0;
  private offeneFragen = new Map<number, (antwort: unknown) => void>();
}
