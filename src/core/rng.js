// Детерминированный генератор: одинаковые пароли и данные у всех игроков.

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Строка из алфавита ALNUM заданной длины. */
export function randStr(r, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALNUM[Math.floor(r() * 62)];
  return s;
}

export const genPw = (r) => randStr(r, 32);
export const genToken = (r) => randStr(r, 43);

/** FNV-1a: быстрый хеш строки в 32-битное число. */
export function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (const c of s) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

export function shuffle(a, r) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
