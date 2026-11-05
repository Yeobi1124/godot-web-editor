// service worker
//  - 모든 같은 출처 응답에 COOP/COEP 헤더를 붙인다 (SharedArrayBuffer 사용 조건)
//  - Godot 엔진 파일(약 100MB)은 버전별로 캐시해서 다음 방문을 빠르게 한다
//  - 클라우드 버전은 엔진 wasm이 조각(engine/godot.editor.N.wasm)으로 올라가 있다. 조각을 한꺼번에 받아 순서대로 이어 붙인다
//    (Worker가 이어 붙여 보내는 /godot.editor.wasm 경로는 서비스 워커가 아직 없을 때만 쓰는 예비 경로)
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
const WRITE_WAIT_MS = 90000; // 진행 중인 캐시 쓰기를 기다리는 최대 시간 (멈춘 다운로드를 무한정 기다리지 않게)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 클라우드 빌드면 조각들을 순서대로 받아 하나의 응답으로, 아니면(조각 목록 없음) 원래 요청 그대로 */
async function fetchEngineWasm(request) {
  const base = new URL('engine/', self.registration.scope);
  let manifest = null;
  try {
    const m = await fetch(new URL('wasm-manifest.json', base), { cache: 'no-cache' });
    if (m.ok) manifest = await m.json();
  } catch {
    /* 조각 목록 없음 → 한 파일로 배포된 빌드 */
  }
  if (!manifest?.parts?.length) return fetch(request);
  // 조각을 한꺼번에 요청해 회선을 다 쓰고, 이어 붙이는 것만 순서대로 한다
  const responses = manifest.parts.map((part) =>
    fetch(new URL(part, base)).then((res) => {
      if (!res.ok || !res.body) throw new Error(`엔진 조각을 받지 못했습니다: ${part} (${res.status})`);
      return res;
    }),
  );
  responses.forEach((p) => p.catch(() => {})); // 앞 조각에서 실패하면 뒤 조각의 거부는 무시
  let index = 0;
  let reader = null;
  const body = new ReadableStream({
    async pull(controller) {
      for (;;) {
        if (!reader) {
          if (index >= responses.length) {
            controller.close();
            return;
          }
          reader = (await responses[index++]).body.getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          reader = null;
          continue;
        }
        controller.enqueue(value);
        return;
      }
    },
    cancel(reason) {
      reader?.cancel(reason);
      for (const p of responses.slice(index)) p.then((r) => r.body.cancel(reason)).catch(() => {});
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/wasm', 'Content-Length': String(manifest.size), ETag: `"${manifest.sha256}"` },
  });
}

async function engineResponse(request) {
  const cache = await caches.open(ENGINE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const pending = engineWrites.get(request.url);
  if (pending) {
    await Promise.race([pending.catch(() => {}), sleep(WRITE_WAIT_MS)]);
    const done = await cache.match(request);
    if (done) return done;
  }
  const name = new URL(request.url).pathname.split('/').pop();
  const res = name === 'godot.editor.wasm' ? await fetchEngineWasm(request) : await fetch(request);
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
