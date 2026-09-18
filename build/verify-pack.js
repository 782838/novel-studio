'use strict';
/** 只做静态检查，不启动应用、不碰真实数据目录。 */
const path = require('path');
const asar = require('@electron/asar');

const U = path.join(__dirname, '..', 'dist', 'win-unpacked', 'resources', 'app.asar');
const files = asar.listPackage(U).filter((f) => !f.endsWith('/'));

let fail = 0;
const check = (n, ok, extra = '') => {
  console.log((ok ? '  ✓ ' : '  ✗ ') + n + (extra ? ' — ' + extra : ''));
  if (!ok) fail++;
};

console.log('asar 文件数:', files.length);
for (const need of ['server/index.js', 'server/store.js', 'server/ai.js', 'server/novel-import.js', 'server/sample.js', 'electron/main.js', 'package.json']) {
  check('asar 含 ' + need, files.some((f) => f.split('\\').join('/').endsWith('/' + need)));
}
check('asar 没把 node_modules 打进去', !files.some((f) => f.includes('node_modules')));

const idx = asar.extractFile(U, 'server/index.js').toString('utf8');
check('新接口 /api/ai/memos 已打包', idx.includes('/api/ai/memos'));

const ai = asar.extractFile(U, 'server/ai.js').toString('utf8');
check('generateMemos 已打包', ai.includes('generateMemos'));
check('记忆点会注入 AI 上下文', ai.includes('剧情记忆点'));

console.log(fail ? '\n打包校验：有 ' + fail + ' 项失败' : '\n打包校验：全部通过');
process.exit(fail ? 1 : 0);
