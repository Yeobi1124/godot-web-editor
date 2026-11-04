// GitHub App 자신으로 인증 (비공개 키 → JWT → 설치 토큰).
// 사람이 로그인하지 않은 상태에서 도는 일(GitHub Actions 실행기 호출)에만 쓴다.
// 토큰은 필요한 저장소 하나와 필요한 권한만 담아 1시간짜리로 받는다.
import { githubFetch } from './http.js';

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

function pemToDer(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function derLength(n) {
  if (n < 0x80) return [n];
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}
const der = (tag, content) => new Uint8Array([tag, ...derLength(content.length), ...content]);

/**
 * GitHub가 주는 키는 PKCS#1("BEGIN RSA PRIVATE KEY")인데 WebCrypto는 PKCS#8만 읽는다.
 * PKCS#8 = SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { PKCS#1 } }
 */
export function pkcs1ToPkcs8(pkcs1) {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const algorithm = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const key = der(0x04, pkcs1);
  return der(0x30, new Uint8Array([...version, ...algorithm, ...key]));
}

let cachedKey = null;
async function signingKey(env) {
  const pem = String(env.GITHUB_APP_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (cachedKey?.pem === pem) return cachedKey.key;
  const raw = pemToDer(pem);
  const pkcs8 = pem.includes('BEGIN RSA PRIVATE KEY') ? pkcs1ToPkcs8(raw) : raw;
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  cachedKey = { pem, key };
  return key;
}

export const appConfigured = (env) => !!(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);

/** 앱 JWT (10분 이내 유효, 시계 차이를 감안해 60초 앞당김) */
export async function appJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64urlJson({ alg: 'RS256', typ: 'JWT' });
  const payload = b64urlJson({ iat: now - 60, exp: now + 540, iss: String(env.GITHUB_APP_ID) });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await signingKey(env), new TextEncoder().encode(`${head}.${payload}`));
  return `${head}.${payload}.${b64url(sig)}`;
}

/** 저장소 하나에 대한 설치 토큰. permissions 예: { actions: 'write' } */
export async function installationToken(env, fullName, permissions) {
  const [owner, repo] = fullName.split('/');
  const jwt = await appJwt(env);
  const inst = await githubFetch(env, `/repos/${owner}/${repo}/installation`, { token: jwt });
  if (!inst.ok) {
    throw new Error(
      inst.status === 404
        ? `GitHub App이 ${fullName}에 설치되어 있지 않습니다. 앱 설치 설정에서 이 저장소를 추가하세요.`
        : `GitHub App 인증 실패 (${inst.status}). GITHUB_APP_ID와 비공개 키를 확인하세요.`,
    );
  }
  const { id } = await inst.json();
  const res = await githubFetch(env, `/app/installations/${id}/access_tokens`, {
    token: jwt,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repositories: [repo], permissions }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`설치 토큰을 받지 못했습니다 (${res.status}). 앱 권한(${Object.keys(permissions).join(', ')})을 확인하세요. ${detail.slice(0, 200)}`);
  }
  return (await res.json()).token;
}
