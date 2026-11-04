// 로그인 세션 하나 = Durable Object 하나 (이름은 세션 쿠키 값).
// GitHub 사용자 토큰은 여기에만 저장되고 브라우저로 나가지 않는다.
// 토큰 갱신은 이 객체 안에서 한 번에 하나만 일어나므로, 동시 요청이 refresh 토큰(1회용)을 두 번 쓰는 일이 없다.
//
// MCP 연결(claude.ai 커넥터, Claude Code)도 세션 하나를 쓴다. 이때는 쿠키 대신 이 서버가 발급한
// 토큰("<세션id>.<비밀>")으로 찾아오고, 인가 코드/접근 토큰/리프레시 토큰의 해시를 'm' 항목에 둔다.
import { DurableObject } from 'cloudflare:workers';
import { exchangeToken, sha256Hex } from './http.js';

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000; // refresh 토큰이 없을 때 세션 유지 기간
const MCP_PENDING_MS = 10 * 60 * 1000; // 승인 화면 → GitHub 로그인까지
const MCP_CODE_MS = 5 * 60 * 1000;
export const MCP_ACCESS_SEC = 60 * 60;
const MCP_REFRESH_MS = 30 * 24 * 3600 * 1000;

async function pkceS256(verifier) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class Session extends DurableObject {
  #refreshing = null;

  /** 로그인 직후 저장 */
  async start({ user, tokens }) {
    const record = { user, ...tokens, createdAt: Date.now() };
    await this.ctx.storage.put('s', record);
    await this.ctx.storage.setAlarm(record.refreshExpiresAt ?? Date.now() + DEFAULT_TTL_MS);
    return this.#expiresAt(record);
  }

  async user() {
    const s = await this.ctx.storage.get('s');
    return s ? s.user : null;
  }

  /**
   * 유효한 접근 토큰. 곧 만료되면 갱신하고, 갱신할 수 없으면 세션을 지우고 null.
   * rejected: GitHub가 401로 거부한 토큰. 그 토큰이 아직 현재 토큰이면 만료 전이라도 갱신한다
   * (이미 다른 요청이 갱신했다면 새 토큰을 그대로 돌려줌).
   */
  async token(rejected = null) {
    const s = await this.ctx.storage.get('s');
    if (!s) return null;
    const stale = rejected && rejected === s.accessToken;
    if (!stale && (!s.expiresAt || Date.now() < s.expiresAt - REFRESH_MARGIN_MS)) return s.accessToken;
    this.#refreshing ??= this.#refresh(s).finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #refresh(s) {
    if (!s.refreshToken || (s.refreshExpiresAt && Date.now() >= s.refreshExpiresAt)) {
      await this.end();
      return null;
    }
    const tokens = await exchangeToken(this.env, { grant_type: 'refresh_token', refresh_token: s.refreshToken });
    if (!tokens) {
      await this.end();
      return null;
    }
    const next = { ...s, ...tokens, refreshToken: tokens.refreshToken ?? s.refreshToken, refreshExpiresAt: tokens.refreshExpiresAt ?? s.refreshExpiresAt };
    await this.ctx.storage.put('s', next);
    if (next.refreshExpiresAt) await this.ctx.storage.setAlarm(next.refreshExpiresAt);
    return next.accessToken;
  }

  // ---------- MCP 인가 (OAuth 2.1 서버 쪽) ----------

  /** 승인 화면에서 "허용"을 누른 뒤, GitHub 로그인 전까지 요청 내용을 보관 */
  async beginMcp(pending) {
    await this.ctx.storage.put('m', { pending: { ...pending, expires: Date.now() + MCP_PENDING_MS } });
    await this.ctx.storage.setAlarm(Date.now() + MCP_PENDING_MS);
  }

  /** GitHub 로그인 완료 → 사용자 토큰 저장, 인가 코드 발급. 돌려주는 값으로 클라이언트에 리다이렉트 */
  async completeMcp({ user, tokens, codeSecret }) {
    const m = await this.ctx.storage.get('m');
    if (!m?.pending || m.pending.expires < Date.now()) return null;
    await this.start({ user, tokens });
    const p = m.pending;
    await this.ctx.storage.put('m', {
      clientId: p.clientId,
      clientName: p.clientName,
      scope: p.scope,
      code: { hash: await sha256Hex(codeSecret), challenge: p.codeChallenge, redirectUri: p.redirectUri, expires: Date.now() + MCP_CODE_MS },
    });
    return { redirectUri: p.redirectUri, state: p.state };
  }

  /** 인가 코드 → 토큰. PKCE(S256)와 redirect_uri, client_id를 확인한다. 실패하면 null */
  async redeemMcpCode({ codeSecret, verifier, redirectUri, clientId, accessSecret, refreshSecret }) {
    const m = await this.ctx.storage.get('m');
    const c = m?.code;
    if (!c || c.expires < Date.now() || m.clientId !== clientId) return null;
    if (c.hash !== (await sha256Hex(codeSecret))) return null;
    if (redirectUri && redirectUri !== c.redirectUri) return null;
    if (!verifier || (await pkceS256(verifier)) !== c.challenge) return null;
    await this.#issueMcp(m, accessSecret, refreshSecret);
    return { scope: m.scope };
  }

  /** 리프레시 토큰 회전. 한 번 쓴 리프레시 토큰은 무효 */
  async refreshMcp({ refreshSecret, clientId, accessSecret, nextRefreshSecret }) {
    const m = await this.ctx.storage.get('m');
    if (!m?.refresh || m.clientId !== clientId || m.refresh.expires < Date.now()) return null;
    if (m.refresh.hash !== (await sha256Hex(refreshSecret))) return null;
    if (!(await this.ctx.storage.get('s'))) return null; // GitHub 쪽 세션이 끝났으면 다시 로그인
    await this.#issueMcp(m, accessSecret, nextRefreshSecret);
    return { scope: m.scope };
  }

  async #issueMcp(m, accessSecret, refreshSecret) {
    const now = Date.now();
    const next = {
      clientId: m.clientId,
      clientName: m.clientName,
      scope: m.scope,
      access: { hash: await sha256Hex(accessSecret), expires: now + MCP_ACCESS_SEC * 1000 },
      refresh: { hash: await sha256Hex(refreshSecret), expires: now + MCP_REFRESH_MS },
    };
    await this.ctx.storage.put('m', next);
  }

  /** MCP 접근 토큰 확인 → 사용자. 틀리거나 만료되면 null */
  async verifyMcp(accessSecret) {
    const [m, s] = await Promise.all([this.ctx.storage.get('m'), this.ctx.storage.get('s')]);
    if (!m?.access || !s || m.access.expires < Date.now()) return null;
    if (m.access.hash !== (await sha256Hex(accessSecret))) return null;
    return s.user;
  }

  async end() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** 세션 만료 시 저장 내용 삭제 */
  async alarm() {
    await this.ctx.storage.deleteAll();
  }

  #expiresAt(record) {
    return record.refreshExpiresAt ?? record.createdAt + DEFAULT_TTL_MS;
  }
}

/** 요청의 세션 쿠키에 해당하는 Session 객체 (쿠키가 없으면 null) */
export function sessionFor(env, sid) {
  if (!sid || sid.length < 32) return null;
  return env.SESSIONS.get(env.SESSIONS.idFromName(sid));
}
