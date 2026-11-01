// 설정과 토큰 저장. 토큰은 이 브라우저에만 저장되고 api.github.com 외에는 보내지 않는다.

const SETTINGS_KEY = 'gwe:settings';
const TOKEN_KEY = 'gwe:token';

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

export function loadToken() {
  return sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY);
}

/** remember=true면 localStorage(브라우저를 닫아도 유지), 아니면 sessionStorage(탭을 닫으면 삭제) */
export function saveToken(token, remember) {
  clearToken();
  (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
}

const isLocalhost = () => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

/**
 * 개발/테스트용 URL 옵션. 토큰이 다른 서버로 새지 않도록 페이지가 localhost에서 열렸을 때만 api 주소를 바꿀 수 있다.
 *  ?api=http://localhost:9000  ?autosave=2  ?poll=3
 */
export function devOptions() {
  const q = new URLSearchParams(location.search);
  const num = (k) => (q.has(k) && Number.isFinite(+q.get(k)) ? +q.get(k) : undefined);
  const opts = { autosaveSec: num('autosave'), pollSec: num('poll'), statusSec: num('status') };
  if (isLocalhost() && q.get('api')) opts.apiBase = q.get('api');
  return opts;
}

export function projectDirFor(owner, repo, branch) {
  const clean = (s) => String(s).replace(/[^\w.-]/g, '_');
  return `/home/web_user/projects/${clean(owner)}__${clean(repo)}__${clean(branch)}`;
}
