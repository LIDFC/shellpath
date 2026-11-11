// Модель iptables: таблицы filter и nat, правила, сохранение и загрузка.
import { parseCidr, netOf } from './ip.js';
import { lines } from '../core/fs.js';

export const IPT_CHAINS = { filter: ['INPUT', 'FORWARD', 'OUTPUT'], nat: ['PREROUTING', 'INPUT', 'OUTPUT', 'POSTROUTING'] };
const IPTV = 'iptables v1.8.10 (legacy)';
const IPT_TARGETS = ['ACCEPT', 'DROP', 'REJECT', 'MASQUERADE', 'SNAT', 'DNAT', 'LOG', 'RETURN'];
const IPT_HELP = "\n\nTry `iptables -h' or 'iptables --help' for more information.";

export function emptyTables() {
  return {
    filter: { pol: { INPUT: 'ACCEPT', FORWARD: 'ACCEPT', OUTPUT: 'ACCEPT' }, rules: [] },
    nat: { pol: { PREROUTING: 'ACCEPT', INPUT: 'ACCEPT', OUTPUT: 'ACCEPT', POSTROUTING: 'ACCEPT' }, rules: [] },
  };
}

function normCidr(x) {
  const c = parseCidr(x);
  if (!c) throw `${IPTV}: host/network \`${x}' not found`;
  return `${netOf(c.ip, c.p)}/${c.p}`;
}

const IPT_CMD = {
  '-A': '-A', '--append': '-A', '-I': '-I', '--insert': '-I', '-D': '-D', '--delete': '-D', '-F': '-F', '--flush': '-F',
  '-L': '-L', '--list': '-L', '-S': '-S', '--list-rules': '-S', '-P': '-P', '--policy': '-P', '-Z': '-Z', '--zero': '-Z',
};

export function iptParse(args) {
  const o = { table: 'filter', cmd: null, chain: null, num: null, spec: {}, j: null, to: null, n: false, v: false, ln: false, policy: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const nx = () => {
      if (i + 1 >= args.length) throw `${IPTV}: option "${a}" requires an argument`;
      return args[++i];
    };
    if (IPT_CMD[a]) {
      if (o.cmd) throw `${IPTV}: Can't use ${a} with ${o.cmd}`;
      o.cmd = IPT_CMD[a];
      if (args[i + 1] && !args[i + 1].startsWith('-')) o.chain = args[++i];
      if ((o.cmd === '-I' || o.cmd === '-D') && /^\d+$/.test(args[i + 1] || '')) o.num = +args[++i];
      if (o.cmd === '-P') o.policy = nx();
      continue;
    }
    switch (a) {
      case '-t': case '--table': o.table = nx(); break;
      case '-s': case '--source': case '--src': o.spec.s = normCidr(nx()); break;
      case '-d': case '--destination': case '--dst': o.spec.d = normCidr(nx()); break;
      case '-i': case '--in-interface': o.spec.i = nx(); break;
      case '-o': case '--out-interface': o.spec.o = nx(); break;
      case '-p': case '--protocol': o.spec.p = nx().toLowerCase(); break;
      case '-j': case '--jump': o.j = nx(); break;
      case '--to-source': case '--to': o.to = nx(); break;
      case '-n': case '--numeric': o.n = true; break;
      case '-v': case '--verbose': o.v = true; break;
      case '--line-numbers': o.ln = true; break;
      default:
        if (/^-[nvL]+$/.test(a)) {
          for (const c of a.slice(1)) {
            if (c === 'n') o.n = true;
            else if (c === 'v') o.v = true;
            else {
              if (o.cmd && o.cmd !== '-L') throw `${IPTV}: Can't use -L with ${o.cmd}`;
              o.cmd = '-L';
            }
          }
          if (a.includes('L') && args[i + 1] && !args[i + 1].startsWith('-')) o.chain = args[++i];
          break;
        }
        throw `${IPTV}: unknown option "${a}"${IPT_HELP}`;
    }
  }
  return o;
}

export const ruleLine = (r) =>
  ['-A', r.chain, r.s && '-s ' + r.s, r.d && '-d ' + r.d, r.i && '-i ' + r.i, r.o && '-o ' + r.o, r.p && '-p ' + r.p, r.j && '-j ' + r.j, r.to && '--to-source ' + r.to]
    .filter(Boolean)
    .join(' ');

/** Выполнить разобранную команду над таблицами tables. Возвращает вывод или бросает текст ошибки. */
export function iptApply(tables, o) {
  const tbl = tables[o.table];
  if (!tbl) throw `${IPTV}: can't initialize iptables table \`${o.table}': Table does not exist (do you need to insmod?)\nPerhaps iptables or your kernel needs to be upgraded.`;
  if (!o.cmd) throw `${IPTV}: no command specified${IPT_HELP}`;
  const chains = IPT_CHAINS[o.table];
  if (o.chain && !chains.includes(o.chain)) throw 'iptables: No chain/target/match by that name.';
  const anywhere = o.n ? '0.0.0.0/0' : 'anywhere';
  const show = (x) => (x ? (x.endsWith('/32') ? x.slice(0, -3) : x) : anywhere);
  const needChain = () => {
    if (!o.chain) throw `${IPTV}: option "${o.cmd}" requires an argument`;
  };

  switch (o.cmd) {
    case '-A':
    case '-I': {
      needChain();
      if (o.j && !IPT_TARGETS.includes(o.j)) throw `${IPTV}: Couldn't load target \`${o.j}':No such file or directory${IPT_HELP}`;
      if ((o.j === 'MASQUERADE' || o.j === 'SNAT') && !(o.table === 'nat' && o.chain === 'POSTROUTING')) throw 'iptables: No chain/target/match by that name.';
      if (o.j === 'SNAT' && !o.to) throw `${IPTV}: SNAT: option "--to-source" must be specified`;
      if (o.spec.o && ['PREROUTING', 'INPUT'].includes(o.chain)) throw `${IPTV}: Can't use -o with ${o.chain}${IPT_HELP}`;
      if (o.spec.i && ['POSTROUTING', 'OUTPUT'].includes(o.chain)) throw `${IPTV}: Can't use -i with ${o.chain}${IPT_HELP}`;
      const r = { chain: o.chain, ...o.spec, j: o.j, to: o.to };
      if (o.cmd === '-A') tbl.rules.push(r);
      else {
        const idx = tbl.rules.map((x, i) => (x.chain === o.chain ? i : -1)).filter((i) => i >= 0);
        const pos = o.num ? idx[o.num - 1] ?? tbl.rules.length : idx[0] ?? tbl.rules.length;
        tbl.rules.splice(pos, 0, r);
      }
      return '';
    }
    case '-D': {
      needChain();
      const idx = tbl.rules.map((x, i) => (x.chain === o.chain ? i : -1)).filter((i) => i >= 0);
      if (o.num) {
        if (idx[o.num - 1] === undefined) throw 'iptables: Index of deletion too big.';
        tbl.rules.splice(idx[o.num - 1], 1);
        return '';
      }
      const want = ruleLine({ chain: o.chain, ...o.spec, j: o.j, to: o.to });
      const i = tbl.rules.findIndex((x) => ruleLine(x) === want);
      if (i < 0) throw 'iptables: Bad rule (does a matching rule exist in that chain?).';
      tbl.rules.splice(i, 1);
      return '';
    }
    case '-F':
      tbl.rules = o.chain ? tbl.rules.filter((x) => x.chain !== o.chain) : [];
      return '';
    case '-Z':
      return '';
    case '-P':
      needChain();
      if (!['ACCEPT', 'DROP'].includes(o.policy) || (o.table === 'nat' && o.policy !== 'ACCEPT')) throw "iptables: Bad policy name. Run `dmesg' for more information.";
      tbl.pol[o.chain] = o.policy;
      return '';
    case '-S':
      return (
        (o.chain ? [o.chain] : chains)
          .map((c) => `-P ${c} ${tbl.pol[c]}`)
          .concat(tbl.rules.filter((r) => !o.chain || r.chain === o.chain).map(ruleLine))
          .join('\n') + '\n'
      );
    case '-L': {
      const out = [];
      for (const c of o.chain ? [o.chain] : chains) {
        out.push(`Chain ${c} (policy ${tbl.pol[c]}${o.v ? ' 0 packets, 0 bytes' : ''})`);
        out.push((o.ln ? 'num  ' : '') + (o.v ? ' pkts bytes ' : '') + 'target     prot opt ' + (o.v ? 'in     out    ' : '') + 'source               destination');
        tbl.rules
          .filter((r) => r.chain === c)
          .forEach((r, i) =>
            out.push(
              (o.ln ? String(i + 1).padEnd(5) : '') +
                (o.v ? '    0     0 ' : '') +
                (r.j || '').padEnd(11) +
                (r.p || 'all').padEnd(5) +
                '--  ' +
                (o.v ? (r.i || '*').padEnd(7) + (r.o || '*').padEnd(7) : '') +
                show(r.s).padEnd(21) +
                show(r.d) +
                (r.to ? '  to:' + r.to : ''),
            ),
          );
        out.push('');
      }
      out.pop();
      return out.join('\n') + '\n';
    }
  }
  throw `${IPTV}: ${o.cmd} is not supported in this emulator`;
}

export function iptSave(tables) {
  const stamp = new Date().toString().slice(0, 24);
  let s = `# Generated by iptables-save v1.8.10 on ${stamp}\n`;
  for (const t of ['nat', 'filter']) {
    const tbl = tables[t];
    s += `*${t}\n` + IPT_CHAINS[t].map((c) => `:${c} ${tbl.pol[c]} [0:0]\n`).join('') + tbl.rules.map((r) => ruleLine(r) + '\n').join('') + 'COMMIT\n';
  }
  return s + `# Completed on ${stamp}\n`;
}

/** Файл в формате iptables-save → правила. Бросает текст ошибки с номером строки. */
export function iptRestore(tables, text) {
  let table = null;
  lines(text).forEach((raw, i) => {
    const l = raw.trim();
    if (!l || l.startsWith('#')) return;
    if (l.startsWith('*')) {
      table = l.slice(1);
      const tbl = tables[table];
      if (!tbl) throw `iptables-restore v1.8.10 (legacy): Table '${table}' does not exist\nError occurred at line: ${i + 1}`;
      tbl.rules = [];
      for (const c of IPT_CHAINS[table]) tbl.pol[c] = 'ACCEPT';
      return;
    }
    if (l === 'COMMIT') {
      table = null;
      return;
    }
    if (!table) throw `iptables-restore v1.8.10 (legacy): no command specified\nError occurred at line: ${i + 1}`;
    if (l.startsWith(':')) {
      const m = /^:(\S+)\s+(\S+)/.exec(l);
      if (m && tables[table].pol[m[1]] !== undefined && m[2] !== '-') tables[table].pol[m[1]] = m[2];
      return;
    }
    const words = (l.match(/"[^"]*"|\S+/g) || []).map((x) => x.replace(/^"|"$/g, ''));
    try {
      iptApply(tables, iptParse(['-t', table, ...words]));
    } catch (e) {
      throw `${String(e).split('\n')[0]}\nError occurred at line: ${i + 1}\nTry \`iptables-restore -h' or 'iptables-restore --help' for more information.`;
    }
  });
}

/** Подходит ли пакет под условия правила. Пинг — это icmp. */
export function matchRule(r, pkt, inIf, outIf, inNetFn) {
  const within = (ip, cidr) => {
    const [net, p] = cidr.split('/');
    return inNetFn(ip, net, +p);
  };
  if (r.s && !within(pkt.src, r.s)) return false;
  if (r.d && !within(pkt.dst, r.d)) return false;
  if (r.i && r.i !== inIf) return false;
  if (r.o && r.o !== outIf) return false;
  if (r.p && r.p !== 'all' && r.p !== 'icmp') return false;
  return true;
}
