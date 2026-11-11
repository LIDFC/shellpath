// Блок «Начальный»: пользователи level0…level15 на сервере shellpath.
//
// Формат уровня (одинаков для всех блоков, подробности — docs/ADDING_LEVELS.md):
//   title    — название
//   goal     — задание, Markdown
//   commands — команды-подсказки (по клику открывается man)
//   hint     — подсказка, Markdown
//   build    — создать файлы уровня в мире (вызывается один раз при старте)
//   solve    — эталонное решение для тестов: async (t) => { await t.run('команда') }
import { rng, genPw, shuffle, ALNUM } from '../core/rng.js';
import { D, F, put, FS, lines, sysNode } from '../core/fs.js';
import { S } from '../core/state.js';
import { register } from '../commands/registry.js';
import { PW, binBlob } from '../worlds/base.js';
import { T } from '../i18n/ru.js';

/** Файл с паролем уровня k+1: читать может только группа уровня k. */
const passFile = (k, content) => F(content, 'level' + (k + 1), 'level' + k, 0o640);

function textBlob(r, n) {
  const w = 'the of and kernel socket packet route shell admin config daemon process signal buffer cache inode mount proxy tunnel cipher token port bridge frame header payload'.split(' ');
  let s = '';
  while (s.length < n) s += w[Math.floor(r() * w.length)] + (r() < 0.12 ? '\n' : ' ');
  return s.slice(0, n);
}

export const BASIC = [
  {
    title: 'Первый вход',
    goal:
      'Ты уже на сервере под пользователем `level0`. В домашнем каталоге лежит файл `readme`, в нём пароль для уровня 1.\n\n' +
      'Найдя пароль, переходи дальше: `ssh level1@shellpath` в терминале или вставь пароль в поле под заданием.',
    commands: ['ls', 'cat', 'pwd', 'ssh'],
    hint: '`ls` покажет, что лежит в каталоге, `cat readme` выведет файл.',
    build: () => put('/home/level0/readme', passFile(0, 'Поздравляем с первым входом!\n\nПароль для перехода на уровень 1:\n' + PW[1] + '\n')),
    solve: (t) => t.run('cat readme'),
  },
  {
    title: 'Файл по имени «-»',
    goal: 'Пароль для уровня 2 лежит в файле с именем `-` в домашнем каталоге.',
    commands: ['ls', 'cat'],
    hint: 'Многие программы понимают `-` как стандартный ввод. Укажи путь явно: `cat ./-`',
    build: () => put('/home/level1/-', passFile(1, PW[2] + '\n')),
    solve: (t) => t.run('cat ./-'),
  },
  {
    title: 'Пробелы в имени',
    goal: 'Пароль в файле `spaces in this filename` в домашнем каталоге.',
    commands: ['ls', 'cat'],
    hint: 'Оболочка разбивает слова по пробелам. Возьми имя в кавычки: `cat "spaces in this filename"`',
    build: () => put('/home/level2/spaces in this filename', passFile(2, PW[3] + '\n')),
    solve: (t) => t.run('cat "spaces in this filename"'),
  },
  {
    title: 'Скрытый файл',
    goal: 'Пароль спрятан в скрытом файле внутри каталога `inhere`.',
    commands: ['ls', 'cd', 'cat'],
    hint: 'Файлы, чьё имя начинается с точки, обычный `ls` не показывает. Нужен ключ `-a`.',
    build: () => {
      put('/home/level3/inhere', D('root', 'level3'));
      put('/home/level3/inhere/...Hiding-From-You', passFile(3, PW[4] + '\n'));
    },
    solve: (t) => t.run('cat inhere/...Hiding-From-You'),
  },
  {
    title: 'Один читаемый',
    goal: 'В каталоге `inhere` несколько файлов. Только в одном из них обычный текст, остальные набиты двоичным мусором. Пароль в текстовом.',
    commands: ['ls', 'file', 'cat'],
    hint: '`file ./inhere/*` покажет тип каждого файла. Ищи *ASCII text*.',
    build: () => {
      const r = rng(44);
      put('/home/level4/inhere', D('root', 'level4', 0o750));
      for (let i = 0; i < 10; i++) put('/home/level4/inhere/-file0' + i, passFile(4, i === 7 ? PW[5] + '\n' : '\x00' + binBlob(r, 32)));
    },
    solve: async (t) => {
      await t.run('file ./inhere/*');
      await t.run('cat ./inhere/-file07');
    },
  },
  {
    title: 'Иголка по размеру',
    goal: 'Где-то в `inhere` лежит файл с тремя свойствами: читаем человеком, ровно **1033 байта**, не исполняемый.',
    commands: ['find', 'file', 'cat'],
    hint: '`find inhere -size 1033c ! -executable`. Суффикс `c` означает байты.',
    build: () => {
      const r = rng(55);
      put('/home/level5/inhere', D('root', 'level5', 0o750));
      const names = ['-file1', '.file1', '-file2', '.file2', '-file3', '.file3', 'spaces file1', 'spaces file2', 'spaces file3'];
      for (let i = 0; i < 20; i++) {
        const dn = '/home/level5/inhere/maybehere' + String(i).padStart(2, '0');
        put(dn, D('root', 'level5', 0o750));
        for (const n of names) {
          let sz = 40 + Math.floor(r() * 9000);
          if (sz === 1033) sz = 1034;
          put(dn + '/' + n, F(textBlob(r, sz), 'root', 'level5', r() < 0.5 ? 0o750 : 0o640));
        }
      }
      put('/home/level5/inhere/maybehere13/-file2', F(textBlob(r, 1033), 'root', 'level5', 0o750));
      put('/home/level5/inhere/maybehere07/.file2', F(PW[6] + '\n' + ' '.repeat(1033 - 33), 'level6', 'level5', 0o640));
    },
    solve: async (t) => {
      await t.run('find inhere -size 1033c ! -executable');
      await t.run('cat inhere/maybehere07/.file2');
    },
  },
  {
    title: 'По всему серверу',
    goal: 'Файл с паролем лежит где-то на сервере. Владелец `level7`, группа `level6`, размер 33 байта.',
    commands: ['find', 'cat'],
    hint: 'Ищи от корня: `find / -user level7 -group level6 -size 33c`. Сообщения «Permission denied» убираются через `2>/dev/null`.',
    build: () => {
      const r = rng(66);
      put('/var/lib/dpkg/info/level7.password', F(PW[7] + '\n', 'level7', 'level6', 0o640));
      put('/var/backups/passwd.bak', F(genPw(r) + '\n', 'root', 'level6', 0o640));
      put('/opt/notes/level7.txt', F(genPw(r) + '\n', 'level7', 'level7', 0o600));
      put('/tmp/.x33', F(genPw(r) + '\n', 'level6', 'level6', 0o644));
    },
    solve: async (t) => {
      await t.run('find / -user level7 -group level6 -size 33c 2>/dev/null');
      await t.run('cat /var/lib/dpkg/info/level7.password');
    },
  },
  {
    title: 'Рядом со словом',
    goal: 'Пароль в файле `data.txt`, в строке со словом `millionth`. Файл длинный, листать бесполезно.',
    commands: ['grep', 'wc', 'head'],
    hint: '`grep millionth data.txt`',
    build: () => {
      const r = rng(77777);
      const words = 'apple orbit lantern quartz meadow vector socket hollow cinder falcon ripple tundra copper violet harbor mantle ember glacier pixel thunder saffron bramble cobalt marble pilgrim'.split(' ');
      const l = [];
      for (let i = 0; i < 3000; i++) l.push(words[Math.floor(r() * words.length)] + '\t' + genPw(r));
      l.splice(1873, 0, 'millionth\t' + PW[8]);
      put('/home/level7/data.txt', passFile(7, l.join('\n') + '\n'));
    },
    solve: (t) => t.run('grep millionth data.txt'),
  },
  {
    title: 'Единственная',
    goal: 'В `data.txt` много строк, и почти все повторяются. Пароль в той строке, что встречается ровно один раз.',
    commands: ['sort', 'uniq', 'wc'],
    hint: '`uniq` сравнивает только соседние строки, поэтому сначала сортировка: `sort data.txt | uniq -u`',
    build: () => {
      const r = rng(888);
      const l = [];
      for (let i = 0; i < 100; i++) {
        const p = genPw(r);
        const rep = 2 + Math.floor(r() * 9);
        for (let j = 0; j < rep; j++) l.push(p);
      }
      l.push(PW[9]);
      shuffle(l, r);
      put('/home/level8/data.txt', passFile(8, l.join('\n') + '\n'));
    },
    solve: (t) => t.run('sort data.txt | uniq -u'),
  },
  {
    title: 'Строки в шуме',
    goal: '`data.txt` почти целиком двоичный. Пароль среди немногих читаемых строк, и перед ним стоят несколько знаков `=`.',
    commands: ['strings', 'grep', 'file'],
    hint: '`strings data.txt | grep ==`',
    build: () => {
      const r = rng(999);
      const nonPrintable = () => {
        let c = Math.floor(r() * 256);
        if ((c >= 32 && c <= 126) || c === 9) c ^= 0x80;
        return String.fromCharCode(c);
      };
      const noise = (n) => {
        let s = '';
        for (let i = 0; i < n; i++) {
          if (r() < 0.12) {
            const k = 1 + Math.floor(r() * 3);
            for (let j = 0; j < k; j++) s += ALNUM[Math.floor(r() * 62)];
          }
          s += nonPrintable();
        }
        return s;
      };
      let d = '';
      for (const e of ['=Kp7x', '========== the', 'xH4b=q', '========== password', 'q=Z0', '========== is', 'Ua=e8', '========== ' + PW[10], 'vT2=']) {
        d += noise(380) + '\x00' + e + '\x00';
      }
      put('/home/level9/data.txt', passFile(9, d + noise(380)));
    },
    solve: (t) => t.run('strings data.txt | grep =='),
  },
  {
    title: 'Base64',
    goal: 'В `data.txt` закодированный в Base64 текст. Пароль внутри.',
    commands: ['cat', 'base64'],
    hint: '`base64 -d data.txt`',
    build: () => put('/home/level10/data.txt', passFile(10, btoa('The password is ' + PW[11] + '\n') + '\n')),
    solve: (t) => t.run('base64 -d data.txt'),
  },
  {
    title: 'ROT13',
    goal: 'В `data.txt` текст, где каждая латинская буква сдвинута на 13 позиций по алфавиту.',
    commands: ['cat', 'tr'],
    hint: "Сдвиг обратно — тот же сдвиг: `tr 'A-Za-z' 'N-ZA-Mn-za-m' < data.txt`",
    build: () => {
      const rot = (s) => s.replace(/[A-Za-z]/g, (c) => {
        const b = c <= 'Z' ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
      });
      put('/home/level11/data.txt', passFile(11, rot('The password is ' + PW[12]) + '\n'));
    },
    solve: (t) => t.run("tr 'A-Za-z' 'N-ZA-Mn-za-m' < data.txt"),
  },
  {
    title: 'Права доступа',
    goal:
      'В домашнем каталоге лежит файл `secret` с паролем. Он твой, но прочитать его не выйдет. Разберись почему и исправь.\n\n' +
      '`ls -l` показывает права строкой вроде `-rw-r-----`. Первый символ — тип (`-` файл, `d` каталог), дальше три тройки: **владелец**, **группа**, **остальные**. ' +
      'В каждой `r` — чтение, `w` — запись, `x` — выполнение, `-` — права нет.\n\n' +
      'Права пишут и цифрами: r = 4, w = 2, x = 1, складываются по тройкам. `600` — это `rw-------`: владелец читает и пишет, остальным ничего. `644` — это `rw-r--r--`. ' +
      'Менять права командой `chmod` может только владелец файла.',
    commands: ['ls', 'chmod', 'cat'],
    hint: '`ls -l secret` покажет `----------`: прав нет ни у кого, даже у тебя. Ты владелец, так что верни себе чтение: `chmod 600 secret` (или `chmod u+r secret`), затем `cat secret`.',
    build: () => put('/home/level12/secret', F(PW[13] + '\n', 'level12', 'level12', 0o000)),
    solve: async (t) => {
      await t.run('chmod 600 secret');
      await t.run('cat secret');
    },
  },
  {
    title: 'Начало строки',
    goal:
      'В `server.conf` пароль записан в параметре `password`. Строк со словом password там много: закомментированные, старые, резервные. Действует только та, что начинается прямо с `password=`.\n\n' +
      'Так устроены почти все конфиги в Linux: строка с `#` в начале — комментарий и не работает.',
    commands: ['grep', 'cat', 'wc'],
    hint: "Символ `^` в шаблоне grep означает «начало строки»: `grep '^password=' server.conf`. Кавычки нужны, чтобы оболочка не трогала спецсимволы. Сравни с выводом `grep password= server.conf`.",
    build: () => {
      const r = rng(1313);
      const keys = 'listen_port max_clients log_level timeout cache_size worker_threads data_dir pid_file admin_email retry_count'.split(' ');
      const l = ['# server.conf — настройки сервиса отчётов', ''];
      for (let i = 0; i < 180; i++) {
        const x = r();
        if (x < 0.06) l.push('#password=' + genPw(r));
        else if (x < 0.1) l.push('old_password=' + genPw(r));
        else if (x < 0.14) l.push('backup_password=' + genPw(r));
        else if (x < 0.17) l.push('  # password=' + genPw(r) + '  (отключено)');
        else if (x < 0.22) l.push('');
        else l.push(keys[Math.floor(r() * keys.length)] + '=' + Math.floor(r() * 9000));
      }
      l.splice(97, 0, 'password=' + PW[14]);
      put('/home/level13/server.conf', passFile(13, l.join('\n') + '\n'));
    },
    solve: (t) => t.run("grep '^password=' server.conf"),
  },
  {
    title: 'Пишем файлы',
    goal:
      'Сторож `gatekeeper` выдаёт пароль, если найдёт файл `~/inbox/request.txt` ровно с двумя строками: `user=level14` и `level=15`.\n\n' +
      '`~` — это твой домашний каталог, здесь `/home/level14`. Каталога `inbox` пока нет.\n\n' +
      'Для тренировки напиши первую строку в редакторе `nano`, а вторую допиши в конец файла без редактора.',
    commands: ['mkdir', 'nano', 'echo', 'gatekeeper'],
    hint:
      '`mkdir ~/inbox`, затем `nano ~/inbox/request.txt`: впиши `user=level14`, Ctrl+O сохранит, Ctrl+X закроет. ' +
      'Вторую строку допиши: `echo level=15 >> ~/inbox/request.txt`. Два знака `>>` дописывают в конец, один `>` перезаписал бы файл целиком. Проверь `cat` и запусти `gatekeeper`.',
    build: () => {
      const home = FS.main.c.home.c.level14;
      home.o = 'level14';
      home.g = 'level14';
      put('/home/level14/readme', F('Сторож gatekeeper выдаёт пароль, если найдёт файл ~/inbox/request.txt\nровно с такими строками:\n\nuser=level14\nlevel=15\n', 'level14', 'level14', 0o644));
      put('/usr/local/bin/gatekeeper', F('#!/bin/sh\n# выдаёт пароль, если ~/inbox/request.txt составлен верно\n', 'root', 'root', 0o755));
    },
    solve: async (t) => {
      await t.run('mkdir ~/inbox');
      await t.run('echo user=level14 > ~/inbox/request.txt');
      await t.run('echo level=15 >> ~/inbox/request.txt');
      await t.run('gatekeeper');
    },
  },
  {
    title: 'Финиш блока',
    goal:
      'Начальный блок пройден. Загляни в `readme`.\n\n' +
      'Каждый `ssh` открывает новую сессию поверх текущей, а `exit` закрывает её и возвращает туда, откуда ты пришёл.\n\n' +
      'Следующий блок — **Сеть**: интерфейсы, адреса, маршруты, etcnet в ALT, NAT и туннели. После него — SSH.',
    commands: ['cat', 'man', 'history'],
    hint: 'Можно вернуться на любой уровень и решить его иначе: например, уровень 8 через `sort | uniq -c`.',
    build: () => put('/home/level15/readme', F('Готово. Ты прошёл начальный блок shellpath.\n\nДальше — блок «Сеть»: интерфейсы, маршруты, etcnet, NAT.\n')),
  },
];

/* Команда уровня 14. Команды, нужные одному уровню, живут рядом с ним. */
register('gatekeeper', () => {
  const dir = `/home/${S.user}/inbox`;
  const file = dir + '/request.txt';
  if (!sysNode(dir)) return { err: T.gatekeeper.noDir, code: 1, note: T.gatekeeper.mkdirHint };
  const node = sysNode(file);
  if (!node || node.t !== 'f') return { err: T.gatekeeper.noFile, code: 1 };
  const m = /(\d+)$/.exec(S.user || '');
  const need = ['user=' + S.user, 'level=' + (m ? +m[1] + 1 : 1)];
  const have = lines(node.d).map((s) => s.trim()).filter(Boolean);
  const extra = have.filter((x) => !need.includes(x));
  let out = T.gatekeeper.reading;
  for (const x of need) out += `  [${have.includes(x) ? 'ok' : '!!'}] ${x}\n`;
  if (extra.length) out += T.gatekeeper.extra(extra);
  if (need.some((x) => !have.includes(x)) || extra.length) return { out: out + T.gatekeeper.denied, code: 1 };
  return { out: out + (S.user === 'level14' ? T.gatekeeper.accepted(PW[15]) : T.gatekeeper.acceptedNoPass) };
});
