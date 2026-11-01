// E2E 테스트: 실제 Godot 웹 에디터를 헤드리스 Chromium에서 띄워 동기화와 AI 도구를 검증한다.
// 사용법: scripts/build.sh && node tests/e2e.mjs [스크린샷 저장 폴더]
// 필요: playwright (전역 설치 또는 NODE_PATH)

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeGitHub } from './fake-github.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.argv[2] ?? join(ROOT, 'test-results'));
mkdirSync(OUT, { recursive: true });
const WEB_PORT = 8070;
const GH_PORT = 8071;
const URL = `http://localhost:${WEB_PORT}/?api=http://localhost:${GH_PORT}&autosave=3&poll=3&status=2`;

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

// ---------- 원격 저장소 초기 상태 (godot-test와 비슷한 구성) ----------
const gh = new FakeGitHub();
const MAIN_TSCN = `[gd_scene format=3]

[node name="Main" type="Node2D"]

[node name="Box" type="ColorRect" parent="."]
offset_left = 100.0
offset_top = 100.0
offset_right = 300.0
offset_bottom = 220.0
color = Color(0.9, 0.35, 0.25, 1)
`;
gh.commit(
  {
    '.gitignore': '# Godot 4+ specific ignores\n.godot/\n/android/\n',
    'README.md': '# game\n',
    'project.godot':
      'config_version=5\n\n[application]\n\nconfig/name="game"\nrun/main_scene="res://main.tscn"\nconfig/features=PackedStringArray("4.7", "GL Compatibility")\n\n[rendering]\n\nrenderer/rendering_method="gl_compatibility"\nrenderer/rendering_method.mobile="gl_compatibility"\n',
    'main.tscn': MAIN_TSCN,
  },
  'Initial commit',
);
await gh.listen(GH_PORT);
const web = spawn(process.execPath, [join(ROOT, 'tools/serve.mjs'), String(WEB_PORT), join(ROOT, 'dist')], { stdio: 'ignore' });
await sleep(500);

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1400, height: 820 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('dialog', (d) => d.accept());
const ai = (expr) => page.evaluate(expr);

try {
  // 1. 첫 접속: 설정 화면에서 저장소 연결
  await page.goto(URL);
  await page.waitForSelector('#setup[open]', { timeout: 30000 });
  check('첫 접속 시 설정 화면 표시', true);
  await page.fill('#setup-repo', 'tester/game');
  await page.fill('#setup-token', 'test-token');
  await page.click('#setup-form button[type=submit]');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 240000 });
  log('에디터 준비 완료');

  const status = await ai(() => window.godotAI.status());
  check('브리지 연결됨', status.editor_ready === true, `bridge v${status.versions.bridge}`);
  check('원격 씬을 에디터가 열 수 있음', status.editor?.main_scene === 'main.tscn', JSON.stringify(status.editor));
  const files = (await ai(() => window.godotAI.listFiles())).files.map((f) => f.path);
  check('원격 파일을 받아옴', ['main.tscn', 'README.md', 'project.godot'].every((p) => files.includes(p)), files.join(', '));

  // 2. 브리지 애드온 설치가 자동 커밋되는지
  const addonPushed = await waitFor(() => gh.text('addons/web_editor_bridge/plugin.gd') && gh.text('project.godot').includes('web_editor_bridge'), 20000);
  check('브리지 애드온과 활성화 설정이 GitHub에 커밋됨', !!addonPushed, gh.lastCommitMessage()?.split('\n')[0]);
  check('.godot 캐시는 커밋되지 않음', !Object.keys(gh.files()).some((p) => p.startsWith('.godot/')));
  const proj = gh.text('project.godot');
  check(
    'project.godot 기존 설정 유지 (이름, 메인 씬, 렌더러)',
    proj.includes('config/name="game"') && proj.includes('run/main_scene="res://main.tscn"') && /rendering_method="gl_compatibility"/.test(proj) && /rendering_method\.mobile="gl_compatibility"/.test(proj),
    JSON.stringify(proj.slice(proj.indexOf('config_version'))),
  );

  // 3. AI 도구로 파일 쓰기 -> 에디터 반영 -> 자동 커밋
  const circle = '@tool\nextends Node2D\n\n@export var radius: float = 40.0\n@export var color: Color = Color.SKY_BLUE\n\nfunc _draw() -> void:\n\tdraw_circle(Vector2.ZERO, radius, color)\n';
  const withCircle = `${MAIN_TSCN.replace('[gd_scene format=3]', '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://circle.gd" id="1"]')}
[node name="Circle" type="Node2D" parent="."]
position = Vector2(500, 200)
script = ExtResource("1")
radius = 60.0
`;
  await ai(() => window.godotAI.openScene('main.tscn'));
  const w = await page.evaluate(([c, s]) => window.godotAI.writeFiles([{ path: 'circle.gd', content: c }, { path: 'main.tscn', content: s }], 'AI: 원 추가'), [circle, withCircle]);
  check('AI 쓰기 성공', w.written?.length === 2 && !w.errors?.length, JSON.stringify(w));
  const pushed = await waitFor(() => gh.text('circle.gd') === circle && gh.text('main.tscn')?.includes('name="Circle"'), 20000);
  check('AI 변경이 자동 커밋됨', !!pushed, gh.lastCommitMessage()?.split('\n')[0]);
  check('커밋 메시지에 AI 메모 포함', /AI: 원 추가/.test(gh.lastCommitMessage() ?? ''));

  await ai(() => window.godotAI.setMainScreen('2D'));
  await sleep(1500);
  const shot1 = await ai(() => window.godotAI.screenshot({ max_width: 1200 }));
  writeFileSync(join(OUT, '1-ai-circle.png'), Buffer.from(shot1.data, 'base64'));
  check('스크린샷', shot1.type === 'image' && shot1.data.length > 1000, `${shot1.width}x${shot1.height}`);

  // 4. 외부 커밋(Claude Code 등) -> 실시간 반영
  const remoteScene = (await ai(() => window.godotAI.readFile('main.tscn'))).content.replace(
    'radius = 60.0\n',
    'radius = 60.0\n\n[node name="FromRemote" type="ColorRect" parent="."]\noffset_left = 700.0\noffset_top = 300.0\noffset_right = 900.0\noffset_bottom = 400.0\ncolor = Color(0.3, 0.85, 0.4, 1)\n',
  );
  gh.commit({ 'main.tscn': remoteScene, 'notes/remote.txt': 'hello from remote\n', 'README.md': null }, 'Claude Code: 초록 사각형 추가');
  const applied = await waitFor(async () => {
    const r = await ai(() => window.godotAI.readFile('notes/remote.txt').catch(() => null));
    return r?.content === 'hello from remote\n';
  }, 20000);
  check('원격 새 파일이 에디터에 반영됨', !!applied);
  const sceneNow = (await ai(() => window.godotAI.readFile('main.tscn'))).content;
  check('원격 씬 변경 반영', sceneNow.includes('FromRemote'));
  const files2 = (await ai(() => window.godotAI.listFiles())).files.map((f) => f.path);
  check('원격 삭제 반영', !files2.includes('README.md'));
  await sleep(1500);
  const shot2 = await ai(() => window.godotAI.screenshot({ max_width: 1200 }));
  writeFileSync(join(OUT, '2-remote-applied.png'), Buffer.from(shot2.data, 'base64'));
  await sleep(8000); // 자동 저장이 몇 번 돈 뒤에도 원격 변경이 되돌려지지 않는지
  check('자동 저장이 원격 변경을 되돌리지 않음', gh.text('main.tscn')?.includes('FromRemote') && gh.text('README.md') === null);

  // 5. DOM AI 패널에서 키보드로 파일 만들기 (Godot이 키 입력을 가로채지 않는지)
  await page.click('#btn-panel');
  await page.waitForSelector('#ai-panel:not([hidden])');
  await page.click('#ai-file-new');
  await page.click('#ai-file-path');
  await page.keyboard.type('notes/from-panel.txt');
  await page.click('#ai-file-content');
  await page.keyboard.type('typed in panel');
  await page.click('#ai-file-save');
  const panelPushed = await waitFor(() => gh.text('notes/from-panel.txt') === 'typed in panel', 20000);
  check('AI 패널에서 키보드로 입력한 파일이 커밋됨', !!panelPushed, JSON.stringify(gh.text('notes/from-panel.txt')));

  // 6. 로그: 스크립트 오류가 get_logs로 보이는지
  await ai(() => window.godotAI.writeFile('broken.gd', 'extends Node\nfunc _ready(:\n'));
  const errs = await waitFor(async () => (await ai(() => window.godotAI.logs({ level: 'error' }))).lines.some((l) => /broken\.gd/.test(l)), 10000);
  check('스크립트 오류가 로그에 나타남', !!errs);
  await ai(() => window.godotAI.deleteFiles(['broken.gd']));

  // 7. 게임 실행/종료
  await ai(() => window.godotAI.run());
  const running = await waitFor(() => page.evaluate(() => !document.getElementById('game-layer').hidden), 30000);
  check('게임 실행 화면이 열림', !!running);
  await sleep(4000);
  await page.screenshot({ path: join(OUT, '3-game-running.png') });
  await ai(() => window.godotAI.stop());
  const stopped = await waitFor(() => page.evaluate(() => document.getElementById('game-layer').hidden), 20000);
  check('게임 종료', !!stopped);

  // 8. 새로고침: 토큰 기억, 다시 받을 파일 없음, 대기 변경 없음
  await waitFor(async () => (await ai(() => window.godotAI.status())).unsynced_files.length === 0, 20000);
  const headBefore = gh.head();
  const requestsBefore = gh.requests.length;
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]', { timeout: 240000 });
  const blobGets = gh.requests.slice(requestsBefore).filter((r) => r.startsWith('GET') && r.includes('/git/blobs/')).length;
  check('새로고침 후 자동 로그인과 재시작', true);
  check('새로고침 시 파일을 다시 받지 않음(로컬 사본 사용)', blobGets <= 1, `blob 요청 ${blobGets}회`);
  const st2 = await ai(() => window.godotAI.status());
  check('새로고침 후 대기 변경 없음', st2.unsynced_files.length === 0, JSON.stringify(st2.unsynced_files));
  await sleep(5000);
  check('새로고침 후 불필요한 커밋 없음', gh.head() === headBefore);

  await page.screenshot({ path: join(OUT, '4-page.png') });
  check('페이지 JS 오류 없음', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  failures++;
  log(`ERROR ${e.stack}`);
  await page.screenshot({ path: join(OUT, 'error.png') }).catch(() => {});
  const appLogs = await page.evaluate(() => window.__gwe?.logs?.query({ limit: 60 }).map((l) => `[${l.source}/${l.level}] ${l.text}`)).catch(() => []);
  console.log(appLogs?.join('\n'));
} finally {
  await browser.close();
  web.kill();
  gh.close();
  log(failures ? `${failures}개 실패` : '모두 통과');
  process.exit(failures ? 1 : 0);
}
