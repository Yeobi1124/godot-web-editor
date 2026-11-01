// .gitignore의 흔한 패턴만 지원하는 간단한 매처 (부정 패턴 '!'은 무시)
// 항상 제외: Godot 캐시(.godot/), .git/, 구버전 .import/

const ALWAYS = ['.godot/', '.git/', '.import/'];

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return re;
}

function compile(line) {
  let p = line.trim();
  if (!p || p.startsWith('#') || p.startsWith('!')) return null;
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith('/') || p.slice(0, -1).includes('/');
  p = p.replace(/^\//, '');
  const body = globToRegex(p);
  const prefix = anchored ? '^' : '^(?:.*/)?';
  // 디렉터리 패턴은 그 아래 모든 파일과 일치, 파일 패턴은 같은 이름의 디렉터리 아래도 포함
  return new RegExp(`${prefix}${body}${dirOnly ? '/' : '(?:$|/)'}`);
}

export class IgnoreMatcher {
  constructor(gitignoreText = '') {
    this.rules = [...ALWAYS, ...gitignoreText.split(/\r?\n/)].map(compile).filter(Boolean);
  }

  ignores(path) {
    return this.rules.some((r) => r.test(path));
  }
}
