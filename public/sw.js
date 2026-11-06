const CACHE_NAME = 'aganim-app-shell-v1';
const APP_URL = new URL('./', self.registration.scope).href;
const STATIC_URLS = [
  new URL('manifest.webmanifest', self.registration.scope).href,
  new URL('icon-192.png', self.registration.scope).href,
  new URL('icon-512.png', self.registration.scope).href,
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const shellResponse = await fetch(APP_URL, { cache: 'no-store' });
    if (!shellResponse.ok) throw new Error('Unable to precache the AGANIM app shell.');
    const shell = await shellResponse.clone().text();
    const localAssets = new Set([...shell.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))["']/g)]
      .map(([, path]) => new URL(path, APP_URL).href)
      .filter(url => new URL(url).origin === self.location.origin));
    const entryScripts = [...localAssets].filter(url => url.endsWith('.js'));
    for (const scriptUrl of entryScripts) {
      const response = await fetch(scriptUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error('Unable to precache an AGANIM script.');
      const script = await response.text();
      for (const [, path] of script.matchAll(/["'`]((?:\/|\.\/)[^"'`]+\.js)["'`]/g)) {
        const url = new URL(path, scriptUrl);
        if (url.origin === self.location.origin) localAssets.add(url.href);
      }
    }
    await cache.put(APP_URL, shellResponse);
    await cache.addAll([...STATIC_URLS, ...localAssets]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith('aganim-app-shell-') && key !== CACHE_NAME)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  const scopePath = new URL(self.registration.scope).pathname;
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(scopePath)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    if (request.mode === 'navigate') {
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(APP_URL, response.clone());
        return response;
      } catch {
        return await cache.match(request) || await cache.match(APP_URL);
      }
    }

    if (!url.pathname.includes('/assets/') && !url.pathname.endsWith('.svg') && !url.pathname.endsWith('.webmanifest')) return fetch(request);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  })());
});