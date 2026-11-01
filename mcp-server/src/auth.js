// 인증
// (OAuth 오류 설명은 HTTP 헤더와 규격(RFC 6749) 때문에 ASCII 영어로 쓴다)
//  - Claude Code: 고정 Bearer 토큰(CLI_TOKEN)
//  - claude.ai / Claude 데스크톱 / 모바일: 1인용 OAuth 2.1 인증 서버
//      동적 클라이언트 등록(DCR) -> /authorize(비밀번호 로그인 화면) -> 인가 코드(PKCE) -> /token
//  MCP SDK의 mcpAuthRouter가 엔드포인트와 검증을 처리하고, 여기서는 저장소와 로그인 화면만 구현한다.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { hashToken, randomToken, safeEqual } from './secrets.js';
import { log, warn } from './log.js';

const ACCESS_TTL_SEC = 60 * 60; // 1시간
const REFRESH_TTL_SEC = 30 * 24 * 60 * 60; // 30일
const CODE_TTL_MS = 5 * 60 * 1000;
const LOGIN_REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
export const SCOPE = 'mcp';

const CLAUDE_CALLBACKS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];

/** 등록을 허용하는 redirect URI: Claude 콜백, 로컬 루프백(Claude Code 등), 추가 설정값 */
export function redirectUriAllowed(uri, extra = []) {
  if (CLAUDE_CALLBACKS.includes(uri) || extra.includes(uri)) return true;
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** 클라이언트와 토큰(해시)을 JSON 파일에 저장. 인가 코드와 로그인 요청은 메모리에만 둔다. */
class AuthStore {
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.path = join(dataDir, 'auth.json');
    try {
      this.data = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      this.data = { clients: {}, access: {}, refresh: {} };
    }
    this.codes = new Map();
    this.loginRequests = new Map();
    this.#prune();
  }

  save() {
    this.#prune();
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  #prune() {
    const now = Math.floor(Date.now() / 1000);
    for (const kind of ['access', 'refresh']) {
      for (const [h, t] of Object.entries(this.data[kind])) if (t.expiresAt < now) delete this.data[kind][h];
    }
  }
}

export class SingleUserOAuthProvider {
  #failures = 0;
  #lockedUntil = 0;

  constructor({ dataDir, adminPassword, cliToken, publicUrl, extraRedirectUris = [] }) {
    this.store = new AuthStore(dataDir);
    this.adminPassword = adminPassword;
    this.cliToken = cliToken;
    this.resource = new URL('/mcp', publicUrl);
    this.extraRedirectUris = extraRedirectUris;
    const store = this.store;
    this.clientsStore = {
      getClient: (id) => store.data.clients[id],
      registerClient: (client) => {
        const bad = (client.redirect_uris ?? []).filter((u) => !redirectUriAllowed(String(u), this.extraRedirectUris));
        if (!client.redirect_uris?.length || bad.length) {
          throw new InvalidClientMetadataError(`redirect_uri not allowed: ${bad.join(', ') || '(none)'}`);
        }
        store.data.clients[client.client_id] = client;
        store.save();
        log(`OAuth 클라이언트 등록: ${client.client_name ?? '(이름 없음)'} [${client.client_id}]`);
        return client;
      },
    };
  }

  // ---------- 인가 (로그인 화면) ----------

  async authorize(client, params, res) {
    const reqId = randomToken(18);
    this.store.loginRequests.set(reqId, { clientId: client.client_id, params, expires: Date.now() + LOGIN_REQUEST_TTL_MS });
    res.status(200).type('html').send(loginPage({ reqId, clientName: client.client_name || client.client_id, error: '' }));
  }

  /** POST /login (로그인 화면 제출) */
  loginHandler() {
    const router = express.Router();
    router.use(express.urlencoded({ extended: false, limit: '10kb' }));
    router.post('/', (req, res) => {
      res.set('Cache-Control', 'no-store');
      const reqId = String(req.body.req ?? '');
      const pending = this.store.loginRequests.get(reqId);
      if (!pending || pending.expires < Date.now()) {
        this.store.loginRequests.delete(reqId);
        res.status(400).type('html').send(messagePage('요청이 만료되었습니다. Claude에서 연결을 다시 시도하세요.'));
        return;
      }
      const client = this.store.data.clients[pending.clientId];
      if (Date.now() < this.#lockedUntil) {
        res.status(429).type('html').send(loginPage({ reqId, clientName: client?.client_name, error: '로그인 시도가 너무 많습니다. 15분 뒤 다시 시도하세요.' }));
        return;
      }
      if (req.body.action === 'deny') {
        this.store.loginRequests.delete(reqId);
        res.redirect(302, withParams(pending.params.redirectUri, { error: 'access_denied', state: pending.params.state }));
        return;
      }
      if (!safeEqual(String(req.body.password ?? ''), this.adminPassword)) {
        this.#failures++;
        warn(`OAuth 로그인 실패 (${this.#failures}회)`);
        if (this.#failures >= MAX_FAILURES) {
          this.#lockedUntil = Date.now() + LOCK_MS;
          this.#failures = 0;
        }
        res.status(401).type('html').send(loginPage({ reqId, clientName: client?.client_name, error: '비밀번호가 맞지 않습니다.' }));
        return;
      }
      this.#failures = 0;
      this.store.loginRequests.delete(reqId);
      const code = randomToken(32);
      const p = pending.params;
      this.store.codes.set(code, {
        clientId: pending.clientId,
        codeChallenge: p.codeChallenge,
        redirectUri: p.redirectUri,
        scopes: p.scopes?.length ? p.scopes : [SCOPE],
        resource: p.resource?.href ?? null,
        expires: Date.now() + CODE_TTL_MS,
      });
      log(`OAuth 승인: ${client?.client_name ?? pending.clientId}`);
      res.redirect(302, withParams(p.redirectUri, { code, state: p.state }));
    });
    return router;
  }

  // ---------- 토큰 ----------

  #codeFor(client, code) {
    const c = this.store.codes.get(code);
    if (!c || c.expires < Date.now() || c.clientId !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code');
    return c;
  }

  async challengeForAuthorizationCode(client, code) {
    return this.#codeFor(client, code).codeChallenge;
  }

  #issue(clientId, scopes, resource) {
    const now = Math.floor(Date.now() / 1000);
    const access = randomToken(32);
    const refresh = randomToken(32);
    this.store.data.access[hashToken(access)] = { clientId, scopes, resource, expiresAt: now + ACCESS_TTL_SEC };
    this.store.data.refresh[hashToken(refresh)] = { clientId, scopes, resource, expiresAt: now + REFRESH_TTL_SEC };
    this.store.save();
    return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL_SEC, refresh_token: refresh, scope: scopes.join(' ') };
  }

  async exchangeAuthorizationCode(client, code, _codeVerifier, redirectUri, resource) {
    const c = this.#codeFor(client, code); // PKCE 검증은 SDK가 challengeForAuthorizationCode로 먼저 처리
    this.store.codes.delete(code);
    if (redirectUri && redirectUri !== c.redirectUri) throw new InvalidGrantError('redirect_uri mismatch');
    if (resource && c.resource && resource.href !== c.resource) throw new InvalidGrantError('resource mismatch');
    return this.#issue(client.client_id, c.scopes, c.resource ?? this.resource.href);
  }

  async exchangeRefreshToken(client, refreshToken, scopes) {
    const h = hashToken(refreshToken);
    const t = this.store.data.refresh[h];
    if (!t || t.clientId !== client.client_id || t.expiresAt < Date.now() / 1000) throw new InvalidGrantError('Invalid or expired refresh token');
    delete this.store.data.refresh[h]; // 회전: 한 번 쓴 리프레시 토큰은 폐기
    const granted = scopes?.length ? scopes.filter((s) => t.scopes.includes(s)) : t.scopes;
    return this.#issue(client.client_id, granted, t.resource);
  }

  async verifyAccessToken(token) {
    if (safeEqual(token, this.cliToken)) {
      return { token, clientId: 'claude-code-cli', scopes: [SCOPE], expiresAt: Math.floor(Date.now() / 1000) + ACCESS_TTL_SEC };
    }
    const t = this.store.data.access[hashToken(token)];
    if (!t || t.expiresAt < Date.now() / 1000) throw new InvalidTokenError('Invalid or expired token');
    return { token, clientId: t.clientId, scopes: t.scopes, expiresAt: t.expiresAt, resource: t.resource ? new URL(t.resource) : undefined };
  }

  async revokeToken(client, request) {
    const h = hashToken(request.token);
    for (const kind of ['access', 'refresh']) {
      if (this.store.data[kind][h]?.clientId === client.client_id) delete this.store.data[kind][h];
    }
    this.store.save();
  }
}

function withParams(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  return u.href;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const PAGE_STYLE = `body{font:15px/1.5 system-ui,sans-serif;background:#202531;color:#e0e3ea;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
main{background:#262c3b;border:1px solid #3b4357;border-radius:10px;padding:24px;width:min(380px,100%)}h1{font-size:18px;margin:0 0 8px}p{color:#9aa3b5;margin:0 0 14px}
input{width:100%;box-sizing:border-box;padding:9px;border-radius:6px;border:1px solid #3b4357;background:#1a1f29;color:inherit;font:inherit;margin:4px 0 12px}
.row{display:flex;gap:8px}button{flex:1;padding:9px;border-radius:6px;border:1px solid #3b4357;background:#2e3547;color:inherit;font:inherit;cursor:pointer}
button.primary{background:#478cbf;border-color:#478cbf;color:#fff}.error{color:#e05a5a}`;

function loginPage({ reqId, clientName, error }) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Godot Web Editor 연결 승인</title><style>${PAGE_STYLE}</style></head><body><main>
<h1>Godot Web Editor MCP 연결</h1>
<p><b>${esc(clientName)}</b>이(가) 이 서버의 Godot 프로젝트 도구(파일 읽기/쓰기, 에디터 조작)를 사용하려고 합니다.</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/login">
<input type="hidden" name="req" value="${esc(reqId)}">
<label for="password">서버 비밀번호 (ADMIN_PASSWORD)</label>
<input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
<div class="row"><button type="submit" name="action" value="deny" formnovalidate>거부</button><button type="submit" name="action" value="allow" class="primary">승인</button></div>
</form></main></body></html>`;
}

function messagePage(text) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Godot Web Editor</title><style>${PAGE_STYLE}</style></head><body><main><p>${esc(text)}</p></main></body></html>`;
}
