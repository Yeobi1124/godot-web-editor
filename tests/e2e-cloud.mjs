// E2E 테스트 (클라우드 버전): wrangler dev(로컬 Worker) + 가짜 GitHub(OAuth) + 실제 Godot 웹 에디터
// GitHub 로그인 → 프로젝트 선택 → 에디터 → 자동 커밋(사용자 토큰) → 원격 반영 → 토큰 갱신
// → MCP(Claude) 연결: 열린 에디터 조종(상태, 파일 쓰기, 스크린샷) → 로그아웃
// 사용법: scripts/build-worker.sh && (cd worker && npm ci) && node tests/e2e-cloud.mjs [스크린샷 폴더]
// 필요: playwright (전역 설치 또는 NODE_PATH)

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeGitHub } from './fake-github.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.argv[2] ?? join(ROOT, 'test-results'));
mkdirSync(OUT, { recursive: true });
const WEB_PORT = 8090;
const GH_PORT = 8091;
const BASE = `http://localhost:${WEB_PORT}`;
const GH = `http://localhost:${GH_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const t0 = Date.now();
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);
function check(name, ok, detail = '') {
  if (!ok) failures++;
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
async function waitFor(fn, timeoutMs, intervalMs = 500) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(intervalMs);
  }
}

// ---------- 가짜 GitHub (OAuth 포함) ----------
const gh = new FakeGitHub({ owner: 'tester', repo: 'game' });
const oauth = gh.enableOAuth({ clientId: 'cid', clientSecret: 'csecret' });
gh.commit(
  {
    '.gitignore': '.godot/\n',
    'project.godot': 'config_version=5\n\n[application]\n\nconfig/name="game"\nrun/main_scene="res://main.tscn"\nconfig/features=PackedStringArray("4.7", "GL Compatibility")\n\n[rendering]\n\nrenderer/rendering_method="gl_compatibility"\nrenderer/rendering_method.mobile="gl_compatibility"\n',
    'main.tscn': '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n',
  },
  'Initial commit',
);
await gh.listen(GH_PORT);

// ---------- 로컬 Worker ----------
const state = mkdtempSync(join(tmpdir(), 'e2e-cloud-'));
const vars = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret', GITHUB_APP_SLUG: 'gwe-test', GITHUB_API_BASE: GH, GITHUB_WEB_BASE: GH };
const wrangler = spawn(
  join(ROOT, 'worker/node_modules/.bin/wrangler'),
  ['dev', '--port', String(WEB_PORT), '--ip', '127.0.0.1', '--persist-to', state, '--show-interactive-dev-session=false', '--inspector-port', '0',
    ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])],
  { cwd: join(ROOT, 'worker'), env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
);
let wranglerOut = '';
wrangler.stdout.on('data', (d) => (wranglerOut += d));
wrangler.stderr.on('data', (d) => (wranglerOut += d));
const up = await waitFor(async () => {
  try {
    return (await fetch(`${BASE}/api/me`)).status === 401;
  } catch {
    return false;
  }
}, 60000);
if (!up) {
  console.error(wranglerOut);
  throw new Error('wrangler dev가 시작되지 않았습니다');
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1400, height: 820 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('dialog', (d) => d.accept());
const consoleLines = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on('worker', (w) => {
  consoleLines.push(`[worker] ${w.url()}`);
  w.on('close', () => consoleLines.push(`[worker-close] ${w.url()}`));
  w.on('console', (m) => consoleLines.push(`[worker-console] ${m.text()}`));
});
page.on('requestfailed', (r) => consoleLines.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => {
  if (r.url().includes('godot.editor')) consoleLines.push(`[response] ${r.status()} ${r.url()} ${JSON.stringify(r.headers())}`);
});
const ghRequests = [];
page.on('request', (r) => {
  if (r.url().startsWith(GH) && !r.url().includes('/login/oauth/')) ghRequests.push(r.url());
});
const ai = (expr) => page.evaluate(expr);

/** MCP 클라이언트 흉내: 등록 → 승인 → GitHub 로그인(가짜) → code → 토큰. 쿠키는 따로 (Claude 쪽 브라우저) */
async function mcpToken() {
  const jar = new Map();
  const go = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    if (url.startsWith(BASE) && jar.size) headers.set('Cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await fetch(url.startsWith('http') ? url : BASE + url, { ...init, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [k, v] = c.split(';')[0].split('=');
      jar.set(k, v);
    }
    return res;
  };
  const redirect = 'http://localhost:9/cb';
  const client = await (await fetch(`${BASE}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'e2e Claude', redirect_uris: [redirect] }) })).json();
  const verifier = randomBytes(32).toString('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 's' });
  const allow = await go('/oauth/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `${q}&action=allow` });
  const ghRes = await go(allow.headers.get('Location'));
  const cb = await go(ghRes.headers.get('Location'));
  const code = new URL(cb.headers.get('Location')).searchParams.get('code');
  const tok = await (await fetch(`${BASE}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect, client_id: client.client_id }) })).json();
  return tok.access_token;
}
let rpcId = 0;
async function mcpCall(token, name, args = {}) {
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  const { result } = await res.json();
  const text = result?.content?.[0]?.text;
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* 이미지나 오류 문장 */
  }
  return { ...result, data };
}

try {
  // 1. 첫 접속: 로그인 화면 (새로고침 우회 없이 cross-origin isolation)
  await page.goto(`${BASE}/?autosave=3&poll=3&status=2`);
  await page.waitForSelector('#login[open]', { timeout: 30000 });
  check('첫 접속 시 로그인 화면', true);
  const iso = await ai(() => ({ isolated: window.crossOriginIsolated, reloaded: sessionStorage.getItem('gwe:coi-reloaded') }));
  check('서버 헤더로 바로 cross-origin isolated (새로고침 없음)', iso.isolated === true && iso.reloaded === null, JSON.stringify(iso));
  check('토큰 입력 화면은 나오지 않음', !(await page.isVisible('#setup[open]')));

  // 2. GitHub 로그인 → 프로젝트 선택
  await page.click('#login-go');
  await page.waitForSelector('#picker[open]', { timeout: 30000 });
  const picker = await ai(() => ({
    user: document.querySelector('#picker-user').textContent,
    repos: [...document.querySelectorAll('#picker-list input')].map((i) => [i.value, i.checked]),
    branch: document.querySelector('#picker-branch').value,
    install: document.querySelector('#picker-install').href,
  }));
  check('프로젝트 선택 화면 (사용자, 저장소, 기본 브랜치)', picker.user.includes('@tester') && picker.repos[0]?.[0] === 'tester/game' && picker.repos[0]?.[1] && picker.branch === 'main', JSON.stringify(picker));
  check('앱 설치 링크', picker.install === 'https://github.com/apps/gwe-test/installations/new');
  await page.screenshot({ path: join(OUT, 'cloud-picker.png') });
  await page.click('#picker-open');
  await page.waitForSelector('body[data-ready="true"]', { timeout: Number(process.env.READY_TIMEOUT ?? 240000) });
  log('에디터 준비 완료');
  const viaWorker = (wranglerOut.match(/GET \/godot\.editor\.wasm/g) ?? []).length;
  check('엔진은 서비스 워커가 조각을 직접 받아 이어 붙임 (Worker 이어 붙이기 경로 안 씀)', viaWorker === 0, `Worker 경로 요청 ${viaWorker}회`);

  const secrets = await ai(() => ({ cookie: document.cookie, local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage) }));
  check('세션 쿠키와 GitHub 토큰이 페이지 JS에 보이지 않음', !/gwe_sid|ghu_|ghr_/.test(JSON.stringify(secrets)), JSON.stringify(secrets).slice(0, 200));
  check('브라우저가 GitHub에 직접 요청하지 않음', ghRequests.length === 0, ghRequests.slice(0, 3).join(', '));
  check('MCP 수동 설정 칸 숨김', await ai(() => document.querySelector('#mcp-section').hidden));
  const status = await ai(() => window.godotAI.status());
  check('에디터 브리지 연결, 메인 씬 인식', status.editor_ready === true && status.editor?.main_scene === 'main.tscn', JSON.stringify(status.editor));

  // 3. 파일 쓰기 → 자동 커밋 (사용자 토큰)
  const pushedAddon = await waitFor(() => gh.text('addons/web_editor_bridge/plugin.gd'), 30000);
  check('브리지 애드온이 Worker를 거쳐 커밋됨', !!pushedAddon);
  const w = await ai(() => window.godotAI.writeFiles([{ path: 'hello.gd', content: 'extends Node\n# from cloud\n' }], 'cloud e2e'));
  check('AI 쓰기 성공', w.written?.length === 1, JSON.stringify(w));
  const pushed = await waitFor(() => gh.text('hello.gd')?.includes('from cloud'), 30000);
  check('변경이 자동 커밋됨', !!pushed, gh.lastCommitMessage()?.split('\n')[0]);
  check('커밋에 쓰인 인증은 사용자 토큰', /^Bearer ghu_user_/.test(gh.lastAuthorization ?? ''), gh.lastAuthorization?.slice(0, 20));

  // 4. 원격 변경 반영
  gh.commit({ 'remote.gd': 'extends Node\n# remote\n' }, 'remote change');
  const pulled = await waitFor(async () => (await ai(() => window.godotAI.readFile('remote.gd').catch(() => null)))?.content?.includes('# remote'), 30000);
  check('원격 커밋이 에디터에 반영됨', !!pulled);

  // 5. 토큰 만료 → Worker가 자동 갱신, 저장 계속 동작
  const refreshedBefore = oauth.refreshed;
  gh.expireUserTokens();
  await ai(() => window.godotAI.writeFiles([{ path: 'after_refresh.gd', content: 'extends Node\n' }], 'after refresh'));
  const afterRefresh = await waitFor(() => gh.text('after_refresh.gd'), 30000);
  check('토큰 만료 후에도 저장 성공 (자동 갱신)', !!afterRefresh && oauth.refreshed > refreshedBefore, `refresh ${oauth.refreshed - refreshedBefore}회`);

  await ai(() => window.godotAI.setMainScreen('2D'));
  await sleep(1000);
  await page.screenshot({ path: join(OUT, 'cloud-editor.png') });

  // 6. MCP(Claude) 연결 → 열린 에디터를 조종
  const badge = await waitFor(() => ai(() => document.querySelector('#mcp-badge').dataset.state === 'connected'), 20000);
  check('에디터가 Worker(/live)에 자동 연결 (설정 없이)', !!badge);
  const token = await mcpToken();
  check('MCP 토큰 발급 (GitHub 로그인)', typeof token === 'string' && token.includes('.'));
  const mst = await mcpCall(token, 'get_status');
  check('MCP get_status → 열린 에디터가 응답', mst.data?.editor_ready === true && mst.data?.repository === 'tester/game', JSON.stringify(mst.data ?? mst).slice(0, 160));
  const mw = await mcpCall(token, 'write_files', { files: [{ path: 'from_mcp.gd', content: 'extends Node\n# claude\n' }], commit_message: 'Claude: MCP e2e' });
  check('MCP write_files 성공', !mw.isError && mw.data?.written?.includes('from_mcp.gd'), JSON.stringify(mw.data ?? mw).slice(0, 160));
  const inEditor = await ai(() => window.godotAI.readFile('from_mcp.gd').then((r) => r.content));
  check('Claude가 쓴 파일이 열린 에디터에 바로 반영', inEditor?.includes('# claude'));
  const mcpCommitted = await waitFor(() => gh.text('from_mcp.gd')?.includes('# claude'), 45000);
  check('에디터 자동 저장으로 커밋 (본인 토큰)', !!mcpCommitted && /^Bearer ghu_user_/.test(gh.lastAuthorization ?? ''), gh.lastCommitMessage()?.split('\n')[0]);
  await mcpCall(token, 'set_main_screen', { name: '2D' });
  const shot = await mcpCall(token, 'screenshot', { max_width: 800 });
  check('MCP screenshot → 에디터 화면 PNG', shot.content?.[0]?.type === 'image' && shot.content[0].data.length > 1000);
  if (shot.content?.[0]?.data) writeFileSync(join(OUT, 'cloud-mcp-screenshot.png'), Buffer.from(shot.content[0].data, 'base64'));
  const calls = await ai(() => document.querySelectorAll('#mcp-calls li').length);
  check('AI 패널에 MCP 호출 기록', calls >= 3, `${calls}건`);

  // 7. 테스트 실행과 스크립트 검사 (브라우저 안의 Godot)
  const runnerInstalled = await waitFor(() => gh.text('addons/web_editor_bridge/runner/gwe_runner.gd'), 30000);
  check('실행기 스크립트가 브리지 애드온과 함께 설치됨', !!runnerInstalled);
  await mcpCall(token, 'write_files', {
    files: [
      { path: 'tests/test_demo.gd', content: 'extends RefCounted\n\nfunc test_pass(t):\n\tt.eq(1 + 1, 2, "덧셈")\n\nfunc test_fail(t):\n\tt.ok(false, "일부러 실패")\n' },
    ],
  });
  const rt = await mcpCall(token, 'run_tests');
  check(
    'MCP run_tests → 통과 1, 실패 1 (브라우저)',
    rt.data?.where === 'browser' && rt.data?.total === 2 && rt.data?.passed === 1 && rt.data?.failures?.[0]?.message === '일부러 실패',
    JSON.stringify(rt.data ?? rt).slice(0, 240),
  );
  const filtered = await mcpCall(token, 'run_tests', { filter: 'nothing_matches' });
  check('filter로 대상 줄이기', filtered.data?.total === 0, JSON.stringify(filtered.data ?? filtered).slice(0, 160));
  const cs1 = await mcpCall(token, 'check_scripts');
  check('MCP check_scripts → 오류 없음', cs1.data?.ok === true && cs1.data?.files >= 1, JSON.stringify(cs1.data ?? cs1).slice(0, 200));
  await mcpCall(token, 'write_files', { files: [{ path: 'broken.gd', content: 'extends Node\nfunc _ready(:\n\tpass\n' }] });
  const cs2 = await mcpCall(token, 'check_scripts');
  check(
    'MCP check_scripts → 문법 오류 파일·줄 보고',
    cs2.data?.ok === false && cs2.data?.errors?.some((e) => e.path === 'res://broken.gd' && e.line === 2),
    JSON.stringify(cs2.data ?? cs2).slice(0, 240),
  );
  const afterRun = await mcpCall(token, 'get_editor_state');
  check('실행 후 게임이 종료됨', afterRun.data?.playing === false, JSON.stringify(afterRun.data ?? afterRun).slice(0, 120));
  await mcpCall(token, 'delete_files', { paths: ['broken.gd', 'tests/test_demo.gd'] });

  // 8. 로그아웃 → 다시 로그인 화면
  await page.click('#btn-settings');
  await page.click('#btn-logout');
  await page.waitForSelector('#login[open]', { timeout: 60000 });
  const meAfter = await page.evaluate(() => fetch('/api/me').then((r) => r.status));
  check('로그아웃 후 로그인 화면, 세션 없음', meAfter === 401);

  check('페이지 오류 없음', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  failures++;
  log(`FAIL 예외: ${e.stack || e}`);
  const state = await page
    .evaluate(async () => {
      const timed = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r('timeout'), 15000))]);
      const viaSw = await timed(fetch('/godot.editor.wasm').then((r) => r.arrayBuffer()).then((b) => b.byteLength).catch((e) => String(e)));
      const keys = await caches.keys();
      return { iso: crossOriginIsolated, hwc: navigator.hardwareConcurrency, sab: typeof SharedArrayBuffer, loading: document.querySelector('#loading-text')?.textContent, app: Object.keys(window.__gwe ?? {}), controlled: !!navigator.serviceWorker?.controller, viaSw, keys };
    })
    .catch((err) => String(err));
  log(`페이지 상태: ${JSON.stringify(state)}`);
  await page.screenshot({ path: join(OUT, 'cloud-failure.png') }).catch(() => {});
} finally {
  writeFileSync(join(OUT, 'cloud-wrangler.log'), wranglerOut);
  writeFileSync(join(OUT, 'cloud-console.log'), consoleLines.join('\n'));
  await browser.close();
  wrangler.kill('SIGINT');
  gh.close();
  rmSync(state, { recursive: true, force: true });
}

log(failures ? `실패 ${failures}건` : '모두 통과');
process.exit(failures ? 1 : 0);
