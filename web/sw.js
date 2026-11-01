// service worker
//  - 모든 같은 출처 응답에 COOP/COEP 헤더를 붙인다 (SharedArrayBuffer 사용 조건)
//  - Godot 엔진 파일(약 100MB)은 버전별로 캐시해서 다음 방문을 빠르게 한다
//  - 앱 파일(html/js/css)은 항상 네트워크를 먼저 확인한다 (업데이트 즉시 반영)
//  - 다른 출처 요청(api.github.com 등)에는 관여하지 않는다
const BUILD_ID = '__BUILD_ID__';
const ENGINE_CACHE = `gwe-engine-${BUILD_ID}`;
const APP_CACHE = 'gwe-app';
const ENGINE_FILES = ['godot.editor.js', 'godot.editor.wasm', 'godot.editor.audio.worklet.js', 'godot.editor.audio.position.worklet.js'];

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('gwe-engine-') && k !== ENGINE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function withIsolation(response) {
  if (!response || response.status === 0 || response.type === 'opaque') return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  const name = url.pathname.split('/').pop();
  if (ENGINE_FILES.includes(name)) {
    event.respondWith(
      caches.open(ENGINE_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return withIsolation(cached);
        const res = await fetch(event.request);
        if (res.ok) cache.put(event.request, res.clone());
        return withIsolation(res);
      }),
    );
    return;
  }
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(event.request, { cache: 'no-cache' });
        if (res.ok) (await caches.open(APP_CACHE)).put(event.request, res.clone());
        return withIsolation(res);
      } catch (e) {
        const cached = await caches.match(event.request);
        if (cached) return withIsolation(cached);
        throw e;
      }
    })(),
  );
});
