// GitHub App 사용자 로그인 (OAuth 웹 흐름)
//   GET  /auth/login     → GitHub 승인 화면으로 이동
//   GET  /auth/callback  → 코드를 토큰으로 바꾸고 세션 쿠키 발급
//   POST /auth/logout    → 세션 삭제
//   GET  /api/me         → 로그인한 사용자 (없으면 401)
import { STATE_COOKIE, SESSION_COOKIE, clearCookie, error, exchangeToken, getCookie, githubFetch, isSameSiteWrite, json, randomToken, setCookie } from './http.js';
import { sessionFor } from './session.js';

const redirectUri = (req) => `${new URL(req.url).origin}/auth/callback`;

function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers });
}

/**
 * 로그인 후 에디터로 들어가는 짧은 페이지. 302로 바로 보내지 않는 이유:
 * GitHub(다른 사이트)에서 리다이렉트로 들어온 문서에서는 Godot 에디터의 스레드 초기화가 멈추는 현상이 있어서
 * (tests/e2e-cloud.mjs로 재현), 같은 출처에서 새로 이동하게 한다.
 */
function enterApp(cookies) {
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  const html = `<!doctype html><meta charset="utf-8"><title>로그인 완료</title>
<body style="font-family:sans-serif;background:#202531;color:#e0e3ea"><p>로그인했습니다. 에디터로 이동합니다… <a href="/" style="color:#478cbf">이동하지 않으면 누르세요</a></p>
<script>location.replace('/')</script>`;
  return new Response(html, { status: 200, headers });
}

function loginError(message) {
  const html = `<!doctype html><meta charset="utf-8"><title>로그인 실패</title>
<body style="font-family:sans-serif;max-width:40em;margin:4em auto">
<h1>로그인하지 못했습니다</h1><p>${message.replace(/[<>&]/g, '')}</p><p><a href="/">처음으로</a></p>`;
  return new Response(html, { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export const appConfigured = (env) => !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
const NOT_CONFIGURED = '서버에 GitHub App 설정(GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET)이 없습니다. docs/CLOUD-SETUP.md를 확인하세요.';

export function login(req, env) {
  if (!appConfigured(env)) return loginError(NOT_CONFIGURED);
  return githubAuthorize(req, env, randomToken(24));
}

/**
 * GitHub 승인 화면으로 보낸다. state는 쿠키에도 넣어 콜백에서 같은 브라우저인지 확인한다.
 * MCP 인가 흐름은 state가 "m.<세션id>.<무작위>" 형태 (oauth.js)
 */
export function githubAuthorize(req, env, state) {
  const url = new URL(`${env.GITHUB_WEB_BASE.replace(/\/$/, '')}/login/oauth/authorize`);
  url.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri(req));
  url.searchParams.set('state', state);
  return redirect(url.href, [setCookie(STATE_COOKIE, state, 600)]);
}

export async function callback(req, env) {
  const url = new URL(req.url);
  const state = getCookie(req, STATE_COOKIE);
  if (url.searchParams.get('error')) return loginError(`GitHub가 로그인을 거부했습니다: ${url.searchParams.get('error_description') || url.searchParams.get('error')}`);
  if (!state || state !== url.searchParams.get('state')) {
    // 앱 설치 직후 GitHub가 바로 보내는 경우(setup_action=install)는 우리 state가 없다.
    // 그 code는 쓰지 않고(로그인 위조 방지) 정상 로그인을 다시 시작한다. 이미 승인했으므로 GitHub가 바로 돌려보낸다.
    if (url.searchParams.has('setup_action') || url.searchParams.has('installation_id')) return redirect('/auth/login');
    return loginError('로그인 요청이 만료되었거나 올바르지 않습니다. 다시 시도하세요.');
  }
  const code = url.searchParams.get('code');
  if (!code) return loginError('GitHub가 인증 코드를 보내지 않았습니다.');

  const tokens = await exchangeToken(env, { code, redirect_uri: redirectUri(req) });
  if (!tokens) return loginError('GitHub에서 토큰을 받지 못했습니다. 앱의 Client ID/secret과 콜백 주소를 확인하세요.');
  const res = await githubFetch(env, '/user', { token: tokens.accessToken });
  if (!res.ok) return loginError(`GitHub 사용자 정보를 읽지 못했습니다 (${res.status}).`);
  const u = await res.json();
  const user = { id: u.id, login: u.login, name: u.name || u.login, avatar_url: u.avatar_url };

  if (state.startsWith('m.')) {
    // MCP 연결(claude.ai 커넥터 등) 승인: 이 브라우저의 로그인 세션은 만들지 않고, MCP 클라이언트에 인가 코드를 돌려준다
    const sid = state.split('.')[1];
    const codeSecret = randomToken(32);
    const done = await sessionFor(env, sid)?.completeMcp({ user, tokens, codeSecret });
    if (!done) return loginError('연결 요청이 만료되었습니다. Claude에서 연결을 다시 시도하세요.');
    const to = new URL(done.redirectUri);
    to.searchParams.set('code', `${sid}.${codeSecret}`);
    if (done.state) to.searchParams.set('state', done.state);
    return redirect(to.href, [clearCookie(STATE_COOKIE)]);
  }

  const sid = randomToken(32);
  const expiresAt = await sessionFor(env, sid).start({ user, tokens });
  return enterApp([setCookie(SESSION_COOKIE, sid, (expiresAt - Date.now()) / 1000), clearCookie(STATE_COOKIE)]);
}

export async function logout(req, env) {
  if (req.method !== 'POST') return error(405, 'POST만 허용됩니다');
  if (!isSameSiteWrite(req)) return error(403, '허용되지 않은 요청입니다');
  await sessionFor(env, getCookie(req, SESSION_COOKIE))?.end();
  return new Response(null, { status: 204, headers: { 'Set-Cookie': clearCookie(SESSION_COOKIE), 'Cache-Control': 'no-store' } });
}

/** 요청의 세션에서 유효한 GitHub 토큰을 꺼낸다. 없으면 { response: 401 } */
export async function requireToken(req, env) {
  const session = sessionFor(env, getCookie(req, SESSION_COOKIE));
  const token = session ? await session.token() : null;
  if (!token) {
    const res = error(401, '로그인이 필요합니다');
    if (session) res.headers.set('Set-Cookie', clearCookie(SESSION_COOKIE));
    return { response: res };
  }
  return { token, session };
}

/**
 * 세션 토큰으로 GitHub를 호출한다. GitHub가 401을 주면 토큰을 한 번 갱신해서 다시 시도하고,
 * 그래도 안 되면 로그인이 필요하다는 401(쿠키 삭제)을 돌려준다.
 * call(token) → Response
 */
export async function withGitHubToken(req, env, call) {
  const r = await requireToken(req, env);
  if (r.response) return r.response;
  let res = await call(r.token);
  if (res.status !== 401) return res;
  const fresh = await r.session.token(r.token);
  if (!fresh) {
    const out = error(401, '로그인이 만료되었습니다. 다시 로그인하세요.');
    out.headers.set('Set-Cookie', clearCookie(SESSION_COOKIE));
    return out;
  }
  res = await call(fresh);
  return res;
}

export async function me(req, env) {
  const r = await requireToken(req, env);
  if (r.response) return r.response;
  return json({ user: await r.session.user(), app_slug: env.GITHUB_APP_SLUG || null });
}
