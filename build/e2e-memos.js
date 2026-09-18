'use strict';
/**
 * 真机界面测试：「AI 记忆点」（v1.4.1）
 *
 * 复现作者的操作路径：
 *   1) 侧边栏「章节」下方应出现「AI记忆点」入口，点开能看到每一章
 *   2) 未配置模型（演示/本地模式）也能一键生成记忆点
 *   3) 单章「✨ 生成」把摘要填进该章的编辑框，并标记为已生成
 *   4) 「生成缺失的记忆点」批量补齐，带进度条
 *   5) 手动编辑记忆点会保存
 *   6) 重新打开应用后记忆点仍在（真持久化）
 *
 * 用法：node build/e2e-memos.js [端口]
 * 需要 electron 二进制（node_modules/electron/dist/electron.exe）。
 * 自己起隔离临时实例，不碰用户真实数据。
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
const DATA = path.join(ROOT, '.e2e-memos');
const SHOT = path.join(ROOT, 'dist', 'e2e-memos.png');
const SHOT_IMPORT = path.join(ROOT, 'dist', 'e2e-memos-import.png');

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
    projects: [{ id: 'p1', title: '记忆点真机测试', genre: '悬疑', createdAt: Date.now() }],
    outline: [], characters: [], relations: [], lines: [], beats: [], world: [],
    foreshadow: [], notes: [], messages: [], materials: [],
    chapters: [
      {
        id: 'c1', projectId: 'p1', title: '第一章 雨夜', order: 1, status: 'done',
        content: '雨下得很大。沈砚站在屋檐下等一个人。那人终究没有来，来的却是陆昭。陆昭递给他一枚铜镜，说这不是镜子，是钥匙。'
      },
      {
        id: 'c2', projectId: 'p1', title: '第二章 旧宅', order: 2, status: 'done',
        content: '旧宅的门被推开，灰尘在光里浮。两人摊开地图复盘白天的交锋，以失败告终。退守这里，是唯一的选择。'
      },
      { id: 'c3', projectId: 'p1', title: '第三章 空章', order: 3, status: 'todo', content: '' }
    ]
  };
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'store.json'), JSON.stringify(db, null, 2));
}

const onDiskMemos = () => {
  const j = JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8'));
  return (j.chapters || []).map((c) => ({ id: c.id, memo: String(c.memo || '') }));
};

function waitPort(port, tries = 60) {
  return new Promise((resolve, reject) => {
    const tick = (n) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/meta', timeout: 800 }, (res) => {
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
  seed();
  const env = { ...process.env, NOVEL_PORT: String(PORT), NOVEL_DATA_DIR: DATA, NOVEL_EMBEDDED: '1', ELECTRON_RUN_AS_NODE: '1' };
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT, env, stdio: 'ignore', windowsHide: true
  });
  await waitPort(PORT);
  console.log(`[环境] 隔离实例 ${BASE}（数据目录 ${DATA}）`);

  const win = new BrowserWindow({ show: false, width: 1500, height: 980, paintWhenInitiallyHidden: true });
  await win.loadURL(BASE);
  await sleep(1500);
  const run = (fn) => win.webContents.executeJavaScript(`(${fn.toString()})()`);

  /* ---------------------------------------- 1. 侧边栏入口 + 视图渲染 */
  console.log('\n== 1. 侧边栏入口与视图 ==');
  let r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const items = [...document.querySelectorAll('.nav-item')];
    const memoNav = items.find((b) => b.dataset.view === 'memos');
    const labels = items.map((b) => b.querySelector('.nav-label').textContent.trim());
    memoNav.click();
    await sleep(400);
    return {
      exists: !!memoNav,
      label: memoNav ? memoNav.querySelector('.nav-label').textContent.trim() : '',
      idx: memoNav ? labels.indexOf(memoNav.querySelector('.nav-label').textContent.trim()) : -1,
      chapterIdx: labels.indexOf('章节'),
      rows: document.querySelectorAll('.memo-row').length,
      stats: document.querySelectorAll('.memo-stat').length,
      hasView: !!document.querySelector('.memo-view')
    };
  });
  check('侧边栏存在「AI记忆点」入口', r.exists && r.label === 'AI记忆点', JSON.stringify(r));
  check('它排在「章节」之后', r.idx === r.chapterIdx + 1, `memo=${r.idx} chapter=${r.chapterIdx}`);
  check('视图正确渲染', r.hasView === true);
  check('逐章列出 3 章', r.rows === 3, `rows=${r.rows}`);
  check('顶部有 4 个统计卡', r.stats === 4, `stats=${r.stats}`);

  /* ---------------------------------------- 2. 单章生成（本地压缩） */
  console.log('\n== 2. 单章生成记忆点 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const btn = document.querySelector('.memo-row[data-id="c1"] [data-act="gen-one"]');
    btn.click();
    await sleep(1600);
    const row = document.querySelector('.memo-row[data-id="c1"]');
    return {
      memo: row.querySelector('.memo-input').value.trim(),
      len: row.querySelector('.memo-len').textContent.trim(),
      hasMemo: row.classList.contains('has-memo')
    };
  });
  check('第一章生成了记忆点', r.memo.length > 0, JSON.stringify(r));
  check('字数同步更新', Number(r.len) === r.memo.length, `len=${r.len} actual=${r.memo.length}`);
  check('该行被标记为已生成', r.hasMemo === true);

  /* ---------------------------------------- 3. 批量补齐 */
  console.log('\n== 3. 批量生成缺失 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const prog = document.getElementById('memoProgress');
    const hiddenBefore = prog.hidden;            // 空闲时应隐藏
    document.querySelector('[data-act="gen-missing"]').click();
    await sleep(3200);
    const rows = [...document.querySelectorAll('.memo-row')];
    return {
      hasProgressEl: !!prog,
      hiddenBefore,
      progHiddenAfter: prog.hidden,
      done: rows.filter((x) => x.classList.contains('has-memo')).length,
      total: rows.length,
      emptyRowMemo: document.querySelector('.memo-row[data-id="c3"] .memo-input').value.trim()
    };
  });
  check('进度条元素存在且空闲时隐藏', r.hasProgressEl === true && r.hiddenBefore === true,
    JSON.stringify({ has: r.hasProgressEl, hidden: r.hiddenBefore }));
  check('批量结束后进度条收起', r.progHiddenAfter === true);
  check('有正文的 2 章都已生成', r.done === 2, `done=${r.done}/${r.total}`);
  check('空正文章节保持为空（不硬造）', r.emptyRowMemo === '', `memo=${JSON.stringify(r.emptyRowMemo)}`);

  /* ---------------------------------------- 4. 手动编辑落盘 */
  console.log('\n== 4. 手动编辑 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const ta = document.querySelector('.memo-row[data-id="c3"] .memo-input');
    ta.value = '手动补写的记忆点：本章为空，待填。';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(1100);
    const row = document.querySelector('.memo-row[data-id="c3"]');
    return { len: row.querySelector('.memo-len').textContent.trim(), hasMemo: row.classList.contains('has-memo') };
  });
  await sleep(500);
  const disk = onDiskMemos();
  const c3 = disk.find((x) => x.id === 'c3');
  check('手动内容写入了输入框', r.len !== '0' && r.hasMemo === true, JSON.stringify(r));
  check('手动内容已落盘', !!c3 && c3.memo.includes('手动补写'), JSON.stringify(c3));

  /* ---------------------------------------- 5. 导入 TXT */
  console.log('\n== 5. 导入 TXT 记忆点 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const text = '第1章 沈砚于雨夜现身，拿到铜镜。\n第2章 陆昭指出铜镜其实是钥匙。\n这一行没有编号，按顺序补进剩下的章。';
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'memos.txt', { type: 'text/plain' }));
    // 拦住「选择文件」：直接塞一个 File 进去，好把导入流程跑通
    const orig = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type === 'file') {
        HTMLInputElement.prototype.click = orig;
        try { this.files = dt.files; } catch (_) {
          Object.defineProperty(this, 'files', { value: dt.files, configurable: true });
        }
        this.dispatchEvent(new Event('change'));
        return;
      }
      return orig.apply(this, arguments);
    };
    document.querySelector('[data-act="import"]').click();
    await sleep(1000);
    const rows = [...document.querySelectorAll('.memo-import-row')];
    return {
      dialogOpen: !!document.querySelector('.modal-mask'),
      rows: rows.length,
      first: rows[0] ? rows[0].querySelector('.mi-memo').value.trim() : '',
      second: rows[1] ? rows[1].querySelector('.mi-memo').value.trim() : '',
      third: rows[2] ? rows[2].querySelector('.mi-memo').value.trim() : '',
      byTags: rows.map((x) => (x.querySelector('.mi-by') || {}).textContent || '')
    };
  });
  check('点「导入 TXT」弹出预览', r.dialogOpen === true);
  check('解析出 3 条（对应 3 章）', r.rows === 3, `rows=${r.rows}`);
  check('按「第N章」识别前两章', /沈砚于雨夜现身/.test(r.first) && /铜镜其实是钥匙/.test(r.second),
    JSON.stringify({ first: r.first, second: r.second }));
  check('没编号的行按顺序补进第三章', /按顺序补/.test(r.third), JSON.stringify(r.third));
  check('标注了识别方式', r.byTags[0] === '按序号' && r.byTags[2] === '按顺序', JSON.stringify(r.byTags));

  // 趁预览弹窗开着截一张
  try {
    win.showInactive();
    win.webContents.invalidate();
    await sleep(900);
    fs.writeFileSync(SHOT_IMPORT, (await win.webContents.capturePage()).toPNG());
    console.log(`[截图] ${SHOT_IMPORT}`);
    win.hide();
  } catch (err) { console.log('  (导入弹窗截图跳过：', err.message, ')'); }

  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    // 原本已有记忆点的默认不勾选（防覆盖），这里全部勾上验证覆盖导入
    [...document.querySelectorAll('.memo-import-row')].forEach((x) => {
      const b = x.querySelector('input[type=checkbox]');
      if (!b.checked) b.click();
    });
    await sleep(200);
    document.querySelector('.modal-mask .modal-foot [data-btn="1"]').click();
    await sleep(3200);
    return { dialogGone: !document.querySelector('.modal-mask') };
  });
  check('导入后弹窗关闭', r.dialogGone === true);
  await sleep(700);
  const after = onDiskMemos();
  const d1 = after.find((x) => x.id === 'c1');
  const d3 = after.find((x) => x.id === 'c3');
  check('第一章记忆点已换成 TXT 里的内容', !!d1 && /沈砚于雨夜现身/.test(d1.memo), JSON.stringify(d1));
  check('第三章也按顺序写入了', !!d3 && /按顺序补/.test(d3.memo), JSON.stringify(d3));

  /* ---------------------------------------- 6. 下载 TXT（本次把「复制」改成「下载」） */
  console.log('\n== 6. 下载为 TXT ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    // 真正的下载会弹系统保存框，测试里拦下 <a download> 的点击，只校验它要存的内容
    let saved = null;
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) {
        saved = { name: this.download, href: this.href };
        return;
      }
      return realClick.apply(this, arguments);
    };
    const btn = document.querySelector('[data-act="download"]');
    const hasBtn = !!btn && !btn.disabled;
    if (btn) btn.click();
    await sleep(300);
    HTMLAnchorElement.prototype.click = realClick;

    // 注意：fetch().text() 解码 UTF-8 时会自动剥离 BOM，故改为读原始字节校验，
    // 这样才等同于「下载落盘的真实文件」（Electron 写盘的是 blob 原始字节，含 BOM）。
    let buf = null;
    let text = '';
    if (saved && saved.href) {
      buf = new Uint8Array(await (await fetch(saved.href)).arrayBuffer());
      text = new TextDecoder('utf-8').decode(buf);
    }
    const hasBom = !!(buf && buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF);
    return {
      hasBtn,
      name: saved && saved.name,
      hasBom,
      body: text.replace(/^\uFEFF/, ''),
      gone: !document.querySelector('.memo-copy')
    };
  });
  check('工具栏有「下载 TXT」按钮且可点', r.hasBtn === true);
  check('下载文件名以 .txt 结尾', !!r.name && /\.txt$/.test(r.name), String(r.name));
  check('内容带 UTF-8 BOM（记事本不乱码）', r.hasBom === true);
  check('文件里含各章记忆点', /沈砚于雨夜现身/.test(r.body) && /按顺序补/.test(r.body), (r.body || '').slice(0, 120));
  check('导出的是 TXT 而不是弹复制框', r.gone === true);

  /* ---------------------------------------- 7. 截图（给作者看） */
  try {
    win.showInactive();
    win.webContents.invalidate();
    await sleep(900);
    const img = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, img.toPNG());
    console.log(`[截图] ${SHOT}`);
    win.hide();
  } catch (err) {
    console.log('  (截图跳过：', err.message, ')');
  }

  /* ---------------------------------------- 8. 重新打开：记忆点仍在 */
  console.log('\n== 8. 重开应用后仍在 ==');
  await win.loadURL(BASE);
  await sleep(1600);
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.querySelector('.nav-item[data-view="memos"]').click();
    await sleep(500);
    const rows = [...document.querySelectorAll('.memo-row')];
    return {
      count: rows.length,
      done: rows.filter((x) => x.classList.contains('has-memo')).length,
      navCount: (document.querySelector('.nav-item[data-view="memos"] .nav-count') || {}).textContent || ''
    };
  });
  check('重开后仍列出章节', r.count === 3, `count=${r.count}`);
  check('已生成的记忆点仍在', r.done === 3, `done=${r.done}`);
  check('侧栏计数显示已生成章节数', String(r.navCount).trim() === '3', `navCount=${r.navCount}`);

  try { child.kill(); } catch (_) { /* ignore */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (_) { /* ignore */ }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  app.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err && err.stack || err);
  try { child && child.kill(); } catch (_) { /* ignore */ }
  app.exit(1);
});
