// Топология лаборатории блока «Сеть». Адресация как в демоэкзамене (au-team.irpo).
//
//   [inet] ─ wan ─ [isp] ─ isp-hq ─ [hq-rtr] ─ hq-lan ─ [hq-srv]
//                    │                 ║ gre1
//                    └── isp-br ─ [br-rtr] ─ br-lan ─ [br-srv]
//
// Каждая машина описывается так, как её настроил бы администратор в etcnet.
// Уровни потом что-то ломают (setup в src/levels/net.js).

export const OSNAME = 'ALT Server 10.4 (Mendelevium)';
export const KERNEL = '6.1.112-un-def-alt1';

/** DNS-серверы, которые отвечают на запросы, и известные им имена. */
export const DNS_SERVERS = ['77.88.8.8', '8.8.8.8'];
export const DNS_ZONE = {
  'ya.ru': '77.88.55.242',
  'yandex.ru': '77.88.55.242',
  'altlinux.org': '194.87.0.50',
  'basealt.ru': '194.87.0.50',
};

/**
 * seg — сегмент сети (провод). Интерфейсы с одинаковым seg видят друг друга.
 * nat — правила для /etc/sysconfig/iptables, fwd — net.ipv4.ip_forward.
 */
export const LABSPEC = {
  inet: {
    hostname: 'inet',
    ifaces: [{ n: 'eth0', seg: 'wan', addr: ['203.0.113.1/24', '77.88.8.8/32', '8.8.8.8/32', '77.88.55.242/32', '194.87.0.50/32'] }],
  },
  isp: {
    hostname: 'isp',
    fwd: 1,
    nat: ['-A POSTROUTING -s 172.16.0.0/12 -o ens18 -j MASQUERADE'],
    ifaces: [
      { n: 'ens18', seg: 'wan', addr: ['203.0.113.2/24'], route: ['default via 203.0.113.1'], dns: ['nameserver 77.88.8.8'] },
      { n: 'ens19', seg: 'isp-hq', addr: ['172.16.4.1/28'] },
      { n: 'ens20', seg: 'isp-br', addr: ['172.16.5.1/28'] },
    ],
  },
  'hq-rtr': {
    hostname: 'hq-rtr.au-team.irpo',
    fwd: 1,
    nat: ['-A POSTROUTING -s 192.168.100.0/26 -o ens18 -j MASQUERADE'],
    ifaces: [
      { n: 'ens18', seg: 'isp-hq', addr: ['172.16.4.2/28'], route: ['default via 172.16.4.1'], dns: ['nameserver 77.88.8.8'] },
      { n: 'ens19', seg: 'hq-lan', addr: ['192.168.100.1/26'] },
      { n: 'gre1', tun: { local: '172.16.4.2', remote: '172.16.5.2' }, addr: ['10.10.0.1/30'], route: ['192.168.200.0/27 via 10.10.0.2'] },
    ],
  },
  'br-rtr': {
    hostname: 'br-rtr.au-team.irpo',
    fwd: 1,
    nat: ['-A POSTROUTING -s 192.168.200.0/27 -o ens18 -j MASQUERADE'],
    ifaces: [
      { n: 'ens18', seg: 'isp-br', addr: ['172.16.5.2/28'], route: ['default via 172.16.5.1'], dns: ['nameserver 77.88.8.8'] },
      { n: 'ens19', seg: 'br-lan', addr: ['192.168.200.1/27'] },
      { n: 'gre1', tun: { local: '172.16.5.2', remote: '172.16.4.2' }, addr: ['10.10.0.2/30'], route: ['192.168.100.0/26 via 10.10.0.1'] },
    ],
  },
  'hq-srv': {
    hostname: 'hq-srv.au-team.irpo',
    ifaces: [
      { n: 'ens18', seg: 'hq-lan', addr: ['192.168.100.2/26'], route: ['default via 192.168.100.1'], dns: ['search au-team.irpo', 'nameserver 77.88.8.8'] },
      { n: 'ens19', seg: null, noconf: true }, // второй сетевой адаптер, кабель не подключён
    ],
  },
  'br-srv': {
    hostname: 'br-srv.au-team.irpo',
    ifaces: [{ n: 'ens18', seg: 'br-lan', addr: ['192.168.200.2/27'], route: ['default via 192.168.200.1'], dns: ['nameserver 77.88.8.8'] }],
  },
};
