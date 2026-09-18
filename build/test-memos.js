'use strict';
/**
 * 「AI 记忆点」功能验证（v1.4.1）：
 *  1) 未配置模型时 → 走本地压缩，也能生成精简记忆点
 *  2) 配置模型后 → 记忆点来自模型输出
 *  3) 记忆点真的落盘（chapter.memo）
 *  4) AI 上下文里出现「剧情记忆点」总览与逐章记忆点（不读全文即可掌握剧情）
 *  5) onlyMissing 只补未生成的；空正文章节会被跳过并给出原因
 *  6) 手动编辑 / 清空记忆点生效
 * 用一个假的 OpenAI 兼容服务当模型，不需要真实 API Key。
 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

delete process.env.ELECTRON_RUN_AS_NODE;

const PROJ = path.join(__dirname, '..');
const NODE = process.execPath;
const DATA = path.join(PROJ, '.testmemos');
const PORT = 5411;
const FAKE_PORT = 5412;
const BASE = `http://127.0.0.1:${PORT}`;

const FAKE_MEMO = '主角沈砚于雨夜现身，与陆昭结盟；首次交锋失败，被迫退守旧宅；埋下线索「铜镜」。';

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------ 假模型：返回一段固定摘要 */
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: FAKE_MEMO } }],
      usage: { total_tokens: 42 }
    }));
  });
});

const api = (method, url, body) => fetch(BASE + url, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body)
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

const readStore = () => JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8'));
const chapters = () => readStore().chapters.filter((c) => c.projectId === 'p_memo');

(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  // 种子：一个作品 + 3 章（两章有正文、一章空），暂时不配置模型 → 走本地压缩
  const db = {
    meta: { version: 1, createdAt: Date.now() },
    settings: { providers: [], activeProvider: null, useDemo: true, agentPersona: '', autoApply: false },
    projects: [
      { id: 'p_memo', title: '记忆点测试作品', genre: '悬疑', createdAt: Date.now() },
      { id: 'p_empty', title: '无章节作品', createdAt: Date.now() }
    ],
    chapters: [
      {
        id: 'ch1', projectId: 'p_memo', title: '第一章 雨夜', order: 1, status: 'done',
        content: '雨下得很大。沈砚站在屋檐下，看着街对面的灯。他等的人没有来。忽然，一个身影从巷口走出来，是陆昭。"你迟到了。"沈砚说。陆昭笑了笑，把一枚铜镜递给他。这一夜之后，事情再也回不到从前。'
      },
      {
        id: 'ch2', projectId: 'p_memo', title: '第二章 旧宅', order: 2, status: 'done',
        content: '旧宅的门被推开，灰尘在光里浮。两人摊开地图，第一次交锋以失败告终。退守这里，是他们唯一的选择。陆昭盯着铜镜上的纹路，忽然说："这不是镜子，是钥匙。"'
      },
      { id: 'ch3', projectId: 'p_memo', title: '第三章 空章', order: 3, status: 'todo', content: '' }
    ]
  };
  ['outline', 'characters', 'relations', 'lines', 'beats', 'world', 'foreshadow', 'notes', 'messages', 'materials']
    .forEach((c) => { db[c] = []; });
  fs.writeFileSync(path.join(DATA, 'store.json'), JSON.stringify(db, null, 2));

  await new Promise((r) => fake.listen(FAKE_PORT, r));
  const srv = spawn(NODE, [path.join(PROJ, 'server', 'index.js'), String(PORT)], {
    env: { ...process.env, NOVEL_DATA_DIR: DATA }, stdio: 'ignore'
  });
  await sleep(1500);

  try {
    /* ------------------------------------------ 1. 未配置模型 → 本地压缩 */
    console.log('\n== 1. 未配置模型时的本地降级 ==');
    const r1 = await api('POST', '/api/ai/memos', { projectId: 'p_memo' });
    check('接口返回成功', r1.status === 200 && !!r1.json, `status=${r1.status}`);
    check('生成了 2 章（有正文的）', r1.json && r1.json.updated && r1.json.updated.length === 2, JSON.stringify(r1.json && r1.json.updated && r1.json.updated.map((u) => u.id)));
    check('空正文章节被跳过并说明原因', r1.json && r1.json.skipped && r1.json.skipped.some((s) => s.id === 'ch3' && /正文/.test(s.reason)), JSON.stringify(r1.json && r1.json.skipped));
    const memo1 = r1.json.updated.find((u) => u.id === 'ch1');
    check('记忆点非空', !!memo1 && memo1.memo.length > 0);
    check('记忆点足够精简（≤ 220 字）', memo1 && memo1.memo.length <= 220, `${memo1 && memo1.memo.length} 字`);
    check('标记为演示/本地模式', r1.json.demo === true);

    /* ------------------------------------------ 2. 落盘 */
    console.log('\n== 2. 记忆点真的写进了数据 ==');
    await sleep(300);
    const ch1 = chapters().find((c) => c.id === 'ch1');
    check('chapter.memo 已持久化', !!ch1 && !!String(ch1.memo || '').trim(), JSON.stringify(ch1 && ch1.memo).slice(0, 60));

    /* ------------------------------------------ 3. AI 上下文纳入记忆点 */
    console.log('\n== 3. AI 上下文里能看到剧情记忆点 ==');
    const ctx = await api('GET', '/api/ai/context/p_memo');
    const ctxText = (ctx.json && ctx.json.context) || '';
    check('上下文含「剧情记忆点」总览段', /剧情记忆点/.test(ctxText));
    check('总览里带上了第一章的记忆点', ctxText.includes(memo1.memo.slice(0, 12)));
    check('章节列表里标注了「记忆点：」', /记忆点：/.test(ctxText));

    /* ------------------------------------------ 4. 配置模型后走模型 */
    console.log('\n== 4. 配置模型后由模型生成 ==');
    const put = await api('PUT', '/api/settings', {
      providers: [{
        id: 'ai_memo_fake', name: '记忆点假模型', provider: 'custom',
        endpoint: `http://127.0.0.1:${FAKE_PORT}/v1`, apiKey: 'sk-fake', model: 'fake-memo',
        temperature: 0.3, maxTokens: 400, extraBody: ''
      }],
      activeProvider: 'ai_memo_fake'
    });
    check('模型配置成功', put.status === 200 && put.json.hasKey === true, `status=${put.status}`);
    const r4 = await api('POST', '/api/ai/memos', { projectId: 'p_memo', chapterIds: ['ch1'], onlyMissing: false });
    const m4 = r4.json && r4.json.updated && r4.json.updated[0];
    check('单章生成成功', !!m4, JSON.stringify(r4.json).slice(0, 120));
    check('记忆点内容来自模型', !!m4 && m4.memo === FAKE_MEMO, JSON.stringify(m4 && m4.memo).slice(0, 80));
    check('不再标记为演示模式', r4.json && r4.json.demo === false);

    /* ------------------------------------------ 5. onlyMissing */
    console.log('\n== 5. onlyMissing 只补缺失 ==');
    const r5 = await api('POST', '/api/ai/memos', { projectId: 'p_memo' });
    check('已有记忆点的章节不再重复生成', r5.json && r5.json.updated.length === 0, `updated=${r5.json && r5.json.updated.length}`);
    check('待生成里只剩空正文章节（被跳过）', r5.json && r5.json.processed === 1 && r5.json.skipped.some((s) => s.id === 'ch3'), `processed=${r5.json && r5.json.processed}`);

    /* ------------------------------------------ 6. 手动编辑 / 清空 */
    console.log('\n== 6. 手动编辑与清空 ==');
    const p6 = await api('PATCH', '/api/chapters/ch3', { memo: '手动补的记忆点' });
    check('可以手动给任意章节写记忆点', p6.status === 200);
    await sleep(300);
    check('手动内容已落盘', (chapters().find((c) => c.id === 'ch3') || {}).memo === '手动补的记忆点');
    await api('PATCH', '/api/chapters/ch1', { memo: '' });
    await sleep(300);
    check('可以清空记忆点', String((chapters().find((c) => c.id === 'ch1') || {}).memo || '') === '');
    const r6 = await api('POST', '/api/ai/memos', { projectId: 'p_memo' });
    check('清空后 onlyMissing 会把它重新纳入', r6.json && r6.json.processed === 1, `processed=${r6.json && r6.json.processed}`);

    /* ------------------------------------------ 7. 边界：无章节 */
    console.log('\n== 7. 边界情况 ==');
    const r7 = await api('POST', '/api/ai/memos', { projectId: 'p_empty' });
    check('没有章节时给出明确错误', r7.status !== 200, `status=${r7.status}`);
    const r8 = await api('POST', '/api/ai/memos', {});
    check('缺少 projectId 时被拒绝', r8.status !== 200, `status=${r8.status}`);

    /* ------------------------------------------ 8. 导入 TXT 的解析规则 */
    // 直接把前端源码里的 parseMemoText 抠出来跑，不改动源码、也不污染生产代码
    console.log('\n== 8. 导入 TXT 的解析规则 ==');
    const lines = fs.readFileSync(path.join(PROJ, 'public', 'js', 'views.js'), 'utf8').split('\n');
    const start = lines.findIndex((l) => l.startsWith('function parseMemoText('));
    let end = -1;
    for (let i = start; i < lines.length; i++) { if (lines[i] === '}') { end = i; break; } }
    check('视图里存在 parseMemoText', start >= 0 && end > start, `start=${start} end=${end}`);
    const parseMemoText = new Function(`${lines.slice(start, end + 1).join('\n')}; return parseMemoText;`)();
    const cs = [{ id: 'c1', title: '第一章 雨夜' }, { id: 'c2', title: '第二章 旧宅' }, { id: 'c3', title: '第三章 空章' }];

    const a = parseMemoText('第1章 沈砚登场\n第2章 陆昭出现', cs);
    check('「第N章」按序号对应', a.entries[0].id === 'c1' && a.entries[1].id === 'c2' && a.entries[0].by === 'index',
      JSON.stringify(a.entries));

    const b = parseMemoText('1. 沈砚登场\n2. 陆昭出现', cs);
    check('「N.」也能按序号对应', b.entries[0].id === 'c1' && b.entries[1].id === 'c2', JSON.stringify(b.entries));

    const c = parseMemoText('雨夜：沈砚在雨中出现', cs);
    check('「标题：内容」按标题匹配', c.entries[0].id === 'c1' && c.entries[0].by === 'title'
      && /沈砚在雨中出现/.test(c.entries[0].memo), JSON.stringify(c.entries));

    const d = parseMemoText('沈砚登场\n陆昭出现', cs);
    check('没有标记的行按顺序填入', d.entries[0].id === 'c1' && d.entries[1].id === 'c2' && d.entries[0].by === 'order',
      JSON.stringify(d.entries));

    const e = parseMemoText('第1章 甲\n第2章 乙\n第3章 丙\n多余一\n多余二', cs);
    check('超出章节数的行计为 leftover', e.entries.length === 3 && e.leftover === 2,
      JSON.stringify({ n: e.entries.length, leftover: e.leftover }));

    const f = parseMemoText('', cs);
    check('空文件不会崩', f.entries.length === 0 && f.leftover === 0);
  } catch (err) {
    fail++;
    console.error('  异常：', err && err.stack || err);
  } finally {
    try { srv.kill(); } catch (_) { /* ignore */ }
    try { fake.close(); } catch (_) { /* ignore */ }
    await sleep(200);
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
