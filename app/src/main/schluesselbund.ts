// Der Schluesselbund: der ehrliche Weg fuer einen API-Schluessel, ueber einen
// eigenen IPC-Kanal, statt ihn in die geteilte Einstellungsdatei zu schreiben.
//
// WARUM DIESE DATEI. Die Modelle-Seite zeigte seit dem 11.08. schon, OB ein
// Anbieter seinen Zugang hat (`einstellungsfenster.ts`, `anbieterSicht`) --
// aber es gab keinen Weg, ihn EINZUGEBEN. Der Grund dafuer stand im Infotext
// selbst: ~/.claude/workbench/settings.json ist geteilter Klartext, den auch
// Worker beschreiben, und jede Aenderung landet im Aenderungsprotokoll -- ein
// Schluessel dort laege im Klartext an zwei Orten.
//
// Der macOS-Schluesselbund ist der Weg, den `wb-state` und `wb-harness-run`
// beim SPAWN eines Harness ohnehin schon zuerst befragen (`secret_chain()` in
// shell/wb-state, `secret_value()` in shell/wb-harness-run: Keychain -> Datei
// -> Umgebungsvariable). Diese Datei schreibt NUR noch dorthin -- kein zweiter
// Weg, keine zweite Wahrheit.
//
// DIE SICHERUNG. Ein Wert, der hier hineingeht, kommt nie wieder heraus, um
// gezeigt zu werden: `schluesselVorhanden()` fragt den Schluesselbund nur nach
// PRAESENZ (`find-generic-password` OHNE `-w`) -- genau wie `secret_present()`
// in shell/wb-state es fuer denselben Zweck tut, und aus demselben Grund: ohne
// `-w` entsteht keine Leseanfrage, die den Wert je in diesen Prozess holt.
//
// DER ECHTE ZUGRIFF UND SEINE ATTRAPPE. `SchluesselZugriff` ist die Naht, an
// der ein Test ansetzt (dieselbe Bauform wie `Sendewege` in melden.ts): die
// produktive Seite (`echterZugriff`) ruft `security` -- ueber den BLOSSEN
// Namen, nicht ueber einen festen Pfad, genau wie shell/wb-harness-run es tut
// (`command -v security`). Das ist kein Zufall: ein Test kann damit eine
// Attrappe vor die echte `security` in den PATH haengen, ohne den echten
// Schluesselbund je anzufassen -- shell/tests/test-schluesselbund.sh tut genau
// das, bis in den gespawnten Harness hinein.
import { spawnSync } from 'node:child_process';
import { effectiveProviders, findProvider, parseModelsRegistry } from '../../../extension/src/models.ts';

/** Das eine Konto, unter dem jeder Eintrag abgelegt wird -- der DIENST (der Anbieter) unterscheidet sie. */
const KONTO = 'apiKey';

const SECURITY_BIN = 'security';

/**
 * Die Naht zum echten Schluesselbund. `setzen` legt den Wert ab (oder
 * ueberschreibt ihn) und liefert nur, ob es geklappt hat -- nie den Wert
 * selbst, auch nicht im Fehlerfall. `vorhanden` fragt nur die PRAESENZ ab.
 */
export interface SchluesselZugriff {
  setzen(service: string, konto: string, wert: string): boolean;
  vorhanden(service: string): boolean;
}

/**
 * Die Bestaetigungsfrage von `security add-generic-password -w` (ohne
 * angehaengten Wert) verlangt den Wert ZWEIMAL ueber stdin -- einmal Eingabe,
 * einmal Wiederholung. Gemessen (11.08.): `-w <wert>` als Argument stuende
 * kurz im Prozessabbild jedes anderen lokalen Prozesses; die Form ohne
 * Argument haelt den Wert ausschliesslich in der stdin-Pipe dieses einen
 * Kindprozesses.
 */
const echterZugriff: SchluesselZugriff = {
  setzen(service, konto, wert) {
    const r = spawnSync(
      SECURITY_BIN,
      ['add-generic-password', '-a', konto, '-s', service, '-U', '-w'],
      { input: `${wert}\n${wert}\n`, encoding: 'utf8', timeout: 10_000 },
    );
    return r.status === 0;
  },
  vorhanden(service) {
    const r = spawnSync(
      SECURITY_BIN,
      ['find-generic-password', '-s', service],
      { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'ignore', 'ignore'] },
    );
    return r.status === 0;
  },
};

/**
 * Einen Wert fuer einen Dienst ablegen. Leerer Dienst oder leerer (nach dem
 * Rand getrimmter) Wert legt NICHTS an -- ein leerer Schluesselbund-Eintrag
 * waere schlimmer als gar keiner, weil `secret_present()` ihn dann faelschlich
 * fuer vorhanden haelt.
 */
export function schluesselSetzen(
  service: string,
  wert: string,
  zugriff: SchluesselZugriff = echterZugriff,
): boolean {
  const s = service.trim();
  const w = wert.trim();
  if (!s || !w) return false;
  return zugriff.setzen(s, KONTO, w);
}

/** Liegt fuer diesen Dienst ein Eintrag vor? Nie der Wert, nur die Praesenz. */
export function schluesselVorhanden(
  service: string,
  zugriff: SchluesselZugriff = echterZugriff,
): boolean {
  const s = service.trim();
  if (!s) return false;
  return zugriff.vorhanden(s);
}

/** Ein Anbieter mit Schluessel -- Dienstname aus der Registry, nie erfunden. */
export interface AnbieterMitSchluessel {
  id: string;
  label: string;
  service: string;
}

/**
 * Alle Anbieter, die ueberhaupt einen Schluesselbund-Dienst fuehren -- ueber
 * `effectiveProviders` (`extension/src/models.ts`), also samt der
 * eingebauten Anbieter, die keine eigene Zeile in models.json brauchen.
 * Dieselbe Quelle wie `findProvider` unten: eine Liste, die weniger sieht als
 * das Setzen kann, waere eine Zeile, die man nie zu Gesicht bekommt, obwohl
 * sie sich setzen liesse. `keychainService` ist die Auflage: kein Dienst,
 * keine Zeile in dieser Liste.
 */
export function anbieterMitSchluessel(registryRaw: string | undefined): AnbieterMitSchluessel[] {
  const registry = parseModelsRegistry(registryRaw);
  const raus: AnbieterMitSchluessel[] = [];
  for (const p of effectiveProviders(registry)) {
    if (p.keychainService) raus.push({ id: p.id, label: p.label ?? p.id, service: p.keychainService });
  }
  return raus;
}

/**
 * Der Wert fuer EINEN Anbieter, ueber seine ID -- der Dienstname kommt aus der
 * Registry, nie vom Aufrufer. Ein unbekannter oder schluessel-loser Anbieter
 * legt nichts an und meldet `false`.
 */
export function schluesselSetzenFuerAnbieter(
  registryRaw: string | undefined,
  providerId: string,
  wert: string,
  zugriff: SchluesselZugriff = echterZugriff,
): boolean {
  const registry = parseModelsRegistry(registryRaw);
  const p = findProvider(registry, providerId);
  if (!p?.keychainService) return false;
  return schluesselSetzen(p.keychainService, wert, zugriff);
}

/**
 * Je Anbieter-ID: liegt ein Schluessel vor? Fuer die Anzeige -- eine einzige
 * Bulk-Abfrage, damit die Seite nicht einen IPC-Aufruf je Zeile braucht.
 */
export function schluesselStatusAlle(
  registryRaw: string | undefined,
  zugriff: SchluesselZugriff = echterZugriff,
): Record<string, boolean> {
  const raus: Record<string, boolean> = {};
  for (const p of anbieterMitSchluessel(registryRaw)) raus[p.id] = schluesselVorhanden(p.service, zugriff);
  return raus;
}
