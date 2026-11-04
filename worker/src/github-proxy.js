// /gh/* → GitHub REST API 대리 호출.
// 웹 에디터(web/js/github.js)가 쓰는 경로만 허용하고, 세션의 사용자 토큰을 붙여 보낸다.
// 사용자 토큰이라 GitHub가 "이 사용자 + 앱이 설치된 저장소" 범위로 권한을 직접 검사한다.
import { withGitHubToken } from './auth.js';
import { error, githubFetch, isSameSiteWrite } from './http.js';

const NAME = '[A-Za-z0-9_.-]+';
const SHA = '[0-9a-f]{40}';
const REPO = `/repos/${NAME}/${NAME}`;
const ALLOWED = [
  ['GET', new RegExp('^/user$')],
  ['GET', new RegExp(`^${REPO}$`)],
  ['GET', new RegExp(`^${REPO}/git/ref/heads/[^?#]+$`)],
  ['GET', new RegExp(`^${REPO}/git/(commits|trees|blobs)/${SHA}$`)],
  ['POST', new RegExp(`^${REPO}/git/(blobs|trees|commits|refs)$`)],
  ['PATCH', new RegExp(`^${REPO}/git/refs/heads/[^?#]+$`)],
  ['PUT', new RegExp(`^${REPO}/contents/[^?#]+$`)], // 빈 저장소의 첫 파일
];
const PASS_QUERY = new Set(['recursive']);
const MAX_BODY = 50 * 1024 * 1024;

export function allowed(method, path) {
  if (path.includes('..') || path.includes('//')) return false;
  return ALLOWED.some(([m, re]) => m === method && re.test(path));
}

export async function proxy(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.slice('/gh'.length);
  if (!allowed(req.method, path)) return error(403, `허용되지 않은 GitHub 요청입니다: ${req.method} ${path}`);
  if (!isSameSiteWrite(req)) return error(403, '허용되지 않은 요청입니다');
  const query = new URLSearchParams();
  for (const [k, v] of url.searchParams) if (PASS_QUERY.has(k)) query.set(k, v);
  let body;
  if (req.method !== 'GET') {
    body = await req.arrayBuffer();
    if (body.byteLength > MAX_BODY) return error(413, '요청이 너무 큽니다');
  }
  const target = path + (query.size ? `?${query}` : '');
  const upstream = await withGitHubToken(req, env, (token) =>
    githubFetch(env, target, { token, method: req.method, body, headers: body ? { 'Content-Type': 'application/json' } : {} }),
  );
  if (upstream.status === 401 && upstream.headers.get('Set-Cookie')) return upstream; // 다시 로그인 필요
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  for (const h of ['Content-Type', 'X-RateLimit-Remaining', 'X-RateLimit-Reset']) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
