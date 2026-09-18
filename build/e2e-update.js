'use strict';
/**
 * 真机界面测试：版本检测（v1.4.1 新增）
 *
 * 1) 顶栏有「检测更新」按钮，按钮 title 带当前版本，版本号来自服务端 /api/meta
 * 2) 进入软件自动检测一次（autoChecked），发现新版本时按钮高亮并弹提示
 * 3) 点按钮打开更新详情：当前版本 / 最新版本 / 发布时间 / 安装包 / 更新说明
 * 4) 「前往下载」把安装包地址交给系统浏览器（这里拦下 window.open 校验 URL）
 * 5) 「跳过此版本」记入本地，之后自动检测不再打扰，但仍标记有新版本
 * 6) 版本相同 / 更旧 → 提示「已是最新版本」，按钮恢复常态
 * 7) 断网、超时 → 给出友好错误提示，按钮恢复常态
 *
 * 用法：node node_modules/electron/cli.js build/e2e-update.js [端口]
 * 自己起隔离临时实例，不碰用户真实数据；GitHub 请求被 preload 换成假数据（不联网）。
 */
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('in-process-gpu');
app.disableHardwareAcceleration();

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2]) || 5396;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, '.e2e-update');
const PRELOAD = path.join(__dirname, 'e2e-update-preload.js');
const SHOT = path.join(ROOT, 'dist', 'e2e-update.png');

// 关键：localStorage（「跳过此版本」）是按 profile 持久化的，
// 用默认 profile 会让上一次跑测试留下的跳过记录影响本次「启动自动检测」的断言。
// 把 userData 指到被测数据目录下（每次 seed 都会整目录重建），保证每次都是干净环境。
app.setPath('userData', path.join(DATA, 'profile'));

let pass = 0, fail = 0;
const check = (n, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, info ? `→ ${info}` : ''); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function seed() {
  const db = {
    meta: { version: 1, createdAt: Date.now() },
    settings: { providers: [], activeProvider: null, useDemo: true, agentPersona: '', autoApply: false },
    projects: [{ id: 'p1', title: '版本检测测试', genre: '悬疑', createdAt: Date.now() }],
    outline: [], characters: [], relations: [], lines: [], beats: [], chapters: [],
    world: [], foreshadow: [], notes: [], messages: [], materials: []
  };
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'store.json'), JSON.stringify(db, null, 2));
}

function waitPort(port, tries = 60) {
  return new Promise((resolve, reject) => {
    const tick = (n) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/meta', timeout: 800 }, (res) => { res.resume(); resolve(); });
      req.on('error', () => (n <= 0 ? reject(new Error('服务未就绪')) : setTimeout(() => tick(n - 1), 300)));
      req.on('timeout', () => { req.destroy(); n <= 0 ? reject(new Error('服务未就绪')) : setTimeout(() => tick(n - 1), 300); });
    };
    tick(tries);
  });
}

let child = null;

(async () => {
  seed();
  const env = { ...process.env, NOVEL_PORT: String(PORT), NOVEL_DATA_DIR: DATA, NOVEL_EMBEDDED: '1', ELECTRON_RUN_AS_NODE: '1' };
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  await waitPort(PORT);
  console.log(`[环境] 隔离实例 ${BASE}`);

  // contextIsolation:false 才能让 preload 改写页面里的 window.fetch
  const win = new BrowserWindow({
    show: false, width: 1400, height: 900, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: false, nodeIntegration: false, preload: PRELOAD }
  });
  await win.loadURL(BASE);
  await sleep(2600);                       // 等 boot + 启动自动检测跑完
  const run = (fn) => win.webContents.executeJavaScript(`(${fn.toString()})()`);

  /* ---------------------------- 1. 启动自动检测 */
  console.log('\n== 1. 启动自动检测 ==');
  let r = await run(async () => {
    await window.__novelStudio.update.auto;
    const btn = document.getElementById('btnUpdate');
    return {
      hasBtn: !!btn,
      label: btn ? btn.textContent.trim() : '',
      cls: btn ? btn.className : '',
      title: btn ? btn.title : '',
      current: window.__novelStudio.update.state.current,
      auto: window.__novelStudio.update.state.autoChecked,
      latest: (window.__novelStudio.update.state.last || {}).latest,
      toast: (document.getElementById('toastRoot') || {}).textContent || ''
    };
  });
  check('顶栏有「检测更新」按钮', r.hasBtn === true);
  check('版本号取自服务端 /api/meta', r.current === '1.4.1', String(r.current));
  check('按钮 title 带当前版本', /v1\.4\.1/.test(r.title || ''), r.title);
  check('进入软件自动检测了一次', r.auto === true);
  check('自动检测识别出新版本', r.latest === '9.9.9', String(r.latest));
  check('按钮高亮显示新版本', /9\.9\.9/.test(r.label || '') && /has-update/.test(r.cls || ''), JSON.stringify({ l: r.label, c: r.cls }));
  check('自动检测给出提示', /发现新版本/.test(r.toast || ''), (r.toast || '').slice(0, 40));

  /* ---------------------------- 2. 更新详情弹窗 */
  console.log('\n== 2. 更新详情弹窗 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.getElementById('btnUpdate').click();
    await sleep(500);
    const modal = document.querySelector('.modal');
    return {
      hasModal: !!modal,
      title: modal ? modal.querySelector('h3').textContent.trim() : '',
      lines: [...document.querySelectorAll('.modal .upd-line')].map((el) => el.textContent.replace(/\s+/g, ' ').trim()),
      notes: (document.querySelector('.modal .upd-notes') || {}).textContent || '',
      btns: [...document.querySelectorAll('.modal-foot [data-btn]')].map((b) => b.textContent.trim())
    };
  });
  check('点按钮打开更新详情弹窗', r.hasModal === true && r.title === '发现新版本', r.title);
  check('显示当前版本与最新版本', r.lines.some((t) => /当前版本/.test(t) && /1\.4\.1/.test(t))
    && r.lines.some((t) => /最新版本/.test(t) && /9\.9\.9/.test(t)), JSON.stringify(r.lines));
  check('显示发布说明', /假更新说明/.test(r.notes || ''), (r.notes || '').slice(0, 40));
  check('显示安装包名', r.lines.some((t) => /novel-studio-setup-9\.9\.9\.exe/.test(t)), JSON.stringify(r.lines));
  check('底部有「前往下载 / 跳过此版本」', r.btns.includes('前往下载') && r.btns.includes('跳过此版本'), JSON.stringify(r.btns));

  // 截图（给作者看）：顶栏「⬆ 新版本」+ 更新详情弹窗
  try {
    win.showInactive();
    win.webContents.invalidate();
    await sleep(900);
    const img = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, img.toPNG());
    console.log(`[截图] ${SHOT}`);
    win.hide();
  } catch (e) {
    console.log('[截图跳过]', e.message);
  }

  /* ---------------------------- 3. 前往下载 */
  console.log('\n== 3. 前往下载 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    let opened = null;
    const realOpen = window.open;
    window.open = (u) => { opened = u; return null; };
    const btn = [...document.querySelectorAll('.modal-foot [data-btn]')].find((b) => /前往下载/.test(b.textContent));
    if (btn) btn.click();
    await sleep(300);
    window.open = realOpen;
    return { opened, toast: (document.getElementById('toastRoot') || {}).textContent || '' };
  });
  check('「前往下载」把安装包地址交给浏览器', /releases\/download\/v9\.9\.9\/novel-studio-setup-9\.9\.9\.exe$/.test(r.opened || ''), String(r.opened));
  check('提示已在浏览器打开', /浏览器/.test(r.toast || ''), (r.toast || '').slice(0, 30));

  /* ---------------------------- 4. 跳过此版本 */
  console.log('\n== 4. 跳过此版本 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const skip = [...document.querySelectorAll('.modal-foot [data-btn]')].find((b) => /跳过此版本/.test(b.textContent));
    if (skip) skip.click();
    await sleep(400);
    const stored = localStorage.getItem('ns_skip_update_version');
    const close = [...document.querySelectorAll('.modal-foot [data-btn]')].find((b) => /关闭/.test(b.textContent));
    if (close) close.click();
    await sleep(400);
    document.getElementById('toastRoot').innerHTML = '';
    const res = await window.__novelStudio.update.run({ silent: true });
    await sleep(400);
    return {
      stored, gone: !document.querySelector('.modal'),
      hasUpdate: !!res.hasUpdate, toast: (document.getElementById('toastRoot') || {}).textContent || '',
      label: document.getElementById('btnUpdate').textContent.trim()
    };
  });
  check('「跳过此版本」记入本地', r.stored === '9.9.9', String(r.stored));
  check('跳过后再自动检测不再打扰', !/发现新版本/.test(r.toast || ''), (r.toast || '').slice(0, 40));
  check('但仍知道有新版本（按钮保持高亮）', r.hasUpdate === true && /9\.9\.9/.test(r.label || ''), JSON.stringify({ has: r.hasUpdate, l: r.label }));
  check('详情弹窗已关闭', r.gone === true);

  /* ---------------------------- 5. 已是最新 / 更旧版本 */
  console.log('\n== 5. 已是最新版本 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    window.__updStub = { mode: 'ok', tag: 'v1.4.1' };
    document.getElementById('toastRoot').innerHTML = '';
    const same = await window.__novelStudio.update.run({ silent: false });
    await sleep(300);
    const btn = document.getElementById('btnUpdate');
    const afterSame = { hasUpdate: same.hasUpdate, label: btn.textContent.trim(), cls: btn.className, toast: document.getElementById('toastRoot').textContent };
    window.__updStub = { mode: 'ok', tag: 'v0.9.0' };
    document.getElementById('toastRoot').innerHTML = '';
    const older = await window.__novelStudio.update.run({ silent: false });
    await sleep(300);
    return { afterSame, olderHasUpdate: older.hasUpdate };
  });
  check('版本相同 → 不提示更新', r.afterSame.hasUpdate === false && !/has-update/.test(r.afterSame.cls || ''), JSON.stringify(r.afterSame));
  check('提示「已是最新版本」', /已是最新版本/.test(r.afterSame.toast || ''), (r.afterSame.toast || '').slice(0, 30));
  check('按钮恢复「检测更新」', r.afterSame.label === '检测更新', r.afterSame.label);
  check('远端版本更旧 → 也不算新版本', r.olderHasUpdate === false);

  /* ---------------------------- 6. 断网 / 超时 */
  console.log('\n== 6. 断网与超时 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    window.__updStub = { mode: 'fail' };
    document.getElementById('toastRoot').innerHTML = '';
    const net = await window.__novelStudio.update.run({ silent: false });
    await sleep(300);
    const netToast = document.getElementById('toastRoot').textContent;
    window.__updStub = { mode: 'slow' };
    document.getElementById('toastRoot').innerHTML = '';
    const slow = await window.__novelStudio.update.run({ silent: false });
    await sleep(300);
    const slowToast = document.getElementById('toastRoot').textContent;
    const btn = document.getElementById('btnUpdate');
    return {
      netOk: net.ok, netErr: net.error, netToast,
      slowErr: slow.error, slowToast,
      label: btn.textContent.trim(), modal: !!document.querySelector('.modal')
    };
  });
  check('断网时返回失败并给出提示', r.netOk === false && /检测失败/.test(r.netToast || ''), JSON.stringify({ ok: r.netOk, t: (r.netToast || '').slice(0, 40) }));
  check('超时给出「联网超时」提示', /超时/.test(r.slowErr || '') && /检测失败/.test(r.slowToast || ''), String(r.slowErr));
  check('失败后按钮恢复常态', r.label === '检测更新', r.label);
  check('失败时不弹详情窗', r.modal === false);

  /* ---------------------------- 7. 静默检测不打扰 */
  console.log('\n== 7. 自动检测静默 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    window.__updStub = { mode: 'fail' };
    document.getElementById('toastRoot').innerHTML = '';
    await window.__novelStudio.update.run({ silent: true });
    await sleep(400);
    return { toast: document.getElementById('toastRoot').textContent || '' };
  });
  check('自动检测失败时不打扰用户', (r.toast || '').trim() === '', (r.toast || '').slice(0, 30));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (child) child.kill();
  app.quit();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); if (child) child.kill(); process.exit(1); });
