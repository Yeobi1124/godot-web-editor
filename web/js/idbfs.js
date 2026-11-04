// Godot(Emscripten IDBFS)가 영구 경로를 저장하는 IndexedDB를 직접 다룬다.
//
// 형식: DB 이름 = 마운트 경로('/home/web_user'), 저장소 'FILE_DATA', 키 = 절대 경로,
//       값 = { timestamp: Date, mode: number, contents?: Uint8Array } (디렉터리는 contents 없음)
//
// 주의: 에디터가 실행 중일 때 여기에 쓰면 Godot의 다음 동기화가 덮어쓰거나 지울 수 있다.
//       쓰기는 에디터 시작 전에만 하고, 실행 중에는 읽기만 한다.

export const MOUNT = '/home/web_user';
const STORE = 'FILE_DATA';
const MODE_DIR = 0o40755;
const MODE_FILE = 0o100644;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(MOUNT);
    req.onupgradeneeded = () => {
      // DB가 처음 만들어지는 경우: Emscripten과 같은 구조로 만든다
      const db = req.result;
      const store = db.objectStoreNames.contains(STORE)
        ? req.transaction.objectStore(STORE)
        : db.createObjectStore(STORE);
      if (!store.indexNames.contains('timestamp')) store.createIndex('timestamp', 'timestamp', { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB가 다른 탭에서 사용 중입니다. 같은 에디터를 연 다른 탭을 닫아 주세요.'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

const rangeUnder = (dir) => IDBKeyRange.bound(`${dir}/`, `${dir}/￿`);

/** dir 아래 파일 목록: Map(상대경로 -> { contents: Uint8Array, timestamp: number }) */
export async function readTree(dir) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const out = new Map();
    await new Promise((resolve, reject) => {
      const req = store.openCursor(rangeUnder(dir));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        const v = cursor.value;
        if (v && v.contents) {
          const contents = v.contents instanceof Uint8Array ? v.contents : new Uint8Array(v.contents);
          out.set(cursor.key.slice(dir.length + 1), { contents, timestamp: +new Date(v.timestamp) });
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
    return out;
  } finally {
    db.close();
  }
}

/** files: [{ path, bytes }] (dir 기준 상대 경로). 상위 디렉터리 항목도 함께 만든다. */
export async function writeFiles(dir, files) {
  if (!files.length) return;
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const now = new Date();
    const dirs = new Set([dir]);
    for (const { path } of files) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(`${dir}/${parts.slice(0, i).join('/')}`);
    }
    // 마운트 경로부터 프로젝트 폴더까지의 상위 디렉터리
    const rel = dir.slice(MOUNT.length + 1).split('/');
    for (let i = 1; i < rel.length; i++) dirs.add(`${MOUNT}/${rel.slice(0, i).join('/')}`);
    for (const d of dirs) store.put({ timestamp: now, mode: MODE_DIR }, d);
    for (const { path, bytes } of files) store.put({ timestamp: now, mode: MODE_FILE, contents: bytes }, `${dir}/${path}`);
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function deleteFiles(dir, paths) {
  if (!paths.length) return;
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const p of paths) store.delete(`${dir}/${p}`);
    await txDone(tx);
  } finally {
    db.close();
  }
}

/** 프로젝트 폴더 전체 삭제 (로컬 데이터 초기화) */
export async function deleteTree(dir) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(rangeUnder(dir));
    tx.objectStore(STORE).delete(dir);
    await txDone(tx);
  } finally {
    db.close();
  }
}

/** 파일 하나 읽기 (절대 경로). 없으면 null. 에디터가 쓴 내용이 IndexedDB까지 저장됐는지 확인할 때 쓴다 */
export async function readFile(absPath) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(absPath);
      req.onsuccess = () => resolve(req.result?.contents ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}
