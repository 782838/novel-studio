'use strict';
/* 真机验证「选择状态记忆」（v1.5.4）
 * 1) 复制用户 store.json 到临时数据目录（绝不碰真实数据）
 * 2) 起服务(5399) → Electron(全新 profile A) 里操作：选线路 / 折叠大纲节点 / 选第3章 / 切到设定页
 * 3) 等防抖落盘 → 读盘断言 settings.ui.selMem
 * 4) 杀服务 → 换端口(5401) 重启 → Electron(全新 profile B，localStorage 必为空)
 * 5) 断言：自动回到设定页；角色页线路筛选还原；大纲折叠还原；章节选中还原
 * 用法：node build/e2e-remember.js */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_STORE = path.join(process.env.APPDATA || '', '小说创作工作台', 'data', 'store.json');
const DATA = path.join(os.tmpdir(), 'ns-remember-e2e');
const STORE = path.join(DATA, 'store.json');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

/* 页面内驱动：phase=act 做操作并回报；phase=check 断言还原。
 * 依赖页面作用域里的 wantProjectId / LINES / parent 三个量。 */
const driver = async (phase) => {
  const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
  const nav = (v) => { document.querySelector('.nav-item[data-view="' + v + '"]').click(); };
  const wait = async (sel, t = 5000) => { const e0 = Date.now(); while (Date.now() - e0 < t) { if (document.querySelector(sel)) return true; await sleep(150); } return false; };
  const st = () => window.__novelStudio.state;
  const out = { phase };

  if (phase === 'act') {
    await wait('.nav-item');
    nav('characters');
    if (!await wait('#charLineFilter')) return Object.assign(out, { err: '无线路下拉' });
    const wantLine = LINES[2] ? LINES[2].id : LINES[0].id;
    const lineSel = document.querySelector('#charLineFilter');
    lineSel.value = wantLine;
    lineSel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(400);
    out.wantLine = wantLine;
    out.lineSet = st().sel.charLine === wantLine;

    nav('outline');
    if (!await wait('.tree-row')) return Object.assign(out, { err: '无大纲树' });
    if (parent) {
      const caret = document.querySelector('.tree-row[data-id="' + parent.id + '"] [data-act="toggle"]');
      if (caret) { caret.click(); await sleep(400); out.collapseSet = st().collapsed.has(parent.id); }
      else out.collapseSet = false;
    }

    nav('chapters');
    if (!await wait('.chapter-item')) return Object.assign(out, { err: '无章节列表' });
    const items = Array.prototype.slice.call(document.querySelectorAll('.chapter-item'));
    const pick = items[Math.min(2, items.length - 1)];
    pick.click();
    await sleep(500);
    out.chapterWant = pick.dataset.id;
    out.chapterSet = st().sel.chapterId === pick.dataset.id;

    nav('world');
    await sleep(300);
    out.viewSet = st().view === 'world';
    return out;
  }

  // check：全新 profile + 新端口，值只可能来自服务端
  await wait('.nav-item');
  await sleep(700);
  const s = st();
  out.restoredProject = s.projectId === wantProjectId;
  out.view = s.view;
  nav('characters');
  await wait('#charLineFilter');
  const ls = document.querySelector('#charLineFilter');
  out.line = ls ? ls.value : null;
  out.cardsShown = document.querySelectorAll('.char-card').length;
  nav('outline');
  await wait('.tree-row');
  out.caret = parent ? ((document.querySelector('.tree-row[data-id="' + parent.id + '"] [data-act="toggle"]') || {}).textContent || '') : null;
  out.collapsed = parent ? s.collapsed.has(parent.id) : null;
  nav('chapters');
  await wait('.chapter-item');
  const act = document.querySelector('.chapter-item.active');
  out.activeChapter = act ? act.dataset.id : null;
  out.lsKeys = Object.keys(localStorage).length;
  return out;
};

async function runElectron(tag, port, phase, vars) {
  const file = path.join(DATA, 'drive-' + tag + '.js');
  const prelude = 'const wantProjectId=' + JSON.stringify(vars.wantProjectId)
    + ';const LINES=' + JSON.stringify(vars.LINES)
    + ';const parent=' + JSON.stringify(vars.parent) + ';';
  // 页面里要执行的整段代码在 Node 侧拼好，作为一个字符串字面量注入
  const code = '(async()=>{' + prelude + 'return await (' + driver.toString() + ')(' + JSON.stringify(phase) + ')})()';
  fs.writeFileSync(file, [
    "const { app, BrowserWindow } = require('electron');",
    "['no-proxy-server','no-sandbox','disable-gpu-sandbox','in-process-gpu','disable-gpu','disable-gpu-compositing','disable-dev-shm-usage'].forEach(s=>app.commandLine.appendSwitch(s));",
    'app.disableHardwareAcceleration();',
    'app.setPath("userData", ' + JSON.stringify(path.join(DATA, 'profile-' + tag)) + ');',
    'app.whenReady().then(async () => {',
    '  const win = new BrowserWindow({ show: false, width: 1500, height: 950 });',
    '  await win.loadURL("http://127.0.0.1:' + port + '");',
    '  const sleep = (ms) => new Promise((x) => setTimeout(x, ms));',
    '  await sleep(1800);',
    '  try {',
    '    const r = await win.webContents.executeJavaScript(' + JSON.stringify(code) + ');',
    '    require("fs").writeFileSync(' + JSON.stringify(path.join(DATA, 'result-' + tag + '.json')) + ', JSON.stringify(r));',
    '  } catch (e) { require("fs").writeFileSync(' + JSON.stringify(path.join(DATA, 'result-' + tag + '.json')) + ', JSON.stringify({err: String(e && e.message)})); }',
    '  app.exit(0);',
    '});'
  ].join('\n'));
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const resFile = path.join(DATA, 'result-' + tag + '.json');
  // 本机沙箱会拦 Node 派生的 spawnSync 子进程（EBUSY，和 build/publish.js 里
  // spawnSync(git) 同因）；异步 spawn 不受影响，改用 spawn + exit 事件等待。
  const runOnce = () => new Promise((resolve) => {
    try { fs.unlinkSync(resFile); } catch (_) { }
    const child = spawn(EXE, ['--no-sandbox', '--disable-gpu', file], { env, stdio: 'ignore' });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { } }, 90000);
    child.on('exit', async () => {
      clearTimeout(t);
      await new Promise((x) => setTimeout(x, 400));
      try { resolve(JSON.parse(fs.readFileSync(resFile, 'utf8'))); } catch (_) { resolve(null); }
    });
    child.on('error', async (e) => { clearTimeout(t); console.log('[spawn err]', e.code || e.message); resolve(null); });
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await runOnce();
    if (res && !res.err) return res;
    console.log('[runElectron ' + tag + '] 第' + (attempt + 1) + '次未拿到干净结果' + (res ? '（页面报错：' + res.err + '）' : '（疑似 Chromium 网络服务崩溃/超时）'));
    spawnSync('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' });
    await new Promise((x) => setTimeout(x, 1500));   // 清残留，避开 userData 锁
  }
  try { return JSON.parse(fs.readFileSync(resFile, 'utf8')); } catch (_) { return null; }
}

const net = require('net');
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function startServer(port, dataDir) {
  const env = Object.assign({}, process.env, {
    NOVEL_PORT: String(port), NOVEL_DATA_DIR: dataDir, NOVEL_PUBLIC_DIR: path.join(ROOT, 'public')
  });
  delete env.ELECTRON_RUN_AS_NODE;
  return spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env, stdio: 'ignore' });
}
async function waitServer(port) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/api/projects'); if (r.ok) return true; } catch (_) { }
    await new Promise((x) => setTimeout(x, 250));
  }
  return false;
}
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));

async function main() {
  spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', DATA], { stdio: 'ignore' });
  fs.mkdirSync(DATA, { recursive: true });
  fs.copyFileSync(SRC_STORE, STORE);

  const db = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  // boot 会打开 lastProject（复制来的偏好），测试数据必须跟着它取，
  // 否则拿的是另一部作品的线路/节点 id，置值自然失败（首跑踩过）。
  const lastId = ((db.settings || {}).ui || {}).lastProject;
  const PROJECT = db.projects.find((p) => p.id === lastId) || db.projects[0];
  const pid = PROJECT.id;
  const LINES = (db.lines || []).filter((x) => x.projectId === pid);
  const OUTLINE = (db.outline || []).filter((x) => x.projectId === pid);
  const parent = OUTLINE.find((n) => OUTLINE.some((c) => c.parentId === n.id)) || null;
  console.log('project:', pid, '| 线路:', LINES.length, '| 折叠目标:', parent && parent.title, '| 章节:', (db.chapters || []).filter((x) => x.projectId === pid).length);

  const PORT1 = await freePort();
  let server = startServer(PORT1, DATA);
  if (!await waitServer(PORT1)) { server.kill(); throw new Error('server 未就绪'); }

  const vars = { wantProjectId: PROJECT.id, LINES, parent };
  const act = await runElectron('act', PORT1, 'act', vars);
  console.log('\n== act ==\n', JSON.stringify(act));
  if (!act || act.err) { server.kill(); process.exit(1); }

  await sleep(1600);   // persistUi 防抖 + 写盘
  const disk = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  const mem = ((disk.settings || {}).ui || {}).selMem || {};
  console.log('\n== 盘上 selMem[' + PROJECT.id + '] ==\n', JSON.stringify(mem[PROJECT.id]));

  server.kill();
  await sleep(900);
  const PORT2 = await freePort();       // 新端口 = 模拟桌面随机端口
  server = startServer(PORT2, DATA);
  if (!await waitServer(PORT2)) { server.kill(); throw new Error('server2 未就绪'); }

  const chk = await runElectron('chk', PORT2, 'check', vars);
  console.log('\n== check（端口 5401 + 全新 profile）==\n', JSON.stringify(chk));
  server.kill();

  const okAct = act.lineSet && act.chapterSet && act.viewSet;
  const okDisk = mem[PROJECT.id] && mem[PROJECT.id].view === 'world'
    && mem[PROJECT.id].sel.charLine === act.wantLine
    && mem[PROJECT.id].sel.chapterId === act.chapterWant
    && (parent ? (mem[PROJECT.id].collapsed || []).indexOf(parent.id) >= 0 : true);
  const okChk = chk && chk.restoredProject && chk.view === 'world'
    && chk.line === act.wantLine
    && chk.collapsed === true && chk.caret === '▸'
    && chk.activeChapter === act.chapterWant
    && chk.lsKeys <= 2;
  const pass = !!(okAct && okDisk && okChk);
  console.log('\nact:' + !!okAct + ' disk:' + !!okDisk + ' check:' + !!okChk);
  console.log('==== ' + (pass ? 'PASS' : 'FAIL') + ' ====');
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
