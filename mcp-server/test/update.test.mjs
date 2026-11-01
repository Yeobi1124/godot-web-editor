// 자동 업데이트(deploy/update.sh) 테스트: 가짜 원격 저장소 + 서버 쪽 클론 + 가짜 npm
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MCP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(MCP, '..');
let tmp;
let remote;
let dev; // 개발자 쪽 클론 (새 커밋을 원격에 올림)
let server; // 서버 쪽 클론 (update.sh 실행)
let npmLog;
let port = 18900;

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
const head = (cwd) => git(cwd, 'rev-parse', '--short', 'HEAD');

function commitFile(path, content, msg = `change ${path}`) {
  mkdirSync(dirname(join(dev, path)), { recursive: true });
  writeFileSync(join(dev, path), content);
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', msg);
  git(dev, 'push', '-q', 'origin', 'main');
  return head(dev);
}

function runUpdate(env = {}) {
  const r = spawnSync('bash', [join(server, 'mcp-server/deploy/update.sh')], {
    cwd: server,
    encoding: 'utf8',
    env: {
      ...process.env,
      NPM: join(tmp, 'npm-stub'),
      NPX: join(tmp, 'npm-stub'),
      UPDATE_VERIFY_PORT: String(++port),
      GITHUB_TOKEN: '',
      GODOT_GITHUB_TOKEN: '',
      ...env,
    },
    timeout: 120000,
  });
  const state = JSON.parse(readFileSync(join(server, 'mcp-server/data/update-state.json'), 'utf8'));
  return { code: r.status, out: r.stdout + r.stderr, state };
}

const npmCalls = () => (existsSync(npmLog) ? readFileSync(npmLog, 'utf8').trim().split('\n').filter(Boolean) : []);

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'update-test-'));
  npmLog = join(tmp, 'npm.log');
  // 가짜 npm/npx: 호출을 기록하고, NPM_FAIL=1이면 실패
  writeFileSync(join(tmp, 'npm-stub'), `#!/usr/bin/env bash\necho "$PWD :: $*" >> ${npmLog}\n[ "\${NPM_FAIL:-0}" = "1" ] && exit 1\nexit 0\n`, { mode: 0o755 });
  // 원격(bare)과 개발자 클론: 실제 저장소의 추적 파일로 시작
  remote = join(tmp, 'remote.git');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  dev = join(tmp, 'dev');
  git(tmp, 'clone', '-q', remote, dev);
  git(dev, 'checkout', '-q', '-b', 'main');
  // 추적 중인 파일 + 아직 커밋하지 않은 새 파일 (작업 중인 코드 그대로 시험)
  for (const f of git(REPO, 'ls-files', '--cached', '--others', '--exclude-standard').split('\n')) {
    if (!f.startsWith('mcp-server/') && !f.startsWith('web/js/') && f !== '.gitignore') continue;
    mkdirSync(dirname(join(dev, f)), { recursive: true });
    cpSync(join(REPO, f), join(dev, f));
  }
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', 'initial');
  git(dev, 'push', '-q', '-u', 'origin', 'main');
});

beforeEach(() => {
  // 매번 새 서버 클론 (원격 최신 상태에서 시작)
  server = join(tmp, `server-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  git(tmp, 'clone', '-q', remote, server);
  symlinkSync(join(MCP, 'node_modules'), join(server, 'mcp-server/node_modules'));
  writeFileSync(
    join(server, 'mcp-server/.env'),
    'PUBLIC_URL=http://localhost:1\nADMIN_PASSWORD=admin-password-1234\nCLI_TOKEN=cli-token-update-1234\nPAIRING_TOKEN=pairing-update-1234\nEDITOR_PAGE_URL=off\n',
  );
  rmSync(npmLog, { force: true });
});

after(() => rmSync(tmp, { recursive: true, force: true }));

describe('자동 업데이트', () => {
  test('최신이면 아무것도 하지 않음', () => {
    const r = runUpdate();
    assert.equal(r.code, 0);
    assert.equal(r.state.status, 'current', r.out);
    assert.deepEqual(npmCalls(), []);
  });

  test('코드만 바뀌면: 받고, npm ci 없이, 새 버전 확인 후 완료', () => {
    const before = head(server);
    const next = commitFile('mcp-server/src/log.js', `${readFileSync(join(dev, 'mcp-server/src/log.js'), 'utf8')}// 업데이트 테스트\n`, '로그 주석 추가');
    const r = runUpdate();
    assert.equal(r.state.status, 'updated', r.out);
    assert.equal(r.state.from, before);
    assert.equal(r.state.to, next);
    assert.equal(head(server), next);
    assert.deepEqual(npmCalls(), [], 'package-lock이 그대로면 npm ci 안 함');
    assert.match(r.state.message, /로그 주석 추가/);
  });

  test('package-lock.json이 바뀌면 그 폴더만 npm ci', () => {
    mkdirSync(join(server, 'mcp-server/headless/node_modules'), { recursive: true }); // 헤드리스 설치된 서버
    const lock = JSON.parse(readFileSync(join(dev, 'mcp-server/package-lock.json'), 'utf8'));
    lock.name = `${lock.name}`; // 내용은 같게 두고 공백만 바꿔 파일 변경
    commitFile('mcp-server/package-lock.json', `${JSON.stringify(lock, null, 2)}\n\n`, '의존성 갱신');
    const r = runUpdate();
    assert.equal(r.state.status, 'updated', r.out);
    const calls = npmCalls();
    assert.equal(calls.length, 1, calls.join('\n'));
    assert.match(calls[0], /mcp-server :: ci/);
    assert.doesNotMatch(calls[0], /headless/);
  });

  test('헤드리스 의존성이 바뀌면 npm ci + Chromium 설치', () => {
    mkdirSync(join(server, 'mcp-server/headless/node_modules'), { recursive: true });
    commitFile('mcp-server/headless/package-lock.json', `${readFileSync(join(dev, 'mcp-server/headless/package-lock.json'), 'utf8')}\n`, '헤드리스 의존성');
    const r = runUpdate();
    assert.equal(r.state.status, 'updated', r.out);
    const calls = npmCalls();
    assert.ok(calls.some((c) => /headless :: ci/.test(c)) && calls.some((c) => /headless :: playwright install chromium/.test(c)), calls.join('\n'));
  });

  test('새 버전의 서버가 시작되지 않으면 이전 버전으로 되돌림', () => {
    const before = head(server);
    const broken = commitFile('mcp-server/src/tools.js', 'export class ToolRouter { constructor( {\n', '깨진 커밋');
    const r = runUpdate();
    assert.equal(r.code, 0, '실패해도 0으로 끝나야 서비스가 기존 코드로 시작됨');
    assert.equal(r.state.status, 'rolled_back', r.out);
    assert.equal(r.state.from, before);
    assert.equal(r.state.to, broken);
    assert.equal(head(server), before, '이전 버전으로 돌아감');
    // 원격을 고쳐 둔다 (다음 테스트를 위해)
    git(dev, 'revert', '--no-edit', 'HEAD');
    git(dev, 'push', '-q', 'origin', 'main');
  });

  test('npm ci가 실패하면 이전 버전으로 되돌림', () => {
    const before = head(server);
    commitFile('mcp-server/package-lock.json', `${readFileSync(join(dev, 'mcp-server/package-lock.json'), 'utf8')} `, '의존성 갱신 2');
    const r = runUpdate({ NPM_FAIL: '1' });
    assert.equal(r.state.status, 'rolled_back', r.out);
    assert.match(r.state.message, /의존성 설치 실패/);
    assert.equal(head(server), before);
  });

  test('서버에서 직접 고친 파일이 있으면 건너뜀', () => {
    commitFile('mcp-server/src/log.js', `${readFileSync(join(dev, 'mcp-server/src/log.js'), 'utf8')}// 또 다른 변경\n`);
    appendFileSync(join(server, 'mcp-server/src/config.js'), '// 서버에서 직접 수정\n');
    const before = head(server);
    const r = runUpdate();
    assert.equal(r.state.status, 'skipped', r.out);
    assert.match(r.state.message, /직접 고친 파일/);
    assert.equal(head(server), before);
  });

  test('서버에 로컬 커밋이 있으면(빨리 감기 불가) 건너뜀', () => {
    commitFile('mcp-server/src/log.js', `${readFileSync(join(dev, 'mcp-server/src/log.js'), 'utf8')}// 원격 변경\n`);
    writeFileSync(join(server, 'mcp-server/LOCAL.md'), 'local');
    git(server, 'add', '-A');
    git(server, 'commit', '-q', '-m', 'local commit');
    const r = runUpdate();
    assert.equal(r.state.status, 'skipped', r.out);
    assert.match(r.state.message, /로컬 커밋/);
  });

  test('GitHub에 연결할 수 없으면 기존 버전으로 시작', () => {
    git(server, 'remote', 'set-url', 'origin', join(tmp, 'does-not-exist.git'));
    const before = head(server);
    const r = runUpdate();
    assert.equal(r.code, 0);
    assert.equal(r.state.status, 'skipped', r.out);
    assert.match(r.state.message, /받지 못해/);
    assert.equal(head(server), before);
  });

  test('main이 아닌 브랜치면 건너뜀', () => {
    git(server, 'checkout', '-q', '-b', 'experiment');
    const r = runUpdate();
    assert.equal(r.state.status, 'skipped', r.out);
    assert.match(r.state.message, /브랜치/);
  });
});
