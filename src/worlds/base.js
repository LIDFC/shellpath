// Основной мир: сервер shellpath и общие системные файлы.
// Файлы конкретных уровней создают сами уровни (поле build в src/levels/*.js).
import { rng, genPw } from '../core/rng.js';
import { D, F, FS, put } from '../core/fs.js';
import { BLOCKS } from '../core/state.js';

export const HOST = 'shellpath';

const PW_RNG = rng(0x5e11a7);
/** Пароли уровней блока «Начальный»: PW[n] — пароль пользователя level{n}. */
export const PW = ['level0'];
for (let i = 1; i <= BLOCKS.basic.max; i++) PW.push(genPw(PW_RNG));

const SSH_RNG = rng(0x55aa01);
/** Пароли пользователей блока SSH. */
export const PK = ['key0'];
for (let i = 1; i <= BLOCKS.ssh.max; i++) PK.push(genPw(SSH_RNG));
/** Тот же генератор дальше раздаёт токены ключей (src/worlds/ssh-world.js). */
export const SSH_TOKEN_RNG = SSH_RNG;

export function binBlob(r, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(Math.floor(r() * 256));
  return s;
}

export const RC = '# ~/.bashrc\nexport PS1="\\u@\\h:\\w\\$ "\nalias ll="ls -l"\n';
export const PROFILE = '# ~/.profile\n. ~/.bashrc\n';

/** Собрать системную часть мира. */
export function buildBase() {
  const root = FS.main;
  for (const n of ['bin', 'boot', 'dev', 'etc', 'home', 'lib', 'opt', 'proc', 'root', 'run', 'srv', 'tmp', 'usr', 'var']) root.c[n] = D();
  root.c.root.m = 0o700;
  root.c.tmp.m = 0o1777;
  root.c.proc.m = 0o555;
  const P = (p, n) => put(p, n, root);

  P('/dev/null', F('', 'root', 'root', 0o666));
  P('/etc/hostname', F(HOST + '\n'));
  P('/etc/motd', F('Добро пожаловать на shellpath.\nПароли уровней лежат в /etc/level_pass, но каждый виден только своему владельцу.\n'));

  let passwd = 'root:x:0:0:root:/root:/bin/bash\nsshd:x:110:65534::/run/sshd:/usr/sbin/nologin\n';
  for (let n = 0; n <= BLOCKS.basic.max; n++) passwd += `level${n}:x:${11000 + n}:${11000 + n}:level ${n}:/home/level${n}:/bin/bash\n`;
  for (let n = 0; n <= BLOCKS.ssh.max; n++) passwd += `key${n}:x:${12000 + n}:${12000 + n}:ssh level ${n}:/home/key${n}:/bin/bash\n`;
  P('/etc/passwd', F(passwd));

  P('/etc/ssl/private', D('root', 'ssl-cert', 0o710));
  P('/etc/ssl/private/shellpath.key', F('-----BEGIN PRIVATE KEY-----\n...\n', 'root', 'ssl-cert', 0o640));
  P('/etc/level_pass', D());
  for (let n = 0; n <= BLOCKS.basic.max; n++) P('/etc/level_pass/level' + n, F(PW[n] + '\n', 'level' + n, 'level' + n, 0o400));
  P('/root/.bash_history', F('cat /etc/level_pass/level7\n', 'root', 'root', 0o600));
  P('/var/log', D('root', 'adm', 0o750));
  P('/var/log/auth.log', F('sshd[812]: Accepted password for level0\n', 'root', 'adm', 0o640));

  const rd = rng(77);
  for (const p of ['bash', 'coreutils', 'findutils', 'grep', 'openssh-server', 'sed', 'tar', 'gzip', 'procps']) {
    P(`/var/lib/dpkg/info/${p}.list`, F(`/usr/bin/${p}\n/usr/share/doc/${p}\n`));
    P(`/var/lib/dpkg/info/${p}.md5sums`, F(Array.from({ length: 4 }, () => genPw(rd) + '  usr/bin/' + p).join('\n') + '\n'));
  }
  for (const c of ['bash', 'ls', 'cat', 'grep', 'find', 'sort', 'uniq', 'tr', 'base64', 'strings', 'file', 'ssh', 'ssh-keygen', 'ssh-copy-id', 'head', 'tail', 'wc', 'nano', 'chmod', 'mkdir', 'cp', 'mv', 'rm', 'touch']) {
    P('/usr/bin/' + c, F('\x7fELF\x02\x01\x01' + binBlob(rd, 120), 'root', 'root', 0o755));
  }
  P('/usr/sbin/sshd', F('\x7fELF\x02\x01\x01' + binBlob(rd, 120), 'root', 'root', 0o755));
  P('/etc/ssh/sshd_config', F('# Конфигурация SSH-сервера shellpath\nInclude /etc/ssh/sshd_config.d/*.conf\n\nPort 22\nPermitRootLogin no\nPasswordAuthentication yes\nKbdInteractiveAuthentication no\nUsePAM yes\nX11Forwarding no\nPrintMotd no\nAcceptEnv LANG LC_*\nSubsystem sftp /usr/lib/openssh/sftp-server\n'));

  // Домашние каталоги пользователей уровней. Права уровни могут поменять в build.
  for (let k = 0; k <= BLOCKS.basic.max; k++) {
    const h = '/home/level' + k;
    P(h, D('root', 'level' + k, 0o755));
    P(h + '/.bashrc', F(RC));
    P(h + '/.profile', F(PROFILE));
  }
  for (let n = 0; n <= BLOCKS.ssh.max; n++) {
    const u = 'key' + n;
    P('/home/' + u, D(u, u, 0o750));
    P(`/home/${u}/.bashrc`, F(RC, u, u));
    P(`/home/${u}/.profile`, F(PROFILE, u, u));
  }
}
