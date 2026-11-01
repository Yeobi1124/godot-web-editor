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

/** 저장소/토큰 설정 대화상자. 제출되면 { owner, repo, branch, token, remember } */
export function askSettings(initial = {}, errorText = '') {
  const dlg = $('#setup');
  const form = $('#setup-form');
  form.repo.value = initial.owner && initial.repo ? `${initial.owner}/${initial.repo}` : '';
  form.branch.value = initial.branch || 'main';
  form.token.value = '';
  form.remember.checked = initial.remember ?? true;
  $('#setup-error').textContent = errorText;
  $('#setup-error').hidden = !errorText;
  dlg.showModal();
  return new Promise((resolve) => {
    form.onsubmit = (e) => {
      e.preventDefault();
      const m = form.repo.value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').match(/^([\w.-]+)\/([\w.-]+)$/);
      if (!m) {
        $('#setup-error').textContent = '저장소는 "소유자/이름" 형식으로 입력하세요. 예: Yeobi1124/godot-test';
        $('#setup-error').hidden = false;
        return;
      }
      if (!form.token.value.trim()) {
        $('#setup-error').textContent = 'GitHub 토큰을 입력하세요.';
        $('#setup-error').hidden = false;
        return;
      }
      dlg.close();
      resolve({ owner: m[1], repo: m[2], branch: form.branch.value.trim() || 'main', token: form.token.value.trim(), remember: form.remember.checked });
    };
  });
}
