# godot-web-editor

로컬 설치 없이 **브라우저만으로** Godot 4 게임을 만들기 위한 웹 에디터입니다.
공식 Godot 웹 에디터를 그대로 쓰고, 프로젝트는 **GitHub 저장소에 자동으로 동기화**됩니다.
Claude 같은 AI가 프로젝트를 읽고 고칠 수 있도록 도구 API도 함께 제공합니다.

- 에디터 페이지: GitHub Pages (이 저장소, 공개)
- 게임 프로젝트: 별도의 GitHub 저장소 (비공개 가능)
- GitHub 토큰: **내 브라우저에만** 저장, GitHub API 외에는 전송하지 않음

## 사용법

1. 데스크톱용 **Chrome 또는 Edge**로 에디터 페이지를 엽니다. 첫 방문에는 페이지가 한 번 자동으로 새로고침됩니다.
2. 게임 저장소(예: `Yeobi1124/godot-test`), 브랜치, GitHub 토큰을 입력합니다.
   - [토큰 만들기](https://github.com/settings/personal-access-tokens/new): **Only select repositories**로 게임 저장소만 고르고,
     **Repository permissions → Contents: Read and write**를 줍니다. 만료 기간을 꼭 정하세요.
3. 에디터가 열리면 평소처럼 작업하고 `Ctrl+S`로 저장합니다. **약 30초마다 자동으로 GitHub에 커밋**됩니다.
   바로 올리려면 상단의 **지금 저장**을 누르세요.
4. 다른 곳(Claude Code, Codespaces, 다른 PC)에서 저장소에 커밋하면 **약 30초 안에 열려 있는 에디터에 반영**됩니다.
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
| **MCP 서버** (claude.ai·모바일·Claude Code) | 내 Ubuntu 컴퓨터에 `mcp-server/`를 설치하고 에디터 설정에서 연결합니다. 에디터를 닫아 두어도 파일 작업은 GitHub로 처리됩니다. [설치 안내](docs/MCP-SETUP.md) · [설계](docs/MCP.md) |

```js
godotAI.help()                                   // 사용법
await godotAI.status()                           // 저장소/동기화/에디터 상태
await godotAI.readFile('main.tscn')
await godotAI.writeFile('main.tscn', text, { message: '적 배치' })
await godotAI.setMainScreen('2D'); await godotAI.screenshot()   // { type: 'image', data: base64 PNG }
await godotAI.run(); await godotAI.logs({ level: 'error' }); await godotAI.stop()
```

도구 목록: `get_status`, `list_files`, `read_file`, `write_files`, `delete_files`, `get_editor_state`,
`open_scene`, `set_main_screen`, `screenshot`, `run_project`, `stop_project`, `get_logs`, `sync_now`, `pull_remote`

## 알아둘 점

- Godot 웹 에디터의 한계: **Compatibility 렌더러만**, **GDScript만**(C# 불가), 데스크톱 Chrome/Edge 권장(모바일 불가)
- 충돌(내 브라우저와 원격이 같은 파일을 동시에 바꾼 경우)은 **브라우저 쪽 내용을 유지**합니다.
  원격 버전은 GitHub 커밋 기록에 남아 있으며, 로그(AI 패널 → 로그)에 커밋 번호가 표시됩니다.
- 같은 프로젝트를 **여러 탭에서 동시에 열 수 없습니다** (파일이 서로 덮어써지는 것을 막기 위해).
- 탭을 닫아도 아직 올라가지 않은 변경은 브라우저에 남아 있다가, 다음에 열 때 올라갑니다.
- 파일 하나가 100MB를 넘으면 GitHub에 올릴 수 없습니다.
- 공용 PC에서는 연결할 때 "이 브라우저에 기억"을 끄거나, 끝난 뒤 **설정 → 로그아웃**을 누르세요.

## 개발

```bash
scripts/build.sh               # 공식 Godot 웹 에디터(체크섬 고정)를 받아 web/과 합쳐 dist/ 생성
node tools/serve.mjs 8060 dist # COOP/COEP 헤더를 붙여 로컬 서빙 → http://localhost:8060
node tests/e2e.mjs             # 가짜 GitHub API + 헤드리스 Chromium으로 전체 흐름 검증 (playwright 필요)
(cd mcp-server && npm ci && npm test)   # MCP 중계 서버 통합 테스트
node tests/e2e-mcp.mjs         # MCP 클라이언트 -> 중계 서버 -> 실제 웹 에디터 E2E
```

`main` 브랜치에 푸시하면 GitHub Actions가 빌드해서 GitHub Pages에 배포합니다
(저장소 **Settings → Pages → Source: GitHub Actions** 필요).

Godot 버전을 바꾸려면 `scripts/build.sh`의 `GODOT_VERSION`과 `GODOT_ZIP_SHA256`을 함께 고치고 E2E 테스트를 돌리세요.
에디터 내부 동작(파일 시스템 형식, 엔진 API)에 의존하는 부분이 있어 버전마다 확인이 필요합니다.

구조와 동기화 알고리즘, 브리지 프로토콜, MCP 연동 계획은 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)에 있습니다.
