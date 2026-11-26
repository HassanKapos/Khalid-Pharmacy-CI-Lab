/**
 * Khalid Pharmacy Production-Ready Offline Service Worker (v3 - Optimized for Slow Networks)
 * Supports both Vite Development Mode and Production Dist Builds
 * Strategy: Cache-First for Hashed Assets + Stale-While-Revalidate for Shell + Safe API Offline Fallbacks
 */

const CACHE_NAME = 'khalid-pharmacy-shell-v8';
const OCR_CACHE_NAME = 'khalid-pharmacy-ocr-v2';
const OCR_ASSET_URLS = [
  '/tesseract/tesseract.esm.min.js',
  '/tesseract/worker.min.js',
  '/tesseract/core/tesseract-core.wasm.js',
  '/tesseract/core/tesseract-core-simd.wasm.js',
  '/tesseract/core/tesseract-core-lstm.wasm.js',
  '/tesseract/core/tesseract-core-simd-lstm.wasm.js',
  '/tesseract/core/tesseract-core.wasm',
  '/tesseract/core/tesseract-core-simd.wasm',
  '/tesseract/core/tesseract-core-lstm.wasm',
  '/tesseract/core/tesseract-core-simd-lstm.wasm',
  '/tesseract/lang/eng.traineddata.gz'
];

// Core fixed assets required for offline startup
const CORE_PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/bankak-worker.js',
  '/icon.svg',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/pwa-maskable-512x512.png',
  '/apple-touch-icon.png'
];

// Fallback dev assets (when running Vite dev server)
const DEV_FALLBACK_URLS = [
  '/src/main.ts',
  '/src/index.css'
];

// Helper to determine if an asset is immutable (contains hash in /assets/)
function isImmutableAsset(url) {
  return url.pathname.startsWith('/assets/') && /[.-][a-zA-Z0-9_-]{8,}\.(js|css|svg|png|jpg|woff2?)$/.test(url.pathname);
}

// Install: Precache App Shell and dynamically discover production bundle chunks
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // 1. Precache core fixed App Shell files
      const corePromises = CORE_PRECACHE_URLS.map((url) =>
        cache.add(url).catch((err) => {
          console.warn(`[SW] Precache skipped for core URL: ${url}`, err.message);
        })
      );
      await Promise.allSettled(corePromises);

      // 2. Prepare the independent local OCR runtime cache. OCR readiness is
      // reported only when every same-origin worker/core/language asset exists.
      let ocrReady = false;
      try {
        const ocrCache = await caches.open(OCR_CACHE_NAME);
        const ocrResults = await Promise.all(OCR_ASSET_URLS.map(async (url) => {
          const response = await fetch(url, { cache: 'no-cache' });
          const contentType = (response.headers.get('content-type') || '').toLowerCase();
          if (!response.ok || contentType.includes('text/html') || new URL(response.url).origin !== self.location.origin) {
            throw new Error(`Invalid local OCR asset: ${url}`);
          }
          await ocrCache.put(url, response.clone());
          return true;
        }));
        ocrReady = ocrResults.length === OCR_ASSET_URLS.length && ocrResults.every(Boolean);
      } catch (ocrError) {
        await caches.delete(OCR_CACHE_NAME);
        console.warn('[SW] Local OCR assets are not fully prepared:', ocrError.message);
      }

      // 3. Discover actual production or dev bundle scripts & stylesheets referenced in index.html
      try {
        const indexResponse = await fetch('/index.html', { cache: 'no-cache' });
        if (indexResponse && indexResponse.status === 200) {
          const htmlText = await indexResponse.text();

          // Extract all <script src="...">
          const scriptRegex = /<script[^>]+src=["']([^"']+)["']/g;
          // Extract all <link rel="stylesheet" href="...">
          const linkRegex = /<link[^>]+href=["']([^"']+\.css[^"']*)["']/g;

          const discovered = new Set();
          let match;

          while ((match = scriptRegex.exec(htmlText)) !== null) {
            const src = match[1];
            if (src && !src.startsWith('http://') && !src.startsWith('https://')) {
              discovered.add(src);
            }
          }

          while ((match = linkRegex.exec(htmlText)) !== null) {
            const href = match[1];
            if (href && !href.startsWith('http://') && !href.startsWith('https://')) {
              discovered.add(href);
            }
          }

          // Precache first-level bundles
          for (const url of discovered) {
            try {
              const res = await fetch(url, { cache: 'no-cache' });
              if (res && res.status === 200) {
                await cache.put(url, res.clone());
                // If it's a JS bundle, discover dynamic chunk imports like import("./vendor-vue-xxx.js")
                if (url.endsWith('.js')) {
                  const jsText = await res.text();
                  const chunkRegex = /(?:\/assets\/[a-zA-Z0-9_\-\.]+\.js)/g;
                  let chunkMatch;
                  while ((chunkMatch = chunkRegex.exec(jsText)) !== null) {
                    const chunkPath = chunkMatch[0];
                    if (!discovered.has(chunkPath)) {
                      discovered.add(chunkPath);
                      cache.add(chunkPath).catch(() => {});
                    }
                  }
                }
              }
            } catch (bundleErr) {
              console.warn(`[SW] Bundle fetch skipped for ${url}:`, bundleErr.message);
            }
          }

          // Also add dev fallbacks if in dev mode
          for (const devUrl of DEV_FALLBACK_URLS) {
            cache.add(devUrl).catch(() => {});
          }
        }
      } catch (err) {
        console.warn('[SW] Bundle auto-discovery warning:', err);
      }

      console.log('[SW] App Shell Precaching fully completed.');

      // Notify open windows that offline storage is ready
      const allClients = await self.clients.matchAll({ includeUncontrolled: true });
      allClients.forEach((client) => {
        client.postMessage({ type: 'OFFLINE_READY', ready: true, ocrReady });
      });
    })
  );
});

// Activate: Clean up older cache versions without touching IndexedDB or local storage
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      await Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key !== OCR_CACHE_NAME && key.startsWith('khalid-pharmacy-')) {
            console.log('[SW] Purging outdated cache version:', key);
            return caches.delete(key);
          }
        })
      );
      await self.clients.claim();
      console.log('[SW] Service Worker claimed clients. Active & controlling.');
    })
  );
});

// Fetch: Intercept all requests
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept non-GET uploads/mutations or Google API / OAuth traffic.
  if (
    request.method !== 'GET' ||
    url.hostname === 'googleapis.com' ||
    url.hostname.endsWith('.googleapis.com') ||
    url.hostname === 'accounts.google.com' ||
    url.hostname.endsWith('.google.com')
  ) {
    return;
  }

  // 0. Tesseract runtime: cache-first in a dedicated cache, same-origin only.
  if (url.origin === self.location.origin && url.pathname.startsWith('/tesseract/')) {
    event.respondWith(
      caches.open(OCR_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) {
          const cachedType = (cached.headers.get('content-type') || '').toLowerCase();
          if (!cachedType.includes('text/html')) return cached;
          await cache.delete(request);
        }
        try {
          const response = await fetch(request);
          const contentType = (response.headers.get('content-type') || '').toLowerCase();
          if (response.ok && !contentType.includes('text/html')) {
            await cache.put(request, response.clone());
          }
          return response;
        } catch {
          return new Response('', { status: 404, statusText: 'OCR asset unavailable offline' });
        }
      })
    );
    return;
  }

  // 1. Backend API requests: Network-first with graceful offline JSON fallback
  // NEVER block UI on API or external services
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => {
        return new Response(
          JSON.stringify({
            success: false,
            offline: true,
            receipts: [],
            message: 'النظام يعمل دون اتصال بالإنترنت حالياً (IndexedDB Active)'
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      })
    );
    return;
  }

  // 2. Navigation requests (Page reload, Cold restart, home screen launch)
  // Network-First with Offline Cache Fallback: ensures latest updates are served when connected
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const resClone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put('/index.html', resClone);
              cache.put('/', networkRes);
            });
          }
          return networkRes;
        })
        .catch(() => {
          // Network offline: safely use cached App Shell
          return caches.match('/index.html').then((cached) => cached || caches.match('/'));
        })
    );
    return;
  }

  // 3. Vite dev server modules: Network-First so .env & code updates apply immediately
  if (
    url.origin === self.location.origin &&
    (url.pathname.startsWith('/src/') ||
      url.pathname.startsWith('/@vite/') ||
      url.pathname.startsWith('/@fs/') ||
      url.pathname.startsWith('/@id/') ||
      url.pathname.startsWith('/node_modules/'))
  ) {
    event.respondWith(
      fetch(request, { cache: 'no-cache' })
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200 && request.method === 'GET') {
            const resClone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, resClone);
            });
          }
          return networkRes;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // 4. Static Assets: Production bundles (/assets/*), JS, CSS, Fonts, Images, Workers
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      // For immutable hashed assets in /assets/, return directly from cache (zero network delay)
      if (cachedResponse) {
        if (!isImmutableAsset(url) && request.method === 'GET') {
          // Only revalidate non-immutable assets in background
          fetch(request, { cache: 'no-cache' })
            .then((networkRes) => {
              if (networkRes && networkRes.status === 200) {
                caches.open(CACHE_NAME).then((cache) => {
                  cache.put(request, networkRes);
                });
              }
            })
            .catch(() => {});
        }
        return cachedResponse;
      }

      // Not in cache: fetch and cache for subsequent offline sessions
      return fetch(request)
        .then((networkRes) => {
          if (
            networkRes &&
            networkRes.status === 200 &&
            request.method === 'GET' &&
            (url.origin === self.location.origin ||
              url.hostname.includes('fonts.googleapis.com') ||
              url.hostname.includes('fonts.gstatic.com'))
          ) {
            const resClone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, resClone);
            });
          }
          return networkRes;
        })
        .catch(() => {
          return new Response('', { status: 404, statusText: 'Offline asset not found' });
        });
    })
  );
});

// Communication with frontend UI
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (event.data?.type === 'CHECK_OFFLINE_READY') {
    Promise.all([caches.has(CACHE_NAME), caches.open(OCR_CACHE_NAME).then(async (cache) => {
      const keys = await cache.keys();
      return OCR_ASSET_URLS.every((url) => keys.some((request) => new URL(request.url).pathname === url));
    })]).then(([shellReady, ocrReady]) => {
      event.source?.postMessage({ type: 'OFFLINE_READY', ready: shellReady, ocrReady });
    });
  }
});
