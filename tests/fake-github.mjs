// 테스트용 가짜 GitHub API (Git Data API 일부). 메모리에만 저장한다.
import { createHash, createVerify } from 'node:crypto';
import { createServer } from 'node:http';

const sha1 = (data) => createHash('sha1').update(data).digest('hex');
const gitBlobSha = (buf) => sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]));

export class FakeGitHub {
  constructor({ owner = 'tester', repo = 'game', token = 'test-token', branch = 'main' } = {}) {
    Object.assign(this, { owner, repo, token, branch });
    this.blobs = new Map();
    this.trees = new Map();
    this.commits = new Map();
    this.refs = new Map();
    this.requests = [];
    this.counter = 0;
    this.oauth = null;
  }

  /**
   * GitHub App 사용자 로그인(OAuth) 흉내. 켜면 /login/oauth/*, /user, /user/installations*를 제공하고,
   * 발급한 사용자 토큰(만료 시각 있음)도 API 인증에 쓸 수 있다. refresh 토큰은 한 번만 쓸 수 있다.
   */
  enableOAuth({ clientId = 'test-client', clientSecret = 'test-secret', tokenTtlSec = 28800, user = { id: 42, login: this.owner, name: 'Test User' } } = {}) {
    this.oauth = { clientId, clientSecret, tokenTtlSec, user, codes: new Map(), access: new Map(), refresh: new Set(), issued: 0, refreshed: 0, authorizeQueries: [] };
    return this.oauth;
  }

  /**
   * GitHub App(설치 토큰)과 실행기 저장소의 Actions 흉내.
   * - 앱 JWT(RS256)를 publicKeyPem으로 검증, 설치 토큰 발급 기록(app.issued)
   * - runnerRepo의 workflow dispatch → 실행 기록(app.runs). onDispatch(run, inputs)로 테스트가 완료 시점/결과를 정한다
   *   (run.complete(resultObj | null) 호출)
   */
  enableApp({ appId = '123', publicKeyPem, runnerRepo = 'tester/runner', installationId = 7 } = {}) {
    this.app = { appId, publicKeyPem, runnerRepo, installationId, issued: [], tokens: new Set(), runs: [], dispatches: [], onDispatch: null, nextRun: 1000 };
    return this.app;
  }

  #verifyJwt(header) {
    const jwt = header?.startsWith('Bearer ') ? header.slice(7) : '';
    const [h, p, sig] = jwt.split('.');
    if (!h || !p || !sig) return false;
    const v = createVerify('RSA-SHA256');
    v.update(`${h}.${p}`);
    if (!v.verify(this.app.publicKeyPem, Buffer.from(sig, 'base64url'))) return false;
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    const now = Date.now() / 1000;
    return String(claims.iss) === String(this.app.appId) && claims.exp > now && claims.iat <= now + 5;
  }

  async #handleApp(req, url, send, res, readBody) {
    const a = this.app;
    const auth = req.headers.authorization;
    let m;
    if (url.pathname.startsWith('/_logs/')) {
      const run = a.runs.find((r) => `/_logs/${r.id * 10}` === url.pathname);
      res.writeHead(run ? 200 : 404, { 'Content-Type': 'text/plain' });
      res.end(run?.log ?? '');
      return true;
    }
    if ((m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/installation$/))) {
      if (!this.#verifyJwt(auth)) return send(401, { message: 'A JSON web token could not be decoded' });
      const full = `${m[1]}/${m[2]}`;
      return full === a.runnerRepo || full === `${this.owner}/${this.repo}` ? send(200, { id: a.installationId }) : send(404, { message: 'Not Found' });
    }
    if ((m = url.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/)) && req.method === 'POST') {
      if (!this.#verifyJwt(auth)) return send(401, { message: 'A JSON web token could not be decoded' });
      const body = await readBody();
      const token = `ghs_inst_${a.issued.length + 1}`;
      a.issued.push({ token, ...body });
      a.tokens.add(token);
      return send(201, { token, expires_at: new Date(Date.now() + 3600e3).toISOString(), permissions: body.permissions, repositories: body.repositories });
    }
    const prefix = `/repos/${a.runnerRepo}/actions`;
    if (!url.pathname.startsWith(prefix)) return false;
    const tok = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!a.tokens.has(tok)) return send(401, { message: 'Bad credentials' });
    const p = url.pathname.slice(prefix.length);
    if (p === '/workflows/godot-runner.yml/dispatches' && req.method === 'POST') {
      const body = await readBody();
      const id = a.nextRun++;
      const run = {
        id,
        name: 'Godot 실행기',
        display_title: `gwe ${body.inputs.request_id}`,
        status: 'queued',
        conclusion: null,
        html_url: `https://github.example/${a.runnerRepo}/actions/runs/${id}`,
        log: '',
        complete(result) {
          this.status = 'completed';
          this.conclusion = result ? 'success' : 'failure';
          this.log = `2026-11-04T00:00:00.0000000Z ##[group]Run godot\n2026-11-04T00:00:01.0000000Z   PASS x\n${result ? `2026-11-04T00:00:02.0000000Z GWE_RESULT ${JSON.stringify(result)}\n` : ''}`;
        },
      };
      a.runs.unshift(run);
      a.dispatches.push({ ref: body.ref, inputs: body.inputs, token: tok });
      a.onDispatch?.(run, body.inputs);
      return send(204);
    }
    if (p.startsWith('/workflows/godot-runner.yml/runs') && req.method === 'GET') {
      return send(200, { total_count: a.runs.length, workflow_runs: a.runs.map(({ log, complete, ...r }) => r) });
    }
    if ((m = p.match(/^\/runs\/(\d+)\/jobs$/))) return send(200, { jobs: [{ id: Number(m[1]) * 10, name: 'run' }] });
    if ((m = p.match(/^\/jobs\/(\d+)\/logs$/))) {
      res.writeHead(302, { Location: `http://${req.headers.host}/_logs/${m[1]}` });
      res.end();
      return true;
    }
    return send(404, { message: `Not Found: ${req.method} ${p}` });
  }

  /** 발급한 사용자 토큰을 모두 만료시킨다 (갱신 테스트용) */
  expireUserTokens() {
    for (const k of this.oauth.access.keys()) this.oauth.access.set(k, 0);
  }

  #issueTokens() {
    const o = this.oauth;
    const n = ++o.issued;
    const access = `ghu_user_${n}`;
    const refresh = `ghr_refresh_${n}`;
    o.access.set(access, Date.now() + o.tokenTtlSec * 1000);
    o.refresh.add(refresh);
    return { access_token: access, expires_in: o.tokenTtlSec, refresh_token: refresh, refresh_token_expires_in: 15897600, token_type: 'bearer', scope: '' };
  }

  #authorized(header) {
    if (header === `Bearer ${this.token}`) return true;
    const t = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const exp = t && this.oauth?.access.get(t);
    return !!exp && exp > Date.now();
  }

  async #handleOAuth(req, url, send, res) {
    const o = this.oauth;
    if (url.pathname === '/login/oauth/authorize') {
      o.authorizeQueries.push(Object.fromEntries(url.searchParams));
      if (url.searchParams.get('client_id') !== o.clientId) return send(400, { error: 'bad client_id' });
      const code = `code_${o.codes.size + 1}_${Math.random().toString(36).slice(2, 8)}`;
      o.codes.set(code, url.searchParams.get('redirect_uri'));
      const to = new URL(url.searchParams.get('redirect_uri'));
      to.searchParams.set('code', code);
      to.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { Location: to.href });
      res.end();
      return true;
    }
    if (url.pathname === '/login/oauth/access_token' && req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (body.client_id !== o.clientId || body.client_secret !== o.clientSecret) return send(200, { error: 'incorrect_client_credentials' });
      if (body.grant_type === 'refresh_token') {
        if (!o.refresh.delete(body.refresh_token)) return send(200, { error: 'bad_refresh_token' });
        o.refreshed++;
        return send(200, this.#issueTokens());
      }
      if (!o.codes.has(body.code)) return send(200, { error: 'bad_verification_code' });
      o.codes.delete(body.code);
      return send(200, this.#issueTokens());
    }
    return false;
  }

  putBlob(buf) {
    const sha = gitBlobSha(buf);
    this.blobs.set(sha, buf);
    return sha;
  }

  putTree(files) {
    const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
    const sha = sha1(`tree ${JSON.stringify(sorted)}`);
    this.trees.set(sha, sorted);
    return sha;
  }

  putCommit(tree, parents, message) {
    const sha = sha1(`commit ${tree} ${parents.join(',')} ${message} ${++this.counter}`);
    this.commits.set(sha, { tree, parents, message });
    return sha;
  }

  head(branch = this.branch) {
    return this.refs.get(branch) ?? null;
  }

  /** 현재 브랜치 파일: { path: Buffer } */
  files(branch = this.branch) {
    const head = this.head(branch);
    if (!head) return {};
    const tree = this.trees.get(this.commits.get(head).tree);
    return Object.fromEntries(Object.entries(tree).map(([p, s]) => [p, this.blobs.get(s)]));
  }

  text(path) {
    return this.files()[path]?.toString('utf8') ?? null;
  }

  lastCommitMessage() {
    return this.commits.get(this.head())?.message ?? null;
  }

  /** 외부 커밋 시뮬레이션 (Claude Code 등): changes = { path: string|Buffer|null } */
  commit(changes, message = 'external commit') {
    const head = this.head();
    const base = head ? { ...this.trees.get(this.commits.get(head).tree) } : {};
    for (const [p, c] of Object.entries(changes)) {
      if (c === null) delete base[p];
      else base[p] = this.putBlob(Buffer.isBuffer(c) ? c : Buffer.from(c));
    }
    const sha = this.putCommit(this.putTree(base), head ? [head] : [], message);
    this.refs.set(this.branch, sha);
    return sha;
  }

  isAncestor(ancestor, sha) {
    const stack = [sha];
    while (stack.length) {
      const s = stack.pop();
      if (s === ancestor) return true;
      stack.push(...(this.commits.get(s)?.parents ?? []));
    }
    return false;
  }

  async handle(req, res) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, X-GitHub-Api-Version',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };
    const send = (status, body) => {
      res.writeHead(status, { ...cors, 'Content-Type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') return send(204);
    const url = new URL(req.url, 'http://x');
    if (this.oauth && url.pathname.startsWith('/login/oauth/')) {
      if ((await this.#handleOAuth(req, url, send, res)) !== false) return undefined;
    }
    if (this.app) {
      const readBody = async () => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      };
      const handled = await this.#handleApp(req, url, send, res, readBody);
      if (handled !== false) return undefined;
    }
    if (!this.#authorized(req.headers.authorization)) return send(401, { message: 'Bad credentials' });
    this.lastAuthorization = req.headers.authorization;
    if (this.oauth && req.method === 'GET') {
      const repoJson = () => ({
        full_name: `${this.owner}/${this.repo}`,
        name: this.repo,
        owner: { login: this.owner },
        default_branch: this.branch,
        private: true,
        permissions: { push: true, pull: true },
        pushed_at: '2026-11-01T00:00:00Z',
      });
      if (url.pathname === '/user') return send(200, { ...this.oauth.user, avatar_url: 'https://example.invalid/a.png' });
      if (url.pathname === '/user/installations') return send(200, { total_count: 1, installations: [{ id: 7, account: { login: this.owner } }] });
      if (url.pathname === '/user/installations/7/repositories') return send(200, { total_count: 1, repositories: [repoJson()] });
    }
    let body = null;
    if (req.method !== 'GET') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    }
    this.requests.push(`${req.method} ${url.pathname}`);
    const prefix = `/repos/${this.owner}/${this.repo}`;
    if (!url.pathname.startsWith(prefix)) return send(404, { message: 'Not Found' });
    const p = url.pathname.slice(prefix.length);
    const empty = this.refs.size === 0;
    let m;

    if (p === '' && req.method === 'GET') return send(200, { name: this.repo, default_branch: this.branch, permissions: { push: true, pull: true } });
    if ((m = p.match(/^\/git\/ref\/heads\/(.+)$/)) && req.method === 'GET') {
      if (empty) return send(409, { message: 'Git Repository is empty.' });
      const sha = this.refs.get(decodeURIComponent(m[1]));
      return sha ? send(200, { object: { sha, type: 'commit' } }) : send(404, { message: 'Not Found' });
    }
    if (p === '/git/refs' && req.method === 'POST') {
      this.refs.set(body.ref.replace('refs/heads/', ''), body.sha);
      return send(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if ((m = p.match(/^\/git\/refs\/heads\/(.+)$/)) && req.method === 'PATCH') {
      const branch = decodeURIComponent(m[1]);
      const cur = this.refs.get(branch);
      if (!body.force && cur && !this.isAncestor(cur, body.sha)) return send(422, { message: 'Update is not a fast forward' });
      this.refs.set(branch, body.sha);
      return send(200, { object: { sha: body.sha } });
    }
    if ((m = p.match(/^\/git\/commits\/(\w+)$/)) && req.method === 'GET') {
      const c = this.commits.get(m[1]);
      return c ? send(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((s) => ({ sha: s })), message: c.message }) : send(404, { message: 'Not Found' });
    }
    if (p === '/git/commits' && req.method === 'POST') {
      if (!this.trees.has(body.tree)) return send(422, { message: 'tree not found' });
      return send(201, { sha: this.putCommit(body.tree, body.parents, body.message) });
    }
    if ((m = p.match(/^\/git\/trees\/(\w+)$/)) && req.method === 'GET') {
      const t = this.trees.get(m[1]);
      if (!t) return send(404, { message: 'Not Found' });
      return send(200, { sha: m[1], truncated: false, tree: Object.entries(t).map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha, size: this.blobs.get(sha)?.length ?? 0 })) });
    }
    if (p === '/git/trees' && req.method === 'POST') {
      const base = body.base_tree ? { ...(this.trees.get(body.base_tree) ?? {}) } : {};
      for (const e of body.tree) {
        if (e.sha === null) delete base[e.path];
        else {
          if (!this.blobs.has(e.sha)) return send(422, { message: `blob not found ${e.sha}` });
          base[e.path] = e.sha;
        }
      }
      return send(201, { sha: this.putTree(base) });
    }
    if ((m = p.match(/^\/git\/blobs\/(\w+)$/)) && req.method === 'GET') {
      const b = this.blobs.get(m[1]);
      return b ? send(200, { sha: m[1], encoding: 'base64', content: b.toString('base64'), size: b.length }) : send(404, { message: 'Not Found' });
    }
    if (p === '/git/blobs' && req.method === 'POST') {
      if (empty) return send(409, { message: 'Git Repository is empty.' });
      return send(201, { sha: this.putBlob(Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8')) });
    }
    if ((m = p.match(/^\/contents\/(.+)$/)) && req.method === 'PUT') {
      const sha = this.commit({ [decodeURIComponent(m[1])]: Buffer.from(body.content, 'base64') }, body.message);
      return send(201, { commit: { sha } });
    }
    return send(404, { message: `Not Found: ${req.method} ${p}` });
  }

  listen(port) {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handle(req, res).catch((e) => {
        res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ message: e.message }));
      }));
      this.server.listen(port, resolve);
    });
  }

  close() {
    this.server?.close();
  }
}
