'use strict';
/**
 * 极简 JSON 持久化仓库。
 * 单个 data/store.json 承载全部数据，写入做 150ms 防抖 + 原子落盘。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// 数据目录可通过 NOVEL_DATA_DIR 覆盖，用于在同一份代码上跑多个互不干扰的实例
const DATA_DIR = process.env.NOVEL_DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

// 新版：支持接入多个自定义 AI（providers 列表），activeProvider 记录当前在用哪一个。
// 每个 provider 自带 endpoint / apiKey / model / temperature / maxTokens / extraBody，
// 这样不同的私有模型、不同的推理强度都能并存、随时切换。
const DEFAULT_SETTINGS = {
  providers: [],
  activeProvider: null,
  useDemo: true, // 未配置 key 时自动用演示模式产出，保证功能可体验
  agentPersona: '',
  autoApply: false
};

/** 把任意来源的对象规整成一个合法的 provider 条目（缺字段补默认、类型校正、去空白） */
function clampN(v, min, max, dflt) {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
function normalizeProvider(p) {
  p = p || {};
  return {
    id: (typeof p.id === 'string' && p.id) ? p.id : uid('ai'),
    name: String(p.name || '').trim().slice(0, 40) || '自定义模型',
    provider: String(p.provider || 'custom'),
    endpoint: String(p.endpoint || '').trim(),
    apiKey: String(p.apiKey || '').trim(),
    model: String(p.model || '').trim(),
    temperature: clampN(p.temperature, 0, 2, 0.85),
    maxTokens: clampN(p.maxTokens, 256, 131072, 4096),
    extraBody: String(p.extraBody || '').trim()
  };
}

/**
 * 旧版单配置（顶层 endpoint / apiKey / model）迁移成 providers 列表的第一项；
 * 同时保证 activeProvider 指向一个有效条目。调用方传入的是已 merged 的 settings 对象（原地修改）。
 */
function migrateSettings(s) {
  if (!Array.isArray(s.providers)) s.providers = [];
  if (s.providers.length === 0 && (s.endpoint || s.apiKey || s.model)) {
    s.providers.push(normalizeProvider({
      name: '默认模型',
      provider: s.provider || 'custom',
      endpoint: s.endpoint || '',
      apiKey: s.apiKey || '',
      model: s.model || '',
      temperature: s.temperature,
      maxTokens: s.maxTokens,
      extraBody: s.extraBody || ''
    }));
  }
  const list = s.providers;
  // 清掉"只有名字、接口/Key/模型名全空"的草稿条目（至少保留一条）。
  // 这类空条目曾经因为"新增模型即置为使用"被写进 store.json，看起来像已有配置被清空。
  const isBlank = (p) => !String(p.endpoint || '').trim()
    && !String(p.apiKey || '').trim() && !String(p.model || '').trim();
  const kept = list.filter((p) => !isBlank(p));
  if (kept.length && kept.length !== list.length) s.providers = kept;
  const has = (id) => s.providers.some((p) => p.id === id);
  s.activeProvider = has(s.activeProvider)
    ? s.activeProvider
    : (s.providers.find((p) => p.apiKey && p.endpoint) || s.providers[0] || {}).id || null;
  // 清掉迁移前的顶层遗留字段，避免与新结构混淆
  delete s.provider; delete s.endpoint; delete s.apiKey; delete s.model;
  delete s.temperature; delete s.maxTokens; delete s.extraBody;
  return s;
}

/** 所有集合名 */
const COLLECTIONS = [
  'projects', 'outline', 'characters', 'relations', 'lines',
  'beats', 'chapters', 'world', 'foreshadow', 'notes', 'messages', 'materials'
];

function blank() {
  const db = {
    meta: { version: 1, createdAt: Date.now() },
    settings: { ...DEFAULT_SETTINGS }
  };
  COLLECTIONS.forEach((c) => { db[c] = []; });
  return db;
}

let state = null;
let timer = null;
let flushing = false;

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function load() {
  if (state) return state;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      state = { ...blank(), ...parsed };
      state.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) };
      migrateSettings(state.settings);
      COLLECTIONS.forEach((c) => { if (!Array.isArray(state[c])) state[c] = []; });
    } catch (err) {
      const bak = `${DATA_FILE}.broken-${Date.now()}`;
      try { fs.copyFileSync(DATA_FILE, bak); } catch (_) { /* ignore */ }
      console.error('[store] 数据文件损坏，已备份到', bak, err.message);
      state = blank();
    }
  } else {
    state = blank();
  }
  return state;
}

function save() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, 150);
}

function flush() {
  if (flushing) return;
  flushing = true;
  try {
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(load(), null, 2), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error('[store] 写入失败:', err.message);
  } finally {
    flushing = false;
  }
}

// ---------- 基础 CRUD ----------

function all(coll) { return load()[coll]; }

function find(coll, id) { return load()[coll].find((x) => x.id === id) || null; }

function where(coll, pred) { return load()[coll].filter(pred); }

function byProject(coll, projectId, opts = {}) {
  let list = load()[coll].filter((x) => x.projectId === projectId);
  if (opts.lineId) list = list.filter((x) => x.lineId === opts.lineId);
  if (opts.sort !== false) list.sort((a, b) => (a.order || 0) - (b.order || 0));
  return list;
}

function insert(coll, obj) {
  const item = { id: uid(coll.slice(0, 4)), createdAt: Date.now(), ...obj };
  load()[coll].push(item);
  save();
  return item;
}

function update(coll, id, patch) {
  const item = find(coll, id);
  if (!item) return null;
  Object.assign(item, patch, { updatedAt: Date.now() });
  save();
  return item;
}

function remove(coll, id) {
  const db = load();
  const i = db[coll].findIndex((x) => x.id === id);
  if (i < 0) return false;
  db[coll].splice(i, 1);
  save();
  return true;
}

function removeWhere(coll, pred) {
  const db = load();
  const before = db[coll].length;
  db[coll] = db[coll].filter((x) => !pred(x));
  save();
  return before - db[coll].length;
}

function nextOrder(list) {
  return list.reduce((m, x) => Math.max(m, x.order || 0), 0) + 1;
}

// ---------- 项目 ----------

function getProject(id) { return find('projects', id); }

/** 删除项目及其全部关联数据 */
function deleteProject(id) {
  const db = load();
  removeWhere('projects', (x) => x.id === id);
  ['outline', 'characters', 'relations', 'lines', 'beats', 'chapters', 'world', 'foreshadow', 'notes', 'messages', 'materials']
    .forEach((c) => removeWhere(c, (x) => x.projectId === id));
  flush();
  return db;
}

/** 导出某个项目的完整快照 */
function bundle(projectId) {
  const db = load();
  const project = getProject(projectId);
  if (!project) return null;
  const out = { project, exportedAt: Date.now() };
  ['outline', 'characters', 'relations', 'lines', 'beats', 'chapters', 'world', 'foreshadow', 'notes', 'messages', 'materials']
    .forEach((c) => { out[c] = db[c].filter((x) => x.projectId === projectId); });
  return out;
}

module.exports = {
  DATA_DIR, ROOT, COLLECTIONS, DEFAULT_SETTINGS,
  normalizeProvider, migrateSettings,
  load, flush, save, uid,
  all, find, where, byProject, insert, update, remove, removeWhere, nextOrder,
  getProject, deleteProject, bundle
};
