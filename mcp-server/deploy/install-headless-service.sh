#!/usr/bin/env bash
# 헤드리스 에디터 실행기를 systemd 서비스로 등록하고 시작한다 (Ubuntu).
# 먼저: cd mcp-server/headless && npm ci && npx playwright install --with-deps chromium
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
SERVICE=godot-headless-editor

[ -n "$NODE" ] || { echo "node를 찾을 수 없습니다." >&2; exit 1; }
[ -f "$DIR/.env" ] || { echo "$DIR/.env 가 없습니다. 먼저 'npm run init'을 실행하세요." >&2; exit 1; }
[ -d "$DIR/headless/node_modules/playwright" ] || { echo "먼저 'cd $DIR/headless && npm ci && npx playwright install --with-deps chromium'을 실행하세요." >&2; exit 1; }
grep -qE '^(DEFAULT_PROJECT|HEADLESS_PROJECT)=.+' "$DIR/.env" || { echo ".env에 DEFAULT_PROJECT가 없습니다. 'npm run init'에서 입력하세요." >&2; exit 1; }
grep -qE '^(GODOT_GITHUB_TOKEN|HEADLESS_GITHUB_TOKEN)=.+' "$DIR/.env" || { echo ".env에 GODOT_GITHUB_TOKEN이 없습니다. 'npm run init'에서 입력하세요." >&2; exit 1; }

sudo tee "/etc/systemd/system/${SERVICE}.service" >/dev/null <<UNIT
[Unit]
Description=Godot web editor (headless, for MCP)
After=network-online.target godot-mcp-relay.service
Wants=network-online.target
Requires=godot-mcp-relay.service

[Service]
Type=simple
User=${USER}
WorkingDirectory=${DIR}/headless
Environment=HOME=${HOME}
ExecStart=${NODE} runner.mjs
Restart=on-failure
RestartSec=10
RestartPreventExitStatus=2
TimeoutStopSec=45
# 종료 신호는 실행기에만 보내고(변경 저장 후 브라우저를 직접 닫음), 남은 프로세스는 시간 초과 후 정리
KillMode=mixed
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE}"
echo "시작했습니다. 처음에는 에디터를 내려받느라 1~2분 걸립니다."
echo "로그 보기: journalctl -u ${SERVICE} -f"
