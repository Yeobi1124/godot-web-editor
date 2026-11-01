// 서버 전원 관리 테스트: 가짜 Paperspace API + 가짜 시계 + 가짜 에디터 탭
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRelay } from '../src/server.js';
import { PaperspaceClient } from '../src/paperspace.js';

const CLI = 'cli-token-power-test-0123';
const PAIR = 'pairing-power-test-0123';
const MACHINE = 'pstest123';
const API_KEY = 'ps-api-key-test';

/** 가짜 Paperspace API (새 API 형식) */
class FakePaperspace {
  state = 'ready';
  requests = [];
  listen() {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        this.requests.push(`${req.method} ${req.url}`);
        const send = (code, body) => {
          res.writeHead(code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.headers.authorization !== `Bearer ${API_KEY}`) return send(401, { message: 'unauthorized' });
        const m = req.url.match(/^\/v1\/machines\/([^/]+)(?:\/(start|stop))?$/);
        if (!m || m[1] !== MACHINE) return send(404, { message: 'not found' });
        if (req.method === 'GET' && !m[2]) return send(200, { id: MACHINE, name: 'test', state: this.state });
        if (req.method === 'PATCH' && m[2] === 'stop') {
          this.state = 'stopping';
          return send(200, { id: MACHINE, state: 'stopping' });
        }
        if (req.method === 'PATCH' && m[2] === 'start') {
          this.state = 'starting';
          return send(200, { id: MACHINE, state: 'starting' });
        }
        send(405, { message: 'method not allowed' });
      });
      this.server.listen(0, '127.0.0.1', () => resolve(this.server.address().port));
    });
  }
  close() {
    this.server.close();
  }
}

let ps;
let psBase;
let relay;
let base;
let dataDir;
let clock;
let sessions;

async function startRelay({ autoStopIdleMinutes = 0 } = {}) {
  const probe = createRelay(cfg('http://localhost:1', autoStopIdleMinutes));
  const addr = await probe.listen(0, '127.0.0.1');
  await probe.close();
  base = `http://localhost:${addr.port}`;
  relay = createRelay(cfg(base, autoStopIdleMinutes));
  await relay.listen(addr.port, '127.0.0.1');
}

function cfg(publicUrl, autoStopIdleMinutes) {
  return {
    port: 0,
    host: '127.0.0.1',
    publicUrl,
    adminPassword: 'admin-password-power',
    cliToken: CLI,
    pairingToken: PAIR,
    allowedOrigins: [],
    githubToken: null,
    defaultProject: null,
    dataDir,
    extraRedirectUris: [],
    paperspaceApiKey: API_KEY,
    paperspaceMachineId: MACHINE,
    paperspaceApiBase: psBase,
    autoStopIdleMinutes,
    powerCheckMs: 3600000, // 테스트에서는 check()를 직접 호출
    powerOverrides: { now: () => clock, loginSessions: async () => sessions },
  };
}

async function mcp() {
  const c = new Client({ name: 'power-test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${CLI}` } } }));
  return c;
}
const json = (r) => JSON.parse(r.content[0].text);

function tab(kind, onCall) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/editor`, { origin: 'http://localhost:8060' });
    const calls = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', pairingToken: PAIR, project: { owner: 'o', repo: 'r', branch: 'main' }, app: { kind }, tools: [] })));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'welcome') resolve({ ws, calls });
      if (m.type === 'call') {
        calls.push(m);
        ws.send(JSON.stringify({ type: 'result', id: m.id, content: [{ type: 'text', text: JSON.stringify(onCall ? onCall(m) : { ok: true }) }] }));
      }
    });
  });
}

before(async () => {
  ps = new FakePaperspace();
  psBase = `http://127.0.0.1:${await ps.listen()}/v1`;
});
after(() => ps.close());

beforeEach(async () => {
  await relay?.close();
  relay = null;
  dataDir = mkdtempSync(join(tmpdir(), 'power-test-'));
  clock = 1_000_000_000_000;
  sessions = 0;
  ps.state = 'ready';
  ps.requests = [];
});

describe('PaperspaceClient', () => {
  test('상태 조회, 시작, 중지 (Bearer 인증)', async () => {
    const c = new PaperspaceClient({ apiKey: API_KEY, machineId: MACHINE, apiBase: psBase });
    assert.equal(await c.getState(), 'ready');
    await c.stop();
    assert.equal(ps.state, 'stopping');
    await c.start();
    assert.equal(ps.state, 'starting');
    const bad = new PaperspaceClient({ apiKey: 'wrong', machineId: MACHINE, apiBase: psBase });
    await assert.rejects(bad.getState(), /401/);
  });
});

describe('자동 종료', () => {
  test('기본은 꺼짐: 오래 사용이 없어도 끄지 않음', async () => {
    await startRelay();
    clock += 10 * 3600_000;
    assert.equal(await relay.power.check(), null);
    assert.ok(!ps.requests.some((r) => r.includes('/stop')));
    await relay.close();
    relay = null;
  });

  test('켜면: 사용이 없으면 에디터를 저장한 뒤 기계 중지', async () => {
    await startRelay({ autoStopIdleMinutes: 30 });
    const headless = await tab('headless');
    clock += 29 * 60_000;
    assert.equal(await relay.power.check(), null, '아직 30분 전');
    clock += 2 * 60_000;
    const r = await relay.power.check();
    assert.ok(r?.reason?.includes('30분'), JSON.stringify(r));
    assert.equal(headless.calls[0]?.name, 'sync_now', '끄기 전에 에디터에 저장 요청');
    assert.ok(ps.requests.includes(`PATCH /v1/machines/${MACHINE}/stop`));
    assert.equal(ps.state, 'stopping');
    headless.ws.close();
  });

  test('MCP 호출, PC 에디터 연결, SSH 로그인은 사용으로 침', async () => {
    await startRelay({ autoStopIdleMinutes: 30 });
    const client = await mcp();
    clock += 25 * 60_000;
    await client.callTool({ name: 'list_files', arguments: {} }); // 사용
    clock += 25 * 60_000;
    assert.equal(await relay.power.check(), null, 'MCP 호출 후 30분이 안 지남');
    // 상태 조회는 사용으로 치지 않음
    clock += 10 * 60_000;
    await client.callTool({ name: 'get_server_power', arguments: {} });
    sessions = 1; // SSH 로그인 중
    assert.equal(await relay.power.check(), null, 'SSH 로그인 중에는 끄지 않음');
    sessions = 0;
    const pc = await tab('browser'); // PC 에디터 연결
    clock += 60 * 60_000;
    assert.equal(await relay.power.check(), null, 'PC 에디터 연결 중에는 끄지 않음');
    pc.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    clock += 29 * 60_000;
    assert.equal(await relay.power.check(), null, 'PC 에디터가 닫힌 뒤 30분 전');
    clock += 2 * 60_000;
    assert.ok(await relay.power.check(), '그 뒤 30분 지나면 종료');
    await client.close();
  });

  test('MCP 도구로 켜기/끄기, 설정은 재시작 후에도 유지', async () => {
    await startRelay();
    const client = await mcp();
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(['get_server_power', 'set_auto_stop', 'stop_server'].every((n) => names.includes(n)), names.join(','));
    const stopTool = (await client.listTools()).tools.find((t) => t.name === 'stop_server');
    assert.equal(stopTool.annotations.destructiveHint, true);

    let s = json(await client.callTool({ name: 'set_auto_stop', arguments: { enabled: true, idle_minutes: 45 } }));
    assert.equal(s.auto_stop, true);
    assert.equal(s.idle_minutes, 45);
    assert.equal(s.stops_in_minutes, 45);
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'power.json'), 'utf8')), { autoStop: true, idleMinutes: 45 });
    await client.close();

    await relay.close();
    await startRelay(); // 재시작
    const c2 = await mcp();
    s = json(await c2.callTool({ name: 'get_server_power', arguments: {} }));
    assert.equal(s.auto_stop, true, '재시작 후에도 켜져 있음');
    s = json(await c2.callTool({ name: 'set_auto_stop', arguments: { enabled: false } }));
    assert.equal(s.auto_stop, false);
    assert.equal(s.stops_in_minutes, null);
    await c2.close();
  });

  test('stop_server 도구: 응답 후 저장하고 중지', async () => {
    await startRelay();
    const client = await mcp();
    const r = json(await client.callTool({ name: 'stop_server', arguments: {} }));
    assert.equal(r.stopping, true);
    await new Promise((res) => setTimeout(res, 800));
    assert.equal(ps.state, 'stopping');
    await client.close();
  });
});

describe('HTTP API (/api/power)', () => {
  test('인증 필요, 조회와 설정, 원격 중지', async () => {
    await startRelay();
    assert.equal((await fetch(`${base}/api/power`)).status, 401);
    const h = { Authorization: `Bearer ${CLI}`, 'Content-Type': 'application/json' };
    let s = await (await fetch(`${base}/api/power`, { headers: h })).json();
    assert.equal(s.auto_stop, false);
    assert.equal(s.paperspace_configured, true);
    s = await (await fetch(`${base}/api/power`, { method: 'POST', headers: h, body: JSON.stringify({ auto_stop: true, idle_minutes: 90 }) })).json();
    assert.equal(s.auto_stop, true);
    assert.equal(s.idle_minutes, 90);
    const bad = await fetch(`${base}/api/power`, { method: 'POST', headers: h, body: JSON.stringify({ auto_stop: 'yes' }) });
    assert.equal(bad.status, 400);
    const stop = await fetch(`${base}/api/power/stop`, { method: 'POST', headers: h });
    assert.equal(stop.status, 202);
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(ps.state, 'stopping');
  });
});

after(async () => {
  await relay?.close();
  rmSync(dataDir, { recursive: true, force: true });
});
