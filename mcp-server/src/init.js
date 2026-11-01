// .env 초기 설정: 비밀값을 무작위로 만들고, 공개 주소 등을 물어본다.
// 사용법: npm run init
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ROOT, parseProject } from './config.js';
import { randomToken } from './secrets.js';

const path = join(ROOT, '.env');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, def = '') => (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def;

const existing = {};
if (existsSync(path)) {
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) existing[m[1]] = m[2];
  }
  console.log(`기존 ${path}를 갱신합니다 (비밀값은 유지).`);
}

console.log('\n1) 공개 주소: Tailscale Funnel이면 "tailscale funnel status"에 나오는 https://<컴퓨터>.<tailnet>.ts.net');
const publicUrl = await ask('PUBLIC_URL', existing.PUBLIC_URL);
console.log('\n2) 에디터 페이지 주소(Origin). GitHub Pages면 https://<사용자>.github.io');
const origins = await ask('ALLOWED_ORIGINS', existing.ALLOWED_ORIGINS || 'https://yeobi1124.github.io');
console.log('\n3) (선택) 에디터 탭이 없을 때 GitHub에 직접 쓰려면 게임 저장소와 토큰을 입력하세요. 건너뛰려면 Enter.');
let project = await ask('DEFAULT_PROJECT (소유자/저장소@브랜치)', existing.DEFAULT_PROJECT || '');
while (project && !parseProject(project)) project = await ask('형식이 맞지 않습니다. 예: Yeobi1124/godot-test@main', '');
const githubToken = project ? await ask('GODOT_GITHUB_TOKEN (해당 저장소 Contents 읽기/쓰기 fine-grained 토큰)', existing.GODOT_GITHUB_TOKEN || '') : '';
console.log('\n4) (선택) 서버 전원 관리: Paperspace API 키를 넣으면 Claude/워크플로에서 서버 끄기, 일정 시간 사용 없을 때 자동 종료를 쓸 수 있습니다.');
const paperspaceKey = await ask('PAPERSPACE_API_KEY', existing.PAPERSPACE_API_KEY || '');
const machineId = paperspaceKey ? await ask('PAPERSPACE_MACHINE_ID', existing.PAPERSPACE_MACHINE_ID || (/^ps[a-z0-9]+$/.test(hostname()) ? hostname() : '')) : '';
const autoStop = paperspaceKey ? await ask('처음 자동 종료 시간(분, 0이면 꺼짐)', existing.AUTO_STOP_IDLE_MINUTES || '0') : '0';
rl.close();

const values = {
  PUBLIC_URL: publicUrl,
  PORT: existing.PORT || '8787',
  ALLOWED_ORIGINS: origins,
  ADMIN_PASSWORD: existing.ADMIN_PASSWORD || randomToken(12),
  CLI_TOKEN: existing.CLI_TOKEN || randomToken(32),
  PAIRING_TOKEN: existing.PAIRING_TOKEN || randomToken(24),
  DEFAULT_PROJECT: project,
  GODOT_GITHUB_TOKEN: githubToken,
  PAPERSPACE_API_KEY: paperspaceKey,
  PAPERSPACE_MACHINE_ID: machineId,
  AUTO_STOP_IDLE_MINUTES: autoStop,
};
// 질문하지 않는 다른 설정(HEADLESS_* 등)은 그대로 유지
for (const [k, v] of Object.entries(existing)) if (!(k in values)) values[k] = v;
const text = `# godot-mcp-relay 설정 (비밀값이 들어 있으니 공유하지 마세요)\n${Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
writeFileSync(path, text, { mode: 0o600 });

console.log(`\n저장했습니다: ${path}\n`);
console.log('다음 값을 연결에 사용하세요:');
console.log(`  claude.ai 커넥터 URL      : ${publicUrl.replace(/\/$/, '')}/mcp`);
console.log(`  claude.ai 로그인 비밀번호  : ${values.ADMIN_PASSWORD}`);
console.log(`  웹 에디터 MCP 서버 주소    : ${publicUrl.replace(/\/$/, '')}`);
console.log(`  웹 에디터 페어링 토큰      : ${values.PAIRING_TOKEN}`);
console.log(`  Claude Code 명령:\n    claude mcp add --transport http godot ${publicUrl.replace(/\/$/, '')}/mcp --header "Authorization: Bearer ${values.CLI_TOKEN}"`);
if (paperspaceKey) console.log(`  GitHub 워크플로 시크릿 RELAY_CLI_TOKEN: 위 CLI_TOKEN과 같은 값`);
console.log('\n값은 나중에 .env 파일에서 다시 볼 수 있습니다.');
