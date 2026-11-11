// Состояние игры: кто вошёл, где, какой прогресс. Без DOM.
import { T } from '../i18n/ru.js';

/** Блоки уровней. prefix — имя пользователя уровня, max — номер последнего уровня. */
export const BLOCKS = {
  basic: { name: T.blocks.basic, prefix: 'level', max: 15 },
  net: { name: T.blocks.net, prefix: 'net', max: 9 },
  ssh: { name: T.blocks.ssh, prefix: 'key', max: 8 },
};
export const BLOCK_ORDER = ['basic', 'net', 'ssh'];

/** level7 → { block: 'basic', n: 7 } */
export function meta(user) {
  for (const id of BLOCK_ORDER) {
    const b = BLOCKS[id];
    const m = new RegExp(`^${b.prefix}(\\d+)$`).exec(user || '');
    if (m && +m[1] <= b.max) return { block: id, n: +m[1] };
  }
  return null;
}
export const userOf = (block, n) => BLOCKS[block].prefix + n;

export const S = {
  user: null, // текущий пользователь сессии (root в лаборатории)
  host: null, // текущий хост
  cwd: '/',
  cur: 'level0', // уровень, который сейчас проходят (имя пользователя уровня)
  u: { basic: 0, net: 0, ssh: 0 }, // максимальный открытый уровень в каждом блоке
  view: 'basic', // блок, показанный в ряду уровней
  stack: [], // вложенные SSH-сессии
  hist: [],
  hi: 0,
  ask: null, // открытый вопрос (пароль, yes/no)
  busy: false,
  status: 0, // код возврата последней команды ($?)
};

export const HOME = () =>
  S.user === 'root' ? '/root' : S.user ? '/home/' + S.user : '/home/you';

/* ---------- сохранение прогресса ---------- */
const KEY = 'shellpath:v3';
const store = () => {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
};

function applySaved(v) {
  if (!v || typeof v !== 'object' || !v.u) return false;
  for (const id of BLOCK_ORDER) {
    const n = v.u[id] | 0;
    S.u[id] = Math.max(0, Math.min(n, BLOCKS[id].max));
  }
  const m = meta(v.cur);
  S.cur = m && m.n <= S.u[m.block] ? v.cur : 'level0';
  return true;
}

export function loadProgress() {
  const ls = store();
  if (!ls) return;
  try {
    const v3 = JSON.parse(ls.getItem(KEY) || 'null');
    if (applySaved(v3)) return;
    // Переход со старых версий: bandit* → level*
    const v2 = JSON.parse(ls.getItem('shellpath:v2') || 'null');
    if (v2 && v2.u) {
      applySaved({ u: { basic: v2.u.basic, net: v2.u.net, ssh: v2.u.ssh }, cur: String(v2.cur || '').replace(/^bandit/, 'level') });
      return;
    }
    const v1 = JSON.parse(ls.getItem('shellpath:v1') || 'null');
    if (v1 && Number.isInteger(v1.unlocked)) applySaved({ u: { basic: v1.unlocked }, cur: 'level' + (v1.level || 0) });
  } catch {
    /* повреждённое сохранение — начинаем заново */
  }
}

export function saveProgress() {
  const ls = store();
  if (!ls) return;
  try {
    ls.setItem(KEY, JSON.stringify({ u: S.u, cur: S.cur }));
  } catch {
    /* хранилище недоступно — прогресс живёт до закрытия вкладки */
  }
}

/** Код прогресса для переноса между браузерами. */
export function exportProgress() {
  return 'SP1.' + btoa(JSON.stringify({ u: S.u, cur: S.cur }));
}

export function importProgress(code) {
  const m = /^SP1\.([A-Za-z0-9+/=]+)$/.exec(String(code).trim());
  if (!m) return false;
  try {
    if (!applySaved(JSON.parse(atob(m[1])))) return false;
  } catch {
    return false;
  }
  saveProgress();
  return true;
}

export function resetProgress() {
  S.u = { basic: 0, net: 0, ssh: 0 };
  S.cur = 'level0';
  S.hist = [];
  S.hi = 0;
  saveProgress();
}
