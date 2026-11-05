// 앱 시작 순서:
//  1. GitHub 로그인(같은 주소의 Cloudflare Worker) → 프로젝트 선택
//  2. GitHub와 브라우저 저장소 동기화 (에디터 시작 전, IndexedDB에 직접 반영) + 브리지 애드온 설치
//  3. Godot 에디터 시작 -> 브리지 애드온 연결
//  4. 자동 저장/원격 확인 시작, AI 진입점(window.godotAI, WebMCP, AI 패널) 준비
/* global Engine */

import { AIPanel } from './ai-panel.js';
import { installGodotAI, registerWebMCP } from './ai-bridge.js';
import { EditorBridge } from './bridge.js';
import { GitHubClient, GitHubError } from './github.js';
import { GodotHost } from './godot-host.js';
import * as idb from './idbfs.js';
import { LogBuffer } from './logs.js';
import { McpLink } from './mcp-link.js';
import { ProjectAPI } from './project-api.js';
import { loadBundledBridge, planScaffold } from './scaffold.js';
import { devOptions, loadSettings, projectDirFor, saveSettings } from './settings.js';
import { SyncEngine } from './sync.js';
import { askLogin, askProject, renderStatus, setLoading, showFatal, toast } from './ui.js';

const $ = (sel) => document.querySelector(sel);
const logs = new LogBuffer();
const app = { logs }; // 디버깅용: window.__gwe
window.__gwe = app;

async function loadBuildInfo() {
  try {
    const res = await fetch('build-info.json', { cache: 'no-cache' });
    if (res.ok) return await res.json();
  } catch {
    /* 개발 환경 */
  }
  return { app: 'dev', godot: 'unknown' };
}

/** 같은 프로젝트를 두 탭에서 열면 IndexedDB가 서로 덮어쓰므로 막는다 */
async function acquireTabLock(projectDir) {
  if (!navigator.locks) return true;
  return new Promise((resolve) => {
    navigator.locks.request(`gwe:${projectDir}`, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(false);
        return undefined;
      }
      resolve(true);
      return new Promise(() => {}); // 탭이 닫힐 때까지 유지
    });
  });
}

const PICK_KEY = 'gwe:pick-project';

/** 서비스 워커가 이 페이지를 맡을 때까지 잠깐 기다린다 (처음 방문 직후에는 아직 없을 수 있음) */
async function waitForServiceWorker(timeoutMs = 5000) {
  if (!('serviceWorker' in navigator) || navigator.serviceWorker.controller) return;
  await Promise.race([
    new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function getJson(path) {
  const res = await fetch(path, { cache: 'no-store', headers: { Accept: 'application/json' } });
  if (res.status === 401) return { unauthorized: true };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${path}: ${res.status}`);
  return data;
}

async function cloudLogout() {
  await fetch('/auth/logout', { method: 'POST', headers: { 'X-GWE': '1' } }).catch(() => {});
  location.reload();
}

/**
 * 같은 주소의 Worker에 로그인하고 프로젝트를 고른다.
 * GitHub 토큰은 브라우저에 없고, GitHubClient는 /gh 로 요청한다(Worker가 세션 토큰을 붙임).
 */
async function connectCloud({ onLoggedIn } = {}) {
  let error = '';
  let forcePick = sessionStorage.getItem(PICK_KEY) === '1';
  sessionStorage.removeItem(PICK_KEY);
  let expiredShown = false;
  const onUnauthorized = () => {
    if (expiredShown) return;
    expiredShown = true;
    askLogin('로그인이 만료되었습니다. 다시 로그인하세요. 아직 올라가지 않은 변경은 이 브라우저에 남아 있다가 다시 로그인하면 올라갑니다.');
  };
  for (;;) {
    setLoading('로그인 확인 중…');
    const me = await getJson('/api/me');
    if (me.unauthorized) return askLogin();
    onLoggedIn?.();
    setLoading('저장소 목록을 가져오는 중…');
    const list = await getJson('/api/repos');
    if (list.unauthorized) return askLogin();
    const last = loadSettings();
    const known = list.repos.find((r) => r.full_name === `${last.owner}/${last.repo}`);
    const settings =
      !error && !forcePick && known
        ? { owner: last.owner, repo: last.repo, branch: last.branch || known.default_branch }
        : await askProject({
            user: me.user,
            repos: list.repos,
            installUrl: list.install_url,
            last,
            error,
            onRefresh: () => getJson('/api/repos'),
            onLogout: cloudLogout,
          });
    forcePick = false;
    setLoading('GitHub 저장소 확인 중…');
    const gh = new GitHubClient({ owner: settings.owner, repo: settings.repo, apiBase: '/gh', onUnauthorized });
    try {
      const repo = await gh.getRepo();
      if (repo.permissions && !repo.permissions.push) {
        error = `${settings.owner}/${settings.repo}에 쓸 권한이 없습니다.`;
        continue;
      }
      saveSettings({ ...settings, remember: true });
      return { gh, settings };
    } catch (e) {
      if (e instanceof GitHubError && e.status === 401) return askLogin();
      if (e instanceof GitHubError && (e.status === 403 || e.status === 404)) {
        error = `${settings.owner}/${settings.repo}을(를) 열 수 없습니다 (${e.status}). 앱에 이 저장소가 추가되어 있는지 확인하세요.`;
        continue;
      }
      throw e;
    }
  }
}

function bindToolbar({ api, sync, panel }) {
  $('#btn-save').addEventListener('click', async () => {
    try {
      let r = await api.call('sync_now');
      if (r.blocked) {
        const sample = r.paths.slice(0, 10).join('\n  ');
        const ok = confirm(`이 저장은 파일 ${r.deletes}개를 GitHub에서 삭제합니다.\n\n  ${sample}${r.deletes > 10 ? '\n  ...' : ''}\n\n정말 지운 파일이 맞나요? (실수라면 취소하고 '설정 → 이 브라우저의 프로젝트 사본 지우고 다시 받기'를 쓰세요)`);
        if (!ok) return;
        const res = await sync.push(undefined, { allowMassDelete: true });
        r = res.commit ? { commit: res.commit, short: res.commit.slice(0, 7), files: res.files } : { commit: null };
      }
      toast(r.commit ? `저장했습니다: 커밋 ${r.short} (파일 ${r.files.length}개)` : '올릴 변경이 없습니다');
    } catch (e) {
      toast(`저장 실패: ${e.message}`, 'error');
    }
  });
  $('#btn-pull').addEventListener('click', async () => {
    try {
      const r = await sync.pull();
      toast(r.applied ? `원격 변경 ${r.applied}개를 반영했습니다` : '새 원격 변경이 없습니다');
    } catch (e) {
      toast(`원격 확인 실패: ${e.message}`, 'error');
    }
  });
  $('#btn-panel').addEventListener('click', () => panel.toggle());
  $('#btn-settings').addEventListener('click', () => $('#settings').showModal());
  $('#btn-logout').addEventListener('click', () => {
    if (sync.status.pending.length && !confirm(`아직 GitHub에 올라가지 않은 파일이 ${sync.status.pending.length}개 있습니다. 그래도 로그아웃할까요?\n(파일은 이 브라우저에 남아 있어 다시 로그인하면 올라갑니다)`)) return;
    cloudLogout();
  });
  $('#btn-change-repo').addEventListener('click', () => {
    sessionStorage.setItem(PICK_KEY, '1');
    location.reload();
  });
  $('#btn-reset-local').addEventListener('click', async () => {
    const pending = sync.status.pending.length;
    if (!confirm(`이 브라우저에 저장된 프로젝트 사본을 지우고 GitHub에서 다시 받습니다.${pending ? `\n\n주의: 아직 올라가지 않은 파일 ${pending}개가 사라집니다!` : ''}\n\n계속할까요?`)) return;
    sync.stop();
    await idb.deleteTree(sync.projectDir);
    sync.resetState();
    location.reload();
  });
  $('#settings-close').addEventListener('click', () => $('#settings').close());
}

/** MCP 연결: 같은 주소의 Worker(/live)에 로그인 쿠키로 자동 연결. Claude의 도구 호출이 이 탭으로 온다 */
function setupMcp({ api, sync, bridge, info }) {
  const mcp = new McpLink({ api, sync, bridge, logs, info });
  const badge = $('#mcp-badge');
  const LABEL = { off: '연결 안 함', connecting: '연결 중…', connected: '연결됨', rejected: '연결 실패' };
  const render = () => {
    badge.hidden = mcp.status === 'off';
    badge.dataset.state = mcp.status;
    badge.title = `Claude 연결(MCP): ${LABEL[mcp.status]}${mcp.detail ? ` — ${mcp.detail}` : ''}`;
  };
  const renderCalls = () => {
    $('#mcp-calls').replaceChildren(
      ...mcp.recent.map((c) => {
        const li = document.createElement('li');
        li.className = c.ok ? '' : 'err';
        li.textContent = `${new Date(c.time).toLocaleTimeString()} ${c.name} (${c.ms}ms)${c.ok ? '' : ` — ${c.error.slice(0, 120)}`}`;
        return li;
      }),
    );
  };
  mcp.addEventListener('status', render);
  mcp.addEventListener('call', renderCalls);
  mcp.configure({ url: location.origin, path: '/live' });
  return mcp;
}

async function main() {
  const missing = GodotHost.missingFeatures();
  if (missing.length) {
    showFatal(
      '이 브라우저에서는 Godot 웹 에디터를 실행할 수 없습니다',
      `필요한 기능: ${missing.join(', ')}\n데스크톱용 Chrome 또는 Edge 최신 버전을 사용하세요.` +
        (window.crossOriginIsolated ? '' : '\n(페이지를 한 번 새로고침하면 해결될 수 있습니다.)'),
    );
    return;
  }
  const build = await loadBuildInfo();
  const dev = devOptions();
  // 엔진(wasm) 다운로드는 로그인 확인 뒤, 서비스 워커가 페이지를 맡은 다음에 시작한다
  // (서비스 워커가 엔진 조각을 받아 이어 붙임. 크기를 알려 주면 압축 전송이어도 진행률이 보인다.
  //  다운로드 완료를 기다리지는 않는다: 진행률은 host.init이 보여 줌)
  let enginePreload = null;
  const preloadEngine = () => {
    enginePreload ??= waitForServiceWorker().then(() => {
      Engine.load('godot.editor', build.wasmSize || 0);
    });
    return enginePreload;
  };

  const { gh, settings } = await connectCloud({ onLoggedIn: preloadEngine });
  const projectDir = projectDirFor(settings.owner, settings.repo, settings.branch);
  if (!(await acquireTabLock(projectDir))) {
    showFatal('이미 다른 탭에서 이 프로젝트를 열었습니다', '같은 프로젝트를 여러 탭에서 동시에 열면 파일이 서로 덮어써집니다. 다른 탭을 닫고 새로고침하세요.');
    return;
  }

  const bridge = new EditorBridge();
  const sync = new SyncEngine({ gh, branch: settings.branch, projectDir, bridge, logs });
  const repoLabel = `${settings.owner}/${settings.repo} · ${settings.branch}`;
  const refresh = () => renderStatus(sync.status, { repoLabel, bridgeReady: bridge.ready });
  sync.addEventListener('status', refresh);
  bridge.addEventListener('ready', refresh);
  bridge.addEventListener('gone', refresh);
  refresh();
  Object.assign(app, { gh, sync, bridge, projectDir });

  // 2. 에디터 시작 전 동기화
  setLoading('GitHub에서 프로젝트를 받는 중…');
  const bridgeFiles = await loadBundledBridge();
  const summary = await sync.prepare({
    scaffold: (local) => planScaffold(local, { projectName: settings.repo, bridgeFiles, installBridge: true }),
  });
  if (summary.downloaded || summary.deleted) logs.info(`GitHub에서 파일 ${summary.downloaded}개를 받고 ${summary.deleted}개를 지웠습니다.`);
  if (summary.scaffolded.length) logs.info(`프로젝트 구성 파일을 추가/갱신했습니다: ${summary.scaffolded.join(', ')}`);
  if (summary.conflicts.length) toast(`충돌 파일 ${summary.conflicts.length}개는 로컬 내용을 유지했습니다. 로그를 확인하세요.`, 'error');

  // 3. 에디터 시작
  const host = new GodotHost({ editorCanvas: $('#editor-canvas'), gameCanvas: $('#game-canvas'), gameLayer: $('#game-layer'), logs });
  app.host = host;
  setLoading('Godot 에디터 내려받는 중…', 0);
  await preloadEngine();
  await host.init((current, total) => {
    if (total > 0) setLoading(`Godot 에디터 내려받는 중… ${Math.round((current / total) * 100)}%`, current / total);
    else setLoading('Godot 에디터 준비 중…');
  });
  setLoading('Godot 에디터 시작 중…');
  await host.startEditor(projectDir);
  setLoading(null);
  $('#btn-game-stop').addEventListener('click', () => host.stopGame());
  host.addEventListener('editor-exit', () => showFatal('Godot 에디터가 종료되었습니다', '페이지를 새로고침하면 다시 시작합니다.'));

  // 4. AI 진입점과 주기 동기화
  const api = new ProjectAPI({
    sync,
    bridge,
    logs,
    host,
    info: { owner: settings.owner, repo: settings.repo, branch: settings.branch, projectDir, appVersion: build.app, godotVersion: build.godot },
  });
  app.api = api;
  installGodotAI(api);
  registerWebMCP(api, logs);
  const panel = new AIPanel({ root: $('#ai-panel'), api, logs, toast });
  bindToolbar({ api, sync, panel });
  app.mcp = setupMcp({ api, sync, bridge, info: api.info });

  sync.start({ autosaveSec: dev.autosaveSec ?? 30, pollSec: dev.pollSec ?? 30, statusSec: dev.statusSec ?? 10 });
  window.addEventListener('beforeunload', (e) => {
    if (sync.status.pending.length) e.preventDefault();
  });
  sync.addEventListener('remote-applied', (e) => {
    if (e.detail.applied) toast(`원격 변경 ${e.detail.applied}개를 에디터에 반영했습니다`);
    if (e.detail.conflicts.length) toast(`충돌 파일 ${e.detail.conflicts.length}개는 로컬 내용을 유지했습니다`, 'error');
  });

  if (!(await bridge.waitReady(90000))) {
    toast('에디터 브리지가 연결되지 않았습니다. 실시간 반영과 AI 도구가 제한됩니다 (Project > Project Settings > Plugins에서 Web Editor Bridge를 켜세요).', 'error', 10000);
  }
  app.ready = true;
  document.body.dataset.ready = 'true';
}

main().catch((e) => {
  console.error(e);
  showFatal('시작하지 못했습니다', e.message || String(e));
});
