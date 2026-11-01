#!/usr/bin/env bash
# godot-mcp-relay를 systemd 서비스로 등록하고 시작한다 (Ubuntu).
# 사용법: mcp-server/deploy/install-service.sh   (sudo 비밀번호를 물어볼 수 있음)
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
SERVICE=godot-mcp-relay

[ -n "$NODE" ] || { echo "node를 찾을 수 없습니다. Node.js 20 이상을 설치하세요." >&2; exit 1; }
[ -f "$DIR/.env" ] || { echo "$DIR/.env 가 없습니다. 먼저 'npm run init'을 실행하세요." >&2; exit 1; }
[ -d "$DIR/node_modules" ] || { echo "의존성이 없습니다. 먼저 'npm ci'를 실행하세요." >&2; exit 1; }

sudo tee "/etc/systemd/system/${SERVICE}.service" >/dev/null <<UNIT
[Unit]
Description=godot-mcp-relay (Godot web editor <-> Claude MCP)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${DIR}
ExecStart=${NODE} src/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE}"
sleep 1
systemctl --no-pager --lines=5 status "${SERVICE}" || true
echo
echo "로그 보기: journalctl -u ${SERVICE} -f"
