// ProjectAPI: 프로젝트를 다루는 도구 모음. 모든 AI 진입 경로가 이 정의 하나를 공유한다.
//
//   window.godotAI (페이지 JS)        ─┐
//   WebMCP (navigator.modelContext)  ─┼─> ProjectAPI.call(name, args)
//   DOM AI 패널                       ─┤
//   MCP 중계 서버 (mcp-link.js)        ─┘
//
// 도구의 이름/설명/스키마는 tool-defs.js(중계 서버와 공용)에 있고, 여기서는 브라우저 쪽 처리만 붙인다.
// 결과는 JSON 직렬화 가능한 객체이며, 이미지는 { type: 'image', mimeType, data(base64) } 형태로 돌려준다.

import * as idb from './idbfs.js';
import { TOOL_DEFS, toDescriptor } from './tool-defs.js';
import { base64ToBytes, bytesToBase64, looksLikeText, normalizeProjectPath, shortSha, utf8Decode } from './util.js';

export class ToolError extends Error {}

export class ProjectAPI extends EventTarget {
  #handlers = new Map();

  constructor({ sync, bridge, logs, host, info }) {
    super();
    this.sync = sync;
    this.bridge = bridge;
    this.logs = logs;
    this.host = host;
    this.info = info; // { owner, repo, branch, projectDir, appVersion, godotVersion }
    this.#registerHandlers();
    for (const d of TOOL_DEFS) if (!this.#handlers.has(d.name)) throw new Error(`도구 처리 함수가 없습니다: ${d.name}`);
  }

  /** MCP tools/list 형식의 도구 목록 */
  toolDescriptors() {
    return TOOL_DEFS.map(toDescriptor);
  }

  async call(name, args = {}) {
    const def = TOOL_DEFS.find((d) => d.name === name);
    const handler = this.#handlers.get(name);
    if (!def || !handler) throw new ToolError(`알 수 없는 도구: ${name}. 사용 가능한 도구: ${TOOL_DEFS.map((d) => d.name).join(', ')}`);
    const input = args && typeof args === 'object' ? args : {};
    for (const req of def.inputSchema.required ?? []) {
      if (input[req] === undefined || input[req] === null) throw new ToolError(`${name}: '${req}' 인자가 필요합니다`);
    }
    const result = await handler(input);
    this.dispatchEvent(new CustomEvent('tool-called', { detail: { name, args: input } }));
    return result;
  }

  #path(raw) {
    const p = normalizeProjectPath(raw);
    if (!p) throw new ToolError(`잘못된 경로입니다: ${JSON.stringify(raw)} (프로젝트 안의 상대 경로를 쓰세요)`);
    if (p === '.godot' || p.startsWith('.godot/') || p.startsWith('.git/')) throw new ToolError(`이 경로는 다룰 수 없습니다: ${p}`);
    return p;
  }

  #requireBridge() {
    if (!this.bridge.ready) throw new ToolError('에디터가 아직 준비되지 않았습니다. 에디터 로딩이 끝난 뒤 다시 시도하세요.');
  }

  #on(name, handler) {
    this.#handlers.set(name, handler);
  }

  #registerHandlers() {
    this.#on('get_status', async () => {
      await this.sync.refreshStatus();
      const s = this.sync.status;
      let editor = null;
      if (this.bridge.ready) editor = await this.bridge.call('get_state').catch(() => null);
      return {
        mode: 'editor',
        repository: `${this.info.owner}/${this.info.repo}`,
        branch: this.info.branch,
        head_commit: s.head,
        sync_phase: s.phase,
        unsynced_files: s.pending,
        conflicts: s.conflicts,
        remote_changes_waiting: s.remotePending,
        last_error: s.lastError,
        editor_ready: this.bridge.ready,
        editor,
        game_running: !!this.host.game,
        tab_visible: document.visibilityState === 'visible',
        versions: { app: this.info.appVersion, godot: this.info.godotVersion, bridge: this.bridge.version },
      };
    });

    this.#on('list_files', async ({ dir }) => {
      const prefix = dir ? `${this.#path(dir)}/` : '';
      if (this.bridge.ready) {
        const files = await this.bridge.call('list_files', { dir: prefix.replace(/\/$/, '') });
        return { files: files.map((f) => ({ path: f.path, size: f.size })) };
      }
      const local = await idb.readTree(this.info.projectDir);
      return {
        files: [...local.entries()]
          .filter(([p]) => !p.startsWith('.godot/') && p.startsWith(prefix))
          .map(([path, f]) => ({ path, size: f.contents.length })),
      };
    });

    this.#on('read_file', async ({ path }) => {
      const p = this.#path(path);
      let bytes;
      if (this.bridge.ready) {
        const r = await this.bridge.call('read_file', { path: p, encoding: 'base64' });
        bytes = base64ToBytes(r.content);
      } else {
        const f = (await idb.readTree(this.info.projectDir)).get(p);
        if (!f) throw new ToolError(`파일이 없습니다: ${p}`);
        bytes = f.contents;
      }
      return looksLikeText(bytes)
        ? { path: p, encoding: 'utf8', content: utf8Decode(bytes) }
        : { path: p, encoding: 'base64', size: bytes.length, content: bytesToBase64(bytes) };
    });

    this.#on('write_files', async ({ files, commit_message }) => {
      this.#requireBridge();
      if (!Array.isArray(files) || !files.length) throw new ToolError('files 배열이 비어 있습니다');
      const payload = files.map((f) => ({ path: this.#path(f.path), content: String(f.content ?? ''), encoding: f.encoding === 'base64' ? 'base64' : 'utf8' }));
      const res = await this.bridge.call('write_files', { files: payload }, 60000);
      if (commit_message) this.sync.addNote(commit_message);
      this.sync.refreshStatus();
      return res;
    });

    this.#on('delete_files', async ({ paths, commit_message }) => {
      this.#requireBridge();
      if (!Array.isArray(paths) || !paths.length) throw new ToolError('paths 배열이 비어 있습니다');
      const res = await this.bridge.call('delete_files', { paths: paths.map((p) => this.#path(p)) });
      if (commit_message) this.sync.addNote(commit_message);
      this.sync.refreshStatus();
      return res;
    });

    this.#on('get_editor_state', async () => {
      this.#requireBridge();
      return this.bridge.call('get_state');
    });

    this.#on('open_scene', async ({ path }) => {
      this.#requireBridge();
      await this.bridge.call('open_scene', { path: this.#path(path) });
      return { opened: this.#path(path) };
    });

    this.#on('set_main_screen', async ({ name }) => {
      this.#requireBridge();
      await this.bridge.call('set_main_screen', { name });
      return { main_screen: name };
    });

    this.#on('screenshot', async ({ max_width }) => {
      this.#requireBridge();
      const r = await this.bridge.call('screenshot', { max_width: max_width ?? 1024 });
      return { type: 'image', mimeType: r.mime_type, width: r.width, height: r.height, data: r.data };
    });

    this.#on('run_project', async ({ scene }) => {
      this.#requireBridge();
      const arg = !scene ? '' : scene === 'current' ? 'current' : this.#path(scene);
      await this.bridge.call('play', { scene: arg });
      return { started: arg || 'main scene' };
    });

    this.#on('stop_project', async () => {
      if (this.bridge.ready) await this.bridge.call('stop').catch(() => {});
      this.host.stopGame();
      return { stopped: true };
    });

    this.#on('get_logs', async ({ since, level, limit }) => {
      const lines = this.logs.query({ since: since ?? 0, level: level ?? null, limit: limit ?? 200 });
      return { lines: lines.map((l) => `[${l.source}${l.level === 'error' ? ' ERROR' : ''}] ${l.text}`), last_seq: lines.at(-1)?.seq ?? since ?? 0 };
    });

    this.#on('sync_now', async ({ message }) => {
      if (this.bridge.ready) await this.bridge.call('save_all').catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      const res = await this.sync.push(message);
      return res.commit ? { commit: res.commit, short: shortSha(res.commit), files: res.files } : { commit: null, message: '올릴 변경이 없습니다' };
    });

    this.#on('pull_remote', async () => this.sync.pull());
  }
}
