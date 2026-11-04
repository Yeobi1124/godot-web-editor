// Worker 통합 테스트: wrangler dev(로컬, workerd) + 가짜 GitHub(OAuth 포함)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeGitHub } from '../../tests/fake-github.mjs';

const WORKER = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let gh;
let oauth;
let wrangler;
let base;
let tmp;
let wasm;

/** 쿠키를 기억하는 아주 작은 클라이언트 (리다이렉트는 직접 따라감) */
class Browser {
  cookies = new Map();
  async fetch(path, init = {}) {
    const url = path.startsWith('http') ? path : base + path;
    const headers = new Headers(init.headers);
    if (url.startsWith(base) && this.cookies.size) headers.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await fetch(url, { ...init, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(';');
      const [k, v] = kv.split('=');
      if (/max-age=0/i.test(attrs.join(';'))) this.cookies.delete(k.trim());
      else this.cookies.set(k.trim(), v);
    }
    return res;
  }
  async login() {
    const r1 = await this.fetch('/auth/login');
    assert.equal(r1.status, 302);
    const r2 = await this.fetch(r1.headers.get('Location')); // 가짜 GitHub 승인 화면 → 콜백으로
    assert.equal(r2.status, 302);
    const r3 = await this.fetch(r2.headers.get('Location'));
    assert.equal(r3.status, 200, await r3.clone().text());
    assert.match(await r3.clone().text(), /location\.replace\('\/'\)/, '같은 출처에서 / 로 이동');
    return r3;
  }
  write(path, method, body, extra = {}) {
    return this.fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-GWE': '1', ...extra }, body: body ? JSON.stringify(body) : undefined });
  }
}

async function waitReady(url, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* 아직 시작 중 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('wrangler dev가 시작되지 않았습니다');
}

before(async () => {
  gh = new FakeGitHub({ owner: 'tester', repo: 'game' });
  oauth = gh.enableOAuth({ clientId: 'cid', clientSecret: 'csecret' });
  gh.commit({ 'project.godot': 'config_version=5\n', 'main.gd': 'extends Node\n' }, 'init');
  await gh.listen(0);
  const ghBase = `http://127.0.0.1:${gh.server.address().port}`;

  // 작은 가짜 정적 파일 (엔진은 조각 3개)
  tmp = mkdtempSync(join(tmpdir(), 'worker-test-'));
  const assets = join(tmp, 'assets');
  mkdirSync(join(assets, 'engine'), { recursive: true });
  writeFileSync(join(assets, 'index.html'), '<!doctype html><title>editor</title>');
  wasm = randomBytes(250_000);
  const parts = [];
  for (let i = 0, n = 0; i < wasm.length; i += 100_000, n++) {
    writeFileSync(join(assets, 'engine', `godot.editor.wasm.${n}`), wasm.subarray(i, i + 100_000));
    parts.push(`godot.editor.wasm.${n}`);
  }
  writeFileSync(join(assets, 'engine', 'wasm-manifest.json'), JSON.stringify({ size: wasm.length, sha256: createHash('sha256').update(wasm).digest('hex'), parts }));
  writeFileSync(join(assets, '_headers'), '/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n');

  const port = 18700 + Math.floor(Math.random() * 200);
  base = `http://localhost:${port}`;
  const vars = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret', GITHUB_APP_SLUG: 'gwe-test', GITHUB_API_BASE: ghBase, GITHUB_WEB_BASE: ghBase };
  wrangler = spawn(
    join(WORKER, 'node_modules/.bin/wrangler'),
    ['dev', '--port', String(port), '--ip', '127.0.0.1', '--assets', assets, '--persist-to', join(tmp, 'state'), '--show-interactive-dev-session=false', '--inspector-port', '0',
      ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])],
    { cwd: WORKER, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  wrangler.stdout.on('data', (d) => (out += d));
  wrangler.stderr.on('data', (d) => (out += d));
  wrangler.on('exit', (code) => {
    if (code) console.error(out);
  });
  await waitReady(`${base}/api/me`);
});

after(() => {
  wrangler?.kill('SIGINT');
  gh?.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('클라우드 Worker', () => {
  test('정적 파일과 보안 헤더', async () => {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(r.headers.get('cross-origin-embedder-policy'), 'require-corp');
    const api = await fetch(`${base}/api/me`);
    assert.equal(api.headers.get('cross-origin-embedder-policy'), 'require-corp', 'Worker 응답에도 헤더');
  });

  test('엔진 wasm: 조각을 이어 붙여 원본과 같은 바이트', async () => {
    const r = await fetch(`${base}/godot.editor.wasm`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/wasm');
    // 실제 Cloudflare는 FixedLengthStream으로 Content-Length를 보낸다. 로컬 wrangler dev는 청크 전송으로 바꿀 수 있어 있을 때만 확인
    if (r.headers.get('content-length')) assert.equal(Number(r.headers.get('content-length')), wasm.length);
    console.log('wasm headers', JSON.stringify(Object.fromEntries(r.headers)));
    const body = Buffer.from(await r.arrayBuffer());
    assert.equal(createHash('sha256').update(body).digest('hex'), createHash('sha256').update(wasm).digest('hex'));
    const etag = r.headers.get('etag');
    assert.equal((await fetch(`${base}/godot.editor.wasm`, { headers: { 'If-None-Match': etag } })).status, 304);
  });

  test('로그인 전: 401, 잘못된 state는 거부', async () => {
    const b = new Browser();
    assert.equal((await b.fetch('/api/me')).status, 401);
    assert.equal((await b.fetch('/api/repos')).status, 401);
    assert.equal((await b.fetch('/gh/user')).status, 401);
    const r1 = await b.fetch('/auth/login');
    const authorize = new URL(r1.headers.get('Location'));
    assert.equal(authorize.searchParams.get('client_id'), 'cid');
    assert.equal(authorize.searchParams.get('redirect_uri'), `${base}/auth/callback`);
    const forged = await b.fetch(`/auth/callback?code=x&state=forged`);
    assert.equal(forged.status, 400);
    const other = new Browser(); // state 쿠키가 없는 다른 브라우저로 콜백
    const r2 = await b.fetch(r1.headers.get('Location'));
    assert.equal((await other.fetch(r2.headers.get('Location'))).status, 400);
  });

  test('로그인 → 사용자, 저장소 목록, 쿠키 속성', async () => {
    const b = new Browser();
    const r = await b.login();
    const cookie = r.headers.getSetCookie().find((c) => c.startsWith('__Host-gwe_sid='));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    const me = await (await b.fetch('/api/me')).json();
    assert.equal(me.user.login, 'tester');
    assert.equal(me.app_slug, 'gwe-test');
    assert.ok(!JSON.stringify(me).includes('ghu_'), '토큰이 응답에 없음');
    const repos = await (await b.fetch('/api/repos')).json();
    assert.deepEqual(repos.repos.map((x) => [x.full_name, x.default_branch, x.can_push]), [['tester/game', 'main', true]]);
    assert.equal(repos.install_url, 'https://github.com/apps/gwe-test/installations/new');
  });

  test('GitHub 대리 호출: 허용 경로만, 쓰기는 X-GWE와 같은 Origin 필요', async () => {
    const b = new Browser();
    await b.login();
    const repo = await b.fetch('/gh/repos/tester/game');
    assert.equal(repo.status, 200);
    assert.equal(repo.headers.get('cache-control'), 'no-store');
    assert.match(gh.lastAuthorization, /^Bearer ghu_user_/, '사용자 토큰으로 호출');
    const ref = await (await b.fetch('/gh/repos/tester/game/git/ref/heads/main')).json();
    const commit = await (await b.fetch(`/gh/repos/tester/game/git/commits/${ref.object.sha}`)).json();
    const tree = await b.fetch(`/gh/repos/tester/game/git/trees/${commit.tree.sha}?recursive=1&evil=1`);
    assert.equal(tree.status, 200);

    // 커밋 만들기 (blob → tree → commit → ref)
    const blob = await (await b.write('/gh/repos/tester/game/git/blobs', 'POST', { content: Buffer.from('print(1)').toString('base64'), encoding: 'base64' })).json();
    const t = await (await b.write('/gh/repos/tester/game/git/trees', 'POST', { base_tree: commit.tree.sha, tree: [{ path: 'a.gd', mode: '100644', type: 'blob', sha: blob.sha }] })).json();
    const c = await (await b.write('/gh/repos/tester/game/git/commits', 'POST', { message: 'via worker', tree: t.sha, parents: [ref.object.sha] })).json();
    const up = await b.write('/gh/repos/tester/game/git/refs/heads/main', 'PATCH', { sha: c.sha, force: false });
    assert.equal(up.status, 200);
    assert.equal(gh.text('a.gd'), 'print(1)');

    // 막혀야 하는 요청들
    assert.equal((await b.fetch('/gh/user/installations')).status, 403, '목록 밖 경로');
    assert.equal((await b.write('/gh/repos/tester/game', 'PATCH', { private: false })).status, 403, '저장소 설정 변경');
    assert.equal((await b.write('/gh/repos/tester/game/git/refs/heads/main', 'DELETE')).status, 403, '브랜치 삭제');
    assert.equal((await b.fetch('/gh/user/keys')).status, 403, '사용자 키 목록');
    assert.equal((await b.fetch('/gh/repos/tester/game/contents/a.gd')).status, 403, 'contents 읽기는 목록에 없음');
    const noHeader = await b.fetch('/gh/repos/tester/game/git/blobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noHeader.status, 403, 'X-GWE 없는 쓰기');
    assert.equal((await b.write('/gh/repos/tester/game/git/blobs', 'POST', {}, { Origin: 'https://evil.example' })).status, 403, '다른 Origin');
  });

  test('토큰이 만료되면 자동 갱신, 동시 요청이 와도 갱신은 한 번', async () => {
    const b = new Browser();
    await b.login();
    const before = oauth.refreshed;
    gh.expireUserTokens();
    const results = await Promise.all(Array.from({ length: 10 }, () => b.fetch('/gh/repos/tester/game')));
    assert.deepEqual(results.map((r) => r.status), Array(10).fill(200));
    assert.equal(oauth.refreshed - before, 1, 'refresh는 한 번만');
    assert.equal((await b.fetch('/api/me')).status, 200);
  });

  test('갱신할 수 없으면 401과 쿠키 삭제', async () => {
    const b = new Browser();
    await b.login();
    gh.expireUserTokens();
    oauth.refresh.clear(); // refresh 토큰 무효화
    const r = await b.fetch('/gh/repos/tester/game');
    assert.equal(r.status, 401);
    assert.ok(r.headers.getSetCookie().some((c) => c.startsWith('__Host-gwe_sid=;') && /Max-Age=0/.test(c)));
    assert.equal((await b.fetch('/api/me')).status, 401, '세션도 삭제됨');
  });

  test('로그아웃: POST + X-GWE만, 이후 401', async () => {
    const b = new Browser();
    await b.login();
    const sid = b.cookies.get('__Host-gwe_sid');
    assert.equal((await b.fetch('/auth/logout')).status, 405);
    assert.equal((await b.fetch('/auth/logout', { method: 'POST' })).status, 403);
    assert.equal((await b.write('/auth/logout', 'POST')).status, 204);
    assert.equal((await b.fetch('/api/me')).status, 401);
    const replay = new Browser();
    replay.cookies.set('__Host-gwe_sid', sid);
    assert.equal((await replay.fetch('/api/me')).status, 401, '삭제된 세션 쿠키 재사용 불가');
  });
});
