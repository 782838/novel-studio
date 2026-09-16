'use strict';
/** 前端是原生 ES Module，node --check 默认按 CJS 解析会误报；拷成 .mjs 再检查。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJ = path.join(__dirname, '..');
const files = ['public/js/app.js', 'public/js/views.js', 'public/js/api.js', 'public/js/ui.js', 'public/js/agent.js', 'public/js/importer.js'];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eschk-'));
let bad = 0;
for (const f of files) {
  const dst = path.join(dir, path.basename(f).replace(/\.js$/, '.mjs'));
  fs.copyFileSync(path.join(PROJ, f), dst);
  const r = spawnSync(process.execPath, ['--check', dst], { encoding: 'utf8' });
  if (r.status === 0) console.log('OK  ', f);
  else { bad++; console.log('FAIL', f, '\n', r.stderr); }
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? `\n${bad} 个文件语法有误` : '\n前端模块全部 OK');
process.exit(bad ? 1 : 0);
