/**
 * EINSTIEG DER MOBILEN WERKBANK (Bauplan Paket 9, Quelle seit Paket 10).
 *
 * Die Oberflaeche kennt nur `MobileQuelle`. Der Produktivbau (app/build.mjs)
 * setzt die signierende HTTP-Quelle ein, registriert den Service Worker und
 * kennt keinen Test- und Vorfuehrzugriff; der Pruefbau der WebKit-E2E
 * (test/mobile/ui/bauen.mjs) setzt die Attrappe ein. Welcher Bau es ist,
 * entscheidet `__AWB_MOBILE_ATTRAPPE__` zur Bauzeit -- der jeweils andere Zweig
 * faellt aus dem Buendel heraus.
 *
 * Lebenszyklus (Spezifikation 7.3): Bei `visibilitychange`, `pageshow`,
 * Netzwechsel und Rueckkehr aus dem Ruhezustand wird der Ereignisstrom
 * verworfen und ein vollstaendiger Abgleich gemacht.
 */
import { schriftAnpassen, themaAnwenden, themaBeobachten, viewportAnbinden } from './components/geraet';
import type { MobileQuelle } from './components/quelle';
import { Rahmen } from './components/rahmen';
import { Router } from './components/router';
import { Stand } from './components/stand';
import { HttpQuelle } from './netz/http-quelle';
import { IndexedDbSpeicher } from './netz/speicher';
import { browserPush } from './netz/push-anbindung';

/** Zur Bauzeit gesetzt: true nur im Pruefbau mit Attrappen-Daten. */
declare const __AWB_MOBILE_ATTRAPPE__: boolean;
/** Zur Bauzeit gesetzt: dieselbe Kennung traegt der Server (Spezifikation 10.12). */
declare const __AWB_MOBILE_BUILD__: string;

declare global {
  interface Window {
    /** Nur im Pruefbau mit Attrappe: Test- und Vorfuehrzugriff auf Stand und Quelle. */
    __werkbank?: { stand: Stand; quelle: MobileQuelle; router: Router };
  }
}

/** Die API-Origins stehen in der ausgelieferten Huelle; der Server setzt sie aus seiner Konfiguration ein. */
function konfigurierteOrigins(): string[] {
  const inhalt = document.querySelector('meta[name="awb-mobile-origins"]')?.getAttribute('content') ?? '';
  return inhalt.split(/\s+/).filter((o) => /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(o));
}

async function quelleBauen(): Promise<MobileQuelle> {
  if (__AWB_MOBILE_ATTRAPPE__) {
    const { AttrappenQuelle, optionenAusAdresse } = await import('./attrappe/quelle');
    return new AttrappenQuelle(optionenAusAdresse(location.search));
  }
  return new HttpQuelle({
    origins: konfigurierteOrigins(),
    heimat: location.origin,
    speicher: new IndexedDbSpeicher(),
    build: __AWB_MOBILE_BUILD__,
    push: browserPush(),
  });
}

const TAKT_MS = 15_000;

async function start(): Promise<void> {
  const quelle = await quelleBauen();
  const stand = new Stand(quelle);
  const router = new Router();

  themaAnwenden(null);
  themaBeobachten();
  schriftAnpassen();
  viewportAnbinden();

  const rahmen = new Rahmen(stand, router);
  const wurzel = document.getElementById('app');
  if (!wurzel) return;
  wurzel.replaceChildren(rahmen.el);
  router.starten();

  if (__AWB_MOBILE_ATTRAPPE__) window.__werkbank = { stand, quelle, router };
  // Die versionierte Huelle kommt aus dem Service Worker (Paket 8); API und SSE
  // bleiben dort network-only. Nur im Produktivbau: die Attrappe hat keinen.
  if (!__AWB_MOBILE_ATTRAPPE__ && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => { /* ohne SW bleibt die App online benutzbar */ });
  }

  // Ist die Kopplung unbekannt (Geraetespeicher schweigt), versucht jeder Anlass es erneut.
  const abgleichbar = (): boolean => !stand.kopplung || stand.kopplung.gekoppelt;
  stand.bei(() => themaAnwenden(stand.bootstrap?.theme ?? null));
  await stand.start();

  // Relative Zeiten und Datenalter fortschreiben; der Punkt wird grau, wenn
  // der letzte Abgleich zu alt ist -- nicht, weil ein Zeitgeber laeuft.
  window.setInterval(() => stand.melden(), TAKT_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stand.trennen();
    } else if (abgleichbar()) {
      void stand.abgleichen();
    }
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && abgleichbar()) void stand.abgleichen();
  });
  window.addEventListener('online', () => { if (abgleichbar()) void stand.abgleichen(); });
  window.addEventListener('offline', () => {
    stand.verbunden = false;
    stand.trennen();
    stand.melden();
  });
  // Rueckkehr aus einem eingefrorenen Zustand ohne visibilitychange: grosse Luecke im Takt.
  let letzterTakt = Date.now();
  window.setInterval(() => {
    const jetzt = Date.now();
    if (jetzt - letzterTakt > 3 * TAKT_MS && abgleichbar() && !document.hidden) void stand.abgleichen();
    letzterTakt = jetzt;
  }, TAKT_MS);
}

void start();
