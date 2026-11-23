/* 電波がないときも開けるように、入口のファイルと Python（Pyodide）を端末に残しておく。
 * 入口のファイルはネットを先に見る（更新がすぐ届く）。Pyodide は版が固定なので端末の分を先に使う。
 * GitHub の API には触らない（データは loader.js が IndexedDB に残している）。 */
const SHELL = "writingapp-shell-v1";
const PYODIDE = "writingapp-pyodide-v0.26.4";
const SHELL_FILES = ["./", "index.html", "loader.js", "manifest.webmanifest",
  "assets/favicon.png", "assets/apple-touch-icon.png", "assets/icon-192.png", "assets/icon-512.png"];

self.addEventListener("install", ev => {
  ev.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", ev => {
  ev.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== SHELL && k !== PYODIDE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", ev => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== "GET") return;
  if (url.hostname === "cdn.jsdelivr.net" && url.pathname.startsWith("/pyodide/")) {
    ev.respondWith(caches.open(PYODIDE).then(async c => {
      const hit = await c.match(ev.request);
      if (hit) return hit;
      const res = await fetch(ev.request);
      if (res.ok) await c.put(ev.request, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin === self.location.origin) {
    ev.respondWith(fetch(ev.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(ev.request, copy)); }
      return res;
    }).catch(() => caches.match(ev.request, {ignoreSearch: true})));
  }
});
