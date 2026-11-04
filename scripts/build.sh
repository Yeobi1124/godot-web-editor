#!/usr/bin/env bash
# dist/ 빌드: 공식 Godot 웹 에디터 파일 + 이 저장소의 web/ 파일
# 사용법: scripts/build.sh            (Godot zip은 .cache/에 보관해서 재사용)
set -euo pipefail

GODOT_VERSION="4.7.2"
GODOT_ZIP_SHA256="5e6904f3b8b6ac642a3ad3893396427c3a31581e5345a3fdc93b3c64575232a4"
APP_VERSION="0.1.0"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$ROOT/.cache"
DIST="$ROOT/dist"
ZIP="$CACHE/Godot_v${GODOT_VERSION}-stable_web_editor.zip"
URL="https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}-stable/Godot_v${GODOT_VERSION}-stable_web_editor.zip"

mkdir -p "$CACHE"
if [ ! -f "$ZIP" ] || ! echo "$GODOT_ZIP_SHA256  $ZIP" | sha256sum -c --quiet - 2>/dev/null; then
  echo "Godot ${GODOT_VERSION} 웹 에디터 내려받는 중..."
  curl -fL --retry 3 -o "$ZIP.part" "$URL"
  mv "$ZIP.part" "$ZIP"
fi
echo "$GODOT_ZIP_SHA256  $ZIP" | sha256sum -c --quiet - || { echo "체크섬이 다릅니다: $ZIP" >&2; exit 1; }

rm -rf "$DIST"
mkdir -p "$DIST"
# 필요한 엔진 파일만 꺼낸다 (공식 HTML, 매니페스트, 공식 service worker는 쓰지 않음)
unzip -q -o "$ZIP" \
  godot.editor.js godot.editor.wasm godot.editor.audio.worklet.js godot.editor.audio.position.worklet.js favicon.png \
  -d "$DIST"
cp -r "$ROOT/web/." "$DIST/"

COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)"
BUILD_ID="${GODOT_VERSION}-${APP_VERSION}-${COMMIT}"
sed -i "s/__BUILD_ID__/${BUILD_ID}/" "$DIST/sw.js"
WASM_SIZE="$(stat -c %s "$DIST/godot.editor.wasm")"
printf '{"app":"%s","godot":"%s","commit":"%s","wasmSize":%s}\n' "$APP_VERSION" "$GODOT_VERSION" "$COMMIT" "$WASM_SIZE" > "$DIST/build-info.json"
touch "$DIST/.nojekyll"
echo "빌드 완료: $DIST (build $BUILD_ID)"
