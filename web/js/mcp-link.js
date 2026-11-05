// Claude(MCP)와의 연결: 같은 주소의 Worker(/live)로 WebSocket을 열고(로그인 쿠키로 인증),
// Worker의 Hub가 보내는 도구 호출을 ProjectAPI로 실행해 결과를 돌려준다.
// 메시지: 탭 → hello / result / state / ping,  서버 → welcome / call / pong / reject

import { toMcpContent } from './tool-defs.js';

const MAX_RECENT = 30;

export class McpLink extends EventTarget {
  #ws = null;
  #retry = 0;
  #timer = null;
  #stopped = true;
  #stateTimer = null;
  #pingTimer = null;
  status = 'off'; // off | connecting | connected | rejected
  detail = '';
  recent = [];

  constructor({ api, sync, bridge, logs, info }) {
    super();
    Object.assign(this, { api, sync, bridge, logs, info });
    const pushState = () => this.#queueState();
    sync.addEventListener('status', pushState);
    bridge.addEventListener('ready', pushState);
    bridge.addEventListener('gone', pushState);
    document.addEventListener('visibilitychange', pushState);
  }

  /** url: 서버 주소(보통 location.origin), path: WebSocket 경로 */
  configure({ url, path = '/live' } = {}) {
    this.url = url || '';
    this.path = path;
    this.stop();
    if (this.url) {
      this.#stopped = false;
      this.#retry = 0;
      this.#connect();
    } else this.#set('off', '');
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    clearInterval(this.#pingTimer);
    if (this.#ws) {
      this.#ws.onclose = null;
      this.#ws.close();
      this.#ws = null;
    }
  }

  #set(status, detail) {
    this.status = status;
    this.detail = detail;
    this.dispatchEvent(new Event('status'));
  }

  #wsUrl() {
    const u = new URL(this.url);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = `${u.pathname.replace(/\/$/, '')}${this.path || '/live'}`;
    u.search = '';
    u.hash = '';
    return u.href;
  }

  #send(msg) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(msg));
  }

  #connect() {
    let url;
    try {
      url = this.#wsUrl();
    } catch {
      this.#set('rejected', '서버 주소 형식이 잘못되었습니다');
      return;
    }
    this.#set('connecting', '연결 중…');
    const ws = new WebSocket(url);
    this.#ws = ws;
    let rejected = false;
    ws.onopen = () => {
      this.#send({
        type: 'hello',
        protocol: 1,
        project: { owner: this.info.owner, repo: this.info.repo, branch: this.info.branch },
        // 서버의 헤드리스 에디터(자동화 브라우저)인지 사람이 쓰는 브라우저인지 (navigator.webdriver는 자동화 시 true)
        app: { version: this.info.appVersion, godot: this.info.godotVersion, kind: navigator.webdriver ? 'headless' : 'browser' },
        tools: this.api.toolDescriptors(),
      });
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'welcome') {
        this.#retry = 0;
        // 연결 유지 확인 (서버가 자동으로 pong 응답)
        clearInterval(this.#pingTimer);
        this.#pingTimer = setInterval(() => this.#send({ type: 'ping' }), 30000);
        this.#set('connected', '연결됨');
        this.logs.info('MCP 서버에 연결했습니다. Claude가 이 에디터를 사용할 수 있습니다.');
        this.#sendState();
      } else if (msg.type === 'reject') {
        rejected = true;
        this.#set('rejected', msg.reason || '서버가 연결을 거부했습니다');
        this.logs.error(`MCP 서버 연결 거부: ${msg.reason}`);
      } else if (msg.type === 'call') {
        this.#handleCall(msg);
      } else if (msg.type === 'ping') {
        this.#send({ type: 'pong' });
      }
    };
    ws.onclose = () => {
      this.#ws = null;
      clearInterval(this.#pingTimer);
      if (this.#stopped || rejected) return;
      const delay = Math.min(30000, 1000 * 2 ** this.#retry++);
      this.#set('connecting', `연결이 끊겼습니다. ${Math.round(delay / 1000)}초 뒤 다시 연결합니다`);
      this.#timer = setTimeout(() => this.#connect(), delay);
    };
  }

  async #handleCall({ id, name, arguments: args }) {
    const started = performance.now();
    let reply;
    try {
      const result = await this.api.call(name, args ?? {});
      reply = { type: 'result', id, ...toMcpContent(result) };
    } catch (e) {
      reply = { type: 'result', id, isError: true, content: [{ type: 'text', text: e.message || String(e) }] };
    }
    this.#send(reply);
    const ms = Math.round(performance.now() - started);
    this.recent.unshift({ time: Date.now(), name, ok: !reply.isError, ms, error: reply.isError ? reply.content[0].text : '' });
    this.recent.length = Math.min(this.recent.length, MAX_RECENT);
    this.dispatchEvent(new Event('call'));
  }

  #queueState() {
    clearTimeout(this.#stateTimer);
    this.#stateTimer = setTimeout(() => this.#sendState(), 200);
  }

  #sendState() {
    if (this.status !== 'connected') return;
    this.#send({
      type: 'state',
      bridgeReady: this.bridge.ready,
      syncPhase: this.sync.status.phase,
      head: this.sync.status.head,
      visible: document.visibilityState === 'visible',
    });
  }
}
