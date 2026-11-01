// ProjectAPI: 프로젝트를 다루는 도구 모음. 모든 AI 진입 경로가 이 정의 하나를 공유한다.
//
//   window.godotAI (페이지 JS)  ─┐
//   WebMCP (navigator.modelContext) ─┼─> ProjectAPI.call(name, args)
//   DOM AI 패널                  ─┤
//   (예정) MCP 중계 서버 WebSocket ─┘
//
// 도구 정의는 MCP의 tools/list 형식(name, description, inputSchema, annotations)을 그대로 따른다.
// 결과는 JSON 직렬화 가능한 객체이며, 이미지는 { type: 'image', mimeType, data(base64) } 형태로 돌려준다.
// 나중에 MCP 서버가 붙으면 toolDescriptors()를 그대로 tools/list로, call()을 tools/call로 연결하면 된다.

import * as idb from './idbfs.js';
import { base64ToBytes, bytesToBase64, looksLikeText, normalizeProjectPath, shortSha, utf8Decode } from './util.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };

const PATH_PROP = { type: 'string', description: '프로젝트 기준 경로. 예: "scenes/main.tscn" (res:// 접두사 허용)' };

export class ToolError extends Error {}

export class ProjectAPI extends EventTarget {
  #tools = new Map();

  constructor({ sync, bridge, logs, host, info }) {
    super();
    this.sync = sync;
    this.bridge = bridge;
    this.logs = logs;
    this.host = host;
    this.info = info; // { owner, repo, branch, projectDir, appVersion, godotVersion }
    this.#registerAll();
  }

  define(name, { title, description, inputSchema, annotations, handler }) {
    this.#tools.set(name, {
      name,
      title,
      description,
      inputSchema: { type: 'object', additionalProperties: false, properties: {}, ...inputSchema },
      annotations,
      handler,
    });
  }

  /** MCP tools/list 형식의 도구 목록 */
  toolDescriptors() {
    return [...this.#tools.values()].map(({ handler, ...d }) => d);
  }

  async call(name, args = {}) {
    const tool = this.#tools.get(name);
    if (!tool) throw new ToolError(`알 수 없는 도구: ${name}. 사용 가능한 도구: ${[...this.#tools.keys()].join(', ')}`);
    const input = args && typeof args === 'object' ? args : {};
    for (const req of tool.inputSchema.required ?? []) {
      if (input[req] === undefined || input[req] === null) throw new ToolError(`${name}: '${req}' 인자가 필요합니다`);
    }
    const result = await tool.handler(input);
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

  #registerAll() {
    this.define('get_status', {
      title: '상태 확인',
      description:
        '저장소, 브랜치, 마지막 커밋, GitHub에 아직 올라가지 않은 파일, 충돌, 에디터 준비 여부, 열린 씬 등 전체 상태를 돌려준다. 작업을 시작할 때 먼저 호출하라.',
      annotations: READ_ONLY,
      handler: async () => {
        await this.sync.refreshStatus();
        const s = this.sync.status;
        let editor = null;
        if (this.bridge.ready) editor = await this.bridge.call('get_state').catch(() => null);
        return {
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
          versions: { app: this.info.appVersion, godot: this.info.godotVersion, bridge: this.bridge.version },
        };
      },
    });

    this.define('list_files', {
      title: '파일 목록',
      description: '프로젝트 파일 목록(경로, 크기)을 돌려준다. .godot/ 캐시는 제외된다.',
      inputSchema: { properties: { dir: { type: 'string', description: '이 폴더 아래만 나열 (생략하면 전체)' } } },
      annotations: READ_ONLY,
      handler: async ({ dir }) => {
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
      },
    });

    this.define('read_file', {
      title: '파일 읽기',
      description: '파일 내용을 읽는다. 텍스트(.gd, .tscn, .tres, .godot 등)는 utf8, 이미지 등 바이너리는 base64로 돌려준다.',
      inputSchema: { properties: { path: PATH_PROP }, required: ['path'] },
      annotations: READ_ONLY,
      handler: async ({ path }) => {
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
      },
    });

    this.define('write_files', {
      title: '파일 쓰기',
      description:
        '파일을 만들거나 덮어쓴다(여러 개 가능). 열려 있는 씬과 스크립트는 에디터에 바로 반영되고, 잠시 뒤 GitHub에 자동으로 커밋된다. ' +
        '.tscn/.tres는 Godot 텍스트 형식을 지켜야 한다. 기존 파일을 고칠 때는 먼저 read_file로 읽어라.',
      inputSchema: {
        properties: {
          files: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: PATH_PROP,
                content: { type: 'string', description: '파일 내용' },
                encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
              },
              required: ['path', 'content'],
            },
          },
          commit_message: { type: 'string', description: '다음 커밋 메시지에 넣을 설명 (선택)' },
        },
        required: ['files'],
      },
      annotations: WRITE,
      handler: async ({ files, commit_message }) => {
        this.#requireBridge();
        if (!Array.isArray(files) || !files.length) throw new ToolError('files 배열이 비어 있습니다');
        const payload = files.map((f) => ({ path: this.#path(f.path), content: String(f.content ?? ''), encoding: f.encoding === 'base64' ? 'base64' : 'utf8' }));
        const res = await this.bridge.call('write_files', { files: payload }, 60000);
        if (commit_message) this.sync.addNote(commit_message);
        this.sync.refreshStatus();
        return res;
      },
    });

    this.define('delete_files', {
      title: '파일 삭제',
      description: '파일을 삭제한다. 삭제도 GitHub에 커밋된다(기록에서 되돌릴 수 있음).',
      inputSchema: {
        properties: { paths: { type: 'array', minItems: 1, items: PATH_PROP }, commit_message: { type: 'string' } },
        required: ['paths'],
      },
      annotations: DESTRUCTIVE,
      handler: async ({ paths, commit_message }) => {
        this.#requireBridge();
        const res = await this.bridge.call('delete_files', { paths: paths.map((p) => this.#path(p)) });
        if (commit_message) this.sync.addNote(commit_message);
        this.sync.refreshStatus();
        return res;
      },
    });

    this.define('get_editor_state', {
      title: '에디터 상태',
      description: '현재 편집 중인 씬, 열린 씬 목록, 선택된 노드, 메인 씬, 게임 실행 여부를 돌려준다.',
      annotations: READ_ONLY,
      handler: async () => {
        this.#requireBridge();
        return this.bridge.call('get_state');
      },
    });

    this.define('open_scene', {
      title: '씬 열기',
      description: '에디터에서 씬(.tscn)을 연다.',
      inputSchema: { properties: { path: PATH_PROP }, required: ['path'] },
      annotations: WRITE,
      handler: async ({ path }) => {
        this.#requireBridge();
        await this.bridge.call('open_scene', { path: this.#path(path) });
        return { opened: this.#path(path) };
      },
    });

    this.define('set_main_screen', {
      title: '에디터 화면 전환',
      description: '에디터 가운데 화면을 2D, 3D, Script, Game, AssetLib 중 하나로 바꾼다. 스크린샷 전에 2D/3D로 바꾸면 씬이 보인다.',
      inputSchema: { properties: { name: { type: 'string', enum: ['2D', '3D', 'Script', 'Game', 'AssetLib'] } }, required: ['name'] },
      annotations: WRITE,
      handler: async ({ name }) => {
        this.#requireBridge();
        await this.bridge.call('set_main_screen', { name });
        return { main_screen: name };
      },
    });

    this.define('screenshot', {
      title: '에디터 스크린샷',
      description: 'Godot 에디터 화면을 PNG로 캡처한다. 씬 배치 결과를 눈으로 확인할 때 쓴다.',
      inputSchema: { properties: { max_width: { type: 'integer', minimum: 200, maximum: 2560, default: 1280 } } },
      annotations: READ_ONLY,
      handler: async ({ max_width }) => {
        this.#requireBridge();
        const r = await this.bridge.call('screenshot', { max_width: max_width ?? 1280 });
        return { type: 'image', mimeType: r.mime_type, width: r.width, height: r.height, data: r.data };
      },
    });

    this.define('run_project', {
      title: '게임 실행',
      description: '게임을 실행한다. scene을 생략하면 메인 씬, "current"면 지금 편집 중인 씬, 경로를 주면 그 씬을 실행한다. 출력은 get_logs로 본다.',
      inputSchema: { properties: { scene: { type: 'string', description: '생략, "current", 또는 씬 경로' } } },
      annotations: WRITE,
      handler: async ({ scene }) => {
        this.#requireBridge();
        const arg = !scene ? '' : scene === 'current' ? 'current' : this.#path(scene);
        await this.bridge.call('play', { scene: arg });
        return { started: arg || 'main scene' };
      },
    });

    this.define('stop_project', {
      title: '게임 종료',
      description: '실행 중인 게임을 종료한다.',
      annotations: WRITE,
      handler: async () => {
        if (this.bridge.ready) await this.bridge.call('stop').catch(() => {});
        this.host.stopGame();
        return { stopped: true };
      },
    });

    this.define('get_logs', {
      title: '로그',
      description: 'Godot 에디터와 게임의 출력(print, 오류)을 돌려준다. 스크립트 오류를 확인할 때 쓴다. since에 이전 결과의 last_seq를 주면 그 뒤만 받는다.',
      inputSchema: {
        properties: {
          since: { type: 'integer', minimum: 0 },
          level: { type: 'string', enum: ['error'] },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
        },
      },
      annotations: READ_ONLY,
      handler: async ({ since, level, limit }) => {
        const lines = this.logs.query({ since: since ?? 0, level: level ?? null, limit: limit ?? 200 });
        return { lines: lines.map((l) => `[${l.source}${l.level === 'error' ? ' ERROR' : ''}] ${l.text}`), last_seq: lines.at(-1)?.seq ?? since ?? 0 };
      },
    });

    this.define('sync_now', {
      title: '지금 저장',
      description: '열린 씬을 저장하고, 아직 올라가지 않은 변경을 즉시 GitHub에 커밋한다. 자동 저장을 기다리지 않을 때 쓴다.',
      inputSchema: { properties: { message: { type: 'string', description: '커밋 메시지 (선택)' } } },
      annotations: WRITE,
      handler: async ({ message }) => {
        if (this.bridge.ready) await this.bridge.call('save_all').catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
        const res = await this.sync.push(message);
        return res.commit ? { commit: res.commit, short: shortSha(res.commit), files: res.files } : { commit: null, message: '올릴 변경이 없습니다' };
      },
    });

    this.define('pull_remote', {
      title: '원격 변경 받기',
      description: 'GitHub에서 다른 곳(Claude Code, 다른 기기)이 만든 커밋을 즉시 받아 에디터에 반영한다.',
      annotations: WRITE,
      handler: async () => this.sync.pull(),
    });
  }
}
