'use strict';
/**
 * 本轮改动的验证（v1.2.0）：
 *  1) /api/ai/chat/stream 真的会推「思考过程 / 工具执行 / 正文」，收尾给 done
 *  2) 中途「停止」能确实中断，并把已生成的部分与已执行的操作落盘
 *  3) 助手消息会存下 thinking / thinkMs / latency
 *  4) 备忘置顶、伏笔状态、作品改名、大纲改名这些接口真的能改到数据
 *       （前端"点了没用"的根因是 ctx.patch 不重绘；数据链路本身在这里对齐）
 * 用一个假的 OpenAI 兼容服务当模型，不需要真实 API Key。
 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

delete process.env.ELECTRON_RUN_AS_NODE;   // 否则子进程会被 Electron 当脚本解释器

const PROJ = path.join(__dirname, '..');
const NODE = process.execPath;
const USER_DATA = path.join(process.env.APPDATA, '小说创作工作台', 'data');
const DATA = path.join(PROJ, '.teststream');
const PORT = 5407;
const FAKE_PORT = 5408;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------ 假模型：会说"思考"、会调工具、能拖时间 */
const SLOW_MARK = '慢慢说';
const PROTO_MARK = '协议测试';   // 触发「模型不支持函数调用、只写文本协议块」的场景
const LONG_MARK = '协议测试长任务';   // 连续 10 轮操作，验证轮次上限
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const payload = JSON.parse(raw || '{}');
    const msgs = payload.messages || [];
    const toolRound = msgs.some((m) => m.role === 'tool');
    const slow = msgs.some((m) => m.role === 'user' && String(m.content).includes(SLOW_MARK));
    const protocol = msgs.some((m) => m.role === 'user' && String(m.content).includes(PROTO_MARK));
    const gotResults = msgs.some((m) => m.role === 'user' && String(m.content).startsWith('执行结果：'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const put = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);

    // 真实故障场景：接口收下了 tools 参数，但模型根本不返回 tool_calls，
    // 只在正文里写 ```json {"tool":...}``` （实测 deepseek 系就是这样）
    if (protocol) {
      // 长任务：连续多轮下达操作，用来验证轮次上限（以前 8 轮就断，长任务做不完）
      if (msgs.some((m) => m.role === 'user' && String(m.content).includes(LONG_MARK))) {
        const done = msgs.filter((m) => m.role === 'user' && String(m.content).startsWith('执行结果：')).length;
        if (done < 10) {
          put({ choices: [{ delta: { content: `第 ${done + 1} 条：\n\n\`\`\`json\n{"tool":"add_note","args":{"title":"长任务备忘${done + 1}","content":"分批写入"}}\n\`\`\`` } }] });
        } else {
          put({ choices: [{ delta: { content: '十批操作都做完了，这就是总结。' } }] });
        }
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      if (!gotResults) {
        put({ choices: [{ delta: { reasoning_content: '我需要先把要写的东西列清楚。' } }] });
        const text = '我来记两条备忘，顺便拉一次上下文：\n\n'
          + '```json\n{"tool":"add_note","args":{"title":"协议测试备忘A","content":"由文本协议写入"}}\n```\n'
          + '```json\n{"tool":"add_note","args":{"title":"协议测试备忘B","content":"第二条"}}\n```\n'
          + '```json\n{"tool":"get_project_context","args":{}}\n```';
        const mid = Math.floor(text.length / 2);
        put({ choices: [{ delta: { content: text.slice(0, mid) } }] });   // 故意分片，验证累积
        put({ choices: [{ delta: { content: text.slice(mid) } }] });
      } else {
        put({ choices: [{ delta: { reasoning_content: '结果拿到了，给作者一个总结。' } }] });
        put({ choices: [{ delta: { content: '已经帮你记好两条备忘了，顺带刷新了项目上下文。' } }] });
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    if (!toolRound) {
      put({ choices: [{ delta: { reasoning_content: '先看看项目里有什么。' } }] });
      put({ choices: [{ delta: { reasoning_content: '需要写一条备忘记录下来。' } }] });
      put({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'add_note', arguments: '{"title":"流式测试备忘",' } }] } }] });
      put({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"由假模型写入","category":"备忘"}' } }] } }] });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    put({ choices: [{ delta: { reasoning_content: '备忘已经写好，给作者一个结论。' } }] });
    if (!slow) {
      put({ choices: [{ delta: { content: '已经帮你建好备忘了。' } }] });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    // 慢速流：每 200ms 吐一小段，留给客户端"停止"
    const chunks = ['这段', '话会', '慢慢', '地说', '出来', '，', '用来', '测试', '停止', '。'];
    let i = 0;
    const timer = setInterval(() => {
      put({ choices: [{ delta: { content: chunks[i] } }] });
      if (++i >= chunks.length) { clearInterval(timer); res.write('data: [DONE]\n\n'); res.end(); }
    }, 200);
    // 注意：要听 res 的 close（req 的 close 在请求体读完就会触发，会误伤）
    res.on('close', () => clearInterval(timer));
  });
});

/* ------------------------------------------------ 测试客户端：读 SSE */
async function streamChat(body, { onEvent, signal } = {}) {
  const res = await fetch(`${BASE}/api/ai/chat/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', final = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      let ev = null;
      try { ev = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
      if (ev.type === 'done' || ev.type === 'stopped' || ev.type === 'error') final = ev;
      if (onEvent) onEvent(ev);
    }
  }
  return final;
}

const api = (method, url, body) => fetch(BASE + url, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body)
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

const readStore = () => JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8'));

(async () => {
  // 准备数据目录：拷一份真实数据，再把模型指向假服务
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  if (fs.existsSync(path.join(USER_DATA, 'store.json'))) {
    fs.copyFileSync(path.join(USER_DATA, 'store.json'), path.join(DATA, 'store.json'));
  }
  const seed = () => {
    const file = path.join(DATA, 'store.json');
    const db = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : { projects: [], settings: {} };
    db.settings = db.settings || {};
    Object.assign(db.settings, {
      provider: 'custom',
      endpoint: `http://127.0.0.1:${FAKE_PORT}/v1`,
      apiKey: 'sk-fake',
      model: 'fake-stream',
      temperature: 0.7,
      maxTokens: 1024
    });
    if (!db.projects.length) {
      db.projects.push({ id: 'p_test', title: '流式测试作品', createdAt: Date.now() });
      db.notes = [{ id: 'n_test', projectId: 'p_test', title: '原备忘', content: '内容', category: '备忘', pinned: false, order: 1 }];
      db.foreshadow = [{ id: 'f_test', projectId: 'p_test', title: '原伏笔', status: 'planted', order: 1 }];
      db.outline = [{ id: 'o_test', projectId: 'p_test', title: '原节点', type: 'act', order: 1 }];
    }
    fs.writeFileSync(file, JSON.stringify(db, null, 2));
  };
  seed();

  await new Promise((r) => fake.listen(FAKE_PORT, r));

  const srv = spawn(NODE, [path.join(PROJ, 'server', 'index.js'), String(PORT)], {
    env: { ...process.env, NOVEL_DATA_DIR: DATA }, stdio: 'ignore'
  });
  await sleep(1500);

  const projectId = readStore().projects[0].id;
  console.log(`[数据] 作品「${readStore().projects[0].title}」（${projectId}），假模型 http://127.0.0.1:${FAKE_PORT}`);

  /* ---------------------------------------------- 1. 流式：思考 / 工具 / 正文 */
  console.log('\n== 1. 流式回答 ==');
  const seen = [];
  const kinds = new Set();
  const final = await streamChat(
    { projectId, message: '帮我把这条灵感记进备忘' },
    { onEvent: (ev) => { seen.push(ev); kinds.add(ev.type); } }
  );
  const thinking = seen.filter((e) => e.type === 'thinking').map((e) => e.text).join('');
  check('收到 thinking 事件（思考过程实时推送）', kinds.has('thinking') && thinking.includes('先看看项目里有什么'), `kinds=${[...kinds]}`);
  check('收到 op 事件（工具真的被执行）', kinds.has('op') && seen.some((e) => e.type === 'op' && /备忘/.test(e.label || '')), JSON.stringify(seen.filter((e) => e.type === 'op')));
  check('收到 answer 事件（正文流式）', kinds.has('answer'));
  check('收到 done 事件', kinds.has('done') && !!final);
  check('最终回答正确', final && /已经帮你建好备忘了/.test(final.reply || ''), (final && final.reply || '').slice(0, 60));
  check('done 里带思考耗时与总耗时', final && final.thinkMs >= 0 && final.latency >= 0, `thinkMs=${final && final.thinkMs} latency=${final && final.latency}`);

  await sleep(400);
  let db = readStore();
  const noted = db.notes.filter((n) => n.projectId === projectId && n.title === '流式测试备忘');
  check('工具写入真的落到数据里', noted.length === 1, `找到 ${noted.length} 条`);
  const saved = db.messages.filter((m) => m.projectId === projectId && m.role === 'assistant');
  const lastMsg = saved[saved.length - 1];
  check('助手消息存下了思考过程', !!lastMsg && /先看看项目里有什么/.test(lastMsg.thinking || ''));
  check('助手消息存下了思考/总耗时', !!lastMsg && typeof lastMsg.thinkMs === 'number' && lastMsg.latency > 0,
    JSON.stringify({ thinkMs: lastMsg && lastMsg.thinkMs, latency: lastMsg && lastMsg.latency }));

  /* ---------------------------------------------- 2. 停止 */
  console.log('\n== 2. 中途停止 ==');
  const ctrl = new AbortController();
  let aborted = false;
  const before = readStore().messages.filter((m) => m.projectId === projectId).length;
  try {
    await streamChat(
      { projectId, message: `${SLOW_MARK}，给我讲一段` },
      { signal: ctrl.signal, onEvent: (ev) => { if (ev.type === 'answer' && ev.text) ctrl.abort(); } }
    );
  } catch (err) {
    aborted = /abort/i.test(err.name || '') || /abort/i.test(err.message || '');
  }
  check('前端能确实中断这次请求', aborted);
  await sleep(1200);   // 等服务端把"已停止"落盘
  db = readStore();
  const msgs2 = db.messages.filter((m) => m.projectId === projectId);
  const stopped = msgs2[msgs2.length - 1];
  check('停止后服务端落盘了一条消息', msgs2.length > before, `${before} → ${msgs2.length}`);
  check('该消息标明是手动停止', !!stopped && stopped.role === 'assistant' && /已手动停止|已停止/.test(stopped.content || ''),
    (stopped && stopped.content || '').slice(0, 60));
  check('停止前已经生成的部分被保留', !!stopped && stopped.content.includes('这段'), (stopped && stopped.content || '').slice(0, 60));
  check('作者的问题本身没有被吞', msgs2.some((m) => m.role === 'user' && String(m.content).includes(SLOW_MARK)));

  /* ---------------------------------------------- 3. 文本协议：模型不会函数调用时，操作也必须真的执行 */
  console.log('\n== 3. 文本协议模型（不会 function calling）==');
  const pSeen = [];
  const pKinds = new Set();
  const pFinal = await streamChat(
    { projectId, message: `${PROTO_MARK}：帮我记两条备忘` },
    { onEvent: (ev) => { pSeen.push(ev); pKinds.add(ev.type); } }
  );
  const pOps = pSeen.filter((e) => e.type === 'op');
  check('模型写的 ```json 操作块被真正执行了', pOps.length >= 2, JSON.stringify(pOps.map((o) => o.label)));
  check('界面收到「已切换文本协议」的说明', pSeen.some((e) => e.type === 'note' && /文本协议/.test(e.text || '')),
    JSON.stringify(pSeen.filter((e) => e.type === 'note')));
  check('只读工具也留下痕迹（读了上下文）', pOps.some((o) => /上下文/.test(o.label || '')), JSON.stringify(pOps.map((o) => o.label)));
  check('执行后继续下一轮（不是把 JSON 当回答）', pKinds.has('round') && pSeen.filter((e) => e.type === 'round').length >= 2,
    `round 数=${pSeen.filter((e) => e.type === 'round').length}`);
  check('最终回答是模型的总结，不是原始 JSON', !!pFinal && /已经帮你记好两条备忘/.test(pFinal.reply || '')
    && !/```/.test(pFinal.reply || '') && !/"tool"/.test(pFinal.reply || ''), (pFinal && pFinal.reply || '').slice(0, 80));
  await sleep(400);
  db = readStore();
  const protoNotes = db.notes.filter((n) => n.projectId === projectId && /^协议测试备忘/.test(n.title || ''));
  check('两条备忘真的写进了数据', protoNotes.length === 2, `找到 ${protoNotes.length} 条：` + protoNotes.map((n) => n.title).join('、'));

  // 长任务：像"把这条副线的所有章节读完再整合"那样，需要十几轮
  const lSeen = [];
  const lFinal = await streamChat(
    { projectId, message: `${LONG_MARK}：分批写十条备忘` },
    { onEvent: (ev) => lSeen.push(ev) }
  );
  const lOps = lSeen.filter((e) => e.type === 'op' && /长任务备忘/.test(e.label || ''));
  check('长任务能连续跑完 10 轮（轮次上限放宽）', lOps.length === 10, `实际执行 ${lOps.length} 批`);
  check('长任务最后也给出了总结', !!lFinal && /十批操作都做完了/.test(lFinal.reply || ''), (lFinal && lFinal.reply || '').slice(0, 60));
  await sleep(400);
  db = readStore();
  check('十条备忘都落库了', db.notes.filter((n) => n.projectId === projectId && /^长任务备忘/.test(n.title || '')).length === 10);

  /* ---------------------------------------------- 4. 置顶 / 伏笔 / 改名 */
  console.log('\n== 4. 置顶、伏笔、改名 ==');
  db = readStore();
  const note = db.notes.find((n) => n.projectId === projectId);
  const foreshadow = db.foreshadow.find((f) => f.projectId === projectId);
  const node = db.outline.find((o) => o.projectId === projectId);

  let r = await api('PATCH', `/api/notes/${note.id}`, { pinned: true });
  check('备忘置顶接口返回成功', r.status === 200 && r.json && r.json.pinned === true);
  await sleep(400);
  check('置顶真的写进了数据', readStore().notes.find((n) => n.id === note.id).pinned === true);

  r = await api('PATCH', `/api/foreshadow/${foreshadow.id}`, { status: 'paid-off' });
  check('伏笔标记已回收接口返回成功', r.status === 200 && r.json && r.json.status === 'paid-off');
  await sleep(400);
  check('伏笔状态真的写进了数据', readStore().foreshadow.find((f) => f.id === foreshadow.id).status === 'paid-off');

  r = await api('PATCH', `/api/projects/${projectId}`, { title: '改过名的作品', genre: '悬疑' });
  check('作品改名接口返回新名字', r.status === 200 && r.json && r.json.title === '改过名的作品');
  await sleep(400);
  const renamed = readStore().projects.find((p) => p.id === projectId);
  check('作品改名真的写进了数据', renamed.title === '改过名的作品' && renamed.genre === '悬疑', JSON.stringify(renamed));

  r = await api('PATCH', `/api/outline/${node.id}`, { title: '改过名的节点' });
  check('大纲节点改名接口返回新名字', r.status === 200 && r.json && r.json.title === '改过名的节点');
  await sleep(400);
  check('大纲改名真的写进了数据', readStore().outline.find((o) => o.id === node.id).title === '改过名的节点');

  // 停止测试要留一条超时保护，避免卡住 CI
  srv.kill();
  fake.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('测试异常：', err);
  try { fake.close(); } catch (_) { /* ignore */ }
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(1);
});
