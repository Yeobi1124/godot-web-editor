// MCP 클라이언트(claude.ai 커넥터, Claude Desktop/모바일, Claude Code)를 위한 OAuth 2.1 인가 서버.
// 사용자 확인은 GitHub 로그인으로 한다. 비밀번호나 고정 토큰이 없다.
//
//   GET  /.well-known/oauth-protected-resource[/mcp]   자원 메타데이터 (RFC 9728)
//   GET  /.well-known/oauth-authorization-server       서버 메타데이터 (RFC 8414)
//   POST /oauth/register     동적 클라이언트 등록 (RFC 7591). 저장하지 않고 서명된 client_id를 돌려준다
//   GET  /oauth/authorize    승인 화면 → (허용) GitHub 로그인 → /auth/callback → 클라이언트로 code
//   POST /oauth/token        code(PKCE S256) 또는 refresh_token → 접근 토큰(1시간)과 리프레시 토큰(30일, 회전)
//
// 토큰 형식은 "<세션id>.<비밀>". 세션 id로 Session Durable Object를 찾고, 비밀은 해시로만 저장한다.
// (오류 설명은 RFC 6749 규격상 ASCII 영어)
import { appConfigured, githubAuthorize } from './auth.js';
import { escapeHtml, hmac, json, randomToken } from './http.js';
import { MCP_ACCESS_SEC, sessionFor } from './session.js';

export const SCOPE = 'mcp';
const CLAUDE_CALLBACKS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };

/** 등록을 허용하는 redirect URI: Claude 콜백과 로컬 루프백(Claude Code 등) */
export function redirectUriAllowed(uri) {
  if (CLAUDE_CALLBACKS.includes(uri)) return true;
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

const cors = (res) => {
  for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
  return res;
};
const oauthError = (status, code, description) => cors(json({ error: code, error_description: description }, status));

export function preflight() {
  return new Response(null, { status: 204, headers: CORS });
}

export function resourceMetadata(req) {
  const origin = new URL(req.url).origin;
  return cors(json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: 'Godot Web Editor' }));
}

export function serverMetadata(req) {
  const origin = new URL(req.url).origin;
  return cors(
    json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [SCOPE],
    }),
  );
}

// ---------- 클라이언트 (서명된 client_id, 저장 없음) ----------

const enc = (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const dec = (s) => JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))));

/** client_id → { redirect_uris, client_name } (서명이 틀리면 null) */
export async function readClient(env, clientId) {
  if (typeof clientId !== 'string') return null;
  const i = clientId.lastIndexOf('.');
  if (i < 1) return null;
  const body = clientId.slice(0, i);
  if (clientId.slice(i + 1) !== (await hmac(env, 'mcp-client', body))) return null;
  try {
    const c = dec(body);
    return { redirect_uris: c.u, client_name: c.n };
  } catch {
    return null;
  }
}

export async function register(req, env) {
  if (req.method !== 'POST') return oauthError(405, 'invalid_request', 'POST required');
  if (!appConfigured(env)) return oauthError(503, 'temporarily_unavailable', 'GitHub App is not configured on this server');
  let meta;
  try {
    meta = await req.json();
  } catch {
    return oauthError(400, 'invalid_client_metadata', 'JSON body required');
  }
  const uris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris.map(String) : [];
  const bad = uris.filter((u) => !redirectUriAllowed(u));
  if (!uris.length || bad.length) return oauthError(400, 'invalid_redirect_uri', `redirect_uri not allowed: ${bad.join(', ') || '(none)'}`);
  const name = String(meta.client_name || 'MCP client').slice(0, 60);
  const body = enc({ u: uris, n: name });
  const clientId = `${body}.${await hmac(env, 'mcp-client', body)}`;
  return cors(
    json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: name,
        redirect_uris: uris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      201,
    ),
  );
}

// ---------- 인가 ----------

const PAGE_STYLE = `body{font:15px/1.5 system-ui,sans-serif;background:#202531;color:#e0e3ea;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
main{background:#262c3b;border:1px solid #3b4357;border-radius:10px;padding:24px;width:min(400px,100%)}h1{font-size:18px;margin:0 0 8px}p{color:#9aa3b5;margin:0 0 14px}
.row{display:flex;gap:8px}button{flex:1;padding:9px;border-radius:6px;border:1px solid #3b4357;background:#2e3547;color:inherit;font:inherit;cursor:pointer}
button.primary{background:#478cbf;border-color:#478cbf;color:#fff}.error{color:#e05a5a}`;

function page(title, inner, status = 200) {
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body><main>${inner}</main></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" } });
}

const withParams = (uri, params) => {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.href;
};

/** 요청 값 검사. 클라이언트와 redirect_uri가 맞지 않으면 리다이렉트하지 않고 화면에 오류를 보인다 (RFC 6749 4.1.2.1) */
async function readAuthorizeParams(env, p) {
  const client = await readClient(env, p.get('client_id'));
  if (!client) return { fatal: '등록되지 않은 클라이언트입니다. Claude에서 연결을 다시 시도하세요.' };
  const redirectUri = p.get('redirect_uri') || (client.redirect_uris.length === 1 ? client.redirect_uris[0] : null);
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) return { fatal: 'redirect_uri가 등록된 값과 다릅니다.' };
  const state = p.get('state') || '';
  const fail = (error, description) => ({ redirect: withParams(redirectUri, { error, error_description: description, state }) });
  if (p.get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be code');
  if (!p.get('code_challenge') || (p.get('code_challenge_method') || 'plain') !== 'S256') return fail('invalid_request', 'PKCE with S256 is required');
  return { client, clientId: p.get('client_id'), redirectUri, state, codeChallenge: p.get('code_challenge'), scope: SCOPE };
}

export async function authorize(req, env) {
  if (!appConfigured(env)) return page('설정 필요', '<p class="error">서버에 GitHub App 설정이 없습니다.</p>', 503);
  const url = new URL(req.url);
  const params = req.method === 'POST' ? new URLSearchParams(await req.text()) : url.searchParams;
  const r = await readAuthorizeParams(env, params);
  if (r.fatal) return page('연결 오류', `<h1>연결할 수 없습니다</h1><p class="error">${escapeHtml(r.fatal)}</p>`, 400);
  if (r.redirect) return Response.redirect(r.redirect, 302);

  if (req.method === 'GET') {
    const hidden = [...params].map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('');
    return page(
      'Godot Web Editor 연결 승인',
      `<h1>Godot Web Editor MCP 연결</h1>
<p><b>${escapeHtml(r.client.client_name)}</b>이(가) 내 GitHub 계정으로 Godot 프로젝트 도구(파일 읽기/쓰기, 열린 에디터 조작)를 쓰려고 합니다.</p>
<p>허용하면 GitHub 로그인으로 넘어갑니다. 접근할 수 있는 저장소는 이 앱을 설치하며 고른 저장소뿐입니다.</p>
<form method="post" action="/oauth/authorize">${hidden}
<div class="row"><button type="submit" name="action" value="deny">거부</button><button type="submit" name="action" value="allow" class="primary">허용</button></div>
</form>`,
    );
  }
  if (params.get('action') !== 'allow') return Response.redirect(withParams(r.redirectUri, { error: 'access_denied', state: r.state }), 302);

  const sid = randomToken(32);
  await sessionFor(env, sid).beginMcp({ clientId: r.clientId, clientName: r.client.client_name, redirectUri: r.redirectUri, state: r.state, codeChallenge: r.codeChallenge, scope: r.scope });
  return githubAuthorize(req, env, `m.${sid}.${randomToken(16)}`);
}

// ---------- 토큰 ----------

function splitToken(token) {
  const i = typeof token === 'string' ? token.indexOf('.') : -1;
  if (i < 32) return null;
  return { sid: token.slice(0, i), secret: token.slice(i + 1) };
}

export async function token(req, env) {
  if (req.method !== 'POST') return oauthError(405, 'invalid_request', 'POST required');
  const type = req.headers.get('Content-Type') || '';
  const p = type.includes('application/json') ? new URLSearchParams(Object.entries(await req.json().catch(() => ({})))) : new URLSearchParams(await req.text());
  const clientId = p.get('client_id');
  if (!(await readClient(env, clientId))) return oauthError(401, 'invalid_client', 'Unknown client');
  const grant = p.get('grant_type');
  const issue = (sid, scope, accessSecret, refreshSecret) =>
    cors(json({ access_token: `${sid}.${accessSecret}`, token_type: 'Bearer', expires_in: MCP_ACCESS_SEC, refresh_token: `${sid}.${refreshSecret}`, scope }));

  if (grant === 'authorization_code') {
    const code = splitToken(p.get('code'));
    if (!code) return oauthError(400, 'invalid_grant', 'Invalid authorization code');
    const accessSecret = randomToken(32);
    const refreshSecret = randomToken(32);
    const ok = await sessionFor(env, code.sid)?.redeemMcpCode({
      codeSecret: code.secret,
      verifier: p.get('code_verifier'),
      redirectUri: p.get('redirect_uri'),
      clientId,
      accessSecret,
      refreshSecret,
    });
    if (!ok) return oauthError(400, 'invalid_grant', 'Invalid or expired authorization code, or PKCE mismatch');
    return issue(code.sid, ok.scope, accessSecret, refreshSecret);
  }
  if (grant === 'refresh_token') {
    const rt = splitToken(p.get('refresh_token'));
    if (!rt) return oauthError(400, 'invalid_grant', 'Invalid refresh token');
    const accessSecret = randomToken(32);
    const nextRefresh = randomToken(32);
    const ok = await sessionFor(env, rt.sid)?.refreshMcp({ refreshSecret: rt.secret, clientId, accessSecret, nextRefreshSecret: nextRefresh });
    if (!ok) return oauthError(400, 'invalid_grant', 'Invalid or expired refresh token');
    return issue(rt.sid, ok.scope, accessSecret, nextRefresh);
  }
  return oauthError(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
}

/** MCP 요청의 Bearer 토큰 → { user, session } 또는 null */
export async function verifyBearer(req, env) {
  const h = req.headers.get('Authorization') || '';
  const t = splitToken(h.startsWith('Bearer ') ? h.slice(7).trim() : '');
  if (!t) return null;
  const session = sessionFor(env, t.sid);
  const user = await session?.verifyMcp(t.secret);
  return user ? { user, session } : null;
}

export function unauthorized(req) {
  const origin = new URL(req.url).origin;
  return cors(
    new Response(JSON.stringify({ error: 'invalid_token', error_description: 'Missing or invalid access token' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="${SCOPE}"`,
      },
    }),
  );
}
