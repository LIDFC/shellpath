// Команды, которые меняют файлы, и редактор nano.
import { register } from './registry.js';
import { S } from '../core/state.js';
import { IO } from '../core/io.js';
import { T } from '../i18n/ru.js';
import {
  lookup, norm, can, createOrWrite, mkdirRaw, canDelete, sysNode, parentDir, lines,
} from '../core/fs.js';

register('touch', (args) => {
  const files = args.filter((a) => !a.startsWith('-'));
  if (!files.length) return { err: 'touch: missing file operand\n', code: 1 };
  let err = '';
  for (const f of files) {
    const abs = norm(f);
    if (lookup(abs).node) continue;
    const e = createOrWrite(abs, '');
    if (e) err += `touch: cannot touch '${f}': ${e}\n`;
  }
  return { err, code: err ? 1 : 0 };
});

register('mkdir', (args) => {
  let parents = false;
  let mode = 0o755;
  const dirs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-p') parents = true;
    else if (a === '-m') mode = parseInt(args[++i], 8) || 0o755;
    else if (!a.startsWith('-')) dirs.push(a);
  }
  if (!dirs.length) return { err: 'mkdir: missing operand\n', code: 1 };
  let err = '';
  for (const d of dirs) {
    const abs = norm(d);
    if (parents) {
      let cur = '';
      for (const part of abs.split('/').filter(Boolean)) {
        cur += '/' + part;
        const L = lookup(cur);
        if (L.node) {
          if (L.node.t !== 'd') {
            err += `mkdir: cannot create directory '${d}': Not a directory\n`;
            break;
          }
          continue;
        }
        const e = mkdirRaw(cur, mode);
        if (e) {
          err += `mkdir: cannot create directory '${d}': ${e}\n`;
          break;
        }
      }
    } else {
      if (lookup(abs).node) {
        err += `mkdir: cannot create directory '${d}': File exists\n`;
        continue;
      }
      const e = mkdirRaw(abs, mode);
      if (e) err += `mkdir: cannot create directory '${d}': ${e}\n`;
    }
  }
  return { err, code: err ? 1 : 0 };
});

/** Права: восьмерично (600) или символьно (u+x, go-rwx). null — ошибка. */
export function applyMode(cur, spec) {
  if (/^[0-7]{1,4}$/.test(spec)) return parseInt(spec, 8);
  let m = cur;
  for (const cl of spec.split(',')) {
    const r = /^([ugoa]*)([+\-=])([rwxt]*)$/.exec(cl);
    if (!r) return null;
    const who = r[1] || 'a';
    let bits = 0;
    let mask = 0;
    for (const w of who) {
      const shifts = w === 'u' ? [6] : w === 'g' ? [3] : w === 'o' ? [0] : [6, 3, 0];
      for (const s of shifts) {
        mask |= 7 << s;
        for (const p of r[3]) {
          const b = { r: 4, w: 2, x: 1 }[p];
          if (b) bits |= b << s;
        }
      }
    }
    if (r[2] === '+') m |= bits;
    else if (r[2] === '-') m &= ~bits;
    else m = (m & ~mask) | bits;
  }
  return m;
}

register('chmod', (args) => {
  const rest = args.filter((a) => !/^-[Rvf]+$/.test(a));
  const mode = rest[0];
  const files = rest.slice(1);
  if (!mode) return { err: 'chmod: missing operand\n', code: 1 };
  if (!files.length) return { err: `chmod: missing operand after '${mode}'\n`, code: 1 };
  let err = '';
  for (const f of files) {
    const L = lookup(norm(f));
    if (L.err) {
      err += `chmod: cannot access '${f}': ${L.err}\n`;
      continue;
    }
    if (L.node.o !== S.user && S.user !== 'root') {
      err += `chmod: changing permissions of '${f}': Operation not permitted\n`;
      continue;
    }
    const m = applyMode(L.node.m, mode);
    if (m === null) return { err: `chmod: invalid mode: '${mode}'\n`, code: 1 };
    L.node.m = m;
  }
  return { err, code: err ? 1 : 0 };
});

register('rm', (args) => {
  let rec = false;
  let force = false;
  const files = [];
  for (const a of args) {
    if (/^-[rRfvi]+$/.test(a)) {
      if (/[rR]/.test(a)) rec = true;
      if (a.includes('f')) force = true;
    } else files.push(a);
  }
  if (!files.length) return { err: 'rm: missing operand\n', code: 1 };
  let err = '';
  for (const f of files) {
    const abs = norm(f);
    const L = lookup(abs);
    if (L.err) {
      if (!force) err += `rm: cannot remove '${f}': ${L.err}\n`;
      continue;
    }
    if (L.node.t === 'd' && !rec) {
      err += `rm: cannot remove '${f}': Is a directory\n`;
      continue;
    }
    if (!canDelete(abs)) {
      err += `rm: cannot remove '${f}': Permission denied\n`;
      continue;
    }
    const { dirPath, name } = parentDir(abs);
    delete sysNode(dirPath).c[name];
  }
  return { err, code: err ? 1 : 0 };
});

register('cp', (args) => {
  const p = args.filter((a) => !a.startsWith('-'));
  if (p.length < 2) {
    return { err: p.length ? `cp: missing destination file operand after '${p[0]}'\n` : 'cp: missing file operand\n', code: 1 };
  }
  const dst = p.pop();
  const dL = lookup(norm(dst));
  const toDir = dL.node && dL.node.t === 'd';
  if (p.length > 1 && !toDir) return { err: `cp: target '${dst}' is not a directory\n`, code: 1 };
  let err = '';
  for (const s of p) {
    const r = lookup(norm(s));
    if (r.err) {
      err += `cp: cannot stat '${s}': ${r.err}\n`;
      continue;
    }
    if (r.node.t === 'd') {
      err += `cp: -r not specified; omitting directory '${s}'\n`;
      continue;
    }
    if (!can(r.node, 4)) {
      err += `cp: cannot open '${s}' for reading: Permission denied\n`;
      continue;
    }
    const target = toDir ? norm(dst) + '/' + norm(s).split('/').pop() : norm(dst);
    const e = createOrWrite(target, r.node.d, { mode: r.node.m & 0o777 & ~0o022 });
    if (e) err += `cp: cannot create regular file '${dst}': ${e}\n`;
  }
  return { err, code: err ? 1 : 0 };
});

register('mv', (args) => {
  const p = args.filter((a) => !a.startsWith('-'));
  if (p.length < 2) return { err: 'mv: missing destination file operand\n', code: 1 };
  const dst = p.pop();
  const dL = lookup(norm(dst));
  const toDir = dL.node && dL.node.t === 'd';
  let err = '';
  for (const s of p) {
    const abs = norm(s);
    const r = lookup(abs);
    if (r.err) {
      err += `mv: cannot stat '${s}': ${r.err}\n`;
      continue;
    }
    const target = toDir ? norm(dst) + '/' + abs.split('/').pop() : norm(dst);
    const tp = parentDir(target);
    const td = lookup(tp.dirPath);
    if (td.err || td.node.t !== 'd') {
      err += `mv: cannot move '${s}' to '${dst}': No such file or directory\n`;
      continue;
    }
    if (!canDelete(abs) || !can(td.node, 2)) {
      err += `mv: cannot move '${s}' to '${dst}': Permission denied\n`;
      continue;
    }
    const { dirPath, name } = parentDir(abs);
    delete sysNode(dirPath).c[name];
    td.node.c[tp.name] = r.node;
  }
  return { err, code: err ? 1 : 0 };
});

register('nano', (args) => {
  const f = args.find((a) => !a.startsWith('-') && !a.startsWith('+'));
  if (!f) return { note: T.cmd.nanoUsage };
  const abs = norm(f);
  const L = lookup(abs);
  let text = '';
  let msg = '';
  if (L.err) {
    if (L.err === 'No such file or directory') {
      const p = lookup(parentDir(abs).dirPath);
      msg = p.err ? `[ Directory '${parentDir(f).dirPath || '.'}' does not exist ]` : '[ New File ]';
    } else msg = `[ Error reading ${f}: ${L.err} ]`;
  } else if (L.node.t === 'd') return { err: `nano: ${f}: Is a directory\n`, code: 1 };
  else if (!can(L.node, 4)) msg = `[ Error reading ${f}: Permission denied ]`;
  else {
    text = L.node.d;
    const n = lines(text).length;
    msg = can(L.node, 2) ? `[ Read ${n} lines ]` : `[ Read ${n} lines (Warning: No write permission) ]`;
  }
  /** Сохранение из редактора: текст ошибки или ''. */
  const save = (content) => createOrWrite(abs, content);
  return IO.openEditor({ path: f, text, msg, save });
});

for (const c of ['vim', 'vi', 'nvim', 'emacs']) register(c, () => ({ note: T.cmd.noVim(c), code: 127 }));
