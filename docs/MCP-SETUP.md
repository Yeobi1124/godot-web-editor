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

## 보안 메모

- 서버는 `127.0.0.1`에서만 열리고, 외부 접속은 Tailscale Funnel을 통해서만 들어옵니다.
- `/mcp`는 OAuth 토큰이나 `CLI_TOKEN` 없이는 동작하지 않고, `/editor`는 페어링 토큰과 페이지 주소(Origin)를 검사합니다.
- 승인 화면 비밀번호는 5번 틀리면 15분 동안 잠깁니다.
- 비밀값이 새었다고 생각되면 위 표의 "비밀값 교체"와 "모든 Claude 연결 끊기"를 하세요.
