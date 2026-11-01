// MCP E2E: MCP 클라이언트 -> 중계 서버 -> 실제 Godot 웹 에디터(헤드리스 Chromium) 경로 검증과 지연 측정
// 사용법: scripts/build.sh && (cd mcp-server && npm install) && node tests/e2e-mcp.mjs [스크린샷 폴더]

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeGitHub } from './fake-github.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(join(ROOT, 'mcp-server', 'package.json'));
const { Client } = await import(req.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { StreamableHTTPClientTransport } = await import(req.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'));
const { createRelay } = await import('../mcp-server/src/server.js');
const { parseProject } = await import('../mcp-server/src/config.js');
const { chromium } = createRequire(import.meta.url)('playwright');

const OUT = resolve(process.argv[2] ?? join(ROOT, 'test-results'));
mkdirSync(OUT, { recursive: true });
const WEB_PORT = 8080;
const GH_PORT = 8081;
const RELAY_PORT = 8082;
const RELAY = `http://localhost:${RELAY_PORT}`;
const CLI_TOKEN = 'cli-token-e2e-0123456789';
const PAIRING = 'pairing-token-e2e-0123';

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
    if (v || Date.now() > end) return v;
    await sleep(intervalMs);
  }
}

const gh = new FakeGitHub();
const MAIN = '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n\n[node name="Box" type="ColorRect" parent="."]\noffset_left = 80.0\noffset_top = 80.0\noffset_right = 240.0\noffset_bottom = 180.0\ncolor = Color(0.9, 0.35, 0.25, 1)\n';
gh.commit(
  {
    '.gitignore': '.godot/\n',
    'project.godot':
      'config_version=5\n\n[application]\n\nconfig/name="game"\nrun/main_scene="res://main.tscn"\nconfig/features=PackedStringArray("4.7", "GL Compatibility")\n\n[rendering]\n\nrenderer/rendering_method="gl_compatibility"\nrenderer/rendering_method.mobile="gl_compatibility"\n',
    'main.tscn': MAIN,
  },
  'Initial commit',
);
await gh.listen(GH_PORT);
const relay = createRelay({
  port: RELAY_PORT,
  host: '127.0.0.1',
  publicUrl: RELAY,
  adminPassword: 'admin-password-e2e',
  cliToken: CLI_TOKEN,
  pairingToken: PAIRING,
  allowedOrigins: [],
  githubToken: 'test-token',
  defaultProject: parseProject('tester/game@main'),
  githubApiBase: `http://localhost:${GH_PORT}`,
  dataDir: mkdtempSync(join(tmpdir(), 'relay-e2e-')),
  extraRedirectUris: [],
});
await relay.listen(RELAY_PORT, '127.0.0.1');
const web = spawn(process.execPath, [join(ROOT, 'tools/serve.mjs'), String(WEB_PORT), join(ROOT, 'dist')], { stdio: 'ignore' });
await sleep(500);

const client = new Client({ name: 'e2e', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${RELAY}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${CLI_TOKEN}` } } }));
const timings = {};
async function call(name, args = {}) {
  const s = performance.now();
  const r = await client.callTool({ name, arguments: args });
  const ms = Math.round(performance.now() - s);
  (timings[name] ??= []).push(ms);
  return r;
}
const json = (r) => JSON.parse(r.content[0].text);

const HEADFUL = process.env.HEADFUL === '1';
const browser = await chromium.launch({
  headless: !HEADFUL,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  // 실제 브라우저처럼 숨겨진 창의 절전(타이머 제한, 렌더링 중단)을 켜 둔다 (Playwright 기본값은 꺼 둠)
  ...(HEADFUL ? { ignoreDefaultArgs: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'] } : {}),
});
const context = await browser.newContext({ viewport: { width: 1400, height: 820 } });
await context.addInitScript(([relay, token]) => {
  localStorage.setItem('gwe:mcp', JSON.stringify({ url: relay, token }));
}, [RELAY, PAIRING]);
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

try {
  // 에디터 열기 (설정 화면 -> 저장소 연결)
  await page.goto(`http://localhost:${WEB_PORT}/?api=http://localhost:${GH_PORT}&autosave=3&poll=3&status=2`);
  await page.fill('#setup-repo', 'tester/game');
  await page.fill('#setup-token', 'test-token');
  await page.click('#setup-form button[type=submit]');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 240000 });
  log('에디터 준비 완료');

  const tabs = await waitFor(async () => {
    const p = json(await call('list_projects'));
    return p.editor_tabs.find((t) => t.editor_ready) ? p : null;
  }, 20000);
  check('에디터 탭이 중계 서버에 연결됨', !!tabs, JSON.stringify(tabs?.editor_tabs));
  check('상단에 MCP 연결 표시', (await page.getAttribute('#mcp-badge', 'data-state')) === 'connected');

  const status = json(await call('get_status'));
  check('get_status가 에디터 모드', status.mode === 'editor' && status.editor_ready === true, `${status.repository} ${status.head_commit?.slice(0, 7)}`);

  // MCP로 씬 수정 -> 에디터 반영 -> 자동 커밋
  const scene = json(await call('read_file', { path: 'main.tscn' })).content;
  const added = `${scene}\n[node name="ViaMCP" type="ColorRect" parent="."]\noffset_left = 400.0\noffset_top = 250.0\noffset_right = 600.0\noffset_bottom = 330.0\ncolor = Color(0.25, 0.55, 0.95, 1)\n`;
  await call('open_scene', { path: 'main.tscn' });
  const w = json(await call('write_files', { files: [{ path: 'main.tscn', content: added }], commit_message: 'Claude: 파란 사각형 추가' }));
  check('MCP write_files', w.written?.includes('main.tscn'), JSON.stringify(w));
  const committed = await waitFor(() => gh.text('main.tscn')?.includes('ViaMCP'), 20000);
  check('MCP 변경이 GitHub에 자동 커밋됨', !!committed, gh.lastCommitMessage()?.split('\n')[0]);
  const st = json(await call('get_editor_state'));
  check('에디터 상태 조회', st.current_scene === 'main.tscn', JSON.stringify(st));

  await call('set_main_screen', { name: '2D' });
  await sleep(1000);
  const shot = await call('screenshot', { max_width: 1024 });
  const img = shot.content.find((c) => c.type === 'image');
  check('MCP 스크린샷이 이미지로 옴', !!img, img ? `${img.mimeType}, base64 ${Math.round(img.data.length / 1024)}KB` : JSON.stringify(shot).slice(0, 200));
  if (img) writeFileSync(join(OUT, 'mcp-1-screenshot.png'), Buffer.from(img.data, 'base64'));

  await call('run_project');
  const playing = await waitFor(async () => json(await call('get_editor_state')).playing, 30000);
  check('MCP로 게임 실행', !!playing);
  await sleep(3000);
  await call('stop_project');
  const logs = json(await call('get_logs', { limit: 20 }));
  check('MCP로 로그 조회', Array.isArray(logs.lines) && logs.lines.length > 0, `${logs.lines.length}줄`);

  // 지연 측정 (같은 도구 여러 번)
  for (let i = 0; i < 5; i++) {
    await call('get_editor_state');
    await call('read_file', { path: 'project.godot' });
  }

  // 에디터 탭이 백그라운드일 때 (HEADFUL=1이면 창을 최소화해서 실제로 숨김 상태를 만든다)
  let other = null;
  let cdp = null;
  let windowId = null;
  if (process.env.HEADFUL === '1') {
    cdp = await context.newCDPSession(page);
    ({ windowId } = await cdp.send('Browser.getWindowForTarget'));
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  } else {
    other = await context.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
  }
  await sleep(1500);
  const vis = await page.evaluate(() => document.visibilityState);
  log(`에디터 탭 visibilityState = ${vis}`);
  const bgStart = performance.now();
  const bgWrite = await call('write_files', { files: [{ path: 'notes/bg.txt', content: 'written while hidden' }] });
  const bgShot = await call('screenshot', { max_width: 640 });
  const bgMs = Math.round(performance.now() - bgStart);
  check('백그라운드 탭에서도 쓰기/스크린샷 응답', !bgWrite.isError && !bgShot.isError, `${bgMs}ms, visibility=${vis}`);
  const bgCommitted = await waitFor(() => gh.text('notes/bg.txt') === 'written while hidden', 20000);
  check('백그라운드 탭에서 쓴 파일도 자동 커밋', !!bgCommitted);
  if (vis === 'hidden') {
    // 숨김 상태에서 30초 이상 지난 뒤에도 호출이 응답하는지 (브라우저의 백그라운드 타이머 제한)
    await sleep(35000);
    const late = await call('read_file', { path: 'notes/bg.txt' });
    check('숨김 35초 뒤에도 응답', !late.isError && json(late).content === 'written while hidden', `${timings.read_file.at(-1)}ms`);
    const remote = gh.commit({ 'notes/remote-while-hidden.txt': 'from remote' }, 'remote while hidden');
    const appliedHidden = await waitFor(async () => {
      const r = await call('read_file', { path: 'notes/remote-while-hidden.txt' });
      return !r.isError;
    }, 60000, 2000);
    check('숨김 상태에서도 원격 변경 반영(주기 확인이 늦어질 수 있음)', !!appliedHidden, remote.slice(0, 7));
  }
  if (cdp) await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await page.bringToFront();
  await other?.close();

  // 탭을 닫으면 GitHub 대체 처리
  await page.close();
  await sleep(1000);
  const s2 = json(await call('get_status'));
  check('탭을 닫으면 GitHub 모드로 전환', s2.mode === 'github', s2.mode);
  await call('write_files', { files: [{ path: 'notes/direct.txt', content: 'direct to github' }], commit_message: '에디터 없이 MCP로 직접' });
  check('탭 없이 GitHub에 직접 커밋', gh.text('notes/direct.txt') === 'direct to github', gh.lastCommitMessage()?.split('\n')[0]);
  const noEditor = await call('screenshot');
  check('탭 없을 때 에디터 도구는 안내 오류', noEditor.isError === true);

  check('페이지 JS 오류 없음', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  console.log('\n도구별 왕복 시간(ms) — MCP 클라이언트 -> 중계 서버 -> 에디터 탭 -> 응답 (같은 컴퓨터, 네트워크 지연 없음)');
  for (const [name, list] of Object.entries(timings)) {
    const sorted = [...list].sort((a, b) => a - b);
    console.log(`  ${name.padEnd(18)} n=${String(list.length).padStart(2)}  중앙값 ${String(sorted[Math.floor(sorted.length / 2)]).padStart(5)}  최대 ${String(sorted.at(-1)).padStart(5)}`);
  }
} catch (e) {
  failures++;
  log(`ERROR ${e.stack}`);
} finally {
  await client.close().catch(() => {});
  await browser.close();
  await relay.close();
  web.kill();
  gh.close();
  log(failures ? `${failures}개 실패` : '모두 통과');
  process.exit(failures ? 1 : 0);
}
