// Блок SSH: пользователи key0…key8, серверы shellpath, vault, backup, gate, inner.
// host — сервер, на котором оказывается игрок, выбрав уровень в ряду.
import { F, D, put, FS, readFile } from '../core/fs.js';
import { S } from '../core/state.js';
import { register } from '../commands/registry.js';
import { privKey, pubLine, blob, fingerprint } from '../commands/keys.js';
import { validateSshd, SSHD_DEFAULTS } from '../commands/ssh.js';
import { PK } from '../worlds/base.js';
import { TOK, SSH_RULES } from '../worlds/ssh-world.js';
import { T } from '../i18n/ru.js';

const own = (u, d, m = 0o640) => F(d, u, u, m);
const sshDir = (u, g = u, m = 0o700) => put(`/home/${u}/.ssh`, D(u, g, m));
const authorized = (u, list) => put(`/home/${u}/.ssh/authorized_keys`, F(list.map(([t, c]) => pubLine('ed25519', t, c)).join('\n') + '\n', u, u, 0o600));

const VAULT_SSHD = [
  '#\t$OpenBSD: sshd_config,v 1.104 2021/07/02 05:11:21 dtucker Exp $', '',
  '# Конфигурация SSH-сервера vault.',
  '# Строки с # — комментарии; закомментированные параметры показывают значения по умолчанию.', '',
  'Include /etc/ssh/sshd_config.d/*.conf', '',
  '#Port 22', '#AddressFamily any', '#ListenAddress 0.0.0.0', '#ListenAddress ::', '',
  '#HostKey /etc/ssh/ssh_host_rsa_key', '#HostKey /etc/ssh/ssh_host_ecdsa_key', '#HostKey /etc/ssh/ssh_host_ed25519_key', '',
  '# Logging', '#SyslogFacility AUTH', '#LogLevel INFO', '',
  '# Authentication:', '#LoginGraceTime 2m', '#PermitRootLogin prohibit-password', '#StrictModes yes', '#MaxAuthTries 6', '#MaxSessions 10', '',
  '#PubkeyAuthentication yes', '#AuthorizedKeysFile\t.ssh/authorized_keys .ssh/authorized_keys2', '',
  'Port 2202', '',
  '#PasswordAuthentication yes', '#PermitEmptyPasswords no', 'KbdInteractiveAuthentication no', 'UsePAM yes', '',
  '#AllowAgentForwarding yes', '#AllowTcpForwarding yes', '#GatewayPorts no', 'X11Forwarding no', '#PrintMotd yes',
  '#TCPKeepAlive yes', '#ClientAliveInterval 0', '#ClientAliveCountMax 3', '#UseDNS no', '#PermitTunnel no', '#Banner none', '',
  'AcceptEnv LANG LC_*', 'Subsystem\tsftp\t/usr/lib/openssh/sftp-server', '',
].join('\n');

const DRAFT_SSHD = [
  '# sshd_config для inner — черновик стажёра',
  'Include /etc/ssh/sshd_config.d/*.conf', '',
  'Port 22', 'PermitRootLogin yes', 'PasswordAuthentication yes', 'PermitEmptyPasswords yes', 'PubkeyAuthentcation yes',
  'MaxAuthTries 10', 'X11Forwarding yes', 'UsePAM yes', 'PrintMotd no', 'AcceptEnv LANG LC_*', 'Subsystem sftp /usr/lib/openssh/sftp-server', '',
  '# дописал в конце, чтобы точно сработало:', 'PermitRootLogin no', '',
].join('\n');

export const SSH = [
  {
    title: 'Ключ вместо пароля',
    host: 'shellpath',
    goal:
      'Ты `key0` на shellpath. Нужно войти на этот же сервер как `key1`. Пароля от key1 нет, зато в домашнем каталоге лежит его закрытый ключ `key1.private`.\n\n' +
      "Блок опирается на начальный: права и `chmod` (уровень 12), `grep '^…'` (13), `nano`, `mkdir` и `>>` (14). Пароль для входа сюда снаружи: `key0`.",
    commands: ['ls', 'cat', 'ssh'],
    hint: 'Ключ передаётся флагом `-i`: `ssh -i key1.private key1@localhost`',
    build: () => {
      put('/home/key0/readme', own('key0', 'Задача: войти на этот же сервер как key1.\nПароль от key1 тебе никто не скажет. Зато рядом лежит закрытый ключ,\nкоторый key1 принимает: key1.private\n'));
      put('/home/key0/key1.private', F(privKey('ed25519', TOK.k1, 'key1@shellpath'), 'key0', 'key0', 0o400));
      sshDir('key1');
      authorized('key1', [[TOK.k1, 'key1@shellpath']]);
    },
    solve: (t) => t.run('ssh -i key1.private key1@localhost'),
  },
  {
    title: 'Слишком открытый ключ',
    host: 'shellpath',
    goal: 'Ключ для входа как `key2` лежит рядом: `key2.private`. Попробуй войти с ним и прочитай, на что ругается ssh.',
    commands: ['ls', 'chmod', 'ssh'],
    hint: 'Закрытый ключ должен быть доступен только владельцу. Посмотри права через `ls -l`, исправь их `chmod 600 key2.private` и подключайся снова.',
    build: () => {
      put('/home/key1/readme', own('key1', 'Ключ для входа как key2 лежит здесь же: key2.private.\nКто-то скопировал его небрежно, и ssh от него откажется.\n'));
      put('/home/key1/key2.private', F(privKey('ed25519', TOK.k2, 'key2@shellpath'), 'key1', 'key1', 0o644));
      sshDir('key2');
      authorized('key2', [[TOK.k2, 'key2@shellpath']]);
    },
    solve: async (t) => {
      await t.run('chmod 600 key2.private');
      await t.run('ssh -i key2.private key2@localhost');
    },
  },
  {
    title: 'Нестандартный порт',
    host: 'shellpath',
    goal:
      'Учётная запись `key3` живёт на сервере `vault`, пароль в `readme`. SSH на vault слушает не 22-й порт. Конфиг сервера: `/srv/vault/etc/ssh/sshd_config`.\n\n' +
      'При первом подключении ssh спросит, доверяешь ли ты ключу хоста. Это нормально, ответь `yes`.',
    commands: ['cat', 'grep', 'ssh'],
    hint: "В конфиге почти всё закомментировано. Найди действующую строку: `grep -i '^port' /srv/vault/etc/ssh/sshd_config`. Затем `ssh -p ПОРТ key3@vault`.",
    build: () => {
      put('/home/key2/readme', own('key2', `Учётная запись key3 живёт на сервере vault.\nВход по паролю: ${PK[3]}\n\nАдмин говорит, что SSH на vault «не на стандартном порту».\nКонфиг сервера vault лежит в /srv/vault/etc/ssh/sshd_config\n`));
      put('/srv/vault/etc/ssh/sshd_config', F(VAULT_SSHD));
    },
    solve: (t) => t.run('ssh -p 2202 key3@vault', ['yes', PK[3]]),
  },
  {
    title: 'Свой ключ',
    host: 'vault',
    goal:
      'Нужно попасть на shellpath как `key4`. Вход по паролю для него запрещён, только по ключу.\n\n' +
      'Файл `/home/key4/.ssh/authorized_keys` открыт на запись твоей группе. Создай свою пару ключей и добавь туда *открытый* ключ.',
    commands: ['ssh-keygen', 'cat', 'ssh', 'ssh-copy-id'],
    hint:
      '`ssh-keygen` (на вопросы можно отвечать Enter), затем `cat ~/.ssh/id_ed25519.pub >> /home/key4/.ssh/authorized_keys` и `ssh key4@shellpath`. ' +
      'Почему здесь не сработает `ssh-copy-id`? Он входит по паролю, чтобы дописать ключ, а паролей у key4 нет.',
    build: () => {
      put('/home/key3/readme', own('key3', 'Нужно попасть на shellpath как key4.\nkey4 пускает только по ключу: вход по паролю для него отключён.\n\nЕго /home/key4/.ssh/authorized_keys открыт на запись твоей группе (key3).\nСоздай свою пару ключей и добавь туда открытый ключ.\n'));
      FS.main.c.home.c.key4.m = 0o751;
      sshDir('key4', 'key3', 0o770);
      put('/home/key4/.ssh/authorized_keys', F('# ключи для входа key4 на shellpath\n' + pubLine('ed25519', TOK.admin, 'admin@shellpath') + '\n', 'key4', 'key3', 0o660));
    },
    solve: async (t) => {
      await t.run('ssh-keygen', ['', '', '']);
      await t.run('cat ~/.ssh/id_ed25519.pub >> /home/key4/.ssh/authorized_keys');
      await t.run('ssh key4@shellpath');
    },
  },
  {
    title: 'Конфиг клиента',
    host: 'shellpath',
    goal:
      'Для входа на vault как `key5` нужны порт 2202, логин key5 и ключ `~/vault_key`. Настрой `~/.ssh/config` так, чтобы хватало команды `ssh vault`.\n\n' +
      'Уровень засчитывается только при входе через конфиг, без флагов и `user@`.',
    commands: ['nano', 'ssh', 'ls'],
    hint: 'Открой `nano ~/.ssh/config` и впиши блок:\n\n```\nHost vault\n    HostName vault\n    Port 2202\n    User key5\n    IdentityFile ~/vault_key\n```\n\nCtrl+O сохранит, Ctrl+X закроет. Затем `ssh vault`.',
    build: () => {
      put('/home/key4/readme', own('key4', 'Доступ к key5 на vault:\n  сервер   vault\n  порт     2202\n  логин    key5\n  ключ     ~/vault_key\n\nНабирать всё это каждый раз надоело. Сделай так, чтобы хватало\nкоманды:  ssh vault\nУровень засчитывается только при входе через ~/.ssh/config, без флагов.\n'));
      put('/home/key4/vault_key', F(privKey('ed25519', TOK.k5, 'key5@vault'), 'key4', 'key4', 0o600));
      sshDir('key5');
      authorized('key5', [[TOK.k5, 'key5@vault']]);
    },
    solve: async (t) => {
      await t.run('echo -e "Host vault\\n    HostName vault\\n    Port 2202\\n    User key5\\n    IdentityFile ~/vault_key" > ~/.ssh/config');
      await t.run('ssh vault', ['yes']);
    },
  },
  {
    title: 'Ключ хоста сменился',
    host: 'vault',
    goal:
      'Нужно попасть на `backup` как `key6`. Твой ключ там уже есть. Но сервер переустановили, и ssh поднимет тревогу.\n\n' +
      'Новый отпечаток сервера лежит в `readme`. Сверь его, прежде чем доверять.',
    commands: ['ssh', 'ssh-keygen', 'cat'],
    hint: 'Старую запись нужно убрать из `~/.ssh/known_hosts`: `ssh-keygen -R backup`. При следующем подключении сравни отпечаток с readme и только потом отвечай `yes`.',
    build: () => {
      put('/home/key5/readme', own('key5', `Сервер backup вчера переустановили, ключ хоста у него новый.\nТвой ключ (~/.ssh/id_ed25519) уже добавлен для key6 на backup.\n\nНовый отпечаток ключа хоста backup (сообщили админы):\n  ${fingerprint(TOK.hbackup)}\n\nПеред подключением сверь отпечаток. Если не совпадает — не подключайся.\n`));
      put('/home/key5/.ssh/id_ed25519', F(privKey('ed25519', TOK.k6, 'key5@vault'), 'key5', 'key5', 0o600));
      put('/home/key5/.ssh/id_ed25519.pub', F(pubLine('ed25519', TOK.k6, 'key5@vault') + '\n', 'key5', 'key5', 0o644));
      put('/home/key5/.ssh/known_hosts', F(`[vault]:2202 ssh-ed25519 ${blob('ed25519', TOK.hvault)}\ngate ssh-ed25519 ${blob('ed25519', TOK.hgate)}\nbackup ssh-ed25519 ${blob('ed25519', TOK.hbackupOld)}\n`, 'key5', 'key5', 0o644));
      sshDir('key6');
      authorized('key6', [[TOK.k6, 'key5@vault'], [TOK.k7, 'key6@backup']]);
    },
    solve: async (t) => {
      await t.run('ssh-keygen -R backup');
      await t.run('ssh key6@backup', ['yes']);
    },
  },
  {
    title: 'Через бастион',
    host: 'backup',
    goal: 'Сервер `inner` закрыт файрволом. Попасть туда можно только с бастиона `gate`. Подключись к `key7@inner` одной командой.',
    commands: ['ssh', 'nano', 'cat'],
    hint: 'Флаг `-J` прокладывает путь через промежуточный хост: `ssh -J gate key7@inner`. То же самое в конфиге: `ProxyJump gate` внутри блока `Host inner`.',
    build: () => {
      put('/home/key6/readme', own('key6', 'Сервер inner закрыт файрволом. Подключиться к нему можно только\nс бастиона gate (порт 22).\n\nТвой ключ ~/.ssh/id_ed25519 принимают и на gate (как key6), и на inner (как key7).\nЗадача: попасть на inner как key7 одной командой ssh.\n'));
      put('/home/key6/.ssh/id_ed25519', F(privKey('ed25519', TOK.k7, 'key6@backup'), 'key6', 'key6', 0o600));
      put('/home/key6/.ssh/id_ed25519.pub', F(pubLine('ed25519', TOK.k7, 'key6@backup') + '\n', 'key6', 'key6', 0o644));
      sshDir('key7');
      authorized('key7', [[TOK.k7, 'key6@backup']]);
    },
    solve: (t) => t.run('ssh -J gate key7@inner', ['yes', 'yes']),
  },
  {
    title: 'Укрепить sshd',
    host: 'inner',
    goal: 'В домашнем каталоге черновик `sshd_config` для inner. Почини синтаксис и приведи его к политике безопасности. `harden-check` выдаст пароль от `key8`.',
    commands: ['nano', 'sshd', 'harden-check'],
    hint: '`sshd -t -f ~/sshd_config` найдёт опечатки. У sshd побеждает *первое* значение параметра, поэтому строка в конце файла ничего не меняет. Исправляй значение там, где оно встречается впервые.',
    build: () => {
      put('/home/key7/readme', own('key7', 'Стажёр подготовил конфиг SSH-сервера для inner: ~/sshd_config\nВ нём есть ошибки — и синтаксические, и по безопасности.\n\n  sshd -t -f ~/sshd_config   проверит синтаксис\n  harden-check               сверит конфиг с политикой\n\nКогда все проверки пройдут, harden-check выдаст пароль от key8.\n'));
      put('/home/key7/sshd_config', F(DRAFT_SSHD, 'key7', 'key7', 0o644));
      put('/usr/local/bin/harden-check', F('#!/bin/sh\n# сверяет sshd_config с политикой безопасности inner\n', 'root', 'root', 0o755));
    },
    solve: async (t) => {
      await t.run('echo -e "Port 2222\\nPermitRootLogin no\\nPasswordAuthentication no\\nPermitEmptyPasswords no\\nPubkeyAuthentication yes\\nMaxAuthTries 3\\nX11Forwarding no" > ~/sshd_config');
      await t.run('sshd -t -f ~/sshd_config');
      await t.run('harden-check');
      await t.run('ssh key8@localhost', [PK[8]]);
    },
  },
  {
    title: 'Финиш блока',
    host: 'inner',
    goal:
      'Блок SSH пройден. Загляни в `readme`.\n\n' +
      'Попробуй закрепить: опиши в `~/.ssh/config` прыжок через gate на inner одним блоком, а потом выйди из всех сессий командой `exit` и посмотри, как они сворачиваются по цепочке.',
    commands: ['cat', 'exit', 'man'],
    hint: 'Глубина вложенности сессий видна в заголовке терминала.',
    build: () => put('/home/key8/readme', own('key8', 'Блок SSH пройден.\n\nТы вошёл по ключу, починил права, нашёл порт, выпустил свой ключ,\nнастроил ~/.ssh/config, разобрался с known_hosts, прошёл через бастион\nи укрепил sshd. Это ровно то, что делают руками на каждом новом сервере.\n')),
  },
];

/* Уровень 4: засчитывается только вход через ~/.ssh/config. */
SSH_RULES.push((ctx) => (ctx.user === 'key5' && !ctx.viaConfig ? T.ssh.needConfig : null));

/* Уровень 7: проверка sshd_config по политике. */
register('harden-check', (args) => {
  const f = args[0] || '~/sshd_config';
  const r = readFile(f, 'harden-check');
  if (r.err) return { err: r.err, code: 1 };
  const { errs, conf } = validateSshd(r.data, f);
  if (errs.length) return { err: T.harden.syntax + errs.join('\n') + '\n', code: 1, note: T.harden.syntaxHint(f) };
  const g = (k) => conf[k] ?? SSHD_DEFAULTS[k];
  const checks = [
    ['Port 2222', conf.ports.length === 1 && conf.ports[0] === '2222', conf.ports.join(', ')],
    ['PermitRootLogin no', g('permitrootlogin') === 'no', g('permitrootlogin')],
    ['PasswordAuthentication no', g('passwordauthentication') === 'no', g('passwordauthentication')],
    ['PermitEmptyPasswords no', g('permitemptypasswords') === 'no', g('permitemptypasswords')],
    ['PubkeyAuthentication yes', g('pubkeyauthentication') === 'yes', g('pubkeyauthentication')],
    [T.harden.maxAuth, +g('maxauthtries') <= 3, g('maxauthtries')],
    ['X11Forwarding no', g('x11forwarding') === 'no', g('x11forwarding')],
  ];
  let out = T.harden.title(f);
  for (const [name, ok, cur] of checks) out += `  [${ok ? 'ok' : '!!'}] ${name}${ok ? '' : T.harden.now(cur)}\n`;
  const failed = checks.filter((c) => !c[1]).length;
  if (failed) return { out: out + T.harden.failed(failed, checks.length), code: 1 };
  out += T.harden.passed(checks.length);
  if (S.user === 'key7') out += T.harden.password(PK[8]);
  return { out };
});
