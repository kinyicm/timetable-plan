// 课表规划 · Service Worker
// 只做静态资源缓存：预缓存首页与图标，其余 GET 网络优先、失败回退缓存。
// 不做后台同步、不做推送。

const CACHE_NAME = "timetable-plan-v1";
const PRECACHE_URLS = [
  "/",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/favicon-32.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // 只处理同源请求
  if (url.origin !== self.location.origin) return;

  // 请求路径以 /api/ 开头：直接走网络，绝不缓存
  if (url.pathname.startsWith("/api/")) return;

  // 其余 GET：先网络，失败后回退缓存
  event.respondWith(
    fetch(request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => cached || caches.match("/")),
      ),
  );
});
