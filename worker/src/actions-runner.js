// GitHub Actions로 테스트 실행 / 스크립트 검사. RUNNER_REPO(비공개 실행기 저장소)의 godot-runner.yml을 실행한다
// (그 파일은 runner-template/godot-runner.yml, 실제 로직은 이 저장소의 재사용 워크플로 .github/workflows/godot-runner.yml)
// 웹 에디터가 열려 있지 않을 때 쓴다. 실행 기록은 run-name "gwe <request_id>"로 찾는다.
import { appConfigured, installationToken } from './github-app.js';
import { githubFetch, randomToken } from './http.js';

const WORKFLOW = 'godot-runner.yml';
const WAIT_MS = 100000; // MCP 호출 한 번에 기다리는 최대 시간
// 확인 간격: 처음 30초는 3초마다, 그 뒤는 8초마다 (Worker 요청 하나의 외부 호출 한도 50회 안에 넉넉히 들도록)
const POLL_FAST_MS = 3000;
const POLL_SLOW_MS = 8000;
const FAST_FOR_MS = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const runnerConfigured = (env) => appConfigured(env) && !!env.RUNNER_REPO;

export const NOT_CONFIGURED =
  'GitHub Actions 실행기가 설정되지 않았습니다 (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, RUNNER_REPO). docs/CLOUD-SETUP.md의 "테스트 실행기"를 참고하세요. ' +
  '웹 에디터를 열어 두면 브라우저에서 바로 실행됩니다.';

async function api(env, token, path, init = {}) {
  const res = await githubFetch(env, path, { token, ...init });
  if (!res.ok) throw Object.assign(new Error(`GitHub ${init.method || 'GET'} ${path.split('?')[0]}: ${res.status}`), { status: res.status });
  return res.status === 204 ? null : res.json();
}

async function findRun(env, token, requestId) {
  const data = await api(env, token, `/repos/${env.RUNNER_REPO}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=30`);
  return (data.workflow_runs ?? []).find((r) => r.display_title === `gwe ${requestId}` || r.name === `gwe ${requestId}`) ?? null;
}

/** 끝난 실행의 로그에서 마지막 "GWE_RESULT {json}" 줄을 꺼낸다 */
async function readResult(env, token, run) {
  const { jobs = [] } = await api(env, token, `/repos/${env.RUNNER_REPO}/actions/runs/${run.id}/jobs`);
  for (const job of jobs) {
    const res = await githubFetch(env, `/repos/${env.RUNNER_REPO}/actions/jobs/${job.id}/logs`, { token, redirect: 'manual' });
    // 로그는 임시 저장소 주소로 리다이렉트된다. 그 주소에는 인증 헤더를 보내지 않는다
    const text = res.status >= 300 && res.status < 400 ? await (await fetch(res.headers.get('Location'))).text() : res.ok ? await res.text() : '';
    const lines = text.split('\n').filter((l) => /GWE_RESULT \{/.test(l));
    const last = lines.at(-1);
    if (last) {
      try {
        return JSON.parse(last.slice(last.indexOf('GWE_RESULT ') + 'GWE_RESULT '.length).trim());
      } catch {
        /* 다음 job */
      }
    }
  }
  return null;
}

/** request_id의 실행을 기다린다. 시간 안에 끝나지 않으면 status: running */
const waitMs = (env) => Number(env.RUNNER_WAIT_MS) || WAIT_MS;
const pollMs = (env, elapsed) => Number(env.RUNNER_POLL_MS) || (elapsed < FAST_FOR_MS ? POLL_FAST_MS : POLL_SLOW_MS);

export async function waitRun(env, requestId, { token = null, deadline = Date.now() + waitMs(env) } = {}) {
  const tok = token ?? (await installationToken(env, env.RUNNER_REPO, { actions: 'read' }));
  const started = Date.now();
  let run = null;
  for (;;) {
    const interval = pollMs(env, Date.now() - started);
    run = await findRun(env, tok, requestId);
    if (run?.status === 'completed') break;
    if (Date.now() + interval > deadline) {
      return {
        status: 'running',
        request_id: requestId,
        run_url: run?.html_url ?? null,
        note: run ? 'GitHub Actions에서 실행 중입니다. 잠시 뒤 같은 도구를 이 request_id로 다시 호출하세요.' : '실행을 기다리는 중입니다(대기열). 잠시 뒤 같은 도구를 이 request_id로 다시 호출하세요.',
      };
    }
    await sleep(interval);
  }
  const result = await readResult(env, tok, run);
  if (!result) return { ok: false, status: 'completed', request_id: requestId, run_url: run.html_url, error: `실행 결과를 찾지 못했습니다 (결론: ${run.conclusion}). 실행 기록을 확인하세요.` };
  return { ...result, status: 'completed', where: 'github-actions', request_id: requestId, run_url: run.html_url };
}

/** 새 실행 시작 → 기다리기 */
export async function startRun(env, { repo, sha, mode, filter = '' }) {
  if (filter && !/^[A-Za-z0-9_.-]*$/.test(filter)) throw new Error('filter에는 영문, 숫자, _ . - 만 쓸 수 있습니다');
  const deadline = Date.now() + waitMs(env);
  const token = await installationToken(env, env.RUNNER_REPO, { actions: 'write' });
  const requestId = randomToken(12).replace(/[^A-Za-z0-9]/g, 'x');
  await api(env, token, `/repos/${env.RUNNER_REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: env.RUNNER_REF || 'main', inputs: { repo, sha, mode, filter, request_id: requestId } }),
  });
  return waitRun(env, requestId, { token, deadline });
}
