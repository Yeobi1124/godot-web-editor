#!/usr/bin/env bash
# 부팅할 때(중계 서버/헤드리스 에디터보다 먼저) godot-web-editor를 최신 main으로 업데이트한다.
#
#  1. main에 새 커밋이 있으면 빨리 감기(fast-forward)로만 받는다
#     - 서버에서 직접 고친 파일이 있거나, 로컬 커밋이 있어 빨리 감기가 안 되면 건너뛴다
#  2. package-lock.json이 바뀐 폴더만 npm ci (헤드리스 쪽은 Chromium도 확인)
#  3. 새 버전의 중계 서버를 임시 포트로 띄워 정상 응답하는지 확인
#  4. 2~3이 실패하면 이전 버전으로 되돌린다
#  5. 결과를 mcp-server/data/update-state.json에 기록 (/healthz와 워크플로 start에 표시)
#
# 어떤 경우에도 0으로 끝난다: 업데이트가 안 되더라도 기존 코드로 서비스가 시작되어야 하기 때문.
# 수동 실행: mcp-server/deploy/update.sh (그 다음 서비스 재시작)
set -uo pipefail

MCP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$MCP_DIR/.." && pwd)"
BRANCH="${UPDATE_BRANCH:-main}"
STATE="$MCP_DIR/${DATA_DIR:-data}/update-state.json"
VERIFY_PORT="${UPDATE_VERIFY_PORT:-8797}"
NPM="${NPM:-npm}"
NPX="${NPX:-npx}"

log() { echo "[update] $*"; }

write_state() { # status from to message
  mkdir -p "$(dirname "$STATE")"
  printf '{"status":"%s","from":"%s","to":"%s","at":"%s","message":"%s"}\n' \
    "$1" "$2" "$3" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(echo "$4" | tr '"\\\n' "'/ ")" >"$STATE.tmp" && mv "$STATE.tmp" "$STATE"
}

finish() { # status from to message
  log "$4"
  write_state "$@"
  exit 0
}

cd "$REPO" || finish error "" "" "저장소 폴더를 찾을 수 없습니다: $REPO"
git rev-parse --git-dir >/dev/null 2>&1 || finish skipped "" "" "git 저장소가 아니라서 업데이트하지 않습니다."
OLD="$(git rev-parse HEAD)"
SHORT_OLD="$(git rev-parse --short HEAD)"

current="$(git symbolic-ref --short -q HEAD || echo detached)"
[ "$current" = "$BRANCH" ] || finish skipped "$SHORT_OLD" "$SHORT_OLD" "현재 브랜치가 '$current'라서 업데이트하지 않습니다 ($BRANCH 브랜치만 자동 업데이트)."
if ! git diff --quiet || ! git diff --cached --quiet; then
  finish skipped "$SHORT_OLD" "$SHORT_OLD" "서버에서 직접 고친 파일이 있어 업데이트하지 않습니다 (git status로 확인)."
fi

if ! timeout 90 git fetch --quiet origin "$BRANCH" 2>/tmp/godot-update-fetch.err; then
  finish skipped "$SHORT_OLD" "$SHORT_OLD" "GitHub에서 받지 못해 기존 버전으로 시작합니다: $(head -c 200 /tmp/godot-update-fetch.err)"
fi
NEW="$(git rev-parse FETCH_HEAD)"
SHORT_NEW="$(git rev-parse --short FETCH_HEAD)"
[ "$OLD" = "$NEW" ] && finish current "$SHORT_OLD" "$SHORT_OLD" "이미 최신입니다 ($SHORT_OLD)."
git merge-base --is-ancestor "$OLD" "$NEW" ||
  finish skipped "$SHORT_OLD" "$SHORT_OLD" "서버에 로컬 커밋이 있어 빨리 감기가 안 되므로 업데이트하지 않습니다."

log "업데이트: $SHORT_OLD -> $SHORT_NEW"
git merge --ff-only --quiet "$NEW" || finish error "$SHORT_OLD" "$SHORT_OLD" "빨리 감기 실패"

changed() { ! git diff --quiet "$1" "$2" -- "$3/package.json" "$3/package-lock.json"; }

install_deps() { # from to : 바뀐 폴더만 설치. 실패하면 1
  local from="$1" to="$2"
  if changed "$from" "$to" mcp-server; then
    log "mcp-server 의존성 설치 (npm ci)"
    (cd "$MCP_DIR" && "$NPM" ci --no-audit --no-fund) || return 1
  fi
  if [ -d "$MCP_DIR/headless/node_modules" ] && changed "$from" "$to" mcp-server/headless; then
    log "headless 의존성 설치 (npm ci, Chromium 확인)"
    (cd "$MCP_DIR/headless" && "$NPM" ci --no-audit --no-fund && "$NPX" playwright install chromium) || return 1
  fi
  return 0
}

verify() { # 새 버전의 중계 서버를 임시 포트로 띄워 /healthz 확인. 헤드리스 실행기는 문법만 확인
  node --check "$MCP_DIR/headless/runner.mjs" || return 1
  local pid ok=1
  (cd "$MCP_DIR" && PORT="$VERIFY_PORT" HOST=127.0.0.1 UPDATE_VERIFY=1 exec node src/server.js) >/tmp/godot-update-verify.log 2>&1 &
  pid=$!
  for _ in $(seq 1 30); do
    if curl -fsS -m 2 "http://127.0.0.1:$VERIFY_PORT/healthz" >/dev/null 2>&1; then
      ok=0
      break
    fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  [ "$ok" = 0 ] || log "새 버전 확인 실패: $(tail -c 400 /tmp/godot-update-verify.log | tr '\n' ' ')"
  return "$ok"
}

rollback() { # message
  log "되돌리기: $SHORT_NEW -> $SHORT_OLD ($1)"
  git reset --quiet --hard "$OLD"
  install_deps "$NEW" "$OLD" || log "되돌린 뒤 의존성 설치에도 실패했습니다. 수동 확인이 필요합니다."
  finish rolled_back "$SHORT_OLD" "$SHORT_NEW" "새 버전($SHORT_NEW)에 문제가 있어 이전 버전($SHORT_OLD)으로 되돌렸습니다: $1"
}

install_deps "$OLD" "$NEW" || rollback "의존성 설치 실패"
verify || rollback "새 버전의 중계 서버가 시작되지 않음"
finish updated "$SHORT_OLD" "$SHORT_NEW" "업데이트 완료: $SHORT_OLD -> $SHORT_NEW ($(git log --oneline -1 --format=%s "$NEW" | head -c 80))"
