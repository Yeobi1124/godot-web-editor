// 서버 헤드리스 에디터 설정 (data/headless.json에 저장, 재시작 후에도 유지)
//   enabled         헤드리스 에디터 사용 여부
//   project         열 프로젝트 "소유자/저장소@브랜치" (GitHub 직접 처리의 기본 프로젝트로도 사용)
//   yieldToBrowser  PC 웹 에디터가 같은 프로젝트로 연결되면 헤드리스 에디터를 멈출지
// 헤드리스 실행기(headless/runner.mjs)가 GET /api/headless로 주기적으로 읽어 바뀐 설정을 바로 적용한다.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProject } from './config.js';

export class HeadlessSettings {
  constructor({ dataDir, defaults = {}, verifyProject = null, log = console.log }) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.path = join(dataDir, 'headless.json');
    this.verifyProject = verifyProject;
    this.log = log;
    this.settings = this.#load(defaults);
  }

  #load(defaults) {
    const fallback = {
      enabled: defaults.enabled ?? true,
      project: defaults.project?.key ?? null,
      yieldToBrowser: defaults.yieldToBrowser ?? true,
    };
    try {
      const s = JSON.parse(readFileSync(this.path, 'utf8'));
      return {
        enabled: typeof s.enabled === 'boolean' ? s.enabled : fallback.enabled,
        project: parseProject(s.project)?.key ?? fallback.project,
        yieldToBrowser: typeof s.yieldToBrowser === 'boolean' ? s.yieldToBrowser : fallback.yieldToBrowser,
      };
    } catch {
      return fallback;
    }
  }

  #save() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.settings, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /** 현재 프로젝트 { owner, repo, branch, key } 또는 null */
  get project() {
    return parseProject(this.settings.project);
  }

  toJSON() {
    return { enabled: this.settings.enabled, project: this.settings.project, yield_to_browser: this.settings.yieldToBrowser };
  }

  /**
   * 설정 변경. 잘못된 값이면 Error(status 400), 저장소에 접근할 수 없으면 Error(status 422)
   * @param {{ enabled?: boolean, project?: string, yieldToBrowser?: boolean }} patch
   */
  async update({ enabled, project, yieldToBrowser } = {}) {
    const bad = (status, message) => Object.assign(new Error(message), { status });
    if (enabled !== undefined && typeof enabled !== 'boolean') throw bad(400, 'enabled must be boolean');
    if (yieldToBrowser !== undefined && typeof yieldToBrowser !== 'boolean') throw bad(400, 'yield_to_browser must be boolean');
    let next = this.settings.project;
    if (project !== undefined && project !== null && project !== '') {
      const p = parseProject(project);
      if (!p) throw bad(400, `project must look like owner/repo@branch: ${String(project).slice(0, 100)}`);
      if (p.key !== this.settings.project && this.verifyProject) {
        try {
          await this.verifyProject(p);
        } catch (e) {
          throw bad(422, e.message);
        }
      }
      next = p.key;
    }
    const before = JSON.stringify(this.settings);
    if (typeof enabled === 'boolean') this.settings.enabled = enabled;
    if (typeof yieldToBrowser === 'boolean') this.settings.yieldToBrowser = yieldToBrowser;
    this.settings.project = next;
    if (JSON.stringify(this.settings) !== before) {
      this.#save();
      this.log(
        `헤드리스 에디터 설정: ${this.settings.enabled ? '켜짐' : '꺼짐'}, 프로젝트 ${this.settings.project ?? '(없음)'}, ` +
          `PC 에디터에 양보 ${this.settings.yieldToBrowser ? '함' : '안 함'}`,
      );
    }
    return this.toJSON();
  }
}
