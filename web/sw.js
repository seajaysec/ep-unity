/**
 * App-shell cache so ep-unity opens on a bench with no wifi.
 *
 * Same-origin GETs only — the cross-origin guard below means this can never
 * request or store anything from teenage.engineering, which is the same rule
 * the rest of the tool follows.
 */

const CACHE = 'ep-unity-shell-v1'

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './fonts.css',
  './app.js',
  './lib/catalog.js',
  './lib/tfw.js',
  './lib/midi.js',
  './lib/dfu.js',
  './lib/overlay.js',
  './lib/pak.js',
  './lib/te-pack.js',
  './lib/backup.js',
  './lib/demo.js',
  './lib/kotu.bundle.js',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // addAll is all-or-nothing; one 404 during development should not leave
      // the worker permanently uninstalled.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  event.respondWith(
    // Network-first so an edited file is picked up immediately during
    // development; the cache is the fallback when the network is gone.
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(CACHE).then((cache) => cache.put(request, copy))
        }
        return response
      })
      .catch(() =>
        caches.match(request).then((hit) => hit || caches.match('./index.html')),
      ),
  )
})
