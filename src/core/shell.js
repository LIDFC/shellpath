// Оболочка: разбор строки, конвейеры, перенаправления, запуск команд, дополнение по Tab.
import { S, HOME } from './state.js';
import { CANCEL, IO, print } from './io.js';
import { C, COMPLETERS } from '../commands/registry.js';
import { lookup, norm, can, cmpName, expandGlob, readFile, createOrWrite } from './fs.js';
import { T } from '../i18n/ru.js';
import { doExit, hostFor } from './session.js';
import { displayHostname } from '../netsim/lab.js';

/* ---------- токенизация ---------- */
export function tokenize(line) {
  const out = [];
  let cur = null;
  let i = 0;
  const push = () => {
    if (cur) out.push(cur);
    cur = null;
  };
  const word = () => cur || (cur = { v: '', g: false });
  const env = {
    HOME: HOME(),
    USER: S.user || 'you',
    '?': String(S.status),
    PWD: S.cwd,
    HOSTNAME: displayHostname(),
    SHELL: '/bin/bash',
  };
  const dollar = () => {
    const m = /^\$(\?|[A-Za-z_]\w*|\{[A-Za-z_]\w*\})/.exec(line.slice(i));
    if (!m) {
      word().v += '$';
      i++;
      return;
    }
    word().v += env[m[1].replace(/[{}]/g, '')] ?? '';
    i += m[0].length;
  };

  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') {
      push();
      i++;
      continue;
    }
    if (ch === '#' && !cur) break;
    if (ch === '|' || ch === ';' || ch === '&') {
      push();
      if (line.startsWith('&&', i)) {
        out.push({ op: '&&' });
        i += 2;
      } else if (line.startsWith('||', i)) {
        out.push({ op: '||' });
        i += 2;
      } else if (ch === '&') {
        throw T.shell.noBackground;
      } else {
        out.push({ op: ch });
        i++;
      }
      continue;
    }
    if (!cur && line.startsWith('2>&1', i)) {
      out.push({ r: '2>&1' });
      i += 4;
      continue;
    }
    if (!cur && line.startsWith('2>', i)) {
      out.push({ r: '2>' });
      i += 2;
      continue;
    }
    if (ch === '>' || ch === '<') {
      push();
      if (line.startsWith('>>', i)) {
        out.push({ r: '>>' });
        i += 2;
      } else {
        out.push({ r: ch });
        i++;
      }
      continue;
    }
    if (ch === "'") {
      const j = line.indexOf("'", i + 1);
      if (j < 0) throw "unexpected EOF while looking for matching `''";
      word().v += line.slice(i + 1, j);
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      word();
      let j = i + 1;
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\' && '"\\$`'.includes(line[j + 1] || 'x')) {
          cur.v += line[j + 1];
          j += 2;
        } else if (line[j] === '$') {
          i = j;
          dollar();
          j = i;
        } else {
          cur.v += line[j];
          j++;
        }
      }
      if (j >= line.length) throw 'unexpected EOF while looking for matching `"\'';
      i = j + 1;
      continue;
    }
    if (ch === '\\') {
      word().v += line[i + 1] || '';
      i += 2;
      continue;
    }
    if (ch === '$') {
      dollar();
      continue;
    }
    if (ch === '~' && !cur && (i + 1 >= line.length || /[/\s]/.test(line[i + 1]))) {
      word().v += HOME();
      i++;
      continue;
    }
    if (ch === '*' || ch === '?') word().g = true;
    word().v += ch;
    i++;
  }
  push();
  return out;
}

/** Токены → последовательность конвейеров с операторами ; && || */
export function parse(tokens) {
  const seq = [];
  let op = null;
  let pipe = [];
  let st = { argv: [], redirs: [] };
  const endStage = () => {
    if (!st.argv.length && !st.redirs.length) throw 'syntax error near unexpected token';
    pipe.push(st);
    st = { argv: [], redirs: [] };
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.op === '|') {
      endStage();
      continue;
    }
    if (t.op) {
      endStage();
      seq.push({ op, pipe });
      pipe = [];
      op = t.op;
      continue;
    }
    if (t.r) {
      if (t.r === '2>&1') {
        st.redirs.push({ r: t.r });
        continue;
      }
      const n = tokens[k + 1];
      if (!n || n.op || n.r) throw "syntax error near unexpected token `newline'";
      st.redirs.push({ r: t.r, to: n.v });
      k++;
      continue;
    }
    st.argv.push(t);
  }
  if (st.argv.length || st.redirs.length) endStage();
  if (pipe.length) seq.push({ op, pipe });
  else if (op && op !== ';') throw 'syntax error: unexpected end of file';
  return seq;
}

/* ---------- выполнение ---------- */
const LOCAL_OK = ['ssh', 'help', 'clear', 'echo', 'whoami', 'man', 'history', 'hostname', 'pwd'];
const NOT_IMPLEMENTED = ['python', 'python3', 'sudo', 'su', 'apt', 'apt-get', 'xxd', 'less', 'more', 'scp', 'sftp', 'nc', 'curl', 'wget'];

async function runPipe(stages) {
  let stdin = null;
  let code = 0;
  let stop = false;
  for (let k = 0; k < stages.length; k++) {
    const st = stages[k];
    const last = k === stages.length - 1;
    const argv = [];
    for (const t of st.argv) argv.push(...(t.g ? expandGlob(t.v) : [t.v]));

    let toNull = false;
    let merge = false;
    let outFile = null;
    let inErr = '';
    for (const r of st.redirs) {
      if (r.r === '2>') {
        if (r.to === '/dev/null') toNull = true;
      } else if (r.r === '2>&1') merge = true;
      else if (r.r === '>' || r.r === '>>') outFile = r;
      else if (r.r === '<') {
        const f = readFile(r.to, 'bash');
        if (f.err) inErr = f.err;
        else stdin = f.data;
      }
    }
    if (inErr) {
      print(inErr, 'err');
      code = 1;
      stdin = '';
      continue;
    }
    if (!argv.length) {
      stdin = '';
      continue;
    }

    const name = argv[0];
    const args = argv.slice(1);
    let res;
    if (!S.user && !LOCAL_OK.includes(name)) {
      res = { note: T.shell.notConnected(S.cur, hostFor(S.cur)), code: 1 };
    } else if (Object.hasOwn(C, name)) {
      try {
        res = (await C[name](args, { stdin, tty: last && !outFile })) || {};
      } catch (e) {
        if (e === CANCEL) throw e;
        res = { err: `${name}: ${e}\n`, code: 1 };
      }
    } else {
      res = {
        err: `${name}: command not found\n`,
        code: 127,
        note: NOT_IMPLEMENTED.includes(name) ? T.shell.notImplemented(name) : null,
      };
    }

    let o = res.out || '';
    let e = res.err || '';
    if (merge) {
      o += e;
      e = '';
    }
    if (toNull) e = '';
    if (e) print(e, 'err');
    if (res.note) print(res.note, 'note');
    if (outFile) {
      const we = createOrWrite(norm(outFile.to), o, { append: outFile.r === '>>' });
      if (we) print(`bash: ${outFile.to}: ${we}`, 'err');
      o = '';
    }
    if (last) print(o);
    else stdin = o;
    code = res.code || 0;
    if (res.action === 'clear') IO.clear();
    if (res.action === 'exit') {
      doExit();
      stop = true;
    }
    if (res.stop) stop = true;
  }
  return { code, stop };
}

/** Выполнить строку целиком. CANCEL пробрасывается наверх. */
export async function runLine(line) {
  let seq;
  try {
    seq = parse(tokenize(line));
  } catch (e) {
    print('bash: ' + e, 'err');
    S.status = 2;
    return;
  }
  for (const seg of seq) {
    if (seg.op === '&&' && S.status !== 0) continue;
    if (seg.op === '||' && S.status === 0) continue;
    const r = await runPipe(seg.pipe);
    S.status = r.code;
    if (r.stop) break;
  }
}

/* ---------- дополнение по Tab ---------- */
function fileCandidates(raw) {
  const i = raw.lastIndexOf('/');
  const dp = i >= 0 ? raw.slice(0, i + 1) : '';
  const bp = raw.slice(i + 1);
  const { node } = lookup(norm(dp || '.'));
  if (!node || node.t !== 'd' || !can(node, 4)) return [];
  return Object.keys(node.c)
    .filter((n) => n.startsWith(bp) && (bp.startsWith('.') || !n.startsWith('.')))
    .sort(cmpName)
    .map((n) => ({ full: dp + n, dir: node.c[n].t === 'd', file: true }));
}

/**
 * Возвращает { value, pos } — новое содержимое строки, { list } — варианты для показа или null.
 *
 * Аргументы команд (ip link, systemctl restart, iptables -t nat…) дополняются по правилам
 * из COMPLETERS, остальное — как имена файлов. Если вариантов несколько и дописать нечего,
 * сразу показывается список. Имена файлов по пустому слову не подставляются, а без кавычек
 * дополнение останавливается перед пробелом и спецсимволами, чтобы Tab не решал уровни за игрока.
 */
export function complete(value, pos) {
  const before = value.slice(0, pos);
  const m = /(["']?)((?:\\.|[^\s|;<>"'])*)$/.exec(before);
  const q = m[1];
  const word = m[2];
  const start = pos - word.length;
  const pre = before.slice(0, start - q.length);
  const segment = pre.split(/[|;&]/).pop();
  const isCmd = !q && !segment.trim();
  const raw = word.replace(/\\(.)/g, '$1');

  let cands;
  if (isCmd && !raw.includes('/')) {
    cands = Object.keys(C)
      .filter((c) => c.startsWith(raw))
      .sort()
      .map((c) => ({ full: c }));
  } else {
    const words = segment.trim().split(/\s+/);
    const completer = !q && COMPLETERS[words[0]];
    const own = completer ? completer(words.slice(1), raw) : null;
    if (own) {
      cands = [...new Set(own)].filter((c) => c.startsWith(raw)).map((c) => ({ full: c }));
    } else {
      cands = fileCandidates(raw);
      if (words[0] === 'cd') cands = cands.filter((c) => c.dir);
    }
  }
  if (!cands.length) return null;

  const list = () => ({ list: cands.map((c) => (c.file ? c.full.split('/').pop() : c.full) + (c.dir ? '/' : '')) });
  const isFiles = cands[0].file;
  if (isFiles && (!raw || (raw.endsWith('/') && !word.split('/').pop()))) return list();

  const cut = (s) => {
    if (q || !isFiles) return s;
    const i = s.search(/[\s'"\\|;&<>$*?]/);
    return i < 0 ? s : s.slice(0, i);
  };
  const set = (ins) => ({ value: value.slice(0, start) + ins + value.slice(pos), pos: start + ins.length });

  if (cands.length === 1) {
    const c = cands[0];
    const t = cut(c.full);
    if (t !== c.full) return t.length > raw.length ? set(t) : null;
    return set(t + (c.dir ? '/' : (q || '') + ' '));
  }
  let cp = cands[0].full;
  for (const c of cands) while (!c.full.startsWith(cp)) cp = cp.slice(0, -1);
  cp = cut(cp);
  if (cp.length > raw.length) return set(cp);
  return list();
}
