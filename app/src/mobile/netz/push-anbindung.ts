/**
 * WEB PUSH IM BROWSER (Paket 8 fuer die Funktionen, Paket 10 fuer die Anbindung).
 *
 * Mitteilungen gibt es auf iOS nur fuer die zum Home-Bildschirm hinzugefuegte
 * App (Spezifikation 6, ab iOS 16.4). Die Erlaubnis wird nur nach einer echten
 * Beruehrung erfragt -- `abonnieren()` ruft die Oberflaeche aus ihrem Knopf.
 * Dieselbe Subscription registriert die HTTP-Quelle dann signiert bei beiden Hosts.
 */
import type { JsonObject } from '../../mobile-shared/vertrag';
import type { PushStand } from '../components/quelle';
import { base64urlBytes, requestPushPermission } from '../push-client';
import type { PushAnbindung } from './http-quelle';

function standalone(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
}

function stand(): PushStand {
  if (typeof Notification === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { erlaubnis: 'nicht_moeglich', grund: 'Dieser Browser kann keine Mitteilungen empfangen.' };
  }
  if (!standalone()) {
    return { erlaubnis: 'nicht_moeglich', grund: 'Mitteilungen gibt es erst, wenn die Werkbank vom Home-Bildschirm aus läuft.' };
  }
  if (Notification.permission === 'granted') return { erlaubnis: 'erteilt', grund: null };
  if (Notification.permission === 'denied') return { erlaubnis: 'verweigert', grund: null };
  return { erlaubnis: 'offen', grund: null };
}

export function browserPush(): PushAnbindung {
  return {
    stand: async () => stand(),
    abonnieren: async (vapidOeffentlich) => {
      if (stand().erlaubnis === 'nicht_moeglich') return { stand: stand(), subscription: null };
      const erlaubnis = await requestPushPermission();
      if (erlaubnis !== 'granted') return { stand: stand(), subscription: null };
      const registrierung = await navigator.serviceWorker.ready;
      const vorhanden = await registrierung.pushManager.getSubscription();
      const abo = vorhanden ?? await registrierung.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: base64urlBytes(vapidOeffentlich),
      });
      return { stand: stand(), subscription: abo.toJSON() as unknown as JsonObject };
    },
  };
}
