// 도구 목록 구성과 호출 라우팅
//  - 에디터 탭이 연결되어 있으면 탭으로 전달 (모든 도구)
//  - 탭이 없고 GitHub 설정이 있으면 파일 도구를 GitHub에서 직접 처리
//  - 그 외에는 "에디터를 여세요" 오류

import { TOOL_DEFS, toDescriptor, toMcpContent } from '../../web/js/tool-defs.js';
import { parseProject } from './config.js';
import { GITHUB_TOOLS } from './github-backend.js';
import { log } from './log.js';

const PROJECT_PROP = {
  type: 'string',
  description: '대상 프로젝트 "소유자/저장소@브랜치" (생략하면 열려 있는 웹 에디터의 프로젝트, 없으면 서버 기본 프로젝트)',
};
const SLOW_TOOLS = new Set(['screenshot', 'run_project', 'write_files', 'sync_now', 'pull_remote']);

const LIST_PROJECTS = {
  name: 'list_projects',
  title: '프로젝트 목록',
  description: '지금 연결된 웹 에디터 탭(프로젝트, 에디터 준비 여부, 탭이 화면에 보이는지)과 서버 기본 프로젝트를 돌려준다.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const POWER_NOTE = '서버를 끄면 다시 켤 때까지 Claude가 이 도구들을 쓸 수 없고, 다시 켜려면 사용자가 GitHub Actions의 "서버 전원" 워크플로(start)를 실행해야 한다.';

const POWER_TOOLS = [
  {
    name: 'get_server_power',
    title: '서버 전원 상태',
    description: `이 MCP 서버(작업용 컴퓨터)의 자동 종료 설정, 마지막 사용 시각, 자동 종료까지 남은 시간을 돌려준다. ${POWER_NOTE}`,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'set_auto_stop',
    title: '자동 종료 설정',
    description: `일정 시간 사용이 없으면 서버를 자동으로 끄는 기능을 켜거나 끈다. 사용 = MCP 도구 호출, PC 웹 에디터 연결, SSH 로그인. ${POWER_NOTE}`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', description: '자동 종료 사용 여부' },
        idle_minutes: { type: 'integer', minimum: 1, maximum: 10080, description: '사용이 없을 때 끄기까지 기다릴 시간(분)' },
      },
      required: ['enabled'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'stop_server',
    title: '서버 끄기',
    description: `열려 있는 에디터의 변경을 GitHub에 저장한 뒤 서버(Paperspace 기계)를 지금 끈다. 사용자가 명시적으로 서버를 끄라고 할 때만 사용하라. ${POWER_NOTE}`,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
];
const POWER_TOOL_NAMES = new Set(POWER_TOOLS.map((t) => t.name));

const errorResult = (text) => ({ isError: true, content: [{ type: 'text', text }] });

export class ToolRouter {
  constructor({ link, github, defaultProject, power = null }) {
    this.link = link;
    this.github = github;
    // 고정값 또는 함수 (헤드리스 설정의 프로젝트를 따라가도록)
    this.getDefaultProject = typeof defaultProject === 'function' ? defaultProject : () => defaultProject;
    this.power = power;
  }

  get defaultProject() {
    return this.getDefaultProject() ?? null;
  }

  /** MCP tools/list 결과. 탭 연결 여부와 상관없이 항상 같은 목록을 돌려준다. */
  listTools() {
    const tools = TOOL_DEFS.map((d) => {
      const desc = toDescriptor(d);
      return { ...desc, inputSchema: { ...desc.inputSchema, properties: { ...desc.inputSchema.properties, project: PROJECT_PROP } } };
    });
    return [...tools, LIST_PROJECTS, ...(this.power ? POWER_TOOLS : [])];
  }

  async #callPowerTool(name, args) {
    if (name === 'get_server_power') return toMcpContent(await this.power.status());
    if (name === 'set_auto_stop') {
      if (typeof args.enabled !== 'boolean') return errorResult('enabled(true/false)가 필요합니다');
      this.power.setAutoStop({ enabled: args.enabled, idleMinutes: args.idle_minutes });
      return toMcpContent(await this.power.status());
    }
    // stop_server: 응답을 먼저 돌려준 뒤 종료를 진행한다 (종료 중에는 이 연결도 끊기므로)
    if (!this.power.paperspace) return errorResult('Paperspace API 키나 기계 ID가 설정되지 않아 서버를 끌 수 없습니다.');
    setTimeout(() => this.power.stopNow('Claude 요청').catch(() => {}), 500);
    return toMcpContent({ stopping: true, message: `열린 에디터의 변경을 저장한 뒤 서버를 끕니다. ${POWER_NOTE}` });
  }

  async callTool(name, rawArgs = {}) {
    const started = Date.now();
    const { project: projectArg, ...args } = rawArgs ?? {};
    const def = TOOL_DEFS.find((d) => d.name === name);
    let result;
    let route = '-';
    try {
      if (this.power && name !== 'get_server_power' && name !== 'list_projects') this.power.markActivity(`MCP ${name}`);
      if (POWER_TOOL_NAMES.has(name)) {
        route = 'server';
        result = this.power ? await this.#callPowerTool(name, args) : errorResult('서버 전원 관리가 설정되지 않았습니다.');
      } else if (name === 'list_projects') {
        route = 'server';
        result = toMcpContent({ editor_tabs: this.link.summary(), default_project: this.defaultProject?.key ?? null });
      } else if (!def) {
        result = errorResult(`알 수 없는 도구: ${name}`);
      } else {
        let project = null;
        if (projectArg) {
          project = parseProject(projectArg);
          if (!project) return errorResult(`project 형식이 잘못되었습니다: "${projectArg}" (예: owner/repo@main)`);
        }
        const tab = this.link.findTab(project?.key);
        if (tab) {
          route = 'editor';
          result = await this.link.call(tab, name, args, SLOW_TOOLS.has(name) ? 60000 : 30000);
        } else {
          const target = project ?? this.defaultProject;
          if (this.github && target && GITHUB_TOOLS.has(name)) {
            route = 'github';
            result = toMcpContent(await this.github.call(name, args, target));
          } else if (def.needsEditor) {
            result = errorResult(`'${name}'은(는) 웹 에디터가 열려 있어야 합니다. 브라우저에서 웹 에디터를 열고 설정에서 MCP 서버에 연결하세요.`);
          } else {
            result = errorResult(
              '연결된 웹 에디터 탭이 없고, 서버에 GitHub 대체 설정(GODOT_GITHUB_TOKEN, DEFAULT_PROJECT)도 없습니다. 웹 에디터를 열어 MCP 서버에 연결하세요.',
            );
          }
        }
      }
    } catch (e) {
      result = errorResult(e.message || String(e));
    }
    log(`tool ${name} -> ${route} ${result.isError ? 'ERROR' : 'ok'} ${Date.now() - started}ms`);
    return result;
  }
}
