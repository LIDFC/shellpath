// Сборка в один файл dist/shellpath.html без зависимостей.
// Такой файл открывается двойным щелчком (file://) и подходит для GitHub Pages.
//
//   node scripts/build.mjs          собрать
//   node scripts/build.mjs --check  только проверить (имена, синтаксис), ничего не записывать
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bundle, ROOT } from './bundle.mjs';

const CHECK = process.argv.includes('--check');
const { js, modules, names, problems } = await bundle();

if (problems.length) {
  console.error('Сборка не удалась:\n  ' + problems.join('\n  '));
  console.error('\nЕсли совпали имена — переименуйте одно из них: при склейке модули делят одну область видимости.');
  process.exit(1);
}
if (CHECK) {
  console.log(`Проверка пройдена: ${modules.length} модулей, ${names} имён.`);
  process.exit(0);
}

const css = await readFile(resolve(ROOT, 'styles/main.css'), 'utf8');
let html = await readFile(resolve(ROOT, 'index.html'), 'utf8');
html = html.replace('<link rel="stylesheet" href="styles/main.css">', () => `<style>\n${css}</style>`);
html = html.replace('<script type="module" src="src/main.js"></script>', () => `<script>\n${js.replace(/<\/script/gi, '<\\/script')}</script>`);
await mkdir(resolve(ROOT, 'dist'), { recursive: true });
await writeFile(resolve(ROOT, 'dist/shellpath.html'), html);
await writeFile(resolve(ROOT, 'dist/index.html'), html);
console.log(`Готово: dist/shellpath.html (${(html.length / 1024).toFixed(0)} КБ, ${modules.length} модулей)`);
