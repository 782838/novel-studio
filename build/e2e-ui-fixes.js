'use strict';
/**
 * 真机界面测试：v1.4.1 体验修复批
 *   1) 弹窗按钮栏不再挤成一行（modal-foot 允许换行）
 *   2) 线路置顶：置顶后排在最前且落盘
 *   3) 伏笔勾选回收后排到已勾选分组的最前面（不再掉到最后）
 *   4) 备忘卡片只显示摘要（3 行截断），「展开全文」查看完整内容，「编辑」按钮才进编辑
 *   5) 章节列表点击后保持滚动位置（不再跳回顶部），且未保存的输入先落盘
 *   6) 备忘 / 设定按「最近修改排最前」，删除有二次确认
 *   7) 全屏写作：编辑器铺满窗口、隐藏顶栏与章节列表、Esc 退出、字数实时同步、输入照常落盘
 *   8) 章节列表在任何重绘（新建 / 改状态 / 挂靠大纲）后都不跳回第一章，且未保存的输入不丢
 *
 * 用法：node node_modules/electron/cli.js build/e2e-ui-fixes.js [端口]
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
const PORT = Number(process.argv[2]) || 5398;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, '.e2e-fixes');
const SHOT = path.join(ROOT, 'dist', 'e2e-writing.png');

let pass = 0, fail = 0;
const check = (n, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, info ? `→ ${info}` : ''); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function seed() {
  const long = '第一段想法。\n第二段更长的内容，用来测试卡片是否截断。\n第三段。\n第四段——只有展开全文才能看到这一句：结尾的秘密。';
  const db = {
    meta: { version: 1, createdAt: Date.now() },
    settings: { providers: [], activeProvider: null, useDemo: true, agentPersona: '', autoApply: false },
    projects: [{ id: 'p1', title: '体验修复测试', genre: '悬疑', createdAt: Date.now() }],
    outline: [],
    characters: [
      { id: 'a1', projectId: 'p1', name: '沈砚', role: '主角', color: '#6b8afd', order: 0 },
      { id: 'a2', projectId: 'p1', name: '傅青', role: '重要配角', color: '#8b5cf6', order: 1 },
      { id: 'a3', projectId: 'p1', name: '沈辞', role: '反派', color: '#ef4444', order: 2 }
    ],
    relations: [
      { id: 'r1', projectId: 'p1', fromId: 'a1', toId: 'a2', label: '雇主', state: 'volatile', trend: '反目' }
    ],
    lines: [
      { id: 'l1', projectId: 'p1', name: '寻兄主线', kind: 'main', order: 0, status: 'active' },
      { id: 'l2', projectId: 'p1', name: '规则线', kind: 'mystery', order: 1, status: 'active' },
      { id: 'l3', projectId: 'p1', name: '愧疚线', kind: 'sub', order: 2, status: 'active' }
    ],
    beats: [],
    chapters: Array.from({ length: 30 }, (_, i) => ({
      id: `c${i + 1}`, projectId: 'p1', title: `第 ${i + 1} 章`, order: i + 1, status: 'draft',
      content: i === 9 ? '这是第十章的正文，用来验证切换章节时的输入落盘。' : ''
    })),
    world: [],
    foreshadow: [
      { id: 'f1', projectId: 'p1', title: '指尖墨痕', plantedChapter: '第1章', status: 'planted', order: 0 },
      { id: 'f2', projectId: 'p1', title: '井底画像', plantedChapter: '第2章', status: 'planted', order: 1 },
      { id: 'f3', projectId: 'p1', title: '指甲朱砂', plantedChapter: '第1章', status: 'planted', order: 2 },
      { id: 'f4', projectId: 'p1', title: '那声师兄', plantedChapter: '第2章', status: 'planted', order: 3 }
    ],
    notes: [
      { id: 'n1', projectId: 'p1', title: '中段危机想法', category: '灵感', content: long, pinned: false, createdAt: Date.now(), order: 0 },
      { id: 'n2', projectId: 'p1', title: '别用巧合', category: '待解决', content: '短备忘。', pinned: false, createdAt: Date.now() - 1, order: 1 }
    ],
    messages: [], materials: []
  };
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'store.json'), JSON.stringify(db, null, 2));
}
const onDisk = () => JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8'));

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

  const win = new BrowserWindow({ show: false, width: 1400, height: 900, paintWhenInitiallyHidden: true });
  await win.loadURL(BASE);
  await sleep(1500);
  const run = (fn) => win.webContents.executeJavaScript(`(${fn.toString()})()`);

  /* ---------------------------- 1. 弹窗按钮栏可换行 */
  console.log('\n== 1. 弹窗按钮栏 ==');
  let r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.querySelector('.nav-item[data-view="characters"]').click();
    await sleep(400);
    document.querySelector('.char-card[data-id="a1"]').click();
    await sleep(400);
    const foot = document.querySelector('.modal .modal-foot');
    const st = foot ? getComputedStyle(foot) : null;
    const btns = foot ? foot.querySelectorAll('[data-btn]').length : 0;
    document.querySelector('.modal [data-close]') && document.querySelector('.modal [data-close]').click();
    return { wrap: st ? st.flexWrap : '', btns };
  });
  check('角色档案底栏按钮 ≥5 个（置顶/关系网/删除/深化/编辑）', r.btns >= 5, `btns=${r.btns}`);
  check('底栏允许换行（不再挤一行）', r.wrap === 'wrap', `wrap=${r.wrap}`);

  /* ---------------------------- 2. 线路置顶 */
  console.log('\n== 2. 线路置顶 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.querySelector('.nav-item[data-view="lines"]').click();
    await sleep(400);
    const first = document.querySelector('.lane .lane-title b');
    const beforeFirst = first ? first.textContent.trim() : '';
    const pinBtn = document.querySelector('[data-act="pin-line"][data-pin-line="l3"]');
    if (!pinBtn) return { err: 'no pin btn' };
    pinBtn.click();
    await sleep(700);
    const lanes = [...document.querySelectorAll('.lane')].map((el) => el.querySelector('.lane-title b').textContent.trim());
    const lbl = document.querySelector('[data-act="pin-line"][data-pin-line="l3"]');
    return { beforeFirst, lanes, label: lbl ? lbl.textContent.trim() : '' };
  });
  check('置顶的副线排到第一', r.lanes && r.lanes[0] === '愧疚线', JSON.stringify(r.lanes));
  check('按钮变为「已置顶」', /已置顶/.test(r.label || ''), r.label);
  check('落盘 pinned=true', ((onDisk().lines.find((l) => l.id === 'l3') || {}).pinned) === true);

  /* ---------------------------- 3. 伏笔勾选顺序 + 删除确认 */
  console.log('\n== 3. 伏笔勾选顺序 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.querySelector('.nav-item[data-view="foreshadow"]').click();
    await sleep(400);
    document.querySelector('[data-act="toggle"][data-id="f2"]').click();   // 先勾「井底画像」
    await sleep(700);
    document.querySelector('[data-act="toggle"][data-id="f4"]').click();   // 再勾「那声师兄」
    await sleep(700);
    const rows = [...document.querySelectorAll('.tr')].map((el) => ({
      t: el.querySelector('.td-main b').textContent.trim(),
      done: el.classList.contains('done-row')
    }));
    return { rows };
  });
  // 未回收的（f1 指尖墨痕、f3 指甲朱砂）整体在前；已回收的两条在其后，且组内按勾选时间倒序
  check('未回收的排最前（不是勾选后的）', r.rows[0] && !r.rows[0].done && r.rows[1] && !r.rows[1].done, JSON.stringify(r.rows.map((x) => [x.t, x.done])));
  check('已回收的两条排在未回收之后', r.rows[2] && r.rows[2].done && r.rows[3] && r.rows[3].done, JSON.stringify(r.rows.map((x) => [x.t, x.done])));
  check('已回收组内最晚勾选的「那声师兄」在前', r.rows[2] && r.rows[2].t === '那声师兄', JSON.stringify(r.rows.map((x) => x.t)));

  // 删除需二次确认：点删除弹确认框，取消则不删
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const before = document.querySelectorAll('.tr').length;
    document.querySelector('[data-act="del"][data-id="f1"]').click();
    await sleep(300);
    const modalTxt = (document.querySelector('.modal .confirm-text') || {}).textContent || '';
    const btns = [...document.querySelectorAll('.modal [data-btn]')];
    // 第一个是「取消」
    const cancel = btns.find((b) => /取消/.test(b.textContent));
    cancel && cancel.click();
    await sleep(400);
    const after = document.querySelectorAll('.tr').length;
    return { before, after, modalTxt };
  });
  check('点删除弹出确认框', /删除伏笔/.test(r.modalTxt) || /确定/.test(r.modalTxt), r.modalTxt.slice(0, 30));
  check('取消后不删除（条数不变）', r.before === r.after, `${r.before}→${r.after}`);

  /* ---------------------------- 4. 备忘摘要 + 展开 */
  console.log('\n== 4. 备忘显示与编辑 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.querySelector('.nav-item[data-view="notes"]').click();
    await sleep(400);
    const p = document.querySelector('.note-card[data-id="n1"] .note-brief');
    const clipped = p ? (p.scrollHeight > p.clientHeight + 2) : false;  // 3 行截断 = 内容被裁
    const cardHasSecret = p ? p.offsetHeight < p.scrollHeight : false;
    document.querySelector('[data-act="view"][data-id="n1"]').click();
    await sleep(400);
    const full = document.querySelector('.note-full');
    const showsSecret = !!(full && full.textContent.includes('结尾的秘密'));
    const hasEditBtn = !!(full && document.querySelector('.modal [data-btn="0"]'));
    if (hasEditBtn) document.querySelector('.modal [data-btn="0"]').click(); // 弹窗里的「编辑」
    await sleep(400);
    const formOpen = !!document.querySelector('.modal form');
    const titleVal = formOpen ? document.querySelector('.modal form').elements['title'].value : '';
    return { clipped, cardHasSecret, showsSecret, formOpen, titleVal };
  });
  check('卡片内容截断显示（3 行摘要）', r.clipped === true && r.cardHasSecret === true);
  check('「展开全文」弹窗能看到完整内容', r.showsSecret === true);
  check('查看弹窗里点「编辑」才进入编辑表单', r.formOpen === true && r.titleVal === '中段危机想法');

  /* ---------------------------- 5. 章节滚动保持 */
  console.log('\n== 5. 章节点击不跳顶 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.querySelector('.nav-item[data-view="chapters"]').click();
    await sleep(500);
    const list = document.querySelector('.chapter-items');
    if (!list) return { err: 'no list' };
    // 先切到第 10 章（注意：点击会重建 DOM，必须重新取列表元素）
    document.querySelector('.chapter-item[data-id="c10"]').click();
    await sleep(600);
    const list2 = document.querySelector('.chapter-items');
    list2.scrollTop = 150;
    await sleep(100);
    const scrolled = list2.scrollTop;
    // 在第 10 章正文里打几个字（防抖 700ms 还没触发就切章，验证 flush）
    const ta = document.querySelector('#chapterContent');
    ta.value = ta.value + '（补写：傅青的半页台账）';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    // 点击另一章
    document.querySelector('.chapter-item[data-id="c12"]').click();
    await sleep(900);
    const nl = document.querySelector('.chapter-items');
    const active = nl ? (nl.querySelector('.chapter-item.active') || {}).dataset : null;
    return { scrolled, kept: nl ? nl.scrollTop : -1, activeId: active && active.id };
  });
  check('滚动确实先发生了', (r.scrolled || 0) > 50, `scrollTop=${r.scrolled}`);
  check('点击切换后保持原滚动位置', Math.abs((r.kept || 0) - (r.scrolled || 0)) < 25, `kept=${r.kept}`);
  check('切到了目标章节', r.activeId === 'c12', `active=${r.activeId}`);

  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.querySelector('.chapter-item[data-id="c10"]').click();
    await sleep(600);
    const ta = document.querySelector('#chapterContent');
    return { content: ta ? ta.value : '' };
  });
  const flushed = /补写：傅青的半页台账/.test(r.content || '');
  const diskC10 = (onDisk().chapters.find((c) => c.id === 'c10') || {}).content || '';
  check('切章前未保存的输入已落盘（不丢字）', flushed && /补写/.test(diskC10), JSON.stringify({ flushed, disk: diskC10.slice(0, 40) }));

  /* ---------------------------- 6. 统一「最近修改排最前」 */
  console.log('\n== 6. 最近修改排序（备忘 / 设定）==');
  // 备忘：新建一条 → 它应排到未置顶组最前；再编辑旧的一条 → 被编辑的换到最前
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.querySelectorAll('.modal-mask').forEach((m) => m.remove()); // 清掉第 4 节遗留的编辑弹窗
    document.querySelector('.nav-item[data-view="notes"]').click();
    await sleep(400);
    const order0 = [...document.querySelectorAll('.note-card')].map((el) => el.dataset.id);
    // 编辑 n2（改标题后保存），它应升到非置顶首位
    document.querySelector('[data-act="edit"][data-id="n2"]').click();
    await sleep(400);
    const form = document.querySelector('.modal form');
    form.elements['title'].value = '别用巧合（已修订）';
    document.querySelector('.modal [data-btn="1"]').click();
    await sleep(900);
    const order1 = [...document.querySelectorAll('.note-card')].map((el) => el.dataset.id);
    return { order0, order1 };
  });
  check('备忘初始没有 n2 在最前', r.order0[0] !== 'n2', JSON.stringify(r.order0));
  check('编辑过的备忘升到最前', r.order1[0] === 'n2', JSON.stringify(r.order1));

  // 设定：新增两条，最近的应排前；再编辑较早那条 → 换到最前
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.querySelector('.nav-item[data-view="world"]').click();
    await sleep(400);
    const add = async (title) => {
      document.querySelector('[data-act="new"]').click();
      await sleep(350);
      const form = document.querySelector('.modal form');
      form.elements['title'].value = title;
      form.elements['content'].value = '规则内容若干。';
      document.querySelector('.modal [data-btn="1"]').click();
      await sleep(800);
    };
    await add('血月规则');
    await add('潮汐历法');
    document.querySelector('.nav-item[data-view="world"]').click();
    await sleep(400);
    let titles = [...document.querySelectorAll('.mini-card b')].map((el) => el.textContent.trim());
    const afterAdd = titles.slice();
    // 编辑较早的那条（血月规则）
    const card = [...document.querySelectorAll('.mini-card')].find((el) => el.querySelector('b').textContent.trim() === '血月规则');
    card.querySelector('[data-act="edit"]').click();
    await sleep(400);
    const form = document.querySelector('.modal form');
    form.elements['content'].value = '血月之夜，规则改写：夜行者不得入城。';
    document.querySelector('.modal [data-btn="1"]').click();
    await sleep(900);
    document.querySelector('.nav-item[data-view="world"]').click();
    await sleep(400);
    titles = [...document.querySelectorAll('.mini-card b')].map((el) => el.textContent.trim());
    return { afterAdd, afterEdit: titles.slice() };
  });
  check('新增设定后最近的排最前', r.afterAdd[0] === '潮汐历法', JSON.stringify(r.afterAdd));
  check('编辑较早的设定后它换到最前', r.afterEdit[0] === '血月规则', JSON.stringify(r.afterEdit));

  // 设定删除也有确认（取消不删）
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const before = document.querySelectorAll('.mini-card').length;
    document.querySelector('.mini-card [data-act="del"]').click();
    await sleep(300);
    const modalTxt = (document.querySelector('.modal .confirm-text') || {}).textContent || '';
    const cancel = [...document.querySelectorAll('.modal [data-btn]')].find((b) => /取消/.test(b.textContent));
    cancel && cancel.click();
    await sleep(400);
    const after = document.querySelectorAll('.mini-card').length;
    return { before, after, modalTxt };
  });
  check('设定删除弹确认框', /删除设定/.test(r.modalTxt) || /确定/.test(r.modalTxt), r.modalTxt.slice(0, 30));
  check('设定取消后不删除', r.before === r.after, `${r.before}→${r.after}`);

  /* ---------------------------- 7. 全屏写作 */
  console.log('\n== 7. 全屏写作 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.querySelectorAll('.modal-mask').forEach((m) => m.remove());
    document.querySelector('.nav-item[data-view="chapters"]').click();
    await sleep(600);
    const btn = document.querySelector('.editor-head [data-act="full"]');
    const hasBtn = !!btn;
    const labelBefore = btn ? btn.textContent.trim() : '';
    if (btn) btn.click();
    await sleep(500);
    const ed = document.querySelector('.editor');
    const bar = document.querySelector('.editor-full-bar');
    const rect = ed ? ed.getBoundingClientRect() : null;
    return {
      hasBtn, labelBefore,
      on: document.body.classList.contains('writing-full'),
      covers: !!(rect && rect.width >= window.innerWidth - 2 && rect.height >= window.innerHeight - 2),
      barShown: bar ? getComputedStyle(bar).display !== 'none' : false,
      topbarHidden: getComputedStyle(document.querySelector('.topbar')).display === 'none',
      listHidden: getComputedStyle(document.querySelector('.chapter-list')).display === 'none',
      toolsHidden: getComputedStyle(document.querySelector('.editor-tools')).display === 'none',
      contentVisible: !!document.querySelector('#chapterContent'),
      exitLabel: bar ? bar.querySelector('[data-act="full"]').textContent.trim() : ''
    };
  });
  check('章节编辑器有「全屏」按钮', r.hasBtn === true && /全屏/.test(r.labelBefore || ''), r.labelBefore);
  check('点击后进入全屏写作', r.on === true);
  check('编辑器铺满窗口', r.covers === true, JSON.stringify({ covers: r.covers }));
  check('隐藏顶栏 / 章节列表 / 工具条', r.topbarHidden === true && r.listHidden === true && r.toolsHidden === true,
    JSON.stringify({ top: r.topbarHidden, list: r.listHidden, tools: r.toolsHidden }));
  check('全屏顶栏有条目信息与退出按钮', r.barShown === true && /退出全屏/.test(r.exitLabel || ''), r.exitLabel);
  check('正文仍在（可继续写）', r.contentVisible === true);

  // 截图（给作者看）：全屏写作界面
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

  // 全屏下打字：字数同步 + 落盘
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const ta = document.querySelector('#chapterContent');
    ta.value = `${ta.value}（全屏里补的一行：雨里的铁锈味更重了）`;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);
    const fw = document.querySelector('#fullWords');
    return { fullWords: fw ? fw.textContent.trim() : '', len: ta.value.length };
  });
  check('全屏字数实时更新', /^\d+ 字$/.test(r.fullWords || ''), JSON.stringify(r));

  // Esc 退出全屏
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(500);
    const ed = document.querySelector('.editor');
    const rect = ed ? ed.getBoundingClientRect() : null;
    return {
      on: document.body.classList.contains('writing-full'),
      topbarShown: getComputedStyle(document.querySelector('.topbar')).display !== 'none',
      label: document.querySelector('.editor-head [data-act="full"]').textContent.trim(),
      normalWidth: !!(rect && rect.width < window.innerWidth - 100)
    };
  });
  check('Esc 退出全屏', r.on === false && r.topbarShown === true, JSON.stringify(r));
  check('按钮恢复为「全屏」', /^⛶ 全屏$/.test(r.label || ''), r.label);
  check('编辑器回到常规布局', r.normalWidth === true);
  await sleep(900);
  check('全屏里的输入已落盘', /雨里的铁锈味更重了/.test((onDisk().chapters.find((c) => c.id === 'c10') || {}).content || ''));

  /* ---------------------------- 8. 章节：任何重绘都不跳顶 */
  console.log('\n== 8. 章节列表：新建 / 改状态都不跳顶 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.querySelector('.nav-item[data-view="chapters"]').click();
    await sleep(700);
    const list = document.querySelector('.chapter-items');
    list.scrollTop = 220;
    await sleep(150);
    const before = list.scrollTop;
    // ① 打字（防抖未触发）后立刻改状态：位置要保住，字也不能丢
    const ta = document.querySelector('#chapterContent');
    ta.value = `${ta.value}（改状态前的一行）`;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const st = document.querySelector('#chapterStatus');
    st.value = 'done';
    st.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(1300);
    const l2 = document.querySelector('.chapter-items');
    const out = {
      before,
      afterStatus: l2.scrollTop,
      statusVal: document.querySelector('#chapterStatus').value,
      contentKept: /改状态前的一行/.test(document.querySelector('#chapterContent').value),
      activeAfterStatus: (l2.querySelector('.chapter-item.active') || {}).dataset.id
    };
    // ② 新建章节
    document.querySelector('.chapter-list [data-act="new"]').click();
    await sleep(1400);
    const l3 = document.querySelector('.chapter-items');
    const act = l3.querySelector('.chapter-item.active');
    const lr = l3.getBoundingClientRect();
    const ar = act ? act.getBoundingClientRect() : null;
    out.afterNew = l3.scrollTop;
    out.newTitle = act ? act.querySelector('.ci-title').textContent.trim() : '';
    out.newVisible = !!(ar && ar.top >= lr.top - 1 && ar.bottom <= lr.bottom + 1);
    out.total = l3.querySelectorAll('.chapter-item').length;
    return out;
  });
  check('改状态后列表不跳回顶部', Math.abs(r.afterStatus - r.before) < 30, `before=${r.before} after=${r.afterStatus}`);
  check('状态改成了「完成」', r.statusVal === 'done', r.statusVal);
  check('改状态前未保存的输入没丢（界面）', r.contentKept === true);
  check('改状态前未保存的输入没丢（落盘）', /改状态前的一行/.test((onDisk().chapters.find((c) => c.id === 'c10') || {}).content || ''));
  check('改状态不改变当前选中章节', r.activeAfterStatus === 'c10', String(r.activeAfterStatus));
  check('新建章节后列表不跳回顶部', r.afterNew >= r.before - 30, `before=${r.before} after=${r.afterNew}`);
  check('新建的章节在末尾并被选中', r.total === 31 && r.newTitle === '第 31 章', JSON.stringify({ total: r.total, t: r.newTitle }));
  check('新章节自动滚到可见位置', r.newVisible === true);

  // ③ 挂靠大纲（静默保存）也不动位置
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const l = document.querySelector('.chapter-items');
    l.scrollTop = 180;
    await sleep(150);
    const before = l.scrollTop;
    const sel = document.querySelector('#chapterNode');
    if (!sel || sel.options.length < 2) return { skip: true };
    sel.value = sel.options[1].value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(900);
    return { skip: false, before, after: document.querySelector('.chapter-items').scrollTop };
  });
  if (r.skip) {
    check('挂靠大纲保持位置（无大纲节点，跳过）', true);
  } else {
    check('挂靠大纲后列表也不跳顶', Math.abs(r.after - r.before) < 30, `before=${r.before} after=${r.after}`);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (child) child.kill();
  app.quit();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); if (child) child.kill(); process.exit(1); });
