// Модель SSH-ключей. Ключ определяется «токеном»: он одинаков в закрытой и открытой частях.
// Формат похож на настоящий, но это не криптография.
import { ALNUM, rng, hashStr } from '../core/rng.js';

export const KT = {
  ed25519: { name: 'ssh-ed25519', pre: 'AAAAC3NzaC1lZDI1NTE5AAAAI', bits: 256, label: 'ED25519' },
  rsa: { name: 'ssh-rsa', pre: 'AAAAB3NzaC1yc2EAAAADAQABAAABgQ', bits: 3072, label: 'RSA' },
  ecdsa: { name: 'ecdsa-sha2-nistp256', pre: 'AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBB', bits: 256, label: 'ECDSA' },
};

export const passHash = (p) => hashStr('kdf:' + p).toString(16);

export function privKey(type, token, comment, pass = '') {
  const payload = ['openssh-key-v1', 'bcrypt-' + (pass ? passHash(pass) : 'none'), type, token, comment].join('\x00');
  const b = btoa(payload);
  return '-----BEGIN OPENSSH PRIVATE KEY-----\n' + b.match(/.{1,70}/g).join('\n') + '\n-----END OPENSSH PRIVATE KEY-----\n';
}

export function parsePriv(s) {
  const m = /-----BEGIN OPENSSH PRIVATE KEY-----\s*\n([\s\S]*?)\n?-----END OPENSSH PRIVATE KEY-----/.exec(s || '');
  if (!m) return null;
  try {
    const f = atob(m[1].replace(/\s/g, '')).split('\x00');
    if (f[0] !== 'openssh-key-v1' || !KT[f[2]] || !f[3]) return null;
    return { type: f[2], token: f[3], comment: f[4] || '', ph: f[1].slice(7) };
  } catch {
    return null;
  }
}

export function parsePub(s) {
  const f = (s || '').trim().split(/\s+/);
  const type = Object.keys(KT).find((k) => KT[k].name === f[0]);
  if (!type || !f[1] || !f[1].startsWith(KT[type].pre)) return null;
  return { type, token: f[1].slice(KT[type].pre.length), comment: f.slice(2).join(' ') };
}

export const blob = (type, token) => KT[type].pre + token;
export const pubLine = (type, token, comment) => `${KT[type].name} ${blob(type, token)}${comment ? ' ' + comment : ''}`;

export function fingerprint(token) {
  const r = rng(hashStr(token));
  const B = ALNUM + '+/';
  let s = '';
  for (let i = 0; i < 43; i++) s += B[Math.floor(r() * 64)];
  return 'SHA256:' + s;
}

/** «Случайное искусство» ssh-keygen: путь «пьяного слона» по полю 17×9. */
export function randomart(token, label, bits) {
  const W = 17;
  const H = 9;
  const g = Array.from({ length: H }, () => Array(W).fill(0));
  let x = 8;
  let y = 4;
  const r = rng(hashStr(token) ^ 0x9e37);
  for (let i = 0; i < 64; i++) {
    const d = Math.floor(r() * 4);
    x = Math.max(0, Math.min(W - 1, x + (d & 1 ? 1 : -1)));
    y = Math.max(0, Math.min(H - 1, y + (d & 2 ? 1 : -1)));
    g[y][x]++;
  }
  const sym = ' .o+=*BOX@%&#/^';
  const rows = g.map(
    (row, yy) => '|' + row.map((c, xx) => (xx === x && yy === y ? 'E' : xx === 8 && yy === 4 ? 'S' : sym[Math.min(c, sym.length - 1)])).join('') + '|',
  );
  const top = `[${label} ${bits}]`;
  const pad = W - top.length;
  const head = '+' + '-'.repeat(Math.floor(pad / 2)) + top + '-'.repeat(Math.ceil(pad / 2)) + '+';
  return [head, ...rows, '+----[SHA256]-----+'].join('\n');
}
