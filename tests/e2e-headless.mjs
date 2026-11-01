// 헤드리스 에디터 실행기 E2E: 중계 서버 + 서버용 헤드리스 에디터 + (가짜) PC 브라우저 탭
//  1. 실행기가 웹 에디터를 띄우고 MCP에 연결 -> 스크린샷 등 모든 도구 사용 가능
//  2. PC 브라우저 탭이 같은 프로젝트로 연결되면 -> 변경을 저장하고 스스로 멈춤, 호출은 PC 탭으로
//  3. PC 탭이 사라지면 -> 다시 시작하고 그 사이 GitHub 변경을 받아 옴
// 사용법: scripts/build.sh && (cd mcp-server && npm install) && node tests/e2e-headless.mjs

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { FakeGitHub } from './fake-github.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(join(ROOT, 'mcp-server', 'package.json'));
const { Client } = await import(req.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { StreamableHTTPClientTransport } = await import(req.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'));
const WebSocket = req('ws');
const { createRelay } = await import('../mcp-server/src/server.js');
const { parseProject } = await import('../mcp-server/src/config.js');

const OUT = resolve(process.argv[2] ?? join(ROOT, 'test-results'));
mkdirSync(OUT, { recursive: true });
const [WEB_PORT, GH_PORT, RELAY_PORT] = [8090, 8091, 8092];
const RELAY = `http://localhost:${RELAY_PORT}`;
const CLI_TOKEN = 'cli-token-headless-0123456789';
const PAIRING = 'pairing-token-headless-0123';
const DATA = mkdtempSync(join(tmpdir(), 'headless-e2e-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const t0 = Date.now();
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
async function waitFor(fn, timeoutMs, intervalMs = 1000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(intervalMs);
  }
}

const gh = new FakeGitHub();
gh.commit(
  {
    '.gitignore': '.godot/\n',
    'project.godot': 'config_version=5\n\n[application]\n\nconfig/name="game"\nrun/main_scene="res://main.tscn"\nconfig/features=PackedStringArray("4.7", "GL Compatibility")\n\n[rendering]\n\nrenderer/rendering_method="gl_compatibility"\nrenderer/rendering_method.mobile="gl_compatibility"\n',
    'main.tscn': '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n\n[node name="Box" type="ColorRect" parent="."]\noffset_left = 80.0\noffset_top = 80.0\noffset_right = 260.0\noffset_bottom = 180.0\ncolor = Color(0.4, 0.8, 0.5, 1)\n',
  },
  'Initial commit',
);
await gh.listen(GH_PORT);
const relay = createRelay({
  port: RELAY_PORT,
  host: '127.0.0.1',
  publicUrl: RELAY,
  adminPassword: 'admin-password-headless',
  cliToken: CLI_TOKEN,
  pairingToken: PAIRING,
  allowedOrigins: [],
  githubToken: 'test-token',
  defaultProject: parseProject('tester/game@main'),
  githubApiBase: `http://localhost:${GH_PORT}`,
  dataDir: join(DATA, 'relay'),
  extraRedirectUris: [],
});
await relay.listen(RELAY_PORT, '127.0.0.1');
const web = spawn(process.execPath, [join(ROOT, 'tools/serve.mjs'), String(WEB_PORT), join(ROOT, 'dist')], { stdio: 'ignore' });

const runnerLog = [];
const runner = spawn(process.execPath, [join(ROOT, 'mcp-server/headless/runner.mjs')], {
  env: {
    ...process.env,
    NODE_PATH: process.env.NODE_PATH || execSync('npm root -g').toString().trim(),
    PUBLIC_URL: RELAY,
    PORT: String(RELAY_PORT),
    CLI_TOKEN,
    PAIRING_TOKEN: PAIRING,
    DEFAULT_PROJECT: 'tester/game@main',
    GODOT_GITHUB_TOKEN: 'test-token',
    HEADLESS_EDITOR_URL: `http://localhost:${WEB_PORT}/?api=http://localhost:${GH_PORT}&autosave=3&poll=3&status=2`,
    HEADLESS_CHECK_SEC: '2',
    HEADLESS_RESUME_AFTER_SEC: '4',
    DATA_DIR: join(DATA, 'runner'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const onOut = (d) => {
  for (const line of d.toString().split('\n').filter(Boolean)) {
    runnerLog.push(line);
    if (process.env.VERBOSE) console.log('   runner:', line);
  }
};
runner.stdout.on('data', onOut);
runner.stderr.on('data', onOut);
let runnerExit = null;
runner.on('exit', (code) => (runnerExit = code));

const client = new Client({ name: 'e2e-headless', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${RELAY}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${CLI_TOKEN}` } } }));
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const json = (r) => JSON.parse(r.content[0].text);
const tabs = async () => json(await call('list_projects')).editor_tabs;

try {
  // 1. 헤드리스 에디터 시작
  const ready = await waitFor(async () => (await tabs()).find((t) => t.kind === 'headless' && t.editor_ready), 240000, 2000);
  check('서버 헤드리스 에디터가 MCP에 연결됨', !!ready, JSON.stringify(ready));
  const st = json(await call('get_status'));
  check('get_status가 에디터 모드', st.mode === 'editor' && st.editor_ready, st.repository);
  await call('open_scene', { path: 'main.tscn' });
  await call('set_main_screen', { name: '2D' });
  await sleep(1000);
  const shot = await call('screenshot', { max_width: 1024 });
  const img = shot.content.find((c) => c.type === 'image');
  check('PC 없이 스크린샷 가능', !!img);
  if (img) writeFileSync(join(OUT, 'headless-1.png'), Buffer.from(img.data, 'base64'));

  // 헤드리스 에디터에서 변경 -> 아직 커밋 전일 수 있는 상태에서 PC가 연결됨
  await call('write_files', { files: [{ path: 'notes/headless.txt', content: 'from headless editor' }] });

  // 2. PC 브라우저 탭 연결 -> 헤드리스 에디터가 저장 후 멈춤
  const pc = new WebSocket(`ws://localhost:${RELAY_PORT}/editor`, { origin: `http://localhost:${WEB_PORT}` });
  await new Promise((r) => pc.on('open', r));
  pc.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'call') pc.send(JSON.stringify({ type: 'result', id: msg.id, content: [{ type: 'text', text: JSON.stringify({ from: 'pc-browser', name: msg.name }) }] }));
  });
  pc.send(JSON.stringify({ type: 'hello', protocol: 1, pairingToken: PAIRING, project: { owner: 'tester', repo: 'game', branch: 'main' }, app: { kind: 'browser' }, tools: [] }));
  await sleep(300);
  const routed = json(await call('get_editor_state'));
  check('PC 탭이 연결되면 호출은 PC 탭으로 감', routed.from === 'pc-browser', JSON.stringify(routed));
  const paused = await waitFor(async () => {
    const t = await tabs();
    return !t.some((x) => x.kind === 'headless') ? t : null;
  }, 40000);
  check('헤드리스 에디터가 스스로 멈춤', !!paused, JSON.stringify(paused?.map((t) => t.kind)));
  check('멈추기 전에 변경을 GitHub에 저장', gh.text('notes/headless.txt') === 'from headless editor');

  // PC 에디터가 작업한 것처럼 GitHub에 커밋
  gh.commit({ 'notes/from-pc.txt': 'edited on PC' }, 'PC 에디터 작업');

  // 3. PC 탭이 닫히면 -> 다시 시작하고 최신 상태를 받아 옴
  pc.close();
  const resumed = await waitFor(async () => (await tabs()).find((t) => t.kind === 'headless' && t.editor_ready), 120000, 2000);
  check('PC 탭이 닫히면 헤드리스 에디터 재시작', !!resumed);
  const fromPc = await call('read_file', { path: 'notes/from-pc.txt' });
  check('재시작 후 그 사이의 GitHub 변경을 받아 옴', !fromPc.isError && json(fromPc).content === 'edited on PC');

  // 4. 종료 신호 -> 정상 종료
  runner.kill('SIGTERM');
  const exited = await waitFor(async () => runnerExit !== null, 60000, 500);
  check('SIGTERM에 정상 종료(코드 0)', exited && runnerExit === 0, `exit=${runnerExit}`);
} catch (e) {
  failures++;
  log(`ERROR ${e.stack}`);
} finally {
  if (failures) console.log(`\n실행기 로그:\n${runnerLog.slice(-40).join('\n')}`);
  if (runnerExit === null) runner.kill('SIGKILL');
  await client.close().catch(() => {});
  await relay.close();
  web.kill();
  gh.close();
  log(failures ? `${failures}개 실패` : '모두 통과');
  process.exit(failures ? 1 : 0);
}
