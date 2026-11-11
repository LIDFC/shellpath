// Реестр команд. Команда: (args, ctx) => { out?, err?, note?, code?, action?, stop? } или Promise с тем же.
// ctx.stdin — данные из конвейера (или null), ctx.tty — вывод идёт прямо на экран.
// Справки для man лежат в src/i18n/ru.js, в T.man.

export const C = {};

export function register(name, fn) {
  C[name] = fn;
}

/**
 * Дополнение аргументов по Tab, как bash-completion.
 * fn(args, cur): args — слова после имени команды до текущего, cur — текущее слово.
 * Возвращает массив вариантов или null — тогда дополняются имена файлов.
 */
export const COMPLETERS = {};

export function registerCompleter(names, fn) {
  for (const n of [].concat(names)) COMPLETERS[n] = fn;
}
