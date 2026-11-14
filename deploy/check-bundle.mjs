// Проверка собранного интерфейса на совместимость с Chrome 75:
// нет синтаксиса ES2020+ (?. ?? ||= &&=) и новых API. node deploy/check-bundle.mjs web/dist/assets
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || 'web/dist/assets';
const files = fs.readdirSync(dir).filter((f) => /\.js$/.test(f));
const SYNTAX = [/\?\.[A-Za-z_$[(]/, /\?\?=?/, /\|\|=|&&=/, /\bstatic\s*\{/];
const APIS = ['replaceAll(', '.at(', 'structuredClone', 'allSettled', 'Object.hasOwn', 'findLast('];
let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const re of SYNTAX) {
    const m = re.exec(src);
    if (m) {
      bad++;
      console.log(`${f}: синтаксис новее Chrome 75 (${re}) — …${src.slice(Math.max(0, m.index - 40), m.index + 30)}…`);
    }
  }
  for (const a of APIS) {
    if (src.indexOf(a) >= 0) {
      bad++;
      console.log(`${f}: API новее Chrome 75: ${a}`);
    }
  }
}
console.log(bad ? `Найдено проблем: ${bad}` : `Chrome 75: проверено файлов ${files.length}, проблем нет`);
process.exit(bad ? 1 : 0);
