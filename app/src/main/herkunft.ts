// DER HERKUNFTSBELEG (Paket 10 der mobilen Werkbank, Spezifikation 3.1 und 4.3).
//
// Bis heute trugen Welten, Aufgaben und Freigaben ihre Herkunft als Paar aus
// `herkunft` ('oberflaeche' | 'steuerkanal') und dem Boolean `echt` (isTrusted
// des Klicks) beziehungsweise `mensch`. Ein gekoppeltes Mobilgeraet passt in
// keines von beiden: es ist kein Klick in diesem Fenster und kein Steuerkanal.
// Es pauschal als Mensch zu fuehren, haette jede menschenexklusive Handlung fuer
// den HTTP-Weg geoeffnet; es als Steuerkanal zu fuehren, verschwiege, dass eine
// Geraetesignatur dahintersteht. Deshalb eine dritte, eigene Herkunft.
//
// WAS DER MOBILBELEG IST: der Mobile-HTTP-Server hat den signierten Umschlag
// (awb-mobile-request-v1) gegen den registrierten oeffentlichen Schluessel eines
// gekoppelten, nicht widerrufenen Geraets geprueft -- Audience, Bodyhash,
// Zeitfenster, Nonce und Zaehler eingeschlossen. Der private Schluessel liegt
// nicht exportierbar im Browser; kein lokaler Prozess kann damit eine neue
// Handlung signieren. Als Beleg gilt nur ein Objekt, das der Server selbst nach
// dieser Pruefung registriert hat (WeakSet unten): ein Objekt gleicher Form aus
// IPC, Steuerkanal oder JSON ist kein Beleg.
//
// WOFUER ER REICHT -- und die Begruendung, warum genau so:
//   * Absender in den Welten (`mensch` statt `cli-operator`): JA. Der Absender
//     ist dort Metadatum, die Bibliothek speichert `verified: false` (welten.ts,
//     Kopf). Der Kern entscheidet ihn heute aus dem isTrusted-Bit, das der
//     Renderer ueber IPC meldet; der Mobilbeleg ist eine im Kern selbst gepruefte
//     Signatur ueber genau diese Handlung und damit mindestens so stark.
//     Spezifikation 3.1: „erhaelt den Absender mensch erst, wenn WeltenQuelle ...
//     einen verifizierten Herkunftsbeleg akzeptiert" -- das tut sie hiermit.
//   * Guard-Annahme (angehaltener Bash-Befehl): NEIN. Eine gueltige Freigabe
//     entsteht nur in `wb-freigabe`, und das misst die Herkunft selbst ueber die
//     Ahnenreihe (`wb-mensch`, WB_MENSCH_QUELLE=oberflaeche). Der Mobilbeleg
//     reicht nicht bis dorthin; Spezifikation 4.3 verlangt, dass „dasselbe
//     Belegobjekt ... bis freigabeErteilen() und wb-freigabe reichen" muss. Bis
//     `wb-freigabe` einen Mobilbeleg selbst pruefen kann, bleibt die Annahme per
//     Mobil gesperrt (fail closed); Ablehnen geht wie bisher ohne Nachweis.
//   * Sitzungsstart mit `--mensch` (Effort-Deckel): NEIN, aus demselben Grund --
//     `wb-code` misst den Menschen ueber `wb-mensch`, nicht ueber diesen Beleg.
import type { AuthenticatedRequest } from './mobile/auth/auth';

export type Herkunft = 'oberflaeche' | 'steuerkanal';

export type Herkunftsbeleg =
  /** Ein Klick in einer Oberflaeche dieses Kerns; `echt` ist dessen isTrusted. */
  | { readonly art: 'oberflaeche'; readonly echt: boolean }
  /** Steuerkanal, Skript, alles ohne Nachweis. */
  | { readonly art: 'steuerkanal' }
  /** Ein vom Mobile-HTTP-Server gepruefter, signierter Umschlag eines gekoppelten Geraets. */
  | { readonly art: 'mobilgeraet'; readonly anfrage: AuthenticatedRequest };

const verifizierteMobilanfragen = new WeakSet<AuthenticatedRequest>();

/**
 * Nur der Mobile-HTTP-Server ruft das, unmittelbar nachdem die Signatur des
 * Umschlags gegen das gekoppelte Geraet geprueft ist.
 */
export function mobilanfrageBelegen(anfrage: AuthenticatedRequest): AuthenticatedRequest {
  verifizierteMobilanfragen.add(anfrage);
  return anfrage;
}

/** Der Beleg fuer eine gepruefte Mobilanfrage; ein ungeprueftes Objekt ergibt keinen Mobilbeleg. */
export function mobilBeleg(anfrage: AuthenticatedRequest): Herkunftsbeleg {
  return verifizierteMobilanfragen.has(anfrage) ? { art: 'mobilgeraet', anfrage } : { art: 'steuerkanal' };
}

/** Die bisherige Paarform, unveraendert gedeutet. */
export function belegAus(herkunft: Herkunft, echt: boolean): Herkunftsbeleg {
  return herkunft === 'oberflaeche' ? { art: 'oberflaeche', echt } : { art: 'steuerkanal' };
}

export function istHerkunftsbeleg(wert: unknown): wert is Herkunftsbeleg {
  const art = (wert as { art?: unknown } | null)?.art;
  return typeof wert === 'object' && wert !== null && (art === 'oberflaeche' || art === 'steuerkanal' || art === 'mobilgeraet');
}

export function istVerifizierterMobilbeleg(beleg: Herkunftsbeleg): boolean {
  return beleg.art === 'mobilgeraet' && verifizierteMobilanfragen.has(beleg.anfrage);
}

/** Ob eine Welten-Handlung als `mensch` schreibt (Begruendung im Kopf dieser Datei). */
export function menschlicherAbsender(beleg: Herkunftsbeleg): boolean {
  if (beleg.art === 'oberflaeche') return beleg.echt;
  return istVerifizierterMobilbeleg(beleg);
}

/**
 * Ob eine Guard-Annahme den Weg zu `wb-freigabe` gehen darf. Nur der echte
 * Klick in dieser Oberflaeche -- der Mobilbeleg reicht nicht bis `wb-freigabe`.
 */
export function guardAnnahmeErlaubt(beleg: Herkunftsbeleg): boolean {
  return beleg.art === 'oberflaeche' && beleg.echt;
}
