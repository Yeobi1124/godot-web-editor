// 헤드리스 에디터 설정 API 테스트 (/api/headless)
import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FakeGitHub } from '../../tests/fake-github.mjs';
import { parseProject } from '../src/config.js';
import { createRelay } from '../src/server.js';

const CLI = 'cli-token-headless-settings-01';
let gh;
let relay;
let base;
let dataDir;

async function start({ githubToken = 'gh-token' } = {}) {
  const probe = createRelay(cfg('http://localhost:1', githubToken));
  const addr = await probe.listen(0, '127.0.0.1');
  await probe.close();
  base = `http://localhost:${addr.port}`;
  relay = createRelay(cfg(base, githubToken));
  await relay.listen(addr.port, '127.0.0.1');
}

function cfg(publicUrl, githubToken) {
  return {
    port: 0,
    host: '127.0.0.1',
    publicUrl,
    adminPassword: 'admin-password-hs',
    cliToken: CLI,
    pairingToken: 'pairing-token-hs-01',
    allowedOrigins: [],
    githubToken,
    defaultProject: parseProject('tester/game@main'),
    githubApiBase: `http://localhost:${gh.server.address().port}`,
    dataDir,
    extraRedirectUris: [],
    powerCheckMs: 3600000,
  };
}

const api = (method, body) =>
  fetch(`${base}/api/headless`, {
    method,
    headers: { Authorization: `Bearer ${CLI}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

beforeEach(async () => {
  await relay?.close();
  relay = null;
  if (!gh) {
    gh = new FakeGitHub({ owner: 'tester', repo: 'game', token: 'gh-token' });
    gh.commit({ 'project.godot': 'config_version=5\n' }, 'init');
    await gh.listen(0);
  }
  dataDir = mkdtempSync(join(tmpdir(), 'headless-settings-'));
});

after(async () => {
  await relay?.close();
  gh?.close();
});

describe('/api/headless', () => {
  test('인증이 필요하고, 기본값은 .env의 프로젝트', async () => {
    await start();
    assert.equal((await fetch(`${base}/api/headless`)).status, 401);
    const s = await (await api('GET')).json();
    assert.deepEqual({ enabled: s.enabled, project: s.project, yield_to_browser: s.yield_to_browser }, { enabled: true, project: 'tester/game@main', yield_to_browser: true });
    assert.deepEqual(s.running, []);
  });

  test('잘못된 값은 400, 접근할 수 없는 저장소는 422 (설정은 그대로)', async () => {
    await start();
    assert.equal((await api('POST', { project: 'not a project' })).status, 400);
    assert.equal((await api('POST', { enabled: 'yes' })).status, 400);
    const r = await api('POST', { project: 'someone/private@main' });
    assert.equal(r.status, 422);
    assert.match((await r.json()).error, /접근할 수 없습니다/);
    assert.equal((await (await api('GET')).json()).project, 'tester/game@main');
  });

  test('GitHub 토큰이 없으면 프로젝트 변경을 거부', async () => {
    await start({ githubToken: null });
    const r = await api('POST', { project: 'tester/game@dev' });
    assert.equal(r.status, 422);
    assert.match((await r.json()).error, /GODOT_GITHUB_TOKEN/);
  });

  test('프로젝트 변경: 저장되고, 기본 프로젝트(/healthz, list_projects)도 따라감', async () => {
    await start();
    const s = await (await api('POST', { project: 'tester/game@dev', yield_to_browser: false })).json();
    assert.equal(s.project, 'tester/game@dev');
    assert.equal(s.yield_to_browser, false);
    assert.equal((await (await fetch(`${base}/healthz`)).json()).default_project, 'tester/game@dev');
    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${CLI}` } } }));
    const lp = JSON.parse((await client.callTool({ name: 'list_projects', arguments: {} })).content[0].text);
    assert.equal(lp.default_project, 'tester/game@dev');
    await client.close();
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'headless.json'), 'utf8')), { enabled: true, project: 'tester/game@dev', yieldToBrowser: false });
  });

  test('끄기/켜기, 재시작 후에도 유지', async () => {
    await start();
    assert.equal((await (await api('POST', { enabled: false })).json()).enabled, false);
    await relay.close();
    await start();
    const s = await (await api('GET')).json();
    assert.equal(s.enabled, false, '재시작 후에도 꺼져 있음');
    assert.equal((await (await api('POST', { enabled: true })).json()).enabled, true);
  });
});

after(() => rmSync(dataDir, { recursive: true, force: true }));
