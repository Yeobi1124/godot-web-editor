// godot-mcp-relay: Godot 웹 에디터 <-> Claude(MCP) 중계 서버
//
//   /mcp                       MCP (Streamable HTTP), Bearer 인증
//   /.well-known/*, /authorize, /token, /register, /revoke   OAuth (MCP SDK)
//   /login                     OAuth 로그인 화면 제출
//   /editor                    웹 에디터 탭 WebSocket
//   /healthz                   상태 확인 (비밀 정보 없음)

import { createServer } from 'node:http';
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
import { log } from './log.js';
import { mcpHandler } from './mcp.js';
import { ToolRouter } from './tools.js';

const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

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
  const router = new ToolRouter({ link, github, defaultProject: config.defaultProject });

  const app = express();
  app.disable('x-powered-by');
  // Tailscale Funnel / Cloudflare Tunnel은 같은 컴퓨터(loopback)에서 프록시한다
  app.set('trust proxy', 'loopback');

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, version: VERSION, editor_tabs: link.tabs.size, github_fallback: !!github, default_project: config.defaultProject?.key ?? null });
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
    listen: (port = config.port, host = config.host) => new Promise((resolve) => server.listen(port, host, () => resolve(server.address()))),
    close: () =>
      new Promise((resolve) => {
        link.close();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

async function main() {
  loadDotEnv();
  const config = readConfig();
  const relay = createRelay(config);
  const addr = await relay.listen();
  log(`godot-mcp-relay ${VERSION} 시작: http://${addr.address}:${addr.port}`);
  log(`공개 주소: ${config.publicUrl}  (MCP: ${config.publicUrl}/mcp)`);
  log(`에디터 페이지 허용 Origin: ${config.allowedOrigins.join(', ')}`);
  log(config.githubToken ? `GitHub 대체 처리: 사용 (기본 프로젝트 ${config.defaultProject?.key ?? '없음'})` : 'GitHub 대체 처리: 사용 안 함');
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
