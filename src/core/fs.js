// Виртуальная файловая система с владельцами и правами rwx.
import { S, HOME } from './state.js';

/** Каталог. o — владелец, g — группа, m — права (как в chmod). */
export const D = (o = 'root', g = 'root', m = 0o755) => ({ t: 'd', c: {}, o, g, m });
/** Файл с содержимым d. */
export const F = (d, o = 'root', g = 'root', m = 0o644) => ({ t: 'f', d, o, g, m });

/**
 * FS.root — корень файловой системы текущей машины.
 * У основного мира (shellpath, vault…) одна ФС, у каждой машины лаборатории «Сеть» — своя.
 */
export const FS = { main: D(), root: null };
FS.root = FS.main;

export function put(path, node, root = FS.root) {
  const p = path.split('/').filter(Boolean);
  let cur = root;
  for (let i = 0; i < p.length - 1; i++) cur = cur.c[p[i]] || (cur.c[p[i]] = D());
  cur.c[p[p.length - 1]] = node;
  return node;
}

/** Может ли текущий пользователь: bit 4 — читать, 2 — писать, 1 — выполнять/входить. */
export function can(n, bit) {
  const u = S.user;
  if (u === 'root') return true;
  if (n.o === u) return (n.m >> 6) & bit;
  if (n.g === u) return (n.m >> 3) & bit;
  return n.m & bit;
}

/** Абсолютный путь: раскрывает ~, ., .. */
export function norm(p) {
  if (p === '~' || p.startsWith('~/')) p = HOME() + p.slice(1);
  if (!p.startsWith('/')) p = S.cwd + '/' + p;
  const out = [];
  for (const s of p.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return '/' + out.join('/');
}

/** Поиск узла с проверкой права входа в каталоги по пути. */
export function lookup(abs) {
  let cur = FS.root;
  for (const part of abs.split('/').filter(Boolean)) {
    if (cur.t !== 'd') return { err: 'Not a directory' };
    if (!can(cur, 1)) return { err: 'Permission denied' };
    cur = cur.c[part];
    if (!cur) return { err: 'No such file or directory' };
  }
  return { node: cur };
}

/** Поиск узла без проверки прав (для «системных» действий: sshd, загрузка машины). */
export function nodeIn(root, abs) {
  let c = root;
  for (const p of abs.split('/').filter(Boolean)) {
    if (!c || c.t !== 'd') return null;
    c = c.c[p];
  }
  return c || null;
}
export const sysNode = (abs) => nodeIn(FS.root, abs);
export const readIn = (root, abs) => {
  const n = nodeIn(root, abs);
  return n && n.t === 'f' ? n.d : null;
};
export const sysRead = (abs) => readIn(FS.root, abs);
export const parentDir = (abs) => {
  const i = abs.lastIndexOf('/');
  return { dirPath: abs.slice(0, i) || '/', name: abs.slice(i + 1) };
};
export function deleteIn(root, abs) {
  const { dirPath, name } = parentDir(abs);
  const d = nodeIn(root, dirPath);
  if (d && d.c) delete d.c[name];
}
export function writeIn(root, abs, data) {
  const n = nodeIn(root, abs);
  if (n && n.t === 'f') n.d = data;
  else put(abs, F(data), root);
}

export const sizeOf = (n) => (n.t === 'd' ? 4096 : n.d.length);
export const isText = (s) => !/[^\x09\x0a\x0d\x20-\x7eЀ-ӿ]/.test(s);
export const isBinary = (s) => /[\x00-\x08\x0e-\x1f]/.test(s);

/** Сортировка имён как в ls с локалью: без учёта регистра и ведущих точек и дефисов. */
export function cmpName(a, b) {
  const ka = a.replace(/^[.\-_ ]+/, '').toLowerCase();
  const kb = b.replace(/^[.\-_ ]+/, '').toLowerCase();
  return ka < kb ? -1 : ka > kb ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

export function readFile(arg, cmd) {
  const { node, err } = lookup(norm(arg));
  if (err) return { err: `${cmd}: ${arg}: ${err}\n` };
  if (node.t === 'd') return { err: `${cmd}: ${arg}: Is a directory\n` };
  if (!can(node, 4)) return { err: `${cmd}: ${arg}: Permission denied\n` };
  return { data: node.d };
}

/** Создать или перезаписать файл от имени текущего пользователя. Возвращает текст ошибки или ''. */
export function createOrWrite(abs, data, { append = false, mode = 0o644 } = {}) {
  if (abs === '/dev/null') return '';
  const { dirPath, name } = parentDir(abs);
  const L = lookup(dirPath);
  if (L.err) return L.err;
  if (L.node.t !== 'd') return 'Not a directory';
  const ex = L.node.c[name];
  if (ex) {
    if (ex.t === 'd') return 'Is a directory';
    if (!can(ex, 2)) return 'Permission denied';
    ex.d = append ? ex.d + data : data;
    return '';
  }
  if (!can(L.node, 2) || !can(L.node, 1)) return 'Permission denied';
  L.node.c[name] = F(data, S.user, S.user, mode);
  return '';
}

export function mkdirRaw(abs, mode = 0o755) {
  const { dirPath, name } = parentDir(abs);
  const L = lookup(dirPath);
  if (L.err) return L.err;
  if (L.node.t !== 'd') return 'Not a directory';
  if (!can(L.node, 2) || !can(L.node, 1)) return 'Permission denied';
  L.node.c[name] = D(S.user, S.user, mode);
  return '';
}

/** Можно ли удалить узел: право записи в каталог и правило sticky-бита. */
export function canDelete(abs) {
  const { dirPath } = parentDir(abs);
  const dir = sysNode(dirPath);
  const n = sysNode(abs);
  if (!dir || !can(dir, 2) || !can(dir, 1)) return false;
  if (dir.m & 0o1000 && n.o !== S.user && dir.o !== S.user) return false;
  return true;
}

export function globRe(g, flags = '') {
  const src = g
    .replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + src + '$', flags);
}

/** Раскрытие * и ? в последнем компоненте пути. Без совпадений — шаблон как есть. */
export function expandGlob(pat) {
  const i = pat.lastIndexOf('/');
  const dp = i >= 0 ? pat.slice(0, i + 1) : '';
  const bp = pat.slice(i + 1);
  if (/[*?]/.test(dp)) return [pat];
  const { node } = lookup(norm(dp || '.'));
  if (!node || node.t !== 'd' || !can(node, 4)) return [pat];
  const re = globRe(bp);
  const r = Object.keys(node.c)
    .filter((n) => (bp.startsWith('.') || !n.startsWith('.')) && re.test(n))
    .sort(cmpName)
    .map((n) => dp + n);
  return r.length ? r : [pat];
}

export function modeStr(n) {
  let s = n.t === 'd' ? 'd' : '-';
  for (const sh of [6, 3, 0]) {
    const b = (n.m >> sh) & 7;
    s += (b & 4 ? 'r' : '-') + (b & 2 ? 'w' : '-') + (b & 1 ? 'x' : '-');
  }
  if (n.m & 0o1000) s = s.slice(0, 9) + (s[9] === 'x' ? 't' : 'T');
  return s;
}
export const octal = (m) => '0' + (m & 0o777).toString(8).padStart(3, '0');

/* ---------- текстовые помощники ---------- */
export const lines = (t) => {
  const l = t.split('\n');
  if (l[l.length - 1] === '') l.pop();
  return l;
};
export const joinLines = (l) => (l.length ? l.join('\n') + '\n' : '');
export const quoteName = (n) => (/[\s'"]/.test(n) ? `'${n}'` : n);

/** Вход для команд вроде sort: файлы или стандартный ввод. none — данных нет вовсе. */
export function gather(files, ctx, cmd) {
  if (!files.length) return { text: ctx.stdin ?? '', none: ctx.stdin == null };
  let text = '';
  let err = '';
  for (const f of files) {
    if (f === '-') {
      text += ctx.stdin ?? '';
      continue;
    }
    const r = readFile(f, cmd);
    if (r.err) err += r.err;
    else text += r.data;
  }
  return { text, err };
}
