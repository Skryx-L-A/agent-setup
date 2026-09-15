// DIE ASCII-UMSCHRIFT ZURUECKHOLEN -- eine Stelle fuer beide Fenster.
//
// Zwei Quellen ausserhalb der Oberflaeche schreiben deutschen Text in ASCII:
// `shell/wb-budget` in seinen Begruendungen ("zaehlen", "Luecken", "ueber") und
// `shell/models.default.json` in den Feldern, die das Einstellungsfenster
// anzeigt ("laege", "Guete", "Koerper"). Beide bleiben so, wie sie sind: das
// eine ist ein Shell-Werkzeug, dessen Ausgabe auch im Terminal steht, das
// andere die Registry, die alle wb-Werkzeuge lesen. Gewandelt wird beim
// ANZEIGEN, und zwar in beiden Fenstern mit demselben Woerterbuch -- zwei
// Kopien waeren zwei Staende, von denen einer irgendwann der falsche ist.
//
// EIN WOERTERBUCH, KEINE REGEL. Eine Regel ("ue" wird "ü") zerstoerte jedes
// zweite deutsche Wort: "neue", "Quelle", "Dauer", "Ereignisse". Hier stehen
// deshalb genau die Woerter, die die beiden Quellen wirklich fuehren; was nicht
// darin steht, bleibt unveraendert stehen, statt geraten zu werden.
//
// UND DESHALB STEHT HIER KEIN WORTSTAMM, DER AUCH IN EINER KENNUNG VORKOMMT.
// Die Registry nennt ihren Pruefstand "pruef3"; stuende "pruef" im Woerterbuch,
// machte die Wandlung daraus "prüf3" und damit eine Kennung kaputt, die es so
// nicht gibt. Aufgenommen wird nur, was als ganzes Wort im Fliesstext steht.
const UMSCHRIFT: Record<string, string> = {
  // Aus `wb-budget` (Stand 03.09.2026).
  Abstaende: 'Abstände', Abstaenden: 'Abständen', Aufloesung: 'Auflösung',
  DARUEBER: 'DARÜBER', Datensaetze: 'Datensätze', Faehigkeit: 'Fähigkeit',
  Fuehrt: 'Führt', Luecken: 'Lücken', Naeherung: 'Näherung',
  Punktemassstab: 'Punktemaßstab', Stueck: 'Stück', aehnlicher: 'ähnlicher',
  annaehernd: 'annähernd', aussen: 'außen', ausserhalb: 'außerhalb',
  beruecksichtigt: 'berücksichtigt', bestaetigt: 'bestätigt', binaer: 'binär',
  braeuchte: 'bräuchte', einschliessen: 'einschließen', frueh: 'früh',
  Erschoepft: 'Erschöpft', erschoepft: 'erschöpft', Rueckfall: 'Rückfall',
  fuer: 'für', gehoeren: 'gehören', geoeffnet: 'geöffnet', gueltig: 'gültig',
  heisst: 'heißt', koennen: 'können', loesbar: 'lösbar', mitgezaehlt: 'mitgezählt',
  moeglich: 'möglich', oeffnen: 'öffnen', pruefbar: 'prüfbar',
  geprueft: 'geprüft', singulaer: 'singulär', spaet: 'spät', traegt: 'trägt',
  ueber: 'über', uebersprungen: 'übersprungen', unabhaengig: 'unabhängig',
  ungeklaert: 'ungeklärt', ungeprueft: 'ungeprüft', verfuegbar: 'verfügbar',
  waehrend: 'während', widerspruechlich: 'widersprüchlich', wuerde: 'würde',
  zaehlt: 'zählt', zaehlen: 'zählen',
  // Aus `shell/models.default.json`, aus den Feldern, die das
  // Einstellungsfenster wirklich zeigt: der Name eines Programms, der Grund
  // gegen eine Chat-Ansicht, was eine Ansicht nicht zeigt, und die Herkunft
  // eines Vorhersage-Weges samt seiner Beschriftung (Stand 03.09.2026).
  FUER: 'FÜR', Buendelung: 'Bündelung', Endgueltiger: 'Endgültiger',
  GUETE: 'GÜTE', Guete: 'Güte', Guetefassung: 'Gütefassung',
  KOERPER: 'KÖRPER', Koerper: 'Körper', Koerpern: 'Körpern',
  Laenge: 'Länge', Massgeblich: 'Maßgeblich', Modellkoerper: 'Modellkörper',
  Moeglichkeit: 'Möglichkeit', NEBENLAEUFIGKEIT: 'NEBENLÄUFIGKEIT',
  Pruefung: 'Prüfung', Schlaegt: 'Schlägt', Stroeme: 'Ströme',
  ausdruecklich: 'ausdrücklich', dafuer: 'dafür', darueber: 'darüber',
  eigenstaendigen: 'eigenständigen', erfuellten: 'erfüllten', faellt: 'fällt',
  gebuendelte: 'gebündelte', gegenueber: 'gegenüber',
  gewoehnlichen: 'gewöhnlichen', haelt: 'hält', haengt: 'hängt',
  hoehere: 'höhere', laedt: 'lädt', laege: 'läge', laeuft: 'läuft',
  liesse: 'ließe', ungepruefte: 'ungeprüfte', waehlbare: 'wählbare',
  waehlt: 'wählt', waere: 'wäre',
};

/**
 * Die ASCII-Umschrift in echte Umlaute zurueckwandeln, Wort fuer Wort.
 *
 * Pfade, Feldnamen und Kennungen bleiben unberuehrt: gewandelt wird nur, was
 * als GANZES Wort im Woerterbuch steht, und dort steht nichts, was auch als
 * Teil einer Kennung vorkommt. `~/.gemini/antigravity-cli/...` und `pruef3`
 * kommen deshalb Zeichen fuer Zeichen wieder heraus.
 */
export function umlaute(text: string): string {
  if (!text) return text;
  return text.replace(/[A-Za-z]+/g, (w) => UMSCHRIFT[w] ?? w);
}
