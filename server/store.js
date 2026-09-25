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
  agentPersona: '',      // 旧版「助手人设」，首次进入会迁移进记忆箱，之后不再使用
  mindBoxEnabled: true,  // 记忆箱总开关：关掉后助手回到"没被调教过"的原始状态
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

/** 记忆箱（助手档案）的字段规整：名字、头像、人设、记忆条 */
const MIND_LIMITS = { text: 500, count: 100, persona: 4000 };
function normalizeMemory(m) {
  m = m || {};
  return {
    id: (typeof m.id === 'string' && m.id) ? m.id : uid('mem'),
    text: String(m.text || '').trim().slice(0, MIND_LIMITS.text),
    enabled: m.enabled !== false,
    createdAt: Number(m.createdAt) || Date.now()
  };
}
function normalizeMind(m) {
  m = m || {};
  return {
    id: (typeof m.id === 'string' && m.id) ? m.id : uid('mind'),
    name: String(m.name || '').trim().slice(0, 24) || '未命名助手',
    avatar: String(m.avatar || '').trim(),        // 空 = 用内置默认头像；也可存 dataURL 或单个 emoji
    persona: String(m.persona || '').trim().slice(0, MIND_LIMITS.persona),
    memories: (Array.isArray(m.memories) ? m.memories : []).map(normalizeMemory).slice(0, MIND_LIMITS.count),
    builtin: m.builtin === true,                 // 内置默认助手：不可删除，但可改
    createdAt: Number(m.createdAt) || Date.now(),
    updatedAt: Number(m.updatedAt) || 0
  };
}

function blank() {
  const db = {
    meta: { version: 1, createdAt: Date.now() },
    settings: { ...DEFAULT_SETTINGS },
    minds: [],
    activeMindId: null
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
      if (!Array.isArray(state.minds)) state.minds = [];
      state.minds = state.minds.map(normalizeMind);
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

/**
 * 强制从磁盘重新读取（丢弃内存缓存）。
 * 外置助手（WorkBuddy 等）直接改 store.json 后，前端点「刷新」时后端先调这个，
 * 否则内存态不会变，外部改动看不到。
 */
function reload() {
  state = null;
  return load();
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

// ---------- 记忆箱（AI 助手档案；全局，不属于任何作品） ----------

function allMinds() { return load().minds; }

function getMind(id) { return load().minds.find((x) => x.id === id) || null; }

function activeMind() {
  const db = load();
  return db.minds.find((x) => x.id === db.activeMindId) || db.minds[0] || null;
}

function insertMind(obj) {
  const item = normalizeMind({ ...obj, id: uid('mind'), createdAt: Date.now() });
  load().minds.push(item);
  save();
  return item;
}

function updateMind(id, patch) {
  const db = load();
  const i = db.minds.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const old = db.minds[i];
  // builtin / id / createdAt 由仓库把持，不被外部补丁覆盖
  const next = normalizeMind({
    ...old, ...patch, id: old.id, createdAt: old.createdAt, builtin: old.builtin
  });
  next.updatedAt = Date.now();
  db.minds[i] = next;
  save();
  return next;
}

function removeMind(id) {
  const db = load();
  const m = db.minds.find((x) => x.id === id);
  if (!m || m.builtin) return false;      // 内置默认助手不可删除
  db.minds = db.minds.filter((x) => x.id !== id);
  if (db.activeMindId === id) db.activeMindId = db.minds.length ? db.minds[0].id : null;
  save();
  return true;
}

function setActiveMind(id) {
  const db = load();
  if (!db.minds.some((x) => x.id === id)) return null;
  db.activeMindId = id;
  save();
  return id;
}

/**
 * 首次进入时把「设置 → 助手人设」迁移成内置默认助手：
 * 从此只在记忆箱一处定义助手性格，避免两份人设互相打架。
 */
function ensureDefaultMind() {
  const db = load();
  if (db.minds.length) {
    if (!db.activeMindId || !db.minds.some((x) => x.id === db.activeMindId)) {
      db.activeMindId = db.minds[0].id;
      save();
    }
    return db.minds.find((x) => x.id === db.activeMindId) || null;
  }
  const def = normalizeMind({
    id: uid('mind'),
    name: '默认助手',
    persona: String((db.settings || {}).agentPersona || '').trim(),
    memories: [],
    builtin: true,
    createdAt: Date.now()
  });
  db.minds.push(def);
  db.activeMindId = def.id;
  save();
  return def;
}

/** 导出：传 id 只导出那一个，不传导出全部 */
function exportMinds(onlyId) {
  const db = load();
  const list = onlyId ? db.minds.filter((x) => x.id === onlyId) : db.minds.slice();
  return {
    format: 'novel-studio-mind',
    version: 1,
    exportedAt: Date.now(),
    activeName: (activeMind() || {}).name || '',
    minds: list.map((m) => ({
      name: m.name,
      avatar: m.avatar,
      persona: m.persona,
      memories: m.memories.map((x) => ({ text: x.text, enabled: x.enabled }))
    }))
  };
}

/** 导入：append（默认，同名覆盖）/ replace（先清空） */
function importMinds(payload, mode = 'append') {
  const db = load();
  const list = Array.isArray(payload && payload.minds) ? payload.minds : null;
  if (!list || !list.length) throw new Error('文件里没有可导入的助手');
  if (mode === 'replace') db.minds = [];
  let added = 0, updated = 0;
  list.forEach((raw) => {
    const m = normalizeMind(raw);
    const same = db.minds.find((x) => x.name === m.name);
    if (same) {
      same.avatar = m.avatar;
      same.persona = m.persona;
      same.memories = m.memories;
      same.updatedAt = Date.now();
      updated++;
    } else {
      db.minds.push(m);
      added++;
    }
  });
  if (!db.activeMindId || !db.minds.some((x) => x.id === db.activeMindId)) db.activeMindId = db.minds[0].id;
  save();
  return { added, updated, total: db.minds.length };
}

module.exports = {
  DATA_DIR, ROOT, COLLECTIONS, DEFAULT_SETTINGS, MIND_LIMITS,
  normalizeProvider, migrateSettings, normalizeMind, normalizeMemory,
  load, flush, save, reload, uid,
  all, find, where, byProject, insert, update, remove, removeWhere, nextOrder,
  getProject, deleteProject, bundle,
  allMinds, getMind, activeMind, insertMind, updateMind, removeMind, setActiveMind,
  ensureDefaultMind, exportMinds, importMinds
};
