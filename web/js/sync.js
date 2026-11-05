// GitHub 저장소 <-> 브라우저 프로젝트 양방향 동기화
//
// 세 가지 상태를 비교한다 (git의 3-way merge와 같은 개념):
//   base   : 마지막으로 동기화했을 때 각 파일의 blob SHA (localStorage에 저장)
//   local  : 브라우저 IndexedDB(Godot이 저장하는 곳)의 현재 파일
//   remote : GitHub 브랜치 최신 커밋의 파일
//
//   local == base, remote != base  -> 원격 변경: 받아서 적용
//   local != base, remote == base  -> 로컬 변경: 커밋해서 올림
//   둘 다 바뀌었고 서로 다름       -> 충돌: 로컬 우선(원격 버전은 git 기록에 남음), 경고 표시

import * as idb from './idbfs.js';
import { IgnoreMatcher } from './gitignore.js';
import { GitHubError } from './github.js';
import { bytesToBase64, gitBlobSha, looksLikeText, mapLimit, Mutex, shortSha, sleep, utf8Decode, utf8Encode } from './util.js';

const MAX_FILE_BYTES = 95 * 1024 * 1024; // GitHub blob 한도(100MB)보다 약간 작게
const WARN_FILE_BYTES = 50 * 1024 * 1024;
const BRIDGE_BATCH_BYTES = 8 * 1024 * 1024; // 브리지 한 번에 보내는 최대 크기
const DEFAULT_GITIGNORE = '# Godot 4+ specific ignores\n.godot/\n/android/\n';

// 자동 저장 안전장치: 한 번에 이만큼 지우는 저장은 사람이 확인해야 올린다
// (브라우저 저장소가 사라진 것을 "사용자가 지움"으로 착각해 파일을 대량 삭제한 사고 재발 방지)
const MASS_DELETE_MIN = 10;
const MASS_DELETE_RATIO = 0.25;
// 에디터를 열 때 기준점에 있던 파일이 이 비율 이상 로컬에 없으면 "브라우저 저장소가 사라졌다"고 본다
const LOST_STORE_RATIO = 0.5;

export class MassDeleteError extends Error {
  constructor(paths) {
    super(`파일 ${paths.length}개를 지우는 저장이라 자동으로 올리지 않았습니다. 의도한 삭제라면 '지금 저장'을 눌러 확인하세요.`);
    this.name = 'MassDeleteError';
    this.paths = paths;
  }
}

export class SyncEngine extends EventTarget {
  #mutex = new Mutex();
  #hashCache = new Map(); // path -> { timestamp, size, sha }
  #notes = []; // 다음 커밋 메시지에 넣을 메모 (AI 도구 등이 추가)
  #timers = [];

  constructor({ gh, branch, projectDir, bridge, logs }) {
    super();
    this.gh = gh;
    this.branch = branch;
    this.projectDir = projectDir;
    this.bridge = bridge;
    this.logs = logs;
    this.stateKey = `gwe:sync:${gh.owner}/${gh.repo}@${branch}`;
    this.state = this.#loadState();
    this.status = {
      phase: 'idle', // idle | pulling | pushing | error
      pending: [], // 올라가지 않은 로컬 변경 경로
      conflicts: [], // 마지막 충돌 경로
      remotePending: [], // 받았지만 아직 에디터에 적용하지 못한 원격 변경
      head: this.state.head,
      lastPush: null,
      lastPull: null,
      lastError: null,
    };
  }

  // ---------- 상태 저장 ----------

  #loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(this.stateKey));
      if (s && typeof s.base === 'object') return s;
    } catch {
      /* 무시 */
    }
    return { head: null, headTree: null, base: null };
  }

  #saveState() {
    try {
      localStorage.setItem(this.stateKey, JSON.stringify(this.state));
    } catch (e) {
      this.logs.error(`동기화 상태를 저장하지 못했습니다: ${e.message}`);
    }
  }

  resetState() {
    this.state = { head: null, headTree: null, base: null };
    localStorage.removeItem(this.stateKey);
  }

  #emit(patch = {}) {
    Object.assign(this.status, patch, { head: this.state.head });
    this.dispatchEvent(new CustomEvent('status', { detail: { ...this.status } }));
  }

  addNote(note) {
    if (note && this.#notes.length < 20) this.#notes.push(String(note).slice(0, 200));
  }

  // ---------- 로컬 / 원격 읽기 ----------

  /** IndexedDB의 프로젝트 파일 -> Map(path -> { sha, bytes, timestamp }) (ignore 규칙 적용) */
  async localSnapshot(ignore) {
    const raw = await idb.readTree(this.projectDir);
    const matcher = ignore ?? new IgnoreMatcher(raw.has('.gitignore') ? utf8Decode(raw.get('.gitignore').contents) : '');
    const out = new Map();
    for (const [path, f] of raw) {
      if (matcher.ignores(path)) continue;
      const cached = this.#hashCache.get(path);
      let sha;
      if (cached && cached.timestamp === f.timestamp && cached.size === f.contents.length) sha = cached.sha;
      else {
        sha = await gitBlobSha(f.contents);
        this.#hashCache.set(path, { timestamp: f.timestamp, size: f.contents.length, sha });
      }
      out.set(path, { sha, bytes: f.contents, timestamp: f.timestamp });
    }
    return out;
  }

  /** 원격 브랜치 상태. 저장소가 비어 있으면 head=null */
  async #fetchRemote() {
    let head;
    try {
      head = await this.gh.getBranchHead(this.branch);
    } catch (e) {
      if (e instanceof GitHubError && e.status === 409) return { head: null, tree: null, files: {} }; // 빈 저장소
      throw e;
    }
    if (head === null) {
      // 브랜치가 없으면 기본 브랜치에서 만든다
      const repo = await this.gh.getRepo();
      const defaultHead = repo.default_branch ? await this.gh.getBranchHead(repo.default_branch).catch(() => null) : null;
      if (!defaultHead) return { head: null, tree: null, files: {} };
      await this.gh.createBranch(this.branch, defaultHead);
      this.logs.info(`브랜치 '${this.branch}'를 '${repo.default_branch}'에서 만들었습니다.`);
      head = defaultHead;
    }
    const commit = await this.gh.getCommit(head);
    const files = await this.gh.getTreeFiles(commit.tree.sha);
    return { head, tree: commit.tree.sha, files };
  }

  async #ignoreForRemote(files) {
    if (!files['.gitignore']) return new IgnoreMatcher('');
    try {
      return new IgnoreMatcher(utf8Decode(await this.gh.getBlob(files['.gitignore'])));
    } catch {
      return new IgnoreMatcher('');
    }
  }

  // ---------- 에디터 시작 전 동기화 ----------

  /**
   * 에디터를 시작하기 전에 호출한다. 원격 변경을 IndexedDB에 직접 반영하고,
   * scaffold(localMap) 가 돌려주는 파일(브리지 애드온 등)을 추가로 쓴다.
   */
  prepare({ scaffold } = {}) {
    return this.#mutex.run(async () => {
      this.#emit({ phase: 'pulling' });
      const remote = await this.#fetchRemote();
      const ignore = await this.#ignoreForRemote(remote.files);
      const local = await this.localSnapshot(ignore);
      let hasBase = this.state.base !== null;
      let base = hasBase ? { ...this.state.base } : {};
      if (hasBase) {
        // 기준점에 있던 파일이 로컬에서 대부분(또는 project.godot가) 사라졌으면, 사용자가 지운 게 아니라
        // 브라우저 저장소(IndexedDB)가 정리된 것으로 본다 → 지우지 않고 처음 열 때처럼 GitHub에서 다시 받는다
        const tracked = Object.keys(base).filter((p) => !ignore.ignores(p));
        const missing = tracked.filter((p) => !local.has(p));
        const lostProject = !!base['project.godot'] && !local.has('project.godot');
        if (missing.length && (lostProject || (tracked.length >= MASS_DELETE_MIN && missing.length / tracked.length >= LOST_STORE_RATIO))) {
          this.logs.error(`이 브라우저에 저장된 프로젝트 파일 ${missing.length}개가 사라져 있습니다(브라우저 저장소 정리 등). 삭제로 보지 않고 GitHub에서 다시 받습니다.`);
          hasBase = false;
          base = {};
        }
      }

      const toWrite = [];
      const toDelete = [];
      const conflicts = [];
      const overwritten = []; // 기준점이 없을 때 원격으로 덮어쓴 로컬 파일 (백업)
      const paths = new Set([...local.keys(), ...Object.keys(remote.files), ...Object.keys(base)]);
      for (const path of paths) {
        if (ignore.ignores(path)) continue;
        const l = local.get(path)?.sha ?? null;
        const r = remote.files[path] ?? null;
        const b = base[path] ?? null;
        if (l === r) {
          if (r) base[path] = r;
          else delete base[path];
          continue;
        }
        if (!hasBase) {
          // 이 브라우저에서 처음 동기화: 원격을 기준으로 하되, 원격에 없는 로컬 파일은 유지(올림)
          if (r) {
            if (l) overwritten.push(path);
            toWrite.push({ path, sha: r });
            base[path] = r;
          }
          continue;
        }
        if (l === b) {
          if (r) toWrite.push({ path, sha: r });
          else toDelete.push(path);
          if (r) base[path] = r;
          else delete base[path];
        } else if (r === b) {
          // 로컬 변경 대기 중 -> 그대로 두고 나중에 올림
        } else {
          conflicts.push(path);
          if (r) base[path] = r;
          else delete base[path];
        }
      }

      if (overwritten.length) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = `${idb.MOUNT}/backups/${this.gh.repo}-${stamp}`;
        await idb.writeFiles(backupDir, overwritten.map((p) => ({ path: p, bytes: local.get(p).bytes })));
        this.logs.info(`원격과 다른 로컬 파일 ${overwritten.length}개를 백업했습니다: ${backupDir}`);
      }

      const downloaded = await mapLimit(toWrite, 6, async (w) => ({ path: w.path, bytes: await this.gh.getBlob(w.sha) }));
      await idb.writeFiles(this.projectDir, downloaded);
      await idb.deleteFiles(this.projectDir, toDelete);

      let scaffolded = [];
      if (scaffold) {
        const after = await this.localSnapshot(ignore);
        scaffolded = await scaffold(after);
        await idb.writeFiles(this.projectDir, scaffolded);
      }

      this.state = { head: remote.head, headTree: remote.tree, base };
      this.#saveState();
      if (conflicts.length) this.#reportConflicts(conflicts, remote.head);
      this.#emit({ phase: 'idle', lastPull: Date.now(), conflicts, remotePending: [] });
      await this.refreshStatus();
      return { downloaded: downloaded.length, deleted: toDelete.length, conflicts, scaffolded: scaffolded.map((f) => f.path) };
    });
  }

  #reportConflicts(paths, remoteHead) {
    this.logs.error(
      `충돌: 로컬과 원격이 모두 바뀐 파일 ${paths.length}개는 로컬 내용을 유지합니다. ` +
        `원격 버전은 GitHub 커밋 ${shortSha(remoteHead)} 에서 확인할 수 있습니다: ${paths.join(', ')}`,
    );
  }

  // ---------- 실행 중 동기화 ----------

  /** 로컬 변경 목록: [{ path, sha|null, bytes|null }] */
  #diffLocal(local) {
    const base = this.state.base ?? {};
    const changes = [];
    for (const [path, f] of local) if (base[path] !== f.sha) changes.push({ path, sha: f.sha, bytes: f.bytes });
    for (const path of Object.keys(base)) if (!local.has(path)) changes.push({ path, sha: null, bytes: null });
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  async refreshStatus() {
    try {
      const local = await this.localSnapshot();
      this.#emit({ pending: this.#diffLocal(local).map((c) => c.path) });
    } catch (e) {
      this.logs.error(`로컬 상태 확인 실패: ${e.message}`);
    }
  }

  pull() {
    return this.#mutex.run(() => this.#pullLocked());
  }

  async #pullLocked() {
    this.#emit({ phase: 'pulling' });
    try {
      const result = await this.#doPull();
      this.#emit({ phase: 'idle', lastPull: Date.now(), lastError: null });
      return result;
    } catch (e) {
      this.#emit({ phase: 'error', lastError: e.message });
      throw e;
    }
  }

  async #doPull() {
    let head;
    try {
      head = await this.gh.getBranchHead(this.branch);
    } catch (e) {
      if (e instanceof GitHubError && e.status === 409) return { applied: 0 };
      throw e;
    }
    if (!head) return { applied: 0 };
    if (head === this.state.head && this.status.remotePending.length === 0) return { applied: 0 };

    const commit = await this.gh.getCommit(head);
    const files = await this.gh.getTreeFiles(commit.tree.sha);
    const ignore = await this.#ignoreForRemote(files);
    const local = await this.localSnapshot(ignore);
    const base = this.state.base ?? {};

    const toApply = [];
    const toDelete = [];
    const conflicts = [];
    for (const path of new Set([...Object.keys(files), ...Object.keys(base)])) {
      if (ignore.ignores(path)) continue;
      const r = files[path] ?? null;
      const b = base[path] ?? null;
      if (r === b) continue;
      const l = local.get(path)?.sha ?? null;
      if (l === r) {
        if (r) base[path] = r;
        else delete base[path];
      } else if (l === b) {
        if (r) toApply.push({ path, sha: r });
        else toDelete.push(path);
      } else {
        conflicts.push(path);
        if (r) base[path] = r;
        else delete base[path];
      }
    }

    let applied = 0;
    const remotePending = [];
    if (toApply.length || toDelete.length) {
      if (!this.bridge.ready) {
        // 에디터가 아직 준비되지 않음: 기준점은 그대로 두고, 다음에 다시 시도(또는 새로고침 시 적용)
        remotePending.push(...toApply.map((a) => a.path), ...toDelete);
      } else {
        const blobs = await mapLimit(toApply, 6, async (a) => ({ ...a, bytes: await this.gh.getBlob(a.sha) }));
        await this.#applyViaBridge(blobs, toDelete);
        // Godot이 IndexedDB에 기록한 것을 확인한 뒤에만 기준점을 옮긴다 (자동 저장이 옛 내용을 되돌리지 않도록)
        const verified = await this.#waitLocal(blobs, toDelete, ignore);
        for (const a of blobs) {
          if (verified.has(a.path)) {
            base[a.path] = a.sha;
            applied++;
          } else remotePending.push(a.path);
        }
        for (const p of toDelete) {
          if (verified.has(p)) {
            delete base[p];
            applied++;
          } else remotePending.push(p);
        }
      }
    }

    this.state = { head, headTree: commit.tree.sha, base };
    this.#saveState();
    if (conflicts.length) this.#reportConflicts(conflicts, head);
    if (applied) this.logs.info(`원격 변경 ${applied}개를 에디터에 반영했습니다 (커밋 ${shortSha(head)}).`);
    this.#emit({ conflicts, remotePending });
    this.dispatchEvent(new CustomEvent('remote-applied', { detail: { head, applied, conflicts, remotePending } }));
    return { applied, conflicts, remotePending };
  }

  async #applyViaBridge(blobs, deletes) {
    let batch = [];
    let size = 0;
    const flush = async () => {
      if (!batch.length) return;
      const res = await this.bridge.call('write_files', { files: batch }, 60000);
      if (res.errors?.length) this.logs.error(`원격 변경 쓰기 오류: ${res.errors.join('; ')}`);
      batch = [];
      size = 0;
    };
    for (const b of blobs) {
      const text = looksLikeText(b.bytes);
      batch.push({ path: b.path, encoding: text ? 'utf8' : 'base64', content: text ? utf8Decode(b.bytes) : bytesToBase64(b.bytes) });
      size += b.bytes.length;
      if (size >= BRIDGE_BATCH_BYTES) await flush();
    }
    await flush();
    if (deletes.length) {
      const res = await this.bridge.call('delete_files', { paths: deletes }, 60000);
      if (res.errors?.length) this.logs.error(`원격 삭제 반영 오류: ${res.errors.join('; ')}`);
    }
  }

  /** 적용한 내용이 IndexedDB에 나타날 때까지 최대 5초 기다린다. 확인된 경로 Set 반환 */
  async #waitLocal(blobs, deletes, ignore) {
    const verified = new Set();
    for (let i = 0; i < 20; i++) {
      const local = await this.localSnapshot(ignore);
      for (const b of blobs) if (local.get(b.path)?.sha === b.sha) verified.add(b.path);
      for (const p of deletes) if (!local.has(p)) verified.add(p);
      if (verified.size === blobs.length + deletes.length) break;
      await sleep(250);
    }
    return verified;
  }

  /**
   * 로컬 변경을 커밋한다. 파일을 많이 지우는 저장은 MassDeleteError로 멈추고(자동 저장도 멈춤),
   * 사람이 확인한 뒤 allowMassDelete: true로 다시 부를 때만 올린다.
   */
  push(message, { allowMassDelete = false } = {}) {
    return this.#mutex.run(async () => {
      this.#emit({ phase: 'pushing' });
      try {
        const result = await this.#doPush(message, 0, allowMassDelete);
        this.blockedDeletes = null;
        this.#emit({ phase: 'idle', lastError: null, blockedDeletes: null, ...(result.commit ? { lastPush: Date.now() } : {}) });
        await this.refreshStatus();
        return result;
      } catch (e) {
        if (e instanceof MassDeleteError) {
          this.blockedDeletes = e.paths;
          this.logs.error(`${e.message} (예: ${e.paths.slice(0, 5).join(', ')})`);
        }
        this.#emit({ phase: 'error', lastError: e.message, ...(e instanceof MassDeleteError ? { blockedDeletes: e.paths } : {}) });
        throw e;
      }
    });
  }

  async #doPush(message, attempt, allowMassDelete = false) {
    let local = await this.localSnapshot();
    let changes = this.#diffLocal(local);
    if (!changes.length) return { commit: null, files: [] };

    if (!this.state.head) await this.#bootstrapEmptyRepo(local);

    const remoteHead = await this.gh.getBranchHead(this.branch);
    if (remoteHead !== this.state.head) {
      await this.#doPull();
      local = await this.localSnapshot();
      changes = this.#diffLocal(local);
      if (!changes.length) return { commit: null, files: [] };
    }

    const entries = [];
    for (const c of changes) {
      if (c.bytes && c.bytes.length > MAX_FILE_BYTES) {
        this.logs.error(`파일이 너무 커서 올리지 않습니다 (GitHub 한도 100MB): ${c.path}`);
        continue;
      }
      if (c.bytes && c.bytes.length > WARN_FILE_BYTES) this.logs.info(`큰 파일을 올립니다 (${(c.bytes.length / 1048576).toFixed(1)}MB): ${c.path}`);
      entries.push(c);
    }
    if (!entries.length) return { commit: null, files: [] };

    const deletes = entries.filter((e) => !e.sha).map((e) => e.path);
    const tracked = Object.keys(this.state.base ?? {}).length;
    const massDelete = deletes.includes('project.godot') || (deletes.length >= MASS_DELETE_MIN && deletes.length >= tracked * MASS_DELETE_RATIO);
    if (massDelete && !allowMassDelete) throw new MassDeleteError(deletes);

    await mapLimit(entries.filter((e) => e.bytes), 4, async (e) => {
      const sha = await this.gh.createBlob(e.bytes);
      if (sha !== e.sha) throw new Error(`업로드한 파일의 해시가 다릅니다: ${e.path}`);
    });
    const tree = await this.gh.createTree(this.state.headTree, entries.map((e) => ({ path: e.path, sha: e.sha })));
    const commit = await this.gh.createCommit(this.#commitMessage(message, entries), tree, [this.state.head]);
    try {
      await this.gh.updateBranch(this.branch, commit);
    } catch (e) {
      // 그 사이 다른 곳에서 커밋됨 -> 받아서 다시 시도 (1회)
      if (e instanceof GitHubError && e.status === 422 && attempt < 1) return this.#doPush(message, attempt + 1, allowMassDelete);
      throw e;
    }

    const base = this.state.base ?? {};
    for (const e of entries) {
      if (e.sha) base[e.path] = e.sha;
      else delete base[e.path];
    }
    this.state = { head: commit, headTree: tree, base };
    this.#saveState();
    this.#notes = [];
    this.logs.info(`GitHub에 저장했습니다: 파일 ${entries.length}개, 커밋 ${shortSha(commit)}`);
    return { commit, files: entries.map((e) => e.path) };
  }

  #commitMessage(message, entries) {
    const title = message?.trim() || this.#notes[0] || `웹 에디터 저장: 파일 ${entries.length}개`;
    const lines = entries.slice(0, 20).map((e) => `- ${e.sha ? '' : '(삭제) '}${e.path}`);
    if (entries.length > 20) lines.push(`- ... 외 ${entries.length - 20}개`);
    const notes = this.#notes.slice(message ? 0 : 1).map((n) => `* ${n}`);
    return [title, '', ...notes, ...(notes.length ? [''] : []), ...lines].join('\n');
  }

  /** 빈 저장소: Git Data API를 쓰려면 커밋이 하나 필요하므로 Contents API로 .gitignore를 먼저 만든다 */
  async #bootstrapEmptyRepo(local) {
    const bytes = local.get('.gitignore')?.bytes ?? utf8Encode(DEFAULT_GITIGNORE);
    await this.gh.createFileWithContentsApi('.gitignore', bytes, '웹 에디터: 저장소 초기화', this.branch);
    const remote = await this.#fetchRemote();
    const base = this.state.base ?? {};
    base['.gitignore'] = remote.files['.gitignore'];
    this.state = { head: remote.head, headTree: remote.tree, base };
    this.#saveState();
  }

  // ---------- 주기 실행 ----------

  start({ autosaveSec = 30, pollSec = 30, statusSec = 10 } = {}) {
    this.stop();
    const every = (sec, fn) => this.#timers.push(setInterval(() => fn().catch((e) => this.logs.error(e.message)), sec * 1000));
    every(statusSec, () => this.refreshStatus());
    every(pollSec, () => this.pull());
    if (autosaveSec > 0) {
      every(autosaveSec, async () => {
        await this.refreshStatus();
        // 대량 삭제로 멈춘 상태면 사람이 확인할 때까지 자동 저장하지 않는다 (지운 파일이 되돌아오면 다시 자동 저장)
        if (this.blockedDeletes) {
          const pending = new Set(this.status.pending);
          if (this.blockedDeletes.some((p) => pending.has(p))) return;
          this.blockedDeletes = null;
        }
        if (this.status.pending.length && this.status.phase !== 'error') await this.push();
      });
    }
    // 에디터가 준비되면 대기 중인 원격 변경을 바로 적용
    this.bridge.addEventListener('ready', () => this.pull().catch((e) => this.logs.error(e.message)));
    const onFocus = () => this.pull().catch((e) => this.logs.error(e.message));
    window.addEventListener('focus', onFocus);
    this.#timers.push({ clear: () => window.removeEventListener('focus', onFocus) });
  }

  stop() {
    for (const t of this.#timers) {
      if (typeof t === 'object' && t.clear) t.clear();
      else clearInterval(t);
    }
    this.#timers = [];
  }
}
