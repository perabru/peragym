'use strict';

// The app is free. Only static assets are cached; personal records stay in IndexedDB.
const VERSION = 'peragym-3.3.0';
const PUBLIC_CACHE = `${VERSION}-public`;
const APP_CACHE = `${VERSION}-app`;
const CACHE_PREFIX = 'peragym-';
const APP_SUFFIX = '-app';
const THEME_PATHS = new Set([
  '/assets/cassette.svg', '/assets/night-drive.jpg', '/assets/palms.svg',
  '/assets/fonts/bungee.ttf', '/assets/fonts/yellowtail.ttf'
]);
const PUBLIC_PATHS = new Set([
  '/', '/index.html', '/promo.css', '/promo.js', '/pwa.js', '/pwa.css',
  '/offline.html', '/manifest.webmanifest', '/icons/icon-192.png',
  '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png',
  ...THEME_PATHS
]);
const BASE_APP_PATHS = new Set([
  '/app/', '/app/index.html', '/app/style.css', '/app/app.js', '/app/db.js', '/app/charts.js'
]);
const APP_PATHS = new Set([...BASE_APP_PATHS, '/app/music-links.js', '/app/music-player.js', '/app/boot.js', '/app/spotify-account.js', '/app/spotify-playback.js']);
const OFFLINE_PATH = '/offline.html';
let preparingOffline;

const absolute = path => new URL(path, self.location.origin).href;
const appKey = path => absolute(path === '/app/' ? '/app/index.html' : path);
const successful = response => response.status === 200 && !response.redirected;
const mime = response => (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();

function appResponse(response, path) {
  // Hosting marks the free shell with X-PeraGym-App: 1. The finite-path MIME
  // check also supports ordinary static hosting without custom headers.
  if (!APP_PATHS.has(path) || !successful(response)) return false;
  const type = mime(response);
  if (path === '/app/' || path === '/app/index.html') return type === 'text/html';
  if (path.endsWith('.css')) return type === 'text/css';
  if (path.endsWith('.js')) return type === 'text/javascript' || type === 'application/javascript';
  return false;
}

function themeResponse(response, path) {
  if (!THEME_PATHS.has(path) || !successful(response)) return false;
  const type = mime(response);
  if (path.endsWith('.svg')) return type === 'image/svg+xml';
  if (path.endsWith('.jpg')) return type === 'image/jpeg';
  if (path.endsWith('.ttf')) return ['font/ttf', 'font/sfnt', 'application/font-sfnt', 'application/x-font-ttf'].includes(type);
  return false;
}

function publicResponse(response) {
  return successful(response) && response.headers.get('X-PeraGym-App') !== '1';
}

async function eraseAppCaches() {
  const names = await caches.keys();
  await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name.endsWith(APP_SUFFIX)).map(name => caches.delete(name)));
}

async function tellClients(message, client) {
  if (client && typeof client.postMessage === 'function') {
    client.postMessage(message);
    return;
  }
  const clients = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
  clients.forEach(item => item.postMessage(message));
}

async function completeShell(cacheName) {
  const cache = await caches.open(cacheName);
  const requiredPaths = cacheName === APP_CACHE ? APP_PATHS : BASE_APP_PATHS;
  for (const path of requiredPaths) {
    const response = await cache.match(appKey(path));
    if (!response || !appResponse(response, path)) return false;
  }
  if (cacheName === APP_CACHE) {
    const theme = await caches.open(PUBLIC_CACHE);
    for (const path of THEME_PATHS) {
      const response = await theme.match(absolute(path));
      if (!response || !themeResponse(response, path)) return false;
    }
  }
  return true;
}

async function appCaches() {
  const names = await caches.keys();
  return [APP_CACHE, ...names.filter(name => name.startsWith(CACHE_PREFIX) && name.endsWith(APP_SUFFIX) && name !== APP_CACHE).reverse()].filter(name => names.includes(name));
}

async function cachedApp(path) {
  // A prior complete shell remains available until its replacement is ready.
  const names = await appCaches();
  for (const name of names) {
    if (!await completeShell(name)) continue;
    const response = await (await caches.open(name)).match(appKey(path));
    if (response && appResponse(response, path)) return response;
  }
  // A just-opened app may have only its requested assets available so far.
  for (const name of names) {
    const response = await (await caches.open(name)).match(appKey(path));
    if (response && appResponse(response, path)) return response;
  }
}

async function warmAppShell(client) {
  // No account, session, donation, or payment endpoint is needed to use the app.
  const paths = [...APP_PATHS].filter(path => path !== '/app/').concat([...THEME_PATHS]);
  const results = await Promise.allSettled(paths.map(async path => {
    if (THEME_PATHS.has(path)) {
      const saved = await (await caches.open(PUBLIC_CACHE)).match(absolute(path));
      if (saved && themeResponse(saved, path)) return {path, response: saved};
    }
    const response = await fetch(absolute(path), {credentials: 'same-origin', cache: 'no-store'});
    if (!(THEME_PATHS.has(path) ? themeResponse(response, path) : appResponse(response, path))) throw new Error('Invalid application asset.');
    return {path, response};
  }));
  if (results.every(result => result.status === 'fulfilled')) {
    const cache = await caches.open(APP_CACHE);
    const theme = await caches.open(PUBLIC_CACHE);
    for (const result of results) {
      if (THEME_PATHS.has(result.value.path)) await theme.put(absolute(result.value.path), result.value.response);
      else await cache.put(appKey(result.value.path), result.value.response);
    }
    if (await completeShell(APP_CACHE)) {
      const names = await caches.keys();
      await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name.endsWith(APP_SUFFIX) && name !== APP_CACHE).map(name => caches.delete(name)));
      await tellClients({type: 'PERAGYM_OFFLINE_READY'}, client);
      return;
    }
  }
  // A transient network error never erases a previously working offline app.
  for (const name of await appCaches()) {
    if (await completeShell(name)) {
      await tellClients({type: 'PERAGYM_OFFLINE_READY'}, client);
      return;
    }
  }
}

function prepareOffline(client) {
  if (!preparingOffline) preparingOffline = warmAppShell(client).finally(() => {preparingOffline = undefined;});
  return preparingOffline;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(PUBLIC_CACHE);
    await Promise.allSettled([...PUBLIC_PATHS].map(async path => {
      const response = await fetch(absolute(path), {credentials: 'same-origin', cache: 'reload'});
      if (publicResponse(response)) await cache.put(absolute(path), response);
    }));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name.endsWith('-public') && name !== PUBLIC_CACHE).map(name => caches.delete(name)));
    await self.clients.claim();
    // Never remove IndexedDB: it belongs to the person using this device.
  })());
});

self.addEventListener('message', event => {
  const client = event.source;
  if (!client || !client.url || new URL(client.url).origin !== self.location.origin) return;
  if (event.data?.type === 'PERAGYM_PREPARE_OFFLINE' || event.data?.type === 'PERAGYM_APP_READY') event.waitUntil(prepareOffline(client));
  if (event.data?.type === 'PERAGYM_CLEAR_OFFLINE') event.waitUntil(eraseAppCaches());
  if (event.data?.type === 'PERAGYM_SKIP_WAITING') self.skipWaiting();
});

async function appFetch(request, path) {
  try {
    const response = await fetch(request);
    if (appResponse(response, path)) {
      await (await caches.open(APP_CACHE)).put(appKey(path), response.clone());
      return response;
    }
    if (response.status >= 400) {
      const saved = await cachedApp(path);
      if (saved) return saved;
    }
    return response;
  } catch (_) {
    const saved = await cachedApp(path);
    if (saved) return saved;
    if (request.mode === 'navigate') {
      return await (await caches.open(PUBLIC_CACHE)).match(absolute(OFFLINE_PATH)) || new Response('Conecte-se à internet para preparar o PeraGym gratuito para uso offline.', {status: 503, headers: {'Content-Type': 'text/plain; charset=utf-8'}});
    }
    return new Response('Arquivo ainda indisponível offline.', {status: 503, headers: {'Content-Type': 'text/plain; charset=utf-8'}});
  }
}

async function publicFetch(request, path) {
  const cache = await caches.open(PUBLIC_CACHE);
  try {
    const response = await fetch(request);
    if (publicResponse(response)) await cache.put(absolute(path), response.clone());
    return response;
  } catch (_) {
    const saved = await cache.match(absolute(path));
    if (saved) return saved;
    if (request.mode === 'navigate') return await cache.match(absolute(OFFLINE_PATH)) || new Response('Você está offline.', {status: 503});
    return new Response('Sem conexão.', {status: 503});
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Authorization callbacks must never be written to offline caches.
  if (url.searchParams.has('state') && (url.searchParams.has('code') || url.searchParams.has('error'))) return;
  // Donation APIs, administration and sign-in always go directly to the server.
  if (url.pathname.startsWith('/api/') || url.pathname === '/admin' || url.pathname.startsWith('/admin/') || url.pathname.startsWith('/signin-') || url.pathname.startsWith('/signout-') || url.pathname === '/callback') return;
  if (APP_PATHS.has(url.pathname)) {
    event.respondWith(appFetch(request, url.pathname));
    return;
  }
  if (PUBLIC_PATHS.has(url.pathname)) event.respondWith(publicFetch(request, url.pathname));
});
