'use strict';
/**
 * 真机界面测试：多自定义 AI 设置弹窗
 *
 * 复现用户操作路径：
 *   1) 旧版单配置的 store.json → 打开设置，应自动迁移成 1 个模型
 *   2) 点「+ 添加」新增第二个模型并填写 → 保存
 *   3) 落盘后检查：第一个模型的 Key / 接口 / 模型名 必须还在（不能因为新增就被清空）
 *   4) 重新打开设置：两个模型都应在列表里、都能分别切换编辑
 *   5) 布局回归：勾选项文字不能挤成一列（曾经复用了章节列表的 .check 类）
 *
 * 用法：
 *   node build/e2e-settings.js [端口]
 * 需要 electron 二进制（node_modules/electron/dist/electron.exe）。
 * 脚本自己起一个隔离的临时实例（临时数据目录），不会碰用户真实数据。
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
const PORT = Number(process.argv[2]) || 5394;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, '.e2e-settings');
const SHOT = path.join(ROOT, 'dist', 'e2e-settings.png');

let pass = 0, fail = 0;
const check = (n, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, info ? `→ ${info}` : ''); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function seedLegacy() {
  const legacy = {
    meta: { version: 1, createdAt: Date.now() },
    settings: {
      provider: 'custom',
      endpoint: 'https://first.example.com/v1',
      apiKey: 'sk-FIRST-KEY',
      model: 'first-model',
      temperature: 0.85,
      maxTokens: 4096,
      agentPersona: ''
    },
    projects: [], outline: [], characters: [], relations: [], lines: [],
    beats: [], chapters: [], world: [], foreshadow: [], notes: [], messages: [], materials: []
  };
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'store.json'), JSON.stringify(legacy, null, 2));
}

function onDisk() {
  const j = JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8'));
  const s = j.settings || {};
  return { providers: s.providers || [], activeProvider: s.activeProvider || null };
}

function waitPort(port, tries = 60) {
  return new Promise((resolve, reject) => {
    const tick = (n) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/settings', timeout: 800 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => (n <= 0 ? reject(new Error('服务未就绪')) : setTimeout(() => tick(n - 1), 300)));
      req.on('timeout', () => { req.destroy(); n <= 0 ? reject(new Error('服务未就绪')) : setTimeout(() => tick(n - 1), 300); });
    };
    tick(tries);
  });
}

let child = null;

(async () => {
  // ---- 起隔离实例
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  seedLegacy();
  const env = { ...process.env, NOVEL_PORT: String(PORT), NOVEL_DATA_DIR: DATA, NOVEL_EMBEDDED: '1' };
  // 让子进程用 electron.exe 以「纯 Node」方式跑服务端，省得依赖外部 node 路径
  env.ELECTRON_RUN_AS_NODE = '1';
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT, env, stdio: 'ignore', windowsHide: true
  });
  await waitPort(PORT);
  console.log(`[环境] 隔离实例 ${BASE}（数据目录 ${DATA}）`);

  const win = new BrowserWindow({ show: false, width: 1500, height: 980, paintWhenInitiallyHidden: true });
  await win.loadURL(BASE);
  await sleep(1400);
  const run = (fn) => win.webContents.executeJavaScript(`(${fn.toString()})()`);

  /* ---------------------------------------- 1. 旧配置迁移 */
  console.log('\n== 1. 旧版单配置自动迁移 ==');
  let r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.getElementById('btnSettings').click();
    await sleep(500);
    const cards = [...document.querySelectorAll('#providerList .prov-card')];
    const c = cards[0];
    return {
      count: cards.length,
      name: c ? c.querySelector('b').textContent.trim() : '',
      sub: c ? c.querySelector('.prov-sub').textContent.trim() : '',
      endpoint: (document.getElementById('peEndpoint') || {}).value || '',
      key: (document.getElementById('peKey') || {}).value || '',
      model: (document.getElementById('peModel') || {}).value || ''
    };
  });
  check('迁移出 1 个模型', r.count === 1, `count=${r.count}`);
  check('第一个模型的接口/Key/模型名都还在',
    r.endpoint === 'https://first.example.com/v1' && r.key === 'sk-FIRST-KEY' && r.model === 'first-model',
    `endpoint=${r.endpoint} key=${r.key} model=${r.model}`);

  /* ---------------------------------------- 2. 新增第二个模型并保存 */
  console.log('\n== 2. 新增第二个模型 → 保存 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const setVal = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    document.getElementById('btnAddProvider').click();
    await sleep(400);
    const cards = [...document.querySelectorAll('#providerList .prov-card')];
    // 关键：新增空白模型不能把"使用中"顶掉，否则用户会以为已有配置被清空
    const activeCard = cards.find((c) => c.classList.contains('active'));
    const newCard = cards[cards.length - 1];
    const added = {
      count: cards.length,
      activeName: activeCard ? activeCard.querySelector('b').textContent.trim() : '',
      newHasDraftTag: !!newCard.querySelector('.prov-tag'),
      newActive: newCard.classList.contains('active')
    };
    setVal(document.getElementById('peName'), '我的智谱');
    setVal(document.getElementById('peEndpoint'), 'https://second.example.com/v1');
    setVal(document.getElementById('peKey'), 'sk-SECOND-KEY');
    setVal(document.getElementById('peModel'), 'second-model');
    await sleep(200);
    document.querySelector('.modal-mask .modal-foot [data-btn="1"]').click();
    await sleep(1200);
    return { ...added, dialogGone: !document.querySelector('.modal-mask') };
  });
  check('点「+ 添加」后列表有 2 个模型', r.count === 2, `count=${r.count}`);
  check('新增空白模型不会顶掉「使用中」', r.activeName === '默认模型' && r.newActive === false,
    `active=${r.activeName} newActive=${r.newActive}`);
  check('新草稿显示「待填写」标记', r.newHasDraftTag === true);
  check('保存后弹窗关闭', r.dialogGone === true);

  let disk = onDisk();
  console.log('    落盘：', disk.providers.map((p) => `${p.name}[${p.apiKey || '空'}]`).join(' | '));
  check('落盘后仍是 2 个模型', disk.providers.length === 2, `count=${disk.providers.length}`);
  const p0 = disk.providers.find((p) => p.model === 'first-model');
  check('第一个模型的 Key 没被清空', !!p0 && p0.apiKey === 'sk-FIRST-KEY',
    p0 ? `apiKey=${p0.apiKey || '(空)'}` : '第一个模型不见了');
  check('第一个模型的接口没被清空', !!p0 && p0.endpoint === 'https://first.example.com/v1',
    p0 ? `endpoint=${p0.endpoint || '(空)'}` : '');
  const p1 = disk.providers.find((p) => p.model === 'second-model');
  check('新增的第二个模型已保存', !!p1 && p1.apiKey === 'sk-SECOND-KEY' && p1.endpoint === 'https://second.example.com/v1');

  /* ---------------------------------------- 3. 重新打开：两个模型都在，可分别编辑 */
  console.log('\n== 3. 重新打开设置：两个模型都该在 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.getElementById('btnSettings').click();
    await sleep(500);
    const cards = [...document.querySelectorAll('#providerList .prov-card')];
    const list = cards.map((c) => ({
      name: c.querySelector('b').textContent.trim(),
      sub: c.querySelector('.prov-sub').textContent.trim(),
      active: c.classList.contains('active')
    }));
    // 点第二个卡片，看编辑区是否切到第二个
    let secondEditor = null;
    if (cards[1]) {
      cards[1].click();
      await sleep(400);
      secondEditor = {
        endpoint: (document.getElementById('peEndpoint') || {}).value || '',
        key: (document.getElementById('peKey') || {}).value || '',
        model: (document.getElementById('peModel') || {}).value || ''
      };
    }
    // 再点回第一个
    let firstEditor = null;
    if (cards[0]) {
      cards[0].click();
      await sleep(400);
      firstEditor = {
        endpoint: (document.getElementById('peEndpoint') || {}).value || '',
        key: (document.getElementById('peKey') || {}).value || '',
        model: (document.getElementById('peModel') || {}).value || ''
      };
    }
    return { list, secondEditor, firstEditor };
  });
  check('列表里有 2 个模型', r.list.length === 2, JSON.stringify(r.list));
  check('第二个模型的编辑区回填正确',
    !!r.secondEditor && r.secondEditor.model === 'second-model' && r.secondEditor.key === 'sk-SECOND-KEY',
    JSON.stringify(r.secondEditor));
  check('切回第一个模型时编辑区回填正确',
    !!r.firstEditor && r.firstEditor.model === 'first-model' && r.firstEditor.key === 'sk-FIRST-KEY',
    JSON.stringify(r.firstEditor));

  /* ---------------------------------------- 4. 布局回归：勾选项不能挤成一列 */
  console.log('\n== 4. 布局：勾选项 / 左右分栏 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const box = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect() : null;
    };
    const hits = (a, b) => !(a.bottom <= b.top + 1 || b.bottom <= a.top + 1 || a.right <= b.left + 1 || b.right <= a.left + 1);
    const lab = document.querySelector('.modal-mask .sw-check');
    const span = lab ? lab.querySelector('span') : null;
    const lr = lab.getBoundingClientRect();
    const sr = span.getBoundingClientRect();
    const test = box('.modal-mask .settings-test');
    const foot = box('.modal-mask .settings-foot');
    const list = box('.modal-mask .provider-list');
    const edit = box('.modal-mask .provider-editor');
    const cards = document.querySelectorAll('.modal-mask .prov-card');
    return {
      labelW: Math.round(lr.width), labelH: Math.round(lr.height),
      spanW: Math.round(sr.width), spanH: Math.round(sr.height),
      overlapTest: hits(sr, test), overlapFoot: hits(sr, foot),
      sideBySide: list.right <= edit.left + 1,
      cardCount: cards.length
    };
  });
  check('勾选项宽度正常（不是 18px 小方块）', r.labelW > 200, `labelW=${r.labelW}`);
  check('勾选项文字单行铺满、没被挤成竖排', r.spanW > 180 && r.spanH < 40, `spanW=${r.spanW} spanH=${r.spanH}`);
  check('勾选项没有压住下方按钮/说明文字', !r.overlapTest && !r.overlapFoot,
    `overlapTest=${r.overlapTest} overlapFoot=${r.overlapFoot}`);
  check('左侧列表与右侧编辑区是并排两栏', r.sideBySide === true);

  // 截图留证：趁设置弹窗还开着。窗口默认是隐藏的（不打扰用户），
  // 隐藏窗口不会重绘，capturePage 只能拿到旧帧 —— 所以要临时 showInactive 一下再截。
  try {
    const rect = await run(() => {
      const m = document.querySelector('.modal-mask .modal');
      const b = m.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
    });
    win.showInactive();
    win.webContents.invalidate();
    await sleep(900);
    const img = await win.webContents.capturePage(rect);
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, img.toPNG());
    win.hide();
    const size = fs.statSync(SHOT).size;
    check('截图已生成且不是空帧', size > 15000, `bytes=${size}`);
    console.log(`    截图（设置弹窗全貌）：${SHOT}`);
  } catch (err) { console.log('    截图失败：', err.message); }

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  return fail;
})()
  .then((code) => {
    if (child) { try { child.kill(); } catch (_) { /* ignore */ } }
    app.exit(code ? 1 : 0);
  })
  .catch((err) => {
    console.error('测试异常：', err);
    if (child) { try { child.kill(); } catch (_) { /* ignore */ } }
    app.exit(1);
  });

app.on('window-all-closed', () => { /* 交给上面的流程收尾 */ });
