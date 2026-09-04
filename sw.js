// SPDX-License-Identifier: GPL-3.0-or-later
// Offline support.
//
// The app is entirely static and has no backend, so there is nothing to keep
// fresh at runtime: the whole shell is precached and served from the cache.
// Updates arrive by changing VERSION, which makes a new cache and drops the
// old one on activation.

const VERSION = 'v0.6.0';
const CACHE = `braille-art-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './src/main.js',
  './src/core/adjust.js',
  './src/core/blur.js',
  './src/core/braille.js',
  './src/core/dither.js',
  './src/core/edges.js',
  './src/core/otsu.js',
  './src/core/pixels.js',
  './src/core/presets.js',
  './src/ui/canvas.js',
  './src/ui/controls.js',
  './src/ui/crop.js',
  './src/ui/export.js',
  './src/ui/pipeline.js',
  './src/ui/platforms.js',
  './src/ui/settings.js',
  './src/worker/pipeline.worker.js',
  './src/worker/protocol.js',
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

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only same-origin reads are ours to answer. Anything else -- another origin,
  // a POST -- goes to the network untouched.
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => cached ?? fetch(request)),
  );
});
