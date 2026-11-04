// GET /api/repos → 로그인한 사용자가 이 앱으로 쓸 수 있는 저장소 목록
import { withGitHubToken } from './auth.js';
import { error, githubFetch, json } from './http.js';

const MAX_PAGES = 5;

async function pages(env, token, path, key) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await githubFetch(env, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, { token });
    if (!res.ok) throw Object.assign(new Error(`GitHub ${path}: ${res.status}`), { status: res.status });
    const data = await res.json();
    const items = data[key] ?? [];
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

export function repos(req, env) {
  return withGitHubToken(req, env, (token) => listRepos(env, token));
}

async function listRepos(env, token) {
  try {
    const installations = await pages(env, token, '/user/installations', 'installations');
    const list = [];
    for (const inst of installations) {
      for (const repo of await pages(env, token, `/user/installations/${inst.id}/repositories`, 'repositories')) {
        list.push({
          full_name: repo.full_name,
          owner: repo.owner.login,
          name: repo.name,
          default_branch: repo.default_branch || 'main',
          private: !!repo.private,
          can_push: repo.permissions ? !!repo.permissions.push : true,
          updated_at: repo.pushed_at || repo.updated_at || null,
        });
      }
    }
    list.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return json({
      repos: list,
      install_url: env.GITHUB_APP_SLUG ? `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new` : null,
    });
  } catch (e) {
    return error(e.status === 401 ? 401 : 502, `저장소 목록을 가져오지 못했습니다: ${e.message}`);
  }
}
