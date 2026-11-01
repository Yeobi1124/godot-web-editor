// 간단한 로그. 토큰/비밀번호는 절대 넘기지 말 것.
export const log = (...args) => console.log(new Date().toISOString(), ...args);
export const warn = (...args) => console.warn(new Date().toISOString(), 'WARN', ...args);
