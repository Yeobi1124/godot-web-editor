// 상단 상태 표시줄, 알림, 설정 대화상자

import { formatTime, shortSha } from './util.js';

const $ = (sel) => document.querySelector(sel);

export function toast(message, kind = 'info', ms = 4500) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  box.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? ms * 2 : ms);
}

export function setLoading(text, progress = null) {
  const overlay = $('#loading');
  if (text === null) {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;
  $('#loading-text').textContent = text;
  const bar = $('#loading-bar');
  if (progress === null) bar.removeAttribute('value');
  else bar.value = progress;
}

export function showFatal(title, detail) {
  setLoading(null);
  const box = $('#fatal');
  $('#fatal-title').textContent = title;
  $('#fatal-detail').textContent = detail;
  box.hidden = false;
}

export function renderStatus(status, { repoLabel, bridgeReady }) {
  $('#repo-label').textContent = repoLabel;
  const pill = $('#sync-pill');
  let text;
  let state;
  if (status.phase === 'pulling') [text, state] = ['받는 중…', 'busy'];
  else if (status.phase === 'pushing') [text, state] = ['저장 중…', 'busy'];
  else if (status.phase === 'error') [text, state] = [`오류: ${status.lastError ?? ''}`, 'error'];
  else if (status.pending.length) [text, state] = [`저장 대기 ${status.pending.length}개`, 'pending'];
  else if (status.remotePending.length) [text, state] = [`원격 변경 ${status.remotePending.length}개 적용 대기`, 'pending'];
  else [text, state] = [`동기화됨 · ${shortSha(status.head)}`, 'ok'];
  pill.textContent = text;
  pill.dataset.state = state;
  const last = Math.max(status.lastPush ?? 0, status.lastPull ?? 0);
  pill.title = [
    `커밋: ${status.head ?? '-'}`,
    `마지막 확인: ${last ? formatTime(last) : '-'}`,
    status.pending.length ? `저장 대기:\n  ${status.pending.slice(0, 15).join('\n  ')}` : '',
    status.conflicts.length ? `충돌(로컬 유지):\n  ${status.conflicts.join('\n  ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  $('#bridge-dot').dataset.ready = String(bridgeReady);
  $('#bridge-dot').title = bridgeReady ? '에디터 브리지 연결됨 (AI 도구 사용 가능)' : '에디터 브리지 대기 중';
}

/** 로그인 화면. 버튼은 /auth/login으로 이동하므로 이 함수는 끝나지 않는다 */
export function askLogin(errorText = '') {
  setLoading(null);
  const dlg = $('#login');
  $('#login-error').textContent = errorText;
  $('#login-error').hidden = !errorText;
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  if (!dlg.open) dlg.showModal();
  return new Promise(() => {});
}

/**
 * 프로젝트 선택 화면.
 * repos: [{ owner, name, full_name, default_branch, private, can_push }]
 * 선택하면 { owner, repo, branch }. onRefresh()는 새 { repos } 를, onLogout()은 로그아웃을 처리한다.
 */
export function askProject({ user, repos, installUrl, last = {}, error = '', onRefresh, onLogout }) {
  setLoading(null);
  const dlg = $('#picker');
  const form = $('#picker-form');
  $('#picker-user').textContent = user ? `${user.name || user.login} (@${user.login})` : '';
  const install = $('#picker-install');
  install.hidden = !installUrl;
  if (installUrl) install.href = installUrl;
  const showError = (text) => {
    $('#picker-error').textContent = text;
    $('#picker-error').hidden = !text;
  };
  showError(error);

  const render = (list) => {
    const box = $('#picker-list');
    box.replaceChildren(
      ...list.map((r) => {
        const label = document.createElement('label');
        label.className = 'repo-item';
        const input = document.createElement('input');
        Object.assign(input, { type: 'radio', name: 'repo', value: r.full_name });
        input.dataset.branch = r.default_branch;
        input.disabled = !r.can_push;
        input.addEventListener('change', () => {
          form.branch.value = r.full_name === `${last.owner}/${last.repo}` && last.branch ? last.branch : r.default_branch;
        });
        const name = document.createElement('span');
        name.textContent = r.full_name;
        const meta = document.createElement('span');
        meta.className = 'muted';
        meta.textContent = [r.private ? '비공개' : '공개', r.can_push ? '' : '읽기 전용'].filter(Boolean).join(' · ');
        label.append(input, name, meta);
        return label;
      }),
    );
    $('#picker-empty').hidden = list.length > 0;
    const pick = list.find((r) => r.full_name === `${last.owner}/${last.repo}` && r.can_push) ?? list.find((r) => r.can_push);
    const input = pick && [...box.querySelectorAll('input')].find((i) => i.value === pick.full_name);
    if (input) {
      input.checked = true;
      input.dispatchEvent(new Event('change'));
    } else form.branch.value = '';
    $('#picker-open').disabled = !pick;
  };
  render(repos);

  $('#picker-refresh').onclick = async () => {
    showError('');
    try {
      render((await onRefresh()).repos);
    } catch (e) {
      showError(e.message);
    }
  };
  $('#picker-logout').onclick = () => onLogout();
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  if (!dlg.open) dlg.showModal();
  return new Promise((resolve) => {
    form.onsubmit = (e) => {
      e.preventDefault();
      const checked = form.querySelector('input[name="repo"]:checked');
      if (!checked) {
        showError('저장소를 고르세요.');
        return;
      }
      const [owner, repo] = checked.value.split('/');
      dlg.close();
      resolve({ owner, repo, branch: form.branch.value.trim() || checked.dataset.branch || 'main' });
    };
  });
}
