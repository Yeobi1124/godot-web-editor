// 중계 서버 통합 테스트: MCP SDK 클라이언트 + 가짜 에디터 탭(WebSocket) + 가짜 GitHub API
// 실행: cd mcp-server && npm test

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FakeGitHub } from '../../tests/fake-github.mjs';
import { createRelay } from '../src/server.js';
import { parseProject } from '../src/config.js';

const CLI_TOKEN = 'cli-token-for-tests-0123456789';
const PAIRING = 'pairing-token-for-tests-0123';
const PASSWORD = 'admin-password-123';
const PAGE_ORIGIN = 'https://yeobi1124.github.io';

let relay;
let base;
let gh;
let dataDir;

before(async () => {
  gh = new FakeGitHub({ owner: 'tester', repo: 'game', token: 'gh-token' });
  gh.commit({ 'project.godot': 'config_version=5\n', 'main.tscn': '[gd_scene format=3]\n' }, 'init');
  await gh.listen(0);
  const ghPort = gh.server.address().port;
  dataDir = mkdtempSync(join(tmpdir(), 'relay-test-'));
  // 공개 주소는 테스트 서버 주소와 같아야 하므로 먼저 포트를 정한다
  const probe = createRelay(baseConfig('http://localhost:1', ghPort));
  const addr = await probe.listen(0, '127.0.0.1');
  await probe.close();
  base = `http://localhost:${addr.port}`;
  relay = createRelay(baseConfig(base, ghPort));
  await relay.listen(addr.port, '127.0.0.1');
});

after(async () => {
  await relay?.close();
  gh?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function baseConfig(publicUrl, ghPort) {
  return {
    port: 0,
    host: '127.0.0.1',
    publicUrl,
    adminPassword: PASSWORD,
    cliToken: CLI_TOKEN,
    pairingToken: PAIRING,
    allowedOrigins: [PAGE_ORIGIN],
    githubToken: 'gh-token',
    defaultProject: parseProject('tester/game@main'),
    githubApiBase: `http://localhost:${ghPort}`,
    dataDir: dataDir ?? mkdtempSync(join(tmpdir(), 'relay-test-')),
    extraRedirectUris: [],
  };
}

async function mcpClient(token) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

const textOf = (res) => JSON.parse(res.content[0].text);

/** 가짜 에디터 탭: 받은 호출을 기록하고 정해진 결과를 돌려준다 */
function fakeTab({ origin = PAGE_ORIGIN, token = PAIRING, project = { owner: 'tester', repo: 'game', branch: 'main' }, onCall } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/editor`, { origin });
    const calls = [];
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode, ws, calls }));
    ws.on('error', () => {});
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: 1, pairingToken: token, project, tools: [] })));
    ws.on('message', async (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'welcome' || msg.type === 'reject') resolve({ msg, ws, calls });
      if (msg.type === 'call') {
        calls.push(msg);
        const result = onCall ? await onCall(msg) : { echoed: msg.name, args: msg.arguments };
        ws.send(JSON.stringify({ type: 'result', id: msg.id, content: [{ type: 'text', text: JSON.stringify(result) }] }));
      }
    });
    setTimeout(() => reject(new Error('fake tab timeout')), 5000);
  });
}

describe('인증', () => {
  test('토큰 없이 /mcp 요청하면 401과 리소스 메타데이터 위치를 알려 준다', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate'), /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/);
  });

  test('잘못된 토큰은 401', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401);
  });

  test('healthz는 비밀 없이 상태만 보여 준다', async () => {
    const body = await (await fetch(`${base}/healthz`)).json();
    assert.equal(body.ok, true);
    assert.ok(!JSON.stringify(body).includes(PAIRING) && !JSON.stringify(body).includes(CLI_TOKEN));
  });
});

describe('도구 목록과 GitHub 대체 처리 (에디터 탭 없음)', () => {
  test('tools/list: 14개 + list_projects + 전원 도구 3개, 프로젝트 도구에 project 인자', async () => {
    const client = await mcpClient(CLI_TOKEN);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 18);
    const serverTools = ['list_projects', 'get_server_power', 'set_auto_stop', 'stop_server'];
    for (const t of tools.filter((t) => !serverTools.includes(t.name))) assert.ok(t.inputSchema.properties.project, t.name);
    const del = tools.find((t) => t.name === 'delete_files');
    assert.equal(del.annotations.destructiveHint, true);
    await client.close();
  });

  test('get_status는 github 모드', async () => {
    const client = await mcpClient(CLI_TOKEN);
    const s = textOf(await client.callTool({ name: 'get_status', arguments: {} }));
    assert.equal(s.mode, 'github');
    assert.equal(s.head_commit, gh.head());
    await client.close();
  });

  test('write_files -> GitHub에 바로 커밋, read_file/list_files로 확인', async () => {
    const client = await mcpClient(CLI_TOKEN);
    const r = textOf(await client.callTool({ name: 'write_files', arguments: { files: [{ path: 'scripts/a.gd', content: 'extends Node\n' }], commit_message: 'MCP 테스트' } }));
    assert.deepEqual(r.written, ['scripts/a.gd']);
    assert.equal(gh.text('scripts/a.gd'), 'extends Node\n');
    assert.match(gh.lastCommitMessage(), /MCP 테스트/);
    const read = textOf(await client.callTool({ name: 'read_file', arguments: { path: 'res://scripts/a.gd' } }));
    assert.equal(read.content, 'extends Node\n');
    const list = textOf(await client.callTool({ name: 'list_files', arguments: { dir: 'scripts' } }));
    assert.deepEqual(list.files.map((f) => f.path), ['scripts/a.gd']);
    const del = textOf(await client.callTool({ name: 'delete_files', arguments: { paths: ['scripts/a.gd', 'nope.gd'] } }));
    assert.deepEqual(del.deleted, ['scripts/a.gd']);
    assert.equal(gh.text('scripts/a.gd'), null);
    await client.close();
  });

  test('경로 검사: 프로젝트 밖과 .godot 거부', async () => {
    const client = await mcpClient(CLI_TOKEN);
    const r1 = await client.callTool({ name: 'read_file', arguments: { path: '../etc/passwd' } });
    assert.equal(r1.isError, true);
    const r2 = await client.callTool({ name: 'write_files', arguments: { files: [{ path: '.godot/x', content: 'x' }] } });
    assert.equal(r2.isError, true);
    await client.close();
  });

  test('에디터가 필요한 도구는 안내 오류', async () => {
    const client = await mcpClient(CLI_TOKEN);
    const r = await client.callTool({ name: 'screenshot', arguments: {} });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /웹 에디터가 열려 있어야/);
    await client.close();
  });
});

describe('에디터 탭 연결', () => {
  test('허용되지 않은 Origin은 403', async () => {
    const r = await fakeTab({ origin: 'https://evil.example' });
    assert.equal(r.status, 403);
  });

  test('페어링 토큰이 틀리면 reject', async () => {
    const r = await fakeTab({ token: 'wrong-token-xxxxxxxx' });
    assert.equal(r.msg.type, 'reject');
    r.ws.close();
  });

  test('탭이 있으면 호출이 탭으로 가고, 끊기면 GitHub로 돌아간다', async () => {
    const tab = await fakeTab({
      onCall: (msg) => (msg.name === 'screenshot' ? { type: 'image' } : { from: 'tab', name: msg.name, args: msg.arguments }),
    });
    assert.equal(tab.msg.type, 'welcome');
    const client = await mcpClient(CLI_TOKEN);
    const projects = textOf(await client.callTool({ name: 'list_projects', arguments: {} }));
    assert.equal(projects.editor_tabs[0].project, 'tester/game@main');

    const r = textOf(await client.callTool({ name: 'write_files', arguments: { files: [{ path: 'x.txt', content: 'hi' }], project: 'tester/game@main' } }));
    assert.equal(r.from, 'tab');
    assert.deepEqual(r.args, { files: [{ path: 'x.txt', content: 'hi' }] }, 'project 인자는 탭에 전달하지 않음');
    assert.equal(gh.text('x.txt'), null, '탭이 있으면 서버가 GitHub에 직접 쓰지 않음');

    // 다른 프로젝트를 지정하면 탭이 아닌 GitHub(해당 저장소)로 간다 -> 가짜 GitHub에는 없는 저장소라 오류
    const other = await client.callTool({ name: 'get_status', arguments: { project: 'someone/else@main' } });
    assert.equal(other.isError, true);

    tab.ws.close();
    await new Promise((r) => setTimeout(r, 200));
    const s = textOf(await client.callTool({ name: 'get_status', arguments: {} }));
    assert.equal(s.mode, 'github');
    await client.close();
  });

  test('탭이 응답하지 않는 중에 끊기면 오류 결과', async () => {
    const tab = await fakeTab({ onCall: () => new Promise(() => {}) });
    const client = await mcpClient(CLI_TOKEN);
    const pending = client.callTool({ name: 'get_editor_state', arguments: {} });
    await new Promise((r) => setTimeout(r, 300));
    tab.ws.terminate();
    const r = await pending;
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /연결이 끊겼습니다/);
    await client.close();
  });
});

describe('OAuth (claude.ai / 모바일 커넥터 흐름)', () => {
  const pkce = () => {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
  };

  test('메타데이터 문서', async () => {
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(prm.resource, `${base}/mcp`);
    const asm = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(asm.registration_endpoint, `${base}/register`);
    assert.ok(asm.code_challenge_methods_supported.includes('S256'));
  });

  test('허용되지 않은 redirect_uri는 등록 거부', async () => {
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'], token_endpoint_auth_method: 'none', client_name: 'evil' }),
    });
    assert.equal(res.status, 400);
  });

  test('등록 -> 로그인(비밀번호) -> 코드 -> 토큰 -> MCP 호출 -> 리프레시', async () => {
    const redirect = 'https://claude.ai/api/mcp/auth_callback';
    const reg = await (
      await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_name: 'Claude' }),
      })
    ).json();
    assert.ok(reg.client_id);

    const { verifier, challenge } = pkce();
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st123', scope: 'mcp', resource: `${base}/mcp` });
    const page = await (await fetch(`${base}/authorize?${q}`)).text();
    const reqId = page.match(/name="req" value="([^"]+)"/)[1];
    assert.match(page, /Claude/);

    const login = (password) =>
      fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ req: reqId, password, action: 'allow' }) });
    assert.equal((await login('wrong-password')).status, 401);
    const ok = await login(PASSWORD);
    assert.equal(ok.status, 302);
    const loc = new URL(ok.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, redirect);
    assert.equal(loc.searchParams.get('state'), 'st123');
    const code = loc.searchParams.get('code');

    const token = async (params) =>
      fetch(`${base}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: reg.client_id, ...params }) });
    const bad = await token({ grant_type: 'authorization_code', code, code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier', redirect_uri: redirect });
    assert.equal(bad.status, 400, 'PKCE 검증');
    const tokRes = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect, resource: `${base}/mcp` });
    const tok = await tokRes.json();
    assert.equal(tokRes.status, 200, JSON.stringify(tok));
    assert.ok(tok.access_token && tok.refresh_token);
    const reuse = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect });
    assert.equal(reuse.status, 400, '인가 코드는 한 번만');

    const client = await mcpClient(tok.access_token);
    assert.equal((await client.listTools()).tools.length, 18);
    await client.close();

    const ref = await (await token({ grant_type: 'refresh_token', refresh_token: tok.refresh_token })).json();
    assert.ok(ref.access_token && ref.access_token !== tok.access_token);
    const refAgain = await token({ grant_type: 'refresh_token', refresh_token: tok.refresh_token });
    assert.equal(refAgain.status, 400, '리프레시 토큰은 회전');
    const client2 = await mcpClient(ref.access_token);
    assert.equal((await client2.listTools()).tools.length, 18);
    await client2.close();
  });
});
