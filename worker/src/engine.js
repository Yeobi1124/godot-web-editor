// GET /godot.editor.wasm → 조각 파일들을 이어 붙여 한 파일처럼 보낸다.
// Workers 정적 파일은 파일당 25MiB 제한이 있어서 약 100MB인 엔진을 scripts/build-worker.sh가 나눠 둔다.
import { error } from './http.js';

export async function engineWasm(req, env, ctx) {
  const base = new URL(req.url);
  const manifestRes = await env.ASSETS.fetch(new URL('/engine/wasm-manifest.json', base));
  if (!manifestRes.ok) return error(500, '엔진 파일 목록(wasm-manifest.json)이 없습니다');
  const manifest = await manifestRes.json();
  const etag = `"${manifest.sha256}"`;
  const headers = {
    'Content-Type': 'application/wasm',
    ETag: etag,
    'Cache-Control': 'public, max-age=3600',
  };
  if (req.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers });
  if (req.method === 'HEAD') return new Response(null, { headers: { ...headers, 'Content-Length': String(manifest.size) } });

  const { readable, writable } = new FixedLengthStream(manifest.size);
  ctx.waitUntil(
    (async () => {
      try {
        for (const part of manifest.parts) {
          const res = await env.ASSETS.fetch(new URL(`/engine/${part}`, base));
          if (!res.ok) throw new Error(`${part}: ${res.status}`);
          await res.body.pipeTo(writable, { preventClose: true });
        }
        await writable.close();
      } catch (e) {
        await writable.abort(e);
      }
    })(),
  );
  return new Response(readable, { headers });
}
