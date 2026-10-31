'use strict';

// Only the server can authorize the first download. Workouts stay in IndexedDB.
const VERSION = 'peragym-2.0.0';
const PUBLIC_CACHE = `${VERSION}-public`;
const APP_CACHE = `${VERSION}-app`;
const PUBLIC_PREFIX = 'peragym-';
const APP_SUFFIX = '-app';
const PUBLIC_PATHS = new Set([
  '/', '/index.html', '/promo.css', '/promo.js', '/pwa.js', '/pwa.css',
  '/offline.html', '/manifest.webmanifest', '/icons/icon-192.png',
  '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png'
]);
const APP_PATHS = new Set([
  '/app/', '/app/index.html', '/app/style.css', '/app/app.js', '/app/db.js', '/app/charts.js'
]);
const OFFLINE_PATH = '/offline.html';
let preparingOffline;

const absolute = path => new URL(path, self.location.origin).href;
const appKey = path => absolute(path === '/app/' ? '/app/index.html' : path);
const protectedResponse = response => response.status === 200 && !response.redirected && response.headers.get('X-PeraGym-Protected') === '1';
const publicResponse = response => response.status === 200 && !response.redirected && response.headers.get('X-PeraGym-Protected') !== '1';

async function eraseAppCaches() {
  const names = await caches.keys();
  await Promise.all(names.filter(name => name.startsWith(PUBLIC_PREFIX) && name.endsWith(APP_SUFFIX)).map(name => caches.delete(name)));
}

async function tellClients(message, client) {
  if (client && typeof client.postMessage === 'function') {
    client.postMessage(message);
    return;
  }
  const clients = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
  clients.forEach(item => item.postMessage(message));
}

async function cachedApp(path) {
  const names = await caches.keys();
  const versions = [APP_CACHE, ...names.filter(name => name.startsWith(PUBLIC_PREFIX) && name.endsWith(APP_SUFFIX) && name !== APP_CACHE).reverse()];
  for (const name of versions) {
    if (!names.includes(name)) continue;
    const response = await (await caches.open(name)).match(appKey(path));
    if (response && protectedResponse(response)) return response;
  }
}

async function hasCurrentShell() {
  const cache = await caches.open(APP_CACHE);
  for (const path of APP_PATHS) {
    const response = await cache.match(appKey(path));
    if (!response || !protectedResponse(response)) return false;
  }
  return true;
}

async function warmProtectedShell(client) {
  // A postMessage, a local flag, or an order status supplied by a browser is
  // never sufficient to fetch the paid shell. Recheck the HttpOnly-cookie session.
  let session;
  try {
    const response = await fetch(absolute('/api/session'), {credentials: 'same-origin', cache: 'no-store'});
    if (response.status === 401 || response.status === 403) {
      await eraseAppCaches();
      await tellClients({type: 'PERAGYM_LICENSE_REQUIRED'}, client);
      return;
    }
    if (!response.ok) return;
    session = await response.json();
  } catch (_) {
    if (await hasCurrentShell()) await tellClients({type: 'PERAGYM_OFFLINE_READY'}, client);
    return;
  }
  if (session.licensed !== true) {
    await eraseAppCaches();
    await tellClients({type: 'PERAGYM_LICENSE_REQUIRED'}, client);
    return;
  }
  const cache = await caches.open(APP_CACHE);
  const paths = [...APP_PATHS].filter(path => path !== '/app/');
  let authorizationLost = false;
  const results = await Promise.allSettled(paths.map(async path => {
    const response = await fetch(absolute(path), {credentials: 'same-origin', cache: 'no-store'});
    if (response.status === 401 || response.status === 403 || response.redirected) authorizationLost = true;
    if (!protectedResponse(response)) throw new Error('Protected application asset was not authorized.');
    await cache.put(appKey(path), response);
  }));
  if (authorizationLost) {
    await eraseAppCaches();
    await tellClients({type: 'PERAGYM_LICENSE_REQUIRED'}, client);
    return;
  }
  if (results.every(result => result.status === 'fulfilled') && await hasCurrentShell()) {
    // Only remove a previous offline shell once its complete replacement exists.
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(PUBLIC_PREFIX) && name.endsWith(APP_SUFFIX) && name !== APP_CACHE).map(name => caches.delete(name)));
    await tellClients({type: 'PERAGYM_OFFLINE_READY'}, client);
  }
}

function prepareOffline(client) {
  if (!preparingOffline) preparingOffline = warmProtectedShell(client).finally(() => {preparingOffline = undefined;});
  return preparingOffline;
}

self.addEventListener('install', event => {
  // Public presentation assets contain no app, payment state, or administrative data.
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
    await Promise.all(names.filter(name => name.startsWith(PUBLIC_PREFIX) && name.endsWith('-public') && name !== PUBLIC_CACHE).map(name => caches.delete(name)));
    await self.clients.claim();
    // Never remove IndexedDB: it belongs to the person using this device.
  })());
});

self.addEventListener('message', event => {
  const client = event.source;
  if (!client || !client.url || new URL(client.url).origin !== self.location.origin) return;
  if (event.data?.type === 'PERAGYM_PREPARE_OFFLINE' || event.data?.type === 'PERAGYM_LICENSE_READY') {
    event.waitUntil(prepareOffline(client));
  }
  if (event.data?.type === 'PERAGYM_CLEAR_OFFLINE') {
    event.waitUntil(eraseAppCaches());
  }
  if (event.data?.type === 'PERAGYM_SKIP_WAITING') self.skipWaiting();
});

async function protectedFetch(request, path) {
  try {
    const response = await fetch(request);
    if (response.status === 401 || response.status === 403 || response.redirected) {
      await eraseAppCaches();
      await tellClients({type: 'PERAGYM_LICENSE_REQUIRED'});
      return response;
    }
    if (protectedResponse(response)) {
      await (await caches.open(APP_CACHE)).put(appKey(path), response.clone());
      return response;
    }
    if (response.status >= 500) {
      const saved = await cachedApp(path);
      if (saved) return saved;
    }
    return response;
  } catch (_) {
    const saved = await cachedApp(path);
    if (saved) return saved;
    if (request.mode === 'navigate') {
      return await (await caches.open(PUBLIC_CACHE)).match(absolute(OFFLINE_PATH)) || new Response('Conecte-se à internet para abrir o PeraGym pela primeira vez.', {status: 503, headers: {'Content-Type': 'text/plain; charset=utf-8'}});
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
  // APIs, Pix, customer tokens, admin and sign-in always go to the server.
  if (url.pathname.startsWith('/api/') || url.pathname === '/admin' || url.pathname.startsWith('/admin/') || url.pathname.startsWith('/signin-') || url.pathname.startsWith('/signout-') || url.pathname === '/callback') return;
  if (APP_PATHS.has(url.pathname)) {
    event.respondWith(protectedFetch(request, url.pathname));
    return;
  }
  if (PUBLIC_PATHS.has(url.pathname)) event.respondWith(publicFetch(request, url.pathname));
});
