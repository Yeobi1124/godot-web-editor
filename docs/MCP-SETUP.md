# MCP 서버 설치 (Ubuntu + Tailscale Funnel)

Claude 앱(claude.ai·데스크톱·모바일)과 Claude Code에서 웹 에디터를 쓰기 위한 중계 서버 `godot-mcp-relay` 설치 방법입니다.
도메인 없이 **Tailscale Funnel**로 고정 HTTPS 주소를 받습니다. 공유기 포트를 열 필요가 없습니다.

```
Claude ──HTTPS──▶ Tailscale Funnel (https://<컴퓨터>.<tailnet>.ts.net) ──▶ 내 Ubuntu :8787 ◀──WebSocket── 웹 에디터 탭
```

## 1. Node.js 22 설치

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
```

```bash
sudo apt-get install -y nodejs git
```

```bash
node --version
```

## 2. 코드 받기와 의존성 설치

```bash
git clone https://github.com/Yeobi1124/godot-web-editor.git ~/godot-web-editor
```

```bash
cd ~/godot-web-editor/mcp-server && npm ci
```

## 3. Tailscale 설치와 Funnel 켜기

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

```bash
sudo tailscale up
```

처음이면 로그인 링크가 나옵니다. 브라우저로 열어 Tailscale 계정(무료)으로 로그인하세요.

```bash
sudo tailscale funnel --bg 8787
```

- Funnel을 처음 쓰면 관리 화면에서 HTTPS 인증서와 Funnel 사용을 허용하라는 링크가 나옵니다. 링크를 열어 허용한 뒤 명령을 다시 실행하세요.
- 공개 주소 확인:

```bash
tailscale funnel status
```

`https://<컴퓨터이름>.<tailnet이름>.ts.net` 형태의 주소가 **PUBLIC_URL**입니다.
Funnel 설정은 재부팅 후에도 유지됩니다(`--bg`).

## 4. 설정 만들기

```bash
cd ~/godot-web-editor/mcp-server && npm run init
```

묻는 값:

| 항목 | 입력 |
|---|---|
| `PUBLIC_URL` | 3단계의 `https://....ts.net` 주소 |
| `ALLOWED_ORIGINS` | 웹 에디터 페이지 주소. 기본값 `https://yeobi1124.github.io` 그대로 Enter |
| `DEFAULT_PROJECT` | (선택) 에디터 탭이 없을 때도 쓰려면 `Yeobi1124/godot-test@main` |
| `GODOT_GITHUB_TOKEN` | (선택) 위 저장소 전용 fine-grained 토큰 (Contents: Read and write) |

끝나면 **claude.ai 로그인 비밀번호, 페어링 토큰, Claude Code 명령**이 출력됩니다. 나중에 다시 보려면 `mcp-server/.env`를 여세요.
이 파일에는 비밀값이 들어 있으니 공유하거나 커밋하지 마세요(`.gitignore`에 포함되어 있음).

## 5. 서비스로 등록 (부팅 시 자동 시작)

```bash
~/godot-web-editor/mcp-server/deploy/install-service.sh
```

확인:

```bash
curl -s https://<PUBLIC_URL의 호스트>/healthz
```

`{"ok":true,...}`가 나오면 외부에서 접속되는 상태입니다. 로그는 `journalctl -u godot-mcp-relay -f`로 봅니다.

## 6. 연결하기

### 웹 에디터
에디터 페이지 상단 **설정 → MCP 서버**에 `PUBLIC_URL`과 페어링 토큰을 넣고 **저장하고 연결**을 누릅니다.
상단에 초록색 **MCP** 표시가 뜨면 연결된 것입니다. Claude가 실행한 도구는 **AI 패널 → AI 연결**에 표시됩니다.

### claude.ai · Claude 데스크톱 · 모바일 앱
1. claude.ai에서 **설정 → 커넥터 → 커스텀 커넥터 추가**
2. 이름: `Godot`, URL: `https://<PUBLIC_URL의 호스트>/mcp`
3. **연결**을 누르면 서버의 승인 화면이 열립니다. `npm run init`에서 출력된 **비밀번호**를 넣고 **승인**합니다.
4. 대화에서 커넥터를 켜고 "Godot 프로젝트 상태 확인해 줘"처럼 요청합니다.

웹에서 추가한 커넥터는 같은 계정의 데스크톱·모바일 앱에서도 쓸 수 있습니다. (커스텀 커넥터는 유료 플랜에서 제공됩니다.)

### Claude Code
`npm run init`이 출력한 명령을 실행합니다:

```bash
claude mcp add --transport http godot https://<PUBLIC_URL의 호스트>/mcp --header "Authorization: Bearer <CLI_TOKEN>"
```

## 7. 운영

| 작업 | 명령 |
|---|---|
| 상태 | `systemctl status godot-mcp-relay` |
| 로그 | `journalctl -u godot-mcp-relay -f` |
| 재시작 | `sudo systemctl restart godot-mcp-relay` |
| 업데이트 | `cd ~/godot-web-editor && git pull && cd mcp-server && npm ci && sudo systemctl restart godot-mcp-relay` |
| 비밀값 교체 | `.env`에서 값을 지우고 `npm run init` → 재시작 → 웹 에디터와 Claude 연결 다시 하기 |
| 모든 Claude 연결 끊기 | `mcp-server/data/auth.json` 삭제 후 재시작 |
| 외부 공개 중지 | `sudo tailscale funnel reset` |

## 8. (선택) 서버에서 에디터 상시 실행 — PC 없이 휴대폰에서도 모든 도구 사용

웹 에디터를 서버의 헤드리스 Chromium으로 계속 띄워 둡니다. PC 브라우저를 열지 않아도 Claude가 스크린샷, 게임 실행, 로그까지 쓸 수 있습니다.

- **PC에서 웹 에디터를 열면** 서버 쪽 에디터가 변경을 GitHub에 저장하고 **스스로 멈춥니다** (두 에디터가 같은 프로젝트를 동시에 고치지 않도록).
- **PC 에디터를 닫으면** 1분 뒤 서버 쪽 에디터가 GitHub에서 최신 상태를 받아 다시 시작합니다.
- CPU로 화면을 그리므로 메모리를 1~2GB 정도 씁니다.
- 서버 안의 에디터는 중계 서버가 전달하는 페이지(`http://127.0.0.1:8787/app/`)로 열립니다. 페이지와 MCP 연결이 같은 컴퓨터 안에서 이루어지므로
  공개 주소(Funnel)를 거치지 않고, 브라우저의 로컬 네트워크 접근 차단에도 걸리지 않습니다.

필요한 설정: 4단계의 `DEFAULT_PROJECT`(예: `Yeobi1124/godot-test@main`)와 `GODOT_GITHUB_TOKEN`. 비어 있으면 `npm run init`을 다시 실행해 입력하세요.

```bash
cd ~/godot-web-editor/mcp-server/headless && npm ci
```

```bash
npx playwright install --with-deps chromium
```

Chromium과 실행에 필요한 시스템 패키지를 설치합니다(sudo 비밀번호를 물을 수 있음, 수백 MB).

```bash
~/godot-web-editor/mcp-server/deploy/install-headless-service.sh
```

```bash
journalctl -u godot-headless-editor -f
```

"에디터 준비 완료"가 보이면 Claude에서 `list_projects`를 호출했을 때 `kind: "headless"` 탭이 나옵니다.

| 작업 | 명령 |
|---|---|
| 상태 / 로그 | `systemctl status godot-headless-editor` / `journalctl -u godot-headless-editor -f` |
| 끄기 / 켜기 | `sudo systemctl stop godot-headless-editor` / `sudo systemctl start godot-headless-editor` |
| 부팅 시 자동 시작 끄기 | `sudo systemctl disable godot-headless-editor` |
| 업데이트 후 | `cd ~/godot-web-editor/mcp-server/headless && npm ci && sudo systemctl restart godot-headless-editor` |
| PC 에디터에 양보하지 않기 | `.env`에 `HEADLESS_YIELD_TO_BROWSER=0` (권장하지 않음) |
| 다시 켜기까지 대기 시간 | `.env`에 `HEADLESS_RESUME_AFTER_SEC=60` |

로그에 "MCP 중계 서버에 연결되지 않습니다"가 계속 나오면 `.env`에서 `HEADLESS_EDITOR_URL`, `HEADLESS_RELAY_URL` 줄을 지우고(기본값 사용)
두 서비스를 재시작하세요: `sudo systemctl restart godot-mcp-relay godot-headless-editor`

## 9. (선택) 서버 전원: GitHub Actions로 켜기/끄기, 사용 없을 때 자동 종료

Paperspace 기계를 쓸 때만 켜 두어 비용을 줄입니다.

### 서버 쪽 설정
`.env`에 Paperspace API 키를 넣습니다(`npm run init`을 다시 실행해도 됩니다). 기계 ID를 비워 두면 Paperspace 기계의 호스트 이름(`ps...`)을 씁니다.

```bash
nano ~/godot-web-editor/mcp-server/.env
```

```
PAPERSPACE_API_KEY=<Paperspace API 키>
PAPERSPACE_MACHINE_ID=<기계 ID, 예: psl1hbkqfu1u>
```

```bash
sudo systemctl restart godot-mcp-relay
```

로그에 `서버 전원: Paperspace 연결됨 (기계 ...)`이 나오면 됩니다.

### 자동 종료
일정 시간 **사용이 없으면** 열린 에디터의 변경을 GitHub에 저장한 뒤 기계를 끕니다. 기본은 꺼져 있습니다.
"사용" = MCP 도구 호출(상태 조회 제외), PC 웹 에디터 연결, SSH 로그인. 서버의 헤드리스 에디터는 사용으로 치지 않습니다.

켜고 끄는 방법 (설정은 서버의 `data/power.json`에 저장되어 재시작 후에도 유지):
- **Claude에게**: "자동 종료 2시간으로 켜 줘" / "자동 종료 꺼 줘" / "서버 전원 상태 알려 줘" (`set_auto_stop`, `get_server_power` 도구)
- **GitHub Actions**: 아래 워크플로의 `auto-stop-on`(분 입력) / `auto-stop-off`
- **서버에서**: `curl -s -X POST -H "Authorization: Bearer $(grep ^CLI_TOKEN= ~/godot-web-editor/mcp-server/.env | cut -d= -f2)" -H 'Content-Type: application/json' -d '{"auto_stop":true,"idle_minutes":120}' http://127.0.0.1:8787/api/power`

Claude에게 "서버 꺼 줘"라고 하면 `stop_server` 도구로 바로 끌 수도 있습니다. 끈 뒤에는 Claude가 다시 켤 수 없으니 아래 워크플로로 켜세요.

Paperspace API 키는 콘솔의 **Team settings → API Keys**에서 만들고, 표시되는 값을 **전부** 복사하세요(앞뒤 공백 없이).

### GitHub Actions 워크플로 (비공개 저장소 `godot-mcp-automation`)
`.github/workflows/server-power.yml` — 그 저장소(또는 GitHub 모바일 앱) → **Actions → 서버 전원 → Run workflow**

| 할 일 | 동작 |
|---|---|
| `status` | 기계 상태, 중계 서버 상태, 자동 종료 설정 |
| `start` | 켜고, 중계 서버와 에디터가 준비될 때까지 기다림 |
| `stop` | 열린 에디터의 변경을 저장한 뒤 끄고, 꺼질 때까지 기다림 |
| `auto-stop-on` / `auto-stop-off` | 자동 종료 켜기(분 입력) / 끄기 |

시크릿은 **Settings → Secrets and variables → Actions → Repository secrets**에 등록합니다 (Codespaces/Dependabot 탭이 아님).

| 이름 | 값 |
|---|---|
| `PAPERSPACE_API_KEY` | Paperspace API 키 |
| `PAPERSPACE_MACHINE_ID` | 기계 ID |
| `RELAY_CLI_TOKEN` | 중계 서버 `.env`의 `CLI_TOKEN` 값 (자동 종료 설정, 끄기 전 저장에 필요) |

## 보안 메모

- 서버는 `127.0.0.1`에서만 열리고, 외부 접속은 Tailscale Funnel을 통해서만 들어옵니다.
- `/mcp`는 OAuth 토큰이나 `CLI_TOKEN` 없이는 동작하지 않고, `/editor`는 페어링 토큰과 페이지 주소(Origin)를 검사합니다.
- 승인 화면 비밀번호는 5번 틀리면 15분 동안 잠깁니다.
- 비밀값이 새었다고 생각되면 위 표의 "비밀값 교체"와 "모든 Claude 연결 끊기"를 하세요.
