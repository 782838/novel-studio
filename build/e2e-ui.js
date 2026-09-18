'use strict';
/**
 * 真实界面测试（用项目自带的 Electron 跑一个真 Chromium）：
 *   1) 备忘点☆置顶 → 星星变★、卡片挪到最前
 *   2) 伏笔点勾选 → 行变已回收、勾上
 *   3) 顶栏「✎ 改名」→ 作品改名，下拉框同步
 *   4) 大纲双击标题 → 就地改名
 *   5) AI 助手：发送后按钮变「停止」、出现思考过程；点停止能中断并落一条「已停止」
 *
 * 用法（需要先起一个测试实例，例如 5399 端口）：
 *   electron build/e2e-ui.js [端口]
 *
 * 建议每次运行前清空测试实例的数据目录（例如 rm -rf .e2e 后重启 --seed），
 * 部分用例（置顶、改名）依赖示例数据的初始状态。
 */
const { app, BrowserWindow, clipboard } = require('electron');
const http = require('http');
const path = require('path');

// 本机可能挂着系统代理，Chromium 会把 localhost 也丢给代理 → 直接关掉，避免 ERR_FAILED
// 另外这台机器上 Chromium 自带沙箱起不来（渲染进程直接崩），必须关掉沙箱
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('in-process-gpu');
app.disableHardwareAcceleration();

const PORT = Number(process.argv[2]) || 5399;
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE_PORT = PORT + 1;
const SLOW_MARK = '慢慢说';
const PROTO_MARK = '协议测试';

let pass = 0, fail = 0;
const check = (n, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, info ? `→ ${info}` : ''); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------- 假模型：先思考，再慢速吐正文（留出"停止"的时间） */
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const payload = JSON.parse(raw || '{}');
    const msgs = payload.messages || [];
    // 只按「当前这一问」决定走哪条分支：历史消息里可能残留上一轮的标记，按全局匹配会串味
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const lastText = String((lastUser && lastUser.content) || '');
    const resultsTurn = lastText.startsWith('执行结果：');
    const protocol = /协议测试/.test(lastText)
      || (resultsTurn && msgs.some((m) => String(m.content).includes(PROTO_MARK)));
    const slow = /慢慢说/.test(lastText)
      || (resultsTurn && msgs.some((m) => String(m.content).includes(SLOW_MARK)));
    const gotResults = resultsTurn;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const put = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (protocol) {
      if (!gotResults) {
        put({ choices: [{ delta: { reasoning_content: '先把要记的东西列出来。' } }] });
        put({ choices: [{ delta: { content: '我来记两条备忘：\n\n```json\n{"tool":"add_note","args":{"title":"界面协议测试A","content":"来自界面测试"}}\n```\n```json\n{"tool":"add_note","args":{"title":"界面协议测试B","content":"第二条"}}\n```' } }] });
      } else {
        put({ choices: [{ delta: { content: '两条备忘都记好了，你可以去备忘页看看。' } }] });
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    put({ choices: [{ delta: { reasoning_content: '先看一遍现有的大纲和章节节奏。' } }] });
    put({ choices: [{ delta: { reasoning_content: '中段偏慢，得给一个转折。' } }] });
    const chunks = ['这个', '故事的', '节奏', '问题', '在于', '中段', '缺少', '一次', '转折', '。'];
    let i = 0;
    const timer = setInterval(() => {
      put({ choices: [{ delta: { content: chunks[i] } }] });
      if (++i >= chunks.length) { clearInterval(timer); res.write('data: [DONE]\n\n'); res.end(); }
    }, 400);
    res.on('close', () => clearInterval(timer));
  });
});

const putJSON = (url, body) => fetch(BASE + url, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}).then((r) => r.json());

(async () => {
  await new Promise((r) => fake.listen(FAKE_PORT, r));
  // 把测试实例的模型指向假服务（这样「停止」才有可停止的流）
  // 注意：设置已升级成 providers 列表，必须按新结构写，否则这一项配置不会生效
  const s = await putJSON('/api/settings', {
    providers: [{
      id: 'ai_e2e_fake',
      name: 'e2e 假模型',
      provider: 'custom',
      endpoint: `http://127.0.0.1:${FAKE_PORT}/v1`,
      apiKey: 'sk-fake',
      model: 'fake-e2e',
      temperature: 0.7,
      maxTokens: 1024,
      extraBody: ''
    }],
    activeProvider: 'ai_e2e_fake'
  });
  console.log(`[环境] 测试实例 ${BASE}，假模型 http://127.0.0.1:${FAKE_PORT}/v1，模型=${s.activeModel}`);

  const win = new BrowserWindow({ show: false, width: 1500, height: 950 });
  await win.loadURL(BASE);
  await sleep(1200);

  const run = (fn) => win.webContents.executeJavaScript(`(${fn.toString()})()`);

  /* ---------------------------------------- 1. 备忘置顶 */
  console.log('\n== 1. 备忘置顶 ==');
  let r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.querySelector('.nav-item[data-view="notes"]').click();
    await sleep(600);
    const cards = [...document.querySelectorAll('.note-card')];
    if (!cards.length) return { ok: false, info: '没有备忘卡片' };
    const target = cards.find((c) => !c.querySelector('.icon-btn[data-act="pin"]').classList.contains('pinned'));
    if (!target) return { ok: false, info: '示例数据里的备忘都已置顶' };
    const id = target.dataset.id;
    const title = target.querySelector('b').textContent;
    target.querySelector('.icon-btn[data-act="pin"]').click();
    await sleep(900);
    const first = document.querySelector('.note-card');
    const btn = document.querySelector(`.note-card[data-id="${id}"] .icon-btn[data-act="pin"]`);
    return {
      ok: !!first && first.dataset.id === id && !!btn && btn.classList.contains('pinned') && btn.textContent.trim() === '★',
      info: `目标《${title}》 首张=${first && (first.querySelector('b') || {}).textContent} 星=${btn && btn.textContent.trim()}`
    };
  });
  check('点☆后变★且卡片置顶到最前', r.ok, r.info);

  /* ---------------------------------------- 2. 伏笔勾选 */
  console.log('\n== 2. 伏笔标记回收 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.querySelector('.nav-item[data-view="foreshadow"]').click();
    await sleep(600);
    const rows = [...document.querySelectorAll('.tr')];
    if (!rows.length) return { ok: false, info: '没有伏笔' };
    const target = rows.find((x) => x.querySelector('.check') && !x.querySelector('.check').classList.contains('on'));
    if (!target) return { ok: false, info: '示例数据里的伏笔都已回收' };
    const id = target.querySelector('.check').dataset.id;
    const title = target.querySelector('b').textContent;
    target.querySelector('.check').click();
    await sleep(900);
    const row = [...document.querySelectorAll('.tr')].find((x) => x.querySelector('.check') && x.querySelector('.check').dataset.id === id);
    const ck = row && row.querySelector('.check');
    return {
      ok: !!row && row.classList.contains('done-row') && !!ck && ck.classList.contains('on') && ck.textContent.trim() === '✓',
      info: `目标《${title}》 行class=${row && row.className} 勾=${ck && ck.textContent.trim()}`
    };
  });
  check('点勾选框后变已回收', r.ok, r.info);

  /* ---------------------------------------- 3. 作品改名 */
  console.log('\n== 3. 作品改名 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.getElementById('btnRenameProject').click();
    await sleep(500);
    const input = document.querySelector('.modal input[name="title"]');
    if (!input) return { ok: false, info: '改名弹窗没出现' };
    const before = input.value;
    input.value = '改名测试作品';
    document.querySelector('.modal [data-btn="1"]').click();
    await sleep(1200);
    const sel = document.getElementById('projectSelect');
    const text = (sel.options[sel.selectedIndex] || {}).textContent || '';
    return { ok: /改名测试作品/.test(text), info: `原名=${before} 顶栏下拉框=${text}` };
  });
  check('顶栏改名后下拉框同步', r.ok, r.info);

  /* ---------------------------------------- 4. 大纲节点改名 */
  console.log('\n== 4. 大纲就地改名 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    document.querySelector('.nav-item[data-view="outline"]').click();
    await sleep(700);
    const row = document.querySelector('.tree-row');
    if (!row) return { ok: false, info: '大纲树是空的' };
    const old = row.querySelector('.tree-title').textContent;
    row.querySelector('.tree-title').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await sleep(300);
    const input = row.querySelector('.rename-input');
    if (!input) return { ok: false, info: '双击标题没有出现输入框' };
    input.value = '改名后的顶层节点';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(1200);
    const titles = [...document.querySelectorAll('.tree-title')].map((t) => t.textContent);
    return { ok: titles.includes('改名后的顶层节点'), info: `原名=${old} 现有=${titles.slice(0, 3).join(' / ')}` };
  });
  check('双击改名并落库', r.ok, r.info);

  /* ---------------------------------------- 5. AI 停止 + 思考过程 */
  console.log('\n== 5. AI 助手：可停止 + 思考过程 ==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const panel = document.getElementById('agentPanel');
    if (!panel.classList.contains('open')) document.getElementById('btnToggleAgent').click();
    await sleep(400);
    const ta = document.getElementById('agentInput');
    if (!ta) return { ok: false, info: '找不到输入框' };
    ta.value = '帮我看看这个故事的节奏';
    document.getElementById('agentSend').click();
    await sleep(1500);
    const btn = document.getElementById('agentSend');
    const during = { text: btn.textContent.trim(), cls: btn.className };
    const think = document.querySelector('#agentMsgs .think');
    const thinkText = think ? think.textContent : '';
    const userBubble = [...document.querySelectorAll('#agentMsgs .bubble.user')].some((b) => b.textContent.includes('帮我看看这个故事的节奏'));
    btn.click();   // 点「停止」
    await sleep(2000);
    const bubbles = [...document.querySelectorAll('#agentMsgs .bubble.assistant')].map((b) => b.textContent);
    const stopped = bubbles.some((t) => /已停止|已手动停止/.test(t));
    const back = document.getElementById('agentSend');
    return {
      ok: during.text.includes('停止') && /danger/.test(during.cls) && thinkText.includes('大纲')
        && userBubble && stopped && back.textContent.trim() === '发送' && !back.disabled,
      info: `回答中按钮=「${during.text}」(${during.cls}) 思考块字数=${thinkText.length} 含大纲=${thinkText.includes('大纲')}`
        + ` 问题已显示=${userBubble} 停止落条=${stopped} 复原=「${back.textContent.trim()}」可用=${!back.disabled}`
    };
  });
  check('发送中可停止、能看见思考过程、停止后落条并复原', r.ok, r.info);

  /* ---------------------------------------- 6. 文本协议模型：操作照常执行、界面不乱 */
  console.log('\n== 6. 文本协议模型（不会 function calling）==');
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const panel = document.getElementById('agentPanel');
    if (!panel.classList.contains('open')) document.getElementById('btnToggleAgent').click();
    await sleep(400);
    document.getElementById('agentInput').value = '协议测试：帮我记两条备忘';
    document.getElementById('agentSend').click();
    let finished = false;
    for (let i = 0; i < 40 && !finished; i++) {     // 最多等 20 秒
      await sleep(500);
      if (document.getElementById('agentSend').textContent.trim() === '发送') finished = true;
    }
    const bubbles = [...document.querySelectorAll('#agentMsgs .bubble.assistant')];
    const last = bubbles[bubbles.length - 1];
    const text = last ? last.textContent : '';
    return {
      ok: finished && /两条备忘都记好了/.test(text) && text.includes('已执行 2 项操作')
        && !text.includes('```') && !text.includes('<br>'),
      info: `跑完=${finished} 有总结=${/两条备忘都记好了/.test(text)} 有操作清单=${text.includes('已执行 2 项操作')}`
        + ` 裸露代码块=${text.includes('```')} 字面<br>=${text.includes('<br>')} 末尾=${JSON.stringify(text.slice(-46))}`
    };
  });
  check('操作被真正执行、给出总结、界面无乱码', r.ok, r.info);

  /* ---------------------------------------- 7. 消息复制（用真剪贴板核对） */
  console.log('\n== 7. 复制消息 ==');
  // Chromium 要求文档处于聚焦状态才允许写剪贴板，隐藏窗口会被拒绝（真实使用不受影响）。
  // 这一节需要把窗口真正显示出来并聚焦，测完再隐藏。
  win.show();
  win.focus();
  await sleep(600);
  clipboard.clear();
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const users = [...document.querySelectorAll('#agentMsgs .bubble.user')];
    const last = users[users.length - 1];
    const text = last.querySelector('.bubble-body').textContent;
    last.querySelector('.bubble-copy').click();
    await sleep(500);
    return { text, btn: last.querySelector('.bubble-copy').textContent.trim(), count: users.length };
  });
  // 这个 Electron 版本的 clipboard.readText() 返回 Promise，两种都兼容
  const readClip = async () => {
    let v = clipboard.readText();
    if (v && typeof v.then === 'function') v = await v;
    return String(v == null ? '' : v);
  };
  const clipUser = await readClip();
  check('复制「我的消息」到剪贴板', !!r.text && clipUser.trim() === r.text.trim(),
    `[${typeof clipboard.readText()}] 剪贴板=${JSON.stringify(clipUser.slice(0, 30))} 期望=${JSON.stringify(String(r.text).slice(0, 30))} 按钮=${r.btn}`);

  clipboard.clear();
  r = await run(async () => {
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const all = [...document.querySelectorAll('#agentMsgs .bubble.assistant')];
    const last = all[all.length - 1];
    const btn = last.querySelector('.bubble-copy');
    btn.click();
    await sleep(500);
    return { btn: btn.textContent.trim(), hasBtn: !!btn, total: all.length };
  });
  const clipAi = await readClip();
  check('复制「助手回答」到剪贴板（拿到的是原文，不是渲染后的 HTML）',
    /两条备忘都记好了/.test(clipAi) && !/```/.test(clipAi),
    `按钮=${r.btn} 剪贴板=${JSON.stringify(clipAi.slice(0, 50))}`);

  clipboard.clear();
  await run(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, shiftKey: true, bubbles: true }));
  });
  await sleep(400);
  const clipKey = await readClip();
  check('Ctrl+Shift+C 复制最后一条回答', /两条备忘都记好了/.test(clipKey), JSON.stringify(clipKey.slice(0, 50)));
  win.hide();

  try { win.destroy(); } catch (_) { /* ignore */ }
  fake.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  app.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('测试异常：', err);
  try { fake.close(); } catch (_) { /* ignore */ }
  app.exit(1);
});
