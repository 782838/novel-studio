'use strict';
/**
 * 桌面端主进程。
 * 把原有的零依赖 Node 服务直接嵌进来跑，再用原生窗口加载它，
 * 因此目标电脑不需要安装 Node，也不需要任何浏览器，更不依赖 WorkBuddy。
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');

const APP_TITLE = '小说创作工作台';

// 只允许开一个实例，第二个实例激活已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let srv = null;

/** 把启动过程写进日志文件，便于用户排查（打包后没有控制台） */
function logLine(msg) {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'startup.log'),
      `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) { /* ignore */ }
}

/** 打包后静态资源在 resources/public；开发时在项目根 public */
function publicDir() {
  const packaged = path.join(process.resourcesPath || '', 'public');
  if (app.isPackaged && fs.existsSync(path.join(packaged, 'index.html'))) return packaged;
  return path.join(__dirname, '..', 'public');
}

/** 数据目录放在用户目录，避免写进只读的安装目录 */
function dataDir() {
  return path.join(app.getPath('userData'), 'data');
}

/** 启动内嵌服务并返回实际端口 */
async function startServer() {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });

  process.env.NOVEL_DATA_DIR = dir;
  process.env.NOVEL_PUBLIC_DIR = publicDir();
  process.env.NOVEL_PORT = '0';         // 0 = 由系统分配空闲端口，避免端口冲突
  process.env.NOVEL_EMBEDDED = '1';     // 出错时不要 process.exit 掉整个应用

  srv = require('../server/index.js');
  await new Promise((resolve, reject) => {
    if (srv.listening) return resolve();
    srv.once('listening', resolve);
    srv.once('error', reject);
  });

  // 首次运行：数据目录为空时铺一份示例作品，避免开局一片空白
  try {
    const store = require('../server/store');
    if (store.load().projects.length === 0) {
      require('../server/sample').seedSampleProject();
      store.flush();
    }
  } catch (_) { /* 示例载入失败不影响使用 */ }

  return srv.address().port;
}

function createWindow(port) {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    title: APP_TITLE,
    backgroundColor: '#f6f7fb',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  // 外部链接交给系统浏览器，不要在应用窗口里跳走
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.includes('127.0.0.1')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  win.loadURL(`http://127.0.0.1:${port}/`);
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  try { srv && srv.close(); } catch (_) { /* ignore */ }
});

app.whenReady().then(async () => {
  logLine('app ready; packaged=' + app.isPackaged + ' resourcesPath=' + process.resourcesPath);
  Menu.setApplicationMenu(null);
  try {
    const port = await startServer();
    logLine('server started on port ' + port + '; dataDir=' + dataDir() + '; publicDir=' + publicDir());
    createWindow(port);
    logLine('window created');
  } catch (err) {
    const msg = String((err && err.stack) || err);
    logLine('STARTUP FAILED: ' + msg);
    try { dialog.showErrorBox(`${APP_TITLE} 启动失败`, msg); } catch (_) { /* ignore */ }
    app.quit();
  }
});

process.on('uncaughtException', (err) => {
  logLine('uncaughtException: ' + String((err && err.stack) || err));
});
process.on('exit', (code) => logLine('exit code=' + code));
