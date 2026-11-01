// 공용 유틸리티: 바이트/문자열 변환, git blob 해시, 경로 검사 등

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

export const utf8Encode = (text) => textEncoder.encode(text);
export const utf8Decode = (bytes) => textDecoder.decode(bytes);

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** git과 같은 방식의 blob 해시 (SHA-1 of "blob <size>\0<content>") */
export async function gitBlobSha(bytes) {
  const header = textEncoder.encode(`blob ${bytes.length}\0`);
  const buf = new Uint8Array(header.length + bytes.length);
  buf.set(header, 0);
  buf.set(bytes, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', buf));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** UTF-8 텍스트로 보이는지 대략 판별 (NUL 바이트가 없고 디코딩 손실이 없으면 텍스트) */
export function looksLikeText(bytes) {
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return true;
  } catch {
    // 샘플 경계에서 멀티바이트 문자가 잘렸을 수 있으므로 전체 길이가 짧으면 실패로 본다
    return bytes.length > 8192;
  }
}

/**
 * 프로젝트 기준 상대 경로로 정규화한다. "res://a/b.gd", "/a/b.gd" -> "a/b.gd"
 * 프로젝트 밖을 가리키거나 비어 있으면 null.
 */
export function normalizeProjectPath(path) {
  if (typeof path !== 'string') return null;
  let p = path.trim().replace(/\\/g, '/');
  if (p.startsWith('res://')) p = p.slice(6);
  p = p.replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/$/, '');
  if (!p) return null;
  const parts = p.split('/');
  if (parts.some((s) => s === '..' || s === '.' || s === '')) return null;
  return p;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const shortSha = (sha) => (sha ? sha.slice(0, 7) : '-------');

export function formatTime(date) {
  if (!date) return '-';
  return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** 동시에 최대 limit개씩 비동기 작업 실행 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 직렬 실행 큐: 동기화 작업이 겹치지 않게 한다 */
export class Mutex {
  #tail = Promise.resolve();
  run(fn) {
    const result = this.#tail.then(fn, fn);
    this.#tail = result.catch(() => {});
    return result;
  }
}
