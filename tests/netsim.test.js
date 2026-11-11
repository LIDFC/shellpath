// Симулятор сети: маршрутизация, NAT, сохранение настроек.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.js';
import { roundtrip, LAB } from '../src/netsim/lab.js';
import { mask2p, parseCidr } from '../src/netsim/ip.js';

const t = createHarness();

test('маска ↔ префикс', () => {
  assert.equal(mask2p('255.255.255.192'), 26);
  assert.equal(mask2p('255.255.0.255'), null);
  assert.deepEqual(parseCidr('10.0.0.5/255.255.255.0'), { ip: '10.0.0.5', p: 24 });
});

test('в собранной лаборатории всё работает: офис, интернет, филиал', () => {
  t.enter('net', 9);
  assert.ok(roundtrip('hq-srv', '77.88.8.8').ok);
  assert.ok(roundtrip('hq-srv', '192.168.200.2').ok);
  assert.ok(roundtrip('br-srv', '192.168.100.2').ok);
});

test('без NAT ответ из интернета не возвращается', async () => {
  t.enter('net', 9);
  await t.run('iptables -t nat -F');
  assert.equal(roundtrip('hq-srv', '77.88.8.8').ok, false);
  assert.ok(roundtrip('hq-rtr', '77.88.8.8').ok, 'сам роутер выходит через NAT провайдера');
});

test('опечатка в цели iptables даёт настоящую ошибку', async () => {
  t.enter('net', 7);
  await t.run('iptables -t nat -A POSTROUTING -o ens18 -j MASQUEARADE');
  assert.match(t.text(), /Couldn't load target `MASQUEARADE'/);
});

test('reboot сбрасывает то, что не записано в файлы', async () => {
  t.enter('net', 3);
  await t.run('ip route add default via 192.168.100.1');
  assert.ok(roundtrip('hq-srv', '77.88.8.8').ok);
  await t.run('reboot');
  // В уровне 3 маршрут убран только из памяти, в etcnet он есть — после перезагрузки вернётся.
  assert.ok(LAB.hosts['hq-srv'].rt.routes.some((r) => r.p === 0));
  t.enter('net', 4);
  await t.run('reboot');
  assert.equal(LAB.hosts['hq-srv'].rt.addrs.ens18.length, 0, 'DHCP без сервера адреса не даёт');
});

test('шлюз вне своей сети отвергается', async () => {
  t.enter('net', 3);
  await t.run('ip route add default via 10.9.9.9');
  assert.match(t.text(), /Nexthop has invalid gateway/);
});
