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
//   * Guard-Annahme (angehaltener Bash-Befehl) und Worker-Antraege: JA, aber
//     nicht auf das Wort des Kerns (14.10.2026, Entscheidung des Nutzers „Annahme
//     am Handy und Guard angleichen: ja"). Eine gueltige Freigabe entsteht nur in
//     `wb-freigabe`, eine Antragsentscheidung nur in `wb-decide`. Beide pruefen
//     den Geraetebeleg selbst: der Beleg traegt dazu den signierten Umschlag und
//     den Body (`nachweis`), die Pruefstelle laesst `wb-mobil-pruefen` die
//     Signatur gegen die Kopplungsliste pruefen, an Eintrag und Entscheidung
//     binden und den Umschlag verbrauchen (Ablauf 60 s, Nonce, Zaehler). Ohne
//     Nachweis bleibt Annehmen per Mobil gesperrt (fail closed). Spezifikation
//     4.3: „dasselbe Belegobjekt ... bis freigabeErteilen() und wb-freigabe".
//   * Sitzungsstart mit `--mensch` (Effort-Deckel): NEIN, aus demselben Grund --
//     `wb-code` misst den Menschen ueber `wb-mensch`, nicht ueber diesen Beleg.
import type { AuthenticatedRequest } from './mobile/auth/auth';
import type { SignedRequestEnvelope } from '../mobile-shared/vertrag';

export type Herkunft = 'oberflaeche' | 'steuerkanal';

export type Herkunftsbeleg =
  /** Ein Klick in einer Oberflaeche dieses Kerns; `echt` ist dessen isTrusted. */
  | { readonly art: 'oberflaeche'; readonly echt: boolean }
  /** Steuerkanal, Skript, alles ohne Nachweis. */
  | { readonly art: 'steuerkanal' }
  /** Ein vom Mobile-HTTP-Server gepruefter, signierter Umschlag eines gekoppelten Geraets. */
  | { readonly art: 'mobilgeraet'; readonly anfrage: AuthenticatedRequest; readonly nachweis?: MobilNachweis };

/**
 * Was eine Pruefstelle ausserhalb des Kerns selbst nachpruefen kann: der signierte
 * Umschlag und genau die Bytes, deren Hash er traegt. Kein Geheimnis -- ohne den
 * privaten Schluessel des Geraets laesst sich daraus keine andere Handlung bauen,
 * und der Umschlag gilt nur einmal.
 */
export interface MobilNachweis {
  readonly umschlag: SignedRequestEnvelope;
  readonly body: Buffer;
}

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
export function mobilBeleg(anfrage: AuthenticatedRequest, nachweis?: MobilNachweis): Herkunftsbeleg {
  if (!verifizierteMobilanfragen.has(anfrage)) return { art: 'steuerkanal' };
  return nachweis ? { art: 'mobilgeraet', anfrage, nachweis } : { art: 'mobilgeraet', anfrage };
}

/** Der weiterreichbare Nachweis eines geprueften Mobilbelegs, sonst null. */
export function mobilNachweis(beleg: Herkunftsbeleg): MobilNachweis | null {
  return beleg.art === 'mobilgeraet' && istVerifizierterMobilbeleg(beleg) && beleg.nachweis ? beleg.nachweis : null;
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
 * Ob eine Guard-Annahme den Weg ueber den Menschen-Nachweis (M2) zu `wb-freigabe`
 * gehen darf: nur der echte Klick in dieser Oberflaeche. Ein Mobilbeleg geht einen
 * eigenen Weg (`wb-freigabe --mobilbeleg`, siehe freigaben.ts `freigabeErteilen`).
 */
export function guardAnnahmeErlaubt(beleg: Herkunftsbeleg): boolean {
  return beleg.art === 'oberflaeche' && beleg.echt;
}
