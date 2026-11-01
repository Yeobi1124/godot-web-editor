// 웹 에디터 탭과의 WebSocket 연결 (/editor)
// 프로토콜은 docs/MCP.md 3장 참고.

import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { log, warn } from './log.js';
import { randomToken, safeEqual } from './secrets.js';

const HELLO_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 20000;
const DEAD_AFTER_MS = 45000;
const MAX_PAYLOAD = 32 * 1024 * 1024;

export class EditorLink extends EventEmitter {
  /** tabId -> { id, ws, project, tools, state, connectedAt, lastSeen, pending: Map } */
  tabs = new Map();

  constructor({ pairingToken, allowedOrigins }) {
    super();
    this.pairingToken = pairingToken;
    this.allowedOrigins = allowedOrigins;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
    this.wss.on('connection', (ws, req) => this.#onConnection(ws, req));
    this.heartbeat = setInterval(() => this.#heartbeat(), PING_INTERVAL_MS);
    this.heartbeat.unref();
  }

  #originAllowed(origin) {
    if (!origin) return false;
    if (this.allowedOrigins.includes(origin)) return true;
    try {
      const u = new URL(origin);
      return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    } catch {
      return false;
    }
  }

  /** http 서버의 'upgrade' 이벤트 처리 */
  handleUpgrade(req, socket, head) {
    const origin = req.headers.origin;
    if (!this.#originAllowed(origin)) {
      warn(`에디터 연결 거부: 허용되지 않은 Origin ${origin ?? '(없음)'}`);
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  }

  #send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  #onConnection(ws, req) {
    let tab = null;
    const helloTimer = setTimeout(() => {
      this.#send(ws, { type: 'reject', reason: 'hello 메시지를 받지 못했습니다' });
      ws.close(4001, 'hello timeout');
    }, HELLO_TIMEOUT_MS);

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (!tab) {
        if (msg.type !== 'hello') return;
        clearTimeout(helloTimer);
        if (!safeEqual(msg.pairingToken, this.pairingToken)) {
          warn(`에디터 연결 거부: 페어링 토큰 불일치 (${req.socket.remoteAddress})`);
          this.#send(ws, { type: 'reject', reason: '페어링 토큰이 맞지 않습니다' });
          ws.close(4003, 'bad pairing token');
          return;
        }
        const p = msg.project ?? {};
        const project = p.owner && p.repo ? `${p.owner}/${p.repo}@${p.branch || 'main'}` : null;
        tab = {
          id: randomToken(9),
          ws,
          project,
          tools: Array.isArray(msg.tools) ? msg.tools : null,
          app: msg.app ?? {},
          state: {},
          connectedAt: Date.now(),
          lastSeen: Date.now(),
          pending: new Map(),
        };
        this.tabs.set(tab.id, tab);
        this.#send(ws, { type: 'welcome', tabId: tab.id });
        log(`에디터 탭 연결: ${project ?? '(프로젝트 없음)'} [${tab.id}]`);
        this.emit('change');
        return;
      }
      tab.lastSeen = Date.now();
      if (msg.type === 'result') {
        const p = tab.pending.get(msg.id);
        if (!p) return;
        tab.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve({ content: Array.isArray(msg.content) ? msg.content : [], ...(msg.isError ? { isError: true } : {}) });
      } else if (msg.type === 'state') {
        tab.state = { ...tab.state, ...msg, type: undefined };
      } else if (msg.type === 'ping') {
        this.#send(ws, { type: 'pong' });
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!tab) return;
      this.tabs.delete(tab.id);
      for (const [, p] of tab.pending) {
        clearTimeout(p.timer);
        p.resolve({ isError: true, content: [{ type: 'text', text: '도구 실행 중 에디터 탭 연결이 끊겼습니다.' }] });
      }
      log(`에디터 탭 연결 끊김: ${tab.project ?? ''} [${tab.id}]`);
      this.emit('change');
    });
    ws.on('error', () => {});
  }

  #heartbeat() {
    const now = Date.now();
    for (const tab of this.tabs.values()) {
      if (now - tab.lastSeen > DEAD_AFTER_MS) {
        tab.ws.terminate();
        continue;
      }
      this.#send(tab.ws, { type: 'ping' });
    }
  }

  /**
   * 프로젝트 키(owner/repo@branch)에 맞는 탭. 없으면 가장 최근에 연결된 탭(프로젝트 지정이 없을 때만).
   * 사람이 쓰는 브라우저 탭을 서버의 헤드리스 에디터보다 우선한다.
   */
  findTab(projectKey) {
    const rank = (t) => (t.app.kind === 'headless' ? 0 : 1);
    const tabs = [...this.tabs.values()].sort((a, b) => rank(b) - rank(a) || b.connectedAt - a.connectedAt);
    if (projectKey) return tabs.find((t) => t.project === projectKey) ?? null;
    return tabs[0] ?? null;
  }

  call(tab, name, args, timeoutMs) {
    return new Promise((resolve) => {
      const id = randomToken(9);
      const timer = setTimeout(() => {
        tab.pending.delete(id);
        resolve({
          isError: true,
          content: [{ type: 'text', text: `에디터 응답 시간 초과(${Math.round(timeoutMs / 1000)}초): ${name}. 에디터 탭이 백그라운드에 있으면 앞으로 가져온 뒤 다시 시도하세요.` }],
        });
      }, timeoutMs);
      tab.pending.set(id, { resolve, timer });
      this.#send(tab.ws, { type: 'call', id, name, arguments: args ?? {}, timeoutMs });
    });
  }

  summary() {
    return [...this.tabs.values()].map((t) => ({
      project: t.project,
      kind: t.app.kind === 'headless' ? 'headless' : 'browser',
      connected_at: new Date(t.connectedAt).toISOString(),
      editor_ready: !!t.state.bridgeReady,
      tab_visible: t.state.visible !== false,
      sync_phase: t.state.syncPhase ?? null,
      head: t.state.head ?? null,
    }));
  }

  close() {
    clearInterval(this.heartbeat);
    for (const t of this.tabs.values()) t.ws.terminate();
    this.wss.close();
  }
}
