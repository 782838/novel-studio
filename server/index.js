'use strict';
/**
 * 零依赖 HTTP 服务：静态站点 + REST API。
 *
 * 用法：node server/index.js [端口] [选项]
 *   --data=<目录>   指定数据目录，用来在同一份代码上跑多个互相隔离的实例
 *   --seed          数据目录里还没有作品时，自动载入示例作品《雾隐城》
 *   --open          启动完成后自动用默认浏览器打开
 *
 * 例：
 *   node server/index.js 5367                    # 写作端
 *   node server/index.js 5368 --data=data-demo --seed --open   # 展示端
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ARGS = process.argv.slice(2);
const OPEN_BROWSER = ARGS.includes('--open') || process.env.OPEN_BROWSER === '1';
const SEED = ARGS.includes('--seed') || process.env.NOVEL_SEED === '1';
// NOVEL_PORT 优先（桌面端用 0 让系统分配空闲端口）；其次命令行数字参数；再其次 PORT
const PORT = Number(
  process.env.NOVEL_PORT !== undefined && process.env.NOVEL_PORT !== ''
    ? process.env.NOVEL_PORT
    : (ARGS.find((a) => /^\d+$/.test(a)) || process.env.PORT || 5367)
);
// 打包进 Electron 后 __dirname 在 asar 内，静态资源改用 extraResources 目录
const PUBLIC_DIR = process.env.NOVEL_PUBLIC_DIR
  ? path.resolve(process.env.NOVEL_PUBLIC_DIR)
  : path.join(__dirname, '..', 'public');

// 必须在 require('./store') 之前设置，store 会在加载时据此确定数据目录
const dataArg = ARGS.find((a) => a.startsWith('--data='));
if (dataArg) {
  const raw = dataArg.slice('--data='.length).trim();
  process.env.NOVEL_DATA_DIR = path.isAbsolute(raw) ? raw : path.join(__dirname, '..', raw);
}

const store = require('./store');
const ai = require('./ai');
const novelImport = require('./novel-import');

/** 跨平台调用系统默认浏览器 */
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
  } catch (_) { /* 打不开就算了，手动访问即可 */ }
}

const JSON_COLLS = new Set([
  'outline', 'characters', 'relations', 'lines', 'beats',
  'chapters', 'world', 'foreshadow', 'notes', 'messages', 'materials'
]);

// ---------------------------------------------------------------- 迷你路由

const routes = [];
function on(method, pattern, handler) {
  const segs = pattern.split('/').filter(Boolean);
  routes.push({ method, segs, handler });
}
function match(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method || r.segs.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < r.segs.length; i++) {
      const s = r.segs[i];
      if (s.startsWith(':')) params[s.slice(1)] = decodeURIComponent(parts[i]);
      else if (s !== parts[i]) { ok = false; break; }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

// ---------------------------------------------------------------- 工具

function send(res, code, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  const base = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Cache-Control': 'no-store'
  };
  res.writeHead(code, {
    ...base,
    ...(isBuf || typeof body === 'string' ? { 'Content-Type': 'text/plain; charset=utf-8' } : { 'Content-Type': 'application/json; charset=utf-8' }),
    ...headers
  });
  res.end(payload);
}
const ok = (res, data) => send(res, 200, data);
const fail = (res, err, code = 400) => send(res, code, { error: String(err && err.message ? err.message : err) });

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

async function handler(h, req, res, params) {
  try { await h({ req, res, params, body: req.$body || {} }); }
  catch (err) {
    console.error('[api]', req.method, req.url, err.message);
    fail(res, err, err.status || 400);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json'
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let file = path.join(PUBLIC_DIR, rel);
  // 防目录穿越
  if (!file.startsWith(PUBLIC_DIR)) return fail(res, '非法路径', 403);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) file = path.join(PUBLIC_DIR, 'index.html');
    else return send(res, 404, 'Not Found');
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------- 元数据

const TYPE_LABEL = { act: '幕/卷', chapter: '章', scene: '场景', beat: '节拍' };
const STATUS_LABEL = { idea: '灵感', todo: '待写', draft: '草稿', done: '完成', active: '进行中', planned: '已排', planted: '已埋', 'paid-off': '已回收' };
const LINE_LABEL = { main: '主线', sub: '副线', romance: '感情线', mystery: '悬念线', growth: '成长线', other: '其他' };

// ---------------------------------------------------------------- 路由定义

on('GET', '/api/meta', async ({ res }) => {
  ok(res, {
    typeLabel: TYPE_LABEL,
    statusLabel: STATUS_LABEL,
    lineLabel: LINE_LABEL,
    configured: ai.llmEnabled()
  });
});

// --- 设置

on('GET', '/api/settings', async ({ res }) => {
  const s = store.load().settings;
  ok(res, { ...s, hasKey: Boolean(s.apiKey) });
});

on('PUT', '/api/settings', async ({ res, body }) => {
  const db = store.load();
  const allow = ['provider', 'endpoint', 'apiKey', 'model', 'temperature', 'maxTokens', 'useDemo', 'agentPersona', 'autoApply', 'extraBody'];
  allow.forEach((k) => {
    if (body[k] !== undefined) {
      let v = body[k];
      if (k === 'temperature' || k === 'maxTokens') v = Number(v);
      if (k === 'temperature') v = Math.min(2, Math.max(0, v));
      if (k === 'maxTokens') v = Math.min(131072, Math.max(256, v));
      db.settings[k] = typeof v === 'string' ? v.trim() : v;
    }
  });
  store.save();
  ok(res, { ...db.settings, hasKey: Boolean(db.settings.apiKey) });
});

// --- 项目

on('GET', '/api/projects', async ({ res }) => {
  const projects = store.all('projects').slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  ok(res, projects);
});

on('POST', '/api/projects', async ({ res, body }) => {
  const p = store.insert('projects', {
    title: (body.title || '未命名作品').trim(),
    genre: body.genre || '',
    targetWords: body.targetWords || 0,
    synopsis: body.synopsis || '',
    cover: body.cover || 'indigo'
  });
  ok(res, p);
});

/** 载入示例作品《雾隐城》（前端按钮与展示端 --seed 共用） */
on('POST', '/api/sample', async ({ res }) => {
  const { seedSampleProject } = require('./sample');
  ok(res, seedSampleProject());
});

on('GET', '/api/projects/:id', async ({ res, params }) => {
  const bundle = store.bundle(params.id);
  if (!bundle) return fail(res, '项目不存在', 404);
  ok(res, bundle);
});

on('PATCH', '/api/projects/:id', async ({ res, params, body }) => {
  const patch = {};
  ['title', 'genre', 'synopsis', 'targetWords', 'cover'].forEach((k) => {
    if (body[k] !== undefined) patch[k] = body[k];
  });
  const p = store.update('projects', params.id, patch);
  if (!p) return fail(res, '项目不存在', 404);
  ok(res, p);
});

on('DELETE', '/api/projects/:id', async ({ res, params }) => {
  store.deleteProject(params.id);
  ok(res, { ok: true });
});

on('POST', '/api/projects/:id/duplicate', async ({ res, params, body }) => {
  const bundle = store.bundle(params.id);
  if (!bundle) return fail(res, '项目不存在', 404);
  const np = store.insert('projects', { ...strip(bundle.project), title: body.title || `${bundle.project.title}（副本）` });
  const idMap = new Map();

  bundle.outline.slice().sort((a, b) => (a.order || 0) - (b.order || 0)).forEach((n) => {
    const c = store.insert('outline', { ...strip(n), projectId: np.id, parentId: null });
    idMap.set(n.id, c.id);
  });
  bundle.outline.forEach((n) => {
    if (n.parentId && idMap.has(n.parentId)) store.update('outline', idMap.get(n.id), { parentId: idMap.get(n.parentId) });
  });
  const charMap = new Map();
  bundle.characters.forEach((c) => {
    const nc = store.insert('characters', { ...strip(c), projectId: np.id });
    charMap.set(c.id, nc.id);
  });
  bundle.relations.forEach((r) => {
    if (charMap.has(r.fromId) && charMap.has(r.toId)) {
      store.insert('relations', { ...strip(r), projectId: np.id, fromId: charMap.get(r.fromId), toId: charMap.get(r.toId) });
    }
  });
  const lineMap = new Map();
  bundle.lines.forEach((l) => {
    const nl = store.insert('lines', { ...strip(l), projectId: np.id });
    lineMap.set(l.id, nl.id);
  });
  bundle.beats.forEach((b) => {
    if (lineMap.has(b.lineId)) {
      store.insert('beats', { ...strip(b), projectId: np.id, lineId: lineMap.get(b.lineId), nodeId: idMap.get(b.nodeId) || null });
    }
  });
  bundle.chapters.forEach((c) => store.insert('chapters', { ...strip(c), projectId: np.id, nodeId: idMap.get(c.nodeId) || null }));
  bundle.world.forEach((w) => store.insert('world', { ...strip(w), projectId: np.id }));
  bundle.foreshadow.forEach((f) => store.insert('foreshadow', { ...strip(f), projectId: np.id }));
  bundle.notes.forEach((n) => store.insert('notes', { ...strip(n), projectId: np.id }));
  (bundle.materials || []).forEach((m) => store.insert('materials', { ...strip(m), projectId: np.id }));

  store.flush();
  ok(res, np);
});

on('GET', '/api/projects/:id/export', async ({ res, params, req }) => {
  const bundle = store.bundle(params.id);
  if (!bundle) return fail(res, '项目不存在', 404);
  const fmt = new URL(req.url, 'http://x').searchParams.get('format') || 'json';
  if (fmt === 'md') {
    ok(res, { markdown: toMarkdown(bundle) });
  } else {
    ok(res, bundle);
  }
});

on('POST', '/api/projects/import', async ({ res, body }) => {
  const data = body.bundle || body;
  if (!data || !data.project) return fail(res, '导入数据缺少 project 字段');
  const p = store.insert('projects', {
    title: data.project.title || '导入作品',
    genre: data.project.genre || '',
    synopsis: data.project.synopsis || '',
    targetWords: data.project.targetWords || 0,
    cover: data.project.cover || 'indigo'
  });
  const idMap = new Map();
  (data.outline || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0)).forEach((n) => {
    const c = store.insert('outline', { ...strip(n), projectId: p.id, parentId: null });
    idMap.set(n.id, c.id);
  });
  (data.outline || []).forEach((n) => {
    if (n.parentId && idMap.has(n.parentId)) store.update('outline', idMap.get(n.id), { parentId: idMap.get(n.parentId) });
  });
  const charMap = new Map();
  (data.characters || []).forEach((c) => {
    const nc = store.insert('characters', { ...strip(c), projectId: p.id });
    charMap.set(c.id, nc.id);
  });
  (data.relations || []).forEach((r) => {
    if (charMap.has(r.fromId) && charMap.has(r.toId)) store.insert('relations', { ...strip(r), projectId: p.id, fromId: charMap.get(r.fromId), toId: charMap.get(r.toId) });
  });
  const lineMap = new Map();
  (data.lines || []).forEach((l) => {
    const nl = store.insert('lines', { ...strip(l), projectId: p.id });
    lineMap.set(l.id, nl.id);
  });
  (data.beats || []).forEach((b) => {
    if (lineMap.has(b.lineId)) store.insert('beats', { ...strip(b), projectId: p.id, lineId: lineMap.get(b.lineId) });
  });
  (data.chapters || []).forEach((c) => store.insert('chapters', { ...strip(c), projectId: p.id }));
  (data.world || []).forEach((w) => store.insert('world', { ...strip(w), projectId: p.id }));
  (data.foreshadow || []).forEach((f) => store.insert('foreshadow', { ...strip(f), projectId: p.id }));
  (data.notes || []).forEach((n) => store.insert('notes', { ...strip(n), projectId: p.id }));
  (data.materials || []).forEach((m) => store.insert('materials', { ...strip(m), projectId: p.id }));

  store.flush();
  ok(res, p);
});

/**
 * 小说 TXT 分章预览：只切分、不入库，便于导入前确认识别结果。
 * body: { content, title }
 */
on('POST', '/api/novel/preview', async ({ res, body }) => {
  const text = String(body.content || '');
  if (!text.trim()) return fail(res, '内容为空', 400);
  const chapters = novelImport.detectChapters(text);
  ok(res, {
    title: body.title || '',
    chapterCount: chapters.length,
    totalWords: chapters.reduce((a, c) => a + c.words, 0),
    chapters: chapters.slice(0, 40).map((c) => ({ index: c.index, title: c.title, words: c.words }))
  });
});

/**
 * 把单本小说文本分章，并（可选）用 AI 解析出元数据，作为新作品归档到作品列表。
 * @returns {{project, chaptersCreated, charactersCreated, analyzed}}
 */
async function buildNovelProject(text, opts) {
  const { title, fileName, genre, useAI } = opts || {};
  const chapters = novelImport.detectChapters(text);
  if (!chapters.length) throw new Error('未能从文本中解析出任何内容');

  const doAI = useAI !== false && ai.llmEnabled();
  let analysis = null;
  if (doAI) {
    const sample = novelImport.summarize(text);
    const titles = chapters.map((c) => c.title).filter(Boolean);
    analysis = await ai.analyzeNovel({ titleHint: title, genreHint: genre, sample, titles });
  }

  const fileTitle = (fileName || '').trim().replace(/\.txt$/i, '').trim();
  const finalTitle = (analysis && analysis.title && String(analysis.title).trim())
    || (title && title.trim())
    || fileTitle
    || '导入的小说';
  const finalGenre = (analysis && analysis.genre && String(analysis.genre).trim())
    || (genre && genre.trim())
    || '';
  const synopsis = (analysis && analysis.synopsis && String(analysis.synopsis).trim()) || '';

  const p = store.insert('projects', {
    title: finalTitle,
    genre: finalGenre,
    synopsis,
    targetWords: chapters.reduce((a, c) => a + c.words, 0),
    cover: ai.pickColor(finalTitle)
  });

  let chapterCount = 0;
  chapters.forEach((c, i) => {
    store.insert('chapters', {
      projectId: p.id,
      title: c.title,
      summary: '',
      content: c.content,
      status: 'done',
      order: i + 1
    });
    chapterCount++;
  });

  const charactersCreated = insertAnalysisExtras(p.id, analysis);

  return { project: p, chaptersCreated: chapterCount, charactersCreated, analyzed: Boolean(analysis) };
}

/**
 * 把 AI 解析出的角色 / 大纲 / 世界观写入指定项目。
 * @param opts.skipOutline 合并导入时跳过「叙事阶段→大纲」，避免与「卷」节点混在一起
 * @returns {number} 创建的角色数
 */
function insertAnalysisExtras(projectId, analysis, opts = {}) {
  const createdChars = [];
  if (analysis && Array.isArray(analysis.characters)) {
    analysis.characters
      .filter((ch) => ch && ch.name && String(ch.name).trim())
      .slice(0, 12)
      .forEach((ch) => {
        const c = store.insert('characters', {
          projectId,
          name: String(ch.name).trim(),
          role: ch.role || '配角',
          alias: ch.alias || '',
          age: ch.age || '',
          appearance: ch.appearance || '',
          personality: ch.personality || '',
          motivation: ch.motivation || '',
          flaw: ch.flaw || '',
          arc: ch.arc || '',
          order: store.nextOrder(store.byProject('characters', projectId))
        });
        createdChars.push(c);
      });
  }

  if (!opts.skipOutline && analysis && Array.isArray(analysis.outline)) {
    analysis.outline
      .filter((o) => o && o.title && String(o.title).trim())
      .slice(0, 8)
      .forEach((o, idx) => {
        const type = ['act', 'chapter', 'scene', 'beat'].includes(o.type) ? o.type : 'act';
        store.insert('outline', {
          projectId,
          parentId: null,
          type,
          title: String(o.title).trim(),
          summary: (o.summary || '').trim(),
          status: 'idea',
          order: idx + 1
        });
      });
  }

  if (analysis && Array.isArray(analysis.world)) {
    analysis.world
      .filter((w) => w && w.title && String(w.title).trim())
      .slice(0, 8)
      .forEach((w) => {
        const cats = ['地理', '历史', '规则', '势力', '物品', '习俗', '种族', '其他'];
        const cat = cats.includes(w.category) ? w.category : '其他';
        store.insert('world', {
          projectId,
          category: cat,
          title: String(w.title).trim(),
          content: (w.content || '').trim(),
          order: store.nextOrder(store.byProject('world', projectId))
        });
      });
  }

  return createdChars.length;
}

/**
 * 导入小说 TXT（单本）：自动分章，可选调用 AI 解析角色/简介/大纲，归档为作品列表中的新作品。
 * body: { content, title, genre, useAI }
 */
on('POST', '/api/projects/import/novel', async ({ res, body }) => {
  const text = String(body.content || '');
  if (!text.trim()) return fail(res, '内容为空', 400);
  try {
    const r = await buildNovelProject(text, { title: body.title, fileName: body.fileName, genre: body.genre, useAI: body.useAI });
    store.flush();
    ok(res, r);
  } catch (err) {
    fail(res, err.message || '导入失败', 400);
  }
});

/**
 * 小说 TXT 分章预览（批量）：只切分、不入库。
 * body: { files: [{ content, title }] }
 */
on('POST', '/api/novel/preview/batch', async ({ res, body }) => {
  const files = Array.isArray(body.files) ? body.files : [];
  const out = files.map((f, i) => {
    const text = String((f && f.content) || '');
    if (!text.trim()) return { index: i, name: f && f.name ? f.name : '', ok: false, error: '内容为空' };
    try {
      const chapters = novelImport.detectChapters(text);
      return {
        index: i,
        name: f.name || '',
        ok: true,
        chapterCount: chapters.length,
        totalWords: chapters.reduce((a, c) => a + c.words, 0),
        chapters: chapters.slice(0, 40).map((c) => ({ index: c.index, title: c.title, words: c.words }))
      };
    } catch (err) {
      return { index: i, name: f.name || '', ok: false, error: err.message };
    }
  });
  ok(res, { files: out });
});

/**
 * 导入小说 TXT（批量）：每本各自分章、可选 AI 解析，分别归档为独立作品。
 * body: { useAI, files: [{ content, title, fileName, genre }] }
 */
on('POST', '/api/projects/import/novel/batch', async ({ res, body }) => {
  const files = Array.isArray(body.files) ? body.files : [];
  const useAI = body.useAI !== false && ai.llmEnabled();
  const results = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i] || {};
    const name = f.name || `文件${i + 1}`;
    const text = String(f.content || '');
    try {
      if (!text.trim()) throw new Error('内容为空');
      const r = await buildNovelProject(text, {
        title: f.title, fileName: f.fileName || name, genre: f.genre, useAI
      });
      results.push({
        index: i, name, ok: true,
        project: { id: r.project.id, title: r.project.title },
        chaptersCreated: r.chaptersCreated,
        charactersCreated: r.charactersCreated,
        analyzed: r.analyzed
      });
    } catch (err) {
      results.push({ index: i, name, ok: false, error: err.message });
    }
  }
  store.flush();
  ok(res, { results, okCount: results.filter((r) => r.ok).length, total: results.length });
});

/**
 * 合并导入小说 TXT：把多个文件合并成「一本」作品，每个文件作为一个「卷」，
 * 各卷的章节通过 nodeId 挂到对应大纲节点下，章节 order 全局连续。
 * 可选 AI 解析（基于第一个文件，抽出书名/类型/简介/角色/世界观）。
 * body: { title, genre, useAI, files: [{ content, fileName, title }] }
 */
on('POST', '/api/projects/import/novel/merge', async ({ res, body }) => {
  const rawFiles = Array.isArray(body.files) ? body.files : [];
  if (!rawFiles.length) return fail(res, '没有可合并的文件', 400);

  const parsed = [];
  for (const f of rawFiles) {
    const text = String((f && f.content) || '');
    if (!text.trim()) continue;
    const chapters = novelImport.detectChapters(text);
    if (!chapters.length) continue;
    const name = String((f.fileName || f.name || '') || '').trim().replace(/\.txt$/i, '').trim();
    parsed.push({ fileName: name, raw: text, chapters });
  }
  if (!parsed.length) return fail(res, '所有文件都没有解析出内容', 400);

  const useAI = body.useAI !== false && ai.llmEnabled();
  let analysis = null;
  if (useAI) {
    const first = parsed[0];
    const sample = novelImport.summarize(first.raw);
    const titles = first.chapters.map((c) => c.title).filter(Boolean);
    analysis = await ai.analyzeNovel({ titleHint: body.title, genreHint: body.genre, sample, titles });
  }

  const title = (analysis && analysis.title && String(analysis.title).trim())
    || (body.title && body.title.trim())
    || parsed[0].fileName
    || '合并导入的小说';
  const genre = (analysis && analysis.genre && String(analysis.genre).trim())
    || (body.genre && body.genre.trim())
    || '';
  const synopsis = (analysis && analysis.synopsis && String(analysis.synopsis).trim()) || '';
  const totalWords = parsed.reduce((a, p) => a + p.chapters.reduce((x, c) => x + c.words, 0), 0);

  const p = store.insert('projects', {
    title,
    genre,
    synopsis,
    targetWords: totalWords,
    cover: ai.pickColor(title)
  });

  let chapterOrder = 0;
  const volumes = [];
  parsed.forEach((file, vi) => {
    const volName = file.fileName || `第 ${vi + 1} 卷`;
    const node = store.insert('outline', {
      projectId: p.id,
      parentId: null,
      type: 'act',
      title: volName,
      summary: `${file.chapters.length} 章`,
      status: 'done',
      order: vi + 1
    });
    file.chapters.forEach((c) => {
      chapterOrder++;
      store.insert('chapters', {
        projectId: p.id,
        nodeId: node.id,
        title: c.title,
        summary: '',
        content: c.content,
        status: 'done',
        order: chapterOrder
      });
    });
    volumes.push({ id: node.id, title: volName, chapters: file.chapters.length });
  });

  const charactersCreated = insertAnalysisExtras(p.id, analysis, { skipOutline: true });

  store.flush();
  ok(res, {
    project: p,
    volumes: volumes.length,
    volumeList: volumes,
    chaptersCreated: chapterOrder,
    charactersCreated,
    analyzed: Boolean(analysis)
  });
});

// --- 集合 CRUD

on('POST', '/api/projects/:id/:coll', async ({ res, params, body }) => {
  const { id, coll } = params;
  if (!JSON_COLLS.has(coll)) return fail(res, `未知集合 ${coll}`, 404);
  if (!store.getProject(id)) return fail(res, '项目不存在', 404);

  let list = store.where(coll, (x) => x.projectId === id);
  if (coll === 'beats' && body.lineId) list = list.filter((x) => x.lineId === body.lineId);
  if (coll === 'outline') {
    list = body.parentId ? list.filter((x) => x.parentId === body.parentId) : list.filter((x) => !x.parentId);
  }

  const base = { projectId: id, order: store.nextOrder(list) };
  if (coll === 'outline') Object.assign(base, { parentId: body.parentId || null, type: body.type || 'chapter', status: 'idea' });
  if (coll === 'characters') Object.assign(base, { role: '配角', color: ai.pickColor(body.name || Date.now().toString()) });
  if (coll === 'lines') Object.assign(base, { kind: body.kind || 'sub', color: body.color || ai.pickColor(body.name || Date.now().toString()), status: 'active' });
  if (coll === 'beats') Object.assign(base, { lineId: body.lineId, status: 'planned' });
  if (coll === 'chapters') Object.assign(base, { content: '', status: 'todo' });
  if (coll === 'foreshadow') Object.assign(base, { status: 'planted' });
  if (coll === 'notes') Object.assign(base, { category: body.category || '备忘', pinned: false });

  const item = store.insert(coll, { ...body, ...base, projectId: id });
  ok(res, item);
});

on('PATCH', '/api/:coll/:eid', async ({ res, params, body }) => {
  const { coll, eid } = params;
  if (!JSON_COLLS.has(coll)) return fail(res, `未知集合 ${coll}`, 404);
  const patch = { ...body };
  ['id', 'projectId', 'createdAt'].forEach((k) => delete patch[k]);
  const item = store.update(coll, eid, patch);
  if (!item) return fail(res, '条目不存在', 404);
  ok(res, item);
});

on('DELETE', '/api/:coll/:eid', async ({ res, params }) => {
  const { coll, eid } = params;
  if (!JSON_COLLS.has(coll)) return fail(res, `未知集合 ${coll}`, 404);
  const item = store.find(coll, eid);
  if (!item) return fail(res, '条目不存在', 404);

  // 级联清理
  if (coll === 'characters') {
    store.removeWhere('relations', (r) => r.fromId === eid || r.toId === eid);
  }
  if (coll === 'lines') {
    store.removeWhere('beats', (b) => b.lineId === eid);
  }
  if (coll === 'outline') {
    const doomed = new Set([eid]);
    let grew = true;
    while (grew) {
      grew = false;
      store.where('outline', (n) => n.parentId && doomed.has(n.parentId)).forEach((n) => {
        if (!doomed.has(n.id)) { doomed.add(n.id); grew = true; }
      });
    }
    Array.from(doomed).forEach((nid) => store.remove('outline', nid));
    store.where('beats', (b) => doomed.has(b.nodeId)).forEach((b) => store.update('beats', b.id, { nodeId: null }));
    store.where('chapters', (c) => doomed.has(c.nodeId)).forEach((c) => store.update('chapters', c.id, { nodeId: null }));
    store.flush();
    return ok(res, { ok: true, removed: doomed.size });
  }

  store.remove(coll, eid);
  store.flush();
  ok(res, { ok: true });
});

/**
 * 批量导入外部素材（从其他 AI 平台导出的对话）。
 * body: { items: [{title, source, content, messageCount}], source }
 */
on('POST', '/api/projects/:id/materials/import', async ({ res, params, body }) => {
  const project = store.getProject(params.id);
  if (!project) return fail(res, '项目不存在', 404);
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return fail(res, '没有可导入的内容');

  const created = [];
  for (const it of items.slice(0, 200)) {
    const content = String(it.content || '').trim();
    if (!content) continue;
    const m = store.insert('materials', {
      projectId: params.id,
      title: String(it.title || '未命名素材').trim().slice(0, 80),
      source: String(it.source || body.source || '外部导入').slice(0, 40),
      content,
      messageCount: Number(it.messageCount) || 0,
      tags: Array.isArray(it.tags) ? it.tags.slice(0, 10) : [],
      importedAt: Date.now(),
      order: store.nextOrder(store.byProject('materials', params.id))
    });
    created.push(m);
  }
  store.flush();
  ok(res, { ok: true, created: created.length, materials: created });
});

on('DELETE', '/api/projects/:id/messages', async ({ res, params }) => {
  store.removeWhere('messages', (m) => m.projectId === params.id);
  store.flush();
  ok(res, { ok: true });
});

// --- AI

on('POST', '/api/ai/test', async ({ res }) => {
  try { ok(res, await ai.testConnection()); }
  catch (err) { ok(res, { ok: false, configured: true, message: err.message }); }
});

on('POST', '/api/ai/chat', async ({ res, body }) => {
  const { projectId, chapterId } = body;
  const text = String(body.message || '').trim();
  if (!projectId) return fail(res, '缺少 projectId');
  if (!text) return fail(res, '内容为空');

  const history = store.where('messages', (m) => m.projectId === projectId)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .slice(-10)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

  const t0 = Date.now();
  // 先把作者的问题落盘——就算接下来 AI 出错，问题也绝不能"消失"
  store.insert('messages', { projectId, role: 'user', content: text });

  let result;
  try {
    result = await ai.runAgent({ projectId, message: text, history, chapterId: chapterId || null });
  } catch (err) {
    console.error('[ai/chat]', err.message);
    const reply = `这次调用出了问题：${err.message}\n\n你的问题已经保留在上面，可以直接重发一次；如果反复失败，请到「设置 → 模型」检查接口地址、Key 与模型名。`;
    store.insert('messages', { projectId, role: 'assistant', content: reply, ops: [] });
    store.flush();
    ok(res, { reply, ops: [], failed: true, latency: Date.now() - t0 });
    return;
  }

  store.insert('messages', { projectId, role: 'assistant', content: result.reply, ops: result.ops });
  store.flush();
  ok(res, { ...result, latency: Date.now() - t0 });
});

on('POST', '/api/ai/generate', async ({ res, body }) => {
  const { projectId, kind, params } = body;
  if (!projectId) return fail(res, '缺少 projectId');
  const result = await ai.generate({ projectId, kind, params: params || {} });
  ok(res, result);
});

on('POST', '/api/ai/continue', async ({ res, body }) => {
  const { projectId, chapterId, instruction, words } = body;
  if (!chapterId) return fail(res, '缺少 chapterId');
  const result = await ai.continueChapter({ projectId, chapterId, instruction: instruction || '', words: words || 600 });
  ok(res, result);
});

on('GET', '/api/ai/context/:id', async ({ res, params }) => {
  try { ok(res, { context: ai.buildContext(params.id).text }); }
  catch (err) { fail(res, err, 404); }
});

// ---------------------------------------------------------------- 导出 Markdown

/** 复制条目时剔除主键与时间戳，避免 id 被 undefined 覆盖 */
function strip(obj, keys = ['id', 'createdAt', 'updatedAt']) {
  const out = { ...obj };
  keys.forEach((k) => delete out[k]);
  return out;
}

function toMarkdown(bundle) {
  const p = bundle.project;
  const out = [`# 《${p.title}》`, ''];
  if (p.genre) out.push(`> 类型：${p.genre}`, '');
  if (p.synopsis) out.push(`## 简介`, '', p.synopsis, '');

  // 大纲
  const nodes = bundle.outline;
  const childrenOf = (pid) => nodes.filter((n) => (n.parentId || null) === pid).sort((a, b) => (a.order || 0) - (b.order || 0));
  if (nodes.length) {
    out.push('## 大纲', '');
    const walk = (pid, depth) => {
      childrenOf(pid).forEach((n) => {
        out.push(`${'#'.repeat(Math.min(6, depth + 3))} ${n.title}　\`${TYPE_LABEL[n.type] || n.type}\``, '');
        if (n.summary) out.push(n.summary, '');
        walk(n.id, depth + 1);
      });
    };
    walk(null, 0);
  }

  if (bundle.characters.length) {
    out.push('## 角色', '');
    bundle.characters.forEach((c) => {
      out.push(`### ${c.name}${c.role ? `（${c.role}）` : ''}`, '');
      [['别名', c.alias], ['年龄', c.age], ['外貌', c.appearance], ['性格', c.personality],
      ['动机', c.motivation], ['弱点', c.flaw], ['弧光', c.arc], ['转折', c.beatNote]]
        .forEach(([k, v]) => { if (v) out.push(`- **${k}**：${v}`); });
      out.push('');
    });
    const relMap = new Map(bundle.characters.map((c) => [c.id, c.name]));
    if (bundle.relations.length) {
      out.push('### 人物关系', '');
      bundle.relations.forEach((r) => {
        out.push(`- ${relMap.get(r.fromId) || '?'} → ${relMap.get(r.toId) || '?'}：${r.label}${r.description ? `（${r.description}）` : ''}`);
      });
      out.push('');
    }
  }

  if (bundle.lines.length) {
    out.push('## 故事线', '');
    bundle.lines.forEach((l) => {
      out.push(`### [${LINE_LABEL[l.kind] || l.kind}] ${l.name}`, '');
      if (l.description) out.push(l.description, '');
      bundle.beats.filter((b) => b.lineId === l.id).sort((a, b) => (a.order || 0) - (b.order || 0))
        .forEach((b, i) => out.push(`${i + 1}. **${b.title}**${b.description ? ` — ${b.description}` : ''}`));
      out.push('');
    });
  }

  if (bundle.chapters.length) {
    out.push('## 章节', '');
    bundle.chapters.sort((a, b) => (a.order || 0) - (b.order || 0)).forEach((c) => {
      out.push(`### ${c.title}`, '');
      if (c.summary) out.push(`> ${c.summary}`, '');
      if (c.content) out.push(c.content, '');
    });
  }

  const groups = {};
  (bundle.world || []).forEach((w) => { (groups[w.category || '其他'] ||= []).push(w); });
  if (Object.keys(groups).length) {
    out.push('## 世界设定', '');
    Object.entries(groups).forEach(([cat, list]) => {
      out.push(`### ${cat}`, '');
      list.forEach((w) => out.push(`- **${w.title}**：${w.content || ''}`));
      out.push('');
    });
  }

  if (bundle.foreshadow && bundle.foreshadow.length) {
    out.push('## 伏笔', '');
    bundle.foreshadow.forEach((f) => out.push(`- [${f.status === 'paid-off' ? '已回收' : '已埋'}] **${f.title}**${f.payoffHint ? ` → ${f.payoffHint}` : ''}`));
    out.push('');
  }

  if (bundle.notes && bundle.notes.length) {
    out.push('## 备忘', '');
    bundle.notes.forEach((n) => out.push(`- [${n.category || '备忘'}] **${n.title}**：${n.content || ''}`));
    out.push('');
  }

  if (bundle.materials && bundle.materials.length) {
    out.push('## 外部素材', '');
    bundle.materials.forEach((m) => {
      out.push(`### ${m.title}`, '');
      if (m.source) out.push(`> 来源：${m.source}`, '');
      out.push(m.content, '');
    });
  }

  return out.join('\n');
}

// ---------------------------------------------------------------- 启动

process.on('exit', () => { try { store.flush(); } catch (_) { /* ignore */ } });
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => { store.flush(); process.exit(0); });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

  const found = match(req.method, url.pathname);
  if (!found) return fail(res, `接口不存在：${req.method} ${url.pathname}`, 404);

  if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
    try { req.$body = await readBody(req); }
    catch (err) { return fail(res, err); }
  }
  return handler(found.handler, req, res, found.params);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // 嵌入式（Electron）运行时不退出进程，交给宿主处理
    if (process.env.NOVEL_EMBEDDED === '1') return;
    console.error('');
    console.error(`  [错误] 端口 ${PORT} 已被占用。`);
    console.error(`  可能已经有一个工作台在运行，先关掉它，或换个端口：`);
    console.error(`      node server/index.js ${PORT + 1}`);
    console.error('');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  // 展示端等场景下，数据目录为空时自动铺一份示例作品
  if (SEED && store.load().projects.length === 0) {
    try {
      require('./sample').seedSampleProject();
      console.log('      已自动载入示例作品《雾隐城》');
    } catch (err) {
      console.warn('      示例作品载入失败：', err.message);
    }
  }

  const db = store.load();
  const actualPort = server.address().port;
  const instance = path.basename(store.DATA_DIR);
  console.log('');
  console.log('  小说创作工作台已启动');
  console.log(`      地址：http://localhost:${actualPort}`);
  console.log(`      实例：${instance}　（${store.DATA_DIR}）`);
  console.log(`      作品数：${db.projects.length}`);
  console.log(`      模型：${ai.llmEnabled() ? `${db.settings.model}（${db.settings.endpoint}）` : '未配置，当前为演示模式'}`);
  console.log('');
  console.log('      按 Ctrl + C 停止服务');
  console.log('');
  if (OPEN_BROWSER) openBrowser(`http://localhost:${actualPort}`);
});

module.exports = server;
