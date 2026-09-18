'use strict';
/**
 * 校验「打包后的产物」里是否真的含有本轮修复。
 * 不启动应用、不碰用户数据 —— 纯读文件。
 *
 * 打包结构要点（容易看错）：
 *   server/** 与 electron/**  → resources/app.asar
 *   public/**                 → resources/public/**（extraResources，不是 asar）
 */
const asar = require('@electron/asar');
const fs = require('fs');
const path = require('path');

const U = path.join(__dirname, '..', 'dist', 'win-unpacked');
const ASAR = path.join(U, 'resources', 'app.asar');
const PUB = path.join(U, 'resources', 'public');

const fromAsar = (f) => {
  try { return asar.extractFile(ASAR, f.replace(/^\//, '')).toString('utf8'); } catch (e) { return ''; }
};
const fromRes = (f) => {
  try { return fs.readFileSync(path.join(PUB, f), 'utf8'); } catch (e) { return ''; }
};

const agent = fromRes('js/agent.js');
const css = fromRes('css/app.css');
const store = fromAsar('/server/store.js');

const rows = [
  ['前端 agent.js 用了新勾选类 .sw-check', /class="sw-check"/.test(agent)],
  ['前端 agent.js 新增模型不再抢「使用中」', /刻意不动 working\.activeProvider/.test(agent)],
  ['前端 agent.js 保存时过滤空草稿', /isBlank/.test(agent)],
  ['前端 agent.js 卡片显示「待填写」', /prov-tag/.test(agent)],
  ['样式 app.css 有 .sw-check 规则', /\.sw-check\s*\{/.test(css)],
  ['样式 app.css 有 .prov-tag 规则', /\.prov-tag\s*\{/.test(css)],
  ['服务端 store.js 迁移时清理空条目', /isBlank/.test(store)]
];

let bad = 0;
for (const [n, ok] of rows) { if (!ok) bad++; console.log(`  ${ok ? '✓' : '✗'} ${n}`); }

// 顺带确认没把测试脚本打进去
let leaked = [];
try {
  leaked = asar.listPackage(ASAR).map((f) => f.replace(/\\/g, '/'))
    .filter((f) => /\/build\/(test|e2e|shot|publish|check)/.test(f));
} catch (e) { /* ignore */ }
console.log(`  打包未混入测试/发布脚本: ${leaked.length === 0 ? '✓' : '✗ ' + leaked.join(', ')}`);
if (leaked.length) bad++;

console.log(bad ? `\n有 ${bad} 项没进包` : '\n全部修复都已在打包产物里');
process.exit(bad ? 1 : 0);
