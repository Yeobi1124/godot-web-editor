# 구조

```
브라우저 ───────────── 같은 주소 (Cloudflare Worker: worker/) ─────────────
  에디터 페이지 (web/)                    /auth/*  GitHub App 로그인 (세션 쿠키)
    Godot 웹 에디터 (wasm, 캔버스)         /gh/*    GitHub API 대리 호출 (사용자 토큰을 Worker가 붙임)
      addons/web_editor_bridge ◀─JS─▶ bridge.js
    sync.js  ──/gh──▶ 게임 저장소          /mcp, /oauth/*  Claude 연결 (MCP + OAuth 2.1)
    mcp-link.js ──/live(WebSocket)──▶     Hub(사용자별 Durable Object) ◀── Claude의 도구 호출
    sw.js: 엔진 조각(GitHub Pages 미러 → Worker 정적 파일)을 이어 붙여 캐시
  project-api.js (도구 레지스트리): window.godotAI, WebMCP, AI 패널, Claude(MCP)가 공유
탭이 없을 때: Worker가 GitHub에 바로 커밋, run_tests/check_scripts는 GitHub Actions(godot-runner.yml)
```

## 파일

| 파일 | 역할 |
|---|---|
| `web/index.html`, `css/app.css` | 화면 (상단 표시줄, 에디터 캔버스, 게임 화면, AI 패널, 로그인/프로젝트 선택, 설정) |
| `web/coi.js`, `web/sw.js` | service worker 등록, 엔진 조각 받기·이어 붙이기·캐시 (COOP/COEP 헤더는 Worker가 붙임) |
| `web/js/main.js` | 시작 순서 조율 |
| `web/js/godot-host.js` | Godot 엔진 실행 (에디터, 게임 실행, 에디터 재시작) |
| `web/js/sync.js` | 3-way 동기화 엔진 |
| `web/js/github.js` | GitHub Git Data API 클라이언트 |
| `web/js/idbfs.js` | Emscripten IDBFS 형식의 IndexedDB 직접 읽기/쓰기 |
| `web/js/bridge.js` | 브리지 애드온과의 요청/응답 |
| `web/js/scaffold.js` | 브리지 애드온 설치, `project.godot` 활성화 항목 추가 |
| `web/js/project-api.js` | 도구 레지스트리 (모든 AI 진입점이 공유) |
| `web/js/ai-bridge.js` | `window.godotAI`, WebMCP 등록, MCP content 변환 |
| `web/js/ai-panel.js` | DOM AI 패널 |
| `web/js/mcp-link.js` | Worker(/live)와의 WebSocket: Claude의 도구 호출을 받아 실행 |
| `web/addon/web_editor_bridge/` | 에디터 안에서 동작하는 GDScript 플러그인, `runner/`(테스트 실행기) |
| `worker/` | Cloudflare Worker: 로그인, GitHub 대리 호출, MCP, Hub, 엔진 조각 (설정: [CLOUD-SETUP.md](CLOUD-SETUP.md)) |
| `tests/` | 가짜 GitHub API, E2E 테스트 |

## 동기화

세 상태를 파일 단위로 비교합니다 (blob SHA는 git과 같은 방식으로 계산).

- **base**: 마지막으로 맞춰 둔 상태. `localStorage['gwe:sync:<owner>/<repo>@<branch>']`에 `{ head, headTree, base: { path: sha } }`로 저장
- **local**: IndexedDB의 프로젝트 파일 (`.gitignore`와 `.godot/` 제외)
- **remote**: 브랜치 최신 커밋의 트리

| local | remote | 처리 |
|---|---|---|
| = base | ≠ base | 원격 변경 적용 |
| ≠ base | = base | 로컬 변경 → 커밋 대상 |
| ≠ base | ≠ base, local = remote | 기준점만 갱신 |
| ≠ base | ≠ base, 서로 다름 | **충돌: 로컬 유지**, 원격 버전은 커밋 기록에 남음, 로그에 표시 |

### 시점별 동작

1. **에디터 시작 전 (`prepare`)**: 에디터가 실행 중이 아니므로 IndexedDB에 직접 쓴다. 이후 엔진 `init()`이 IndexedDB 내용을 메모리 파일 시스템으로 불러온다.
   이 브라우저에서 처음 동기화하는 경우(기준점 없음)에는 원격을 기준으로 하고, 덮어쓴 로컬 파일은 `/home/web_user/backups/`에 백업한다.
2. **자동 저장 (`push`, 기본 30초)**: IndexedDB를 읽어 base와 다른 파일을 blob → tree(`base_tree` = 원격 head 트리) → commit → ref 갱신(fast-forward만) 순서로 올린다.
   ref 갱신이 422(다른 곳에서 먼저 커밋)이면 원격 변경을 먼저 받고 한 번 다시 시도한다.
3. **원격 확인 (`pull`, 기본 30초, 창 포커스 시)**: 원격 변경을 브리지 `write_files`/`delete_files`로 에디터에 반영한다.
   **IndexedDB에 실제로 기록된 것을 확인한 뒤에만** base를 옮긴다. 그렇지 않으면 자동 저장이 아직 옛 내용인 로컬을 "변경"으로 보고 원격 변경을 되돌릴 수 있다.
   브리지가 없으면 base를 그대로 두고 "적용 대기"로 표시한다(새로고침 시 1번에서 적용).

### Godot 웹 에디터 관련 주의

- 공개 엔진 API는 쓰기(`copyToFS`)만 제공한다. 읽기는 IndexedDB, 실행 중 쓰기/삭제는 브리지 플러그인을 쓴다.
- 에디터에서 게임을 실행하면 별도의 엔진 인스턴스가 영구 경로(IndexedDB)를 통해 프로젝트를 읽는다. 그래서 프로젝트는 반드시 `/home/web_user` 아래에 있어야 한다.
- 웹 에디터는 `project.godot`을 저장할 때 웹 기본값(`gl_compatibility`)과 같은 렌더러 설정 줄을 지운다.
  데스크톱 Godot에서 렌더러가 바뀌지 않도록 브리지 플러그인이 시작할 때 데스크톱 기본값을 초기값으로 지정하고 다시 저장한다.
- 같은 프로젝트를 두 탭에서 열면 IndexedDB를 서로 덮어쓰므로 Web Locks로 막는다.

## 브리지 프로토콜

페이지 → 플러그인: `window.__godotBridgeCall(JSON.stringify({ id, method, params }))`
플러그인 → 페이지: `window.__godotBridgeResolve(JSON.stringify({ id, result, error }))`
준비/종료 알림: `window.__godotBridgeReady(version)`, `window.__godotBridgeGone()`

| method | params | result |
|---|---|---|
| `ping` | | `{ version, godot }` |
| `list_files` | `{ dir }` | `[{ path, size, mtime }]` |
| `read_file` | `{ path, encoding: 'utf8'\|'base64' }` | `{ path, encoding, content }` |
| `write_files` | `{ files: [{ path, content, encoding }] }` | `{ written, errors }` (열린 씬/스크립트 다시 불러오기 포함) |
| `delete_files` | `{ paths }` | `{ deleted, errors }` |
| `rescan`, `save_all`, `stop` | | `true` |
| `get_state` | | `{ current_scene, open_scenes, selected_nodes, playing, main_scene }` |
| `open_scene` | `{ path }` | `true` |
| `set_main_screen` | `{ name: 2D\|3D\|Script\|Game\|AssetLib }` | `true` |
| `play` | `{ scene: '' \| 'current' \| path }` | `true` |
| `screenshot` | `{ max_width }` | `{ mime_type, width, height, data(base64) }` |

경로는 모두 프로젝트 기준 상대 경로이며, `..`이 들어간 경로는 거부한다.

## 도구 레지스트리와 MCP

`ProjectAPI`의 도구 정의(`web/js/tool-defs.js`)는 MCP `tools/list` 형식(`name`, `title`, `description`, `inputSchema`, `annotations`)을 그대로 따르고, Worker도 같은 정의를 쓴다.
결과는 JSON 객체이고, 이미지는 `{ type: 'image', mimeType, data }`이며 `toMcpContent()`로 MCP content 블록으로 바꾼다.

탭 ↔ Worker(/live) 메시지:

| 방향 | 메시지 |
|---|---|
| 탭 → Worker | `{ type: 'hello', protocol, project: { owner, repo, branch }, app, tools }` |
| Worker → 탭 | `{ type: 'welcome', tabId }`, `{ type: 'call', id, name, arguments, timeoutMs }` |
| 탭 → Worker | `{ type: 'result', id, ...toMcpContent(result) }` 또는 `{ type: 'result', id, isError: true, content }`, `{ type: 'state', ... }` |
| 양쪽 | `{ type: 'ping' }` / `{ type: 'pong' }` (Worker는 자동 응답) |

## 보안

- GitHub 토큰은 브라우저에 두지 않는다. Worker의 세션(Durable Object)이 보관하고 `/gh/*` 대리 호출에서만 붙인다. 세션 쿠키는 `HttpOnly`.
- `/gh/*`는 에디터가 쓰는 Git Data API 경로만 허용하고, 상태를 바꾸는 요청은 `X-GWE` 헤더와 같은 Origin이 필요하다.
- Claude(MCP)에는 Worker가 발급한 토큰만 준다. 도구 호출은 같은 GitHub 사용자의 탭으로만 간다.
- 자동 저장은 한 번에 많은 파일을 지우는 커밋을 올리지 않는다(사람 확인 필요). 브라우저 저장소가 사라진 것은 삭제로 보지 않고 다시 받는다.
- AI가 읽는 프로젝트 파일 내용은 데이터로 취급하라고 도구 설명과 안내문에 명시한다.
