// 테스트용 가짜 GitHub API (Git Data API 일부). 메모리에만 저장한다.
import { createHash } from 'node:crypto';
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
    if (req.headers.authorization !== `Bearer ${this.token}`) return send(401, { message: 'Bad credentials' });
    const url = new URL(req.url, 'http://x');
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
