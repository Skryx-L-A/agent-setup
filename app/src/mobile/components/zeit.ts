/** Zeitangaben in der Sprache der Oberflaeche. */

const MIN = 60_000;
const TAG = 86_400_000;

const uhrFormat = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const tagFormat = new Intl.DateTimeFormat('de-DE', { weekday: 'short' });
const datumFormat = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short' });

export function uhr(t: number): string {
  return uhrFormat.format(t);
}

function tagesanfang(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** „gerade eben“, „vor 7 Min.“, „14:02“, „gestern“, „Mo.“, „12. Sept.“ */
export function relativ(t: number, jetzt = Date.now()): string {
  const d = jetzt - t;
  if (d < 45_000) return 'gerade eben';
  if (d < 60 * MIN) return `vor ${Math.max(1, Math.round(d / MIN))} Min.`;
  const heute = tagesanfang(jetzt);
  if (t >= heute) return uhr(t);
  if (t >= heute - TAG) return 'gestern';
  if (t >= heute - 6 * TAG) return tagFormat.format(t);
  return datumFormat.format(t);
}

/** Datenalter: „1 Min. alt“, „47 Min. alt“, „3 Std. alt“. */
export function alter(ms: number): string {
  if (ms < 90_000) return 'gerade aktuell';
  if (ms < 60 * MIN) return `${Math.round(ms / MIN)} Min. alt`;
  return `${Math.round(ms / (60 * MIN))} Std. alt`;
}

/** Ueberschrift eines Tagesabschnitts. */
export function tag(t: number, jetzt = Date.now()): string {
  const heute = tagesanfang(jetzt);
  if (t >= heute) return 'Heute';
  if (t >= heute - TAG) return 'Gestern';
  return new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }).format(t);
}

/** Zeitmarke im Verlauf: „Heute 17:48“, „Gestern 09:12“. */
export function marke(t: number, jetzt = Date.now()): string {
  return `${tag(t, jetzt)} ${uhr(t)}`;
}
