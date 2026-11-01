// DOM AI 패널: Godot 에디터(캔버스)를 직접 조작하기 어려운 브라우저 에이전트와 사람이 함께 쓰는 패널.
// 파일 편집, 로그, AI 연결 안내. 모든 동작은 ProjectAPI 도구를 통해 처리한다.

const $ = (sel, root = document) => root.querySelector(sel);

export class AIPanel {
  constructor({ root, api, logs, toast }) {
    this.root = root;
    this.api = api;
    this.logs = logs;
    this.toast = toast;
    this.current = null; // { path, encoding }
    this.#bindTabs();
    this.#bindFiles();
    this.#bindLogs();
    this.#renderTools();
  }

  toggle(force) {
    const show = force ?? this.root.hidden;
    this.root.hidden = !show;
    document.getElementById('btn-panel').setAttribute('aria-expanded', String(show));
    if (show && !this.loadedOnce) this.refreshFiles();
  }

  #bindTabs() {
    for (const btn of this.root.querySelectorAll('[role="tab"]')) {
      btn.addEventListener('click', () => {
        for (const b of this.root.querySelectorAll('[role="tab"]')) b.setAttribute('aria-selected', String(b === btn));
        for (const p of this.root.querySelectorAll('[role="tabpanel"]')) p.hidden = p.id !== btn.getAttribute('aria-controls');
        if (btn.id === 'tab-logs') this.#renderLogs();
      });
    }
  }

  // ---------- 파일 ----------

  #bindFiles() {
    $('#ai-files-refresh').addEventListener('click', () => this.refreshFiles());
    $('#ai-file-new').addEventListener('click', () => this.#openEditor({ path: '', content: '', encoding: 'utf8' }));
    $('#ai-file-save').addEventListener('click', () => this.#save());
    $('#ai-file-delete').addEventListener('click', () => this.#delete());
    $('#ai-files-filter').addEventListener('input', () => this.#renderFileList());
  }

  async refreshFiles() {
    const list = $('#ai-files-list');
    list.setAttribute('aria-busy', 'true');
    try {
      const { files } = await this.api.call('list_files');
      this.files = files.sort((a, b) => a.path.localeCompare(b.path));
      this.loadedOnce = true;
      this.#renderFileList();
    } catch (e) {
      list.textContent = `파일 목록을 불러오지 못했습니다: ${e.message}`;
    } finally {
      list.removeAttribute('aria-busy');
    }
  }

  #renderFileList() {
    const list = $('#ai-files-list');
    const q = $('#ai-files-filter').value.trim().toLowerCase();
    list.replaceChildren(
      ...(this.files ?? [])
        .filter((f) => !q || f.path.toLowerCase().includes(q))
        .map((f) => {
          const li = document.createElement('li');
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'file-item';
          b.dataset.path = f.path;
          b.textContent = f.path;
          b.title = `${f.path} (${f.size} bytes)`;
          if (this.current?.path === f.path) b.setAttribute('aria-current', 'true');
          b.addEventListener('click', () => this.openFile(f.path));
          li.append(b);
          return li;
        }),
    );
  }

  async openFile(path) {
    try {
      const r = await this.api.call('read_file', { path });
      this.#openEditor(r);
    } catch (e) {
      this.toast(`열기 실패: ${e.message}`, 'error');
    }
  }

  #openEditor({ path, content, encoding, size }) {
    this.current = { path, encoding };
    const area = $('#ai-file-content');
    $('#ai-file-path').value = path;
    $('#ai-file-editor').hidden = false;
    if (encoding === 'base64') {
      area.value = `(바이너리 파일, ${size ?? '?'} bytes — 여기서는 편집할 수 없습니다)`;
      area.readOnly = true;
      $('#ai-file-save').disabled = true;
    } else {
      area.value = content;
      area.readOnly = false;
      $('#ai-file-save').disabled = false;
    }
    $('#ai-file-delete').disabled = !path;
    this.#renderFileList();
    (path ? area : $('#ai-file-path')).focus();
  }

  async #save() {
    const path = $('#ai-file-path').value.trim();
    if (!path) return this.toast('파일 경로를 입력하세요', 'error');
    try {
      const r = await this.api.call('write_files', { files: [{ path, content: $('#ai-file-content').value }] });
      if (r.errors?.length) throw new Error(r.errors.join('; '));
      this.toast(`저장했습니다: ${path} (곧 GitHub에 커밋됩니다)`);
      this.current = { path, encoding: 'utf8' };
      if (!this.files?.some((f) => f.path === path)) await this.refreshFiles();
    } catch (e) {
      this.toast(`저장 실패: ${e.message}`, 'error');
    }
  }

  async #delete() {
    const path = this.current?.path;
    if (!path || !confirm(`${path} 파일을 삭제할까요? (GitHub 기록에서 되돌릴 수 있습니다)`)) return;
    try {
      await this.api.call('delete_files', { paths: [path] });
      this.toast(`삭제했습니다: ${path}`);
      $('#ai-file-editor').hidden = true;
      this.current = null;
      await this.refreshFiles();
    } catch (e) {
      this.toast(`삭제 실패: ${e.message}`, 'error');
    }
  }

  // ---------- 로그 ----------

  #bindLogs() {
    $('#ai-logs-errors').addEventListener('change', () => this.#renderLogs());
    this.logs.addEventListener('line', () => {
      if (!$('#panel-logs').hidden && !this.root.hidden) this.#renderLogs();
    });
  }

  #renderLogs() {
    const errorsOnly = $('#ai-logs-errors').checked;
    const lines = this.logs.query({ level: errorsOnly ? 'error' : null, limit: 400 });
    const out = $('#ai-logs-output');
    out.textContent = lines.map((l) => `${new Date(l.time).toLocaleTimeString()} [${l.source}] ${l.text}`).join('\n');
    out.scrollTop = out.scrollHeight;
  }

  // ---------- AI 연결 안내 ----------

  #renderTools() {
    const ul = $('#ai-tools-list');
    ul.replaceChildren(
      ...this.api.toolDescriptors().map((t) => {
        const li = document.createElement('li');
        const code = document.createElement('code');
        code.textContent = t.name;
        li.append(code, ` — ${t.description}`);
        return li;
      }),
    );
    $('#ai-copy-prompt').addEventListener('click', async () => {
      const text = $('#ai-prompt').textContent;
      try {
        await navigator.clipboard.writeText(text);
        this.toast('클립보드에 복사했습니다');
      } catch {
        this.toast('복사하지 못했습니다. 직접 선택해서 복사하세요.', 'error');
      }
    });
  }
}
