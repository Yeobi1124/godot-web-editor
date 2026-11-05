#!/usr/bin/env bash
# dist-worker/ 빌드: Cloudflare Worker(클라우드 버전)용 정적 파일
#   - dist/ 를 빌드해서 복사
#   - 엔진 wasm(약 100MB)을 24MiB 조각으로 나눔 (Workers 정적 파일은 파일당 25MiB 제한).
#     Worker가 /godot.editor.wasm 요청에 조각을 이어 붙여 보낸다 (worker/src/engine.js)
#   - 모든 정적 파일에 COOP/COEP 헤더 (_headers)
#   - build-info.json에 "mode":"cloud" → 페이지가 GitHub 로그인 방식으로 동작
# 사용법: scripts/build-worker.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
OUT="$ROOT/dist-worker"
PART_BYTES=$((24 * 1024 * 1024))

"$ROOT/scripts/build.sh"

rm -rf "$OUT"
mkdir -p "$OUT/engine"
cp -r "$DIST/." "$OUT/"
rm -f "$OUT/godot.editor.wasm" "$OUT/.nojekyll"

WASM="$DIST/godot.editor.wasm"
# 조각 이름은 .wasm으로 끝나게 한다 (godot.editor.0.wasm …): Content-Type이 application/wasm이 되어 Cloudflare가 압축해서 보낸다
split -b "$PART_BYTES" -d -a 1 "$WASM" "$OUT/engine/part."
for f in "$OUT"/engine/part.*; do mv "$f" "$OUT/engine/godot.editor.${f##*.}.wasm"; done
PARTS="$(cd "$OUT/engine" && ls godot.editor.*.wasm | sort -V | sed 's/.*/"&"/' | paste -sd, -)"
SIZE="$(stat -c %s "$WASM")"
SHA="$(sha256sum "$WASM" | cut -d' ' -f1)"
# 엔진 조각 미러 (선택): ENGINE_MIRROR=https://<사용자>.github.io/<저장소>/ 이면 브라우저가 그곳에서 먼저 받는다.
# 경로에 엔진 해시를 넣어 버전이 섞이지 않게 한다. 미러에 올릴 파일은 dist-mirror/ 에 만든다.
MIRRORS=""
if [ -n "${ENGINE_MIRROR:-}" ]; then
  MIRRORS=",\"mirrors\":[\"${ENGINE_MIRROR%/}/engine/${SHA}/\"]"
fi
printf '{"size":%s,"sha256":"%s","parts":[%s]%s}\n' "$SIZE" "$SHA" "$PARTS" "$MIRRORS" > "$OUT/engine/wasm-manifest.json"
MIRROR_OUT="$ROOT/dist-mirror"
rm -rf "$MIRROR_OUT"
mkdir -p "$MIRROR_OUT/engine/$SHA"
cp "$OUT"/engine/godot.editor.*.wasm "$MIRROR_OUT/engine/$SHA/"
touch "$MIRROR_OUT/.nojekyll"
printf '<!doctype html><meta charset="utf-8"><title>Godot 엔진 파일</title><p>웹 에디터가 쓰는 Godot 엔진 파일 미러입니다. 에디터 주소는 따로 있습니다.</p>\n' > "$MIRROR_OUT/index.html"

# 조각을 다시 이어 붙였을 때 원본과 같은지 확인
[ "$(cd "$OUT/engine" && cat $(ls godot.editor.*.wasm | sort -V) | sha256sum | cut -d' ' -f1)" = "$SHA" ] || { echo "엔진 조각 검증 실패" >&2; exit 1; }

python3 - "$OUT/build-info.json" <<'PY'
import json, sys
p = sys.argv[1]
info = json.load(open(p))
info["mode"] = "cloud"
json.dump(info, open(p, "w"))
PY

cat > "$OUT/_headers" <<'H'
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
H

echo "Worker용 빌드 완료: $OUT (엔진 조각 $(echo "$PARTS" | tr ',' '\n' | wc -l)개, $SIZE 바이트)"
