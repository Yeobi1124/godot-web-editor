// 설정: 환경 변수 또는 mcp-server/.env 파일
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** KEY=VALUE 형식의 .env 파일을 읽는다 (이미 설정된 환경 변수가 우선) */
export function loadDotEnv(path = join(ROOT, '.env')) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

/** "owner/repo@branch" -> { owner, repo, branch, key } */
export function parseProject(text) {
  if (!text) return null;
  const m = String(text).trim().match(/^([\w.-]+)\/([\w.-]+)(?:@(.+))?$/);
  if (!m) return null;
  const branch = m[3] || 'main';
  return { owner: m[1], repo: m[2], branch, key: `${m[1]}/${m[2]}@${branch}` };
}

function toOrigin(text) {
  if (!text) return '';
  try {
    return new URL(text).origin;
  } catch {
    return text.replace(/\/+$/, '');
  }
}

export function readConfig(env = process.env) {
  const required = (k) => {
    const v = env[k];
    if (!v) throw new Error(`환경 변수 ${k}가 필요합니다. 'npm run init'으로 .env를 만드세요.`);
    return v;
  };
  const publicUrl = new URL(required('PUBLIC_URL'));
  const config = {
    port: Number(env.PORT || 8787),
    host: env.HOST || '127.0.0.1',
    publicUrl: publicUrl.href.replace(/\/$/, ''),
    adminPassword: required('ADMIN_PASSWORD'),
    cliToken: required('CLI_TOKEN'),
    pairingToken: required('PAIRING_TOKEN'),
    // 전체 주소(https://x.github.io/godot-web-editor/)를 넣어도 Origin(https://x.github.io)만 쓴다
    allowedOrigins: (env.ALLOWED_ORIGINS || 'https://yeobi1124.github.io').split(',').map((s) => toOrigin(s.trim())).filter(Boolean),
    githubToken: env.GODOT_GITHUB_TOKEN || null,
    defaultProject: parseProject(env.DEFAULT_PROJECT),
    githubApiBase: env.GITHUB_API_BASE || 'https://api.github.com',
    dataDir: resolve(ROOT, env.DATA_DIR || 'data'),
    extraRedirectUris: (env.EXTRA_REDIRECT_URIS || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
  for (const k of ['adminPassword', 'cliToken', 'pairingToken']) {
    if (config[k].length < 12) throw new Error(`${k}가 너무 짧습니다 (12자 이상)`);
  }
  if (env.DEFAULT_PROJECT && !config.defaultProject) throw new Error('DEFAULT_PROJECT는 "소유자/저장소@브랜치" 형식이어야 합니다');
  return config;
}
