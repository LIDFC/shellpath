// Навигация, чтение и обработка текста.
import { register, registerCompleter, C } from './registry.js';
import { S } from '../core/state.js';
import { T } from '../i18n/ru.js';
import {
  lookup, norm, can, readFile, sysNode, sizeOf, modeStr, quoteName, cmpName, isText, isBinary,
  globRe, gather, lines, joinLines,
} from '../core/fs.js';
import { parsePriv, parsePub, KT } from './keys.js';
import { displayHostname, KERNEL } from '../netsim/lab.js';

/** Разобрать короткие флаги: ['-la', 'x'] → { flags: Set('l','a'), rest: ['x'] } */
function splitFlags(args) {
  const flags = new Set();
  const rest = [];
  for (const a of args) {
    if (a.startsWith('-') && a.length > 1 && a !== '--') for (const c of a.slice(1)) flags.add(c);
    else rest.push(a);
  }
  return { flags, rest };
}

register('help', () => ({ out: T.help }));
register('pwd', () => ({ out: S.cwd + '\n' }));
register('whoami', () => ({ out: (S.user || 'you') + '\n' }));
register('date', () => ({ out: new Date().toString() + '\n' }));
register('history', () => ({ out: S.hist.map((h, i) => String(i + 1).padStart(5) + '  ' + h).join('\n') + '\n' }));
register('clear', () => ({ action: 'clear' }));
register('exit', () => ({ action: 'exit' }));
register('logout', () => ({ action: 'exit' }));

register('id', () => {
  if (S.user === 'root') return { out: 'uid=0(root) gid=0(root) groups=0(root),1(bin),2(daemon),3(sys),4(adm),6(disk),10(wheel)\n' };
  const m = /(\d+)$/.exec(S.user || '');
  if (!S.user || !m) return { out: 'uid=1000(you) gid=1000(you) groups=1000(you)\n' };
  const base = S.user.startsWith('key') ? 12000 : 11000;
  const n = base + +m[1];
  return { out: `uid=${n}(${S.user}) gid=${n}(${S.user}) groups=${n}(${S.user})\n` };
});

register('uname', (a) => {
  const hn = displayHostname();
  const kern = S.user === 'root' ? KERNEL : '6.1.0-shellpath';
  if (a.includes('-a')) return { out: `Linux ${hn} ${kern} #1 SMP x86_64 GNU/Linux\n` };
  if (a.includes('-r')) return { out: kern + '\n' };
  return { out: 'Linux\n' };
});

register('echo', (a) => {
  let n = false;
  let e = false;
  while (a[0] === '-n' || a[0] === '-e') {
    if (a[0] === '-n') n = true;
    else e = true;
    a = a.slice(1);
  }
  let s = a.join(' ');
  if (e) s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  return { out: s + (n ? '' : '\n') };
});

register('cd', (a) => {
  const t = a[0] ?? '~';
  const abs = norm(t);
  const { node, err } = lookup(abs);
  if (err) return { err: `bash: cd: ${t}: ${err}\n`, code: 1 };
  if (node.t !== 'd') return { err: `bash: cd: ${t}: Not a directory\n`, code: 1 };
  if (!can(node, 1)) return { err: `bash: cd: ${t}: Permission denied\n`, code: 1 };
  S.cwd = abs;
  return {};
});

register('ls', (args, ctx) => {
  const { flags, rest: paths } = splitFlags(args);
  const all = flags.has('a');
  const almost = flags.has('A');
  const long = flags.has('l');
  const one = flags.has('1') || !ctx.tty;
  let out = '';
  let err = '';
  let code = 0;
  const fmtLong = (n, name) =>
    `${modeStr(n)} 1 ${n.o.padEnd(8)} ${n.g.padEnd(8)} ${String(sizeOf(n)).padStart(5)} Oct  4 21:07 ${ctx.tty ? quoteName(name) : name}`;
  const fmt = (items) => {
    if (!items.length) return '';
    if (long) {
      const total = items.reduce((s, [, n]) => s + Math.ceil(sizeOf(n) / 4096) * 4, 0);
      return `total ${total}\n` + items.map(([nm, n]) => fmtLong(n, nm)).join('\n') + '\n';
    }
    if (one) return items.map(([nm]) => nm).join('\n') + '\n';
    return items.map(([nm]) => quoteName(nm)).join('  ') + '\n';
  };
  const targets = paths.length ? paths : ['.'];
  const files = [];
  const dirs = [];
  for (const p of targets) {
    const abs = norm(p);
    const { node, err: e } = lookup(abs);
    if (e) {
      err += `ls: cannot access '${p}': ${e}\n`;
      code = 2;
      continue;
    }
    (node.t === 'd' ? dirs : files).push([p, node, abs]);
  }
  out += fmt(files.map(([p, n]) => [p, n]));
  for (const [p, node, abs] of dirs) {
    if (targets.length > 1) out += (out ? '\n' : '') + p + ':\n';
    if (!can(node, 4)) {
      err += `ls: cannot open directory '${p}': Permission denied\n`;
      code = 2;
      continue;
    }
    let items = Object.keys(node.c)
      .filter((n) => all || almost || !n.startsWith('.'))
      .sort(cmpName)
      .map((n) => [n, node.c[n]]);
    if (all) items = [['.', node], ['..', sysNode(norm(abs + '/..')) || node], ...items];
    out += fmt(items);
  }
  return { out, err, code };
});

register('cat', (args, ctx) => {
  let out = '';
  let err = '';
  let code = 0;
  let note;
  if (!args.length) {
    if (ctx.stdin != null) return { out: ctx.stdin };
    return { note: T.cmd.noteStdin('cat') };
  }
  for (const a of args) {
    if (a === '-') {
      if (ctx.stdin != null) out += ctx.stdin;
      else note = T.cmd.catDash;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      return { err: `cat: invalid option -- '${a[1]}'\nTry 'cat --help' for more information.\n`, code: 1 };
    }
    const r = readFile(a, 'cat');
    if (r.err) {
      err += r.err;
      code = 1;
    } else out += r.data;
  }
  return { out, err, code, note };
});

register('file', (args) => {
  if (!args.length) return { err: 'Usage: file [-bchikLlNnprsvzZ0] file ...\n', code: 1 };
  let out = '';
  for (const a of args) {
    if (a.startsWith('-') && a.length > 1) {
      return { err: `file: invalid option -- '${a[1]}'\nUsage: file [-bchikLlNnprsvzZ0] file ...\n`, code: 1 };
    }
    const { node, err } = lookup(norm(a));
    let d;
    if (err) d = `cannot open \`${a}' (${err})`;
    else if (node.t === 'd') d = 'directory';
    else if (!can(node, 4)) d = 'regular file, no read permission';
    else if (!node.d.length) d = 'empty';
    else if (node.d.startsWith('\x7fELF')) d = 'ELF 64-bit LSB pie executable, x86-64';
    else if (parsePriv(node.d)) d = 'OpenSSH private key';
    else if (parsePub(node.d)) d = `OpenSSH ${KT[parsePub(node.d).type].label} public key`;
    else if (isText(node.d)) d = /[Ѐ-ӿ]/.test(node.d) ? 'UTF-8 Unicode text' : 'ASCII text';
    else d = 'data';
    out += `${a}: ${d}\n`;
  }
  return { out };
});

register('find', (args) => {
  let i = 0;
  const starts = [];
  while (i < args.length && !/^[-!(]/.test(args[i])) starts.push(args[i++]);
  if (!starts.length) starts.push('.');
  const tests = [];
  let maxd = Infinity;
  let mind = 0;
  let neg = false;
  try {
    while (i < args.length) {
      const a = args[i++];
      if (a === '!' || a === '-not') {
        neg = !neg;
        continue;
      }
      if (a === '-a' || a === '-and' || a === '-print') continue;
      const need = () => {
        if (i >= args.length) throw `find: missing argument to \`${a}'`;
        return args[i++];
      };
      let t;
      switch (a) {
        case '-name': {
          const re = globRe(need());
          t = (n, nm) => re.test(nm);
          break;
        }
        case '-iname': {
          const re = globRe(need(), 'i');
          t = (n, nm) => re.test(nm);
          break;
        }
        case '-type': {
          const v = need();
          t = (n) => (v === 'd' ? n.t === 'd' : v === 'f' ? n.t === 'f' : false);
          break;
        }
        case '-size': {
          const v = need();
          const m = /^([+-]?)(\d+)([ckMGb]?)$/.exec(v);
          if (!m) throw `find: invalid argument \`${v}' to \`-size'`;
          const unit = { c: 1, k: 1024, M: 1048576, G: 1073741824, b: 512, '': 512 }[m[3]];
          const N = +m[2];
          t = (n) => {
            const s = Math.ceil(sizeOf(n) / unit);
            return m[1] === '+' ? s > N : m[1] === '-' ? s < N : s === N;
          };
          break;
        }
        case '-user': {
          const v = need();
          t = (n) => n.o === v;
          break;
        }
        case '-group': {
          const v = need();
          t = (n) => n.g === v;
          break;
        }
        case '-perm': {
          const v = need();
          const m = parseInt(v.replace(/^[-/]/, ''), 8);
          t = (n) => (v.startsWith('-') ? (n.m & m) === m : v.startsWith('/') ? !!(n.m & m) : (n.m & 0o777) === m);
          break;
        }
        case '-readable':
          t = (n) => can(n, 4);
          break;
        case '-writable':
          t = (n) => can(n, 2);
          break;
        case '-executable':
          t = (n) => can(n, 1);
          break;
        case '-empty':
          t = (n) => (n.t === 'd' ? !Object.keys(n.c).length : !n.d.length);
          break;
        case '-maxdepth':
          maxd = +need();
          continue;
        case '-mindepth':
          mind = +need();
          continue;
        default:
          throw `find: unknown predicate \`${a}'`;
      }
      const nn = neg;
      neg = false;
      tests.push((n, nm) => !!t(n, nm) !== nn);
    }
  } catch (e) {
    return { err: e + '\n', code: 1 };
  }
  let out = '';
  let err = '';
  const walk = (node, path, nm, dep) => {
    if (dep >= mind && tests.every((f) => f(node, nm))) out += path + '\n';
    if (node.t === 'd' && dep < maxd) {
      if (!can(node, 4) || !can(node, 1)) {
        err += `find: '${path}': Permission denied\n`;
        return;
      }
      for (const k of Object.keys(node.c).sort(cmpName)) {
        walk(node.c[k], (path.endsWith('/') ? path : path + '/') + k, k, dep + 1);
      }
    }
  };
  for (const s of starts) {
    const { node, err: e } = lookup(norm(s));
    if (e) {
      err += `find: '${s}': ${e}\n`;
      continue;
    }
    walk(node, s, s.split('/').filter(Boolean).pop() || s, 0);
  }
  return { out, err, code: err ? 1 : 0 };
});

/** Базовые регулярные выражения grep (BRE) → JavaScript. */
function breToJs(p) {
  let o = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\' && i + 1 < p.length) {
      const d = p[++i];
      o += '|(){}+?'.includes(d) ? d : '\\' + d;
    } else if ('|(){}+?'.includes(c)) o += '\\' + c;
    else o += c;
  }
  return o;
}

register('grep', (args, ctx) => {
  const o = {};
  let pat = null;
  let dd = false;
  const files = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (!dd && a === '--') {
      dd = true;
      continue;
    }
    if (!dd && a.startsWith('-') && a.length > 1) {
      for (const c of a.slice(1)) {
        if (c === 'e') {
          pat = args[++k];
          break;
        }
        o[c] = 1;
      }
    } else if (pat === null) pat = a;
    else files.push(a);
  }
  if (pat === null) return { err: "Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n", code: 2 };
  let src = o.F ? pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : o.E ? pat : breToJs(pat);
  if (o.w) src = '\\b(?:' + src + ')\\b';
  let re;
  try {
    re = new RegExp(src, o.i ? 'gi' : 'g');
  } catch {
    return { err: 'grep: Invalid regular expression\n', code: 2 };
  }
  if (!files.length && ctx.stdin == null) return { note: T.cmd.noteStdin('grep') };
  const srcs = files.length ? files : ['-'];
  const multi = srcs.length > 1;
  let out = '';
  let err = '';
  let any = false;
  for (const f of srcs) {
    let text;
    if (f === '-') text = ctx.stdin ?? '';
    else {
      const r = readFile(f, 'grep');
      if (r.err) {
        err += r.err;
        continue;
      }
      text = r.data;
    }
    const L = lines(text);
    let cnt = 0;
    let buf = '';
    const bin = isBinary(text) && !o.a;
    L.forEach((ln, idx) => {
      re.lastIndex = 0;
      const m = re.test(ln);
      if (m === !!o.v) return;
      cnt++;
      const prefix = multi ? f + ':' : '';
      if (o.o && !o.v) {
        re.lastIndex = 0;
        for (const mm of ln.matchAll(re)) buf += prefix + mm[0] + '\n';
      } else buf += prefix + (o.n ? idx + 1 + ':' : '') + ln + '\n';
    });
    if (cnt) any = true;
    if (o.c) out += (multi ? f + ':' : '') + cnt + '\n';
    else if (bin && cnt) out += `grep: ${f === '-' ? '(standard input)' : f}: binary file matches\n`;
    else out += buf;
  }
  return { out, err, code: err ? 2 : any ? 0 : 1 };
});

register('sort', (args, ctx) => {
  const { flags, rest } = splitFlags(args);
  const g = gather(rest, ctx, 'sort');
  if (g.none) return { note: T.cmd.noteStdin('sort') };
  let L = lines(g.text);
  const byte = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  L.sort(flags.has('n') ? (a, b) => (parseFloat(a) || 0) - (parseFloat(b) || 0) || byte(a, b) : byte);
  if (flags.has('r')) L.reverse();
  if (flags.has('u')) L = L.filter((l, i) => i === 0 || l !== L[i - 1]);
  return { out: joinLines(L), err: g.err };
});

register('uniq', (args, ctx) => {
  const { flags, rest } = splitFlags(args);
  const g = gather(rest.slice(0, 1), ctx, 'uniq');
  if (g.none) return { note: T.cmd.noteStdin('uniq') };
  const groups = [];
  for (const l of lines(g.text)) {
    if (groups.length && groups[groups.length - 1][0] === l) groups[groups.length - 1][1]++;
    else groups.push([l, 1]);
  }
  const sel = groups.filter(([, c]) => (flags.has('u') ? c === 1 : flags.has('d') ? c > 1 : true));
  return { out: joinLines(sel.map(([l, c]) => (flags.has('c') ? String(c).padStart(7) + ' ' + l : l))), err: g.err };
});

function expandSet(s) {
  s = s
    .replace(/\[:lower:\]/g, 'a-z')
    .replace(/\[:upper:\]/g, 'A-Z')
    .replace(/\[:digit:\]/g, '0-9')
    .replace(/\[:alpha:\]/g, 'A-Za-z')
    .replace(/\[:space:\]/g, ' \t\n');
  const r = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const d = s[++i];
      r.push(d === 'n' ? '\n' : d === 't' ? '\t' : d);
      continue;
    }
    if (s[i + 1] === '-' && i + 2 < s.length) {
      const a = c.charCodeAt(0);
      const b = s.charCodeAt(i + 2);
      for (let x = a; x <= b; x++) r.push(String.fromCharCode(x));
      i += 2;
    } else r.push(c);
  }
  return r;
}

register('tr', (args, ctx) => {
  let del = false;
  let sq = false;
  const sets = [];
  for (const a of args) {
    if (a === '-d') del = true;
    else if (a === '-s') sq = true;
    else if (a === '-ds' || a === '-sd') del = sq = true;
    else sets.push(a);
  }
  if (!sets.length) return { err: "tr: missing operand\nTry 'tr --help' for more information.\n", code: 1 };
  if (sets.length > 2) return { err: `tr: extra operand '${sets[2]}'\n`, code: 1, note: T.cmd.trNoFile };
  if (ctx.stdin == null) return { note: T.cmd.trStdin };
  const s1 = expandSet(sets[0]);
  let out;
  if (del) {
    const set = new Set(s1);
    out = [...ctx.stdin].filter((c) => !set.has(c)).join('');
  } else {
    if (sets.length < 2) return { err: `tr: missing operand after '${sets[0]}'\n`, code: 1 };
    const s2 = expandSet(sets[1]);
    const map = new Map();
    s1.forEach((c, i) => map.set(c, s2[Math.min(i, s2.length - 1)]));
    out = [...ctx.stdin].map((c) => (map.has(c) ? map.get(c) : c)).join('');
    if (sq) {
      const t = new Set(s2);
      out = out.replace(/(.)\1+/g, (m, c) => (t.has(c) ? c : m));
    }
  }
  return { out };
});

register('base64', (args, ctx) => {
  const dec = args.some((a) => a === '-d' || a === '--decode');
  const files = args.filter((a) => !a.startsWith('-'));
  const g = gather(files.slice(0, 1), ctx, 'base64');
  if (g.none) return { note: T.cmd.noteStdin('base64') };
  if (g.err) return { err: g.err, code: 1 };
  if (dec) {
    try {
      return { out: atob(g.text.replace(/\s/g, '')) };
    } catch {
      return { err: 'base64: invalid input\n', code: 1 };
    }
  }
  const b = btoa(g.text);
  return { out: (b.match(/.{1,76}/g) || ['']).join('\n') + '\n' };
});

register('strings', (args, ctx) => {
  let n = 4;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-n') n = +args[++i];
    else if (/^-\d+$/.test(a)) n = +a.slice(1);
    else files.push(a);
  }
  const g = gather(files, ctx, 'strings');
  if (g.none) return { note: T.cmd.noteStdin('strings') };
  const re = new RegExp(`[\\x20-\\x7e\\t]{${n},}`, 'g');
  return { out: joinLines(g.text.match(re) || []), err: g.err };
});

function headTail(tail) {
  const name = tail ? 'tail' : 'head';
  return (args, ctx) => {
    let n = 10;
    const files = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-n') n = +args[++i];
      else if (/^-n\d+$/.test(a)) n = +a.slice(2);
      else if (/^-\d+$/.test(a)) n = +a.slice(1);
      else files.push(a);
    }
    const g = gather(files, ctx, name);
    if (g.none) return { note: T.cmd.noteStdin(name) };
    const L = lines(g.text);
    return { out: joinLines(tail ? L.slice(Math.max(0, L.length - n)) : L.slice(0, n)), err: g.err };
  };
}
register('head', headTail(false));
register('tail', headTail(true));

register('wc', (args, ctx) => {
  const { flags, rest: files } = splitFlags(args);
  if (!flags.size) ['l', 'w', 'c'].forEach((c) => flags.add(c));
  const one = (t, name) => {
    const v = [];
    if (flags.has('l')) v.push((t.match(/\n/g) || []).length);
    if (flags.has('w')) v.push((t.match(/\S+/g) || []).length);
    if (flags.has('c')) v.push(t.length);
    return v.map((x) => String(x).padStart(v.length > 1 ? 7 : 0)).join(' ') + (name ? ' ' + name : '');
  };
  if (!files.length) {
    if (ctx.stdin == null) return { note: T.cmd.noteStdin('wc') };
    return { out: one(ctx.stdin) + '\n' };
  }
  let out = '';
  let err = '';
  for (const f of files) {
    const r = readFile(f, 'wc');
    if (r.err) err += r.err;
    else out += one(r.data, f) + '\n';
  }
  return { out, err };
});

register('man', (a) => {
  if (!a[0]) return { out: "What manual page do you want?\nFor example, try 'man man'.\n", code: 1 };
  const t = T.man[a[0]];
  if (!t) return { err: `No manual entry for ${a[0]}\n`, code: 16 };
  return { out: a[0].toUpperCase() + '\n\n  ' + t.replace(/\n/g, '\n  ') + '\n' };
});

/* Дополнение по Tab: man знает имена команд. */
registerCompleter('man', (args) => (args.length ? [] : Object.keys(T.man).filter((c) => C[c])));
