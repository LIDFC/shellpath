// Связь игровой логики с интерфейсом. Логика пишет сюда, интерфейс (или тесты) подставляют реализацию.
import { S } from './state.js';

export const CANCEL = Symbol('cancel');

export const IO = {
  /** Вывести строку. cls: '' | 'err' | 'note' | 'sys' | 'win' */
  print(_text, _cls) {},
  clear() {},
  /** Перерисовать боковую панель и приглашение. */
  refresh() {},
  /** Показан вопрос (пароль, yes/no). */
  onAsk(_ask) {},
  /** Открыть редактор. Должен вернуть Promise, который выполнится при выходе из редактора. */
  openEditor(_file) {
    return Promise.resolve({ code: 0 });
  },
};

export function print(text, cls) {
  if (text == null || text === '') return;
  IO.print(String(text).replace(/\n$/, ''), cls || '');
}

/** Спросить у игрока строку. Возвращает null, если он нажал Ctrl+C. */
export function ask(label, secret = false) {
  return new Promise((res, rej) => {
    S.ask = { label, secret, res, rej };
    IO.onAsk(S.ask);
  });
}

export function answerAsk(value) {
  const a = S.ask;
  if (!a) return;
  S.ask = null;
  a.res(value);
}

/** Прервать вопрос без ответа (переход на другой уровень). */
export function cancelAsk() {
  const a = S.ask;
  if (!a) return;
  S.ask = null;
  a.rej(CANCEL);
}
