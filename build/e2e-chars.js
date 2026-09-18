'use strict';
/**
 * 真机界面测试：角色集「置顶 / 关系图聚焦 / 可能变化」+ AI 发送改为 Enter（v1.4.1 优化）
 *
 * 1) 角色卡片有置顶按钮，点击后该角色排到最前、且落盘 pinned=true
 * 2) 关系图开启后点击节点 → 出现「关系网」侧栏，列出该角色的全部联系人
 * 3) 标记为「可能变化」的关系在关系网侧栏显示「可能变化」徽标
 * 4) 详情弹窗可添加一条「可能变化」关系，落盘 state=volatile
 * 5) AI 输入框：Enter 发送（新消息出现），Shift+Enter 不发送（仅换行）
 * 6) 档案长字段默认折叠只显示部分，「展开全文」看全文并能转总编辑；保存后档案刷新且弹窗不叠加
 * 7) 导出人物卡 TXT：可多选（默认全选）、角色之间空一排、含关系与「可能变化」标注；档案内可单独导出
 * 8) 人物关系列（档案右侧）：长说明默认截断、「点开看全部」进详情；详情里可编辑/删除，删除需二次确认
 * 9) 出现在的线路（档案右侧）：同样截断 + 点开看全部（含线路/位置/状态），可转编辑并刷新档案
 *
 * 用法：node build/e2e-chars.js [端口]
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
const PORT = Number(process.argv[2]) || 5397;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, '.e2e-chars');
const SHOT = path.join(ROOT, 'dist', 'e2e-chars.png');

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
    projects: [{ id: 'p1', title: '角色视图测试', genre: '悬疑', createdAt: Date.now() }],
    outline: [], characters: [
      {
        id: 'c1', projectId: 'p1', name: '沈砚', role: '主角', color: '#6b8afd', order: 0, motivation: '寻兄',
        appearance: '身形清瘦，眉眼冷峻，穿一身洗旧的青衫；左手小指有一道旧伤，是他自己割的——那年他刚满十四岁，刀口至今没能长平。他习惯把袖口拉下来盖住那道疤，只有在拔刀时才会露出来。（这段只有展开才看得到）'
      },
      { id: 'c2', projectId: 'p1', name: '傅青', role: '重要配角', color: '#8b5cf6', order: 1 },
      { id: 'c3', projectId: 'p1', name: '沈辞', role: '反派', color: '#ef4444', order: 2 }
    ],
    relations: [
      {
        id: 'r1', projectId: 'p1', fromId: 'c1', toId: 'c2', label: '雇主与雇工',
        description: '半真半假：白天是雇主与雇工，夜里他替她掩去行踪，两人都在等对方先露出破绽。（这段只有点开关系才看得到）',
        state: 'volatile', trend: '后期可能反目'
      },
      { id: 'r2', projectId: 'p1', fromId: 'c1', toId: 'c3', label: '同门宿敌', state: 'stable' }
    ],
    lines: [{ id: 'ln1', projectId: 'p1', name: '寻兄主线', kind: 'main', order: 0, status: 'active' }],
    beats: [
      {
        id: 'bt1', projectId: 'p1', lineId: 'ln1', title: '雨夜相认', status: 'planned', order: 0,
        description: '沈砚在雨夜认出师兄的佩刀，却选择沉默；这一段说明很长，只有点开节拍才能看全（长说明测试）。'
      },
      { id: 'bt2', projectId: 'p1', lineId: 'ln1', title: '沈砚与沈辞城门对峙', status: 'idea', order: 1 },
      { id: 'bt3', projectId: 'p1', lineId: 'ln1', title: '与角色无关的一拍', status: 'idea', order: 2, description: '这条跟任何人都没关系，不该出现在档案里。' }
    ],
    world: [], foreshadow: [], notes: [], messages: [], materials: [], chapters: []
  };
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'store.json'), JSON.stringify(db, null, 2));
}

const onDisk = () => JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8'));

function waitPort(port, tries = 60) {
  return new Promise((resolve, reject) => {
    const tick = (n) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/meta', timeout: 800 }, (res) => {
        res.resume(); resolve();
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
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  await waitPort(PORT);
  console.log(`[环境] 隔离实例 ${BASE}（数据目录 ${DATA}）`);

  const win = new BrowserWindow({ show: false, width: 1500, height: 980, paintWhenInitiallyHidden: true });
  await win.loadURL(BASE);
  await sleep(1500);
  const run = (fn) => win.webContents.executeJavaScript(`(${fn.toString()})()`);

  /* ---------------------------------------- 1. 角色视图基础 */
  console.log('\n== 1. 角色视图与置顶 ==');
  let r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.querySelector('.nav-item[data-view="characters"]').click();
    await sleep(400);
    const cards = [...document.querySelectorAll('.char-card')];
    return {
      count: cards.length,
      hasPin: cards.every((c) => c.querySelector('.pin-btn')),
      firstId: cards[0] && cards[0].dataset.id
    };
  });
  check('列出 3 个角色', r.count === 3, `count=${r.count}`);
  check('每张卡片都有置顶按钮', r.hasPin === true);

  // 置顶 c3
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.querySelector('.pin-btn[data-pin="c3"]').click();
    await sleep(600);
    const cards = [...document.querySelectorAll('.char-card')];
    return { firstId: cards[0] && cards[0].dataset.id, pinnedClass: cards[0] && cards[0].classList.contains('pinned') };
  });
  check('置顶后 c3 排到最前', r.firstId === 'c3', `first=${r.firstId}`);
  check('置顶卡片带 pinned 样式', r.pinnedClass === true);
  const disk1 = onDisk();
  check('落盘 pinned=true', (disk1.characters.find((c) => c.id === 'c3') || {}).pinned === true);

  /* ---------------------------------------- 2. 关系图聚焦 */
  console.log('\n== 2. 关系图聚焦 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const tg = document.getElementById('toggleGraph');
    if (!tg.checked) { tg.click(); await sleep(400); }
    document.querySelector('.rel-node[data-id="c1"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(500);
    const side = document.querySelector('.ego-side');
    const items = side ? [...side.querySelectorAll('.ego-rel li')] : [];
    return {
      hasGraph: !!document.querySelector('.rel-svg'),
      hasSide: !!side,
      relCount: items.length,
      hasVolatile: !!(side && side.querySelector('.badge-volatile')),
      volatileText: side && side.querySelector('.badge-volatile') ? side.querySelector('.badge-volatile').textContent.trim() : '',
      focusNode: !!document.querySelector('.rel-node.rel-focus-node')
    };
  });
  check('开启关系图出现 SVG', r.hasGraph === true);
  check('点击节点出现关系网侧栏', r.hasSide === true);
  check('侧栏列出该角色的全部关系（2 条）', r.relCount === 2, `rel=${r.relCount}`);
  check('含「可能变化」徽标', r.hasVolatile === true);
  check('徽标文案为「可能变化」', r.volatileText === '可能变化', `txt=${r.volatileText}`);
  check('图中聚焦节点高亮', r.focusNode === true);

  // 取消聚焦
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const clr = document.getElementById('clearFocus');
    if (clr) clr.click();
    await sleep(400);
    return { sideGone: !document.querySelector('.ego-side') };
  });
  check('点击「查看全部」收起关系网', r.sideGone === true);

  /* ---------------------------------------- 3. 添加「可能变化」关系 */
  console.log('\n== 3. 添加可能变化关系 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const tg = document.getElementById('toggleGraph');
    const graphOn = !!(tg && tg.checked);
    if (tg && !tg.checked) { tg.click(); await sleep(400); }
    const node = document.querySelector('.rel-node[data-id="c2"]');
    let hasSide = false, hasProf = false;
    if (node) { node.dispatchEvent(new MouseEvent('click', { bubbles: true })); await sleep(400); }
    const side = document.querySelector('.ego-side');
    hasSide = !!side;
    hasProf = !!(side && side.querySelector('[data-act="profile"]'));
    let toIdVal = null, labelVal = null, stateVal = null, modalCount = 0;
    // 仅当档案按钮存在才继续
    if (hasProf) {
      side.querySelector('[data-act="profile"]').click();
      await sleep(400);
      const addBtn = document.querySelector('[data-act="add-rel"]');
      if (addBtn) {
        addBtn.click();
        await sleep(300);
        const form = document.querySelector('.modal form');
        if (form) {
          form.elements['toId'].value = 'c3';
          form.elements['label'].value = '表面盟友';
          form.elements['state'].value = 'volatile';
          form.elements['trend'].value = '最终对立';
          toIdVal = form.elements['toId'].value;
          labelVal = form.elements['label'].value;
          stateVal = form.elements['state'].value;
          // 确认按钮在弹窗 footer，不在 form 内
          const ok = form.closest('.modal').querySelector('[data-btn="1"]');
          if (ok) ok.click();
          await sleep(700);
        }
      }
    }
    modalCount = document.querySelectorAll('.modal').length;
    return { graphOn, hasNode: !!node, hasSide, hasProf, toIdVal, labelVal, stateVal, modalCount, closed: !document.querySelector('.modal form') };
  });
  check('经关系网入口能打开角色档案', r.hasSide === true && r.hasProf === true);
  check('添加关系后表单关闭', r.closed === true);
  const disk2 = onDisk();
  const newRel = disk2.relations.find((x) => x.fromId === 'c2' && x.toId === 'c3');
  check('新关系落盘 state=volatile', !!newRel && newRel.state === 'volatile', JSON.stringify(newRel));
  check('新关系带变化方向', !!newRel && newRel.trend === '最终对立');

  /* ---------------------------------------- 4. AI 发送：Enter vs Shift+Enter */
  console.log('\n== 4. AI 发送（Enter） ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const input = document.getElementById('agentInput');
    const before = document.querySelectorAll('.bubble.user').length;
    // Shift + Enter：不应发送
    input.value = '第一行\n第二行';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    await sleep(200);
    const afterShift = document.querySelectorAll('.bubble.user').length;
    const valKept = input.value;
    // Enter：应发送
    input.value = '测试回车发送';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(1500);
    const afterEnter = document.querySelectorAll('.bubble.user').length;
    return { before, afterShift, valKept, afterEnter };
  });
  check('Shift+Enter 不发送', r.afterShift === r.before, `before=${r.before} afterShift=${r.afterShift}`);
  check('Shift+Enter 保留文本（换行）', /\n/.test(r.valKept), JSON.stringify(r.valKept));
  check('Enter 发送成功（出现用户消息）', r.afterEnter > r.before, `before=${r.before} after=${r.afterEnter}`);

  /* ---------------------------------------- 5. 档案字段折叠 + 导出人物卡 */
  console.log('\n== 5. 档案字段折叠与导出人物卡 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.querySelectorAll('.modal-mask').forEach((m) => m.remove());
    document.querySelector('.nav-item[data-view="characters"]').click();
    await sleep(500);
    const tg = document.getElementById('toggleGraph');
    if (tg && tg.checked) { tg.click(); await sleep(400); }
    document.querySelector('.char-card[data-id="c1"]').click();
    await sleep(500);
    const field = document.querySelector('.cd-field.clamped');
    const more = document.querySelector('[data-act="field"]');
    const p = field ? field.querySelector('p') : null;
    // Chromium 对 -webkit-line-clamp 元素不报 scrollHeight 溢出，
    // 改用「同宽克隆 + 取消截断」对比高度，判断内容确实被裁掉了
    let clipped = false;
    let clampCss = '';
    if (p) {
      clampCss = getComputedStyle(p).webkitLineClamp || '';
      const clone = p.cloneNode(true);
      clone.style.cssText = `display:block;position:absolute;visibility:hidden;width:${p.clientWidth}px`;
      document.body.appendChild(clone);
      const fullH = clone.getBoundingClientRect().height;
      clone.remove();
      clipped = fullH > p.getBoundingClientRect().height + 4;
    }
    const footLabels = [...document.querySelectorAll('.modal-foot [data-btn]')].map((b) => b.textContent.trim());
    let fullText = ''; let hasEditInside = false; let modalCount = 0;
    if (more) {
      more.click();
      await sleep(400);
      const last = [...document.querySelectorAll('.modal')].pop();
      fullText = last ? (last.querySelector('.note-full') || {}).textContent || '' : '';
      hasEditInside = !!(last && [...last.querySelectorAll('[data-btn]')].some((b) => /编辑/.test(b.textContent)));
      modalCount = document.querySelectorAll('.modal').length;
    }
    return { hasClamped: !!field, clipped, clampCss, moreLabel: more ? more.textContent.trim() : '', fullText: fullText.trim(), hasEditInside, footLabels, modalCount };
  });
  check('长字段默认折叠（只显示部分）', r.hasClamped === true && r.clipped === true && r.clampCss === '2', JSON.stringify({ hasClamped: r.hasClamped, clipped: r.clipped, css: r.clampCss }));
  check('折叠字段带「展开全文」入口', /展开全文/.test(r.moreLabel || ''), r.moreLabel);
  check('点开后能看到完整内容', /只有展开才看得到/.test(r.fullText), (r.fullText || '').slice(-40));
  check('展开视图里有「编辑」按钮', r.hasEditInside === true);
  check('弹窗底栏保留「编辑」作为总编辑', (r.footLabels || []).includes('编辑'), JSON.stringify(r.footLabels));
  check('档案底栏有「导出人物卡」', (r.footLabels || []).includes('导出人物卡'), JSON.stringify(r.footLabels));

  // 展开视图里点「编辑」→ 总编辑表单；保存后档案刷新且弹窗不叠加
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const last = [...document.querySelectorAll('.modal')].pop();
    const editBtn = [...last.querySelectorAll('[data-btn]')].find((b) => /编辑/.test(b.textContent));
    if (editBtn) { editBtn.click(); await sleep(500); }
    const form = document.querySelector('.modal form');
    const hasAllFields = !!(form && form.elements['name'] && form.elements['appearance']
      && form.elements['motivation'] && form.elements['beatNote']);
    const nameVal = form ? form.elements['name'].value : '';
    if (form) {
      form.elements['alias'].value = '阿砚';
      // 保存按钮要取最上层那个弹窗（此刻有档案/字段/表单三个弹窗叠着）
      [...document.querySelectorAll('.modal')].pop().querySelector('[data-btn="1"]').click();
    }
    await sleep(1200);
    return { hasAllFields, nameVal, modals: document.querySelectorAll('.modal').length, hasProfile: !!document.querySelector('.modal .char-detail') };
  });
  check('「编辑」打开的是整张角色卡表单', r.hasAllFields === true && r.nameVal === '沈砚', JSON.stringify({ all: r.hasAllFields, n: r.nameVal }));
  check('保存后落盘', (onDisk().characters.find((x) => x.id === 'c1') || {}).alias === '阿砚');
  check('保存后档案自动刷新且不叠加弹窗', r.modals === 1 && r.hasProfile === true, JSON.stringify({ modals: r.modals, hasProfile: r.hasProfile }));

  // 多选导出：默认全选 → 取消一个 → 导出 TXT，角色之间空一排
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.querySelectorAll('.modal-mask').forEach((m) => m.remove());
    let saved = null;
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) { saved = { name: this.download, href: this.href }; return; }
      return realClick.apply(this, arguments);
    };
    document.querySelector('[data-act="export-cards"]').click();
    await sleep(400);
    const boxes = [...document.querySelectorAll('.pick-list input[type=checkbox]')];
    const total = boxes.length;
    const allChecked = boxes.length > 0 && boxes.every((b) => b.checked);
    const c2box = boxes.find((b) => b.value === 'c2');
    if (c2box) { c2box.checked = false; c2box.dispatchEvent(new Event('change', { bubbles: true })); }
    await sleep(200);
    const countTxt = (document.getElementById('pickCount') || {}).textContent || '';
    document.querySelector('.modal-foot [data-btn="1"]').click();
    await sleep(500);
    HTMLAnchorElement.prototype.click = realClick;
    let body = '';
    let hasBom = false;
    if (saved && saved.href) {
      const buf = new Uint8Array(await (await fetch(saved.href)).arrayBuffer());
      hasBom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
      body = new TextDecoder('utf-8').decode(buf).replace(/^\uFEFF/, '');
    }
    return {
      total, allChecked, countTxt, name: saved && saved.name, hasBom, body,
      gone: !document.querySelector('.modal-mask'),
      gaps: (body.match(/\n\n【/g) || []).length
    };
  });
  check('勾选列表列出全部角色且默认全选', r.total === 3 && r.allChecked === true, JSON.stringify({ total: r.total, all: r.allChecked }));
  check('取消勾选后计数同步', /2 \/ 3/.test(r.countTxt || ''), r.countTxt);
  check('导出文件名以 .txt 结尾', /\.txt$/.test(r.name || ''), String(r.name));
  check('导出内容带 UTF-8 BOM', r.hasBom === true);
  check('勾选的角色都在文件里', /【沈砚】/.test(r.body || '') && /【沈辞】/.test(r.body || ''));
  check('没勾选的角色不导出', !/【傅青】/.test(r.body || ''));
  check('不同角色之间空一排（正好一空行）', r.gaps === 1, `gaps=${r.gaps}`);
  check('人物关系写进了人物卡', /人物关系/.test(r.body || '') && /雇主与雇工/.test(r.body || ''));
  check('「可能变化」关系带标注', /可能变化/.test(r.body || ''));
  check('导出后弹窗自动关闭', r.gone === true);

  // 档案内单独导出当前角色
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    let saved = null;
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) { saved = { name: this.download, href: this.href }; return; }
      return realClick.apply(this, arguments);
    };
    document.querySelector('.char-card[data-id="c1"]').click();
    await sleep(500);
    const foot = document.querySelector('.modal-foot');
    const btn = [...foot.querySelectorAll('[data-btn]')].find((b) => /导出人物卡/.test(b.textContent));
    if (btn) btn.click();
    await sleep(400);
    HTMLAnchorElement.prototype.click = realClick;
    let body = '';
    if (saved && saved.href) body = new TextDecoder('utf-8').decode(new Uint8Array(await (await fetch(saved.href)).arrayBuffer())).replace(/^\uFEFF/, '');
    return { name: saved && saved.name, body, stillOpen: !!document.querySelector('.modal .char-detail') };
  });
  check('档案内可单独导出该角色', /【沈砚】/.test(r.body || '') && !/【傅青】/.test(r.body || ''), (r.body || '').slice(0, 20));
  check('单独导出文件名带角色名', /沈砚/.test(r.name || ''), String(r.name));
  check('单独导出后档案仍打开', r.stillOpen === true);

  /* ---------------------------------------- 6. 人物关系列：折叠 + 点开看全部 + 编辑 */
  console.log('\n== 6. 人物关系（右侧） ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.querySelectorAll('.modal-mask').forEach((m) => m.remove());
    document.querySelector('.nav-item[data-view="characters"]').click();
    await sleep(500);
    const tg = document.getElementById('toggleGraph');
    if (tg && tg.checked) { tg.click(); await sleep(400); }
    document.querySelector('.char-card[data-id="c1"]').click();
    await sleep(600);
    // 档案右侧有两份 .cd-rel-list（人物关系 + 出现在的线路），这里只看第一份「人物关系」
    const lists = [...document.querySelectorAll('.cd-rel-list')];
    const relList = lists[0];
    const items = relList ? [...relList.querySelectorAll('.rel-item')] : [];
    const clamped = relList ? relList.querySelector('.rel-item.clamped') : null;
    const p = clamped ? clamped.querySelector('.rel-desc') : null;
    // 同宽克隆比对高度，确认长说明确实被截断（Chromium 不报 line-clamp 的 scrollHeight 溢出）
    let clipped = false;
    if (p) {
      const clone = p.cloneNode(true);
      clone.style.cssText = `display:block;position:absolute;visibility:hidden;width:${p.clientWidth}px`;
      document.body.appendChild(clone);
      const fullH = clone.getBoundingClientRect().height;
      clone.remove();
      clipped = fullH > p.getBoundingClientRect().height + 2;
    }
    const first = items[0];
    return {
      count: items.length,
      hasClamped: !!clamped,
      clipped,
      more: clamped ? clamped.querySelector('.rel-more').textContent.trim() : '',
      hasEdit: !!(first && first.querySelector('[data-edit-rel]')),
      hasDel: !!(first && first.querySelector('[data-del-rel]')),
      editLabel: first && first.querySelector('[data-edit-rel]') ? first.querySelector('[data-edit-rel]').textContent.trim() : '',
      dir: first ? first.querySelector('.rel-dir').textContent.trim() : ''
    };
  });
  check('右侧列出两条关系', r.count === 2, `count=${r.count}`);
  check('长说明默认截断（看不完）', r.hasClamped === true && r.clipped === true, JSON.stringify({ c: r.hasClamped, clip: r.clipped }));
  check('截断项带「点开看全部」提示', /点开看全部/.test(r.more || ''), r.more);
  check('每条关系都有「编辑 / 删除」按钮', r.hasEdit === true && r.hasDel === true && r.editLabel === '编辑', JSON.stringify({ e: r.hasEdit, d: r.hasDel, l: r.editLabel }));
  check('显示关系方向', /→|←/.test(r.dir || ''), r.dir);

  // 点开整行 → 关系详情（能看到被截断的完整说明）
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.querySelector('.cd-rel-list .rel-item').click();
    await sleep(500);
    // 档案弹窗还开着，必须取最上层那个弹窗（关系详情）
    const last = [...document.querySelectorAll('.modal')].pop();
    const btns = last ? [...last.querySelectorAll('.modal-foot [data-btn]')].map((b) => b.textContent.trim()) : [];
    return {
      hasModal: !!last,
      lines: last ? [...last.querySelectorAll('.rel-line')].map((el) => el.textContent.replace(/\s+/g, ' ').trim()) : [],
      full: last ? (last.querySelector('.rel-full') || {}).textContent || '' : '',
      btns
    };
  });
  check('点关系行打开详情弹窗', r.hasModal === true, JSON.stringify({ m: r.hasModal }));
  check('详情里能看到完整说明', /只有点开关系才看得到/.test(r.full || ''), (r.full || '').slice(-30));
  check('详情列出关系 / 对象 / 方向 / 状态', r.lines.some((t) => /^关系/.test(t)) && r.lines.some((t) => /^对象/.test(t))
    && r.lines.some((t) => /^方向/.test(t)) && r.lines.some((t) => /^状态/.test(t)), JSON.stringify(r.lines));
  check('可能变化的关系显示走向', r.lines.some((t) => /走向/.test(t) && /后期可能反目/.test(t)), JSON.stringify(r.lines));
  check('详情里有「编辑 / 删除」', r.btns.includes('编辑') && r.btns.includes('删除'), JSON.stringify(r.btns));

  // 详情里点「编辑」→ 打开关系编辑表单，且带出原值
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const detail = [...document.querySelectorAll('.modal')].pop();
    const btn = [...detail.querySelectorAll('.modal-foot [data-btn]')].find((b) => b.textContent.trim() === '编辑');
    if (btn) btn.click();
    await sleep(600);
    const formModal = [...document.querySelectorAll('.modal')].pop();
    const form = formModal ? formModal.querySelector('form') : null;
    const out = {
      hasForm: !!form,
      label: form && form.elements['label'] ? form.elements['label'].value : '',
      state: form && form.elements['state'] ? form.elements['state'].value : '',
      trend: form && form.elements['trend'] ? form.elements['trend'].value : ''
    };
    if (form) {
      const cancel = [...formModal.querySelectorAll('[data-btn]')].find((b) => /取消/.test(b.textContent));
      if (cancel) cancel.click();
    }
    await sleep(400);
    return out;
  });
  check('详情里点「编辑」打开关系表单', r.hasForm === true);
  check('表单带出原关系内容', r.label === '雇主与雇工' && r.state === 'volatile' && r.trend === '后期可能反目', JSON.stringify(r));

  // 列表上的删除要二次确认，取消不删
  const relCountBefore = onDisk().relations.length;
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.querySelector('.cd-rel-list .rel-item [data-del-rel]').click();
    await sleep(400);
    const last = [...document.querySelectorAll('.modal')].pop();
    const txt = (last.querySelector('.confirm-text') || {}).textContent || '';
    const title = (last.querySelector('h3') || {}).textContent || '';
    const cancel = [...last.querySelectorAll('[data-btn]')].find((b) => /取消/.test(b.textContent));
    if (cancel) cancel.click();
    await sleep(400);
    return {
      title, txt,
      // 注意：档案右侧有两份 .cd-rel-list（人物关系 + 出现在的线路），关系只数第一份
      items: document.querySelectorAll('.cd-rel-list')[0].querySelectorAll('.rel-item').length,
      hasProfile: !!document.querySelector('.modal .char-detail')
    };
  });
  check('删除关系先弹确认框', /删除关系/.test(r.title || '') && /将删除/.test(r.txt || ''), JSON.stringify({ t: r.title, x: r.txt }));
  check('取消后关系照旧（不误删）', r.items === 2 && onDisk().relations.length === relCountBefore, JSON.stringify({ items: r.items, disk: onDisk().relations.length }));
  check('取消后档案仍在', r.hasProfile === true);

  /* ---------------------------------------- 7. 出现在的线路：折叠 + 点开看全部 + 编辑 */
  console.log('\n== 7. 出现在的线路 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.querySelectorAll('.modal-mask').forEach((m) => m.remove());
    document.querySelector('.nav-item[data-view="characters"]').click();
    await sleep(500);
    const tg = document.getElementById('toggleGraph');
    if (tg && tg.checked) { tg.click(); await sleep(400); }
    document.querySelector('.char-card[data-id="c1"]').click();
    await sleep(600);
    const lists = [...document.querySelectorAll('.cd-rel-list')];
    const beatList = lists[lists.length - 1];               // 第二个列表 = 出现在的线路
    const items = beatList ? [...beatList.querySelectorAll('.rel-item')] : [];
    const clamped = beatList ? beatList.querySelector('.rel-item.clamped') : null;
    const p = clamped ? clamped.querySelector('.rel-desc') : null;
    let clipped = false;
    if (p) {
      const clone = p.cloneNode(true);
      clone.style.cssText = `display:block;position:absolute;visibility:hidden;width:${p.clientWidth}px`;
      document.body.appendChild(clone);
      const fullH = clone.getBoundingClientRect().height;
      clone.remove();
      clipped = fullH > p.getBoundingClientRect().height + 2;
    }
    const first = items[0];
    return {
      lists: lists.length,
      count: items.length,
      titles: items.map((el) => el.querySelector('b').textContent.trim()),
      hasKindBadge: !!(first && first.querySelector('.kind-badge')),
      hasClamped: !!clamped, clipped,
      more: clamped ? clamped.querySelector('.rel-more').textContent.trim() : '',
      hasEdit: !!(first && first.querySelector('[data-edit-beat]')),
      editLabel: first ? first.querySelector('[data-edit-beat]').textContent.trim() : ''
    };
  });
  check('档案里两个列表：人物关系 + 出现在的线路', r.lists === 2, `lists=${r.lists}`);
  check('只列出提到该角色的节拍（2 条）', r.count === 2, JSON.stringify(r.titles));
  check('无关节拍不出现', !(r.titles || []).some((t) => /无关/.test(t)), JSON.stringify(r.titles));
  check('节拍带线路类型徽标', r.hasKindBadge === true);
  check('长说明默认截断', r.hasClamped === true && r.clipped === true, JSON.stringify({ c: r.hasClamped, clip: r.clipped }));
  check('截断项带「点开看全部」', /点开看全部/.test(r.more || ''), r.more);
  check('每拍都有「编辑」按钮', r.hasEdit === true && r.editLabel === '编辑', JSON.stringify({ e: r.hasEdit, l: r.editLabel }));

  // 点开节拍 → 详情（线路 / 位置 / 状态 + 完整说明）
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const lists = [...document.querySelectorAll('.cd-rel-list')];
    lists[lists.length - 1].querySelector('.rel-item').click();
    await sleep(500);
    const last = [...document.querySelectorAll('.modal')].pop();
    return {
      title: last.querySelector('h3').textContent.trim(),
      sub: (last.querySelector('.modal-sub') || {}).textContent || '',
      lines: [...last.querySelectorAll('.rel-line')].map((el) => el.textContent.replace(/\s+/g, ' ').trim()),
      full: (last.querySelector('.rel-full') || {}).textContent || '',
      btns: [...last.querySelectorAll('.modal-foot [data-btn]')].map((b) => b.textContent.trim())
    };
  });
  check('点开节拍显示详情', r.title === '雨夜相认', r.title);
  check('详情标明线路与类型', /寻兄主线/.test(r.sub || ''), r.sub);
  check('详情列出线路 / 位置 / 状态', r.lines.some((t) => /^线路/.test(t)) && r.lines.some((t) => /^位置/.test(t))
    && r.lines.some((t) => /^状态/.test(t) && /已排/.test(t)), JSON.stringify(r.lines));
  check('详情里能看到完整说明', /只有点开节拍才能看全/.test(r.full || ''), (r.full || '').slice(-24));
  check('详情有「编辑」', r.btns.includes('编辑'), JSON.stringify(r.btns));

  // 详情里点「编辑」→ 节拍编辑表单（带出原值），保存后档案刷新
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const detail = [...document.querySelectorAll('.modal')].pop();
    const btn = [...detail.querySelectorAll('.modal-foot [data-btn]')].find((b) => b.textContent.trim() === '编辑');
    if (btn) btn.click();
    await sleep(600);
    const fm = [...document.querySelectorAll('.modal')].pop();
    const form = fm.querySelector('form');
    const out = {
      hasForm: !!form,
      titleVal: form ? form.elements['title'].value : '',
      statusVal: form ? form.elements['status'].value : ''
    };
    if (form) {
      form.elements['title'].value = '雨夜相认（改）';
      [...fm.querySelectorAll('[data-btn]')].find((b) => /保存/.test(b.textContent)).click();
    }
    await sleep(1300);
    return { ...out, modals: document.querySelectorAll('.modal').length, hasProfile: !!document.querySelector('.modal .char-detail') };
  });
  check('「编辑」打开节拍表单并带出原值', r.hasForm === true && r.titleVal === '雨夜相认' && r.statusVal === 'planned', JSON.stringify(r));
  check('保存后落盘', onDisk().beats.find((b) => b.id === 'bt1').title === '雨夜相认（改）');
  check('保存后档案刷新且不叠加弹窗', r.modals === 1 && r.hasProfile === true, JSON.stringify({ m: r.modals, p: r.hasProfile }));

  /* ---------------------------------------- 8. 截图（给作者看） */
  try {
    await run(async () => {
      const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
      document.querySelectorAll('.modal-mask').forEach((m) => m.remove());
      document.querySelector('.nav-item[data-view="characters"]').click();
      await sleep(400);
      const tg = document.getElementById('toggleGraph');
      if (tg && tg.checked) { tg.click(); await sleep(300); }
      document.querySelector('.char-card[data-id="c1"]').click();
      await sleep(700);
    });
    // 隐藏窗口不重绘：必须先 show 再 invalidate，才能截到当前帧
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

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (child) child.kill();
  app.quit();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); if (child) child.kill(); process.exit(1); });
