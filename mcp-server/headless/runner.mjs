// 서버에서 Godot 웹 에디터를 헤드리스 Chromium으로 상시 실행한다.
// 그러면 PC 브라우저를 열어 두지 않아도(휴대폰 Claude 앱 등에서) 스크린샷, 게임 실행, 로그까지 모든 도구를 쓸 수 있다.
//
// 동작
//  - 웹 에디터 페이지를 열고 저장소/토큰/MCP 설정을 자동으로 넣는다 (브라우저 프로필은 data/headless-profile에 유지)
//  - 사람이 쓰는 브라우저(PC)가 같은 프로젝트로 MCP에 연결되면, 변경을 먼저 GitHub에 올리고 스스로 멈춘다
//    (같은 프로젝트를 두 에디터가 동시에 편집하면 변경이 엇갈리기 때문)
//  - PC 에디터가 닫히고 일정 시간이 지나면 다시 켠다 (GitHub에서 최신 상태를 받아서 시작)
//  - 페이지가 멈추거나 연결이 끊기면 다시 불러온다. 브라우저가 죽으면 종료 코드 1로 끝나고 systemd가 재시작한다
//
// 설정 (mcp-server/.env)
//  DEFAULT_PROJECT            열 프로젝트 "소유자/저장소@브랜치"   (또는 HEADLESS_PROJECT)
//  GODOT_GITHUB_TOKEN         웹 에디터가 쓸 GitHub 토큰          (또는 HEADLESS_GITHUB_TOKEN)
//  PUBLIC_URL, PAIRING_TOKEN, CLI_TOKEN, PORT   중계 서버 설정 그대로 사용
//  HEADLESS_RELAY_URL         에디터가 접속할 중계 서버 주소 (기본 http://127.0.0.1:<PORT>, 같은 컴퓨터)
//  HEADLESS_EDITOR_URL        기본 https://yeobi1124.github.io/godot-web-editor/
//  HEADLESS_YIELD_TO_BROWSER  1(기본)이면 PC 에디터가 연결될 때 멈춤, 0이면 멈추지 않음
//  HEADLESS_RESUME_AFTER_SEC  PC 에디터가 사라진 뒤 다시 켜기까지 기다리는 시간 (기본 60)
//  HEADLESS_CHECK_SEC         상태 확인 주기 (기본 15)
//  HEADLESS_CHROMIUM_PATH     (선택) Chromium 실행 파일 경로

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { loadDotEnv, parseProject, ROOT } from '../src/config.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

loadDotEnv();
const env = process.env;
const log = (...a) => console.log(new Date().toISOString(), '[headless]', ...a);
const fail = (msg) => {
  console.error(`[headless] ${msg}`);
  process.exit(2); // 설정 오류: systemd가 계속 재시작하지 않도록 2로 종료 (서비스에서 RestartPreventExitStatus=2)
};

const project = parseProject(env.HEADLESS_PROJECT || env.DEFAULT_PROJECT);
const githubToken = env.HEADLESS_GITHUB_TOKEN || env.GODOT_GITHUB_TOKEN;
if (!project) fail('DEFAULT_PROJECT(또는 HEADLESS_PROJECT)를 "소유자/저장소@브랜치" 형식으로 설정하세요.');
if (!githubToken) fail('GODOT_GITHUB_TOKEN(또는 HEADLESS_GITHUB_TOKEN)을 설정하세요.');
for (const k of ['PUBLIC_URL', 'PAIRING_TOKEN', 'CLI_TOKEN']) if (!env[k]) fail(`${k}가 없습니다. 'npm run init'을 먼저 실행하세요.`);

const EDITOR_URL = env.HEADLESS_EDITOR_URL || 'https://yeobi1124.github.io/godot-web-editor/';
// 서버 안의 에디터는 공개 주소(Funnel)를 돌아 나가지 않고 같은 컴퓨터의 중계 서버로 바로 접속한다
const RELAY_FOR_PAGE = (env.HEADLESS_RELAY_URL || `http://127.0.0.1:${env.PORT || 8787}`).replace(/\/$/, '');
const RELAY_LOCAL = `http://127.0.0.1:${env.PORT || 8787}`;
const YIELD = env.HEADLESS_YIELD_TO_BROWSER !== '0';
const RESUME_AFTER_MS = Number(env.HEADLESS_RESUME_AFTER_SEC ?? 60) * 1000;
const CHECK_MS = Number(env.HEADLESS_CHECK_SEC ?? 15) * 1000;
const READY_TIMEOUT_MS = 5 * 60 * 1000;
const PROFILE_DIR = resolve(ROOT, env.DATA_DIR || 'data', 'headless-profile');
mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) => Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`${label} 시간 초과`)))]);

let context = null;
let page = null;
let state = 'stopped'; // stopped | starting | running | paused
let browserGoneSince = null;
let unhealthy = 0;
let mcpDown = 0;
let shuttingDown = false;
let closingOnPurpose = false;

/** 중계 서버에서 연결된 에디터 탭 목록 */
async function fetchTabs() {
  const res = await fetch(`${RELAY_LOCAL}/api/tabs`, { headers: { Authorization: `Bearer ${env.CLI_TOKEN}` } });
  if (!res.ok) throw new Error(`중계 서버 응답 ${res.status}`);
  return (await res.json()).tabs;
}

async function openEditor() {
  state = 'starting';
  log(`에디터 시작: ${project.key} (${EDITOR_URL})`);
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1600, height: 900 },
    executablePath: env.HEADLESS_CHROMIUM_PATH || undefined,
    // 종료 신호는 이 프로그램이 직접 처리한다 (브라우저를 닫기 전에 변경을 저장하기 위해)
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...(env.HEADLESS_CHROMIUM_ARGS ? env.HEADLESS_CHROMIUM_ARGS.split(' ') : [])],
  });
  context.on('close', () => {
    if (!shuttingDown && !closingOnPurpose) {
      log('브라우저가 종료되었습니다. 프로세스를 다시 시작합니다.');
      process.exit(1);
    }
  });
  // 페이지 스크립트보다 먼저 저장소/토큰/MCP 설정을 넣는다 (이 서버의 브라우저 프로필에만 저장됨)
  await context.addInitScript(
    ([settings, token, mcp]) => {
      localStorage.setItem('gwe:settings', JSON.stringify(settings));
      localStorage.setItem('gwe:token', token);
      localStorage.setItem('gwe:mcp', JSON.stringify(mcp));
    },
    [
      { owner: project.owner, repo: project.repo, branch: project.branch, remember: true },
      githubToken,
      { url: RELAY_FOR_PAGE, token: env.PAIRING_TOKEN },
    ],
  );
  page = context.pages()[0] ?? (await context.newPage());
  page.on('pageerror', (e) => log('페이지 오류:', e.message));
  page.on('crash', () => log('페이지가 비정상 종료되었습니다.'));
  page.on('console', (m) => {
    const t = m.text();
    // 에디터 오류와 동기화/연결 메시지만 남긴다
    if (/^\[godot:app\]/.test(t) || (m.type() === 'warning' && /^\[godot:/.test(t) && /ERROR|SCRIPT ERROR/.test(t))) log(t.slice(0, 500));
  });
  await page.goto(EDITOR_URL, { waitUntil: 'domcontentloaded' });
  await waitReady();
  state = 'running';
  unhealthy = 0;
  log('에디터 준비 완료. MCP 도구를 모두 사용할 수 있습니다.');
}

async function waitReady() {
  const end = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < end) {
    const s = await page
      .evaluate(() => ({
        ready: document.body.dataset.ready === 'true',
        setup: !!document.querySelector('#setup[open]'),
        setupError: document.querySelector('#setup-error')?.textContent ?? '',
        fatal: document.querySelector('#fatal')?.hidden === false ? document.querySelector('#fatal-title')?.textContent : '',
      }))
      .catch(() => ({}));
    if (s.ready) return;
    if (s.setup) throw new Error(`저장소 연결 실패: ${s.setupError || '토큰이나 저장소 이름을 확인하세요'}`);
    if (s.fatal) throw new Error(`에디터 시작 실패: ${s.fatal}`);
    await sleep(2000);
  }
  throw new Error('에디터가 5분 안에 준비되지 않았습니다');
}

async function health() {
  return withTimeout(
    page.evaluate(() => ({
      ready: document.body.dataset.ready === 'true',
      bridge: !!window.__gwe?.bridge?.ready,
      mcp: window.__gwe?.mcp?.status ?? 'off',
      mcpDetail: window.__gwe?.mcp?.detail ?? '',
      pending: window.__gwe?.sync?.status?.pending?.length ?? 0,
    })),
    10000,
    '상태 확인',
  );
}

/** 올라가지 않은 변경을 GitHub에 저장하고 에디터를 닫는다 */
async function closeEditor(reason) {
  if (!context) return;
  log(`에디터 정지 (${reason}): 변경 사항을 먼저 GitHub에 저장합니다.`);
  try {
    const r = await withTimeout(page.evaluate(() => window.godotAI?.syncNow('서버 에디터 정지 전 저장')), 30000, '저장');
    if (r?.commit) log(`저장했습니다: ${r.short} (파일 ${r.files.length}개)`);
  } catch (e) {
    log(`저장하지 못했습니다(브라우저 프로필에 남아 다음 시작 때 올라감): ${e.message}`);
  }
  const ctx = context;
  context = null;
  page = null;
  closingOnPurpose = true;
  await ctx.close().catch(() => {});
  closingOnPurpose = false;
}

async function tick() {
  let tabs = null;
  try {
    tabs = await fetchTabs();
  } catch (e) {
    log(`중계 서버에 연결할 수 없습니다: ${e.message}`);
  }
  const browserTab = tabs?.some((t) => t.project === project.key && t.kind === 'browser');

  if (state === 'running' && YIELD && browserTab) {
    state = 'paused';
    await closeEditor('PC 브라우저 에디터가 연결됨');
    log(`PC 에디터를 닫으면 ${Math.round(RESUME_AFTER_MS / 1000)}초 뒤 다시 시작합니다.`);
    browserGoneSince = null;
    return;
  }
  if (state === 'paused') {
    if (browserTab) {
      browserGoneSince = null;
      return;
    }
    if (tabs === null) return;
    browserGoneSince ??= Date.now();
    if (Date.now() - browserGoneSince >= RESUME_AFTER_MS) {
      log('PC 에디터가 닫혀 있어 서버 에디터를 다시 시작합니다.');
      await openEditor();
    }
    return;
  }
  if (state === 'running') {
    try {
      const h = await health();
      // 에디터 자체가 멈췄을 때만 재시작한다. MCP 연결 문제는 재시작해도 해결되지 않으므로 원인만 알린다.
      const ok = h.ready && h.bridge;
      unhealthy = ok ? 0 : unhealthy + 1;
      if (!ok) log(`상태 이상 ${unhealthy}/3: ${JSON.stringify(h)}`);
      if (ok && h.mcp !== 'connected') {
        mcpDown++;
        if (mcpDown === 2 || mcpDown % 20 === 0) {
          log(`MCP 중계 서버에 연결되지 않습니다 (${h.mcp}${h.mcpDetail ? `: ${h.mcpDetail}` : ''}). 에디터가 접속하는 주소: ${RELAY_FOR_PAGE}/editor`);
          log('확인: 중계 서버 로그(journalctl -u godot-mcp-relay)에 "에디터 연결 거부"가 있는지, .env의 PAIRING_TOKEN/ALLOWED_ORIGINS가 맞는지');
        }
      } else if (ok) {
        if (mcpDown >= 2) log('MCP 중계 서버에 연결되었습니다.');
        mcpDown = 0;
      }
    } catch (e) {
      unhealthy++;
      log(`상태 확인 실패 ${unhealthy}/3: ${e.message}`);
    }
    if (unhealthy >= 3) {
      log('에디터를 다시 시작합니다.');
      await closeEditor('응답 없음');
      await openEditor();
    }
  }
}

async function main() {
  log(`프로젝트 ${project.key}, PC 에디터 연결 시 ${YIELD ? '양보함' : '양보 안 함'}`);
  // 시작할 때 이미 PC 에디터가 연결되어 있으면 기다린다
  try {
    const tabs = await fetchTabs();
    if (YIELD && tabs.some((t) => t.project === project.key && t.kind === 'browser')) {
      state = 'paused';
      log('PC 에디터가 연결되어 있어 기다립니다.');
    }
  } catch (e) {
    log(`중계 서버 확인 실패(계속 진행): ${e.message}`);
  }
  if (state !== 'paused') await openEditor();
  for (;;) {
    await sleep(CHECK_MS);
    try {
      await tick();
    } catch (e) {
      log(`오류: ${e.message}`);
      if (state === 'starting') {
        await closeEditor('시작 실패');
        state = 'stopped';
        await sleep(30000);
        await openEditor().catch((err) => log(`다시 시작 실패: ${err.message}`));
      }
    }
  }
}

const stop = async (sig) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${sig} 받음: 종료합니다.`);
  await closeEditor('서비스 종료');
  process.exit(0);
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

main().catch(async (e) => {
  log(`시작 실패: ${e.message}`);
  await closeEditor('시작 실패').catch(() => {});
  process.exit(1);
});
