// Блок «Сеть»: лаборатория на ALT Server. Игрок — root на одной из машин (host).
// Дополнительно у уровня есть:
//   readme — текст для /root/readme
//   setup  — что сломать в свежей лаборатории (LAB) перед входом
//   check  — async (host) => true|false|null; вызывается командой labcheck
import { register } from '../commands/registry.js';
import { S } from '../core/state.js';
import { saveProgress } from '../core/state.js';
import { print, ask, IO } from '../core/io.js';
import { T } from '../i18n/ru.js';
import { readIn, writeIn, deleteIn, nodeIn } from '../core/fs.js';
import { LAB, labHost, bootHost, roundtrip, resolveName, linkDown, parseOpts, macOf } from '../netsim/lab.js';
import { curMeta, loginLab } from '../core/session.js';

const H = (id) => LAB.hosts[id];
/** Строка результата проверки. */
const ck = (ok, text) => {
  print(`  [${ok ? 'ok' : '!!'}] ${text}`, ok ? '' : 'err');
  return !!ok;
};
const pingOK = (from, dst, src) => roundtrip(from, dst, src).ok;
function rebootFor(hid) {
  print(T.labcheck.rebooting(hid), 'sys');
  const msgs = bootHost(H(hid), []);
  if (msgs.length) print(msgs.map((m) => T.labcheck.bootMsg(m)).join('\n'), 'err');
}

export const NET = [
  {
    title: 'Знакомство с ip',
    host: 'hq-srv',
    readme: 'Узнай три вещи и назови их команде labcheck:\n  1) IPv4-адрес интерфейса ens18 вместе с префиксом\n  2) MAC-адрес интерфейса ens19\n  3) адрес шлюза по умолчанию',
    goal:
      'Ты `root` на сервере `hq-srv` под ALT Server. Сеть в Linux смотрят командой `ip`. Узнай три вещи: адрес `ens18` с префиксом, MAC-адрес `ens19` и шлюз по умолчанию. Ответы спросит `labcheck`.\n\n' +
      'Как читать вывод `ip a`: строка `inet 192.168.1.10/24` — адрес и префикс, `link/ether` — MAC-адрес, `state UP` или `DOWN` — включён ли интерфейс. Шлюз по умолчанию — строка `default via …` в выводе `ip route`.',
    commands: ['ip', 'labcheck'],
    hint: '`ip a` (коротко: `ip -br a`), `ip link show ens19`, `ip route` (коротко: `ip r`).',
    check: async () => {
      const a1 = await ask(T.labcheck.qAddr);
      if (a1 === null) return null;
      const a2 = await ask(T.labcheck.qMac);
      if (a2 === null) return null;
      const a3 = await ask(T.labcheck.qGw);
      if (a3 === null) return null;
      return [
        ck(a1.trim() === '192.168.100.2/26', 'адрес ens18'),
        ck(a2.trim().toLowerCase() === macOf('hq-srv', 'ens19'), 'MAC ens19'),
        ck(a3.trim() === '192.168.100.1', 'шлюз по умолчанию'),
      ].every(Boolean);
    },
    solve: (t) => t.run('labcheck', ['192.168.100.2/26', macOf('hq-srv', 'ens19'), '192.168.100.1', 'n']),
  },
  {
    title: 'Интерфейс выключен',
    host: 'hq-srv',
    readme: 'ping 192.168.100.1 не проходит: кто-то выключил интерфейс ens18. Включи его.',
    setup: () => linkDown(H('hq-srv'), 'ens18'),
    goal:
      '`ping 192.168.100.1` не проходит: кто-то выключил интерфейс `ens18`. Найди это в выводе `ip a` и включи интерфейс.\n\n' +
      'Заметь: когда интерфейс выключают, ядро удаляет все маршруты через него. После включения вернётся только маршрут в свою сеть, шлюза по умолчанию не будет. Для этого уровня хватит соседа `192.168.100.1`.',
    commands: ['ip', 'ping', 'labcheck'],
    hint: '`ip link set ens18 up`, затем `ping -c 2 192.168.100.1` и `labcheck`.',
    check: async (h) => {
      const up = ck(h.rt.links.ens18.up, 'ens18 включён');
      return ck(up && pingOK('hq-srv', '192.168.100.1'), 'ping 192.168.100.1') && up;
    },
    solve: async (t) => {
      await t.run('ip link set ens18 up');
      await t.run('labcheck', ['n']);
    },
  },
  {
    title: 'Адрес и маска',
    host: 'hq-srv',
    readme: 'У ens18 нет адреса. Назначь адрес 192.168.100.2 с маской 255.255.255.192.',
    setup: () => {
      const h = H('hq-srv');
      h.rt.addrs.ens18 = [];
      h.rt.routes = [];
    },
    goal:
      'У `ens18` нет адреса. Назначь `192.168.100.2` с маской `255.255.255.192`.\n\n' +
      'Команда `ip` ждёт не маску, а префикс: число единиц в двоичной записи маски. `255.255.255.0` — это 24 единицы, то есть `/24`. ' +
      'Последний октет 192 — это `11000000`, две единицы, значит всего 24 + 2 = `/26`. В сети /26 64 адреса, из них 62 для хостов. Проверить себя поможет `ipcalc`.',
    commands: ['ipcalc', 'ip', 'ping'],
    hint: '`ipcalc 192.168.100.2 255.255.255.192` покажет префикс. Затем `ip addr add 192.168.100.2/26 dev ens18`. Ошибся — убери адрес: `ip addr del 192.168.100.2/24 dev ens18`.',
    check: async (h) => {
      const a = h.rt.addrs.ens18.find((x) => x.ip === '192.168.100.2');
      const ok1 = ck(a && a.p === 26, 'адрес 192.168.100.2/26 на ens18');
      if (a && a.p !== 26) print(T.labcheck.wrongPrefix(a.p), 'err');
      const extra = h.rt.addrs.ens18.filter((x) => x.ip !== '192.168.100.2');
      if (extra.length) print(T.labcheck.extraAddrs(extra.map((x) => x.ip + '/' + x.p).join(', ')), 'err');
      return ck(pingOK('hq-srv', '192.168.100.1'), 'ping 192.168.100.1') && ok1 && !extra.length;
    },
    solve: async (t) => {
      await t.run('ip addr add 192.168.100.2/26 dev ens18');
      await t.run('labcheck', ['n']);
    },
  },
  {
    title: 'Шлюз по умолчанию',
    host: 'hq-srv',
    readme: 'Свою сеть hq-srv видит, а до провайдера (172.16.4.1) и интернета (77.88.8.8) не достаёт. Не хватает шлюза по умолчанию. Шлюз — роутер hq-rtr, 192.168.100.1.',
    setup: () => {
      H('hq-srv').rt.routes = [];
    },
    goal:
      'Свою сеть сервер видит, а до провайдера `172.16.4.1` и интернета `77.88.8.8` не достаёт: `ping` отвечает *Network is unreachable*.\n\n' +
      'Ядро знает только сети, к которым подключено напрямую. Всё остальное отправляется на **шлюз по умолчанию** — маршрут `default`. Здесь шлюз — роутер hq-rtr, `192.168.100.1`.',
    commands: ['ip', 'ping', 'traceroute'],
    hint: '`ip route add default via 192.168.100.1`. Проверь, куда пойдёт пакет: `ip route get 77.88.8.8`, и посмотри путь: `traceroute 77.88.8.8`.',
    check: async () => {
      const a = ck(pingOK('hq-srv', '172.16.4.1'), 'ping 172.16.4.1 (провайдер)');
      const b = ck(pingOK('hq-srv', '77.88.8.8'), 'ping 77.88.8.8 (интернет)');
      return a && b;
    },
    solve: async (t) => {
      await t.run('ip route add default via 192.168.100.1');
      await t.run('labcheck', ['n']);
    },
  },
  {
    title: 'etcnet: навсегда',
    host: 'hq-srv',
    readme: 'ens18 настроен на DHCP, а DHCP-сервера в сети нет. Переведи его на статику через etcnet:\n  адрес 192.168.100.2/26, шлюз 192.168.100.1\nlabcheck перезагрузит сервер и проверит, что настройки сохранились.',
    setup: () => {
      const h = H('hq-srv');
      writeIn(h.fs, '/etc/net/ifaces/ens18/options', 'TYPE=eth\nDISABLED=no\nBOOTPROTO=dhcp\nCONFIG_IPV4=yes\n');
      deleteIn(h.fs, '/etc/net/ifaces/ens18/ipv4address');
      deleteIn(h.fs, '/etc/net/ifaces/ens18/ipv4route');
      bootHost(h);
    },
    goal:
      'Всё, что делает команда `ip`, живёт до перезагрузки. Постоянные настройки сети в ALT хранит **etcnet**: каталог `/etc/net/ifaces/<интерфейс>/` с файлами ' +
      '`options` (тип и способ настройки), `ipv4address` (адреса), `ipv4route` (маршруты) и `resolv.conf` (DNS). Применяются командой `systemctl restart network`.\n\n' +
      'Сейчас `ens18` настроен на DHCP, а DHCP-сервера в сети нет. Переведи его на статику: `192.168.100.2/26`, шлюз `192.168.100.1`. `labcheck` перезагрузит сервер.',
    commands: ['ls', 'cat', 'nano', 'systemctl'],
    hint:
      'Посмотри, что есть: `ls /etc/net/ifaces/ens18`, `cat /etc/net/ifaces/ens18/options`. В `options` замени `BOOTPROTO=dhcp` на `BOOTPROTO=static` (через `nano`). Остальное можно записать без редактора:\n\n' +
      '```\necho 192.168.100.2/26 > /etc/net/ifaces/ens18/ipv4address\necho default via 192.168.100.1 > /etc/net/ifaces/ens18/ipv4route\nsystemctl restart network\nip a\nip r\n```',
    check: async (h) => {
      rebootFor('hq-srv');
      const o = parseOpts(readIn(h.fs, '/etc/net/ifaces/ens18/options'));
      ck((o.BOOTPROTO || 'static').toLowerCase() === 'static', 'BOOTPROTO=static в options');
      const a = ck(h.rt.addrs.ens18.some((x) => x.ip === '192.168.100.2' && x.p === 26), 'после перезагрузки на ens18 адрес 192.168.100.2/26');
      return ck(pingOK('hq-srv', '77.88.8.8'), 'после перезагрузки ping 77.88.8.8') && a;
    },
    solve: async (t) => {
      await t.run('echo -e "TYPE=eth\\nDISABLED=no\\nBOOTPROTO=static\\nCONFIG_IPV4=yes" > /etc/net/ifaces/ens18/options');
      await t.run('echo 192.168.100.2/26 > /etc/net/ifaces/ens18/ipv4address');
      await t.run('echo default via 192.168.100.1 > /etc/net/ifaces/ens18/ipv4route');
      await t.run('systemctl restart network');
      await t.run('labcheck', ['n']);
    },
  },
  {
    title: 'DNS и имя хоста',
    host: 'hq-srv',
    readme: 'ping ya.ru не работает: серверу не задан DNS.\n  1) DNS-сервер 77.88.8.8 — через etcnet (resolv.conf в каталоге интерфейса)\n  2) имя хоста hq-srv.au-team.irpo\nОба должны пережить перезагрузку.',
    setup: () => {
      const h = H('hq-srv');
      deleteIn(h.fs, '/etc/net/ifaces/ens18/resolv.conf');
      writeIn(h.fs, '/etc/hostname', 'localhost.localdomain\n');
      bootHost(h);
    },
    goal:
      '`ping ya.ru` не работает: имя не во что превратить в адрес, серверу не задан DNS. Нужно две вещи.\n\n' +
      'DNS-сервер `77.88.8.8`. В ALT его пишут в `/etc/net/ifaces/ens18/resolv.conf`, а `/etc/resolv.conf` etcnet собирает сам при запуске сети. Правка `/etc/resolv.conf` руками проживёт только до перезапуска сети.\n\n' +
      'Имя хоста `hq-srv.au-team.irpo`. Его задают через `hostnamectl`, оно сохраняется в `/etc/hostname`.',
    commands: ['nano', 'systemctl', 'hostnamectl', 'ping'],
    hint: '```\necho nameserver 77.88.8.8 > /etc/net/ifaces/ens18/resolv.conf\nsystemctl restart network\ncat /etc/resolv.conf\nhostnamectl set-hostname hq-srv.au-team.irpo\nping -c 2 ya.ru\n```',
    check: async (h) => {
      rebootFor('hq-srv');
      const hn = ck(h.rt.hostname === 'hq-srv.au-team.irpo', `имя хоста hq-srv.au-team.irpo (сейчас ${h.rt.hostname})`);
      const r = resolveName(h, 'ya.ru');
      const d = ck(!r.err, 'ya.ru превращается в адрес');
      return ck(d && pingOK('hq-srv', r.ip), 'ping ya.ru') && hn && d;
    },
    solve: async (t) => {
      await t.run('echo nameserver 77.88.8.8 > /etc/net/ifaces/ens18/resolv.conf');
      await t.run('systemctl restart network');
      await t.run('hostnamectl set-hostname hq-srv.au-team.irpo');
      await t.run('labcheck', ['n']);
    },
  },
  {
    title: 'Пересылка пакетов',
    host: 'hq-rtr',
    readme: 'Ты на роутере hq-rtr. hq-srv из офисной сети 192.168.100.0/26 не достаёт до провайдера: роутер не пересылает чужие пакеты.\nВключи пересылку (net.ipv4.ip_forward) сейчас и так, чтобы она пережила перезагрузку.',
    setup: () => {
      const h = H('hq-rtr');
      writeIn(h.fs, '/etc/net/sysctl.conf', '# Параметры ядра, которые etcnet применяет при запуске сети\nnet.ipv4.ip_forward = 0\nnet.ipv4.conf.default.rp_filter = 1\nnet.ipv4.tcp_syncookies = 1\n');
      bootHost(h);
    },
    goal:
      'Теперь ты на роутере `hq-rtr`: его `ens18` смотрит к провайдеру, `ens19` — в офисную сеть `192.168.100.0/26`.\n\n' +
      'Сервер из офиса не может достучаться до провайдера: по умолчанию Linux не пересылает чужие пакеты между интерфейсами. Этим управляет параметр ядра `net.ipv4.ip_forward`: 0 — выключено, 1 — включено. Включи его сейчас и навсегда.\n\n' +
      'В ALT постоянное значение пишут в `/etc/net/sysctl.conf`: etcnet применяет его при запуске сети.',
    commands: ['sysctl', 'nano', 'ping'],
    hint:
      'Сейчас: `sysctl net.ipv4.ip_forward`, затем `sysctl -w net.ipv4.ip_forward=1`. Навсегда: в `/etc/net/sysctl.conf` поменяй строку на `net.ipv4.ip_forward = 1`. ' +
      'Применить файл сразу: `sysctl -p /etc/net/sysctl.conf`. Пакеты самого роутера ходят и без пересылки, поэтому проверку «из офиса» сделает `labcheck`: он пингует с hq-srv.',
    check: async (h) => {
      rebootFor('hq-rtr');
      const f = ck(h.rt.fwd, 'после перезагрузки net.ipv4.ip_forward = 1');
      return ck(pingOK('hq-srv', '172.16.4.1'), 'hq-srv → 172.16.4.1') && f;
    },
    solve: async (t) => {
      await t.run('sysctl -w net.ipv4.ip_forward=1');
      await t.run('echo net.ipv4.ip_forward = 1 > /etc/net/sysctl.conf');
      await t.run('labcheck', ['n']);
    },
  },
  {
    title: 'NAT',
    host: 'hq-rtr',
    readme: 'Пересылка работает, но у офиса нет интернета: адреса 192.168.100.0/26 частные, провайдер не знает обратного пути.\nНастрой маскарадинг на ens18, сохрани правила в /etc/sysconfig/iptables и включи службу iptables.',
    setup: () => {
      const h = H('hq-rtr');
      deleteIn(h.fs, '/etc/sysconfig/iptables');
      h.svc.iptables = false;
      bootHost(h);
    },
    goal:
      'Пересылка работает, а интернета у офиса нет. Адреса `192.168.100.0/26` частные: пакет до интернета дойдёт, а ответ вернуть некуда.\n\n' +
      'Роутер должен подменять адрес отправителя на свой внешний (`172.16.4.2`) и запоминать, кому вернуть ответ. Это **NAT**, а его вариант «подставь адрес выходного интерфейса» называется `MASQUERADE`. ' +
      'Правило ставят в таблицу `nat`, цепочку `POSTROUTING`: она срабатывает перед самой отправкой пакета.\n\n' +
      'Правила iptables живут в памяти. В ALT их сохраняют в `/etc/sysconfig/iptables`, а служба `iptables` загружает этот файл при старте.',
    commands: ['iptables', 'iptables-save', 'systemctl', 'ping'],
    hint:
      '```\niptables -t nat -A POSTROUTING -s 192.168.100.0/26 -o ens18 -j MASQUERADE\niptables -t nat -L -n -v\niptables-save > /etc/sysconfig/iptables\nsystemctl enable --now iptables\nping -I 192.168.100.1 77.88.8.8\n```\n\n' +
      'Цель пишется именно `MASQUERADE`: в слове легко ошибиться.',
    check: async (h) => {
      const en = ck(h.svc.iptables, 'служба iptables включена (enabled)');
      rebootFor('hq-rtr');
      const r = ck(h.rt.ipt.nat.rules.some((x) => x.chain === 'POSTROUTING' && (x.j === 'MASQUERADE' || x.j === 'SNAT')), 'после перезагрузки правило NAT на месте');
      return ck(pingOK('hq-srv', '77.88.8.8'), 'hq-srv → 77.88.8.8 (интернет)') && en && r;
    },
    solve: async (t) => {
      await t.run('iptables -t nat -A POSTROUTING -s 192.168.100.0/26 -o ens18 -j MASQUERADE');
      await t.run('iptables-save > /etc/sysconfig/iptables');
      await t.run('systemctl enable --now iptables');
      await t.run('labcheck', ['n']);
    },
  },
  {
    title: 'GRE-туннель в филиал',
    host: 'hq-rtr',
    readme: 'Офис 192.168.100.0/26 и филиал 192.168.200.0/27 должны видеть друг друга напрямую.\nНастрой GRE-туннель gre1 через etcnet:\n  TUNLOCAL 172.16.4.2, TUNREMOTE 172.16.5.2\n  адрес туннеля 10.10.0.1/30 (у br-rtr — 10.10.0.2/30, уже настроен)\n  маршрут 192.168.200.0/27 via 10.10.0.2',
    setup: () => {
      const h = H('hq-rtr');
      delete nodeIn(h.fs, '/etc/net/ifaces').c.gre1;
      bootHost(h);
    },
    goal:
      'Офис `192.168.100.0/26` и филиал `192.168.200.0/27` должны видеть друг друга напрямую. Через провайдера частные адреса не пройдут, поэтому роутеры строят **GRE-туннель**: пакеты офиса заворачиваются в пакеты между внешними адресами роутеров.\n\n' +
      'Концы туннеля: hq-rtr `172.16.4.2` и br-rtr `172.16.5.2`. На br-rtr туннель уже есть, его адрес `10.10.0.2/30`. Сделай свою сторону в etcnet: интерфейс `gre1`, адрес `10.10.0.1/30` и маршрут в сеть филиала через `10.10.0.2`.',
    commands: ['mkdir', 'nano', 'systemctl', 'ping', 'traceroute'],
    hint:
      '`mkdir /etc/net/ifaces/gre1`, затем в `nano /etc/net/ifaces/gre1/options`:\n\n' +
      "```\nTYPE=iptun\nTUNTYPE=gre\nTUNLOCAL=172.16.4.2\nTUNREMOTE=172.16.5.2\nTUNOPTIONS='ttl 64'\nHOST=ens18\nBOOTPROTO=static\nDISABLED=no\n```\n\n" +
      '```\necho 10.10.0.1/30 > /etc/net/ifaces/gre1/ipv4address\necho 192.168.200.0/27 via 10.10.0.2 > /etc/net/ifaces/gre1/ipv4route\nsystemctl restart network\nping 10.10.0.2\ntraceroute 192.168.200.2\n```',
    check: async (h) => {
      rebootFor('hq-rtr');
      const g = ck(!!h.rt.tun.gre1 && h.rt.links.gre1.up, 'после перезагрузки интерфейс gre1 поднят');
      const p = ck(g && pingOK('hq-rtr', '10.10.0.2'), 'ping 10.10.0.2 (другой конец туннеля)');
      return ck(pingOK('hq-srv', '192.168.200.2'), 'hq-srv → 192.168.200.2 (сервер филиала)') && g && p;
    },
    solve: async (t) => {
      await t.run('mkdir /etc/net/ifaces/gre1');
      await t.run('echo -e "TYPE=iptun\\nTUNTYPE=gre\\nTUNLOCAL=172.16.4.2\\nTUNREMOTE=172.16.5.2\\nHOST=ens18\\nBOOTPROTO=static\\nDISABLED=no" > /etc/net/ifaces/gre1/options');
      await t.run('echo 10.10.0.1/30 > /etc/net/ifaces/gre1/ipv4address');
      await t.run('echo 192.168.200.0/27 via 10.10.0.2 > /etc/net/ifaces/gre1/ipv4route');
      await t.run('systemctl restart network');
      await t.run('labcheck', ['n']);
    },
  },
  {
    title: 'Финиш блока',
    host: 'hq-rtr',
    readme: 'Блок «Сеть» пройден. Это песочница: ломай и чини что угодно.',
    goal:
      'Сеть собрана: адреса и маски, маршруты, etcnet, DNS, пересылка, NAT и GRE-туннель. Это базовый набор для любого роутера на ALT.\n\n' +
      'Здесь песочница: попробуй сломать и починить. Например, удали NAT и посмотри, что изменится в `traceroute 77.88.8.8`. Следующий блок — **SSH**.',
    commands: ['ip', 'iptables', 'traceroute'],
    hint: 'Посмотри весь путь до интернета: `traceroute 77.88.8.8`, и путь в филиал через туннель: `traceroute 192.168.200.2`.',
  },
];

/* labcheck — проверка текущего уровня блока. */
register('labcheck', async () => {
  const h = labHost();
  const m = curMeta();
  if (!h || m.block !== 'net') return { note: T.labcheck.onlyNet, code: 1 };
  const L = NET[m.n];
  if (!L.check) {
    print(T.labcheck.final, 'note');
    return {};
  }
  print(T.labcheck.start(m.n, L.title), 'sys');
  const res = await L.check(h);
  if (res === null) return { code: 1 };
  if (!res) {
    print(T.labcheck.notYet, 'note');
    return { code: 1 };
  }
  const next = m.n + 1;
  const isNew = next > S.u.net;
  if (isNew) {
    S.u.net = next;
    saveProgress();
  }
  print(T.labcheck.passed(m.n, isNew ? next : null), 'win');
  IO.refresh();
  const a = await ask(T.labcheck.goNext(next));
  if (a && /^(y|д)/i.test(a.trim())) {
    loginLab(next, { fresh: true });
    return { stop: true };
  }
  return {};
});
