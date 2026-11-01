// godot-mcp-relay: Godot 웹 에디터 <-> Claude(MCP) 중계 서버
//
//   /mcp                       MCP (Streamable HTTP), Bearer 인증
//   /.well-known/*, /authorize, /token, /register, /revoke   OAuth (MCP SDK)
//   /login                     OAuth 로그인 화면 제출
//   /editor                    웹 에디터 탭 WebSocket
//   /healthz                   상태 확인 (비밀 정보 없음)
//   /app/                      웹 에디터 페이지 전달 (서버의 헤드리스 에디터가 같은 출처로 열기 위함)

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { SCOPE, SingleUserOAuthProvider } from './auth.js';
import { loadDotEnv, readConfig, ROOT } from './config.js';
import { EditorLink } from './editor-link.js';
import { GitHubBackend } from './github-backend.js';
import { GitHubClient } from '../../web/js/github.js';
import { HeadlessSettings } from './headless-settings.js';
import { log, warn } from './log.js';
import { mcpHandler } from './mcp.js';
import { PaperspaceClient } from './paperspace.js';
import { PowerManager } from './power.js';
import { ToolRouter } from './tools.js';

const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

/** 실행 중인 코드의 커밋 (자동 업데이트 확인용) */
function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

/** 마지막 자동 업데이트 결과 (deploy/update.sh가 기록) */
function readUpdateState(dataDir) {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'update-state.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 웹 에디터 페이지를 /app/ 아래로 그대로 전달한다 (서버 안의 헤드리스 에디터용).
 * 페이지와 /editor WebSocket이 같은 출처(127.0.0.1)가 되므로, 공개 주소(Funnel)를 돌아 나가거나
 * 브라우저의 로컬 네트워크 접근 차단에 걸리지 않는다. 페이지는 공개 정적 파일이라 비밀 정보가 없다.
 */
function editorPageProxy(baseUrl) {
  const base = new URL(baseUrl);
  const PASS_HEADERS = ['content-type', 'last-modified', 'etag'];
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(405).end();
      return;
    }
    if (req.originalUrl.split('?')[0] === '/app') {
      res.redirect(301, '/app/');
      return;
    }
    const rel = decodeURIComponent(req.path).replace(/^\/+/, '');
    if (rel.split('/').includes('..')) {
      res.status(400).end();
      return;
    }
    try {
      const upstream = await fetch(new URL(rel, base), { method: req.method });
      res.status(upstream.status);
      for (const h of PASS_HEADERS) {
        const v = upstream.headers.get(h);
        if (v) res.set(h, v);
      }
      res.set({
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD' || !upstream.body) {
        res.end();
        return;
      }
      Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
    } catch (e) {
      warn(`에디터 페이지를 가져오지 못했습니다 (${rel || 'index'}): ${e.message}`);
      if (!res.headersSent) res.status(502).type('text').send('editor page unavailable');
    }
  };
}

export function createRelay(config) {
  const publicUrl = new URL(config.publicUrl);
  const mcpUrl = new URL('/mcp', publicUrl);
  const provider = new SingleUserOAuthProvider({
    dataDir: config.dataDir,
    adminPassword: config.adminPassword,
    cliToken: config.cliToken,
    publicUrl,
    extraRedirectUris: config.extraRedirectUris,
  });
  const link = new EditorLink({ pairingToken: config.pairingToken, allowedOrigins: config.allowedOrigins });
  const github = config.githubToken ? new GitHubBackend({ token: config.githubToken, apiBase: config.githubApiBase }) : null;
  const paperspace =
    config.paperspaceApiKey && config.paperspaceMachineId
      ? new PaperspaceClient({ apiKey: config.paperspaceApiKey, machineId: config.paperspaceMachineId, apiBase: config.paperspaceApiBase })
      : null;
  const power = new PowerManager({
    dataDir: config.dataDir,
    paperspace,
    link,
    defaults: { autoStop: config.autoStopIdleMinutes > 0, idleMinutes: config.autoStopIdleMinutes || 120 },
    log,
    ...(config.powerOverrides ?? {}),
  });
  const headless = new HeadlessSettings({
    dataDir: config.dataDir,
    defaults: {
      project: config.headlessProject ?? config.defaultProject,
      enabled: config.headlessEnabled ?? true,
      yieldToBrowser: config.headlessYield ?? true,
    },
    // 새 프로젝트로 바꾸기 전에 서버 토큰으로 접근(쓰기)할 수 있는지 확인
    verifyProject: async (p) => {
      if (!config.githubToken) throw new Error('GODOT_GITHUB_TOKEN이 없어 저장소를 확인할 수 없습니다');
      const gh = new GitHubClient({ token: config.githubToken, owner: p.owner, repo: p.repo, apiBase: config.githubApiBase });
      let repo;
      try {
        repo = await gh.getRepo();
      } catch (e) {
        throw new Error(`${p.owner}/${p.repo}에 접근할 수 없습니다 (토큰의 저장소 목록에 추가했는지 확인): ${e.status ?? ''} ${e.message}`.trim());
      }
      if (repo.permissions && !repo.permissions.push) throw new Error(`${p.owner}/${p.repo}에 쓰기 권한이 없습니다 (토큰의 Contents 권한을 Read and write로)`);
    },
    log,
  });
  const router = new ToolRouter({ link, github, defaultProject: () => headless.project, power });

  const app = express();
  app.disable('x-powered-by');
  // Tailscale Funnel / Cloudflare Tunnel은 같은 컴퓨터(loopback)에서 프록시한다
  app.set('trust proxy', 'loopback');

  if (config.editorPageUrl) app.use('/app', editorPageProxy(config.editorPageUrl));

  const commit = gitCommit();
  const lastUpdate = readUpdateState(config.dataDir);
  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      commit,
      last_update: lastUpdate,
      editor_tabs: link.tabs.size,
      github_fallback: !!github,
      default_project: headless.project?.key ?? null,
    });
  });
  app.get('/', (_req, res) => {
    res.type('text').send(`godot-mcp-relay ${VERSION}\nMCP endpoint: ${mcpUrl.href}\n연결된 에디터 탭: ${link.tabs.size}\n`);
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: publicUrl,
      resourceServerUrl: mcpUrl,
      scopesSupported: [SCOPE],
      resourceName: 'Godot Web Editor',
    }),
  );
  app.use('/login', provider.loginHandler());

  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
  app.all('/mcp', bearer, express.json({ limit: '50mb' }), mcpHandler(router, VERSION));
  // 연결된 에디터 탭 목록 (헤드리스 에디터 실행기가 PC 에디터 연결 여부를 확인할 때 사용)
  app.get('/api/tabs', bearer, (_req, res) => res.json({ tabs: link.summary() }));
  // 서버 전원 (GitHub Actions 워크플로 등에서 사용)
  app.get('/api/power', bearer, async (_req, res) => res.json(await power.status()));
  // 서버 헤드리스 에디터 설정 (헤드리스 실행기와 GitHub Actions 워크플로가 사용)
  app.get('/api/headless', bearer, (_req, res) =>
    res.json({ ...headless.toJSON(), running: link.summary().filter((t) => t.kind === 'headless') }),
  );
  app.post('/api/headless', bearer, express.json(), async (req, res) => {
    const b = req.body ?? {};
    try {
      const s = await headless.update({ enabled: b.enabled, project: b.project, yieldToBrowser: b.yield_to_browser });
      res.json({ ...s, running: link.summary().filter((t) => t.kind === 'headless') });
    } catch (e) {
      res.status(e.status ?? 500).json({ error: e.message });
    }
  });
  app.post('/api/power', bearer, express.json(), async (req, res) => {
    const { auto_stop: enabled, idle_minutes: idleMinutes } = req.body ?? {};
    if (enabled !== undefined && typeof enabled !== 'boolean') return res.status(400).json({ error: 'auto_stop must be boolean' });
    power.setAutoStop({ enabled, idleMinutes });
    res.json(await power.status());
  });
  app.post('/api/power/stop', bearer, (_req, res) => {
    if (!power.paperspace) return res.status(409).json({ error: 'Paperspace API key or machine id is not configured' });
    res.status(202).json({ stopping: true });
    setTimeout(() => power.stopNow('원격 요청').catch(() => {}), 200);
  });

  power.start(config.powerCheckMs ?? 60000);
  const server = createServer(app);
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/editor') link.handleUpgrade(req, socket, head);
    else socket.destroy();
  });

  return {
    app,
    server,
    link,
    provider,
    router,
    power,
    headless,
    commit,
    listen: (port = config.port, host = config.host) => new Promise((resolve) => server.listen(port, host, () => resolve(server.address()))),
    close: () =>
      new Promise((resolve) => {
        power.stop();
        link.close();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

async function main() {
  loadDotEnv();
  const config = readConfig();
  // 자동 업데이트의 임시 확인 실행이면 전원 관리 타이머를 돌리지 않는다
  if (process.env.UPDATE_VERIFY) config.powerCheckMs = 3600000;
  const relay = createRelay(config);
  const addr = await relay.listen();
  log(`godot-mcp-relay ${VERSION} (${relay.commit ?? "커밋 정보 없음"}) 시작: http://${addr.address}:${addr.port}`);
  log(`공개 주소: ${config.publicUrl}  (MCP: ${config.publicUrl}/mcp)`);
  log(`에디터 페이지 허용 Origin: ${config.allowedOrigins.join(', ')}`);
  if (config.editorPageUrl) log(`웹 에디터 페이지 전달: /app/ -> ${config.editorPageUrl}`);
  const ps = await relay.power.status();
  log(
    `서버 전원: Paperspace ${ps.paperspace_configured ? `연결됨 (기계 ${ps.machine_id})` : '설정 안 됨'}, 자동 종료 ${ps.auto_stop ? `켜짐 (${ps.idle_minutes}분)` : '꺼짐'}`,
  );
  log(config.githubToken ? `GitHub 대체 처리: 사용 (기본 프로젝트 ${relay.headless.project?.key ?? '없음'})` : 'GitHub 대체 처리: 사용 안 함');
  const hs = relay.headless.toJSON();
  log(`헤드리스 에디터 설정: ${hs.enabled ? '켜짐' : '꺼짐'}, 프로젝트 ${hs.project ?? '(없음)'}`);
  const stop = async () => {
    log('종료 중...');
    await relay.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
