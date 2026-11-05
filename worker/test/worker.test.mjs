// Worker 통합 테스트: wrangler dev(로컬, workerd) + 가짜 GitHub(OAuth 포함)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeGitHub } from '../../tests/fake-github.mjs';

const WORKER = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WebSocket = createRequire(import.meta.url)('ws');
let gh;
let oauth;
let wrangler;
let base;
let tmp;
let wasm;
let app;
let appKeyPem;

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
  gh.requireUserAgent = true; // Worker가 GitHub에 보내는 모든 요청에 User-Agent가 있어야 함
  // GitHub App 비공개 키: GitHub처럼 PKCS#1 PEM으로 (Worker가 PKCS#8로 바꿔 읽는지 확인)
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  appKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  app = gh.enableApp({ appId: '123', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), runnerRepo: 'tester/runner' });
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
    writeFileSync(join(assets, 'engine', `godot.editor.${n}.wasm`), wasm.subarray(i, i + 100_000));
    parts.push(`godot.editor.${n}.wasm`);
  }
  writeFileSync(join(assets, 'engine', 'wasm-manifest.json'), JSON.stringify({ size: wasm.length, sha256: createHash('sha256').update(wasm).digest('hex'), parts }));
  writeFileSync(join(assets, '_headers'), '/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n');

  const port = 18700 + Math.floor(Math.random() * 200);
  base = `http://localhost:${port}`;
  const vars = {
    GITHUB_CLIENT_ID: 'cid',
    GITHUB_CLIENT_SECRET: 'csecret',
    GITHUB_APP_SLUG: 'gwe-test',
    GITHUB_API_BASE: ghBase,
    GITHUB_WEB_BASE: ghBase,
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: appKeyPem.replace(/\n/g, '\\n'),
    RUNNER_REPO: 'tester/runner',
    RUNNER_WAIT_MS: '4000',
    RUNNER_POLL_MS: '300',
  };
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
    // 앱 설치 직후의 콜백(state 없음): code를 쓰지 않고 정상 로그인을 다시 시작
    const install = await new Browser().fetch('/auth/callback?code=x&installation_id=1&setup_action=install');
    assert.equal(install.status, 302);
    assert.equal(install.headers.get('Location'), '/auth/login');
    assert.equal(install.headers.getSetCookie().length, 0, '세션을 만들지 않음');
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

// ---------- MCP (Claude 연결) ----------

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const REDIRECT = 'http://localhost:9/callback';

/** MCP 클라이언트가 하는 일: 등록 → 승인 화면 → 허용 → GitHub 로그인 → code → 토큰 */
async function mcpConnect(b = new Browser(), { verifier = b64url(randomBytes(32)) } = {}) {
  const reg = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Test Claude', redirect_uris: [REDIRECT] }) });
  assert.equal(reg.status, 201);
  const client = await reg.json();
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'client-state', scope: 'mcp' });
  const consent = await b.fetch(`/oauth/authorize?${q}`);
  assert.equal(consent.status, 200);
  assert.match(await consent.text(), /Test Claude/);
  const allow = await b.fetch('/oauth/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `${q}&action=allow` });
  assert.equal(allow.status, 302);
  const gh1 = await b.fetch(allow.headers.get('Location'));
  const cb = await b.fetch(gh1.headers.get('Location'));
  assert.equal(cb.status, 302, await cb.clone().text());
  const back = new URL(cb.headers.get('Location'));
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get('state'), 'client-state');
  const code = back.searchParams.get('code');
  const tok = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: client.client_id });
  assert.equal(tok.status, 200);
  return { client, code, verifier, ...(await tok.json()) };
}

const tokenRequest = (params) => fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });

let rpcId = 0;
async function rpc(token, method, params = {}) {
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.ok(!body.error, JSON.stringify(body.error));
  return body.result;
}
const call = async (token, name, args = {}) => {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  const text = r.content?.[0]?.text;
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* 오류 문장 */
  }
  return { ...r, text, data };
};

/** 로그인한 브라우저 탭처럼 /live 에 붙는다 */
async function openTab(b, project = { owner: 'tester', repo: 'game', branch: 'main' }) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/live`, { headers: { Cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join('; '), Origin: base } });
  const messages = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    const w = waiters.findIndex((x) => x.pred(m));
    if (w >= 0) waiters.splice(w, 1)[0].resolve(m);
    else messages.push(m);
  });
  const next = (pred, ms = 10000) =>
    new Promise((resolve, reject) => {
      const i = messages.findIndex(pred);
      if (i >= 0) return resolve(messages.splice(i, 1)[0]);
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('메시지를 기다리다 시간 초과')), ms);
    });
  await new Promise((r, j) => {
    ws.on('open', r);
    ws.on('error', j);
  });
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, project, app: { kind: 'browser' }, tools: [] }));
  await next((m) => m.type === 'welcome');
  return { ws, next, send: (m) => ws.send(JSON.stringify(m)) };
}

describe('MCP (Claude 연결)', () => {
  test('메타데이터와 인증 요구', async () => {
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(prm.resource, `${base}/mcp`);
    const asm = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.deepEqual([asm.authorization_endpoint, asm.token_endpoint, asm.registration_endpoint], [`${base}/oauth/authorize`, `${base}/oauth/token`, `${base}/oauth/register`]);
    assert.deepEqual(asm.code_challenge_methods_supported, ['S256']);
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /resource_metadata="http:\/\/localhost:\d+\/\.well-known\/oauth-protected-resource"/);
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer nope.nope' } })).status, 401);
  });

  test('등록: 허용되지 않은 redirect_uri 거부, 위조한 client_id 거부', async () => {
    const bad = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }) });
    const { client_id } = await ok.json();
    const forged = client_id.replace(/\.[^.]+$/, '.AAAA');
    const r = await fetch(`${base}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(forged)}&redirect_uri=${encodeURIComponent('https://claude.ai/api/mcp/auth_callback')}&code_challenge=x&code_challenge_method=S256`);
    assert.equal(r.status, 400, '리다이렉트하지 않고 오류 화면');
    const other = await fetch(`${base}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(client_id)}&redirect_uri=${encodeURIComponent('http://localhost:1/x')}&code_challenge=x&code_challenge_method=S256`);
    assert.equal(other.status, 400, '등록하지 않은 redirect_uri');
  });

  test('승인 → 토큰, PKCE 검사, 코드 재사용 불가, 거부하면 access_denied', async () => {
    const c = await mcpConnect();
    assert.equal(c.token_type, 'Bearer');
    assert.ok(!c.access_token.includes('ghu_'), 'GitHub 토큰을 Claude에 주지 않음');
    const again = await tokenRequest({ grant_type: 'authorization_code', code: c.code, code_verifier: c.verifier, redirect_uri: REDIRECT, client_id: c.client.client_id });
    assert.equal((await again.json()).error, 'invalid_grant', '코드는 한 번만');

    // 틀린 verifier
    const b = new Browser();
    await assert.rejects(() => mcpConnectWithWrongVerifier(b));

    // 거부
    const reg = await (await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) })).json();
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: 'abc', code_challenge_method: 'S256', state: 's' });
    const deny = await b.fetch('/oauth/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `${q}&action=deny` });
    assert.equal(new URL(deny.headers.get('Location')).searchParams.get('error'), 'access_denied');
  });

  test('initialize, tools/list', async () => {
    const { access_token } = await mcpConnect();
    const init = await rpc(access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.protocolVersion, '2025-06-18');
    assert.equal(init.serverInfo.name, 'godot-web-editor');
    assert.match(init.instructions, /list_projects/);
    const notif = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' });
    assert.equal(notif.status, 202);
    const { tools } = await rpc(access_token, 'tools/list');
    const names = tools.map((t) => t.name);
    for (const n of ['get_status', 'read_file', 'write_files', 'screenshot', 'list_projects']) assert.ok(names.includes(n), n);
    assert.ok(tools.find((t) => t.name === 'write_files').inputSchema.properties.project, 'project 인자');
    assert.ok(!names.some((n) => /server|power|auto_stop/.test(n)), '전원 도구 없음');
  });

  test('탭이 없을 때: GitHub에 바로 (사용자 토큰), 에디터 전용 도구는 안내', async () => {
    const { access_token } = await mcpConnect();
    const lp = await call(access_token, 'list_projects');
    assert.deepEqual(lp.data.repositories.map((r) => r.project), ['tester/game@main']);
    const none = await call(access_token, 'read_file', { path: 'main.gd' });
    // 아직 연 프로젝트가 없는 새 사용자라면 project를 요구한다 (다른 테스트가 먼저 탭을 열었으면 그 프로젝트)
    if (none.isError) assert.match(none.text, /project 인자/);
    const read = await call(access_token, 'read_file', { path: 'main.gd', project: 'tester/game' });
    assert.equal(read.data.content, 'extends Node\n');
    const st = await call(access_token, 'get_status', { project: 'tester/game@main' });
    assert.equal(st.data.mode, 'github');
    assert.equal(st.data.editor_url, base);
    const w = await call(access_token, 'write_files', { project: 'tester/game@main', files: [{ path: 'from_claude.gd', content: 'extends Node\n# mcp\n' }], commit_message: 'Claude: 테스트' });
    assert.ok(!w.isError, w.text);
    assert.equal(gh.text('from_claude.gd'), 'extends Node\n# mcp\n');
    assert.match(gh.lastAuthorization, /^Bearer ghu_user_/, '커밋은 사용자 토큰으로');
    assert.equal(gh.lastCommitMessage(), 'Claude: 테스트');
    const shot = await call(access_token, 'screenshot', { project: 'tester/game@main' });
    assert.ok(shot.isError);
    assert.match(shot.text, /웹 에디터가 열려 있어야/);
    const bad = await call(access_token, 'read_file', { path: 'x', project: 'not a project' });
    assert.ok(bad.isError);
  });

  test('리프레시 토큰 회전', async () => {
    const c = await mcpConnect();
    const r1 = await (await tokenRequest({ grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: c.client.client_id })).json();
    assert.ok(r1.access_token && r1.refresh_token && r1.refresh_token !== c.refresh_token);
    assert.ok((await rpc(r1.access_token, 'tools/list')).tools.length > 0);
    const reuse = await (await tokenRequest({ grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: c.client.client_id })).json();
    assert.equal(reuse.error, 'invalid_grant', '한 번 쓴 리프레시 토큰은 무효');
    const oldAccess = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${c.access_token}`, 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    assert.equal(oldAccess.status, 401, '이전 접근 토큰도 무효');
  });

  test('열린 탭으로 전달: 호출 → 탭 응답 → 결과, 탭 목록, 끊기면 GitHub로', async () => {
    const b = new Browser();
    await b.login();
    // 로그인 안 한 연결, 다른 Origin은 거부
    const anon = new WebSocket(`${base.replace('http', 'ws')}/live`, { headers: { Origin: base } });
    const anonStatus = await new Promise((r) => anon.on('unexpected-response', (_q, res) => r(res.statusCode)).on('open', () => r(101)));
    assert.equal(anonStatus, 401);
    const evil = new WebSocket(`${base.replace('http', 'ws')}/live`, { headers: { Origin: 'https://evil.example', Cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    assert.equal(await new Promise((r) => evil.on('unexpected-response', (_q, res) => r(res.statusCode)).on('open', () => r(101))), 403);

    const tab = await openTab(b);
    tab.send({ type: 'ping' });
    assert.equal((await tab.next((m) => m.type === 'pong')).type, 'pong', '자동 pong');
    tab.send({ type: 'state', bridgeReady: true, syncPhase: 'idle', head: 'abc', visible: true });

    const { access_token } = await mcpConnect();
    const pending = call(access_token, 'get_editor_state');
    const msg = await tab.next((m) => m.type === 'call');
    assert.equal(msg.name, 'get_editor_state');
    tab.send({ type: 'result', id: msg.id, content: [{ type: 'text', text: JSON.stringify({ current_scene: 'main.tscn' }) }] });
    const r = await pending;
    assert.equal(r.data.current_scene, 'main.tscn', '탭이 처리한 결과');

    const shotP = call(access_token, 'screenshot', {});
    const shotMsg = await tab.next((m) => m.type === 'call' && m.name === 'screenshot');
    tab.send({ type: 'result', id: shotMsg.id, content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] });
    assert.equal((await shotP).content[0].type, 'image');

    const lp = await call(access_token, 'list_projects');
    assert.equal(lp.data.editor_tabs.length, 1);
    assert.equal(lp.data.editor_tabs[0].project, 'tester/game@main');
    assert.equal(lp.data.editor_tabs[0].editor_ready, true);
    assert.equal(lp.data.default_project, 'tester/game@main');

    // 다른 프로젝트를 지정하면 탭으로 가지 않음 (탭은 tester/game@main)
    const otherBranch = await call(access_token, 'get_status', { project: 'tester/game@dev' });
    assert.ok(otherBranch.isError || otherBranch.data.mode === 'github');

    // 탭이 응답 중에 끊기면 오류, 이후에는 마지막 프로젝트로 GitHub 처리
    const cut = call(access_token, 'get_editor_state');
    await tab.next((m) => m.type === 'call');
    tab.ws.close();
    const cutR = await cut;
    assert.ok(cutR.isError);
    assert.match(cutR.text, /연결이 끊겼습니다/);
    await new Promise((r) => setTimeout(r, 300));
    const after = await call(access_token, 'get_status');
    assert.equal(after.data.mode, 'github', '탭이 없으면 마지막 프로젝트로 GitHub');
    assert.equal(after.data.repository, 'tester/game');
  });
});

async function mcpConnectWithWrongVerifier(b) {
  const verifier = b64url(randomBytes(32));
  const c = await mcpConnect(b, { verifier }).catch(() => null);
  if (!c) throw new Error('connect failed');
  const reg = await (await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) })).json();
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's' });
  const allow = await b.fetch('/oauth/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `${q}&action=allow` });
  const gh1 = await b.fetch(allow.headers.get('Location'));
  const cb = await b.fetch(gh1.headers.get('Location'));
  const code = new URL(cb.headers.get('Location')).searchParams.get('code');
  const tok = await (await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: 'wrong-verifier', redirect_uri: REDIRECT, client_id: reg.client_id })).json();
  if (tok.error === 'invalid_grant') throw new Error('rejected as expected');
  return tok;
}

describe('테스트 실행기 (GitHub Actions / 브라우저)', () => {
  test('탭이 없으면 Actions: 앱 토큰(실행기 저장소만, actions:write)으로 실행, 결과 읽기', async () => {
    const { access_token } = await mcpConnect();
    const before = app.issued.length;
    app.onDispatch = (run) => setTimeout(() => run.complete({ ok: true, mode: 'test', passed: 2, total: 2, failures: [] }), 500);
    const r = await call(access_token, 'run_tests', { project: 'tester/game@main', filter: 'chess' });
    assert.ok(!r.isError, r.text);
    assert.equal(r.data.where, 'github-actions');
    assert.equal(r.data.passed, 2);
    assert.equal(r.data.commit, gh.head());
    assert.equal(r.data.project, 'tester/game@main');
    const d = app.dispatches.at(-1);
    assert.deepEqual({ repo: d.inputs.repo, sha: d.inputs.sha, mode: d.inputs.mode, filter: d.inputs.filter, ref: d.ref }, { repo: 'tester/game', sha: gh.head(), mode: 'test', filter: 'chess', ref: 'main' });
    const issued = app.issued.slice(before);
    assert.ok(issued.length >= 1);
    assert.deepEqual(issued[0].repositories, ['runner'], '실행기 저장소 하나만');
    assert.deepEqual(issued[0].permissions, { actions: 'write' });
    assert.ok(!JSON.stringify(d.inputs).includes('ghu_'), '사용자 토큰을 Actions에 넘기지 않음');
  });

  test('오래 걸리면 request_id → 다시 호출해서 결과 받기, 잘못된 filter 거부', async () => {
    const { access_token } = await mcpConnect();
    let pending = null;
    app.onDispatch = (run) => (pending = run);
    const first = await call(access_token, 'check_scripts', { project: 'tester/game' });
    assert.equal(first.data.status, 'running', first.text);
    assert.ok(first.data.request_id);
    assert.equal(app.dispatches.at(-1).inputs.mode, 'check');
    pending.complete({ ok: false, mode: 'check', files: 3, errors: [{ path: 'res://a.gd', line: 2, message: 'Parse Error' }] });
    const second = await call(access_token, 'check_scripts', { request_id: first.data.request_id });
    assert.equal(second.data.status, 'completed');
    assert.equal(second.data.errors[0].line, 2);
    const bad = await call(access_token, 'run_tests', { project: 'tester/game', filter: '$(rm -rf /)' });
    assert.ok(bad.isError);
    const badId = await call(access_token, 'run_tests', { request_id: '../../x' });
    assert.ok(badId.isError);
  });

  test('에디터 탭이 열려 있으면 브라우저로 (Actions 실행 없음)', async () => {
    const b = new Browser();
    await b.login();
    const tab = await openTab(b);
    const { access_token } = await mcpConnect();
    const dispatchesBefore = app.dispatches.length;
    const p = call(access_token, 'run_tests', { filter: 'x' });
    const msg = await tab.next((m) => m.type === 'call');
    assert.equal(msg.name, 'run_tests');
    assert.deepEqual(msg.arguments, { filter: 'x' });
    tab.send({ type: 'result', id: msg.id, content: [{ type: 'text', text: JSON.stringify({ ok: true, where: 'browser', passed: 1, total: 1 }) }] });
    const r = await p;
    assert.equal(r.data.where, 'browser');
    assert.equal(app.dispatches.length, dispatchesBefore);
    tab.ws.close();
  });
});
