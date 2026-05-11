/**
 * Price Checker — Service Worker
 * Provides offline caching and background sync support.
 */

const CACHE_NAME = 'price-checker-v1';
const STATIC_CACHE = 'price-checker-static-v1';

// Resources to pre-cache on install
const PRECACHE_URLS = [
    '/',
    '/products',
    '/lists',
    '/settings',
    '/static/style.css',
    '/static/app.js',
    '/manifest.json',
];

// API endpoints to cache for offline use
const API_CACHE_PATHS = [
    '/api/products',
    '/api/lists',
    '/api/stats',
];

// ─── Install ────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then((cache) => cache.addAll(PRECACHE_URLS))
            .then(() => self.skipWaiting())
    );
});

// ─── Activate ───────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => {
                        return name !== STATIC_CACHE && name !== CACHE_NAME;
                    })
                    .map((name) => caches.delete(name))
            );
        }).then(() => self.clients.claim())
    );
});

// ─── Fetch ──────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Handle API requests specially
    if (url.pathname.startsWith('/api/')) {
        // For scan/lookup requests, try network first, then cache
        if (url.pathname === '/api/scan') {
            event.respondWith(networkFirstWithCache(request, url));
            return;
        }

        // For GET list/data requests, cache them
        if (request.method === 'GET') {
            event.respondWith(networkFirstCache(request, url));
            return;
        }

        // For POST/PUT/DELETE, network only (no caching mutations)
        event.respondWith(networkOnly(request));
        return;
    }

    // Static assets: cache-first (fastest)
    if (url.pathname.startsWith('/static/') ||
        url.pathname === '/manifest.json' ||
        url.pathname === '/sw.js') {
        event.respondWith(cacheFirst(request));
        return;
    }

    // Pages: network-first (fresh content, fallback to cache)
    event.respondWith(networkFirst(request));
});

// ─── Caching Strategies ─────────────────────────────────────────────────────

/**
 * Cache-first: serve from cache, fall back to network.
 */
async function cacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) return cached;

    try {
        const response = await fetch(request);
        if (response && response.status === 200) {
            const cache = await caches.open(STATIC_CACHE);
            cache.put(request, response.clone());
        }
        return response;
    } catch (error) {
        return new Response('Offline', { status: 503 });
    }
}

/**
 * Network-first: try network, fall back to cache.
 */
async function networkFirst(request) {
    try {
        const response = await fetch(request);
        if (response && response.status === 200) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
        }
        return response;
    } catch (error) {
        const cached = await caches.match(request);
        if (cached) return cached;
        return new Response('Offline', { status: 503 });
    }
}

/**
 * Network-first for cacheable data endpoints.
 */
async function networkFirstCache(request, url) {
    try {
        const response = await fetch(request);
        if (response && response.status === 200) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
        }
        return response;
    } catch (error) {
        const cached = await caches.match(request);
        if (cached) return cached;

        // For specific API endpoints, try to match with query params stripped
        const strippedUrl = new URL(url);
        strippedUrl.search = '';
        const genericCached = await caches.match(new Request(strippedUrl));
        if (genericCached) return genericCached;

        return new Response(JSON.stringify({ error: 'offline' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * Network-first with cache for POST scan requests.
 * Sends the request normally, caches the response for offline lookup.
 */
async function networkFirstWithCache(request, url) {
    try {
        const response = await fetch(request.clone());
        if (response && response.status === 200) {
            const clone = response.clone();
            // Cache the response keyed by the barcode for offline lookup
            const body = await request.clone().json();
            if (body && body.barcode) {
                const cacheUrl = `/api/scan/${body.barcode}`;
                const cache = await caches.open(CACHE_NAME);
                cache.put(cacheUrl, clone);
            }
        }
        return response;
    } catch (error) {
        // Try to find cached scan result
        try {
            const body = await request.clone().json();
            if (body && body.barcode) {
                const cacheUrl = `/api/scan/${body.barcode}`;
                const cached = await caches.match(cacheUrl);
                if (cached) return cached;
            }
        } catch (e) { /* ignore */ }
        return new Response(JSON.stringify({
            found: false,
            barcode: '',
            message: 'Network unavailable. Please try again when connected.'
        }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * Network only — no caching for mutations.
 */
async function networkOnly(request) {
    try {
        return await fetch(request);
    } catch (error) {
        return new Response(JSON.stringify({ error: 'Network unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

// ─── Background Sync (for offline scans) ─────────────────────────────────────
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-scans') {
        event.waitUntil(syncScans());
    }
});

async function syncScans() {
    // Background sync for queued scan data
    try {
        const cache = await caches.open('scan-queue');
        const requests = await cache.keys();
        for (const request of requests) {
            try {
                await fetch(request);
                await cache.delete(request);
            } catch (e) {
                console.error('Sync failed for:', request.url, e);
            }
        }
        return true;
    } catch (error) {
        console.error('Sync error:', error);
        return false;
    }
}
