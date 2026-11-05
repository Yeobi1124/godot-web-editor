// 테스트 실행기(gwe_runner.gd)를 Actions와 같은 방식(cli.gd)으로 진짜 Godot 헤드리스에서 돌려 결과 형식을 확인한다
// 사용법: GODOT_BIN=/path/to/Godot_v4.7.2-stable_linux.x86_64 node --test tests/runner-cli.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const GODOT = process.env.GODOT_BIN;
const RUNNER_SRC = join(ROOT, 'web/addon/web_editor_bridge/runner');
let dir;

function godot(args) {
  const r = spawnSync(GODOT, ['--headless', '--path', dir, ...args], { encoding: 'utf8', timeout: 180000 });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

function runCli(...args) {
  const { code, out } = godot(['-s', 'res://.gwe_runner/cli.gd', '--', ...args]);
  const line = out.split('\n').find((l) => l.startsWith('GWE_RESULT '));
  assert.ok(line, `GWE_RESULT 줄이 없음:\n${out}`);
  return { code, result: JSON.parse(line.slice('GWE_RESULT '.length)), out };
}

before(() => {
  if (!GODOT) return;
  dir = mkdtempSync(join(tmpdir(), 'gwe-runner-'));
  const files = {
    'project.godot': 'config_version=5\n\n[application]\n\nconfig/name="runner-fixture"\n',
    'tests/test_math.gd': 'extends RefCounted\n\nfunc test_add(t):\n\tt.eq(1 + 1, 2, "덧셈")\n\nfunc test_wrong(t):\n\tt.eq(2 * 2, 5, "일부러 틀림")\n\nfunc helper():\n\tpass\n',
    'tests/test_other.gd': 'extends Node\n\nfunc test_tree(t):\n\tt.ok(is_inside_tree(), "트리 안에서 실행")\n',
    'scripts/good.gd': 'extends Node\n\nfunc _ready() -> void:\n\tpass\n',
    'scripts/broken.gd': 'extends Node\n\nfunc _ready(:\n\tpass\n',
  };
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  mkdirSync(join(dir, '.gwe_runner'));
  for (const f of readdirSync(RUNNER_SRC).filter((f) => f.endsWith('.gd'))) cpSync(join(RUNNER_SRC, f), join(dir, '.gwe_runner', f));
  godot(['--import']);
});

after(() => dir && rmSync(dir, { recursive: true, force: true }));

test('test 모드: 통과/실패를 함수 단위로 보고', { skip: !GODOT && 'GODOT_BIN 없음' }, () => {
  const { code, result } = runCli('test');
  assert.equal(result.mode, 'test');
  assert.equal(result.ok, false);
  assert.equal(result.total, 3);
  assert.equal(result.passed, 2);
  assert.deepEqual(result.tests.map((t) => `${t.name}:${t.ok}`).sort(), ['test_math::test_add:true', 'test_math::test_wrong:false', 'test_other::test_tree:true']);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].message, /일부러 틀림/);
  assert.match(result.godot, /^4\./);
  assert.equal(code, 1);
});

test('test 모드: 필터로 파일 고르기, 모두 통과하면 종료 코드 0', { skip: !GODOT && 'GODOT_BIN 없음' }, () => {
  const { code, result } = runCli('test', 'other');
  assert.equal(result.ok, true);
  assert.equal(result.total, 1);
  assert.equal(result.tests[0].name, 'test_other::test_tree');
  assert.equal(code, 0);
});

test('check 모드: 파싱 오류만 한 번씩, 실행기 폴더(.gwe_runner)는 제외', { skip: !GODOT && 'GODOT_BIN 없음' }, () => {
  const { code, result } = runCli('check');
  assert.equal(result.mode, 'check');
  assert.equal(result.ok, false);
  assert.equal(result.files, 4); // scripts/ 2개 + tests/ 2개
  const paths = [...new Set(result.errors.map((e) => e.path))];
  assert.deepEqual(paths, ['res://scripts/broken.gd']);
  assert.ok(result.errors.every((e) => !/^Failed to load script/.test(e.message)), JSON.stringify(result.errors));
  assert.ok(result.errors[0].line > 0);
  assert.equal(code, 1);
});
