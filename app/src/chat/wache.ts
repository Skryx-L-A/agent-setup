// DIE KONTEXTWACHE EINER CHAT-SITZUNG -- die Entscheidung, und nur sie.
//
// WARUM ES DIESE DATEI GIBT (der bewusst offene Punkt vom 12.08.). Die
// Kontextwache dieses Hauses ist `shell/context-guard`: sie liest die
// Statuszeile eines tmux-Panes und tippt mit `send-keys` hinein. Eine
// Chat-Sitzung hat weder das eine noch das andere -- sie ist ein eigener
// `claude`-Prozess im Hauptprozess der App, der ueber stream-json spricht
// (chatsitzung.ts). Der Guard kann sie nicht sehen und nicht erreichen. Die
// Wache fuer Chat-Sitzungen laeuft deshalb IM Programm, an derselben Stelle,
// an der die Sitzung ohnehin lebt.
//
// DIE DREI PRINZIPIEN AUS `~/.claude/regeln/kontext-guard.md` gelten
// unveraendert, sie werden hier nur mit anderen Mitteln durchgesetzt:
//
//   1. NIEMAND KOMPAKTIERT SICH SELBST. Die Wache ist ein anderer Akteur als
//      die Sitzung: sie schickt `/compact` von aussen in den Strom, so wie der
//      Guard es in den Pane tippt.
//   2. KOMPAKTIERT WIRD NUR MIT GESICHERTER UEBERGABE. Erst wenn die
//      Uebergabedatei nachweislich auf der Platte liegt -- gelesen, nicht
//      geglaubt --, geht `/compact` hinaus. Die einzige Ausnahme ist die
//      Notbremse, und die sagt in ihrem Protokoll und im Gespraech, dass sie
//      ohne Uebergabe kompaktiert hat.
//   3. NACH DER KOMPAKTIERUNG ZWINGEND EIN RESUME-PROMPT. Beide Haelften
//      gehoeren zusammen; ohne den zweiten Schritt sitzt eine frisch
//      komprimierte Sitzung ohne Auftrag da und scheitert lautlos.
//
// UND EIN VIERTES, aus derselben Regel: die Schwelle kommt aus
// `wb-state settings kontextwache.mahnenAb` und NIE aus einer Zahl im
// Quelltext. Diese Datei traegt deshalb keine einzige Prozentzahl -- die
// Schwellen kommen als `Wacheregel` herein.
//
// REIN: kein Zugriff auf Dateien, Prozesse oder Uhren. Lage hinein,
// Entscheidung heraus. So laesst sich die ganze Kette gegen eine gestellte
// Uhr durchspielen, ohne Electron, ohne tmux und ohne einen bezahlten Zug.

/**
 * NOCH NICHTS GEMESSEN -- und das ist NICHT „kein Nenner" (Befund 1 des
 * Reviews vom 15.08.). Eine gerade geoeffnete Sitzung hat keinen Zug gefahren,
 * also meldet der Strom keine Belegung; `auslastung(0, 200000)` ergibt -1, und
 * -1 hiess bis dahin „diese Sitzung wird NICHT bewacht". Jede frische
 * Chat-Sitzung bekam damit innerhalb von Sekunden eine Meldung ueber ein
 * angeblich fehlendes Fenster in der Registry -- gemessen.
 *
 * Zwei Lagen ergeben dieselbe fehlende Prozentzahl und verlangen verschiedene
 * Antworten: „Modell ohne Fenster in der Registry" ist der Befund, den die
 * Meldung meint, „noch nichts gemessen" ist harmlos und schweigt. Der Treiber
 * unterscheidet sie am Nenner (chatwache.ts, `eineSitzung`).
 */
export const UNGEMESSEN = -2;

/** Die Schwellen einer Rolle, so wie `wb-state wache get --json` sie meldet. */
export interface Wacheregel {
  /** Wird diese Rolle ueberhaupt bewacht? */
  an: boolean;
  /** Ab dieser Auslastung in Prozent wird die Uebergabe erbeten. */
  mahnenAb: number;
  /** Aus heisst: die Wache meldet, sie kompaktiert aber nicht. */
  eingreifen: boolean;
  /** Ab dieser Auslastung kompaktiert die Wache OHNE Uebergabe (Notbremse). */
  notbremseAb: number;
}

/**
 * WAS DIE WACHE ZU EINEM ZEITPUNKT SIEHT. Alles gemessen, nichts gemerkt --
 * `auslastung` kommt aus dem Strom der Sitzung, `uebergabeDa` aus einem Blick
 * auf die Platte, `kompaktierungen` aus den `compact_boundary`-Ereignissen.
 */
export interface Wachelage {
  /**
   * Die Kontextauslastung in Prozent, -1 fuer UNBEKANNT (kein Nenner) oder
   * `UNGEMESSEN` fuer "diese Sitzung hat noch keinen Zug gefahren". Unbekannt
   * ist NICHT "alles gut" (die Lehre des blinden Guards vom 25.07.): eine
   * Sitzung ohne Nenner wird nicht bewacht, und die Wache sagt genau das.
   * Ungemessen dagegen ist harmlos und schweigt -- siehe `UNGEMESSEN`.
   */
  auslastung: number;
  /** Arbeitet die Sitzung gerade an einer Antwort? Dann wird nichts geschickt. */
  arbeitet: boolean;
  /** Wartet eine Freigabe auf den Menschen? Dann ebenfalls nicht. */
  wartetAufFreigabe: boolean;
  /** Laeuft der Prozess ueberhaupt noch? Eine tote Sitzung wird nicht bewacht. */
  laeuft: boolean;
  /** Liegt die Uebergabedatei -- NEUER als die Bitte -- auf der Platte? */
  uebergabeDa: boolean;
  /** Wieviele Kompaktierungen der Strom bisher gemeldet hat. */
  kompaktierungen: number;
  /** Die Uhr, von aussen. */
  jetzt: number;
}

/** Die Fristen. Sie stehen hier, weil sie zur Entscheidung gehoeren. */
export interface Wachefristen {
  /**
   * Wie lange auf die Uebergabedatei gewartet wird, bevor die Wache es sagt.
   * Gewartet wird danach WEITER -- abgebrochen wird nie, es wird nur nicht
   * mehr geschwiegen.
   */
  uebergabeMs: number;
  /**
   * Wie lange auf die Bestaetigung der Kompaktierung gewartet wird. Kommt sie
   * nicht, gibt die Wache fuer diese Sitzung auf und sagt es -- ein
   * Resume-Prompt auf eine Kompaktierung, die nie stattfand, waere eine
   * Falschmeldung.
   */
  kompaktMs: number;
}

/**
 * DIE FRISTEN, hergeleitet und nicht geraten.
 *
 * `uebergabeMs` = 10 Minuten: die Sitzung muss einen ganzen Zug fahren, um die
 * Uebergabe zu schreiben, und im Freigabemodus `default` fragt sie dafuer
 * zuerst um Erlaubnis -- dann haengt es an einem Menschen. Zehn Minuten sind
 * lang genug, dass ein normaler Schreibzug samt Rueckfrage hineinpasst, und
 * kurz genug, dass ein Ausbleiben noch vor der Notbremse auffaellt.
 *
 * `kompaktMs` = 5 Minuten: die gemessene Kompaktierung vom 15.08. brauchte
 * 13,0 Sekunden (`compact_metadata.duration_ms` = 13034 bei 60.202 Tokens).
 * Fuenf Minuten sind das Zwanzigfache -- Raum fuer ein volles Fenster und
 * einen langsamen Tag, ohne dass ein echter Haenger unbemerkt bliebe.
 */
export const FRISTEN: Wachefristen = { uebergabeMs: 10 * 60 * 1000, kompaktMs: 5 * 60 * 1000 };

/**
 * WO DIE WACHE STEHT. Der Ablauf ist eine Kette, keine Sammlung von Schaltern:
 * jede Stufe hat genau einen Weg vorwaerts und ihre eigene Frist.
 *
 *   ruhig        unterhalb der Mahnschwelle -- nichts zu tun
 *   gebeten      die Uebergabe ist erbeten, die Datei fehlt noch
 *   kompaktiert  `/compact` ist hinaus, die Bestaetigung fehlt noch
 *   fortgesetzt  der Resume-Prompt ist hinaus; faellt die Auslastung, wird
 *                wieder scharf gestellt
 *   blind        kein Nenner -- diese Sitzung wird NICHT bewacht, und das ist
 *                gesagt worden
 *   gescheitert  die Kompaktierung kam nicht an; die Wache haelt still und hat
 *                es gesagt. Sie stellt sich erst wieder scharf, wenn die
 *                Auslastung faellt (also ein Mensch von Hand kompaktiert hat).
 */
export type Wachestufe = 'ruhig' | 'gebeten' | 'kompaktiert' | 'fortgesetzt' | 'blind' | 'gescheitert';

/** Was die Wache jetzt TUT. Der Treiber setzt es um, er entscheidet es nicht. */
export type Wachetat =
  | 'nichts'
  /** Die Uebergabe erbitten (eine Nachricht in die Sitzung). */
  | 'bitten'
  /** Nur melden, nicht eingreifen -- `eingreifen` steht aus. */
  | 'melden'
  /** `/compact` schicken. */
  | 'kompaktieren'
  /** Den Resume-Prompt schicken. */
  | 'fortsetzen'
  /** Sagen, dass diese Sitzung ohne Nenner nicht bewacht wird. */
  | 'blind-melden'
  /** Sagen, dass die Uebergabe aussteht. */
  | 'uebergabe-mahnen'
  /** Sagen, dass die Kompaktierung nicht ankam. */
  | 'aufgeben';

export interface Wachestand {
  stufe: Wachestufe;
  /** Seit wann diese Stufe gilt -- die Grundlage jeder Frist. */
  seit: number;
  /** Der Stand der Kompaktierungszaehlung, als `/compact` hinausging. */
  kompaktVorher: number;
  /** Wurde in dieser Stufe schon einmal gemahnt? Jede Mahnung genau einmal. */
  gemahnt: boolean;
  /** Hat die Wache OHNE Uebergabe kompaktiert? Der Resume-Prompt sagt es dann. */
  ohneUebergabe: boolean;
  /** Ist die Fehlkonfiguration der Notbremse schon gesagt worden? Einmal reicht. */
  fehlkonfigGemeldet: boolean;
}

export function neuerWachestand(jetzt = 0): Wachestand {
  return {
    stufe: 'ruhig', seit: jetzt, kompaktVorher: 0,
    gemahnt: false, ohneUebergabe: false, fehlkonfigGemeldet: false,
  };
}

export interface Wacheschritt {
  tat: Wachetat;
  /** Der Stand NACH diesem Schritt. Der Aufrufer uebernimmt ihn. */
  stand: Wachestand;
  /** Warum -- im Klartext, fuer das Protokoll und fuer das Gespraech. */
  grund: string;
}

function weiter(stand: Wachestand, stufe: Wachestufe, jetzt: number, aenderung: Partial<Wachestand> = {}): Wachestand {
  return { ...stand, gemahnt: false, ...aenderung, stufe, seit: jetzt };
}

/**
 * DER EINE SCHRITT. Aufgerufen im Takt der Oberflaeche; er entscheidet
 * hoechstens eine Tat je Aufruf, damit jede Tat ihr eigenes Protokoll bekommt
 * und keine zwei Nachrichten im selben Augenblick in dieselbe Sitzung fallen.
 *
 * RUHIG BLEIBT SIE, SOLANGE DIE SITZUNG ARBEITET. Der Guard hat dieselbe
 * Auflage („never types into a pane that is mid-turn"), und hier gilt sie aus
 * demselben Grund: eine Nachricht mitten im Zug reiht sich in die Warteschlange
 * ein, und ein wartendes `/compact` liefe als gewoehnliche Chatnachricht --
 * genau der Fehler, an dem der tmux-Guard am 25.07. schon einmal haengen blieb.
 */
export function wacheschritt(
  standRein: Wachestand,
  lage: Wachelage,
  regel: Wacheregel,
  fristen: Wachefristen = FRISTEN,
): Wacheschritt {
  // NUR-MELDEN GILT AB DIESEM TAKT, nicht erst beim naechsten Durchgang
  // (Befund 3 des Reviews vom 15.08.). Der Schalter wurde bis dahin nur in der
  // Stufe `ruhig` gelesen: wer ihn umlegte, waehrend die Wache schon auf die
  // Uebergabe wartete, bekam trotzdem ein `/compact`. Die Regel wird alle
  // dreissig Sekunden neu geholt -- der neue Wert kam also an und wurde
  // ignoriert. Eine wartende Wache faellt deshalb auf `ruhig` zurueck: die
  // Bitte ist hinaus und darf stehenbleiben, kompaktiert wird nicht mehr.
  const stand = !regel.eingreifen && standRein.stufe === 'gebeten'
    ? weiter(standRein, 'ruhig', lage.jetzt)
    : standRein;
  const nichts = (grund = ''): Wacheschritt => ({ tat: 'nichts', stand, grund });

  // Eine tote Sitzung hat keinen Kontext, den man entlasten koennte.
  if (!lage.laeuft) return nichts();
  // Eine abgeschaltete Wache tut nichts -- und der Treiber hat das beim Start
  // EINMAL gesagt (dieselbe Haltung wie im Guard: eine Wache, die schweigend
  // nichts tut, ist von einer kaputten nicht zu unterscheiden).
  if (!regel.an) return nichts();

  // EINE NOTBREMSE UNTER DER MAHNSCHWELLE IST KEINE NOTBREMSE (Befund 4).
  // `wb-state wache set --mahnen-ab 90` wird angenommen, waehrend die Notbremse
  // bei 80 steht: die Wache bittet dann bei 90 Prozent um die Uebergabe und
  // kompaktiert im naechsten stillen Takt sofort ohne sie, weil 90 auch groesser
  // als 80 ist. Das Prinzip „kompaktiert wird nur mit gesicherter Uebergabe"
  // fiele damit still weg. Die Wache hebt die Schwelle NICHT heimlich an -- das
  // waere eine zweite Wahrheit ueber eine Zahl, die alice gesetzt hat --,
  // sondern sagt es einmal und laesst die Notbremse ausser Kraft.
  if (regel.notbremseAb <= regel.mahnenAb && !stand.fehlkonfigGemeldet) {
    return {
      tat: 'melden',
      stand: { ...stand, fehlkonfigGemeldet: true },
      grund: `Fehlkonfiguration: die Notbremse (${regel.notbremseAb} Prozent) liegt nicht ueber der `
        + `Mahnschwelle (${regel.mahnenAb} Prozent) und bleibt deshalb ausser Kraft. `
        + 'Kompaktiert wird nur mit gesicherter Uebergabe.',
    };
  }

  // NOCH NICHTS GEMESSEN heisst NICHTS TUN -- und nichts sagen (Befund 1).
  if (lage.auslastung === UNGEMESSEN) return nichts();

  // OHNE NENNER WIRD NICHT GERATEN, und Unbekannt ist nicht „alles gut".
  if (lage.auslastung < 0) {
    if (stand.stufe === 'blind') return nichts();
    return {
      tat: 'blind-melden',
      stand: weiter(stand, 'blind', lage.jetzt),
      grund: 'Kontextfenster unbekannt -- diese Sitzung wird nicht bewacht.',
    };
  }
  // Ein Nenner, der spaeter doch auftaucht (die Registry wurde ergaenzt, das
  // Modell wechselte), stellt die Wache wieder scharf.
  if (stand.stufe === 'blind') {
    return { tat: 'nichts', stand: weiter(stand, 'ruhig', lage.jetzt), grund: '' };
  }

  // Die Kompaktierung ist die einzige Stufe, die eine BESTAETIGUNG braucht.
  if (stand.stufe === 'kompaktiert') {
    if (lage.kompaktierungen > stand.kompaktVorher) {
      return {
        tat: 'fortsetzen',
        stand: weiter(stand, 'fortgesetzt', lage.jetzt, { ohneUebergabe: stand.ohneUebergabe }),
        grund: 'Die Kompaktierung ist bestaetigt.',
      };
    }
    if (lage.jetzt - stand.seit >= fristen.kompaktMs) {
      return {
        tat: 'aufgeben',
        stand: weiter(stand, 'gescheitert', lage.jetzt),
        grund: 'Die Kompaktierung wurde nicht bestaetigt.',
      };
    }
    return nichts();
  }

  // Nach dem Resume-Prompt wird erst wieder scharf gestellt, wenn die
  // Auslastung wirklich gefallen ist. Sonst kaeme die naechste Bitte im
  // naechsten Takt, waehrend die Sitzung den Auftrag gerade erst liest.
  if (stand.stufe === 'fortgesetzt' || stand.stufe === 'gescheitert') {
    if (lage.auslastung < regel.mahnenAb) {
      return { tat: 'nichts', stand: weiter(stand, 'ruhig', lage.jetzt), grund: '' };
    }
    return nichts();
  }

  // Ab hier wird geschickt -- und geschickt wird nur in eine stille Sitzung.
  const still = !lage.arbeitet && !lage.wartetAufFreigabe;

  if (stand.stufe === 'gebeten') {
    // IST NICHTS MEHR ZU ENTLASTEN, wird auch nicht kompaktiert (Befund 2).
    // Faellt die Auslastung, waehrend die Wache auf die Uebergabe wartet, hat
    // jemand anders kompaktiert -- alice von Hand, oder der Harness von
    // selbst. Ohne diesen Ausstieg kompaktierte die Wache ein fast leeres
    // Fenster ein zweites Mal und schickte hinterher noch einen Resume-Prompt:
    // zwei bezahlte Zuege und ein Kontextverlust fuer nichts.
    if (lage.auslastung < regel.mahnenAb) {
      return { tat: 'nichts', stand: weiter(stand, 'ruhig', lage.jetzt), grund: '' };
    }
    // Die Notbremse gilt nur, wenn sie ueber der Mahnschwelle liegt (Befund 4,
    // Meldung oben).
    const notbremse = regel.notbremseAb > regel.mahnenAb && lage.auslastung >= regel.notbremseAb;
    if (lage.uebergabeDa && still) {
      return {
        tat: 'kompaktieren',
        stand: weiter(stand, 'kompaktiert', lage.jetzt, {
          kompaktVorher: lage.kompaktierungen, ohneUebergabe: false,
        }),
        grund: 'Die Uebergabe liegt vor.',
      };
    }
    if (notbremse && still) {
      return {
        tat: 'kompaktieren',
        stand: weiter(stand, 'kompaktiert', lage.jetzt, {
          kompaktVorher: lage.kompaktierungen, ohneUebergabe: true,
        }),
        grund: `Notbremse bei ${lage.auslastung} Prozent -- ohne gesicherte Uebergabe.`,
      };
    }
    if (!stand.gemahnt && lage.jetzt - stand.seit >= fristen.uebergabeMs) {
      return {
        tat: 'uebergabe-mahnen',
        stand: { ...stand, gemahnt: true },
        grund: 'Die Uebergabe steht seit der Frist aus.',
      };
    }
    return nichts();
  }

  // 'ruhig'
  if (lage.auslastung < regel.mahnenAb) {
    // Faellt die Auslastung wieder unter die Schwelle, ist die naechste
    // Ueberschreitung eine NEUE Lage und bekommt ihre eigene Meldung. Ohne
    // dieses Zuruecksetzen meldete der Nur-Melden-Modus genau einmal je
    // Sitzungsleben (Befund 10) -- nach einer Handkompaktierung blieb er stumm.
    if (!stand.gemahnt) return nichts();
    return { tat: 'nichts', stand: { ...stand, gemahnt: false }, grund: '' };
  }
  if (!regel.eingreifen) {
    if (stand.gemahnt) return nichts();
    return {
      tat: 'melden',
      stand: { ...stand, gemahnt: true },
      grund: `${lage.auslastung} Prozent belegt -- die Wache meldet nur, sie greift nicht ein.`,
    };
  }
  if (!still) return nichts();
  return {
    tat: 'bitten',
    stand: weiter(stand, 'gebeten', lage.jetzt),
    grund: `${lage.auslastung} Prozent belegt.`,
  };
}

/**
 * DIE AUSLASTUNG IN PROZENT -- dieselbe Rechnung wie ueberall sonst im Haus
 * (workerstate.ts, `transcriptStand`): belegt ist, was beim naechsten Aufruf
 * wieder hineingeht. Ohne Nenner gibt es keine Prozentzahl, sondern -1.
 */
export function auslastung(tokens: number, fenster: number): number {
  if (tokens <= 0 || fenster <= 0) return -1;
  return Math.min(100, Math.floor((tokens * 100) / fenster));
}
