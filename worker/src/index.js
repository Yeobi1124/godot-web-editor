// Godot 웹 에디터 클라우드 버전 Worker
// 정적 파일(웹 에디터)은 Cloudflare가 직접 보내고, 아래 경로만 이 코드가 처리한다.
//   /auth/*            GitHub 로그인
//   /api/me, /api/repos
//   /gh/*              GitHub API 대리 호출
//   /godot.editor.wasm 엔진 조각 이어 붙이기
//   /mcp, /oauth/*, /.well-known/oauth-*   MCP (Claude 연결)
//   /live              웹 에디터 탭 ↔ Hub(WebSocket)
import { callback, login, logout, me } from './auth.js';
import { engineWasm } from './engine.js';
import { proxy } from './github-proxy.js';
import { error, withSecurityHeaders } from './http.js';
import { live, mcp } from './mcp.js';
import { authorize, preflight, register, resourceMetadata, serverMetadata, token } from './oauth.js';
import { repos } from './repos.js';

export { Hub } from './hub.js';
export { Session } from './session.js';

async function route(req, env, ctx) {
  const { pathname } = new URL(req.url);
  if (pathname === '/auth/login') return login(req, env);
  if (pathname === '/auth/callback') return callback(req, env);
  if (pathname === '/auth/logout') return logout(req, env);
  if (pathname === '/api/me') return me(req, env);
  if (pathname === '/api/repos') return repos(req, env);
  if (pathname.startsWith('/gh/')) return proxy(req, env);
  if (pathname === '/godot.editor.wasm') return engineWasm(req, env, ctx);
  if (pathname === '/mcp') return mcp(req, env);
  if (pathname === '/live') return live(req, env);
  if (pathname.startsWith('/.well-known/oauth-protected-resource')) return req.method === 'OPTIONS' ? preflight() : resourceMetadata(req);
  if (pathname.startsWith('/.well-known/oauth-authorization-server')) return req.method === 'OPTIONS' ? preflight() : serverMetadata(req);
  if (pathname === '/oauth/register') return req.method === 'OPTIONS' ? preflight() : register(req, env);
  if (pathname === '/oauth/authorize') return authorize(req, env);
  if (pathname === '/oauth/token') return req.method === 'OPTIONS' ? preflight() : token(req, env);
  return env.ASSETS.fetch(req);
}

export default {
  async fetch(req, env, ctx) {
    try {
      const res = await route(req, env, ctx);
      if (res.status === 101) return res; // WebSocket 업그레이드 응답은 그대로
      return withSecurityHeaders(res);
    } catch (e) {
      console.error(e);
      return withSecurityHeaders(error(500, '서버 오류가 발생했습니다'));
    }
  },
};
