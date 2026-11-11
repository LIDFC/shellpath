// Игра без браузера: вывод собирается в массив, на вопросы отвечает очередь answers.
import { IO, answerAsk } from '../src/core/io.js';
import { S } from '../src/core/state.js';
import { runLine } from '../src/core/shell.js';
import '../src/commands/index.js';
import { buildWorld } from '../src/levels/index.js';
import { enterLevel } from '../src/core/session.js';

export function createHarness() {
  const out = [];
  let queue = [];
  IO.print = (text) => out.push(text);
  IO.clear = () => {};
  IO.refresh = () => {};
  IO.onAsk = (a) => {
    out.push(a.label);
    answerAsk(queue.length ? queue.shift() : null);
  };
  IO.openEditor = () => Promise.resolve({ code: 0 });
  buildWorld();

  const t = {
    out,
    /** Весь вывод с прошлого вызова text(). */
    text() {
      const s = out.join('\n');
      out.length = 0;
      return s;
    },
    /** Выполнить строку; answers — ответы на вопросы (пароль, yes/no) по порядку. */
    async run(line, answers = []) {
      queue = answers.slice();
      out.push('$ ' + line);
      await runLine(line);
      if (queue.length) throw new Error(`Не все ответы использованы в «${line}»: ${queue.join(', ')}`);
    },
    enter(block, n) {
      enterLevel(block, n, {});
      out.length = 0;
    },
    S,
  };
  return t;
}
