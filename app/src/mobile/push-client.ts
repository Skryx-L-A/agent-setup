/** Browserreine Push-Helfer fuer die spaetere Oberflaeche; sie bauen kein DOM auf. */

export interface PushApi {
  put(subscription: PushSubscriptionJSON): Promise<{ subscription_id: string }>;
  remove(subscriptionId: string): Promise<void>;
}

export interface PushClientStatus {
  readonly supported: boolean;
  readonly permission: NotificationPermission | 'unsupported';
  readonly subscribed: boolean;
  readonly subscription_id?: string;
}

export function base64urlBytes(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('VAPID public key is not base64url');
  const padded = `${value}${'='.repeat((4 - value.length % 4) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = globalThis.atob(padded);
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function supported(): boolean {
  return typeof Notification !== 'undefined' && typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/** Nur nach einer echten Touch-/Klickhandlung der Oberflaeche aufrufen. */
export async function requestPushPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!supported()) return 'unsupported';
  return Notification.requestPermission();
}

/** Abonniert mit dem serverseitig gelieferten oeffentlichen VAPID-Schluessel. */
export async function subscribeToPush(registration: ServiceWorkerRegistration, vapidPublicKey: string, api: PushApi): Promise<string> {
  if (!supported()) throw new Error('Web Push is not supported');
  if (Notification.permission !== 'granted') throw new Error('push permission is not granted');
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64urlBytes(vapidPublicKey) });
  const result = await api.put(subscription.toJSON());
  return result.subscription_id;
}

export async function unsubscribeFromPush(registration: ServiceWorkerRegistration, subscriptionId: string, api: PushApi): Promise<boolean> {
  const subscription = await registration.pushManager.getSubscription();
  const removed = await api.remove(subscriptionId);
  void removed;
  return subscription ? subscription.unsubscribe() : true;
}

export async function pushStatus(registration?: ServiceWorkerRegistration, subscriptionId?: string): Promise<PushClientStatus> {
  if (!supported()) return { supported: false, permission: 'unsupported', subscribed: false };
  const subscription = registration ? await registration.pushManager.getSubscription() : null;
  return { supported: true, permission: Notification.permission, subscribed: subscription !== null, ...(subscriptionId ? { subscription_id: subscriptionId } : {}) };
}
