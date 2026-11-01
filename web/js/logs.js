// Godot 출력(에디터와 실행 중인 게임)을 모아 두는 링 버퍼. 브라우저 콘솔에도 그대로 남겨
// Claude in Chrome / DevTools MCP 같은 브라우저 에이전트가 콘솔에서 읽을 수 있게 한다.

const MAX_LINES = 2000;

// 엔진이 시작할 때마다 나오는, 무시해도 되는 메시지
const NOISE = [/tcp_server\.cpp/, /Condition "err != OK" is true\. Returning: ERR_CANT_CREATE/, /Blocking on the main thread is very dangerous/, /Occlusion culling is disabled/, /_print_warning \(\.\/servers\/rendering/];

export class LogBuffer extends EventTarget {
  #lines = [];
  #seq = 0;

  push(source, level, text) {
    const line = String(text ?? '');
    if (!line.trim() || NOISE.some((r) => r.test(line))) return;
    const entry = { seq: ++this.#seq, time: Date.now(), source, level, text: line };
    this.#lines.push(entry);
    if (this.#lines.length > MAX_LINES) this.#lines.splice(0, this.#lines.length - MAX_LINES);
    const tag = `[godot:${source}]`;
    if (level === 'error') console.warn(tag, line);
    else console.log(tag, line);
    this.dispatchEvent(new CustomEvent('line', { detail: entry }));
  }

  info(text) {
    this.push('app', 'info', text);
  }

  error(text) {
    this.push('app', 'error', text);
  }

  /** since(seq 이후), level('error'만), limit(최근 N줄) */
  query({ since = 0, level = null, limit = 200 } = {}) {
    let out = this.#lines.filter((l) => l.seq > since && (!level || l.level === level));
    if (limit > 0) out = out.slice(-limit);
    return out;
  }
}
