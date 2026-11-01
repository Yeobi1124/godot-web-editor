// 웹 에디터 탭이 없을 때 파일 도구를 GitHub 저장소에서 직접 처리한다.
// 웹 페이지와 같은 GitHub 클라이언트(web/js/github.js)를 그대로 쓴다.

import { GitHubClient, GitHubError } from '../../web/js/github.js';
import { base64ToBytes, bytesToBase64, looksLikeText, normalizeProjectPath, utf8Decode, utf8Encode } from '../../web/js/util.js';

export const GITHUB_TOOLS = new Set(['get_status', 'list_files', 'read_file', 'write_files', 'delete_files', 'sync_now', 'pull_remote']);

class ToolError extends Error {}

function checkPath(raw) {
  const p = normalizeProjectPath(raw);
  if (!p) throw new ToolError(`잘못된 경로입니다: ${JSON.stringify(raw)}`);
  if (p === '.godot' || p.startsWith('.godot/') || p.startsWith('.git/')) throw new ToolError(`이 경로는 다룰 수 없습니다: ${p}`);
  return p;
}

export class GitHubBackend {
  #token;

  constructor({ token, apiBase }) {
    this.#token = token;
    this.apiBase = apiBase;
  }

  #client(project) {
    return new GitHubClient({ token: this.#token, owner: project.owner, repo: project.repo, apiBase: this.apiBase });
  }

  async #head(gh, branch) {
    const head = await gh.getBranchHead(branch);
    if (!head) throw new ToolError(`브랜치가 없습니다: ${branch}`);
    const commit = await gh.getCommit(head);
    return { head, tree: commit.tree.sha };
  }

  /** 파일 변경을 커밋 하나로 기록. changes: [{ path, bytes|null }] */
  async #commit(gh, branch, changes, message) {
    for (let attempt = 0; ; attempt++) {
      const { head, tree } = await this.#head(gh, branch);
      const entries = [];
      for (const c of changes) entries.push({ path: c.path, sha: c.bytes ? await gh.createBlob(c.bytes) : null });
      const newTree = await gh.createTree(tree, entries);
      const commit = await gh.createCommit(message, newTree, [head]);
      try {
        await gh.updateBranch(branch, commit);
        return commit;
      } catch (e) {
        if (e instanceof GitHubError && e.status === 422 && attempt < 2) continue; // 그 사이 다른 커밋 -> 다시
        throw e;
      }
    }
  }

  async call(name, args, project) {
    const gh = this.#client(project);
    switch (name) {
      case 'get_status': {
        const { head } = await this.#head(gh, project.branch);
        return {
          mode: 'github',
          repository: `${project.owner}/${project.repo}`,
          branch: project.branch,
          head_commit: head,
          editor_ready: false,
          note: '웹 에디터 탭이 연결되어 있지 않아 GitHub 저장소를 직접 다룹니다. 파일 도구만 쓸 수 있고, 스크린샷/게임 실행/로그는 웹 에디터를 열어야 합니다.',
        };
      }
      case 'list_files': {
        const prefix = args.dir ? `${checkPath(args.dir)}/` : '';
        const { tree } = await this.#head(gh, project.branch);
        const entries = await gh.getTreeEntries(tree);
        return { files: entries.filter((e) => e.path.startsWith(prefix) && !e.path.startsWith('.godot/')).map((e) => ({ path: e.path, size: e.size })) };
      }
      case 'read_file': {
        const p = checkPath(args.path);
        const { tree } = await this.#head(gh, project.branch);
        const sha = (await gh.getTreeFiles(tree))[p];
        if (!sha) throw new ToolError(`파일이 없습니다: ${p}`);
        const bytes = await gh.getBlob(sha);
        return looksLikeText(bytes)
          ? { path: p, encoding: 'utf8', content: utf8Decode(bytes) }
          : { path: p, encoding: 'base64', size: bytes.length, content: bytesToBase64(bytes) };
      }
      case 'write_files': {
        if (!Array.isArray(args.files) || !args.files.length) throw new ToolError('files 배열이 비어 있습니다');
        const changes = args.files.map((f) => ({
          path: checkPath(f.path),
          bytes: f.encoding === 'base64' ? base64ToBytes(String(f.content ?? '')) : utf8Encode(String(f.content ?? '')),
        }));
        const commit = await this.#commit(gh, project.branch, changes, args.commit_message || `MCP: 파일 ${changes.length}개 수정`);
        return { written: changes.map((c) => c.path), errors: [], commit, note: '웹 에디터가 없어 GitHub에 바로 커밋했습니다. 에디터를 열면 자동으로 반영됩니다.' };
      }
      case 'delete_files': {
        if (!Array.isArray(args.paths) || !args.paths.length) throw new ToolError('paths 배열이 비어 있습니다');
        const paths = args.paths.map(checkPath);
        const { tree } = await this.#head(gh, project.branch);
        const files = await gh.getTreeFiles(tree);
        const existing = paths.filter((p) => files[p]);
        const missing = paths.filter((p) => !files[p]);
        let commit = null;
        if (existing.length) {
          commit = await this.#commit(gh, project.branch, existing.map((p) => ({ path: p, bytes: null })), args.commit_message || `MCP: 파일 ${existing.length}개 삭제`);
        }
        return { deleted: existing, errors: missing.map((p) => `not found: ${p}`), commit };
      }
      case 'sync_now':
      case 'pull_remote':
        return { commit: null, message: '웹 에디터 탭이 없어 GitHub 저장소를 직접 다루는 중입니다. 따로 동기화할 것이 없습니다.' };
      default:
        throw new ToolError(`GitHub 모드에서 지원하지 않는 도구: ${name}`);
    }
  }
}

export { ToolError as GitHubToolError };
