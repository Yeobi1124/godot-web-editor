// 로그인 세션 하나 = Durable Object 하나 (이름은 세션 쿠키 값).
// GitHub 사용자 토큰은 여기에만 저장되고 브라우저로 나가지 않는다.
// 토큰 갱신은 이 객체 안에서 한 번에 하나만 일어나므로, 동시 요청이 refresh 토큰(1회용)을 두 번 쓰는 일이 없다.
import { DurableObject } from 'cloudflare:workers';
import { exchangeToken } from './http.js';

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000; // refresh 토큰이 없을 때 세션 유지 기간

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
