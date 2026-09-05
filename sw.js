// SPDX-License-Identifier: GPL-3.0-or-later
// Offline support.
//
// The app is entirely static and has no backend, so the whole shell is
// precached and answered from the cache: that is what makes it work offline and
// what makes it open instantly.
//
// It used to stop there, and that was a mistake with a twenty-release tail. The
// cache is keyed by VERSION, and a browser only reinstalls a worker whose file
// has changed, so a release that touched no module -- five of the last seven --
// left both the worker and the cache untouched, and anyone who had the app
// installed went on being served the shell they first cached. Nothing said so.
//
// So there are two defences now, because either alone has a hole in it. VERSION
// tracks the app and is checked against src/version.js by the test suite, so a
// forgotten bump fails the build rather than the user. And a cached answer is
// refreshed in the background after it is served, so even a worker that never
// changes cannot serve last month's app twice.

const VERSION = 'v0.47.1';
const CACHE = `braille-art-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './src/main.js',
  './src/version.js',
  './src/core/adjust.js',
  './src/core/blur.js',
  './src/core/colour.js',
  './src/core/bluenoise.js',
  './src/core/braille.js',
  './src/core/classify.js',
  './src/core/score.js',
  './src/core/variants.js',
  './src/core/dither.js',
  './src/core/edges.js',
  './src/core/gamma.js',
  './src/core/glyphs.js',
  './src/i18n/en.js',
  './src/i18n/index.js',
  './src/i18n/ru.js',
  './src/core/otsu.js',
  './src/core/palette.js',
  './src/core/pixels.js',
  './src/core/presets.js',
  './src/core/sample.js',
  './src/ui/camera.js',
  './src/ui/canvas.js',
  './src/ui/draw.js',
  './src/ui/controls.js',
  './src/ui/crop.js',
  './src/ui/export.js',
  './src/ui/lattice.js',
  './src/ui/link.js',
  './src/ui/pace.js',
  './src/ui/pipeline.js',
  './src/ui/platforms.js',
  './src/ui/settings.js',
  './src/ui/store.js',
  './src/worker/pipeline.worker.js',
  './src/worker/protocol.js',
  './src/ui/dots.js',
  './src/ui/text.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

/**
 * Answer from the cache, then quietly replace what was answered.
 *
 * The page still gets the cached copy immediately, so opening offline and
 * opening instantly both survive. What changes is that the copy is not kept
 * forever: a fresh one is fetched afterwards and stored for next time.
 *
 * A whole page load is served from whatever the cache held when it began, so
 * the modules on any single load are a matching set; the new ones take effect
 * on the following visit.
 */
function refresh(request, cache) {
  return fetch(request)
    .then((response) => {
      // Only a real, complete, same-origin answer is worth keeping. An error
      // page or an opaque cross-origin response would poison the shell.
      if (response.ok && response.type === 'basic') cache.put(request, response.clone());
      return response;
    })
    // Offline is the ordinary case here, not a failure worth reporting.
    .catch(() => null);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only same-origin reads are ours to answer. Anything else -- another origin,
  // a POST -- goes to the network untouched.
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) {
        // Not awaited: the point is that the page does not wait for it.
        event.waitUntil(refresh(request, cache));
        return cached;
      }
      return (await refresh(request, cache)) ?? fetch(request);
    }),
  );
});
