// GitHub REST API (Git Data API) 최소 클라이언트. 토큰은 이 모듈 밖으로 나가지 않는다.
import { base64ToBytes, bytesToBase64, utf8Encode } from './util.js';

export class GitHubError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
}

export class GitHubClient {
  #token;

  constructor({ token, owner, repo, apiBase = 'https://api.github.com' }) {
    this.#token = token;
    this.owner = owner;
    this.repo = repo;
    this.apiBase = apiBase.replace(/\/$/, '');
  }

  get repoPath() {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  async request(method, path, body) {
    const res = await fetch(this.apiBase + path, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.#token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg = (data && data.message) || res.statusText || 'request failed';
      throw new GitHubError(res.status, `GitHub ${method} ${path.split('?')[0]}: ${res.status} ${msg}`, data);
    }
    return data;
  }

  getUser() {
    return this.request('GET', '/user');
  }

  getRepo() {
    return this.request('GET', this.repoPath);
  }

  /** 브랜치의 최신 커밋 SHA. 브랜치가 없으면 null. 저장소가 비어 있으면 GitHubError(409). */
  async getBranchHead(branch) {
    try {
      const ref = await this.request('GET', `${this.repoPath}/git/ref/heads/${encodeURIComponent(branch)}`);
      return ref.object.sha;
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    }
  }

  getCommit(sha) {
    return this.request('GET', `${this.repoPath}/git/commits/${sha}`);
  }

  /** 트리를 재귀로 펼쳐 { path: blobSha } 형태로 반환 */
  async getTreeFiles(treeSha) {
    const tree = await this.request('GET', `${this.repoPath}/git/trees/${treeSha}?recursive=1`);
    if (tree.truncated) {
      throw new GitHubError(0, '저장소 파일이 너무 많아 GitHub가 목록을 잘라서 보냈습니다. 지원하지 않는 크기입니다.');
    }
    const files = {};
    for (const e of tree.tree) {
      if (e.type === 'blob' && e.mode !== '160000') files[e.path] = e.sha;
    }
    return files;
  }

  async getBlob(sha) {
    const blob = await this.request('GET', `${this.repoPath}/git/blobs/${sha}`);
    if (blob.encoding === 'base64') return base64ToBytes(blob.content);
    return utf8Encode(blob.content);
  }

  async createBlob(bytes) {
    const res = await this.request('POST', `${this.repoPath}/git/blobs`, {
      content: bytesToBase64(bytes),
      encoding: 'base64',
    });
    return res.sha;
  }

  /** entries: [{ path, sha }] (sha가 null이면 삭제) */
  async createTree(baseTree, entries) {
    const res = await this.request('POST', `${this.repoPath}/git/trees`, {
      base_tree: baseTree,
      tree: entries.map((e) => ({ path: e.path, mode: '100644', type: 'blob', sha: e.sha })),
    });
    return res.sha;
  }

  async createCommit(message, treeSha, parents) {
    const res = await this.request('POST', `${this.repoPath}/git/commits`, { message, tree: treeSha, parents });
    return res.sha;
  }

  /** fast-forward만 허용 (force 없음). 다른 곳에서 먼저 바뀌었으면 422 */
  updateBranch(branch, sha) {
    return this.request('PATCH', `${this.repoPath}/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force: false });
  }

  createBranch(branch, sha) {
    return this.request('POST', `${this.repoPath}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  }

  /** 빈 저장소에 첫 파일을 만들 때만 사용 (Git Data API는 빈 저장소에서 동작하지 않음) */
  createFileWithContentsApi(path, bytes, message, branch) {
    return this.request('PUT', `${this.repoPath}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
      message,
      content: bytesToBase64(bytes),
      ...(branch ? { branch } : {}),
    });
  }
}
