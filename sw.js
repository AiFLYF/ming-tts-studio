/* Ming TTS Studio — offline shell cache.
 *
 * Scope of this worker: same-origin static assets only.
 * API traffic (/generate, /health, /uploads, ...) is never cached, so audio and
 * health state always come from the gateway.
 *
 * Bump VERSION together with assets/js/config.js and the ?v= strings in
 * index.html — old caches are dropped on activate.
 */
const VERSION = "1.0.7";
const CACHE = `ming-tts-studio-${VERSION}`;
const CACHE_PREFIX = "ming-tts-studio-";
const INDEX_URL = new URL("./index.html", self.location.href).href;
const SCOPE_PATH = new URL("./", self.location.href).pathname;
const NAV_TIMEOUT_MS = 8000;

const STATIC_EXT = /\.(?:css|js|mjs|svg|png|jpe?g|webp|ico|woff2?|ttf|wav|mp3|flac|webmanifest)$/i;

function isStaticUrl(rawUrl) {
  const url = new URL(rawUrl, self.location.href);
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.includes("/uploads/")) return false;
  if (url.pathname.endsWith("/health")) return false;
  return STATIC_EXT.test(url.pathname);
}

/** Read index.html and cache exactly the assets it references.
 *  Deriving the list from the document keeps the shell in sync with the ?v=
 *  query strings — no second list to forget. */
async function precacheShell(cache) {
  const indexResponse = await fetch(new Request(INDEX_URL, { cache: "reload" }));
  if (!indexResponse.ok) return;
  const html = await indexResponse.clone().text();
  await cache.put(INDEX_URL, indexResponse);

  const targets = new Set();
  const attribute = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = attribute.exec(html))) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("data:")) continue;
    if (/^(?:https?:)?\/\//i.test(raw)) continue;
    if (!isStaticUrl(raw)) continue;
    targets.add(new URL(raw, INDEX_URL).href);
  }

  await Promise.all(Array.from(targets).map(async url => {
    try {
      const response = await fetch(new Request(url, { cache: "reload" }));
      if (response.ok) await cache.put(url, response);
    } catch (error) {
      /* One missing icon must not abort the whole install. */
    }
  }));
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      await precacheShell(cache);
    } catch (error) {
      /* Index unreachable. Fall through to the check below. */
    }
    // Without a cached shell this worker would be worse than useless: activate
    // deletes the previous cache, so a failed update must NOT take over.
    if (!(await cache.match(INDEX_URL, { ignoreSearch: true }))) {
      throw new Error("precache failed: index.html is not cached");
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE)
        .map(key => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

/** Only the studio page itself counts as a shell navigation — /docs and any
 *  other route on the same origin must reach the network untouched. */
function isShellNavigation(request) {
  if (request.mode !== "navigate") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  return url.pathname === SCOPE_PATH || url.pathname === `${SCOPE_PATH}index.html`;
}

function offlineFallback() {
  return new Response(
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>离线 · Ming TTS Studio</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#080a0b;color:#e8f2e2;
font:15px/1.7 system-ui,"Segoe UI",sans-serif;text-align:center;padding:24px}
strong{display:block;font-size:17px;margin-bottom:6px;color:#d6f36a}</style></head>
<body><div><strong>当前处于离线状态</strong>重新联网后刷新页面即可继续使用。</div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 503 }
  );
}

self.addEventListener("fetch", event => {
  const { request } = event;

  if (request.mode === "navigate") {
    if (!isShellNavigation(request)) return;
    event.respondWith((async () => {
      try {
        const fresh = await Promise.race([
          fetch(request),
          new Promise((_, reject) => setTimeout(() => reject(new Error("nav timeout")), NAV_TIMEOUT_MS))
        ]);
        if (fresh.ok) {
          const cache = await caches.open(CACHE);
          cache.put(INDEX_URL, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (error) {
        const cached = await caches.match(INDEX_URL, { ignoreSearch: true });
        return cached || offlineFallback();
      }
    })());
    return;
  }

  if (request.method !== "GET" || !isStaticUrl(request.url)) return;
  // Range requests (media seeking) bypass the cache entirely: a 206 response
  // cannot be stored, and serving a cached 200 would break seeking.
  if (request.headers.has("range")) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    if (cached) {
      // Stale-while-revalidate: serve fast, refresh quietly.
      fetch(request)
        .then(response => {
          if (response.ok) return cache.put(request, response.clone());
        })
        .catch(() => {});
      return cached;
    }
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone()).catch(() => {});
    return response;
  })());
});
