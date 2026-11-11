// Мир блока SSH: какие хосты есть, на каких портах, кого пускают и как.
import { genToken } from '../core/rng.js';
import { meta } from '../core/state.js';
import { PW, PK, SSH_TOKEN_RNG } from './base.js';

/** Токены ключей: kN — ключ для входа как keyN, h* — ключи хостов. */
export const TOK = {};
for (const k of ['k1', 'k2', 'k5', 'k6', 'k7', 'admin', 'hvault', 'hbackup', 'hbackupOld', 'hgate', 'hinner']) TOK[k] = genToken(SSH_TOKEN_RNG);

export const LOCALNAMES = ['localhost', '127.0.0.1', '::1'];

/** only — с каких хостов сервер доступен (файрвол). */
export const HOSTS = {
  shellpath: { ports: [22], ip: '10.0.0.10' },
  vault: { ports: [2202], ip: '10.0.0.21' },
  backup: { ports: [22], ip: '10.0.0.22' },
  gate: { ports: [22], ip: '10.0.0.5' },
  inner: { ports: [22], ip: '10.0.1.7', only: ['gate', 'inner'] },
};

export const HOSTKEY = { vault: TOK.hvault, backup: TOK.hbackup, gate: TOK.hgate, inner: TOK.hinner };

/** Кого пускает каждый хост. */
export const ALLOW = {
  shellpath: (u) => /^level\d+$/.test(u) || ['key0', 'key1', 'key2', 'key4'].includes(u),
  vault: (u) => u === 'key3' || u === 'key5',
  backup: (u) => u === 'key6',
  gate: (u) => u === 'key6',
  inner: (u) => u === 'key7' || u === 'key8',
};

/** Кому разрешён вход по паролю. Остальным — только по ключу. */
export const PASSWORD_OK = (u) => /^level\d+$/.test(u) || ['key0', 'key1', 'key2', 'key3', 'key8'].includes(u);

export function passOf(user) {
  const m = meta(user);
  if (!m) return null;
  return m.block === 'basic' ? PW[m.n] : m.block === 'ssh' ? PK[m.n] : null;
}

/** Правила уровней, которые нельзя выразить сетью: ({ user, host, viaConfig }) → текст отказа или null. */
export const SSH_RULES = [];

/** localhost — это текущий хост. Вне сервера (после exit) — shellpath. */
export function resolveSshHost(name, from) {
  if (LOCALNAMES.includes(name)) return from === 'local' ? 'shellpath' : from;
  return HOSTS[name] ? name : null;
}
