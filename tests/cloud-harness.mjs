// E2E 공용 준비물: 가짜 GitHub(OAuth) + 엔진 조각 미러(GitHub Pages 흉내) + 로컬 Worker(wrangler dev) + 헤드리스 Chromium
// 사용: const t = await startCloud({ name, ports, files }); await t.run(async () => { ... t.check(...) ... });
// 먼저: scripts/build-worker.sh && (cd worker && npm ci) && npm ci
// E2E_MIRROR=down 이면 닫힌 포트를 미러로 넣어 Worker 조각으로 대체되는지 확인할 수 있다

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeGitHub } from './fake-github.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, timeoutMs, intervalMs = 500) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(intervalMs);
  }
}

export const DEFAULT_PROJECT = {
  '.gitignore': '.godot/\n',
  'project.godot':
    'config_version=5\n\n[application]\n\nconfig/name="game"\nrun/main_scene="res://main.tscn"\nconfig/features=PackedStringArray("4.7", "GL Compatibility")\n\n[rendering]\n\nrenderer/rendering_method="gl_compatibility"\nrenderer/rendering_method.mobile="gl_compatibility"\n',
  'main.tscn': '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n',
};

/**
 * name: 결과 파일 접두사, ports: { web, gh, mirror }, files: 가짜 저장소의 첫 커밋
 */
export async function startCloud({ name = 'e2e', ports = { web: 8090, gh: 8091, mirror: 8092 }, files = DEFAULT_PROJECT, out = process.argv[2] } = {}) {
  const OUT = resolve(out ?? join(ROOT, 'test-results'));
  mkdirSync(OUT, { recursive: true });
  const BASE = `http://localhost:${ports.web}`;
  const GH = `http://localhost:${ports.gh}`;
  let failures = 0;
  const t0 = Date.now();
  const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);
  const check = (label, ok, detail = '') => {
    if (!ok) failures++;
    log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  };

  // 가짜 GitHub (OAuth 포함, User-Agent 없는 API 요청은 진짜처럼 거부)
  const gh = new FakeGitHub({ owner: 'tester', repo: 'game' });
  const oauth = gh.enableOAuth({ clientId: 'cid', clientSecret: 'csecret' });
  gh.requireUserAgent = true;
  gh.commit(files, 'Initial commit');
  await gh.listen(ports.gh);

  // 엔진 조각 미러 (CORS 허용, 요청 기록)
  const manifestPath = join(ROOT, 'dist-worker/engine/wasm-manifest.json');
  const originalManifest = readFileSync(manifestPath, 'utf8');
  const engineSha = JSON.parse(originalManifest).sha256;
  const mirrorDown = process.env.E2E_MIRROR === 'down';
  const mirrorHits = [];
  const mirror = createServer((req, res) => {
    const path = join(ROOT, 'dist-mirror', decodeURIComponent(new URL(req.url, 'http://x').pathname));
    mirrorHits.push(req.url);
    if (!path.startsWith(join(ROOT, 'dist-mirror')) || !existsSync(path)) {
      res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/wasm', 'Access-Control-Allow-Origin': '*' });
    createReadStream(path).pipe(res);
  });
  if (!mirrorDown) await new Promise((r) => mirror.listen(ports.mirror, r));
  writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(originalManifest), mirrors: [`http://localhost:${mirrorDown ? 9 : ports.mirror}/engine/${engineSha}/`] }));

  // 로컬 Worker
  const state = mkdtempSync(join(tmpdir(), `${name}-`));
  const vars = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret', GITHUB_APP_SLUG: 'gwe-test', GITHUB_API_BASE: GH, GITHUB_WEB_BASE: GH };
  const wrangler = spawn(
    join(ROOT, 'worker/node_modules/.bin/wrangler'),
    ['dev', '--port', String(ports.web), '--ip', '127.0.0.1', '--persist-to', state, '--show-interactive-dev-session=false', '--inspector-port', '0', ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])],
    { cwd: join(ROOT, 'worker'), env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let wranglerOut = '';
  wrangler.stdout.on('data', (d) => (wranglerOut += d));
  wrangler.stderr.on('data', (d) => (wranglerOut += d));
  const restore = () => {
    writeFileSync(manifestPath, originalManifest);
    mirror.close();
    gh.close();
    wrangler.kill('SIGINT');
    rmSync(state, { recursive: true, force: true });
  };
  const up = await waitFor(async () => {
    try {
      return (await fetch(`${BASE}/api/me`)).status === 401;
    } catch {
      return false;
    }
  }, 60000);
  if (!up) {
    console.error(wranglerOut);
    restore();
    throw new Error('wrangler dev가 시작되지 않았습니다');
  }

  // 브라우저
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 820 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleLines = [];
  const ghRequests = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => d.accept());
  page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on('requestfailed', (r) => consoleLines.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
  page.on('request', (r) => {
    if (r.url().startsWith(GH) && !r.url().includes('/login/oauth/')) ghRequests.push(r.url());
  });
  const ai = (expr, arg) => page.evaluate(expr, arg);

  /** 첫 접속 → GitHub 로그인 → 프로젝트 선택 → 에디터 준비까지 */
  async function loginAndOpen(query = '?autosave=3&poll=3&status=2') {
    await page.goto(`${BASE}/${query}`);
    await page.waitForSelector('#login[open]', { timeout: 30000 });
    await page.click('#login-go');
    await page.waitForSelector('#picker[open]', { timeout: 30000 });
    await page.click('#picker-open');
    await page.waitForSelector('body[data-ready="true"]', { timeout: Number(process.env.READY_TIMEOUT ?? 240000) });
    log('에디터 준비 완료');
  }

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
  async function mcpCall(token, tool, args = {}) {
    const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: tool, arguments: args } }) });
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

  /** 본문 실행 → 실패 시 진단 → 정리 → 종료 코드 */
  async function run(body) {
    try {
      await body();
    } catch (e) {
      failures++;
      log(`FAIL 예외: ${e.stack || e}`);
      const st = await page
        .evaluate(() => ({ loading: document.querySelector('#loading-text')?.textContent, controlled: !!navigator.serviceWorker?.controller, logs: window.__gwe?.logs?.query({ limit: 40 }).map((l) => `[${l.source}/${l.level}] ${l.text}`) }))
        .catch((err) => String(err));
      log(`페이지 상태: ${JSON.stringify(st)}`);
      await page.screenshot({ path: join(OUT, `${name}-failure.png`) }).catch(() => {});
    } finally {
      writeFileSync(join(OUT, `${name}-wrangler.log`), wranglerOut);
      writeFileSync(join(OUT, `${name}-console.log`), consoleLines.join('\n'));
      await browser.close().catch(() => {});
      restore();
    }
    log(failures ? `실패 ${failures}건` : '모두 통과');
    process.exit(failures ? 1 : 0);
  }

  return {
    OUT, BASE, GH, gh, oauth, page, context, ai, log, check, run, loginAndOpen, mcpToken, mcpCall,
    pageErrors, consoleLines, ghRequests, mirrorHits, mirrorDown,
    wranglerOut: () => wranglerOut,
  };
}
