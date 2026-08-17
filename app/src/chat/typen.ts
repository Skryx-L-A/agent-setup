// DIE BEGRIFFE DER CHAT-ANSICHT (SPEC-V4 Abschnitt 6, gebaut 2026-08-11).
//
// EINE Quelle beschreibt, wie eine laufende Sitzung ihr Gespraech hergibt: der
// `session`-Block des Harness-Eintrags in der Registry. Es gibt keinen zweiten
// Block und kein zweites Schema -- die Entscheidung vom 11.08. steht in
// SPEC-V4 6.3 ("Der Bau nimmt deshalb gleich einen gemeinsamen session-Block,
// aus dem Kontextwache und Chat-Ansicht lesen"), und `contextSession` ist genau
// daran am 11.08. aufgegangen. Diese Datei bildet den Block ab, sie erweitert
// ihn nicht.
//
// WAS HIER BEWUSST FEHLT: eine Fassung des Blocks, die aus zwei Feldern dieselbe
// Datei beschreibt, und jede Angabe, die die Registry nicht traegt. Was das
// Programm ueber einen Harness wissen will, steht in der Registry oder es steht
// nicht zur Verfuegung.

/**
 * Die vier Anschlussarten (SPEC-V4 6.3). Leer heisst: dieser Harness gibt sein
 * Gespraech nicht her, und `grund` sagt im Klartext, warum.
 */
export type Via = 'http-sse' | 'sessionFile' | 'acp' | '';

/** Wie sich eine laufende Sitzung ihrem Protokoll zuordnen laesst. */
export type Zuordnung = 'cwd' | 'pid' | 'hook' | 'serverId' | '';

/**
 * WORAUF eine getroffene Zuordnung beruht (zuordnung.ts). Nicht dasselbe wie
 * `Zuordnung`: die steht in der Registry und sagt, was VORGESEHEN ist; diese
 * hier sagt, welcher Weg tatsaechlich getragen hat -- der vorgesehene oder
 * einer der beiden Rueckfaelle. Leer = es gibt keine Zuordnung.
 */
export type Herkunft = 'hook' | 'vermerk' | 'pid' | 'ordner' | '';

/**
 * Was die Ansicht aus dem Protokoll NICHT bekommt und deshalb aus der
 * Bildschirmauswertung hineingereicht bekommen muss (SPEC-V4 6.2). Das
 * Vokabular ist geschlossen; `shell/tests/test-context-guard-sessionblock.sh`
 * prueft die Registry gegen genau diese drei Woerter.
 */
export type ZeigtNicht = 'freigabedialog' | 'kontextauslastung' | 'arbeits-anzeige';

export interface Probe {
  datum: string;
  beleg: string;
}

/** Die Auflage fuer einen lokalen Server (SPEC-V4 6.3 Punkt 5). */
export interface ServerAuflage {
  bind: string;
  token: string;
  auflage: string;
}

/** Der `session`-Block eines Harness-Eintrags, so wie er in der Registry steht. */
export interface SessionBlock {
  via: Via;
  /** Klartext, warum es nicht geht -- nur gesetzt, wenn `via` leer ist. */
  grund: string;
  /** Pfad, Glob oder Adresse. Leer, wenn es keine Quelle gibt. */
  ort: string;
  /** Der Name des Lesers. Ein Name ohne Leser liefert nichts (siehe leser.ts). */
  format: string;
  /** Hoechstalter der Datei in Sekunden; 0 = die Vorgabe des Lesers gilt. */
  maxAgeSec: number;
  zuordnung: Zuordnung;
  live: boolean;
  /** Immer 'pane' (SPEC-V4 6.2: die Eingabe bleibt am Pane, zwingend). */
  eingabe: string;
  zeigtNicht: ZeigtNicht[];
  server: ServerAuflage | null;
  probe: Probe | null;
}

/** Wer gesprochen hat. Vier Rollen, mehr braucht die Anzeige nicht. */
export type Rolle = 'mensch' | 'agent' | 'system' | 'werkzeug';

/**
 * Eine Zeile des Gespraechs. `zeit` ist 0, wenn das Protokoll keine traegt --
 * geraten wird sie nicht, eine erfundene Uhrzeit sieht aus wie eine gemessene.
 */
export interface ChatNachricht {
  rolle: Rolle;
  text: string;
  /** Millisekunden seit 1970, 0 = das Protokoll nennt keine. */
  zeit: number;
  /** 'text' | 'denken' | 'werkzeug' -- fuer die Darstellung, nicht fuer den Inhalt. */
  art: 'text' | 'denken' | 'werkzeug';
}

/**
 * Was NICHT aus dem Protokoll kommt (SPEC-V4 6.2). Ohne diese drei ist die
 * Ansicht huebscher und schlechter, deshalb steht die Bruecke im Datentyp und
 * nicht in einer Fussnote: eine Chat-Ansicht ohne sie laesst den Menschen vor
 * einer Frage sitzen, die er nicht sieht.
 */
export interface Bruecke {
  /** Ein Freigabedialog steht offen. Erkannt am Bildschirm, nie im Protokoll. */
  freigabeOffen: boolean;
  /** Der Satz dazu, soweit bekannt -- leer, wenn nur das Ob bekannt ist. */
  freigabeText: string;
  /** Kontextauslastung in Prozent, -1 = unbekannt. Nie geschaetzt. */
  auslastung: number;
  /** Belegte Tokens, 0 = unbekannt. */
  tokens: number;
  /** Groesse des Kontextfensters, 0 = unbekannt. */
  fenster: number;
  /** Arbeitet das Programm gerade? Spinner und Fortschritt sind reine Oberflaeche. */
  arbeitet: boolean;
}

export const LEERE_BRUECKE: Bruecke = {
  freigabeOffen: false,
  freigabeText: '',
  auslastung: -1,
  tokens: 0,
  fenster: 0,
  arbeitet: false,
};

/**
 * Der Stand einer Pane-Ansicht: entweder ein Gespraech oder ein Grund im
 * Klartext, warum keins da ist. Beides zusammen gibt es nicht -- was ein Harness
 * nicht kann, wird nicht ausgegraut, sondern begruendet (SPEC-V4 6.3 Punkt 6).
 */
export interface ChatStand {
  paneId: string;
  harness: string;
  via: Via;
  /** Kann diese Sitzung ein Gespraech zeigen? */
  moeglich: boolean;
  /** Warum nicht, im Klartext. Leer, solange `moeglich` gilt. */
  grund: string;
  /** Woher gelesen wurde (Pfad oder Adresse) -- fuer die Fusszeile der Ansicht. */
  quelle: string;
  /**
   * WORAUF die Zuordnung beruht (zuordnung.ts, 12.08.) -- leer, wenn keine
   * getroffen wurde. Die Ansicht zeigt es an, weil die Wege nicht gleich gut
   * sind: der Haken nennt die Sitzung, Ordner und Zeit raten sie gut. Ein
   * Gespraech ohne diese Angabe sieht in beiden Faellen gleich sicher aus.
   */
  herkunft: Herkunft;
  nachrichten: ChatNachricht[];
  bruecke: Bruecke;
  /**
   * Soll dieser Pane das Gespraech zeigen? Das fertige Ergebnis der
   * Aufloesungsregel (ansichtsregel.ts) aus Sitzungs-Uebersteuerung,
   * Rollenvorgabe (`chatAnsichtVorgabe`, Seite Aussehen) und dem, was der
   * Harness erlaubt und kann.
   *
   * Es steht hier, weil nur der Hauptprozess Einstellungen und ui.json liest --
   * der Renderer wuerde beides sonst ein zweites Mal fuehren.
   */
  vorgabe: boolean;
  /** Wann dieser Stand entstand, in Millisekunden. */
  stand: number;
  /**
   * Die Sprache der Oberflaeche -- dieselbe Ableitung wie im Einstellungsfenster
   * (`sprache()`, app/src/main/einstellungen.ts). Optional und von aussen angeheftet
   * (main.ts, IPC `awb:chat-stand`): `chatquelle.ts` selbst kennt sie nicht, jede ihrer
   * eigenen `ChatStand`-Konstruktionen bleibt deshalb unveraendert.
   */
  sprache?: string;
}

/** Ein Fund im Dateisystem, bevor entschieden ist, welcher zum Pane gehoert. */
export interface Kandidat {
  pfad: string;
  /** Aenderungszeit in Millisekunden. */
  mtimeMs: number;
  /** Das Arbeitsverzeichnis, das die Datei selbst nennt -- leer, wenn keins. */
  cwd: string;
  /** Die Prozesskennung, die die Datei selbst nennt -- 0, wenn keine. */
  pid: number;
}
