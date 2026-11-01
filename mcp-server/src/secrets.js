import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (text) => createHash('sha256').update(String(text)).digest();
export const hashToken = (text) => sha256(text).toString('hex');

/** 길이와 상관없이 상수 시간으로 비교 */
export function safeEqual(a, b) {
  return timingSafeEqual(sha256(a ?? ''), sha256(b ?? ''));
}
