'use strict';
/**
 * 针对本次 AI 助手问题的验证：
 *  1) read_chapter 工具能按 id / 标题 / 序号取到章节全文
 *  2) buildContext 带上"作者当前打开的章节"全文
 *  3) AI 调用失败时，作者的问题也不会被吞掉（服务端先落盘 + 失败也给可见回复）
 * 用一份拷贝出来的真实数据（105 章）来测，不碰原数据。
 */
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;                 // build/
const PROJ = path.join(__dirname, '..'); // 项目根
const NODE = process.execPath;
const USER_DATA = path.join(process.env.APPDATA, '小说创作工作台', 'data');
const DATA = path.join(PROJ, '.testai');
process.env.NOVEL_DATA_DIR = DATA; // 必须在 require store 之前设置
const PORT = 5406;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.copyFileSync(path.join(USER_DATA, 'store.json'), path.join(DATA, 'store.json'));

// 1) 工具与上下文（直接调真实代码）
const ai = require(path.join(PROJ, 'server', 'ai.js'));
const store = require(path.join(PROJ, 'server', 'store.js'));
const db = store.load();
const proj = db.projects.map((p) => ({ p, n: db.chapters.filter((c) => c.projectId === p.id).length }))
  .sort((a, b) => b.n - a.n)[0];
const projectId = proj.p.id;
console.log(`[数据] 作品「${proj.p.title}」 ${proj.n} 章`);

const exec = ai.makeExecutor(projectId, []);
const chapters = db.chapters.filter((c) => c.projectId === projectId).sort((a, b) => a.order - b.order);
const target = chapters[3];

const byId = exec.read_chapter({ chapterId: target.id });
check('read_chapter 按 id 取到全文', byId.ok && byId.content.length === (target.content || '').length && byId.content.length > 500,
  `words=${byId.words}`);
const byTitle = exec.read_chapter({ title: target.title });
check('read_chapter 按标题模糊匹配', byTitle.ok && byTitle.id === target.id, `got=${byTitle.id} want=${target.id}`);
const byIndex = exec.read_chapter({ index: 4 });
check('read_chapter 按序号取第 4 章', byIndex.ok && byIndex.id === target.id, `got=${byIndex.id}`);
const miss = exec.read_chapter({});
check('read_chapter 参数不足时给出可读提示', !miss.ok && /chapterId|title|index/.test(miss.message));

const ctx = ai.buildContext(projectId, target.id);
check('上下文包含「作者当前打开的章节」全文', ctx.text.includes(target.content.slice(0, 80)), '未找到正文片段');
check('上下文章节段带 read_chapter 提示', /read_chapter/.test(ctx.text));
console.log(`  （上下文总长 ${ctx.text.length} 字符）`);

// 2) AI 失败也不吞问题：故意配一个打不通的接口（写到 providers 里，新的多模型结构下才能生效）
let p0 = (db.settings.providers && db.settings.providers[0]) || null;
if (!p0) {
  p0 = { id: 'ai_test', name: '测试', provider: 'custom', endpoint: '', apiKey: '', model: 'x', temperature: 0.85, maxTokens: 4096, extraBody: '' };
  db.settings.providers = [p0];
}
p0.endpoint = 'http://127.0.0.1:9/v1'; // 必然连不上
p0.apiKey = 'sk-test';
fs.writeFileSync(path.join(DATA, 'store.json'), JSON.stringify(db, null, 2));
// 让正在跑的服务重新读到（store 是启动时加载的，这里直接重启服务）
store.flush && store.flush();

const srv = spawn(NODE, [path.join(PROJ, 'server', 'index.js'), String(PORT)], {
  env: { ...process.env, NOVEL_DATA_DIR: DATA }, stdio: 'ignore'
});

(async () => {
  await sleep(1500);
  const msg = '帮我检查第三章的逻辑漏洞（这条消息不该被吞掉）';
  const r = await fetch(`${BASE}/api/ai/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, message: msg, chapterId: target.id })
  });
  const j = await r.json();
  check('AI 失败时 HTTP 仍是 200（前端能渲染出回复）', r.status === 200, 'status=' + r.status);
  check('回复里带失败说明', j.failed === true && /这次调用出了问题/.test(j.reply || ''), (j.reply || '').slice(0, 80));

  const db2 = JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8'));
  const saved = db2.messages.filter((m) => m.projectId === projectId);
  const userMsg = saved.find((m) => m.role === 'user' && m.content === msg);
  check('作者的问题已持久化，不再消失', !!userMsg, '未找到该消息');
  check('失败也有一条可见的助手回复', saved.some((m) => m.role === 'assistant' && /这次调用出了问题/.test(m.content)));

  srv.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
