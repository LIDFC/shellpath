// Склейка ES-модулей в один скрипт без зависимостей. Используется в build.mjs и в тестах.
//
// Модули склеиваются в порядке, в котором их выполнил бы браузер (обход зависимостей),
// строки import удаляются, слово export снимается. Поэтому имена верхнего уровня во всех
// модулях должны быть разными — функция это проверяет.
import { readFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const IMPORT_RE = /^import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"];?[ \t]*$/gm;
const REEXPORT_FROM_RE = /^export\s*\{[^}]*\}\s*from\s*['"]([^'"]+)['"];?[ \t]*$/gm;
const REEXPORT_RE = /^export\s*\{[^}]*\}(?:\s*from\s*['"][^'"]+['"])?;?[ \t]*$/gm;
const DECL_RE = /^(?:const|let|var|class|function\*?|async\s+function)\s+([A-Za-z_$][\w$]*)/gm;

/** @returns {Promise<{ js: string, modules: string[], names: number, problems: string[] }>} */
export async function bundle(entry = 'src/main.js') {
  const order = [];
  const seen = new Set();
  const sources = new Map();

  async function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const src = await readFile(file, 'utf8');
    sources.set(file, src);
    for (const m of src.matchAll(IMPORT_RE)) await visit(resolve(dirname(file), m[1]));
    for (const m of src.matchAll(REEXPORT_FROM_RE)) await visit(resolve(dirname(file), m[1]));
    order.push(file);
  }
  await visit(resolve(ROOT, entry));

  const declared = new Map();
  const problems = [];
  let body = '';
  for (const file of order) {
    const name = relative(ROOT, file).split('\\').join('/');
    const src = sources
      .get(file)
      .replace(IMPORT_RE, '')
      .replace(REEXPORT_RE, '')
      .replace(/^export\s+(default\s+)?/gm, '');
    for (const m of src.matchAll(DECL_RE)) {
      const prev = declared.get(m[1]);
      if (prev) problems.push(`имя «${m[1]}» объявлено и в ${prev}, и в ${name}`);
      else declared.set(m[1], name);
    }
    body += `\n// ---- ${name} ----\n${src}`;
  }
  const js = `(() => {\n'use strict';\n${body}\n})();\n`;
  try {
    new vm.Script(js, { filename: 'shellpath.bundle.js' });
  } catch (e) {
    problems.push('синтаксическая ошибка в сборке: ' + e.message);
  }
  return { js, modules: order.map((f) => relative(ROOT, f)), names: declared.size, problems };
}
