// ssh, ssh-keygen, ssh-copy-id, sshd -t.
import { register, registerCompleter } from './registry.js';
import { S, meta } from '../core/state.js';
import { print, ask } from '../core/io.js';
import { T } from '../i18n/ru.js';
import {
  lookup, norm, can, readFile, createOrWrite, mkdirRaw, sysNode, sysRead, parentDir, globRe,
  lines, joinLines, octal, put, D, F,
} from '../core/fs.js';
import { KT, parsePriv, parsePub, blob, pubLine, privKey, fingerprint, randomart, passHash } from './keys.js';
import { HOSTS, HOSTKEY, ALLOW, PASSWORD_OK, LOCALNAMES, SSH_RULES, passOf, resolveSshHost } from '../worlds/ssh-world.js';
import { genToken } from '../core/rng.js';
import { LAB } from '../netsim/lab.js';
import { login } from '../core/session.js';

const BANNER = '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@';
const unprotectedWarn = (m, id) =>
  `${BANNER}\n@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @\n${BANNER}\n` +
  `Permissions ${octal(m)} for '${id}' are too open.\nIt is required that your private key files are NOT accessible by others.\n` +
  `This private key will be ignored.\nLoad key "${id}": bad permissions`;
const changedWarn = (fpr, kh, ln, name) =>
  `${BANNER}\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n${BANNER}\n` +
  'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!\nSomeone could be eavesdropping on you right now (man-in-the-middle attack)!\n' +
  `It is also possible that a host key has just been changed.\nThe fingerprint for the ED25519 key sent by the remote host is\n${fpr}.\n` +
  `Please contact your system administrator.\nAdd correct host key in ${kh} to get rid of this message.\n` +
  `Offending ED25519 key in ${kh}:${ln}\nHost key for ${name} has changed and you have requested strict checking.\nHost key verification failed.`;
const SSH_USAGE =
  'usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface] [-b bind_address]\n' +
  '           [-c cipher_spec] [-D [bind_address:]port] [-E log_file]\n' +
  '           [-e escape_char] [-F configfile] [-I pkcs11] [-i identity_file]\n' +
  '           [-J destination] [-L address] [-l login_name] [-m mac_spec]\n' +
  '           [-O ctl_cmd] [-o option] [-P tag] [-p port] [-R address]\n' +
  '           [-S ctl_path] [-W host:port] [-w local_tun[:remote_tun]]\n' +
  '           destination [command [argument ...]]';

/** Открытые ключи из authorized_keys пользователя (читает «сервер», без учёта прав). */
export function authorizedBlobs(user) {
  const t = sysRead(`/home/${user}/.ssh/authorized_keys`);
  if (!t) return [];
  const out = [];
  for (const l of t.split('\n')) {
    if (l.trim().startsWith('#')) continue;
    const f = l.trim().split(/\s+/);
    const i = f.findIndex((x) => Object.values(KT).some((k) => k.name === x));
    if (i >= 0 && f[i + 1]) out.push(f[i + 1]);
  }
  return out;
}

/** Проверка ключа хоста по ~/.ssh/known_hosts с вопросом yes/no для нового хоста. */
async function hostKeyCheck(name, host, port) {
  const id = port === 22 ? name : `[${name}]:${port}`;
  const key = blob('ed25519', HOSTKEY[host]);
  const fpr = fingerprint(HOSTKEY[host]);
  const kh = S.user ? `/home/${S.user}/.ssh/known_hosts` : null;
  const text = kh ? sysRead(kh) : null;
  if (text) {
    const L = text.split('\n');
    for (let i = 0; i < L.length; i++) {
      const f = L[i].trim().split(/\s+/);
      if (f.length < 3 || f[0].startsWith('#')) continue;
      if (!f[0].split(',').includes(id)) continue;
      if (f[2] === key) return true;
      print(changedWarn(fpr, kh, i + 1, name), 'err');
      return false;
    }
  }
  print(`The authenticity of host '${id} (${HOSTS[host].ip})' can't be established.\nED25519 key fingerprint is ${fpr}.\nThis key is not known by any other names.`);
  let a = await ask('Are you sure you want to continue connecting (yes/no/[fingerprint])? ');
  for (;;) {
    if (a === null) return false;
    a = a.trim();
    if (a === 'yes' || a === fpr) break;
    if (a === 'no') {
      print('Host key verification failed.', 'err');
      return false;
    }
    a = await ask("Please type 'yes', 'no' or the fingerprint: ");
  }
  let err = 'no home';
  if (kh) {
    const sd = `/home/${S.user}/.ssh`;
    err = sysNode(sd) ? '' : mkdirRaw(sd, 0o700);
    if (!err) err = createOrWrite(kh, `${id} ssh-ed25519 ${key}\n`, { append: true });
  }
  if (err) print(`Failed to add the host to the list of known hosts (${kh || '/home/you/.ssh/known_hosts'}).`, 'err');
  else print(`Warning: Permanently added '${id}' (ED25519) to the list of known hosts.`, 'sys');
  return true;
}

/** Одно подключение: сеть → ключ хоста → ключи → пароль. Возвращает хост или null. */
export async function connect({ user, host: name, port, ids = [], explicit = [], from, passOnly = false }) {
  const host = resolveSshHost(name, from);
  if (!host) {
    print(`ssh: Could not resolve hostname ${name}: Name or service not known`, 'err');
    return null;
  }
  const H = HOSTS[host];
  if (H.only && !H.only.includes(from)) {
    print(`ssh: connect to host ${name} port ${port}: Connection timed out`, 'err');
    return null;
  }
  if (!H.ports.includes(port)) {
    print(`ssh: connect to host ${name} port ${port}: Connection refused`, 'err');
    return null;
  }
  if (!LOCALNAMES.includes(name) && host !== 'shellpath' && !(await hostKeyCheck(name, host, port))) return null;

  const allowed = ALLOW[host](user);
  if (!passOnly && S.user) {
    const list = [...ids];
    for (const d of ['~/.ssh/id_ed25519', '~/.ssh/id_rsa', '~/.ssh/id_ecdsa']) if (!list.includes(d)) list.push(d);
    for (const id of list) {
      const r = lookup(norm(id));
      if (r.err || r.node.t !== 'f') {
        if (explicit.includes(id)) print(`Warning: Identity file ${id} not accessible: ${r.err || 'Is a directory'}.`, 'err');
        continue;
      }
      const node = r.node;
      if (!can(node, 4)) {
        print(`Load key "${id}": Permission denied`, 'err');
        continue;
      }
      if (node.o === S.user && node.m & 0o077) {
        print(unprotectedWarn(node.m, id), 'err');
        continue;
      }
      const k = parsePriv(node.d);
      if (!k) {
        const isPub = !!parsePub(node.d);
        print(`Load key "${id}": ${isPub ? 'error in libcrypto' : 'invalid format'}`, 'err');
        if (isPub) print(T.ssh.pubGiven, 'note');
        continue;
      }
      if (allowed && authorizedBlobs(user).includes(blob(k.type, k.token))) {
        if (k.ph !== 'none') {
          let good = false;
          for (let t = 0; t < 3 && !good; t++) {
            const p = await ask(`Enter passphrase for key '${id}': `, true);
            if (p === null) return null;
            if (passHash(p) === k.ph) good = true;
          }
          if (!good) continue;
        }
        return host;
      }
    }
  }
  const pwAllowed = allowed ? PASSWORD_OK(user) : true;
  if (!pwAllowed) {
    print(`${user}@${name}: Permission denied (publickey).`, 'err');
    return null;
  }
  for (let t = 0; t < 3; t++) {
    const p = await ask(`${user}@${name}'s password: `, true);
    if (p === null) return null;
    if (allowed && p.trim() === passOf(user)) return host;
    print('Permission denied, please try again.', 'err');
  }
  print(`${user}@${name}: Permission denied (publickey,password).`, 'err');
  if (meta(user)?.block === 'basic') print(T.ssh.caseSensitive, 'note');
  return null;
}

const CFGKEYS = new Set([
  'host', 'match', 'hostname', 'user', 'port', 'identityfile', 'identitiesonly', 'proxyjump', 'proxycommand',
  'stricthostkeychecking', 'userknownhostsfile', 'serveraliveinterval', 'serveralivecountmax', 'forwardagent',
  'localforward', 'remoteforward', 'dynamicforward', 'compression', 'loglevel', 'addkeystoagent', 'include',
  'connecttimeout', 'preferredauthentications', 'pubkeyauthentication', 'passwordauthentication', 'controlmaster',
  'controlpath', 'controlpersist', 'setenv', 'sendenv', 'requesttty', 'hashknownhosts', 'visualhostkey',
]);

/** Настройки из ~/.ssh/config для псевдонима. Первое найденное значение побеждает, как в ssh. */
export function sshConfig(alias, file) {
  const r = { identityfile: [] };
  if (!S.user) return r;
  const path = file ? norm(file) : `/home/${S.user}/.ssh/config`;
  const L = lookup(path);
  if (L.err || L.node.t !== 'f') {
    if (file) r.err = `Can't open user config file ${file}: No such file or directory`;
    return r;
  }
  const node = L.node;
  if (!file && (node.o !== S.user || node.m & 0o022)) {
    r.err = `Bad owner or permissions on ${path}`;
    return r;
  }
  let active = true;
  let bad = 0;
  let msgs = '';
  node.d.split('\n').forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) return;
    const m = /^([A-Za-z]+)\s*(?:=\s*|\s+)(.*)$/.exec(line);
    if (!m) {
      msgs += `${path}: line ${i + 1}: Bad configuration option: ${line.split(/\s/)[0]}\n`;
      bad++;
      return;
    }
    const k = m[1].toLowerCase();
    const v = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (!CFGKEYS.has(k)) {
      msgs += `${path}: line ${i + 1}: Bad configuration option: ${m[1]}\n`;
      bad++;
      return;
    }
    if (!v) {
      msgs += `${path} line ${i + 1}: missing argument.\n`;
      bad++;
      return;
    }
    if (k === 'host') {
      const pats = v.split(/\s+/);
      active =
        pats.some((p) => !p.startsWith('!') && globRe(p).test(alias)) &&
        !pats.some((p) => p.startsWith('!') && globRe(p.slice(1)).test(alias));
      if (active && pats.some((p) => p !== '*')) r.matched = true;
      return;
    }
    if (k === 'match') {
      active = false;
      return;
    }
    if (!active) return;
    if (k === 'port' && !/^\d+$/.test(v)) {
      msgs += `${path} line ${i + 1}: Badly formatted port number.\n`;
      bad++;
      return;
    }
    if (k === 'identityfile') r.identityfile.push(v);
    else if (!(k in r)) r[k] = v;
  });
  if (bad) r.err = msgs + `${path}: terminating, ${bad} bad configuration options`;
  return r;
}

register('ssh', async (args) => {
  if (LAB.hosts[S.host] && S.user === 'root') {
    print(T.ssh.inLab, 'note');
    return { code: 1, stop: true };
  }
  const o = { ids: [], port: null, user: null, jump: null, opts: {}, F: null, flags: false };
  let target = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (target !== null) {
      rest.push(a);
      continue;
    }
    const val = () => {
      if (i + 1 >= args.length) throw `option requires an argument -- ${a[1]}`;
      return args[++i];
    };
    try {
      if (a === '-i') {
        o.ids.push(val());
        o.flags = true;
      } else if (a === '-p') {
        o.port = +val();
        o.flags = true;
      } else if (a === '-l') {
        o.user = val();
        o.flags = true;
      } else if (a === '-J') {
        o.jump = val();
        o.flags = true;
      } else if (a === '-o') {
        const m = /^(\w+)\s*[= ]\s*(.*)$/.exec(val());
        if (m) o.opts[m[1].toLowerCase()] = m[2];
        o.flags = true;
      } else if (a === '-F') o.F = val();
      else if (/^-[46AaCfGgKkMNnqsTtVvXxYy]+$/.test(a)) {
        /* флаги без значения ни на что не влияют */
      } else if (a.startsWith('-')) {
        print(`ssh: illegal option -- ${a.replace(/^-+/, '')[0] || '-'}\n${SSH_USAGE}`, 'err');
        return { code: 255, stop: true };
      } else target = a;
    } catch (e) {
      print(`ssh: ${e}\n${SSH_USAGE}`, 'err');
      return { code: 255, stop: true };
    }
  }
  if (!target) {
    print(SSH_USAGE, 'err');
    return { code: 255, stop: true };
  }
  let alias = target;
  let explicitUser = null;
  const at = target.lastIndexOf('@');
  if (at >= 0) {
    explicitUser = target.slice(0, at);
    alias = target.slice(at + 1);
  }
  const cfg = sshConfig(alias, o.F);
  if (cfg.err) {
    print(cfg.err, 'err');
    return { code: 255, stop: true };
  }
  const host = o.opts.hostname || cfg.hostname || alias;
  const user = explicitUser || o.user || o.opts.user || cfg.user || S.user || 'you';
  const port = o.port || +(o.opts.port || cfg.port || 22);
  const ids = [...o.ids];
  if (o.opts.identityfile) ids.push(o.opts.identityfile);
  ids.push(...cfg.identityfile);
  const jump = o.jump || o.opts.proxyjump || cfg.proxyjump;
  if (rest.length) print(T.ssh.noRemoteCommands, 'note');

  let from = S.host || 'local';
  if (jump && jump.toLowerCase() !== 'none') {
    for (const hop of jump.split(',')) {
      const m = /^(?:(.*)@)?([^:@]+)(?::(\d+))?$/.exec(hop.trim());
      if (!m) {
        print(`ssh: invalid ProxyJump "${hop}"`, 'err');
        return { code: 255, stop: true };
      }
      const jc = sshConfig(m[2]);
      if (jc.err) {
        print(jc.err, 'err');
        return { code: 255, stop: true };
      }
      const r = await connect({
        user: m[1] || jc.user || S.user || 'you',
        host: jc.hostname || m[2],
        port: +(m[3] || jc.port || 22),
        ids: [...jc.identityfile],
        from,
      });
      if (!r) {
        print('Connection closed by UNKNOWN port 65535', 'err');
        return { code: 255, stop: true };
      }
      from = r;
    }
  }
  const r = await connect({ user, host, port, ids, explicit: o.ids, from });
  if (!r) {
    if (HOSTS[host]?.only && !jump) print(T.ssh.needJump(host), 'note');
    return { code: 255, stop: true };
  }
  const ctx = { user, host: r, viaConfig: !!cfg.matched && !o.flags && !explicitUser };
  for (const rule of SSH_RULES) {
    const deny = rule(ctx);
    if (deny) {
      print(deny, 'note');
      print(`Connection to ${host} closed.`, 'sys');
      return { code: 1, stop: true };
    }
  }
  login(user, r, { push: true });
  return { code: 0, stop: true };
});

const KEYGEN_USAGE =
  'usage: ssh-keygen [-q] [-a rounds] [-b bits] [-C comment] [-f output_keyfile]\n' +
  '                  [-N new_passphrase] [-t ecdsa | ed25519 | rsa]\n' +
  '       ssh-keygen -l [-f input_keyfile]\n' +
  '       ssh-keygen -y [-f input_keyfile]\n' +
  '       ssh-keygen -R hostname [-f known_hosts_file]';

register('ssh-keygen', async (args) => {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = () => args[++i];
    if (a === '-t') o.t = v();
    else if (a === '-f') o.f = v();
    else if (a === '-N') o.N = v() ?? '';
    else if (a === '-C') o.C = v();
    else if (a === '-b' || a === '-a' || a === '-E') v();
    else if (a === '-R') o.R = v();
    else if (a === '-l') o.l = 1;
    else if (a === '-y') o.y = 1;
    else if (a === '-q') o.q = 1;
    else {
      print(`ssh-keygen: illegal option -- ${a.replace(/^-+/, '')[0] || a}\n${KEYGEN_USAGE}`, 'err');
      return { code: 1 };
    }
  }
  if (!S.user) {
    print(T.ssh.connectFirst, 'note');
    return { code: 1 };
  }
  const home = S.user === 'root' ? '/root' : `/home/${S.user}`;

  if (o.R) {
    const file = o.f || home + '/.ssh/known_hosts';
    const r = readFile(file, 'ssh-keygen');
    if (r.err) {
      print(`do_known_hosts: hostkeys_foreach failed for ${file}: No such file or directory`, 'err');
      return { code: 255 };
    }
    const keep = [];
    const found = [];
    lines(r.data).forEach((l, i) => {
      const f = l.trim().split(/\s+/);
      if (f[0] && !f[0].startsWith('#') && f[0].split(',').includes(o.R)) found.push(i + 1);
      else keep.push(l);
    });
    if (!found.length) {
      print(`Host ${o.R} not found in ${file}`);
      return { code: 0 };
    }
    for (const n of found) print(`# Host ${o.R} found: line ${n}`);
    createOrWrite(norm(file) + '.old', r.data);
    const e = createOrWrite(norm(file), joinLines(keep));
    if (e) {
      print(`mkstemp: ${e}`, 'err');
      return { code: 1 };
    }
    print(`${file} updated.\nOriginal contents retained as ${file}.old`);
    return { code: 0 };
  }

  if (o.l || o.y) {
    let f = o.f;
    if (!f) {
      f = await ask(`Enter file in which the key is (${home}/.ssh/id_ed25519): `);
      if (f === null) return { code: 1 };
      f = f.trim() || home + '/.ssh/id_ed25519';
    }
    const r = readFile(f, 'ssh-keygen');
    if (r.err) {
      print(`${f}: No such file or directory`, 'err');
      return { code: 1 };
    }
    const fromKnownHosts = () =>
      r.data
        .split('\n')
        .map((l) => {
          const x = l.trim().split(/\s+/);
          return x.length >= 3 ? parsePub(x.slice(1).join(' ')) : null;
        })
        .find(Boolean);
    const k = parsePriv(r.data) || parsePub(r.data) || fromKnownHosts();
    if (!k) {
      print(`${f} is not a key file.`, 'err');
      return { code: 255 };
    }
    if (o.y) {
      if (!parsePriv(r.data)) {
        print(`Load key "${f}": invalid format`, 'err');
        return { code: 255 };
      }
      print(pubLine(k.type, k.token, k.comment));
      return { code: 0 };
    }
    print(`${KT[k.type].bits} ${fingerprint(k.token)} ${k.comment || 'no comment'} (${KT[k.type].label})`);
    return { code: 0 };
  }

  const type = (o.t || 'ed25519').toLowerCase();
  if (!KT[type]) {
    print(`unknown key type ${o.t}`, 'err');
    return { code: 1 };
  }
  if (!o.q) print(`Generating public/private ${type} key pair.`);
  const def = `${home}/.ssh/id_${type}`;
  let file = o.f;
  if (!file) {
    const a = await ask(`Enter file in which to save the key (${def}): `);
    if (a === null) return { code: 1 };
    file = a.trim() || def;
  }
  const abs = norm(file);
  const pd = parentDir(abs).dirPath;
  if (pd === home + '/.ssh' && !sysNode(pd)) {
    const e = mkdirRaw(pd, 0o700);
    if (e) {
      print(`Saving key "${file}" failed: ${e}`, 'err');
      return { code: 1 };
    }
    print(`Created directory '${pd}'.`);
  }
  if (lookup(abs).node) {
    print(`${file} already exists.`);
    const a = await ask('Overwrite (y/n)? ');
    if (a === null || !/^y/i.test(a.trim())) return { code: 1 };
  }
  let pass = o.N;
  while (pass === undefined) {
    const p1 = await ask(`Enter passphrase for "${file}" (empty for no passphrase): `, true);
    if (p1 === null) return { code: 1 };
    const p2 = await ask('Enter same passphrase again: ', true);
    if (p2 === null) return { code: 1 };
    if (p1 === p2) pass = p1;
    else print('Passphrases do not match.  Try again.');
  }
  const token = genToken(Math.random);
  const comment = o.C ?? `${S.user}@${S.host}`;
  let e = createOrWrite(abs, privKey(type, token, comment, pass), { mode: 0o600 });
  if (e) {
    print(`Saving key "${file}" failed: ${e}`, 'err');
    return { code: 1 };
  }
  const pn = sysNode(abs);
  if (pn && pn.o === S.user) pn.m = 0o600;
  e = createOrWrite(abs + '.pub', pubLine(type, token, comment) + '\n', { mode: 0o644 });
  if (e) {
    print(`Unable to save public key to ${file}.pub: ${e}`, 'err');
    return { code: 1 };
  }
  if (!o.q) {
    print(
      `Your identification has been saved in ${file}\nYour public key has been saved in ${file}.pub\n` +
        `The key fingerprint is:\n${fingerprint(token)} ${comment}\nThe key's randomart image is:\n${randomart(token, KT[type].label, KT[type].bits)}`,
    );
  }
  return { code: 0 };
});

register('ssh-copy-id', async (args) => {
  let id = null;
  let port = null;
  let target = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-i') id = args[++i];
    else if (a === '-p') port = +args[++i];
    else if (!a.startsWith('-')) target = a;
  }
  if (!target) {
    print('Usage: /usr/bin/ssh-copy-id [-h|-?|-f|-n|-s|-x] [-i [identity_file]] [-p port] [-F alternative ssh_config file] [[-o <ssh -o options>] ...] [user@]hostname', 'err');
    return { code: 1 };
  }
  if (!S.user) {
    print(T.ssh.connectFirst, 'note');
    return { code: 1 };
  }
  const pubPath = id
    ? id.endsWith('.pub')
      ? id
      : id + '.pub'
    : ['~/.ssh/id_ed25519.pub', '~/.ssh/id_rsa.pub', '~/.ssh/id_ecdsa.pub'].find((p) => lookup(norm(p)).node);
  const r = pubPath ? readFile(pubPath, 'ssh-copy-id') : { err: 1 };
  const k = r.err ? null : parsePub(r.data);
  if (!k) {
    print(`/usr/bin/ssh-copy-id: ERROR: failed to open ID file '${pubPath || '/home/' + S.user + '/.ssh/id_*.pub'}': No such file or directory`, 'err');
    return { code: 1 };
  }
  print(`/usr/bin/ssh-copy-id: INFO: Source of key(s) to be installed: "${pubPath}"`, 'sys');
  let alias = target;
  let eu = null;
  const at = target.lastIndexOf('@');
  if (at >= 0) {
    eu = target.slice(0, at);
    alias = target.slice(at + 1);
  }
  const cfg = sshConfig(alias);
  const host = cfg.hostname || alias;
  const user = eu || cfg.user || S.user;
  const p = port || +(cfg.port || 22);
  print('/usr/bin/ssh-copy-id: INFO: attempting to log in with the new key(s), to filter out any that are already installed', 'sys');
  if (authorizedBlobs(user).includes(blob(k.type, k.token))) {
    print('\n/usr/bin/ssh-copy-id: WARNING: All keys were skipped because they already exist on the remote system.\n\t\t(if you think this is a mistake, you may want to use -f option)', 'sys');
    return { code: 0 };
  }
  print('/usr/bin/ssh-copy-id: INFO: 1 key(s) remain to be installed -- if you are prompted now it is to install the new keys', 'sys');
  const ok = await connect({ user, host, port: p, from: S.host, passOnly: true });
  if (!ok) {
    const h = resolveSshHost(host, S.host);
    if (h && ALLOW[h](user) && !PASSWORD_OK(user)) print(T.ssh.copyIdNeedsPassword, 'note');
    return { code: 1 };
  }
  const dir = `/home/${user}/.ssh`;
  if (!sysNode(dir)) put(dir, D(user, user, 0o700));
  const ak = sysNode(dir + '/authorized_keys');
  const line = pubLine(k.type, k.token, k.comment) + '\n';
  if (ak) ak.d += line;
  else put(dir + '/authorized_keys', F(line, user, user, 0o600));
  print(`\nNumber of key(s) added: 1\n\nNow try logging into the machine, with:   "ssh '${user}@${host}'"\nand check to make sure that only the key(s) you wanted were added.`);
  return { code: 0 };
});

/* ---------- sshd -t ---------- */
const SSHD_KEYS = {
  port: 'port', listenaddress: 's', addressfamily: 's', hostkey: 's',
  permitrootlogin: ['yes', 'no', 'prohibit-password', 'without-password', 'forced-commands-only'],
  passwordauthentication: 'bool', pubkeyauthentication: 'bool', permitemptypasswords: 'bool', x11forwarding: 'bool',
  usepam: 'bool', printmotd: 'bool', printlastlog: 'bool', kbdinteractiveauthentication: 'bool',
  challengeresponseauthentication: 'bool', strictmodes: 'bool', usedns: 'bool', tcpkeepalive: 'bool',
  allowagentforwarding: 'bool', allowtcpforwarding: ['yes', 'no', 'local', 'remote', 'all'],
  gatewayports: ['yes', 'no', 'clientspecified'], permittunnel: ['yes', 'no', 'point-to-point', 'ethernet'],
  maxauthtries: 'int', maxsessions: 'int', logingracetime: 's', clientaliveinterval: 'int', clientalivecountmax: 'int',
  allowusers: 's', allowgroups: 's', denyusers: 's', denygroups: 's', acceptenv: 's', subsystem: 's',
  authorizedkeysfile: 's', syslogfacility: 's', loglevel: 's', include: 's', banner: 's', match: 'match',
};
export const SSHD_DEFAULTS = {
  port: '22', permitrootlogin: 'prohibit-password', passwordauthentication: 'yes', pubkeyauthentication: 'yes',
  permitemptypasswords: 'no', maxauthtries: '6', x11forwarding: 'no',
};

/** Разбор sshd_config: ошибки и итоговые значения (первое значение побеждает, Port может повторяться). */
export function validateSshd(text, path) {
  const errs = [];
  const conf = {};
  const ports = [];
  let inMatch = false;
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const m = /^(\S+)\s*(.*)$/.exec(line);
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    const t = SSHD_KEYS[k];
    if (!t) return errs.push(`${path}: line ${i + 1}: Bad configuration option: ${m[1]}`);
    if (t === 'match') {
      inMatch = true;
      return;
    }
    if (!v) return errs.push(`${path} line ${i + 1}: missing argument.`);
    const lv = v.toLowerCase();
    if (t === 'bool' && lv !== 'yes' && lv !== 'no') return errs.push(`${path} line ${i + 1}: unsupported option "${v}".`);
    if (Array.isArray(t) && !t.includes(lv)) return errs.push(`${path} line ${i + 1}: unsupported option "${v}".`);
    if (t === 'port' && !(/^\d+$/.test(v) && +v > 0 && +v < 65536)) return errs.push(`${path} line ${i + 1}: Badly formatted port number.`);
    if (t === 'int' && !/^\d+$/.test(v)) return errs.push(`${path} line ${i + 1}: integer value "${v}" is invalid.`);
    if (inMatch) return;
    if (k === 'port') {
      ports.push(v);
      return;
    }
    if (!(k in conf)) conf[k] = lv;
  });
  conf.ports = ports.length ? ports : ['22'];
  return { errs, conf };
}

register('sshd', (args) => {
  if (!args.includes('-t') && !args.includes('-T')) {
    return { err: 'sshd re-exec requires execution with an absolute path\n', code: 1, note: T.ssh.sshdNoRun };
  }
  const fi = args.indexOf('-f');
  const f = fi >= 0 ? args[fi + 1] : '/etc/ssh/sshd_config';
  if (!f) return { err: 'sshd: option requires an argument -- f\n', code: 1 };
  const r = readFile(f, 'sshd');
  if (r.err) return { err: `${f}: No such file or directory\n`, code: 1 };
  const { errs, conf } = validateSshd(r.data, f);
  if (errs.length) {
    const bad = errs.filter((e) => e.includes('Bad configuration option')).length;
    return { err: errs.join('\n') + '\n' + (bad ? `${f}: terminating, ${bad} bad configuration options\n` : ''), code: 255 };
  }
  if (args.includes('-T')) {
    const out = conf.ports
      .map((p) => 'port ' + p)
      .concat(Object.keys(SSHD_DEFAULTS).filter((k) => k !== 'port').map((k) => `${k} ${conf[k] ?? SSHD_DEFAULTS[k]}`));
    return { out: out.join('\n') + '\n' };
  }
  return {};
});

/* ---------- дополнение по Tab: хосты из known_hosts и ~/.ssh/config, как в bash-completion ---------- */
function knownSshHosts() {
  const hosts = new Set(['localhost', 'shellpath']);
  if (!S.user) return [...hosts];
  for (const l of (sysRead(`/home/${S.user}/.ssh/known_hosts`) || '').split('\n')) {
    const f = l.trim().split(/\s+/)[0];
    if (f && !f.startsWith('#')) for (const h of f.split(',')) hosts.add(h.replace(/^\[([^\]]+)\]:\d+$/, '$1'));
  }
  for (const l of (sysRead(`/home/${S.user}/.ssh/config`) || '').split('\n')) {
    const m = /^\s*host\s+(.+)$/i.exec(l);
    if (m) for (const h of m[1].split(/\s+/)) if (!/[*?!]/.test(h)) hosts.add(h);
  }
  return [...hosts];
}

registerCompleter(['ssh', 'ssh-copy-id'], (args, cur) => {
  const prev = args[args.length - 1];
  if (['-i', '-F'].includes(prev)) return null;
  if (['-p', '-l', '-o'].includes(prev)) return [];
  if (cur.startsWith('-')) return ['-i', '-p', '-l', '-J', '-F', '-o'];
  const at = cur.lastIndexOf('@');
  const user = at >= 0 ? cur.slice(0, at + 1) : '';
  return knownSshHosts().map((h) => user + h);
});

registerCompleter('ssh-keygen', (args, cur) => {
  const prev = args[args.length - 1];
  if (prev === '-t') return Object.keys(KT);
  if (prev === '-R') return knownSshHosts();
  if (cur.startsWith('-')) return ['-t', '-f', '-N', '-C', '-R', '-l', '-y'];
  return null;
});
