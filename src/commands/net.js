// Сетевые команды машин лаборатории (ALT Server, etcnet).
import { register, registerCompleter, C } from './registry.js';
import { S } from '../core/state.js';
import { print, IO } from '../core/io.js';
import { T } from '../i18n/ru.js';
import { norm, readFile, readIn, writeIn } from '../core/fs.js';
import { ip2n, n2ip, maskN, inNet, netOf, bcastOf, parseCidr } from '../netsim/ip.js';
import { iptParse, iptApply, iptSave, iptRestore, IPT_CHAINS } from '../netsim/iptables.js';
import {
  labHost, connectedRoutes, lookupRoute, routeAdd, linkDown, parseRouteArgs, ownAddr, firstAddr,
  roundtrip, send, resolveName, applySysctl, getSys, setSys, SYSCTL_DEFAULTS, netStart, loadIptables,
  bootHost, OSNAME, KERNEL,
} from '../netsim/lab.js';

const labOnly = () => ({ note: T.net.labOnly, code: 1 });

/* ---------- ip ---------- */
function ifaceList(h) {
  const rt = h.rt;
  const L = [{ n: 'lo', kind: 'lo' }];
  for (const p of h.phys) L.push({ n: p.n, kind: 'eth', seg: p.seg, mac: p.mac });
  for (const n of Object.keys(rt.tun)) L.push({ n, kind: 'gre', tun: rt.tun[n] });
  return L.map((x, i) => ({ ...x, idx: i + 1, up: !!rt.links[x.n]?.up, addrs: rt.addrs[x.n] || [] }));
}
const ifState = (x) => (x.kind === 'lo' ? 'UNKNOWN' : x.kind === 'gre' ? (x.up ? 'UNKNOWN' : 'DOWN') : x.up && x.seg ? 'UP' : 'DOWN');
const ifName = (x) => (x.kind === 'gre' ? `${x.n}@${x.tun.host || 'NONE'}` : x.n);

function ifHead(x) {
  let flags;
  let l1;
  let link;
  if (x.kind === 'lo') {
    flags = 'LOOPBACK' + (x.up ? ',UP,LOWER_UP' : '');
    l1 = 'mtu 65536 qdisc noqueue';
    link = '    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00';
  } else if (x.kind === 'gre') {
    flags = 'POINTOPOINT,NOARP' + (x.up ? ',UP,LOWER_UP' : '');
    l1 = 'mtu 1476 qdisc noqueue';
    link = `    link/gre ${x.tun.local} peer ${x.tun.remote}`;
  } else {
    flags = (x.up && !x.seg ? 'NO-CARRIER,' : '') + 'BROADCAST,MULTICAST' + (x.up ? (x.seg ? ',UP,LOWER_UP' : ',UP') : '');
    l1 = 'mtu 1500 qdisc fq_codel';
    link = `    link/ether ${x.mac} brd ff:ff:ff:ff:ff:ff\n    altname enp0s${x.n.replace(/\D/g, '')}`;
  }
  return { flags, text: `${x.idx}: ${ifName(x)}: <${flags}> ${l1} state ${ifState(x)} group default qlen 1000\n${link}` };
}
const ifAddrs = (x) =>
  x.addrs.map(
    (a) =>
      `    inet ${a.ip}/${a.p}${a.p < 31 && x.kind === 'eth' ? ' brd ' + bcastOf(a.ip, a.p) : ''} scope ${x.kind === 'lo' ? 'host' : 'global'} ${x.n}\n` +
      '       valid_lft forever preferred_lft forever',
  );
const devArg = (t) => {
  const i = t.indexOf('dev');
  return (i >= 0 ? t[i + 1] : t.find((x) => !['show', 'list', 'up', 'down', 'set'].includes(x)))?.split('@')[0];
};
const isShow = (s) => !s || /^(s|sh|sho|show|l|li|lis|list|lst)$/.test(s);

function ipAddr(h, t, brief) {
  const sub = t[0];
  if (isShow(sub)) {
    const d = devArg(t.slice(sub ? 1 : 0));
    let L = ifaceList(h);
    if (d) {
      L = L.filter((x) => x.n === d);
      if (!L.length) return { err: `Device "${d}" does not exist.\n`, code: 1 };
    }
    const out = L.map((x) =>
      brief ? `${ifName(x).padEnd(16)} ${ifState(x).padEnd(14)} ${x.addrs.map((a) => a.ip + '/' + a.p).join(' ')}` : [ifHead(x).text, ...ifAddrs(x)].join('\n'),
    );
    return { out: out.join('\n') + '\n' };
  }
  if (/^(a|ad|add|d|de|del|delete|f|fl|flush)$/.test(sub)) {
    const rest = t.slice(1);
    const di = rest.indexOf('dev');
    const dev = di >= 0 ? rest[di + 1] : null;
    if (sub[0] === 'f') {
      const d = dev || rest[0];
      if (!d || !h.rt.links[d]) return { err: `Device "${d || ''}" does not exist.\n`, code: 1 };
      h.rt.addrs[d] = [];
      h.rt.routes = h.rt.routes.filter((r) => r.dev !== d);
      return {};
    }
    const a = rest.find((x) => x !== 'dev' && x !== dev);
    if (!dev) return { err: 'Not sufficient information: "dev" argument is required.\n', code: 1 };
    if (!h.rt.links[dev]) return { err: `Cannot find device "${dev}"\n`, code: 1 };
    const c = parseCidr(a);
    if (!c) return { err: `Error: inet prefix is expected rather than "${a || ''}".\n`, code: 1 };
    const list = h.rt.addrs[dev];
    if (sub[0] === 'a') {
      if (list.some((x) => x.ip === c.ip && x.p === c.p)) return { err: 'RTNETLINK answers: File exists\n', code: 2 };
      list.push(c);
      return { note: a.includes('/') ? null : T.net.noPrefix };
    }
    const i = list.findIndex((x) => x.ip === c.ip && (!a.includes('/') || x.p === c.p));
    if (i < 0) return { err: 'RTNETLINK answers: Cannot assign requested address\n', code: 2 };
    list.splice(i, 1);
    // Маршруты через шлюз, который больше не в подключённой сети, ядро удаляет.
    h.rt.routes = h.rt.routes.filter((r) => !r.via || connectedRoutes(h).some((x) => x.dev === r.dev && inNet(r.via, x.net, x.p)));
    return {};
  }
  return { err: `Command "${sub}" is unknown, try "ip address help".\n`, code: 1 };
}

function ipLink(h, t, brief) {
  const sub = t[0];
  if (isShow(sub)) {
    const d = devArg(t.slice(sub ? 1 : 0));
    let L = ifaceList(h);
    if (d) {
      L = L.filter((x) => x.n === d);
      if (!L.length) return { err: `Device "${d}" does not exist.\n`, code: 1 };
    }
    const out = L.map((x) => {
      const hd = ifHead(x);
      if (!brief) return hd.text.split('\n').slice(0, 2).join('\n');
      const addr = x.kind === 'eth' ? x.mac : x.kind === 'lo' ? '00:00:00:00:00:00' : '0.0.0.0';
      return `${ifName(x).padEnd(16)} ${ifState(x).padEnd(14)} ${addr} <${hd.flags}>`;
    });
    return { out: out.join('\n') + '\n' };
  }
  if (sub === 'set') {
    const rest = t.slice(1);
    const dev = (rest[0] === 'dev' ? rest[1] : rest[0] || '').split('@')[0];
    if (!dev) return { err: 'Not enough of information: "dev" argument is required.\n', code: 1 };
    if (!h.rt.links[dev]) return { err: `Cannot find device "${dev}"\n`, code: 1 };
    if (rest.includes('up')) {
      h.rt.links[dev].up = true;
      return {};
    }
    if (rest.includes('down')) {
      linkDown(h, dev);
      return {};
    }
    return { err: `Error: either "dev" is duplicate, or "${rest[2] || ''}" is a garbage.\n`, code: 1 };
  }
  if (sub === 'add' || sub === 'delete' || sub === 'del') return { note: T.net.useEtcnet, code: 1 };
  return { err: `Command "${sub}" is unknown, try "ip link help".\n`, code: 1 };
}

function ipRoute(h, t) {
  const sub = t[0];
  if (isShow(sub)) {
    const all = [...h.rt.routes.filter((r) => h.rt.links[r.dev]?.up).map((r) => ({ ...r, k: 0 })), ...connectedRoutes(h)];
    all.sort((a, b) => (a.p === 0 ? -1 : 0) - (b.p === 0 ? -1 : 0) || ip2n(a.net) - ip2n(b.net) || b.p - a.p);
    const out = all.map((r) =>
      r.k
        ? `${r.net}/${r.p} dev ${r.dev} proto kernel scope link src ${r.src}`
        : `${r.p === 0 ? 'default' : r.net + '/' + r.p}${r.via ? ' via ' + r.via : ''} dev ${r.dev}${r.via ? '' : ' scope link'}`,
    );
    return { out: out.join('\n') + (all.length ? '\n' : '') };
  }
  if (sub === 'get') {
    const ip = t[1];
    if (ip2n(ip) === null) return { err: `Error: inet prefix is expected rather than "${ip || ''}".\n`, code: 1 };
    if (ownAddr(h, ip)) return { out: `local ${ip} dev lo src ${ip} uid 0\n    cache <local>\n` };
    const r = lookupRoute(h, ip);
    if (!r) return { err: 'RTNETLINK answers: Network is unreachable\n', code: 2 };
    return { out: `${ip}${r.via ? ' via ' + r.via : ''} dev ${r.dev} src ${r.src} uid 0\n    cache\n` };
  }
  if (sub === 'flush') {
    h.rt.routes = [];
    return {};
  }
  if (/^(a|add|del|delete|d|replace|change|r)$/.test(sub)) {
    const r = parseRouteArgs(t.slice(1));
    if (r.err) return { err: r.err + '\n', code: 1 };
    if (sub.startsWith('d')) {
      const net = r.dst === 'default' ? { ip: '0.0.0.0', p: 0 } : parseCidr(r.dst);
      const i = net ? h.rt.routes.findIndex((x) => x.net === net.ip && x.p === net.p && (!r.via || x.via === r.via)) : -1;
      if (i < 0) return { err: 'RTNETLINK answers: No such process\n', code: 2 };
      h.rt.routes.splice(i, 1);
      return {};
    }
    const e = routeAdd(h, r, sub !== 'a' && sub !== 'add');
    return e ? { err: e + '\n', code: 2 } : {};
  }
  return { err: `Command "${sub}" is unknown, try "ip route help".\n`, code: 1 };
}

register('ip', (args) => {
  const h = labHost();
  if (!h) return labOnly();
  args = args.slice();
  let brief = false;
  while (args[0] && args[0].startsWith('-')) {
    const f = args.shift();
    if (f === '-br' || f === '-brief') brief = true;
    else if (!['-4', '-c', '-color', '-s', '-d', '-6'].includes(f)) return { err: `Option "${f}" is unknown, try "ip -help".\n`, code: 255 };
  }
  const obj = args[0] || '';
  const rest = args.slice(1);
  const is = (...full) => obj && full.some((f) => f.startsWith(obj));
  if (!obj || obj === 'help') return { out: 'Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }\nwhere  OBJECT := { address | link | route | neighbour }\n       OPTIONS := { -4 | -br[ief] | -c[olor] }\n' };
  if (is('address', 'addr')) return ipAddr(h, rest, brief);
  if (is('link')) return ipLink(h, rest, brief);
  if (is('route')) return ipRoute(h, rest);
  if (is('neighbor', 'neighbour')) return { out: '' };
  return { err: `Object "${obj}" is unknown, try "ip help".\n`, code: 1 };
});

/* ---------- ping, traceroute, ipcalc ---------- */
register('ping', (args) => {
  const h = labHost();
  if (!h) return labOnly();
  let count = 4;
  let iface = null;
  let tgt = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c') count = +args[++i] || 4;
    else if (/^-c\d+$/.test(a)) count = +a.slice(2);
    else if (a === '-I') iface = args[++i];
    else if (['-W', '-i', '-s', '-t', '-w'].includes(a)) i++;
    else if (!a.startsWith('-')) tgt = a;
  }
  if (!tgt) return { err: 'ping: usage error: Destination address required\n', code: 1 };
  count = Math.min(Math.max(count, 1), 10);
  const res = resolveName(h, tgt);
  if (res.err) return { err: `ping: ${tgt}: ${res.err}\n`, code: 2, note: res.why === 'nons' ? T.net.noNameserver : res.why === 'unreach' ? T.net.dnsUnreachable : null };
  let src = null;
  if (iface) {
    if (ip2n(iface) !== null) {
      if (!ownAddr(h, iface)) return { err: 'ping: bind: Cannot assign requested address\n', code: 2 };
      src = iface;
    } else {
      if (!h.rt.links[iface]) return { err: `ping: SO_BINDTODEVICE ${iface}: No such device\n`, code: 2 };
      src = firstAddr(h, iface);
    }
  }
  const r = roundtrip(h.id, res.ip, src);
  if (!r.ok && r.stage === 'fwd' && r.why === 'unreach' && r.at === h.id) return { err: 'ping: connect: Network is unreachable\n', code: 2 };
  const who = tgt === res.ip ? res.ip : `${tgt} (${res.ip})`;
  let out = `PING ${tgt} (${res.ip}) 56(84) bytes of data.\n`;
  const times = [];
  if (r.ok) {
    for (let k = 1; k <= count; k++) {
      const t = 0.25 + Math.random() * 0.5 + (64 - r.ttl) * 0.35;
      times.push(t);
      out += `64 bytes from ${who}: icmp_seq=${k} ttl=${r.ttl} time=${t.toFixed(3)} ms\n`;
    }
  } else if (r.stage === 'fwd' && r.why === 'arp-origin') {
    for (let k = 1; k <= count; k++) out += `From ${r.src} icmp_seq=${k} Destination Host Unreachable\n`;
  }
  const errs = !r.ok && r.why === 'arp-origin' ? `+${count} errors, ` : '';
  out += `\n--- ${tgt} ping statistics ---\n${count} packets transmitted, ${r.ok ? count : 0} received, ${errs}${r.ok ? 0 : 100}% packet loss, time ${(count - 1) * 1001}ms\n`;
  if (r.ok) {
    const mn = Math.min(...times);
    const mx = Math.max(...times);
    const av = times.reduce((a, b) => a + b, 0) / times.length;
    out += `rtt min/avg/max/mdev = ${mn.toFixed(3)}/${av.toFixed(3)}/${mx.toFixed(3)}/${((mx - mn) / 2).toFixed(3)} ms\n`;
  }
  return { out, code: r.ok ? 0 : 1 };
});

register('traceroute', (args) => {
  const h = labHost();
  if (!h) return labOnly();
  const tgt = args.find((a) => !a.startsWith('-'));
  if (!tgt) return { err: 'Usage: traceroute host\n', code: 2 };
  const res = resolveName(h, tgt);
  if (res.err) return { err: `${tgt}: ${res.err}\nCannot handle "host" cmdline arg \`${tgt}' on position 1 (argc 1)\n`, code: 2 };
  const pkt = { src: null, dst: res.ip, dir: 'orig', ct: [], fwd: 0, hops: [] };
  const f = send(h.id, pkt, null);
  if (!f.ok && f.why === 'unreach' && f.at === h.id) return { err: 'connect: Network is unreachable\n', code: 1 };
  const t = () => (0.2 + Math.random() * 1.4).toFixed(3) + ' ms';
  let out = `traceroute to ${tgt} (${res.ip}), 30 hops max, 60 byte packets\n`;
  let n = 0;
  for (const hop of pkt.hops) out += ` ${++n}  ${hop} (${hop})  ${t()}  ${t()}  ${t()}\n`;
  if (f.ok && !ownAddr(h, res.ip)) out += ` ${++n}  ${res.ip} (${res.ip})  ${t()}  ${t()}  ${t()}\n`;
  else if (!f.ok) for (let k = 0; k < 3; k++) out += ` ${++n}  * * *\n`;
  return { out };
});

register('ipcalc', (args) => {
  const a = args.filter((x) => !x.startsWith('-'));
  if (!a.length) return { err: 'ipcalc: ip address expected\n', code: 1 };
  const c = parseCidr(a[0].includes('/') ? a[0] : a[0] + (a[1] ? '/' + a[1] : '/32'));
  if (!c) return { err: `ipcalc: bad IPv4 address or netmask: ${a.join(' ')}\n`, code: 1 };
  const p = c.p;
  const hosts = p >= 31 ? 2 ** (32 - p) : 2 ** (32 - p) - 2;
  const net = netOf(c.ip, p);
  const bc = bcastOf(c.ip, p);
  const priv = inNet(c.ip, '10.0.0.0', 8) || inNet(c.ip, '172.16.0.0', 12) || inNet(c.ip, '192.168.0.0', 16);
  return {
    out:
      `Address:\t${c.ip}\nNetmask:\t${n2ip(maskN(p))} = ${p}\nNetwork:\t${net}/${p}\nBroadcast:\t${bc}\n` +
      (priv ? 'Address space:\tPrivate Use\n' : '') +
      `HostMin:\t${p >= 31 ? net : n2ip(ip2n(net) + 1)}\nHostMax:\t${p >= 31 ? bc : n2ip(ip2n(bc) - 1)}\nHosts/Net:\t${hosts}\n`,
  };
});

/* ---------- sysctl ---------- */
register('sysctl', (args) => {
  const h = labHost();
  if (!h) return labOnly();
  if (args[0] === '-p' || args[0] === '--load') {
    const f = args[1] || '/etc/sysctl.conf';
    const t = readIn(h.fs, norm(f));
    if (t === null) return { err: `sysctl: cannot open "${f}": No such file or directory\n`, code: 1 };
    const o = [];
    applySysctl(h, t, o, true, f);
    const errs = o.filter((x) => x.startsWith('sysctl:'));
    const ok = o.filter((x) => !x.startsWith('sysctl:'));
    return { out: ok.length ? ok.join('\n') + '\n' : '', err: errs.length ? errs.join('\n') + '\n' : '' };
  }
  if (args.includes('-a')) return { out: Object.keys(SYSCTL_DEFAULTS).sort().map((k) => `${k} = ${getSys(h, k)}`).join('\n') + '\n' };
  const items = args.filter((a) => !a.startsWith('-'));
  if (!items.length) return { err: 'sysctl: no variables specified\n', code: 1 };
  let out = '';
  let err = '';
  for (const it of items) {
    const m = /^([^=]+)=(.*)$/.exec(it);
    if (m) {
      const k = m[1].trim();
      const v = m[2].trim();
      const e = setSys(h, k, v);
      if (e) err += e + '\n';
      else out += `${k.replace(/\//g, '.')} = ${v}\n`;
    } else {
      const k = it.replace(/\//g, '.');
      if (!(k in SYSCTL_DEFAULTS)) err += `sysctl: cannot stat /proc/sys/${k.replace(/\./g, '/')}: No such file or directory\n`;
      else out += `${k} = ${getSys(h, k)}\n`;
    }
  }
  return { out, err, code: err ? 1 : 0 };
});

/* ---------- iptables ---------- */
register('iptables', (args) => {
  const h = labHost();
  if (!h) return labOnly();
  try {
    return { out: iptApply(h.rt.ipt, iptParse(args)) };
  } catch (e) {
    return { err: String(e) + '\n', code: 2 };
  }
});
register('iptables-save', () => {
  const h = labHost();
  if (!h) return labOnly();
  return { out: iptSave(h.rt.ipt) };
});
register('iptables-restore', (args, ctx) => {
  const h = labHost();
  if (!h) return labOnly();
  const f = args.find((a) => !a.startsWith('-'));
  let text;
  if (f) {
    const r = readFile(f, 'iptables-restore');
    if (r.err) return { err: r.err, code: 1 };
    text = r.data;
  } else if (ctx.stdin != null) text = ctx.stdin;
  else return { note: T.cmd.noteStdin('iptables-restore') };
  try {
    iptRestore(h.rt.ipt, text);
    return {};
  } catch (e) {
    return { err: String(e) + '\n', code: 2 };
  }
});

/* ---------- службы ---------- */
const UNITS = { network: 'LSB: Bring up/down networking', iptables: 'IPv4 firewall with iptables', sshd: 'OpenSSH server daemon' };

register('systemctl', (args) => {
  const h = labHost();
  if (!h) return { note: T.net.noSystemctl, code: 1 };
  const flags = args.filter((a) => a.startsWith('-'));
  const pos = args.filter((a) => !a.startsWith('-'));
  const act = pos[0];
  const unit = (pos[1] || '').replace(/\.service$/, '');
  if (act === 'reboot') return C.reboot([]);
  if (!act) {
    const rows = Object.keys(UNITS).map(
      (u) => `  ${(u + '.service').padEnd(17)} loaded ${(h.svcA[u] ? 'active' : 'inactive').padEnd(8)} ${(h.svcA[u] ? (u === 'sshd' ? 'running' : 'exited') : 'dead').padEnd(7)} ${UNITS[u]}`,
    );
    return { out: '  UNIT              LOAD   ACTIVE   SUB     DESCRIPTION\n' + rows.join('\n') + '\n' };
  }
  if (!unit) return { err: 'Too few arguments.\n', code: 1 };
  if (!UNITS[unit]) {
    if (act === 'status') return { err: `Unit ${unit}.service could not be found.\n`, code: 4 };
    return { err: `Failed to ${act} ${unit}.service: Unit ${unit}.service not found.\n`, code: 5, note: unit === 'NetworkManager' ? T.net.noNetworkManager : null };
  }
  const now = flags.includes('--now');
  const msgs = [];
  let out = '';
  let err = '';
  const fail = () => `Job for ${unit}.service failed because the control process exited with error code.\nSee "systemctl status ${unit}.service" and "journalctl -xeu ${unit}.service" for details.\n`;
  const start = () => {
    if (unit === 'network') netStart(h, msgs);
    else if (unit === 'iptables') {
      h.svcA.iptables = loadIptables(h, msgs);
      if (!h.svcA.iptables) err += fail();
    } else h.svcA[unit] = true;
  };
  const stop = () => {
    if (unit === 'network') {
      for (const p of h.phys) linkDown(h, p.n);
      h.svcA.network = false;
    } else if (unit === 'iptables') {
      for (const t of ['filter', 'nat']) {
        h.rt.ipt[t].rules = [];
        for (const c of IPT_CHAINS[t]) h.rt.ipt[t].pol[c] = 'ACCEPT';
      }
      h.svcA.iptables = false;
    } else h.svcA[unit] = false;
  };
  switch (act) {
    case 'start':
    case 'restart':
    case 'reload':
    case 'try-restart':
      start();
      break;
    case 'stop':
      stop();
      break;
    case 'enable':
      h.svc[unit] = true;
      out += `Created symlink /etc/systemd/system/multi-user.target.wants/${unit}.service → /lib/systemd/system/${unit}.service.\n`;
      if (now) start();
      break;
    case 'disable':
      h.svc[unit] = false;
      out += `Removed "/etc/systemd/system/multi-user.target.wants/${unit}.service".\n`;
      if (now) stop();
      break;
    case 'is-enabled':
      return { out: (h.svc[unit] ? 'enabled' : 'disabled') + '\n', code: h.svc[unit] ? 0 : 1 };
    case 'is-active':
      return { out: (h.svcA[unit] ? 'active' : 'inactive') + '\n', code: h.svcA[unit] ? 0 : 3 };
    case 'status':
      return {
        out:
          `● ${unit}.service - ${UNITS[unit]}\n     Loaded: loaded (/lib/systemd/system/${unit}.service; ${h.svc[unit] ? 'enabled' : 'disabled'}; preset: disabled)\n` +
          `     Active: ${h.svcA[unit] ? `active (${unit === 'sshd' ? 'running' : 'exited'})` : 'inactive (dead)'}\n`,
        code: h.svcA[unit] ? 0 : 3,
      };
    default:
      return { err: `Unknown command verb '${act}'.\n`, code: 1 };
  }
  if (msgs.length) err += msgs.map((m) => `${unit}: ${m}`).join('\n') + '\n';
  return { out, err, code: err ? 1 : 0 };
});

register('service', (args) =>
  args.length >= 2 ? C.systemctl([args[1], args[0]]) : { err: 'Usage: service < option > | --status-all | [ service_name [ command | --full-restart ] ]\n', code: 1 },
);

/* ---------- имя машины, перезагрузка ---------- */
register('hostname', (a) => {
  const h = labHost();
  if (!h) return { out: (S.host || 'laptop') + '\n' };
  if (a[0] && !a[0].startsWith('-')) {
    h.rt.hostname = a[0];
    return { note: T.net.hostnameTransient };
  }
  return { out: (a.includes('-s') ? h.rt.hostname.split('.')[0] : h.rt.hostname) + '\n' };
});

register('hostnamectl', (args) => {
  const h = labHost();
  if (!h) return labOnly();
  const a = args.filter((x) => !x.startsWith('-'));
  if (a[0] === 'set-hostname' || (a[0] === 'hostname' && a[1])) {
    const n = a[1];
    if (!n) return { err: 'Too few arguments.\n', code: 1 };
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(n)) return { err: `Invalid hostname '${n}'\n`, code: 1 };
    writeIn(h.fs, '/etc/hostname', n + '\n');
    h.rt.hostname = n;
    IO.refresh();
    return {};
  }
  if (!a[0] || a[0] === 'status') {
    const st = (readIn(h.fs, '/etc/hostname') || '').trim();
    return {
      out:
        ` Static hostname: ${st || '(unset)'}\n` +
        (st !== h.rt.hostname ? `Transient hostname: ${h.rt.hostname}\n` : '') +
        `       Icon name: computer-vm\n         Chassis: vm\n  Virtualization: kvm\nOperating System: ${OSNAME}\n          Kernel: Linux ${KERNEL}\n    Architecture: x86-64\n`,
    };
  }
  return { err: `Unknown command verb '${a[0]}'.\n`, code: 1 };
});

register('reboot', () => {
  const h = labHost();
  if (!h) return { err: 'Call to Reboot failed: Access denied\n', code: 1, note: T.net.rebootOnlyLab };
  print(`Connection to ${h.rt.hostname.split('.')[0]} closed by remote host.`, 'sys');
  const msgs = bootHost(h, []);
  let boot = `[  OK  ] Reached target reboot.target.\n…\n[  OK  ] Started network.service - ${UNITS.network}.`;
  if (h.svc.iptables) boot += `\n[${h.svcA.iptables ? '  OK  ' : 'FAILED'}] ${h.svcA.iptables ? 'Finished' : 'Failed to start'} iptables.service - ${UNITS.iptables}.`;
  print(boot, 'sys');
  if (msgs.length) print(msgs.join('\n'), 'err');
  print(`\n${OSNAME}\nKernel ${KERNEL} on x86_64\n\n${T.net.afterReboot}`, 'sys');
  S.cwd = '/root';
  IO.refresh();
  return { code: 0, stop: true };
});

register('shutdown', (args) => (args.includes('-r') ? C.reboot([]) : { note: T.net.noShutdown, code: 1 }));

/* ---------- дополнение аргументов по Tab ---------- */
const labDevices = () => {
  const h = labHost();
  return h ? ifaceList(h).map((x) => x.n) : [];
};
const IP_OBJECTS = { address: ['show', 'add', 'del', 'flush'], link: ['show', 'set'], route: ['show', 'add', 'del', 'replace', 'get', 'flush'], neighbour: ['show'] };
const fullObject = (w) => Object.keys(IP_OBJECTS).find((o) => w && o.startsWith(w) && !(w === 'a' && o !== 'address'));

registerCompleter('ip', (args, cur) => {
  const words = args.filter((a) => !a.startsWith('-'));
  if (!words.length) return cur.startsWith('-') ? ['-br', '-4', '-c'] : Object.keys(IP_OBJECTS);
  const obj = fullObject(words[0]);
  if (!obj) return [];
  const prev = args[args.length - 1];
  if (prev === 'dev') return labDevices();
  if (words.length === 1) return IP_OBJECTS[obj];
  const sub = words[1];
  if (obj === 'link') {
    if (sub === 'set') return words.length === 2 ? labDevices() : ['up', 'down'];
    return labDevices();
  }
  if (obj === 'address') return sub === 'show' || sub === 'flush' ? ['dev', ...labDevices()] : ['dev'];
  if (obj === 'route') {
    if (['add', 'del', 'replace'].includes(sub)) return words.length === 2 ? ['default'] : prev === 'via' ? [] : ['via', 'dev'];
    return [];
  }
  return [];
});

registerCompleter('systemctl', (args) => {
  const words = args.filter((a) => !a.startsWith('-'));
  if (!words.length) return ['start', 'stop', 'restart', 'reload', 'status', 'enable', 'disable', 'is-enabled', 'is-active', 'reboot', '--now'];
  if (words.length === 1) return Object.keys(UNITS).concat(['enable', 'disable'].includes(words[0]) ? ['--now'] : []);
  return [];
});

registerCompleter('service', (args) => (args.length === 0 ? Object.keys(UNITS) : args.length === 1 ? ['start', 'stop', 'restart', 'status'] : []));

registerCompleter('iptables', (args, cur) => {
  const prev = args[args.length - 1];
  const ti = args.indexOf('-t');
  const table = ti >= 0 && IPT_CHAINS[args[ti + 1]] ? args[ti + 1] : 'filter';
  if (prev === '-t') return Object.keys(IPT_CHAINS);
  if (['-A', '-I', '-D', '-F', '-L', '-S', '-P'].includes(prev)) return IPT_CHAINS[table];
  if (prev === '-j') return table === 'nat' ? ['MASQUERADE', 'SNAT', 'DNAT', 'ACCEPT', 'RETURN'] : ['ACCEPT', 'DROP', 'REJECT', 'LOG', 'RETURN'];
  if (prev === '-o' || prev === '-i') return labDevices();
  if (prev === '-p') return ['all', 'icmp', 'tcp', 'udp'];
  if (prev === '-P') return IPT_CHAINS[table];
  if (['-s', '-d', '--to-source'].includes(prev)) return [];
  return cur.startsWith('-') || !cur ? ['-t', '-A', '-I', '-D', '-F', '-L', '-S', '-P', '-s', '-d', '-i', '-o', '-p', '-j', '-n', '-v', '--to-source', '--line-numbers'] : [];
});

registerCompleter('sysctl', (args, cur) => {
  if (args[args.length - 1] === '-p') return null;
  if (cur.startsWith('-')) return ['-w', '-p', '-a'];
  return Object.keys(SYSCTL_DEFAULTS);
});

registerCompleter('hostnamectl', (args) => (args.length ? [] : ['set-hostname', 'status']));
