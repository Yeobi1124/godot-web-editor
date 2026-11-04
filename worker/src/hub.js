// 사용자 한 명 = Hub 하나 (이름: "user:<GitHub 사용자 id>").
// 그 사용자가 연 웹 에디터 탭들의 WebSocket을 들고 있다가, MCP 도구 호출을 알맞은 탭으로 전달한다.
// 탭 쪽 프로토콜은 중계 서버와 같다 (web/js/mcp-link.js, docs/MCP.md 3장): hello → welcome, call → result, state, ping/pong
//
// WebSocket Hibernation API를 쓰므로 탭을 오래 열어 두어도 이 객체는 잠들어 있다(비용 거의 없음).
// ping/pong은 자동 응답이라 객체를 깨우지 않는다.
import { DurableObject } from 'cloudflare:workers';
import { randomToken } from './http.js';

const HELLO_TIMEOUT_MS = 10000;

export class Hub extends DurableObject {
  /** callId → { resolve, timer, tabId } (호출이 진행 중인 동안에는 객체가 잠들지 않으므로 메모리로 충분) */
  #pending = new Map();

  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  /** /live 업그레이드 요청 (Worker가 로그인 확인 후 전달) */
  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ tabId: randomToken(9), hello: false, connectedAt: Date.now(), project: null, app: {}, state: {} });
    return new Response(null, { status: 101, webSocket: client });
  }

  #tabs() {
    return this.ctx
      .getWebSockets()
      .map((ws) => ({ ws, ...ws.deserializeAttachment() }))
      .filter((t) => t.hello);
  }

  #send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* 이미 닫힘 */
    }
  }

  async webSocketMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    } catch {
      return;
    }
    const att = ws.deserializeAttachment();
    if (!att.hello) {
      if (msg.type !== 'hello') return;
      if (Date.now() - att.connectedAt > HELLO_TIMEOUT_MS) {
        ws.close(4001, 'hello timeout');
        return;
      }
      const p = msg.project ?? {};
      const project = p.owner && p.repo ? `${p.owner}/${p.repo}@${p.branch || 'main'}` : null;
      ws.serializeAttachment({ ...att, hello: true, project, app: msg.app ?? {}, connectedAt: Date.now() });
      if (project) await this.ctx.storage.put('lastProject', project);
      this.#send(ws, { type: 'welcome', tabId: att.tabId });
      return;
    }
    if (msg.type === 'result') {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve({ content: Array.isArray(msg.content) ? msg.content : [], ...(msg.isError ? { isError: true } : {}) });
    } else if (msg.type === 'state') {
      const { type, ...state } = msg;
      ws.serializeAttachment({ ...att, state: { ...att.state, ...state } });
    } else if (msg.type === 'ping') {
      this.#send(ws, { type: 'pong' });
    }
  }

  async webSocketClose(ws) {
    this.#dropTab(ws);
  }

  async webSocketError(ws) {
    this.#dropTab(ws);
  }

  #dropTab(ws) {
    const { tabId } = ws.deserializeAttachment() ?? {};
    for (const [id, p] of this.#pending) {
      if (p.tabId !== tabId) continue;
      this.#pending.delete(id);
      clearTimeout(p.timer);
      p.resolve({ isError: true, content: [{ type: 'text', text: '도구 실행 중 에디터 탭 연결이 끊겼습니다.' }] });
    }
  }

  /** 프로젝트에 맞는 탭 (지정이 없으면 화면에 보이는 가장 최근 탭) */
  #findTab(projectKey) {
    const tabs = this.#tabs().sort((a, b) => (b.state.visible !== false) - (a.state.visible !== false) || b.connectedAt - a.connectedAt);
    if (projectKey) return tabs.find((t) => t.project === projectKey) ?? null;
    return tabs[0] ?? null;
  }

  /** 지금 열린 탭 목록과 기본 프로젝트 (list_projects, 대상 결정용) */
  async summary() {
    return {
      tabs: this.#tabs().map((t) => ({
        project: t.project,
        connected_at: new Date(t.connectedAt).toISOString(),
        editor_ready: !!t.state.bridgeReady,
        tab_visible: t.state.visible !== false,
        sync_phase: t.state.syncPhase ?? null,
        head: t.state.head ?? null,
      })),
      lastProject: (await this.ctx.storage.get('lastProject')) ?? null,
    };
  }

  /**
   * 탭으로 도구 호출. 맞는 탭이 없으면 { handled: false, defaultProject }.
   * defaultProject: 열린 탭의 프로젝트, 없으면 마지막으로 연 프로젝트
   */
  async callTool(projectKey, name, args, timeoutMs) {
    const tab = this.#findTab(projectKey);
    if (!tab) return { handled: false, defaultProject: (await this.ctx.storage.get('lastProject')) ?? null };
    const result = await new Promise((resolve) => {
      const id = randomToken(9);
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({
          isError: true,
          content: [{ type: 'text', text: `에디터 응답 시간 초과(${Math.round(timeoutMs / 1000)}초): ${name}. 에디터 탭이 백그라운드에 있으면 앞으로 가져온 뒤 다시 시도하세요.` }],
        });
      }, timeoutMs);
      this.#pending.set(id, { resolve, timer, tabId: tab.tabId });
      this.#send(tab.ws, { type: 'call', id, name, arguments: args ?? {}, timeoutMs });
    });
    return { handled: true, project: tab.project, result };
  }
}

export const hubFor = (env, user) => env.HUBS.get(env.HUBS.idFromName(`user:${user.id}`));
