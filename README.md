# godot-web-editor

로컬 설치 없이 **브라우저만으로** Godot 4 게임을 만들기 위한 웹 에디터입니다.
공식 Godot 웹 에디터를 그대로 쓰고, 프로젝트는 **GitHub 저장소에 자동으로 동기화**됩니다.
Claude 같은 AI가 프로젝트를 읽고 고칠 수 있도록 도구 API도 함께 제공합니다.

- 에디터 주소: **https://godotweb.solitary-cloud-8e56.workers.dev** (Cloudflare Worker)
- 게임 프로젝트: 별도의 GitHub 저장소 (비공개 가능)
- 로그인: **"GitHub로 로그인"** 한 번. GitHub 토큰은 Worker에만 보관되고 브라우저에는 남지 않습니다.
- 서비스 설정(Cloudflare, GitHub App): [docs/CLOUD-SETUP.md](docs/CLOUD-SETUP.md)

## 사용법

1. 데스크톱용 **Chrome 또는 Edge**로 에디터 주소를 엽니다.
2. **GitHub로 로그인**을 누르고, 처음이면 앱을 내 계정에 설치하면서 쓸 저장소를 고릅니다.
3. 프로젝트 목록에서 게임 저장소(예: `Yeobi1124/godot-test`)를 고릅니다. 마지막에 연 프로젝트는 다음부터 바로 열립니다.
   - 목록에 없는 저장소는 선택 화면의 **GitHub에서 앱에 저장소 추가/변경** 링크로 추가합니다.
   - 다른 프로젝트로 바꾸려면 **설정 → 다른 저장소 연결**을 누릅니다.
4. 에디터가 열리면 평소처럼 작업하고 `Ctrl+S`로 저장합니다. **약 30초마다 자동으로 GitHub에 커밋**됩니다(작성자는 본인).
   바로 올리려면 상단의 **지금 저장**을 누르세요.
5. 다른 곳(Claude Code, Codespaces, 다른 PC)에서 저장소에 커밋하면 **약 30초 안에 열려 있는 에디터에 반영**됩니다.
   바로 받으려면 **원격 확인**을 누르세요.

상단 표시줄의 상태: `동기화됨 · 커밋` / `저장 대기 N개` / `받는 중…` / `오류`. 초록 점은 에디터 브리지 연결 상태입니다.

### 처음 열 때 저장소에 추가되는 것

- `addons/web_editor_bridge/`: 에디터와 페이지를 잇는 작은 에디터 플러그인입니다.
  **웹 에디터가 아닌 곳(데스크톱 Godot, Codespaces)에서는 아무 동작도 하지 않습니다.**
- `project.godot`의 `[editor_plugins]`에 위 플러그인 활성화 항목
- 저장소가 비어 있으면 `.gitignore`와 기본 `project.godot`

## AI와 함께 쓰기

| 방법 | 설명 |
|---|---|
| **GitHub 경유** (Claude Code 등) | 저장소에 커밋하면 열려 있는 에디터에 자동 반영됩니다. 설치가 필요 없습니다. |
| **Claude in Chrome 등 브라우저 AI** | 페이지가 `window.godotAI` API를 제공합니다. **AI 패널 → AI 연결** 탭의 안내문을 복사해 AI에게 주세요. |
| **JS 실행 없이 클릭만 하는 AI** | **AI 패널 → 파일** 탭(경로·내용 입력란, 파일 저장 버튼)을 쓰면 됩니다. |
| **WebMCP** | 브라우저가 `navigator.modelContext`를 지원하면 같은 도구를 자동으로 등록합니다. (실험적 표준) |
| **MCP** (claude.ai·모바일·Claude Code) | 커넥터에 `에디터주소/mcp`를 추가하고 GitHub로 로그인하면 끝입니다. 에디터가 열려 있으면 Claude가 그 에디터를 실시간으로 조종하고, 없으면 GitHub에 바로 커밋합니다. [연결 방법](docs/CLOUD-SETUP.md#claude-연결-mcp) |

```js
godotAI.help()                                   // 사용법
await godotAI.status()                           // 저장소/동기화/에디터 상태
await godotAI.readFile('main.tscn')
await godotAI.writeFile('main.tscn', text, { message: '적 배치' })
await godotAI.setMainScreen('2D'); await godotAI.screenshot()   // { type: 'image', data: base64 PNG }
await godotAI.run(); await godotAI.logs({ level: 'error' }); await godotAI.stop()
```

도구 목록: `get_status`, `list_files`, `read_file`, `write_files`, `delete_files`, `get_editor_state`,
`open_scene`, `set_main_screen`, `screenshot`, `run_project`, `stop_project`, `get_logs`, `run_tests`, `check_scripts`, `sync_now`, `pull_remote`
(`run_tests`/`check_scripts`는 에디터가 열려 있으면 브라우저에서, 없으면 GitHub Actions에서 실행: [테스트 실행기](docs/CLOUD-SETUP.md#테스트-실행기-run_tests-check_scripts))

## 알아둘 점

- Godot 웹 에디터의 한계: **Compatibility 렌더러만**, **GDScript만**(C# 불가), 데스크톱 Chrome/Edge 권장(모바일 불가)
- 충돌(내 브라우저와 원격이 같은 파일을 동시에 바꾼 경우)은 **브라우저 쪽 내용을 유지**합니다.
  원격 버전은 GitHub 커밋 기록에 남아 있으며, 로그(AI 패널 → 로그)에 커밋 번호가 표시됩니다.
- 같은 프로젝트를 **여러 탭에서 동시에 열 수 없습니다** (파일이 서로 덮어써지는 것을 막기 위해).
- 탭을 닫아도 아직 올라가지 않은 변경은 브라우저에 남아 있다가, 다음에 열 때 올라갑니다.
- 파일 하나가 100MB를 넘으면 GitHub에 올릴 수 없습니다.
- 공용 PC에서는 작업이 끝난 뒤 **설정 → 로그아웃**을 누르세요.

## 개발

```bash
scripts/build-worker.sh        # dist-worker/ 생성: 공식 Godot 웹 에디터(체크섬 고정) + web/ + 엔진 조각, 헤더, mode=cloud
(cd worker && npm ci && npm test)   # Worker 통합 테스트 (wrangler dev + 가짜 GitHub OAuth)
node tests/e2e-cloud.mjs       # 브라우저 E2E: 로그인 → 에디터 → 자동 커밋 → 토큰 갱신 → 로그아웃 (playwright 필요)
```

`main`에 푸시하면 GitHub Actions(**클라우드 Worker** 워크플로)가 테스트 후 Cloudflare에 배포합니다.

예전 방식(토큰 입력, GitHub Pages, MCP 중계 서버)의 코드와 테스트는 정리할 예정이라 아직 남아 있습니다.

```bash
scripts/build.sh               # dist/ (토큰 입력 방식) — node tools/serve.mjs 8060 dist 로 로컬 확인
node tests/e2e.mjs             # 토큰 입력 방식 E2E
(cd mcp-server && npm ci && npm test)   # MCP 중계 서버 통합 테스트
node tests/e2e-mcp.mjs         # MCP 클라이언트 -> 중계 서버 -> 실제 웹 에디터 E2E
```

Godot 버전을 바꾸려면 `scripts/build.sh`의 `GODOT_VERSION`과 `GODOT_ZIP_SHA256`을 함께 고치고 E2E 테스트를 돌리세요.
에디터 내부 동작(파일 시스템 형식, 엔진 API)에 의존하는 부분이 있어 버전마다 확인이 필요합니다.

구조와 동기화 알고리즘, 브리지 프로토콜은 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)에 있습니다.
