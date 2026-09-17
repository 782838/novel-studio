'use strict';
/**
 * 对「打包后的桌面应用」做冒烟测试。
 * 端口从应用自己写的 startup.log 里读（不依赖 tasklist/netstat，避免环境差异）。
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const U = path.join(__dirname, '..', 'dist', 'win-unpacked');
const EXE = path.join(U, '小说创作工作台.exe');
const userData = path.join(process.env.APPDATA || '', '小说创作工作台');
const logFile = path.join(userData, 'startup.log');
const storeFile = path.join(userData, 'data', 'store.json');

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --- 1) asar 内容 --- */
try {
  const asar = require('@electron/asar');
  const files = asar.listPackage(path.join(U, 'resources', 'app.asar'));
  files.filter((f) => !f.endsWith('/')).forEach((f) => console.log('   asar:', f));
  for (const need of ['server/index.js', 'server/store.js', 'server/ai.js', 'server/novel-import.js', 'server/sample.js', 'electron/main.js']) {
    check('asar 含 ' + need, files.some((f) => f.replace(/\\/g, '/').endsWith('/' + need)));
  }
  check('asar 没把 node_modules 打进去', !files.some((f) => f.includes('node_modules')));
} catch (e) { console.log('(asar 列表跳过:', e.message, ')'); }

/* --- 2) 启动应用 --- */
// 注意：绝不删除 userData —— 里面是用户在安装版里写的真实作品数据。
// 只清掉上次冒烟留下的 startup.log，保证端口是本次新写的。
console.log('\n[启动] ' + EXE);
if (fs.existsSync(logFile)) fs.rmSync(logFile, { force: true });
// 宿主环境带了 ELECTRON_RUN_AS_NODE=1，会让 Electron 退化成纯 Node，必须剔除
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
// 在受限环境（CI / 沙箱 / 远程会话）里 Chromium 的沙箱和 GPU 进程会直接崩掉整个应用，
// 表现为「窗口创建后就退出」，于是端口连不上、冒烟失败。加这几个开关让它在受限环境也能起来。
// 用户正常双击启动时不需要这些参数，也不受影响。
const args = ['--no-sandbox', '--in-process-gpu', '--disable-gpu-sandbox', '--disable-gpu'];
const child = spawn(EXE, args, { detached: true, stdio: 'ignore', env: childEnv });
child.unref();
const pid = child.pid;
console.log('  pid =', pid);

(async () => {
  /* --- 3) 等它自己把端口写进日志 --- */
  let port = null;
  for (let i = 0; i < 30 && !port; i++) {
    await sleep(600);
    if (!fs.existsSync(logFile)) continue;
    const m = fs.readFileSync(logFile, 'utf8').match(/server started on port (\d+)/);
    if (m) port = m[1];
  }
  const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  check('应用已启动内嵌服务端', !!port, port ? '' : '\n' + (logText || '(无 startup.log)'));
  check('已创建应用窗口', /window created/.test(logText));
  check('启动过程没有报错', !/STARTUP FAILED|uncaughtException/.test(logText),
    logText.split('\n').filter((l) => /FAILED|Exception/.test(l)).join('\n'));

  /* --- 4) 真的能用 HTTP 访问到（即窗口能加载出内容）--- */
  if (port) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      const body = await r.text();
      check('窗口首页可访问', r.status === 200 && body.includes('app.js'), 'status=' + r.status);
      const meta = await (await fetch(`http://127.0.0.1:${port}/api/meta`)).json();
      check('API /api/meta 正常', !!meta.typeLabel);
      const ps = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json();
      check('首次运行自动铺了示例作品', ps.length >= 1, 'projects=' + ps.length + ' ' + ps.map((p) => p.title).join(','));
      const prev = await (await fetch(`http://127.0.0.1:${port}/api/novel/preview/batch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: [{ content: '第一章 起\n正文一。\n\n第二章 承\n正文二。', name: 't.txt' }] })
      })).json();
      check('批量分章预览接口可用（本次新功能）', !!(prev.files && prev.files[0].chapterCount === 2));
      const mg = await (await fetch(`http://127.0.0.1:${port}/api/projects/import/novel/merge`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useAI: false, title: '打包合并测试', files: [{ content: '第一章 A\n甲\n\n第二章 B\n乙', fileName: '卷一' }] })
      })).json();
      check('合并导入接口可用（本次新功能）', !!(mg.project && mg.volumes === 1));
    } catch (e) { check('HTTP 请求', false, e.message); }
  }

  await sleep(700);
  check('数据写进 %APPDATA%\\小说创作工作台', fs.existsSync(storeFile));

  console.log('\n[结束] 关闭应用');
  try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'pipe' }); } catch (_) { /* ignore */ }

  console.log(`\n打包冒烟：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
