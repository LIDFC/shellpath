// Каждый уровень проходим: эталонное решение (поле solve) действительно открывает следующий.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.js';
import { LEVELS } from '../src/levels/index.js';
import { BLOCKS, BLOCK_ORDER } from '../src/core/state.js';
import { PW } from '../src/worlds/base.js';
import { C } from '../src/commands/registry.js';
import { T } from '../src/i18n/ru.js';

const t = createHarness();

test('число уровней совпадает с BLOCKS', () => {
  for (const b of BLOCK_ORDER) assert.equal(LEVELS[b].length, BLOCKS[b].max + 1, b);
});

test('у каждого уровня есть название, задание, подсказка и существующие команды', () => {
  for (const b of BLOCK_ORDER) {
    LEVELS[b].forEach((L, n) => {
      const id = `${b}/${n}`;
      assert.ok(L.title && L.goal && L.hint, id);
      for (const c of L.commands) assert.ok(C[c], `${id}: команды ${c} нет`);
      for (const c of L.commands) assert.ok(T.man[c], `${id}: нет man для ${c}`);
      if (n < BLOCKS[b].max) assert.equal(typeof L.solve, 'function', `${id}: нет эталонного решения`);
      if (b === 'net') assert.ok(L.host && L.readme, id);
    });
  }
});

for (const [n, L] of LEVELS.basic.entries()) {
  if (!L.solve) continue;
  test(`Начальный ${n}: «${L.title}» выдаёт пароль уровня ${n + 1}`, async () => {
    t.enter('basic', n);
    await L.solve(t);
    const text = t.text();
    assert.ok(text.includes(PW[n + 1]), text.slice(-400));
  });
}

for (const [n, L] of LEVELS.net.entries()) {
  if (!L.solve) continue;
  test(`Сеть ${n}: «${L.title}» проходит labcheck`, async () => {
    t.enter('net', n);
    await L.solve(t);
    const text = t.text();
    assert.ok(text.includes(`Уровень ${n} пройден`), text.slice(-600));
  });
}

for (const [n, L] of LEVELS.ssh.entries()) {
  if (!L.solve) continue;
  test(`SSH ${n}: «${L.title}» приводит в key${n + 1}`, async () => {
    t.enter('ssh', n);
    await L.solve(t);
    const text = t.text();
    assert.equal(t.S.user, 'key' + (n + 1), text.slice(-600));
  });
}
