// 서버 전원 관리: 일정 시간 사용이 없으면 변경 사항을 저장하고 Paperspace 기계를 스스로 중지한다.
//
// "사용"으로 보는 것
//  - MCP 도구 호출 (전원 상태 조회는 제외)
//  - 사람이 쓰는 브라우저(PC)의 웹 에디터가 연결되어 있는 동안
//  - SSH 등으로 로그인한 사용자가 있는 동안 (`who`)
// 서버 안의 헤드리스 에디터는 항상 켜져 있으므로 사용으로 치지 않는다.
//
// 설정은 data/power.json에 저장되어 재시작 후에도 유지된다.

import { execFile } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const MIN_IDLE_MINUTES = 1;
export const MAX_IDLE_MINUTES = 7 * 24 * 60;

/** 로그인한 사용자 수 (who 명령 결과 줄 수). 실패하면 0 */
export function countLoginSessions() {
  return new Promise((resolve) => {
    execFile('who', { timeout: 5000 }, (err, stdout) => resolve(err ? 0 : stdout.split('\n').filter((l) => l.trim()).length));
  });
}

export class PowerManager {
  #timer = null;
  stopping = false;

  constructor({ dataDir, paperspace = null, link, defaults = {}, now = () => Date.now(), loginSessions = countLoginSessions, log = console.log }) {
    this.path = join(dataDir, 'power.json');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.paperspace = paperspace;
    this.link = link;
    this.now = now;
    this.loginSessions = loginSessions;
    this.log = log;
    this.settings = this.#load(defaults);
    this.lastActivity = now();
    this.lastActivityReason = '서버 시작';
    this.lastStop = null;
  }

  #load(defaults) {
    try {
      const s = JSON.parse(readFileSync(this.path, 'utf8'));
      return { autoStop: !!s.autoStop, idleMinutes: clampMinutes(s.idleMinutes) };
    } catch {
      return { autoStop: !!defaults.autoStop, idleMinutes: clampMinutes(defaults.idleMinutes ?? 120) };
    }
  }

  #save() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.settings, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  markActivity(reason) {
    this.lastActivity = this.now();
    this.lastActivityReason = reason;
  }

  /** 지금 계속 사용 중인 이유 목록 */
  async activeNow() {
    const reasons = [];
    const browserTabs = this.link.summary().filter((t) => t.kind === 'browser');
    if (browserTabs.length) reasons.push(`PC 웹 에디터 연결 ${browserTabs.length}개`);
    const sessions = await this.loginSessions();
    if (sessions > 0) reasons.push(`로그인 세션 ${sessions}개(SSH 등)`);
    return reasons;
  }

  async status() {
    const active = await this.activeNow();
    const idleMs = active.length ? 0 : this.now() - this.lastActivity;
    const remaining = this.settings.idleMinutes * 60000 - idleMs;
    return {
      auto_stop: this.settings.autoStop,
      idle_minutes: this.settings.idleMinutes,
      paperspace_configured: !!this.paperspace,
      machine_id: this.paperspace?.machineId ?? null,
      in_use_now: active,
      last_activity_at: new Date(this.lastActivity).toISOString(),
      last_activity: this.lastActivityReason,
      idle_minutes_so_far: Math.floor(idleMs / 60000),
      stops_in_minutes: this.settings.autoStop && !active.length ? Math.max(0, Math.ceil(remaining / 60000)) : null,
      stopping: this.stopping,
      last_stop: this.lastStop,
    };
  }

  setAutoStop({ enabled, idleMinutes }) {
    if (typeof enabled === 'boolean') this.settings.autoStop = enabled;
    if (idleMinutes !== undefined && idleMinutes !== null) this.settings.idleMinutes = clampMinutes(idleMinutes);
    this.#save();
    // 설정을 바꾼 순간부터 다시 센다 (켜자마자 바로 꺼지지 않도록)
    this.markActivity('자동 종료 설정 변경');
    this.log(`자동 종료: ${this.settings.autoStop ? `켜짐 (${this.settings.idleMinutes}분 동안 사용 없으면)` : '꺼짐'}`);
    return this.settings;
  }

  /** 주기 확인: 사용이 없으면 종료 */
  async check() {
    if (!this.settings.autoStop || this.stopping) return null;
    const active = await this.activeNow();
    if (active.length) {
      this.markActivity(active[0]);
      return null;
    }
    if (this.now() - this.lastActivity < this.settings.idleMinutes * 60000) return null;
    return this.stopNow(`${this.settings.idleMinutes}분 동안 사용 없음`);
  }

  /** 연결된 에디터의 변경을 GitHub에 저장한 뒤 기계를 중지한다 */
  async stopNow(reason) {
    if (this.stopping) return { already: true };
    if (!this.paperspace) throw new Error('Paperspace API 키나 기계 ID가 설정되지 않아 서버를 끌 수 없습니다 (.env의 PAPERSPACE_API_KEY, PAPERSPACE_MACHINE_ID).');
    this.stopping = true;
    this.log(`서버 종료 시작: ${reason}`);
    const saved = [];
    for (const tab of [...this.link.tabs.values()]) {
      const res = await this.link.call(tab, 'sync_now', { message: `서버 종료 전 저장 (${reason})` }, 60000);
      saved.push({ project: tab.project, kind: tab.app?.kind ?? 'browser', ok: !res.isError });
    }
    try {
      await this.paperspace.stop();
    } catch (e) {
      this.stopping = false;
      this.log(`서버 종료 실패: ${e.message}`);
      throw e;
    }
    this.lastStop = { at: new Date(this.now()).toISOString(), reason, saved };
    this.log(`Paperspace에 기계 중지를 요청했습니다 (${reason}). 저장한 에디터: ${saved.length}개`);
    return this.lastStop;
  }

  start(intervalMs = 60000) {
    this.stop();
    this.#timer = setInterval(() => this.check().catch((e) => this.log(`자동 종료 확인 실패: ${e.message}`)), intervalMs);
    this.#timer.unref();
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = null;
  }
}

function clampMinutes(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 120;
  return Math.min(MAX_IDLE_MINUTES, Math.max(MIN_IDLE_MINUTES, n));
}
