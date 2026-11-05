// 브라우저에 기억하는 설정 (마지막에 연 프로젝트). GitHub 토큰은 브라우저에 두지 않는다(Worker 세션이 보관).

const SETTINGS_KEY = 'gwe:settings';

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
  } catch {
    return {};
  }
}

export function saveSettings({ owner, repo, branch, remember }) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ owner, repo, branch, remember }));
}

/** 개발/테스트용 URL 옵션 (초 단위): ?autosave=3&poll=3&status=2 */
export function devOptions() {
  const q = new URLSearchParams(location.search);
  const num = (k) => (q.has(k) && Number.isFinite(+q.get(k)) ? +q.get(k) : undefined);
  return { autosaveSec: num('autosave'), pollSec: num('poll'), statusSec: num('status') };
}

export function projectDirFor(owner, repo, branch) {
  const clean = (s) => String(s).replace(/[^\w.-]/g, '_');
  return `/home/web_user/projects/${clean(owner)}__${clean(repo)}__${clean(branch)}`;
}
