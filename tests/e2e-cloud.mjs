// E2E 테스트 (클라우드 버전): wrangler dev(로컬 Worker) + 가짜 GitHub(OAuth) + 실제 Godot 웹 에디터
// GitHub 로그인 → 프로젝트 선택 → 에디터 → 자동 커밋(사용자 토큰) → 원격 반영 → 토큰 갱신
// → MCP(Claude) 연결: 열린 에디터 조종 → 테스트 실행기 → 안전장치(대량 삭제, 저장소 유실) → 로그아웃
// 사용법: scripts/build-worker.sh && (cd worker && npm ci) && npm ci && node tests/e2e-cloud.mjs [결과 폴더]

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sleep, startCloud, waitFor } from './cloud-harness.mjs';

const t = await startCloud({ name: 'cloud', ports: { web: 8090, gh: 8091, mirror: 8092 } });
const { OUT, BASE, GH, gh, oauth, page, ai, log, check, mcpToken, mcpCall, mirrorHits, mirrorDown, ghRequests, pageErrors } = t;

await t.run(async () => {
  // 1. 첫 접속: 로그인 화면 (새로고침 우회 없이 cross-origin isolation)
  await page.goto(`${BASE}/?autosave=3&poll=3&status=2`);
  await page.waitForSelector('#login[open]', { timeout: 30000 });
  check('첫 접속 시 로그인 화면', true);
  const iso = await ai(() => ({ isolated: window.crossOriginIsolated, reloaded: sessionStorage.getItem('gwe:coi-reloaded') }));
  check('서버 헤더로 바로 cross-origin isolated (새로고침 없음)', iso.isolated === true && iso.reloaded === null, JSON.stringify(iso));

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
  const viaWorker = (t.wranglerOut().match(/GET \/godot\.editor\.wasm/g) ?? []).length;
  check('엔진은 서비스 워커가 조각을 직접 받아 이어 붙임 (Worker 이어 붙이기 경로 안 씀)', viaWorker === 0, `Worker 경로 요청 ${viaWorker}회`);
  const partHits = mirrorHits.filter((u) => /godot\.editor\.\d\.wasm$/.test(u)).length;
  if (mirrorDown) check('미러가 꺼져 있으면 Worker의 조각으로 대체해서 엔진 로드', partHits === 0, `미러 요청 ${partHits}회`);
  else check('엔진 조각 4개를 미러(GitHub Pages 흉내)에서 받음', partHits === 4, `미러 요청 ${partHits}회: ${mirrorHits.join(', ')}`);

  const secrets = await ai(() => ({ cookie: document.cookie, local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage) }));
  check('세션 쿠키와 GitHub 토큰이 페이지 JS에 보이지 않음', !/gwe_sid|ghu_|ghr_/.test(JSON.stringify(secrets)), JSON.stringify(secrets).slice(0, 200));
  check('브라우저가 GitHub에 직접 요청하지 않음', ghRequests.length === 0, ghRequests.slice(0, 3).join(', '));
  check('MCP 수동 설정 칸 없음 (자동 연결)', await ai(() => !document.querySelector('#mcp-url')));
  const status = await ai(() => window.godotAI.status());
  check('에디터 브리지 연결, 메인 씬 인식', status.editor_ready === true && status.editor?.main_scene === 'main.tscn', JSON.stringify(status.editor));

  // 3. 파일 쓰기 → 자동 커밋 (사용자 토큰)
  const pushedAddon = await waitFor(() => gh.text('addons/web_editor_bridge/plugin.gd'), 60000); // 자동 저장 주기(30초)보다 넉넉히
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

  // 8. 안전장치: 파일을 한꺼번에 많이 지우는 저장은 자동으로 올리지 않는다
  const bulk = Array.from({ length: 12 }, (_, i) => ({ path: `bulk/f${i}.gd`, content: `extends Node\n# ${i}\n` }));
  await mcpCall(token, 'write_files', { files: bulk, commit_message: 'bulk' });
  await waitFor(() => gh.text('bulk/f11.gd'), 45000);
  const tracked = Object.keys(gh.files()).length;
  await mcpCall(token, 'delete_files', { paths: bulk.map((f) => f.path) });
  const mcpSave = await mcpCall(token, 'sync_now');
  check('대량 삭제는 MCP sync_now로도 올라가지 않음 (사람 확인 필요)', mcpSave.data?.blocked === true && mcpSave.data?.deletes === 12, JSON.stringify(mcpSave.data ?? mcpSave).slice(0, 160));
  await sleep(40000);
  check('자동 저장이 대량 삭제를 올리지 않음', !!gh.text('bulk/f0.gd') && Object.keys(gh.files()).length === tracked, `원격 파일 ${Object.keys(gh.files()).length}/${tracked}`);
  await page.click('#btn-save'); // 확인 창은 자동으로 "확인"
  const bulkGone = await waitFor(() => !gh.text('bulk/f0.gd'), 30000);
  check("'지금 저장'에서 확인하면 삭제가 올라감", !!bulkGone, gh.lastCommitMessage()?.split('\n')[0]);

  // 9. 브라우저 저장소(IndexedDB)가 사라져도 파일을 지우지 않고 GitHub에서 다시 받음 (동기화 기록은 남은 상태)
  const before = Object.keys(gh.files()).sort();
  const headBefore = gh.head();
  await page.goto(`${BASE}/favicon.png`);
  await page.evaluate(() => new Promise((res) => {
    const req = indexedDB.deleteDatabase('/home/web_user');
    req.onsuccess = req.onerror = req.onblocked = () => res();
  }));
  await page.goto(`${BASE}/?autosave=3&poll=3&status=2`);
  await page.waitForSelector('body[data-ready="true"]', { timeout: 240000 });
  await sleep(10000);
  const after = Object.keys(gh.files()).sort();
  check('저장소가 사라져도 원격 파일을 지우지 않음', JSON.stringify(after) === JSON.stringify(before), `${before.length} → ${after.length}, head ${headBefore === gh.head() ? '그대로' : '바뀜: ' + gh.lastCommitMessage()?.split('\n')[0]}`);
  const restored = await ai(() => window.godotAI.readFile('main.tscn').then((r) => r.content).catch((e) => String(e)));
  check('GitHub에서 다시 받아 에디터에 파일이 있음', /\[node name="Main"/.test(restored ?? ''), String(restored).slice(0, 60));

  // 10. 로그아웃 → 다시 로그인 화면
  await page.click('#btn-settings');
  await page.click('#btn-logout');
  await page.waitForSelector('#login[open]', { timeout: 60000 });
  const meAfter = await page.evaluate(() => fetch('/api/me').then((r) => r.status));
  check('로그아웃 후 로그인 화면, 세션 없음', meAfter === 401);

  check('페이지 오류 없음', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
});
