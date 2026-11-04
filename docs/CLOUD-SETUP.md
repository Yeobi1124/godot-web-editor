# 클라우드 버전 설정 (Cloudflare Worker + GitHub App)

웹 에디터를 Cloudflare Worker 한 곳에서 제공한다. 사용자는 **"GitHub로 로그인"만** 하면 된다.
- 토큰 붙여 넣기, 서버 주소 입력이 없다.
- GitHub 토큰은 Worker에만 보관되고 브라우저에는 저장되지 않는다.

> 포함된 것: 웹 에디터, GitHub 로그인, GitHub 동기화, **MCP(Claude 연결)**와 열린 에디터 실시간 조종.
> 아직 없는 것: Godot 실행기(테스트 실행, 게임 화면 캡처).
> GitHub Pages 배포는 내렸다. 예전 MCP 중계 서버는 Pages 에디터에 의존해서 지금은 동작하지 않는다(MCP 단계에서 대체).

## 구조
```
브라우저 ──(같은 주소, 세션 쿠키)──> Cloudflare Worker (worker/)
  /                  웹 에디터 정적 파일 (dist-worker/, COOP/COEP 헤더 포함)
  /godot.editor.wasm 엔진 조각 4개를 이어 붙여 전송 (정적 파일 25MiB 제한 때문에 나눠 둠)
  /auth/*            GitHub App 사용자 로그인 (OAuth)
  /api/me, /api/repos 로그인 사용자, 앱이 설치된 저장소 목록
  /gh/*              GitHub API 대리 호출 (에디터가 쓰는 경로만 허용, 사용자 토큰을 붙임)
  /mcp               MCP 엔드포인트 (Claude가 호출)
  /oauth/*, /.well-known/oauth-*  Claude 연결용 로그인 (OAuth 2.1, 동적 등록, PKCE) → GitHub 로그인
  /live              웹 에디터 탭의 WebSocket (로그인 쿠키)
Session Durable Object  사용자 토큰 보관, 만료 전 자동 갱신 (브라우저 로그인 1개, Claude 연결 1개마다)
Hub Durable Object      사용자별. 열린 에디터 탭을 들고 Claude의 도구 호출을 전달
```

Claude의 도구 호출은 이렇게 처리된다.
1. 그 사용자의 웹 에디터 탭이 열려 있으면 탭으로 보낸다. 변경이 에디터에 바로 보이고, 에디터 자동 저장이 커밋한다.
2. 탭이 없으면(휴대폰 등) 파일 도구는 GitHub에 바로 커밋한다.
3. 스크린샷, 게임 실행처럼 에디터가 꼭 필요한 도구는 "에디터를 여세요"라고 안내한다.

어느 경우든 커밋 작성자는 로그인한 사용자 본인이다.

- 커밋 작성자는 로그인한 사용자 본인이다.
- 저장소 접근 범위는 "사용자의 권한 ∩ 앱이 설치된 저장소"이고, GitHub가 직접 검사한다.
- 비용: Cloudflare 무료 플랜으로 충분하다 (하루 10만 요청). 한도를 넘으면 요청이 거절될 뿐 요금이 청구되지 않는다.

## 처음 한 번 설정

### 1. Cloudflare
1. https://dash.cloudflare.com 에서 가입한다.
2. **Workers & Pages**를 한 번 열어 `workers.dev` 하위 도메인을 정한다. 예: `yeobi`
3. 오른쪽에 보이는 **Account ID**를 복사한다.
4. My Profile → API Tokens → **Create Token** → 템플릿 **Edit Cloudflare Workers**로 토큰을 만든다.

### 2. godot-web-editor 저장소에 Cloudflare 값 넣기
Settings → Secrets and variables → Actions → **Secrets**
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

이 상태로 Actions → **클라우드 Worker** → Run workflow(main)를 실행하면 첫 배포가 된다.
- 주소: `https://godotweb.<하위도메인>.workers.dev` (Worker 이름은 `worker/wrangler.toml`의 `name`)
- 아직 로그인은 되지 않는다. 다음 단계에서 GitHub App을 만들면 된다.

### 3. GitHub App 만들기
GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**

| 항목 | 값 |
|---|---|
| GitHub App name | 원하는 이름 (예: `yeobi-godot-editor`). 주소에 쓰이는 이름이 **slug** |
| Homepage URL | Worker 주소 |
| Callback URL | `Worker주소/auth/callback` |
| Expire user authorization tokens | **켬** (8시간 토큰 + 자동 갱신) |
| Request user authorization (OAuth) during installation | **켬** (설치하면서 바로 로그인) |
| Webhook → Active | **끔** (이번 단계에서는 쓰지 않음) |
| Repository permissions → Contents | **Read and write** |
| Repository permissions → Metadata | Read-only (자동) |
| Where can this GitHub App be installed? | Only on this account (나만 쓸 때) |

만든 뒤 앱 화면에서 아래를 확인한다.
- 위쪽에 "You must generate a private key in order to install your GitHub App" 띠가 보이면 **Generate a private key**로 비공개 키(.pem)를 먼저 만든다.
  이 키가 있어야 앱을 설치할 수 있다. 내려받은 파일은 안전하게 보관한다(이번 단계에서는 쓰지 않음, MCP 단계에서 사용).
- **Client ID**를 복사한다.
- **Generate a new client secret**을 눌러 비밀값을 만든다. 한 번만 보이므로 바로 복사한다.

### 4. 앱 값 넣고 다시 배포
godot-web-editor → Settings → Secrets and variables → Actions
- **Secrets:** `GH_APP_CLIENT_SECRET` = client secret
- **Variables:** `GH_APP_CLIENT_ID` = Client ID, `GH_APP_SLUG` = 앱 slug

(GitHub는 `GITHUB_`로 시작하는 이름을 허용하지 않아서 `GH_APP_` 접두사를 쓴다.)

그다음 Actions → **클라우드 Worker** → Run workflow를 실행한다. 이후에는 main에 push할 때마다 자동으로 배포된다.

### 5. 앱 설치
- 앱 화면 → **Install App** → 내 계정 → 쓸 저장소를 고른다 ("All repositories"도 가능).
- 나중에 저장소를 추가하려면 에디터의 프로젝트 선택 화면에 있는 "GitHub에서 앱에 저장소 추가/변경" 링크를 쓴다.

## 사용
1. Worker 주소를 연다. 데스크톱 Chrome이나 Edge를 쓴다.
2. **GitHub로 로그인**을 누른다.
3. 프로젝트를 고른다. 마지막에 연 프로젝트는 다음부터 바로 열린다.
4. 다른 프로젝트로 바꾸려면 설정 → **다른 저장소 연결**을 누른다.

## Claude 연결 (MCP)
서버 쪽 추가 설정은 없다. GitHub App의 Callback URL(`/auth/callback`)을 그대로 쓴다.

**claude.ai (웹, 데스크톱, 휴대폰 앱)**
1. claude.ai → 설정 → **커넥터** → **커스텀 커넥터 추가**
2. 주소: `https://godotweb.<하위도메인>.workers.dev/mcp`
3. **연결**을 누르면 승인 화면이 나온다. **허용** → GitHub 로그인(이미 로그인했으면 바로 넘어감) → 연결 완료.
4. 대화에서 "godot-test에 ... 만들어 줘"처럼 요청한다. 대상 프로젝트는 열린 에디터, 없으면 마지막으로 연 프로젝트다. `project` 인자나 `list_projects`로 바꿀 수 있다.

**Claude Code**
```bash
claude mcp add --transport http godot https://godotweb.<하위도메인>.workers.dev/mcp
```
그다음 Claude Code에서 `/mcp` → godot → 인증을 고르면 브라우저에서 같은 승인 화면이 열린다.

연결은 30일 동안 쓰지 않으면 만료된다(쓰는 동안은 자동 갱신). 만료되거나 GitHub 로그인이 끝나면 커넥터를 다시 연결한다.

## 로컬 개발과 테스트
```bash
scripts/build-worker.sh           # dist-worker/ 빌드 (Godot 웹 에디터 zip은 .cache/에 보관)
cd worker && npm ci
npm test                          # Worker 통합 테스트: wrangler dev + 가짜 GitHub(OAuth 포함), MCP 인가·도구·탭 중계
cd .. && node tests/e2e-cloud.mjs # 브라우저 e2e: 로그인 → 에디터 → 자동 커밋 → 토큰 갱신 → MCP로 에디터 조종 → 로그아웃
```

`wrangler dev`를 직접 띄울 때는 아래처럼 실행한다.
```bash
wrangler dev --var GITHUB_CLIENT_ID:... --var GITHUB_CLIENT_SECRET:...
```
GitHub App의 Callback URL에 `http://localhost:8787/auth/callback`도 추가해 두어야 한다.

## 문제 해결
| 증상 | 확인할 것 |
|---|---|
| 로그인하면 "GitHub App 설정이 없습니다" | `GH_APP_CLIENT_ID`(Variables), `GH_APP_CLIENT_SECRET`(Secrets)을 넣은 뒤 다시 배포했는지 |
| GitHub에서 "redirect_uri is not associated" | 앱의 Callback URL이 `Worker주소/auth/callback`과 정확히 같은지 |
| 프로젝트 목록이 비어 있음 | 앱을 설치했는지, 그 저장소를 선택했는지. 링크로 추가한 뒤 "목록 새로고침" |
| 저장 중 "로그인이 만료되었습니다" | 다시 로그인한다. 올라가지 않은 변경은 브라우저에 남아 있다가 로그인 후 올라간다 |
| 에디터가 "내려받는 중"에서 멈춤 | 강력 새로고침(Ctrl+Shift+R). 엔진 캐시(service worker)를 다시 받는다 |
| Claude가 "웹 에디터가 열려 있어야" 라고 함 | 그 도구(스크린샷, 실행 등)는 브라우저에 에디터가 열려 있어야 한다. 상단의 MCP 배지가 초록(연결됨)인지 확인 |
| Claude 연결이 갑자기 안 됨 | claude.ai 커넥터 설정에서 연결 해제 후 다시 연결 |

## 보안 메모
- 세션 쿠키: `__Host-` 접두사, `HttpOnly; Secure; SameSite=Lax`. 페이지 자바스크립트에서 읽을 수 없다.
- `/gh/*`는 Git Data API 일부와 빈 저장소의 첫 파일 쓰기만 허용한다. 저장소 설정 변경, 브랜치 삭제, 다른 API는 403이다.
- 상태를 바꾸는 요청에는 `X-GWE: 1` 헤더와 같은 Origin이 필요하다 (CSRF 방지).
- Claude에게 주는 토큰은 이 서버가 발급한 것(1시간 접근 토큰 + 30일 리프레시 토큰, 회전)이고, GitHub 토큰은 넘기지 않는다. 서버에는 해시만 저장한다.
- 동적 클라이언트 등록은 Claude 콜백(`claude.ai`, `claude.com`)과 로컬 루프백 주소만 허용한다. client_id는 서버 비밀값으로 서명해서 따로 저장하지 않는다.
- Claude의 도구 호출은 **같은 GitHub 사용자**의 에디터 탭에만 전달된다.
- refresh 토큰은 한 번만 쓸 수 있다. 갱신은 세션 Durable Object 안에서 한 번에 하나만 일어나서, 동시 요청이 와도 토큰을 잃지 않는다.
