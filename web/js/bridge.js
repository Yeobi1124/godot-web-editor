// 페이지 <-> 에디터 브리지 애드온(addons/web_editor_bridge) 간 요청/응답
// 애드온이 window.__godotBridgeCall 을 등록하고, 응답은 window.__godotBridgeResolve 로 돌려준다.

export class EditorBridge extends EventTarget {
  #pending = new Map();
  #nextId = 1;
  version = null;

  constructor() {
    super();
    window.__godotBridgeReady = (version) => {
      this.version = version;
      this.dispatchEvent(new CustomEvent('ready', { detail: { version } }));
    };
    window.__godotBridgeGone = () => {
      this.version = null;
      for (const [, p] of this.#pending) p.reject(new Error('에디터 브리지가 종료되었습니다'));
      this.#pending.clear();
      this.dispatchEvent(new Event('gone'));
    };
    window.__godotBridgeResolve = (json) => {
      let msg;
      try {
        msg = JSON.parse(json);
      } catch {
        return;
      }
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    };
  }

  get ready() {
    return this.version !== null && typeof window.__godotBridgeCall === 'function';
  }

  /** 브리지가 준비될 때까지 기다린다 (timeoutMs 안에 안 되면 false) */
  waitReady(timeoutMs = 60000) {
    if (this.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.removeEventListener('ready', onReady);
        resolve(false);
      }, timeoutMs);
      const onReady = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.addEventListener('ready', onReady, { once: true });
    });
  }

  call(method, params = {}, timeoutMs = 20000) {
    if (!this.ready) return Promise.reject(new Error('에디터 브리지가 준비되지 않았습니다 (에디터가 아직 열리지 않았거나 애드온이 꺼져 있음)'));
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`에디터 브리지 응답 시간 초과: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        window.__godotBridgeCall(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(e);
      }
    });
  }
}
