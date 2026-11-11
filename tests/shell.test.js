// Оболочка: кавычки, конвейеры, перенаправления, дополнение по Tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.js';
import { tokenize, parse, complete } from '../src/core/shell.js';

const t = createHarness();

test('кавычки и экранирование склеивают слово', () => {
  t.enter('basic', 0);
  assert.deepEqual(tokenize('cat "a b" c\\ d \'e f\'').map((x) => x.v), ['cat', 'a b', 'c d', 'e f']);
});

test('конвейер и перенаправления разбираются', () => {
  const seq = parse(tokenize('sort f | uniq -u > out 2>/dev/null; echo ok'));
  assert.equal(seq.length, 2);
  assert.equal(seq[0].pipe.length, 2);
  assert.deepEqual(seq[0].pipe[1].redirs.map((r) => r.r), ['>', '2>']);
});

test('>> дописывает, > перезаписывает', async () => {
  t.enter('basic', 14);
  await t.run('echo один > f.txt');
  await t.run('echo два >> f.txt');
  t.text();
  await t.run('cat f.txt');
  assert.match(t.text(), /один\nдва/);
  await t.run('echo три > f.txt');
  t.text();
  await t.run('cat f.txt');
  assert.doesNotMatch(t.text(), /один/);
});

test('Tab не подставляет имя файла по пустому слову, а показывает список', () => {
  t.enter('basic', 0);
  assert.deepEqual(complete('cat ', 4), { list: ['readme'] });
});

test('Tab дополняет одно совпадение и не повторяет его', () => {
  t.enter('basic', 0);
  const r = complete('cat re', 6);
  assert.deepEqual(r, { value: 'cat readme ', pos: 11 });
  assert.ok(!complete(r.value, r.pos)?.value, 'повторный Tab не дописывает имя второй раз');
});

test('без кавычек Tab останавливается перед пробелом', () => {
  t.enter('basic', 2);
  assert.deepEqual(complete('cat sp', 6), { value: 'cat spaces', pos: 10 });
  assert.deepEqual(complete('cat "sp', 7), { value: 'cat "spaces in this filename" ', pos: 30 });
});

test('скрытые файлы дополняются только после точки', () => {
  t.enter('basic', 3);
  assert.equal(complete('cat inhere/', 11), null);
  assert.equal(complete('cat inhere/.', 12).value, 'cat inhere/...Hiding-From-You ');
});

test('cat - подсказывает про ./-', async () => {
  t.enter('basic', 1);
  await t.run('cat -');
  assert.match(t.text(), /\.\/-/);
});

const tab = (line) => {
  const r = complete(line, line.length);
  return r?.value ?? r?.list ?? null;
};

test('Tab в лаборатории: ip, интерфейсы, systemctl, iptables', () => {
  t.enter('net', 1);
  assert.equal(tab('ip li'), 'ip link ');
  assert.deepEqual(tab('ip link s'), ['show', 'set']);
  assert.equal(tab('ip link se'), 'ip link set ');
  assert.equal(tab('ip link set en'), 'ip link set ens1');
  assert.deepEqual(tab('ip link set ens1'), ['ens18', 'ens19']);
  assert.equal(tab('ip link set ens18 u'), 'ip link set ens18 up ');
  assert.equal(tab('ip route add d'), 'ip route add default ');
  assert.equal(tab('ip route add default v'), 'ip route add default via ');
  assert.equal(tab('systemctl rest'), 'systemctl restart ');
  assert.equal(tab('systemctl restart net'), 'systemctl restart network ');
  assert.equal(tab('iptables -t n'), 'iptables -t nat ');
  assert.equal(tab('iptables -t nat -A PO'), 'iptables -t nat -A POSTROUTING ');
  assert.equal(tab('iptables -t nat -A POSTROUTING -o en'), 'iptables -t nat -A POSTROUTING -o ens1');
  assert.equal(tab('iptables -t nat -A POSTROUTING -j MA'), 'iptables -t nat -A POSTROUTING -j MASQUERADE ');
  assert.equal(tab('sysctl net.ipv4.ip_f'), 'sysctl net.ipv4.ip_forward ');
  assert.equal(tab('cat /etc/net/if'), 'cat /etc/net/ifaces/');
  assert.equal(tab('nano /etc/net/ifaces/ens18/op'), 'nano /etc/net/ifaces/ens18/options ');
});

test('Tab для ssh берёт хосты из known_hosts', () => {
  t.enter('ssh', 5);
  assert.equal(tab('ssh key6@ba'), 'ssh key6@backup ');
  assert.equal(tab('ssh-keygen -R ba'), 'ssh-keygen -R backup ');
  assert.equal(tab('man ssh-k'), 'man ssh-keygen ');
});
