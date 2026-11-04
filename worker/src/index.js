// Godot 웹 에디터 클라우드 버전 Worker
// 정적 파일(웹 에디터)은 Cloudflare가 직접 보내고, 아래 경로만 이 코드가 처리한다.
//   /auth/*            GitHub 로그인
//   /api/me, /api/repos
//   /gh/*              GitHub API 대리 호출
//   /godot.editor.wasm 엔진 조각 이어 붙이기
import { callback, login, logout, me } from './auth.js';
import { engineWasm } from './engine.js';
import { proxy } from './github-proxy.js';
import { error, withSecurityHeaders } from './http.js';
import { repos } from './repos.js';

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
  return env.ASSETS.fetch(req);
}

export default {
  async fetch(req, env, ctx) {
    try {
      return withSecurityHeaders(await route(req, env, ctx));
    } catch (e) {
      console.error(e);
      return withSecurityHeaders(error(500, '서버 오류가 발생했습니다'));
    }
  },
};
