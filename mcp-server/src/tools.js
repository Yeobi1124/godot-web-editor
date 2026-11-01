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

const errorResult = (text) => ({ isError: true, content: [{ type: 'text', text }] });

export class ToolRouter {
  constructor({ link, github, defaultProject }) {
    this.link = link;
    this.github = github;
    this.defaultProject = defaultProject;
  }

  /** MCP tools/list 결과. 탭 연결 여부와 상관없이 항상 같은 목록을 돌려준다. */
  listTools() {
    const tools = TOOL_DEFS.map((d) => {
      const desc = toDescriptor(d);
      return { ...desc, inputSchema: { ...desc.inputSchema, properties: { ...desc.inputSchema.properties, project: PROJECT_PROP } } };
    });
    return [...tools, LIST_PROJECTS];
  }

  async callTool(name, rawArgs = {}) {
    const started = Date.now();
    const { project: projectArg, ...args } = rawArgs ?? {};
    const def = TOOL_DEFS.find((d) => d.name === name);
    let result;
    let route = '-';
    try {
      if (name === 'list_projects') {
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
