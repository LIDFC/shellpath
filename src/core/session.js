// Сессии: вход на уровень, вложенные SSH-сессии, выход.
import { S, BLOCKS, meta, userOf, saveProgress } from './state.js';
import { FS, F, put } from './fs.js';
import { print, IO } from './io.js';
import { T } from '../i18n/ru.js';
import { LEVELS } from '../levels/index.js';
import { LAB, newLab, OSNAME, KERNEL } from '../netsim/lab.js';

export const hostFor = (user) => {
  const m = meta(user);
  if (!m) return 'shellpath';
  return LEVELS[m.block][m.n].host || 'shellpath';
};

/** Уровень, который сейчас открыт (в лаборатории пользователь — root, поэтому смотрим S.cur). */
export const curMeta = () => meta(S.user) || meta(S.cur);

export function setFsForHost(host) {
  FS.root = LAB.hosts[host]?.fs || FS.main;
}

function unlock(block, n) {
  const isNew = n > S.u[block];
  if (isNew) S.u[block] = n;
  return isNew;
}

/** Вход в основном мире (блоки «Начальный» и SSH). push — вложенная SSH-сессия. */
export function login(user, host, { fresh = false, push = false } = {}) {
  if (push && S.user) S.stack.push({ user: S.user, host: S.host, cwd: S.cwd });
  if (!push) S.stack = [];
  const m = meta(user);
  const isNew = unlock(m.block, m.n);
  S.user = user;
  S.host = host;
  setFsForHost(host);
  S.cwd = '/home/' + user;
  S.cur = user;
  S.view = m.block;
  saveProgress();
  if (fresh) IO.clear();
  if (isNew) print(T.session.unlocked(m.n, BLOCKS[m.block].name), 'win');
  print(T.session.banner(host, BLOCKS[m.block].name, m.n, user), 'sys');
  print(m.n === BLOCKS[m.block].max ? T.session.lastLevel : T.session.hint, 'note');
  IO.refresh();
}

/** Вход в лабораторию блока «Сеть»: каждый раз собирается свежая сеть. */
export function loginLab(n, { fresh = false } = {}) {
  const L = LEVELS.net[n];
  newLab();
  if (L.setup) L.setup(LAB);
  const h = LAB.hosts[L.host];
  put('/root/readme', F(L.readme + '\n', 'root', 'root', 0o600), h.fs);
  S.stack = [];
  S.user = 'root';
  S.host = L.host;
  setFsForHost(L.host);
  S.cwd = '/root';
  S.cur = userOf('net', n);
  S.view = 'net';
  const isNew = unlock('net', n);
  saveProgress();
  if (fresh) IO.clear();
  if (isNew) print(T.session.unlocked(n, BLOCKS.net.name), 'win');
  print(T.session.labBanner(OSNAME, KERNEL, n, h.rt.hostname), 'sys');
  print(n === BLOCKS.net.max ? T.session.labLast : T.session.labHint, 'note');
  IO.refresh();
}

export function enterLevel(block, n, opts) {
  if (block === 'net') loginLab(n, opts);
  else {
    const u = userOf(block, n);
    login(u, hostFor(u), opts);
  }
}

export function doExit() {
  const lab = LAB.hosts[S.host];
  print('logout', 'sys');
  print(`Connection to ${lab && S.user === 'root' ? lab.rt.hostname.split('.')[0] : S.host} closed.`, 'sys');
  const prev = S.stack.pop();
  if (prev) {
    S.user = prev.user;
    S.host = prev.host;
    setFsForHost(prev.host);
    S.cwd = prev.cwd;
    S.cur = prev.user;
    saveProgress();
  } else {
    S.user = null;
    S.host = null;
    setFsForHost(null);
    S.cwd = '/home/you';
    print(meta(S.cur)?.block === 'net' ? T.session.backLab : T.session.backSsh(S.cur, hostFor(S.cur)), 'note');
  }
  IO.refresh();
}
