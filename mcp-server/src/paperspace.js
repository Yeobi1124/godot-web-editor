// Paperspace(DigitalOcean) 기계 시작/중지 API 클라이언트
// 새 API: https://api.paperspace.com/v1, 인증 "Authorization: Bearer <API 키>" (예전 api.paperspace.io는 2024년 폐기)

export class PaperspaceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class PaperspaceClient {
  #apiKey;

  constructor({ apiKey, machineId, apiBase = 'https://api.paperspace.com/v1' }) {
    this.#apiKey = apiKey;
    this.machineId = machineId;
    this.apiBase = apiBase.replace(/\/$/, '');
  }

  async #request(method, path) {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.#apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: text.slice(0, 200) };
    }
    if (!res.ok) throw new PaperspaceError(res.status, `Paperspace ${method} ${path.replace(this.machineId, '<id>')}: ${res.status} ${data?.message ?? ''}`.trim());
    return data;
  }

  getMachine() {
    return this.#request('GET', `/machines/${encodeURIComponent(this.machineId)}`);
  }

  async getState() {
    return (await this.getMachine())?.state ?? 'unknown';
  }

  start() {
    return this.#request('PATCH', `/machines/${encodeURIComponent(this.machineId)}/start`);
  }

  stop() {
    return this.#request('PATCH', `/machines/${encodeURIComponent(this.machineId)}/stop`);
  }
}
