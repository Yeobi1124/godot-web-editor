// 프로젝트 기본 구성: 빈 저장소용 project.godot, 브리지 애드온 설치와 활성화

import { utf8Decode, utf8Encode } from './util.js';

export const BRIDGE_DIR = 'addons/web_editor_bridge';
export const BRIDGE_PLUGIN_CFG = `res://${BRIDGE_DIR}/plugin.cfg`;
const BRIDGE_FILES = ['plugin.cfg', 'plugin.gd'];

export function defaultProjectGodot(name) {
  const safe = String(name).replace(/["\\]/g, '');
  return `; Engine configuration file.
; It's best edited using the editor UI and not directly,
; since the parameters that go here are not all obvious.
;
; Format:
;   [section] ; section goes between []
;   param=value ; assign values to parameters

config_version=5

[application]

config/name="${safe}"
config/features=PackedStringArray("4.7", "GL Compatibility")

[rendering]

renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"
`;
}

/**
 * project.godot 텍스트에 [editor_plugins] enabled 항목으로 플러그인을 추가한다.
 * 이미 있으면 null(변경 없음)을 반환한다.
 */
export function ensurePluginEnabled(text, pluginCfg = BRIDGE_PLUGIN_CFG) {
  const lines = text.split('\n');
  const sectionIdx = lines.findIndex((l) => l.trim() === '[editor_plugins]');
  const entry = `"${pluginCfg}"`;
  if (sectionIdx === -1) {
    const trimmed = text.replace(/\n*$/, '');
    return `${trimmed}\n\n[editor_plugins]\n\nenabled=PackedStringArray(${entry})\n`;
  }
  let end = lines.length;
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    if (/^\s*\[.*\]\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  for (let i = sectionIdx + 1; i < end; i++) {
    const m = lines[i].match(/^(\s*enabled\s*=\s*PackedStringArray\()(.*)(\)\s*)$/);
    if (!m) continue;
    if (m[2].includes(entry)) return null;
    const inner = m[2].trim();
    lines[i] = `${m[1]}${inner ? `${inner}, ` : ''}${entry}${m[3]}`;
    return lines.join('\n');
  }
  lines.splice(sectionIdx + 1, 0, '', `enabled=PackedStringArray(${entry})`);
  return lines.join('\n');
}

/** 페이지와 함께 배포된 애드온 파일을 읽는다: [{ path, bytes }] */
export async function loadBundledBridge(baseUrl = 'addon/web_editor_bridge/') {
  return Promise.all(
    BRIDGE_FILES.map(async (f) => {
      const res = await fetch(baseUrl + f, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`애드온 파일을 불러오지 못했습니다: ${f}`);
      return { path: `${BRIDGE_DIR}/${f}`, bytes: new Uint8Array(await res.arrayBuffer()) };
    }),
  );
}

/**
 * 로컬 파일 상태(Map path -> {contents})를 보고 필요한 파일 변경 목록을 만든다.
 * - project.godot이 없으면 기본값 생성
 * - 브리지 애드온이 없거나 버전이 다르면 설치
 * - project.godot에서 애드온 활성화
 */
export function planScaffold(localFiles, { projectName, bridgeFiles, installBridge }) {
  const writes = [];
  const bytesOf = (path) => {
    const f = localFiles.get(path);
    return f ? (f.bytes ?? f.contents) : null;
  };
  const projectBytes = bytesOf('project.godot');
  let projectText = projectBytes ? utf8Decode(projectBytes) : null;
  if (projectText !== null && !/^\s*config_version\s*=/m.test(projectText)) {
    // 읽은 내용이 project.godot 같지 않으면 손대지 않는다 (덮어써서 설정을 잃는 사고 방지)
    throw new Error('project.godot 내용을 확인할 수 없어 프로젝트 구성을 중단했습니다.');
  }
  let projectChanged = false;
  if (projectText === null) {
    projectText = defaultProjectGodot(projectName);
    projectChanged = true;
  }
  if (installBridge) {
    for (const f of bridgeFiles) {
      const cur = bytesOf(f.path);
      if (!cur || utf8Decode(cur) !== utf8Decode(f.bytes)) writes.push(f);
    }
    const enabled = ensurePluginEnabled(projectText);
    if (enabled !== null) {
      projectText = enabled;
      projectChanged = true;
    }
  }
  if (projectChanged) writes.push({ path: 'project.godot', bytes: utf8Encode(projectText) });
  return writes;
}
