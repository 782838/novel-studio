'use strict';
/**
 * 真实联网自检：让应用界面真的去查一次 GitHub 最新版本（**不打桩**）。
 *
 * 用来确认「检测更新」接口在本机可用：能否连通 api.github.com、能否解析、
 * 版本比较是否正确、按钮状态是否同步。启动时的自动检测与手动检测各跑一遍。
 *
 * 用法：node node_modules/electron/cli.js build/check-update-live.js [端口]
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
const PORT = Number(process.argv[2]) || 5395;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, '.e2e-live');

function seed() {
  const db = {
    meta: { version: 1, createdAt: Date.now() },
    settings: { providers: [], activeProvider: null, useDemo: true, agentPersona: '', autoApply: false },
    projects: [{ id: 'p1', title: '更新自检', genre: '悬疑', createdAt: Date.now() }],
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

  const win = new BrowserWindow({ show: false, width: 1400, height: 900, paintWhenInitiallyHidden: true });
  await win.loadURL(BASE);
  await new Promise((r) => setTimeout(r, 3500));          // 等启动自动检测跑完
  const run = (fn) => win.webContents.executeJavaScript(`(${fn.toString()})()`);

  const r = await run(async () => {
    const api = window.__novelStudio.update;
    await api.auto;                                        // 启动那次（真实网络）
    const auto = api.state.last || {};
    const manual = await api.run({ silent: false });        // 手动再查一次
    const btn = document.getElementById('btnUpdate');
    return {
      current: api.state.current,
      auto: {
        ok: auto.ok, latest: auto.latest, tag: auto.tag, hasUpdate: auto.hasUpdate,
        error: auto.error, assetName: auto.assetName, publishedAt: auto.publishedAt
      },
      manual: {
        ok: manual.ok, latest: manual.latest, tag: manual.tag, title: manual.title,
        hasUpdate: manual.hasUpdate, error: manual.error,
        assetName: manual.assetName, notesLen: (manual.notes || '').length
      },
      btn: { label: btn ? btn.textContent.trim() : '', title: btn ? btn.title : '', cls: btn ? btn.className : '' }
    };
  });

  console.log('');
  console.log('========== 「检测更新」真实联网自检 ==========');
  console.log(`当前版本（服务端 /api/meta）：${r.current}`);
  console.log(`按钮：${r.btn.label}　title=「${r.btn.title}」　class=${r.btn.cls || '(无)'}`);
  console.log('');
  console.log('① 启动时的自动检测：');
  console.log(`   ok=${r.auto.ok}　最新=${r.auto.latest || '-'}　tag=${r.auto.tag || '-'}　有新版本=${r.auto.hasUpdate}`);
  console.log(`   安装包=${r.auto.assetName || '-'}　发布时间=${r.auto.publishedAt || '-'}`);
  if (r.auto.error) console.log(`   错误：${r.auto.error}`);
  console.log('');
  console.log('② 手动检测（点按钮等价）：');
  console.log(`   ok=${r.manual.ok}　最新=${r.manual.latest || '-'}　tag=${r.manual.tag || '-'}　有新版本=${r.manual.hasUpdate}`);
  console.log(`   发布标题=${r.manual.title || '-'}　说明长度=${r.manual.notesLen || 0} 字　安装包=${r.manual.assetName || '-'}`);
  if (r.manual.error) console.log(`   错误：${r.manual.error}`);
  console.log('');

  const good = r.auto.ok === true && r.manual.ok === true;
  if (good) {
    console.log(`✅ 接口可用：已连通 GitHub 并正确解析（远端最新 v${r.manual.latest}，本地 v${r.current}，判定 hasUpdate=${r.manual.hasUpdate}）`);
  } else {
    console.log('❌ 接口不可用：请查看上面的错误信息（网络不通 / 证书问题 / 仓库不可访问）');
  }
  console.log('=============================================');

  try { win.destroy(); } catch (_) { /* ignore */ }
  if (child) child.kill();
  app.quit();
  process.exit(good ? 0 : 1);
})().catch((e) => {
  console.error('自检异常：', e && e.message);
  if (child) child.kill();
  process.exit(1);
});
