// DIE VERVOLLSTAENDIGUNG IM EINGABEFELD DER CHAT-SITZUNG (Punkt 3):
// `/` zeigt die Slash-Befehle des Harness, `@` die Dateien des Projektordners.
//
// ZWEI TEILE, UND DER OBERE IST REIN. Was gerade getippt wird -- steht der
// Schreibstrich hinter einem `/` am Zeilenanfang, hinter einem `@` mitten im
// Satz, oder hinter gar nichts? -- ist eine Frage an eine Zeichenkette und eine
// Zahl, sonst nichts. Sie steht deshalb als reine Funktion hier oben und wird
// getrennt geprueft (shell/tests/test-app-chatsdk-strom.sh); der DOM-Teil
// darunter kann sie nur noch falsch anzeigen, nicht mehr falsch entscheiden.
//
// KEIN EMOJI, keine fremde Bibliothek: dieselbe Auflage wie im Rest des Hauses.

/** Welche Sorte Vervollstaendigung gerade offen ist. */
export type Vervollart = 'befehl' | 'datei';

/** Was an der Schreibmarke steht -- `null`, wenn nichts vorzuschlagen ist. */
export interface Ausloeser {
  art: Vervollart;
  /**
   * Was hinter dem Auslosezeichen schon getippt ist, ohne das Zeichen selbst --
   * bis zur SCHREIBMARKE, nicht bis zum Wortende. Gefiltert wird nach dem, was
   * der Mensch geschrieben HAT, nicht nach dem, was noch dahintersteht.
   */
  muster: string;
  /** Die Stelle des Auslosezeichens im Text -- von hier an wird ersetzt. */
  von: number;
  /**
   * BIS WOHIN ERSETZT WIRD -- das WORTENDE, nicht die Schreibmarke
   * (Reviewbefund 8, 12.08.).
   *
   * Hier stand die Marke. Steht sie mitten im Wort -- im Feld `/compact`, die
   * Marke hinter `/co`, weil jemand geklickt oder die Pfeiltaste gedrueckt hat
   * --, dann ersetzte das Einsetzen nur `/co` und liess `mpact` stehen:
   * `/compact mpact`. Dasselbe bei `@app/src` mit der Marke hinter `@app`.
   */
  bis: number;
}

/**
 * WAS AN DER SCHREIBMARKE STEHT.
 *
 * DIE REGELN, und warum sie so und nicht anders sind:
 *
 *   `/`  gilt NUR als ERSTES Zeichen des Feldes. Genauso verhaelt sich die CLI
 *        im Terminal, und aus gutem Grund: ein Schraegstrich kommt in jedem
 *        zweiten Pfad und in jedem Datum vor, und eine Liste, die bei
 *        „schreib das nach app/src" aufspringt, ist im Weg statt zur Hand.
 *
 *   `@`  gilt ueberall, aber nur am WORTANFANG -- am Textanfang oder hinter
 *        einem Leerzeichen. Sonst spraenge die Liste mitten in jeder
 *        E-Mail-Adresse auf.
 *
 * Ein Leerzeichen im Muster beendet beide: wer weitergeschrieben hat, meint
 * keinen Vorschlag mehr. Bei `/` beendet es die Liste auch dann, wenn danach
 * noch Argumente folgen -- der Befehl steht dann schon fest.
 */
export function ausloeser(text: string, marke: number): Ausloeser | null {
  const hier = Math.max(0, Math.min(marke, text.length));
  // Das Wortende hinter der Marke: bis zum naechsten Leerzeichen oder bis zum
  // Schluss. Von hier an wird ersetzt, damit kein Rest stehenbleibt.
  let ende = hier;
  while (ende < text.length && !/\s/.test(text[ende])) ende += 1;

  if (text.startsWith('/')) {
    const muster = text.slice(1, hier);
    if (hier >= 1 && !/\s/.test(muster)) return { art: 'befehl', muster, von: 0, bis: ende };
  }

  // Rueckwaerts bis zum naechsten `@` oder Leerzeichen -- was zuerst kommt.
  for (let i = hier - 1; i >= 0; i -= 1) {
    const z = text[i];
    if (/\s/.test(z)) return null;
    if (z !== '@') continue;
    const davor = i === 0 ? '' : text[i - 1];
    if (davor !== '' && !/\s/.test(davor)) return null;
    return { art: 'datei', muster: text.slice(i + 1, hier), von: i, bis: ende };
  }
  return null;
}

/**
 * DEN VORSCHLAG EINSETZEN. Gibt den neuen Text UND die neue Stelle der
 * Schreibmarke zurueck -- beides gehoert zusammen, und wer nur den Text
 * zurueckgibt, laesst die Marke am Ende stehen, auch wenn mitten im Satz
 * ersetzt wurde.
 *
 * Hinter einem Befehl steht ein Leerzeichen, hinter einem Ordner ein
 * Schraegstrich (dann geht die Liste gleich eine Ebene tiefer weiter), hinter
 * einer Datei ein Leerzeichen -- ausser es steht dort schon eins. Mitten in
 * einem Satz zu vervollstaendigen ergaebe sonst zwei Leerzeichen, und das
 * sieht man dem Text nicht an, bis er abgeschickt ist.
 */
export function einsetzen(
  text: string,
  a: Ausloeser,
  wahl: string,
  ordner = false,
): { text: string; marke: number } {
  const kopf = a.art === 'befehl' ? '/' : '@';
  const rest = text.slice(a.bis);
  const schwanz = ordner ? '/' : (/^\s/.test(rest) ? '' : ' ');
  const neu = `${kopf}${wahl}${schwanz}`;
  return {
    text: text.slice(0, a.von) + neu + rest,
    // Die Marke steht direkt hinter dem Eingesetzten -- also vor dem
    // Leerzeichen, das schon dastand, wenn keins dazukam.
    marke: a.von + neu.length,
  };
}

/**
 * DIE BEFEHLSLISTE FILTERN. Dieselbe Stufung wie bei den Dateien
 * (main/chatdateien.ts): was so ANFAENGT, steht vor dem, was es nur enthaelt.
 * Ohne diese Stufung stuende bei `co` das `autocompact` vor dem `compact`.
 */
export function filtereBefehle<T extends { name: string }>(
  liste: T[],
  muster: string,
  hoechstens = 12,
): T[] {
  const m = muster.trim().toLowerCase();
  if (!m) return liste.slice(0, hoechstens);
  const treffer: { e: T; rang: number }[] = [];
  for (const e of liste) {
    const n = e.name.toLowerCase();
    let rang = -1;
    if (n.startsWith(m)) rang = 0;
    else if (n.includes(m)) rang = 1;
    if (rang < 0) continue;
    treffer.push({ e, rang });
  }
  // Innerhalb einer Stufe ALPHABETISCH, nicht nach Laenge. Nach Laenge stuende
  // bei `co` das `config` vor dem `compact`, und welcher von beiden kuerzer
  // ist, kann niemand vorhersagen -- eine Liste, deren Reihenfolge man nicht
  // vorhersagt, muss man jedes Mal ganz lesen.
  treffer.sort((a, b) => {
    if (a.rang !== b.rang) return a.rang - b.rang;
    return a.e.name.localeCompare(b.e.name);
  });
  return treffer.slice(0, hoechstens).map((t) => t.e);
}

/**
 * DIE DATEILISTE FILTERN, waehrend getippt wird.
 *
 * Sie steht HIER und nicht bei der Beschaffung (main/chatdateien.ts), weil sie
 * im FENSTER laeuft: die ganze Liste wird einmal geholt, jeder Tastendruck
 * filtert sie oertlich. Sie ueber IPC zu filtern hiesse, bei jedem Zeichen
 * einige tausend Pfade durch den Kanal zu schicken -- derselbe Fehler wie der
 * volle Gespraechsstand je Token (Befund B1).
 *
 * Bewertet wird in drei Stufen, weil eine reine Teilzeichenkette bei tausend
 * Dateien den falschen Treffer nach oben spuelt: wer `read` tippt, meint eher
 * `README.md` als `app/src/thread/reader.ts`.
 *
 *   0  der DATEINAME beginnt so
 *   1  der ganze Pfad beginnt so
 *   2  es kommt irgendwo vor
 *
 * Gross- und Kleinschreibung zaehlen nicht: niemand tippt einen Pfad mit der
 * Umschalttaste, nur um seine Datei zu finden.
 */
export function filtereDateien<T extends { pfad: string }>(
  liste: T[],
  muster: string,
  hoechstens = 12,
): T[] {
  const m = muster.trim().toLowerCase();
  if (!m) return liste.slice(0, hoechstens);
  const treffer: { v: T; rang: number }[] = [];
  for (const v of liste) {
    const pfad = v.pfad.toLowerCase();
    const name = pfad.split('/').pop() ?? pfad;
    let rang = -1;
    if (name.startsWith(m)) rang = 0;
    else if (pfad.startsWith(m)) rang = 1;
    else if (pfad.includes(m)) rang = 2;
    if (rang < 0) continue;
    treffer.push({ v, rang });
  }
  treffer.sort((a, b) => {
    if (a.rang !== b.rang) return a.rang - b.rang;
    if (a.v.pfad.length !== b.v.pfad.length) return a.v.pfad.length - b.v.pfad.length;
    return a.v.pfad.localeCompare(b.v.pfad);
  });
  return treffer.slice(0, hoechstens).map((t) => t.v);
}

/** Ein Eintrag, wie die Liste ihn zeigt. */
export interface Vorschlag {
  /** Was eingesetzt wird. */
  wert: string;
  /** Die zweite Zeile, gedimmt. Leer, wenn es keine gibt. */
  satz: string;
  /** Ordner bekommen einen Schraegstrich statt eines Leerzeichens dahinter. */
  ordner: boolean;
}

/**
 * DIE LISTE ALS DOM. Sie haengt UEBER dem Eingabefeld, weil unter ihm der Rand
 * des Fensters kommt -- und sie liegt im selben Kasten, damit sie mit ihm
 * mitwandert, wenn das Feld waechst.
 *
 * Die Tastatur bedient sie, nicht die Maus: Pfeiltasten waehlen, Eingabe und
 * Tabulator setzen ein, Escape schliesst. Der Klick geht trotzdem, weil eine
 * Liste, die man sieht und nicht anklicken kann, ein Fehler ist.
 */
export class Vervollstaendigung {
  private readonly wurzel: HTMLDivElement;

  private eintraege: Vorschlag[] = [];

  private wahl = 0;

  private offenArt: Vervollart | null = null;

  constructor(private readonly aufWahl: (v: Vorschlag) => void) {
    this.wurzel = document.createElement('div');
    this.wurzel.className = 'csdk-vervoll';
    this.wurzel.hidden = true;
  }

  element(): HTMLDivElement {
    return this.wurzel;
  }

  istOffen(): boolean {
    return !this.wurzel.hidden;
  }

  art(): Vervollart | null {
    return this.offenArt;
  }

  zu(): void {
    this.wurzel.hidden = true;
    this.wurzel.replaceChildren();
    this.eintraege = [];
    this.offenArt = null;
  }

  /**
   * Die Liste setzen. Eine LEERE Liste schliesst sie: ein aufgeklappter Kasten
   * mit nichts darin sagt „nichts gefunden" und nimmt dabei die Sicht auf den
   * Verlauf -- die Auskunft ist die Abwesenheit der Liste selbst.
   */
  zeige(art: Vervollart, eintraege: Vorschlag[], kopfzeile: string): void {
    if (!eintraege.length) {
      this.zu();
      return;
    }
    this.eintraege = eintraege;
    this.offenArt = art;
    this.wahl = 0;
    this.wurzel.hidden = false;
    this.zeichne(kopfzeile);
  }

  private zeichne(kopfzeile: string): void {
    this.wurzel.replaceChildren();
    if (kopfzeile) {
      const k = document.createElement('div');
      k.className = 'csdk-vervoll-kopf';
      k.textContent = kopfzeile;
      this.wurzel.appendChild(k);
    }
    this.eintraege.forEach((e, i) => {
      const z = document.createElement('div');
      z.className = `csdk-vervoll-zeile${i === this.wahl ? ' gewaehlt' : ''}`;
      const w = document.createElement('span');
      w.className = 'csdk-vervoll-wert';
      w.textContent = e.ordner ? `${e.wert}/` : e.wert;
      z.appendChild(w);
      if (e.satz) {
        const s = document.createElement('span');
        s.className = 'csdk-vervoll-satz';
        s.textContent = e.satz;
        z.appendChild(s);
      }
      // `mousedown` statt `click`: ein `click` kaeme erst, nachdem das Feld
      // seinen Fokus verloren hat -- und der Fokusverlust schliesst die Liste.
      z.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        this.aufWahl(e);
      });
      this.wurzel.appendChild(z);
    });
  }

  /**
   * Eine Taste anbieten. Gibt zurueck, ob die Liste sie VERBRAUCHT hat -- nur
   * dann darf der Aufrufer sie nicht mehr an das Feld weiterreichen.
   */
  taste(key: string, umschalt = false): boolean {
    if (this.wurzel.hidden) return false;
    // UMSCHALT+EINGABE GEHOERT DEM FELD (Reviewbefund 9, 12.08.). Hier wurde
    // nur der Tastenname geprueft, und die Liste lief VOR der Umschalt-Pruefung
    // der Ansicht -- wer bei offener Liste eine neue Zeile beginnen wollte,
    // setzte stattdessen den gewaehlten Eintrag ein.
    if (key === 'Enter' && umschalt) return false;
    if (key === 'Escape') {
      this.zu();
      return true;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      const schritt = key === 'ArrowDown' ? 1 : -1;
      this.wahl = (this.wahl + schritt + this.eintraege.length) % this.eintraege.length;
      const kopf = this.wurzel.querySelector('.csdk-vervoll-kopf')?.textContent ?? '';
      this.zeichne(kopf);
      return true;
    }
    if (key === 'Enter' || key === 'Tab') {
      const e = this.eintraege[this.wahl];
      if (e) this.aufWahl(e);
      return true;
    }
    return false;
  }
}
