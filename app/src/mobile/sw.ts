export interface MobileServiceWorkerManifest {
  readonly cacheName: string;
  readonly shellAssets: readonly string[];
}

interface ServiceWorkerLike {
  readonly location: Location;
  readonly caches: CacheStorage;
  readonly clients: ClientDirectory;
  readonly registration: { showNotification(title: string, options: NotificationOptions): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

interface ExtendableEvent { waitUntil(promise: Promise<unknown>): void; }
interface FetchEvent extends ExtendableEvent { readonly request: Request; respondWith(response: Promise<Response>): void; }
interface PushEvent extends ExtendableEvent { readonly data?: { json(): unknown }; }
interface NotificationEvent extends ExtendableEvent { readonly notification: { data: unknown; close(): void }; }
interface WindowClient { readonly url: string; focus(): Promise<WindowClient>; }
interface ClientDirectory {
  matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly WindowClient[]>;
  openWindow(url: string): Promise<WindowClient | null>;
}

function scope(): ServiceWorkerLike | undefined {
  const candidate = globalThis as unknown as Partial<ServiceWorkerLike>;
  return typeof candidate.addEventListener === 'function' && candidate.caches ? candidate as ServiceWorkerLike : undefined;
}

function safePayload(value: unknown): { event_id: string; text: string; link: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.event_id === 'string' && typeof record.text === 'string' && typeof record.link === 'string'
    ? { event_id: record.event_id, text: record.text, link: record.link } : undefined;
}

/**
 * Die Manifestdateiliste kommt vom Build. API-Pfade bleiben ausnahmslos
 * network-only (der SW fasst sie gar nicht an); die Event-ID wird in Cache
 * Storage persistent entdoppelt.
 */
export function installMobileServiceWorker(manifest: MobileServiceWorkerManifest): void {
  const worker = scope();
  if (!worker) return;
  const eventCache = `${manifest.cacheName}-events`;
  worker.addEventListener('install', (value) => {
    const event = value as ExtendableEvent;
    event.waitUntil(worker.caches.open(manifest.cacheName).then((cache) => cache.addAll([...manifest.shellAssets])).then(() => worker.skipWaiting()));
  });
  worker.addEventListener('activate', (value) => {
    const event = value as ExtendableEvent;
    event.waitUntil(worker.caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('awb-mobile-') && key !== manifest.cacheName && key !== eventCache)
      .map((key) => worker.caches.delete(key)))));
  });
  worker.addEventListener('fetch', (value) => {
    const event = value as FetchEvent;
    const url = new URL(event.request.url);
    // API und fremde Origins (peer) gehen direkt vom Browser ins Netz, ohne
    // `respondWith`: so haengt ein SSE-Strom nicht am Leben des Service Workers,
    // und kein Umweg kostet eine Anfrage Zeit. Dasselbe gilt fuer jede Nicht-GET-Anfrage.
    if (url.pathname.startsWith('/mobile/v1/') || url.origin !== worker.location.origin || event.request.method !== 'GET') return;
    event.respondWith(worker.caches.open(manifest.cacheName).then((cache) => cache.match(event.request).then((cached) => cached ?? fetch(event.request))));
  });
  worker.addEventListener('push', (value) => {
    const event = value as PushEvent;
    let parsed: unknown;
    try { parsed = event.data?.json(); } catch { return; }
    const payload = safePayload(parsed);
    if (!payload) return;
    event.waitUntil(worker.caches.open(eventCache).then(async (cache) => {
      const key = new Request(new URL(`/__awb-mobile-notification/${encodeURIComponent(payload.event_id)}`, worker.location.origin).href);
      if (await cache.match(key)) return;
      await cache.put(key, new Response('1'));
      await worker.registration.showNotification('Werkbank', { body: payload.text, data: payload, tag: payload.event_id });
    }));
  });
  worker.addEventListener('notificationclick', (value) => {
    const event = value as NotificationEvent;
    event.notification.close();
    const payload = safePayload(event.notification.data);
    if (!payload) return;
    event.waitUntil((async (): Promise<void> => {
      const destination = new URL(payload.link, worker.location.origin);
      if (destination.origin !== worker.location.origin) return;
      const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = clients.find((client) => client.url === destination.href);
      if (existing) {
        await existing.focus();
        return;
      }
      await worker.clients.openWindow(destination.pathname + destination.search + destination.hash);
    })());
  });
}

/** Der Mobile-Build setzt diese Daten vor dem Laden des Worker-Bundles. */
const configuredManifest = (globalThis as unknown as { __AWB_MOBILE_SW_MANIFEST__?: MobileServiceWorkerManifest }).__AWB_MOBILE_SW_MANIFEST__;
if (configuredManifest && typeof configuredManifest.cacheName === 'string' && Array.isArray(configuredManifest.shellAssets)) {
  installMobileServiceWorker(configuredManifest);
}
