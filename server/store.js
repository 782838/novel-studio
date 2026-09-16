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

const DEFAULT_SETTINGS = {
  provider: 'deepseek',
  endpoint: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.85,
  maxTokens: 4096,
  useDemo: true, // 未配置 key 时自动用演示模式产出，保证功能可体验
  agentPersona: '',
  extraBody: '', // 高级请求参数（JSON 字符串），用于传模型特有字段如 reasoning_effort
  autoApply: false
};

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
  load, flush, save, uid,
  all, find, where, byProject, insert, update, remove, removeWhere, nextOrder,
  getProject, deleteProject, bundle
};
