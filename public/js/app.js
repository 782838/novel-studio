'use strict';
import api from './api.js';
import * as V from './views.js';
import { createAgent, openSettings } from './agent.js';
import { initUpdate } from './update.js';
import { esc, openForm, openModal, openConfirm, closeModal, toast } from './ui.js';

const NAV = [
  { key: 'dashboard', icon: '◎', label: '总览' },
  { key: 'outline', icon: '🗂', label: '大纲' },
  { key: 'characters', icon: '👤', label: '角色集' },
  { key: 'lines', icon: '🧵', label: '线路' },
  { key: 'chapters', icon: '📄', label: '章节' },
  { key: 'memos', icon: '🧠', label: 'AI记忆点' },
  { key: 'world', icon: '🌐', label: '设定' },
  { key: 'foreshadow', icon: '❓', label: '伏笔' },
  { key: 'notes', icon: '📌', label: '备忘' },
  { key: 'materials', icon: '📥', label: '素材箱' }
];

const LS_PROJECT = 'novel-studio:project';
const LS_AGENT = 'novel-studio:agent-open';

const VIEWS = {
  dashboard: V.dashboard,
  outline: V.outline,
  characters: V.characters,
  lines: V.lines,
  chapters: V.chapters,
  memos: V.memos,
  world: V.world,
  foreshadow: V.foreshadow,
  notes: V.notes,
  materials: V.materials
};

const state = {
  meta: { typeLabel: {}, statusLabel: {}, lineLabel: {} },
  settings: {},
  projects: [],
  projectId: null,
  data: emptyBundle(),
  view: 'dashboard',
  sel: { nodeId: null, chapterId: null, charGraph: false, focusChar: null, query: '' },
  collapsed: new Set()
};

function emptyBundle() {
  return {
    project: { title: '', synopsis: '', genre: '' },
    outline: [], characters: [], relations: [], lines: [],
    beats: [], chapters: [], world: [], foreshadow: [], notes: [], messages: [], materials: []
  };
}

const viewEl = () => document.getElementById('view');
const sidebarEl = () => document.getElementById('sidebar');

/* ---------------------------------------------------------------- 上下文 */

// 当前视图注册的「重绘前落盘」钩子。
// 视图每次重绘都会重建，所以 render() 会清空重登记——否则来回切几次视图后，
// 旧视图的钩子会拿着新视图的 DOM（同一个 .view 元素）去写旧章节，属于数据事故。
let flushers = [];

const ctx = {
  get meta() { return state.meta; },
  get settings() { return state.settings; },
  get data() { return state.data; },
  get projectId() { return state.projectId; },
  get sel() { return state.sel; },
  get collapsed() { return state.collapsed; },
  get apiReady() { return Boolean(state.settings.hasKey); },

  setView(v) { state.view = v; render(); },
  toast,
  openForm, openModal, openConfirm,
  registerFlush(fn) { flushers.push(fn); },

  async reload() {
    const pending = flushers.slice();
    flushers = [];                                   // 先把钩子摘掉，避免重绘后又跑一遍
    // 钩子可能返回 promise（把待保存的输入写回）：等它落地再拉新数据，避免读到旧值
    await Promise.all(pending.map((f) => {
      try { return Promise.resolve(f()); } catch (_) { return null; }
    }));
    const fresh = await api.getProject(state.projectId);
    state.data = { ...emptyBundle(), ...fresh };
    render();
    agent.paint();
  },

  /** 轻量刷新：只更新侧栏计数，不重建当前视图 */
  syncLocal() { renderSidebar(); },

  async create(coll, body, cb) {
    if (!state.projectId) return;
    const item = await api.create(state.projectId, coll, body);
    if (cb) cb(item);
    await ctx.reload();
    return item;
  },

  /**
   * 修改一条数据。
   * 默认会重新拉取并重绘（否则像「备忘置顶」「伏笔已回收」这类操作，服务端改了但界面纹丝不动，
   * 看起来就像"点了没反应"）。正在输入框里自动保存的场景请传 { silent: true }，避免重建 DOM 打断输入。
   */
  async patch(coll, id, body, opts = {}) {
    const res = await api.patchItem(coll, id, body);
    if (!opts.silent) await ctx.reload();
    return res;
  },

  async remove(coll, id) {
    await api.removeItem(coll, id);
    await ctx.reload();
  },

  render,
  askAI,
  /**
   * 开一个「AI 任务」：自动打开 AI 助手面板，执行过程与结果都显示在对话流里，
   * 结束时汇报执行了多少项。生成记忆点、续写、生成大纲/角色/线路/设定/脑暴都走这里。
   */
  aiTask(title, opts) { toggleAgent(true); return agent.beginTask(title, opts); },
  toggleAgent,
  refreshProjects: () => loadProjects(),
  refreshSettings: async () => {
    state.settings = await api.settings();
    // 顶栏徽章只在启动时设置过一次，中途保存 Key 会一直显示"演示模式"——这里同步刷新
    const chip = document.getElementById('statusChip');
    if (chip) {
      const label = state.settings.activeName || state.settings.activeModel;
      chip.textContent = state.settings.hasKey ? `模型 ${label || ''}` : '演示模式';
      chip.className = `status-chip ${state.settings.hasKey ? 'on' : 'off'}`;
    }
    agent.paint();
  }
};

let agent = null;

function toggleAgent(open) {
  const panel = document.getElementById('agentPanel');
  const on = open === undefined ? !panel.classList.contains('open') : open;
  panel.classList.toggle('open', on);
  document.body.classList.toggle('agent-open', on);
  localStorage.setItem(LS_AGENT, on ? '1' : '0');
  if (on) agent.paint();
}

function askAI(text) {
  toggleAgent(true);
  const input = document.getElementById('agentInput');
  if (input) input.focus();
  agent.send(text);
}

/* ---------------------------------------------------------------- 渲染 */

/* ------------------------------------------------- 重绘时保留滚动位置
 *
 * 视图是整块 innerHTML 重建的，浏览器会把里面所有滚动容器重置到顶部：
 * 「新建章节 / 改章节状态 / 点列表项 / AI 插入正文」这类操作之后，
 * 左侧章节列表都会莫名跳回第一章，长列表尤其难受。
 * 这里在重绘前后按「子节点索引路径」记录并恢复滚动位置——
 * 同一个视图重绘时 DOM 结构一致，路径稳定；结构变了则跳过（不硬套旧位置）。
 */
function scrollPathOf(el, root) {
  const path = [];
  let node = el;
  while (node && node !== root) {
    const parent = node.parentElement;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.children, node));
    node = parent;
  }
  return node === root ? path : null;
}

function captureScroll(root) {
  const saved = [];
  for (const el of [root, ...root.querySelectorAll('*')]) {
    if (!el.scrollTop && !el.scrollLeft) continue;
    if (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1) continue;
    const path = scrollPathOf(el, root);
    if (path) saved.push({ path, top: el.scrollTop, left: el.scrollLeft });
  }
  return saved;
}

function restoreScroll(root, saved) {
  for (const { path, top, left } of saved) {
    let node = root;
    for (const i of path) {
      node = node && node.children[i];
      if (!node) break;
    }
    if (!node || !node.style) continue;
    // 结构变了导致路径落到别的元素上时，别乱设滚动
    if (node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1) continue;
    node.scrollTop = top;
    node.scrollLeft = left;
  }
}

function render() {
  renderSidebar();

  // 重绘前先把「还没自动保存的输入」写回：切换视图、点章节、改状态、新建……都走这里。
  // 此刻旧视图的 DOM 还在（innerHTML 尚未替换），所以钩子读到的是正确的编辑框内容。
  const pending = flushers;
  flushers = [];
  pending.forEach((f) => { try { f(); } catch (_) { /* ignore */ } });

  if (!state.projectId) {
    viewEl().innerHTML = welcomeHtml();
    mountWelcome();
    return;
  }

  const el = viewEl();
  const saved = captureScroll(el);
  const factory = VIEWS[state.view] || V.dashboard;
  const view = factory(ctx);
  el.innerHTML = view.html;
  restoreScroll(el, saved);
  if (view.mount) view.mount(el, ctx);
}

function renderSidebar() {
  const d = state.data;
  const counts = {
    outline: d.outline.length, characters: d.characters.length, lines: d.lines.length,
    chapters: d.chapters.length, world: d.world.length,
    memos: d.chapters.filter((c) => String(c.memo || '').trim()).length,
    foreshadow: d.foreshadow.filter((f) => f.status !== 'paid-off').length,
    notes: d.notes.length,
    materials: d.materials.length
  };
  sidebarEl().innerHTML = NAV.map((n) => `
    <button class="nav-item ${state.view === n.key ? 'active' : ''}" data-view="${n.key}" ${state.projectId ? '' : 'disabled'}>
      <span class="nav-icon">${n.icon}</span>
      <span class="nav-label">${n.label}</span>
      ${state.projectId && counts[n.key] ? `<span class="nav-count">${counts[n.key]}</span>` : ''}
    </button>`).join('');

  sidebarEl().querySelectorAll('.nav-item').forEach((b) => {
    b.addEventListener('click', () => { state.view = b.dataset.view; render(); });
  });
}

function welcomeHtml() {
  const has = state.projects.length > 0;
  return `
    <div class="welcome">
      <div class="welcome-card">
        <span class="welcome-quill">✒</span>
        <h2>${has ? '选择一部作品开始' : '先建一部作品'}</h2>
        <p>大纲、角色卡、故事线、章节正文、伏笔与设定放在同一个项目里。
        助手能读到全部内容，既能陪你想，也能直接替你改。</p>
        <div class="welcome-acts">
          <button class="btn primary" data-act="create">＋ 新建作品</button>
          <button class="btn ghost" data-act="sample">载入示例作品</button>
          ${has ? '<button class="btn ghost" data-act="focus">从下拉框选择已有作品</button>' : ''}
        </div>
        ${!ctx.settings.hasKey ? `<p class="welcome-tip">尚未配置模型，助手当前运行在演示模式。到右上「设置」填入 Key 后即可真正接手。</p>` : ''}
      </div>
    </div>`;
}

function mountWelcome() {
  const root = viewEl();
  root.querySelector('[data-act="create"]')?.addEventListener('click', () => newProject());
  root.querySelector('[data-act="sample"]')?.addEventListener('click', () => seedSample());
  root.querySelector('[data-act="focus"]')?.addEventListener('click', () => {
    document.getElementById('projectSelect').focus();
  });
}

/* ---------------------------------------------------------------- 项目操作 */

async function newProject() {
  openForm({
    title: '新建作品', width: 520, okText: '创建',
    fields: [
      { key: 'title', label: '作品名', placeholder: '如：雾隐城' },
      { key: 'genre', label: '类型标签', placeholder: '如：东方奇幻 / 悬疑' },
      { key: 'targetWords', label: '目标字数', type: 'number', default: 200000 },
      { key: 'synopsis', label: '一句话故事', type: 'textarea', rows: 3, hint: '谁，在什么处境下，想要什么，代价是什么' }
    ],
    onSubmit: async (v) => {
      if (!v.title) { toast('请填写作品名', 'error'); return false; }
      const p = await api.createProject(v);
      await selectProject(p.id, true);
      toast('作品已创建', 'success');
    }
  });
}

/** 重命名当前作品（顺带可改类型、目标字数、一句话故事） */
async function renameCurrentProject() {
  const p = state.projects.find((x) => x.id === state.projectId);
  if (!p) return toast('请先选择要改名的作品', 'error');
  const full = state.data?.project || {};
  openForm({
    title: '作品改名', subtitle: `当前：${p.title}`, width: 520, okText: '保存',
    fields: [
      { key: 'title', label: '作品名', placeholder: '如：雾隐城' },
      { key: 'genre', label: '类型标签', placeholder: '如：东方奇幻 / 悬疑' },
      { key: 'targetWords', label: '目标字数', type: 'number' },
      { key: 'synopsis', label: '一句话故事', type: 'textarea', rows: 3, hint: '谁，在什么处境下，想要什么，代价是什么' }
    ],
    values: {
      title: full.title || p.title,
      genre: full.genre || '',
      targetWords: full.targetWords || 200000,
      synopsis: full.synopsis || ''
    },
    onSubmit: async (v) => {
      if (!String(v.title || '').trim()) { toast('作品名不能为空', 'error'); return false; }
      await api.patchProject(p.id, {
        title: v.title.trim(),
        genre: v.genre,
        targetWords: Number(v.targetWords) || 0,
        synopsis: v.synopsis
      });
      await loadProjects();                       // 顶栏下拉框同步新名字
      await selectProject(p.id, false);           // 重新拉取作品数据并重绘
      toast('已改名', 'success');
    }
  });
}

/** 删除当前作品：需要手动输入作品名确认，防止误删 */
async function deleteCurrentProject() {
  const p = state.projects.find((x) => x.id === state.projectId);
  if (!p) return toast('请先选择要删除的作品', 'error');
  const chapters = (state.data?.chapters || []).length;
  const outline = (state.data?.outline || []).length;
  const words = (state.data?.chapters || []).reduce((a, c) => a + (c.content || '').length, 0);

  openForm({
    title: '删除作品',
    subtitle: `《${p.title}》`,
    width: 500, okText: '彻底删除',
    fields: [{
      key: 'confirm', label: `这部作品共有 ${chapters} 章（${words.toLocaleString()} 字）、${outline} 个大纲节点。删除后无法恢复。请输入作品名「${p.title}」以确认`,
      placeholder: p.title
    }],
    onSubmit: async (v) => {
      if (String(v.confirm || '').trim() !== p.title) {
        toast('作品名不一致，已取消删除', 'error');
        return false;
      }
      await api.deleteProject(p.id);
      toast(`《${p.title}》已删除`, 'success');
      const rest = state.projects.filter((x) => x.id !== p.id);
      await selectProject(rest.length ? rest[0].id : null, true);
    }
  });
}

async function selectProject(id, reloadProjects = false) {  state.projectId = id;
  state.sel = { nodeId: null, chapterId: null, charGraph: false, focusChar: null, query: '' };
  state.collapsed = new Set();
  localStorage.setItem(LS_PROJECT, id || '');
  if (reloadProjects) await loadProjects();
  if (id) {
    try {
      state.data = { ...emptyBundle(), ...await api.getProject(id) };
    } catch (err) {
      toast(`打开作品失败：${err.message}`, 'error');
      state.projectId = null;
      localStorage.setItem(LS_PROJECT, '');
    }
    agent.paint();
  }
  render();
}

async function loadProjects() {
  state.projects = await api.projects();
  const sel = document.getElementById('projectSelect');
  sel.innerHTML = state.projects.map((p) => `<option value="${p.id}" ${p.id === state.projectId ? 'selected' : ''}>${esc(p.title)}</option>`).join('');
}

async function exportProject() {
  if (!state.projectId) return;
  openModal({
    title: '导出作品', width: 460,
    html: `<p class="confirm-text">选择格式。Markdown 适合交给编辑或存档阅读，JSON 可以完整还原回工作台。</p>`,
    buttons: [
      { label: '取消', kind: 'ghost' },
      { label: '下载 JSON', kind: 'ghost', onClick: () => doExport('json') },
      { label: '下载 Markdown', kind: 'primary', onClick: () => doExport('md') }
    ]
  });
}

async function doExport(format) {
  const title = (state.data.project.title || '作品').replace(/[\\/:*?"<>|]/g, '_');
  try {
    if (format === 'md') {
      const res = await api.exportProject(state.projectId, 'md');
      download(`${title}.md`, res.markdown, 'text/markdown');
    } else {
      const bundle = await api.exportProject(state.projectId, 'json');
      download(`${title}.novel.json`, JSON.stringify(bundle, null, 2), 'application/json');
    }
    toast('已导出', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

function download(name, text, type) {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importProject() {
  openModal({
    title: '导入作品', width: 460, footer: false,
    html: `
      <div class="import-menu">
        <button class="import-opt" data-mode="json">
          <b>导入工作台存档</b>
          <span>从 .novel.json 完整还原一部作品（大纲/角色/章节全保留）</span>
        </button>
        <button class="import-opt" data-mode="txt">
          <b>导入小说 TXT（AI 解析）</b>
          <span>读取文本，自动分章，并抽取角色 / 简介 / 大纲，归档成新作品</span>
        </button>
      </div>`,
    onMount: (body) => {
      const close = () => closeModal(body.closest('.modal-mask'));
      body.querySelector('[data-mode="json"]').addEventListener('click', () => { close(); importJsonFile(); });
      body.querySelector('[data-mode="txt"]').addEventListener('click', () => { close(); importNovelFlow(); });
    }
  });
}

/** 导入工作台存档（.novel.json） */
async function importJsonFile() {
  const input = document.getElementById('importFile');
  input.value = '';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const bundle = JSON.parse(await file.text());
      const p = await api.importProject(bundle);
      await selectProject(p.id, true);
      toast('导入成功', 'success');
    } catch (err) { toast(`导入失败：${err.message}`, 'error'); }
  };
  input.click();
}

/** 导入小说 TXT（批量）：多选 -> 分章预览 -> 逐一归档（带进度 / 重试）或合并为一本 */
const NOVEL_MAX_FILES = 20;
let _novelFiles = [];

function importNovelFlow() {
  _novelFiles = [];
  const modal = openModal({
    title: '导入小说 TXT（批量）',
    subtitle: `一次最多 ${NOVEL_MAX_FILES} 个 .txt，可各自归档为独立作品，也可合并成一本书`,
    width: 720, footer: false,
    html: `
      <div class="novel-import">
        <label class="field file-drop">
          <span>选择 TXT 文本（可多选，最多 ${NOVEL_MAX_FILES} 个）</span>
          <input type="file" id="niFile" accept=".txt,text/plain" multiple />
          <em id="niFileHint">未选择文件</em>
        </label>

        <div class="ni-mode" id="niMode">
          <label class="ni-mode-opt">
            <input type="radio" name="niMode" value="multi" checked />
            <span><b>各自归档</b><i>每个文件成为一部独立作品</i></span>
          </label>
          <label class="ni-mode-opt">
            <input type="radio" name="niMode" value="merge" />
            <span><b>合并为一本</b><i>所有文件合成一本书，每个文件作一卷</i></span>
          </label>
        </div>

        <div class="ni-merge-fields" id="niMergeFields" hidden>
          <div class="ni-row">
            <label class="field"><span>合并后作品名（留空则取第一个文件名）</span><input id="niMergeTitle" placeholder="如：遮天" /></label>
            <label class="field"><span>类型（可选）</span><input id="niMergeGenre" placeholder="如：东方玄幻" /></label>
          </div>
        </div>

        <label class="ni-ai"><input type="checkbox" id="niUseAI" checked /> 使用 AI 解析角色 / 简介 / 大纲（未配置模型时仅分章入库）</label>

        <div class="ni-progress" id="niProgress" hidden>
          <div class="ni-bar"><i id="niBarFill"></i></div>
          <p class="ni-progress-text" id="niProgressText"></p>
        </div>

        <div class="ni-files" id="niFiles"></div>

        <div class="ni-actions">
          <button class="btn ghost" id="niCancel">取消</button>
          <button class="btn primary" id="niStart" disabled>开始导入</button>
        </div>
      </div>`,
    onMount: (body) => {
      const fileInput = body.querySelector('#niFile');
      const hint = body.querySelector('#niFileHint');
      const listEl = body.querySelector('#niFiles');
      const startBtn = body.querySelector('#niStart');
      const useAIEl = body.querySelector('#niUseAI');
      const modeEl = body.querySelector('#niMode');
      const mergeFields = body.querySelector('#niMergeFields');
      const mergeTitleEl = body.querySelector('#niMergeTitle');
      const mergeGenreEl = body.querySelector('#niMergeGenre');
      const progEl = body.querySelector('#niProgress');
      const barFill = body.querySelector('#niBarFill');
      const progText = body.querySelector('#niProgressText');
      const mask = body.closest('.modal-mask');

      let mode = 'multi';
      let busy = false;
      const isValid = (f) => Boolean(f.content && f.content.trim());

      body.querySelector('#niCancel').addEventListener('click', () => { if (!busy) closeModal(mask); });

      /* ---------------- 进度条 ---------------- */
      function showProgress() { progEl.hidden = false; }
      function setProgress(done, total, text) {
        progEl.classList.remove('indeterminate');
        barFill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
        progText.textContent = text || `已完成 ${done} / ${total}`;
      }
      function setProgressText(text) {
        progEl.classList.add('indeterminate');
        progText.textContent = text;
      }
      function hideProgress() { progEl.hidden = true; progEl.classList.remove('indeterminate'); barFill.style.width = '0%'; }

      function updateHint() {
        hint.textContent = _novelFiles.length ? `已选择 ${_novelFiles.length} / ${NOVEL_MAX_FILES} 个文件` : '未选择文件';
      }
      function refreshStart() {
        startBtn.disabled = busy || !_novelFiles.some(isValid);
      }

      /* ---------------- 文件列表 ---------------- */
      function renderList() {
        if (!_novelFiles.length) {
          listEl.innerHTML = '<p class="empty-hint">选择文件后将在此列出每本的解析结果。</p>';
          refreshStart();
          return;
        }
        listEl.innerHTML = _novelFiles.map((f, i) => {
          let stat;
          if (f.status === 'running') stat = '<span class="ni-stat muted">导入中…</span>';
          else if (f.status === 'done') stat = `<span class="ni-stat ok">✓ 《${esc(f.doneInfo.title)}》${f.doneInfo.chapters} 章</span>`;
          else if (f.status === 'error') stat = `<span class="ni-stat err">失败：${esc(f.errorMsg || '未知错误')}</span>`;
          else if (f.previewError) stat = `<span class="ni-stat err">${esc(f.previewError)}</span>`;
          else if (f.preview) stat = `<span class="ni-stat"><b>${f.preview.chapterCount}</b> 章 · 约 <b>${f.preview.totalWords.toLocaleString()}</b> 字</span>`;
          else stat = '<span class="ni-stat muted">解析中…</span>';

          const retryBtn = f.status === 'error'
            ? `<button class="ni-retry" data-retry="${i}" ${busy ? 'disabled' : ''} title="重试">重试</button>` : '';
          const removeBtn = busy ? '' : `<button class="ni-remove" data-i="${i}" title="移除">✕</button>`;

          const row = mode === 'merge'
            ? `<div class="ni-row">
                 <input class="ni-vol" data-i="${i}" placeholder="卷名（默认用文件名）" value="${esc(f.volName || f.base)}" ${busy ? 'disabled' : ''} />
               </div>`
            : `<div class="ni-row">
                 <input class="ni-title" data-i="${i}" placeholder="作品名（留空用文件名）" value="${esc(f.title)}" ${busy ? 'disabled' : ''} />
                 <input class="ni-genre" data-i="${i}" placeholder="类型（可选）" value="${esc(f.genre)}" ${busy ? 'disabled' : ''} />
               </div>`;

          return `
            <div class="ni-file ${f.status === 'done' ? 'is-done' : ''} ${f.status === 'error' ? 'is-error' : ''}">
              <div class="ni-file-head">
                <span class="ni-name">${esc(f.name)}</span>
                ${stat}
                ${retryBtn}
                ${removeBtn}
              </div>
              ${row}
            </div>`;
        }).join('');

        listEl.querySelectorAll('.ni-remove').forEach((b) => b.addEventListener('click', () => {
          _novelFiles.splice(Number(b.dataset.i), 1);
          updateHint(); renderList();
        }));
        listEl.querySelectorAll('.ni-retry').forEach((b) => b.addEventListener('click', () => retryOne(_novelFiles[Number(b.dataset.retry)])));
        const bind = (sel, key) => listEl.querySelectorAll(sel).forEach((inp) => inp.addEventListener('input', () => {
          _novelFiles[Number(inp.dataset.i)][key] = inp.value;
        }));
        bind('.ni-title', 'title');
        bind('.ni-genre', 'genre');
        bind('.ni-vol', 'volName');

        refreshStart();
      }

      /* ---------------- 预览 ---------------- */
      async function previewAll() {
        const payload = _novelFiles.map((f) => ({ content: f.content, title: f.title, fileName: f.base }));
        try {
          const det = await api.previewNovelBatch(payload);
          (det.files || []).forEach((d) => {
            const f = _novelFiles[d.index];
            if (!f) return;
            if (d.ok) { f.preview = d; f.previewError = ''; } else { f.previewError = d.error; }
          });
          renderList();
        } catch (err) {
          toast(`预览失败：${err.message}`, 'error');
        }
      }

      fileInput.addEventListener('change', async () => {
        const picked = Array.from(fileInput.files || []);
        fileInput.value = '';
        if (!picked.length) return;
        const room = NOVEL_MAX_FILES - _novelFiles.length;
        if (room <= 0) { toast(`最多导入 ${NOVEL_MAX_FILES} 个文件，请先移除部分`, 'error'); return; }
        const slice = picked.slice(0, room);
        if (picked.length > room) toast(`已超出 ${NOVEL_MAX_FILES} 个上限，仅加入前 ${room} 个`, 'error');

        for (const file of slice) {
          const name = file.name;
          const base = name.replace(/\.txt$/i, '');
          _novelFiles.push({
            name, base, content: await file.text(),
            title: base, genre: '', volName: base,
            preview: null, previewError: '', status: 'idle', doneInfo: null, errorMsg: ''
          });
        }
        updateHint();
        renderList();
        await previewAll();
      });

      /* ---------------- 模式切换 ---------------- */
      modeEl.querySelectorAll('input[name="niMode"]').forEach((r) => r.addEventListener('change', () => {
        if (!r.checked) return;
        mode = r.value;
        mergeFields.hidden = mode !== 'merge';
        startBtn.textContent = mode === 'merge' ? '合并导入' : '开始导入';
        renderList();
      }));

      /* ---------------- 导入 ---------------- */
      async function importOne(f, useAI) {
        f.status = 'running'; f.errorMsg = '';
        renderList();
        try {
          const res = await api.importNovel({
            content: f.content, title: f.title, fileName: f.base, genre: f.genre, useAI
          });
          f.status = 'done';
          f.doneInfo = { id: res.project.id, title: res.project.title, chapters: res.chaptersCreated };
          return true;
        } catch (err) {
          f.status = 'error';
          f.errorMsg = err.message;
          return false;
        } finally {
          renderList();
        }
      }

      async function runMulti(valid) {
        let ok = 0, fail = 0;
        showProgress();
        for (let i = 0; i < valid.length; i++) {
          const f = valid[i];
          setProgress(i, valid.length, `正在导入 ${i + 1} / ${valid.length}：${f.name}`);
          const good = await importOne(f, useAIEl.checked);
          if (good) ok++; else fail++;
          setProgress(i + 1, valid.length, `已完成 ${i + 1} / ${valid.length}`);
        }
        busy = false;
        await loadProjects();
        render();
        if (!fail) {
          closeModal(mask);
          toast(`已归档 ${ok} 部作品`, 'success');
        } else if (!ok) {
          toast(`全部失败（${fail} 本），可点失败项上的「重试」逐个重来`, 'error');
          startBtn.textContent = '重新导入';
        } else {
          toast(`成功 ${ok} 部，失败 ${fail} 部，可在失败项上点「重试」`, 'error');
          startBtn.textContent = '重新导入';
        }
        refreshStart();
      }

      async function runMerge(valid) {
        showProgress();
        setProgressText(`正在合并 ${valid.length} 本，解析与归档中，请稍候…`);
        try {
          const res = await api.importNovelMerge({
            title: mergeTitleEl.value.trim(),
            genre: mergeGenreEl.value.trim(),
            useAI: useAIEl.checked,
            files: valid.map((f) => ({ content: f.content, fileName: f.volName || f.base, title: f.volName || f.base }))
          });
          busy = false;
          closeModal(mask);
          await loadProjects();
          await selectProject(res.project.id);
          toast(`已合并为《${res.project.title}》：${res.volumes} 卷 · ${res.chaptersCreated} 章`, 'success');
        } catch (err) {
          busy = false;
          hideProgress();
          startBtn.disabled = false;
          startBtn.textContent = '合并导入';
          toast(`合并失败：${err.message}`, 'error');
        }
      }

      async function retryOne(f) {
        if (busy || !f || !isValid(f)) return;
        busy = true;
        showProgress();
        setProgressText(`正在重试：${f.name}`);
        const good = await importOne(f, useAIEl.checked);
        busy = false;
        hideProgress();
        if (good) {
          await loadProjects();
          render();
          toast(`《${f.doneInfo.title}》导入成功`, 'success');
        } else {
          toast(`重试失败：${f.errorMsg}`, 'error');
        }
        refreshStart();
      }

      startBtn.addEventListener('click', async () => {
        const valid = _novelFiles.filter(isValid);
        if (!valid.length || busy) return;
        busy = true;
        startBtn.disabled = true;
        startBtn.textContent = mode === 'merge' ? '合并中…' : '导入中…';
        if (mode === 'merge') await runMerge(valid);
        else await runMulti(valid);
      });

      renderList();
    }
  });
}

/* ---------------------------------------------------------------- 示例作品 */

async function seedSample() {
  try {
    const p = await api.seedSample();
    await selectProject(p.id, true);
    toast('示例作品已载入', 'success');
  } catch (err) {
    toast(`载入示例失败：${err.message}`, 'error');
  }
}

/* ---------------------------------------------------------------- 启动 */

async function boot() {
  try {
    state.meta = await api.meta();
    state.settings = await api.settings();
  } catch (err) {
    document.body.innerHTML = `<div style="padding:40px;font:14px/1.8 system-ui">服务未就绪：${esc(err.message)}</div>`;
    return;
  }

  agent = createAgent(ctx);

  await loadProjects();
  const remembered = localStorage.getItem(LS_PROJECT);
  const target = state.projects.find((p) => p.id === remembered) || state.projects[0];

  const sel = document.getElementById('projectSelect');
  sel.addEventListener('change', () => selectProject(sel.value));
  document.getElementById('btnNewProject').addEventListener('click', () => newProject());
  document.getElementById('btnRenameProject').addEventListener('click', renameCurrentProject);
  document.getElementById('btnDeleteProject').addEventListener('click', deleteCurrentProject);
  document.getElementById('btnExport').addEventListener('click', exportProject);
  document.getElementById('btnImport').addEventListener('click', importProject);
  document.getElementById('btnSettings').addEventListener('click', () => openSettings(ctx));
  document.getElementById('btnToggleAgent').addEventListener('click', () => toggleAgent());

  const statusChip = document.getElementById('statusChip');
  statusChip.addEventListener('click', () => toggleAgent());
  const statusLabel = state.settings.activeName || state.settings.activeModel;
  statusChip.textContent = state.settings.hasKey ? `模型 ${statusLabel || ''}` : '演示模式';
  statusChip.className = `status-chip ${state.settings.hasKey ? 'on' : 'off'}`;

  // 版本检测：进入软件自动查一次；顶栏「检测更新」按钮可手动再查
  const updateApi = initUpdate({ current: (state.meta && state.meta.version) || '' });
  window.__novelStudio = window.__novelStudio || {};
  window.__novelStudio.update = updateApi;

  if (localStorage.getItem(LS_AGENT) !== '0') toggleAgent(true);

  if (target) await selectProject(target.id);
  else render();

  window.addEventListener('keydown', (e) => {
    // Esc 退出全屏写作（沉浸写作模式下）
    if (e.key === 'Escape' && document.body.classList.contains('writing-full')) {
      V.setWritingFull(false);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === '\\') { e.preventDefault(); toggleAgent(); }
  });
}

boot();

window.__novelStudio = { state, ctx, api };
