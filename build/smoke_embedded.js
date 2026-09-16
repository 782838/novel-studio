'use strict';
/**
 * 冒烟测试「嵌入式」配置：模拟 Electron 主进程设置的那些环境变量，
 * 验证服务端能随机端口启动、从 NOVEL_PUBLIC_DIR 提供静态页、按 NOVEL_DATA_DIR 读写数据。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, '.smoke');
fs.rmSync(DATA, { recursive: true, force: true });

const env = {
  ...process.env,
  NOVEL_DATA_DIR: DATA,
  NOVEL_PUBLIC_DIR: path.join(ROOT, 'public'),
  NOVEL_PORT: '0',
  NOVEL_EMBEDDED: '1'
};

const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env });
let out = '';
let done = false;

function finish(code, msg) {
  if (done) return;
  done = true;
  console.log(msg);
  try { child.kill(); } catch (_) {}
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(code);
}

child.stdout.on('data', async (d) => {
  out += d.toString();
  const m = out.match(/localhost:(\d+)/);
  if (!m || done) return;
  const port = m[1];
  console.log('检测到随机端口:', port);
  let pass = 0, fail = 0;
  const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };
  try {
    const html = await fetch(`http://127.0.0.1:${port}/`);
    const body = await html.text();
    check('首页 200', html.status === 200, 'status=' + html.status);
    check('首页内容是工作台 HTML', body.includes('novel-studio') || body.includes('app.js'), body.slice(0, 60));
    const css = await fetch(`http://127.0.0.1:${port}/css/app.css`);
    check('静态 css 200（来自 NOVEL_PUBLIC_DIR）', css.status === 200, 'status=' + css.status);
    const meta = await (await fetch(`http://127.0.0.1:${port}/api/meta`)).json();
    check('API /api/meta 可用', !!meta && !!meta.typeLabel);
    const proj = await (await fetch(`http://127.0.0.1:${port}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '冒烟' }) })).json();
    check('能在 NOVEL_DATA_DIR 建项目', !!proj.id, JSON.stringify(proj));
    await new Promise((r) => setTimeout(r, 700)); // store 是 ~150ms 防抖写盘
    check('数据写到了指定目录', fs.existsSync(path.join(DATA, 'store.json')));
  } catch (e) {
    fail++; console.log('  ✗ 请求异常', e.message);
  }
  finish(fail ? 1 : 0, `\n嵌入式冒烟：${pass} 通过 / ${fail} 失败`);
});

child.stderr.on('data', (d) => process.stderr.write(d));
setTimeout(() => finish(1, '超时：服务端未在 15s 内就绪\n' + out), 15000);
