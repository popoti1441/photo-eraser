// 오프라인 캐시 + 갤러리 "공유"로 받은 사진 넘겨주기
const CACHE = 'eraser-v2';
const MODEL_CACHE = 'eraser-model-v1';
const ASSETS = [
  './', './index.html', './style.css', './app.js', './worker.js', './engine.js', './jpegmeta.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png',
  './vendor/ort.wasm.min.mjs', './vendor/ort-wasm-simd-threaded.mjs', './vendor/ort-wasm-simd-threaded.wasm',
];
const MODEL = './models/migan_pipeline_v2.onnx';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  const keep = [CACHE, MODEL_CACHE, 'share-inbox'];
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(handleShare(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // AI 모델(약 28MB)은 처음 쓸 때 한 번 받아서 계속 보관
  if (url.pathname.endsWith('.onnx')) {
    e.respondWith(caches.open(MODEL_CACHE).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  // 캐시를 먼저 보여주고 뒤에서 새 버전으로 갱신 (다음 실행 때 반영)
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const network = fetch(e.request, { cache: 'no-cache' })
        .then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; })
        .catch(() => cached);
      if (cached) { e.waitUntil(network); return cached; }
      return network;
    })
  );
});

async function handleShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('images').filter((f) => f && typeof f !== 'string').slice(0, 2);
    const inbox = await caches.open('share-inbox');
    for (const k of await inbox.keys()) await inbox.delete(k);
    let i = 0;
    for (const f of files) {
      await inbox.put(new Request(`./inbox/${i++}`), new Response(f, {
        headers: { 'content-type': f.type || 'image/jpeg', 'x-name': encodeURIComponent(f.name || '사진.jpg') },
      }));
    }
    return Response.redirect(`./?shared=${files.length}`, 303);
  } catch (err) {
    return Response.redirect('./', 303);
  }
}
