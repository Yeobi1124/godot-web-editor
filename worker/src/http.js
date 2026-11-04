// 공용 도우미: 응답, 쿠키, CSRF 검사, GitHub 호출

export const SESSION_COOKIE = '__Host-gwe_sid';
export const STATE_COOKIE = '__Host-gwe_state';
const USER_AGENT = 'godot-web-editor-worker';

/** 모든 Worker 응답에 붙이는 헤더 (정적 파일은 _headers 파일로 같은 값을 붙인다) */
export function withSecurityHeaders(res) {
  const out = new Response(res.body, res);
  out.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  out.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Referrer-Policy', 'same-origin');
  return out;
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

export const error = (status, message) => json({ error: message }, status);

export function getCookie(req, name) {
  const header = req.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function setCookie(name, value, maxAgeSec) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;
}

export const clearCookie = (name) => setCookie(name, '', 0);

export function randomToken(bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 상태를 바꾸는 요청(GET/HEAD 이외)은 같은 페이지에서 보낸 것만 받는다.
 * 사용자 지정 헤더(X-GWE)는 다른 사이트가 CORS 허가 없이 붙일 수 없고, Origin이 있으면 같은 주소여야 한다.
 */
export function isSameSiteWrite(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  if (req.headers.get('X-GWE') !== '1') return false;
  const origin = req.headers.get('Origin');
  return !origin || origin === new URL(req.url).origin;
}

/** GitHub REST 호출 (Worker 안에서만 사용) */
export function githubFetch(env, path, { token, method = 'GET', body, headers = {} } = {}) {
  return fetch(env.GITHUB_API_BASE.replace(/\/$/, '') + path, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body,
  });
}

/** OAuth 토큰 교환 (code 또는 refresh_token). 실패하면 null */
export async function exchangeToken(env, params) {
  const res = await fetch(`${env.GITHUB_WEB_BASE.replace(/\/$/, '')}/login/oauth/access_token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, ...params }),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || !data.access_token) return null;
  const now = Date.now();
  return {
    accessToken: data.access_token,
    // 만료 없는 토큰(앱 설정에서 만료를 끈 경우)은 expiresAt이 null
    expiresAt: data.expires_in ? now + data.expires_in * 1000 : null,
    refreshToken: data.refresh_token || null,
    refreshExpiresAt: data.refresh_token_expires_in ? now + data.refresh_token_expires_in * 1000 : null,
  };
}
