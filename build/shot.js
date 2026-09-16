'use strict';
/**
 * 用本地已缓存的 Electron 运行时驱动一个真实 Chromium，
 * 逐个视图截图，输出到 docs/images/。
 * 用法：electron build/shot.js   （需先启动工作台）
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const BASE = process.env.SHOT_URL || 'http://127.0.0.1:5377';
const OUT = path.join(__dirname, '..', 'docs', 'images');
const W = 1440, H = 900;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 无 GPU / 受限环境（VM、无桌面会话）下必须关掉硬件加速，否则 GPU 进程反复崩溃导致页面加载失败
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');

const VIEWS = [
  ['dashboard', '总览'],
  ['outline', '大纲'],
  ['characters', '角色集'],
  ['lines', '线路'],
  ['chapters', '章节'],
  ['world', '设定'],
  ['foreshadow', '伏笔'],
  ['notes', '备忘'],
  ['materials', '素材箱']
];

let fails = 0;
async function shot(win, name, label) {
  const img = await win.webContents.capturePage();
  const p = path.join(OUT, name + '.png');
  fs.writeFileSync(p, img.toPNG());
  const size = fs.statSync(p).size;
  if (img.isEmpty() || size < 4000) { fails++; console.log('  ✗ 疑似空白', name, size); }
  else console.log(`  ✓ ${name}.png  ${(size / 1024).toFixed(0)}KB  ${label || ''}`);
}

const js = (code) => win => win.webContents.executeJavaScript(code, true);

let win = null;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  win = new BrowserWindow({
    width: W, height: H,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: { backgroundThrottling: false, contextIsolation: true }
  });

  await win.loadURL(BASE);
  await wait(2200);

  console.log('[各视图]');
  for (const [key, label] of VIEWS) {
    await win.webContents.executeJavaScript(
      `(()=>{const b=document.querySelector('[data-view="${key}"]');if(b){b.click();return true}return false})()`, true
    );
    await wait(800);
    await shot(win, 'view-' + key, label);
  }

  console.log('[弹窗]');
  // 回到总览，再演示导入流程
  await win.webContents.executeJavaScript(`(()=>{document.querySelector('[data-view="dashboard"]').click()})()`, true);
  await wait(500);

  await win.webContents.executeJavaScript(`(()=>{document.getElementById('btnImport').click()})()`, true);
  await wait(600);
  await shot(win, 'import-menu', '导入菜单');

  await win.webContents.executeJavaScript(`(()=>{document.querySelector('[data-mode="txt"]').click()})()`, true);
  await wait(700);
  await shot(win, 'import-txt', '批量导入 TXT（本次新功能）');

  // 关掉弹窗
  await win.webContents.executeJavaScript(`(()=>{document.querySelectorAll('.modal-mask').forEach(m=>m.remove());document.body.classList.remove('agent-open')})()`, true);
  await wait(400);

  console.log('[设置]');
  await win.webContents.executeJavaScript(`(()=>{document.getElementById('btnSettings').click()})()`, true);
  await wait(700);
  await shot(win, 'settings', '模型设置');
  await win.webContents.executeJavaScript(`(()=>{document.querySelectorAll('.modal-mask').forEach(m=>m.remove())})()`, true);

  console.log(fails ? `\n完成，但有 ${fails} 张疑似空白` : '\n全部截图完成');
  app.quit();
});

app.on('window-all-closed', () => app.quit());
process.on('uncaughtException', (e) => { console.error('ERR', e); app.exit(1); });
