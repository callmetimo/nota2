const SHELL_CACHE = 'nota-shell-v2';
const DATA_CACHE  = 'nota-data-v1';
const CDN_CACHE   = 'nota-cdn-v1';

// Core app files cached on install
const SHELL_FILES = ['./index.html', './icon.png'];

// These are live API calls — never intercept them
const BYPASS_HOSTS = [
  'script.google.com',
  'frankfurter.app',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

// ── Install: pre-cache shell ──────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(c => c.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

// ── Activate: remove stale caches ────────────────────────────
self.addEventListener('activate', e => {
  const keep = [SHELL_CACHE, DATA_CACHE, CDN_CACHE];
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !keep.includes(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: per-resource strategy ─────────────────────────────
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Always bypass API and font calls
  if (BYPASS_HOSTS.some(h => url.includes(h))) return;

  // data.json — stale-while-revalidate (instant load, updates in background)
  if (url.includes('data.json')) {
    e.respondWith(staleWhileRevalidate(DATA_CACHE, e.request));
    return;
  }

  // Chart.js CDN — cache-first (immutable versioned URL)
  if (url.includes('cdnjs.cloudflare.com')) {
    e.respondWith(cacheFirst(CDN_CACHE, e.request));
    return;
  }

  // Shell (index.html, icon.png) — network-first, fall back to cache
  e.respondWith(networkFirst(SHELL_CACHE, e.request));
});

// ── Strategies ────────────────────────────────────────────────

async function networkFirst(cacheName, request) {
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function cacheFirst(cacheName, request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(cacheName, request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  // Kick off background refresh regardless of cache hit
  const fetchPromise = fetch(request).then(res => {
    if (res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  // Return cached immediately if available, otherwise wait for network
  return cached || await fetchPromise
    || new Response('{}', { headers: { 'Content-Type': 'application/json' } });
}
