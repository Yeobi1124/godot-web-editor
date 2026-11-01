#!/usr/bin/env bash
# 부팅할 때 godot-web-editor를 자동으로 업데이트하는 systemd 서비스를 등록한다 (Ubuntu).
# 중계 서버(godot-mcp-relay)와 헤드리스 에디터보다 먼저 실행된다.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE=godot-update
NODE_DIR="$(dirname "$(command -v node)")"

sudo tee "/etc/systemd/system/${SERVICE}.service" >/dev/null <<UNIT
[Unit]
Description=Update godot-web-editor before the MCP relay starts
After=network-online.target
Wants=network-online.target
Before=godot-mcp-relay.service godot-headless-editor.service

[Service]
Type=oneshot
User=${USER}
WorkingDirectory=${DIR}
Environment=HOME=${HOME}
Environment=PATH=${NODE_DIR}:/usr/local/bin:/usr/bin:/bin
ExecStart=${DIR}/deploy/update.sh
TimeoutStartSec=900
RemainAfterExit=no

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE}"
echo "등록했습니다. 다음 부팅부터 자동으로 업데이트합니다."
echo "지금 바로 업데이트하려면: sudo systemctl start ${SERVICE} && sudo systemctl restart godot-mcp-relay godot-headless-editor"
echo "로그 보기: journalctl -u ${SERVICE} -n 30 --no-pager"
