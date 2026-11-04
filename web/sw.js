// service worker
//  - 모든 같은 출처 응답에 COOP/COEP 헤더를 붙인다 (SharedArrayBuffer 사용 조건)
//  - Godot 엔진 파일(약 100MB)은 버전별로 캐시해서 다음 방문을 빠르게 한다
//  - 앱 파일(html/js/css)은 항상 네트워크를 먼저 확인한다 (업데이트 즉시 반영)
//  - 다른 출처 요청(api.github.com 등)과 클라우드 Worker의 동적 경로(/auth, /api, /gh)에는 관여하지 않는다
//    (로그인 리다이렉트를 깨뜨리거나 GitHub 응답을 캐시에 남기지 않기 위함)
const BUILD_ID = '__BUILD_ID__';
const ENGINE_CACHE = `gwe-engine-${BUILD_ID}`;
const APP_CACHE = 'gwe-app';
const ENGINE_FILES = ['godot.editor.js', 'godot.editor.wasm', 'godot.editor.audio.worklet.js', 'godot.editor.audio.position.worklet.js'];
const DYNAMIC = /^\/(auth|api|gh)\//;

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

// 엔진 파일을 캐시에 쓰는 중인 요청 (url → cache.put 약속).
// 이전 페이지가 다운로드 도중 떠나도 캐시 쓰기는 계속되는데, 그때 새 페이지가 같은 파일을 또 받으면
// Godot 에디터 초기화가 멈추는 경우가 있어서(tests/e2e-cloud.mjs로 재현) 진행 중인 쓰기가 끝나길 기다렸다가 캐시에서 준다.
const engineWrites = new Map();

async function engineResponse(request) {
  const cache = await caches.open(ENGINE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const pending = engineWrites.get(request.url);
  if (pending) {
    await pending.catch(() => {});
    const done = await cache.match(request);
    if (done) return done;
  }
  const res = await fetch(request);
  if (res.ok) {
    const write = cache.put(request, res.clone());
    engineWrites.set(request.url, write);
    write.catch(() => {}).finally(() => engineWrites.delete(request.url));
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET' || DYNAMIC.test(url.pathname)) return;
  const name = url.pathname.split('/').pop();
  if (ENGINE_FILES.includes(name)) {
    event.respondWith(engineResponse(event.request).then(withIsolation));
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
