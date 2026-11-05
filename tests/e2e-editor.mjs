// E2E 테스트 (에디터 동작): 실제 Godot 웹 에디터의 동기화와 AI 도구 (클라우드 Worker + 가짜 GitHub)
// 브리지 설치·설정 유지 → AI 쓰기·스크린샷 → 원격 변경 반영 → AI 패널 키보드 입력 → 오류 로그 → 게임 실행 → 새로고침
// 사용법: scripts/build-worker.sh && (cd worker && npm ci) && npm ci && node tests/e2e-editor.mjs [결과 폴더]

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sleep, startCloud, waitFor } from './cloud-harness.mjs';

const MAIN_TSCN = `[gd_scene format=3]

[node name="Main" type="Node2D"]

[node name="Box" type="ColorRect" parent="."]
offset_left = 100.0
offset_top = 100.0
offset_right = 300.0
offset_bottom = 220.0
color = Color(0.9, 0.35, 0.25, 1)
`;

const t = await startCloud({
  name: 'editor',
  ports: { web: 8093, gh: 8094, mirror: 8095 },
  files: {
    '.gitignore': '# Godot 4+ specific ignores\n.godot/\n/android/\n',
    'README.md': '# game\n',
    'project.godot':
      'config_version=5\n\n[application]\n\nconfig/name="game"\nrun/main_scene="res://main.tscn"\nconfig/features=PackedStringArray("4.7", "GL Compatibility")\n\n[rendering]\n\nrenderer/rendering_method="gl_compatibility"\nrenderer/rendering_method.mobile="gl_compatibility"\n',
    'main.tscn': MAIN_TSCN,
  },
});
const { OUT, gh, page, ai, log, check, pageErrors } = t;

await t.run(async () => {
  // 1. 로그인 → 에디터
  await t.loginAndOpen();
  const status = await ai(() => window.godotAI.status());
  check('브리지 연결됨', status.editor_ready === true, `bridge v${status.versions.bridge}`);
  check('원격 씬을 에디터가 열 수 있음', status.editor?.main_scene === 'main.tscn', JSON.stringify(status.editor));
  const files = (await ai(() => window.godotAI.listFiles())).files.map((f) => f.path);
  check('원격 파일을 받아옴', ['main.tscn', 'README.md', 'project.godot'].every((p) => files.includes(p)), files.join(', '));

  // 2. 브리지 애드온 설치 커밋, 기존 설정 유지
  const addonPushed = await waitFor(() => gh.text('addons/web_editor_bridge/plugin.gd') && gh.text('project.godot').includes('web_editor_bridge'), 60000);
  check('브리지 애드온과 활성화 설정이 GitHub에 커밋됨', !!addonPushed, gh.lastCommitMessage()?.split('\n')[0]);
  check('.godot 캐시는 커밋되지 않음', !Object.keys(gh.files()).some((p) => p.startsWith('.godot/')));
  const proj = gh.text('project.godot');
  check(
    'project.godot 기존 설정 유지 (이름, 메인 씬, 렌더러)',
    proj.includes('config/name="game"') && proj.includes('run/main_scene="res://main.tscn"') && /rendering_method="gl_compatibility"/.test(proj) && /rendering_method\.mobile="gl_compatibility"/.test(proj),
  );

  // 3. AI 도구로 파일 쓰기 → 에디터 반영 → 자동 커밋
  const circle = '@tool\nextends Node2D\n\n@export var radius: float = 40.0\n@export var color: Color = Color.SKY_BLUE\n\nfunc _draw() -> void:\n\tdraw_circle(Vector2.ZERO, radius, color)\n';
  const withCircle = `${MAIN_TSCN.replace('[gd_scene format=3]', '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://circle.gd" id="1"]')}
[node name="Circle" type="Node2D" parent="."]
position = Vector2(500, 200)
script = ExtResource("1")
radius = 60.0
`;
  await ai(() => window.godotAI.openScene('main.tscn'));
  const w = await ai(([c, s]) => window.godotAI.writeFiles([{ path: 'circle.gd', content: c }, { path: 'main.tscn', content: s }], 'AI: 원 추가'), [circle, withCircle]);
  check('AI 쓰기 성공', w.written?.length === 2 && !w.errors?.length, JSON.stringify(w));
  const pushed = await waitFor(() => gh.text('circle.gd') === circle && gh.text('main.tscn')?.includes('name="Circle"'), 30000);
  check('AI 변경이 자동 커밋됨', !!pushed, gh.lastCommitMessage()?.split('\n')[0]);
  check('커밋 메시지에 AI 메모 포함', /AI: 원 추가/.test(gh.lastCommitMessage() ?? ''));
  await ai(() => window.godotAI.setMainScreen('2D'));
  await sleep(1500);
  const shot1 = await ai(() => window.godotAI.screenshot({ max_width: 1200 }));
  writeFileSync(join(OUT, 'editor-1-ai-circle.png'), Buffer.from(shot1.data, 'base64'));
  check('스크린샷', shot1.type === 'image' && shot1.data.length > 1000, `${shot1.width}x${shot1.height}`);

  // 4. 외부 커밋(Claude Code 등) → 실시간 반영
  const remoteScene = (await ai(() => window.godotAI.readFile('main.tscn'))).content.replace(
    'radius = 60.0\n',
    'radius = 60.0\n\n[node name="FromRemote" type="ColorRect" parent="."]\noffset_left = 700.0\noffset_top = 300.0\noffset_right = 900.0\noffset_bottom = 400.0\ncolor = Color(0.3, 0.85, 0.4, 1)\n',
  );
  gh.commit({ 'main.tscn': remoteScene, 'notes/remote.txt': 'hello from remote\n', 'README.md': null }, 'Claude Code: 초록 사각형 추가');
  const applied = await waitFor(async () => (await ai(() => window.godotAI.readFile('notes/remote.txt').catch(() => null)))?.content === 'hello from remote\n', 30000);
  check('원격 새 파일이 에디터에 반영됨', !!applied);
  check('원격 씬 변경 반영', (await ai(() => window.godotAI.readFile('main.tscn'))).content.includes('FromRemote'));
  check('원격 삭제 반영', !(await ai(() => window.godotAI.listFiles())).files.some((f) => f.path === 'README.md'));
  await sleep(8000); // 자동 저장이 몇 번 돈 뒤에도 원격 변경이 되돌려지지 않는지
  check('자동 저장이 원격 변경을 되돌리지 않음', gh.text('main.tscn')?.includes('FromRemote') && gh.text('README.md') === null);

  // 5. AI 패널에서 키보드로 파일 만들기 (Godot이 키 입력을 가로채지 않는지)
  await page.click('#btn-panel');
  await page.waitForSelector('#ai-panel:not([hidden])');
  await page.click('#ai-file-new');
  await page.click('#ai-file-path');
  await page.keyboard.type('notes/from-panel.txt');
  await page.click('#ai-file-content');
  await page.keyboard.type('typed in panel');
  await page.click('#ai-file-save');
  const panelPushed = await waitFor(() => gh.text('notes/from-panel.txt') === 'typed in panel', 30000);
  check('AI 패널에서 키보드로 입력한 파일이 커밋됨', !!panelPushed, JSON.stringify(gh.text('notes/from-panel.txt')));

  // 6. 스크립트 오류가 로그로 보이는지
  await ai(() => window.godotAI.writeFile('broken.gd', 'extends Node\nfunc _ready(:\n'));
  const errs = await waitFor(async () => (await ai(() => window.godotAI.logs({ level: 'error' }))).lines.some((l) => /broken\.gd/.test(l)), 15000);
  check('스크립트 오류가 로그에 나타남', !!errs);
  await ai(() => window.godotAI.deleteFiles(['broken.gd']));

  // 7. 게임 실행/종료
  await ai(() => window.godotAI.run());
  const running = await waitFor(() => page.evaluate(() => !document.getElementById('game-layer').hidden), 30000);
  check('게임 실행 화면이 열림', !!running);
  await sleep(4000);
  await page.screenshot({ path: join(OUT, 'editor-2-game-running.png') });
  await ai(() => window.godotAI.stop());
  const stopped = await waitFor(() => page.evaluate(() => document.getElementById('game-layer').hidden), 20000);
  check('게임 종료', !!stopped);

  // 8. 새로고침: 로그인 유지, 마지막 프로젝트 바로 열기, 다시 받을 파일 없음, 대기 변경 없음
  await waitFor(async () => (await ai(() => window.godotAI.status())).unsynced_files.length === 0, 30000);
  const headBefore = gh.head();
  const requestsBefore = gh.requests.length;
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]', { timeout: 240000 });
  check('새로고침 후 로그인 유지, 마지막 프로젝트로 바로 시작', !(await page.isVisible('#picker[open]')));
  const blobGets = gh.requests.slice(requestsBefore).filter((r) => r.startsWith('GET') && r.includes('/git/blobs/')).length;
  check('새로고침 시 파일을 다시 받지 않음(로컬 사본 사용)', blobGets <= 1, `blob 요청 ${blobGets}회`);
  const st2 = await ai(() => window.godotAI.status());
  check('새로고침 후 대기 변경 없음', st2.unsynced_files.length === 0, JSON.stringify(st2.unsynced_files));
  await sleep(5000);
  check('새로고침 후 불필요한 커밋 없음', gh.head() === headBefore);

  await page.screenshot({ path: join(OUT, 'editor-3-page.png') });
  check('페이지 JS 오류 없음', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  log('끝');
});
