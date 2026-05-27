const CACHE = 'kakarta-v3';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.json', './icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // выкидываем ВЕСЬ старый кэш (чтобы не отдавать прошлый билд)
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
    // принудительно перезагружаем уже открытые вкладки на свежий код —
    // спасает «залипших» на старой версии (в т.ч. белый экран)
    const cls = await self.clients.matchAll({ type: 'window' });
    cls.forEach(c => { try { c.navigate(c.url); } catch (e) {} });
  })());
});

// Свой домен — network-first (всегда свежее онлайн, кеш — только запасной офлайн-вариант).
// Чужие домены (Supabase-прокси, тайлы) не трогаем.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
