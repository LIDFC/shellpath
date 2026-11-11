// Сборка в один файл: имена не конфликтуют, а модули запускаются в правильном порядке.
// Порядок важен: если модуль на старте обратится к чему-то, что объявлено ниже, браузер упадёт.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { bundle } from '../scripts/bundle.mjs';

/** Минимальная подмена DOM: любой элемент принимает любые вызовы. */
function fakeDom(printed) {
  const make = (id) => {
    const node = {
      id,
      hidden: false,
      dataset: {},
      style: { setProperty() {} },
      value: '',
      textContent: '',
      innerHTML: '',
      childNodes: [],
      classList: { toggle() {}, add() {}, remove() {} },
      setAttribute() {},
      removeAttribute() {},
      addEventListener() {},
      append() {},
      appendChild(child) {
        if (id === '#log') printed.push(child.textContent);
        return child;
      },
      replaceChildren() {},
      removeChild() {},
      cloneNode: () => make(),
      focus() {},
      select() {},
      setSelectionRange() {},
      querySelector: () => make(),
      querySelectorAll: () => [],
      closest: () => null,
      contains: () => false,
    };
    return node;
  };
  const cache = new Map();
  return {
    querySelector: (s) => cache.get(s) || (cache.set(s, make(s)), cache.get(s)),
    createElement: () => make(),
    addEventListener() {},
    body: make('body'),
  };
}

test('сборка без конфликтов имён и синтаксических ошибок', async () => {
  const { problems } = await bundle();
  assert.deepEqual(problems, []);
});

test('собранная игра запускается и печатает приветствие', async () => {
  const { js } = await bundle();
  const printed = [];
  const context = {
    document: fakeDom(printed),
    window: { getSelection: () => '' },
    navigator: {},
    localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (f) => f(),
    setTimeout,
    clearTimeout,
    btoa,
    atob,
    console,
  };
  vm.runInNewContext(js, context);
  assert.ok(printed.some((t) => t.includes('Вы вошли как level0')), printed.join('\n'));
});
