'use strict';
import api from './api.js';
import { esc, md, openForm, openModal, openConfirm, closeModal, toast, debounce, downloadText, stripBom } from './ui.js';
import { parseImport } from './importer.js';

const TYPE_ORDER = { act: 0, chapter: 1, scene: 2, beat: 3 };

function fmtNum(n) {
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
  return String(n);
}

function byOrder(a, b) {
  return (a.order || 0) - (b.order || 0);
}

// 统一排序：最近修改的排最前（服务端 update 会写 updatedAt；老数据回退 createdAt）
function byRecent(a, b) {
  return ((b.updatedAt || b.createdAt) || 0) - ((a.updatedAt || a.createdAt) || 0);
}

function childrenOf(list, parentId) {
  return list.filter((n) => (n.parentId || null) === (parentId || null)).sort(byOrder);
}

function hasDescendant(list, parentId, targetId) {
  const children = list.filter((n) => n.parentId === parentId);
  for (const c of children) {
    if (c.id === targetId) return true;
    if (hasDescendant(list, c.id, targetId)) return true;
  }
  return false;
}

function toolbar(inner, extra = '') {
  return `<div class="toolbar"><div class="toolbar-main">${inner}</div><div class="toolbar-side">${extra}</div></div>`;
}

function emptyBox(text, btn = '') {
  return `<div class="empty"><div class="empty-glyph">✎</div><p>${esc(text)}</p>${btn}</div>`;
}

/* ==================================================================== 总览 */

export function dashboard(ctx) {
  const d = ctx.data;
  const p = d.project;
  const words = d.chapters.reduce((s, c) => s + (c.content || '').length, 0);
  const pendingHooks = d.foreshadow.filter((f) => f.status !== 'paid-off').length;
  const doneNodes = d.outline.filter((n) => n.status === 'done').length;

  const stats = [
    { label: '大纲节点', value: d.outline.length, sub: `${doneNodes} 个已完成`, icon: '🗂' },
    { label: '角色', value: d.characters.length, sub: `${d.relations.length} 组关系`, icon: '👤' },
    { label: '故事线', value: d.lines.length, sub: `${d.beats.length} 个节拍`, icon: '🧵' },
    { label: '累计字数', value: fmtNum(words), sub: p.targetWords ? `目标 ${fmtNum(p.targetWords)}` : '未设目标', icon: '✍' },
    { label: '未回收伏笔', value: pendingHooks, sub: pendingHooks > 3 ? '留意堆积' : '节奏健康', icon: '❓' },
    { label: '待决问题', value: d.notes.filter((n) => n.category === '待解决').length, sub: '备忘待处理', icon: '📌' }
  ];

  const roots = childrenOf(d.outline, null);
  const percent = p.targetWords ? Math.min(100, Math.round((words / p.targetWords) * 100)) : 0;

  return {
    html: `
      <div class="page">
        <section class="hero-card">
          <div class="hero-main">
            <input class="hero-title" id="heroTitle" value="${esc(p.title)}" placeholder="作品名" title="直接在这里改作品名（也可用顶栏「✎ 改名」）" />
            <div class="hero-meta">
              <input class="hero-genre" id="heroGenre" value="${esc(p.genre || '')}" placeholder="类型标签，如：都市悬疑" />
              <span class="dot-sep">·</span>
              <span>${fmtNum(words)} 字</span>
              ${p.targetWords ? `<span class="dot-sep">·</span><span>目标 ${fmtNum(p.targetWords)} 字</span>` : ''}
            </div>
            <textarea class="hero-synopsis" id="heroSynopsis" placeholder="一句话故事：谁，在什么处境下，想要什么，代价是什么？">${esc(p.synopsis || '')}</textarea>
          </div>
          <div class="hero-side">
            <div class="progress-ring" style="--p:${percent}">
              <span>${percent}<i>%</i></span>
            </div>
            <p class="hero-label">写作进度</p>
          </div>
        </section>

        <div class="stat-grid">
          ${stats.map((s) => `
            <div class="stat-card">
              <span class="stat-icon">${s.icon}</span>
              <b>${esc(s.value)}</b>
              <span class="stat-label">${esc(s.label)}</span>
              <span class="stat-sub">${esc(s.sub)}</span>
            </div>`).join('')}
        </div>

        <div class="two-col">
          <section class="panel">
            <h4>故事骨架</h4>
            ${roots.length
        ? `<ul class="mini-list">${roots.map((n) => `
                <li data-goto="outline" data-node="${n.id}">
                  <span class="mini-badge">${esc(ctx.meta.typeLabel[n.type] || n.type)}</span>
                  <span class="mini-title">${esc(n.title)}</span>
                  <span class="status-dot s-${esc(n.status)}" title="${esc(ctx.meta.statusLabel[n.status] || n.status)}"></span>
                </li>`).join('')}</ul>`
        : emptyBox('还没有大纲。去「大纲」页建立第一层结构，或让助手帮你起手。')}
          </section>

          <section class="panel">
            <h4>让助手接手</h4>
            <div class="prompt-grid">
              ${[
        '帮我梳理主线，并把缺失的关键节拍补齐',
        '检查角色动机是否成立，指出最薄弱的一个',
        '给我三个能让中段不塌的转折方案',
        '列出所有还没回收的伏笔，给出回收建议',
        '这个世界设定有哪些自相矛盾的地方？'
      ].map((q) => `<button class="prompt-chip" data-ask="${esc(q)}">${esc(q)}</button>`).join('')}
            </div>
          </section>
        </div>
      </div>`,

    mount(root, c) {
      const patchProject = debounce((patchObj) => {
        api.patchProject(c.projectId, patchObj)
          .then(() => c.refreshProjects())   // 顶栏下拉框跟着一起改名
          .catch((e) => toast(e.message, 'error'));
      }, 600);

      const bindHero = (id, key) => {
        const el = root.querySelector(`#${id}`);
        el.addEventListener('input', () => patchProject({ [key]: el.value }));
      };
      bindHero('heroTitle', 'title');
      bindHero('heroGenre', 'genre');
      bindHero('heroSynopsis', 'synopsis');

      root.querySelectorAll('[data-goto]').forEach((el) => {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => {
          c.sel.nodeId = el.dataset.node;
          c.setView(el.dataset.goto);
        });
      });

      root.querySelectorAll('[data-ask]').forEach((el) => {
        el.addEventListener('click', () => c.askAI(el.dataset.ask));
      });
    }
  };
}

/* ==================================================================== 大纲 */

export function outline(ctx) {
  const d = ctx.data;
  const selected = ctx.sel.nodeId && d.outline.find((n) => n.id === ctx.sel.nodeId);
  const node = selected || null;
  const children = node ? childrenOf(d.outline, node.id) : [];

  return {
    html: `
      <div class="page split-view">
        <div class="split-left">
          ${toolbar(
      `<button class="btn primary sm" data-act="add-root">＋ 顶层节点</button>
             <button class="btn ghost sm" data-act="expand">展开</button>
             <button class="btn ghost sm" data-act="collapse">折叠</button>`,
      `<button class="btn ghost sm" data-act="ai-extend">✨ AI 补全大纲</button>`
    )}
          <div class="tree-wrap" id="treeWrap">${outlineTree(d.outline, null, ctx)}</div>
          ${d.outline.length ? '' : '<div class="empty" style="margin-top:10px"><p>大纲是空的。点「＋ 顶层节点」开始，或让 AI 先起一版骨架。</p></div>'}
        </div>

        <div class="split-right">
          ${node ? nodeEditor(d, node, children, ctx) : `
            <div class="empty">
              <div class="empty-glyph">🗂</div>
              <p>选中左侧任一节点查看细节</p>
            </div>`}
        </div>
      </div>`,

    mount(root, c) {
      bindTree(root, c);
      if (node) mountNodeEditor(root, c);

      root.querySelector('[data-act="add-root"]').addEventListener('click', () => {
        openForm({
          title: '新增顶层节点', width: 460,
          fields: [
            { key: 'title', label: '标题', placeholder: '如：第一幕 · 失衡' },
            { key: 'type', label: '层级', type: 'select', options: [['act', '幕 / 卷'], ['chapter', '章'], ['scene', '场景'], ['beat', '节拍']] },
            { key: 'summary', label: '梗概', type: 'textarea', rows: 3, placeholder: '这一段落要达成什么？转折在哪？' }
          ],
          okText: '创建',
          onSubmit: async (v) => {
            if (!v.title) { toast('标题不能为空', 'error'); return false; }
            const n = await c.create('outline', { ...v, parentId: null });
            c.sel.nodeId = n.id;
            toast('已创建', 'success');
          }
        });
      });

      const setAll = (collapsed) => {
        c.collapsed = collapsed ? new Set(d.outline.filter((n) => childrenOf(d.outline, n.id).length).map((n) => n.id)) : new Set();
        c.render();
      };
      root.querySelector('[data-act="expand"]').addEventListener('click', () => setAll(false));
      root.querySelector('[data-act="collapse"]').addEventListener('click', () => setAll(true));

      root.querySelector('[data-act="ai-extend"]').addEventListener('click', () => {
        const parent = node || null;
        openForm({
          title: 'AI 补全大纲',
          subtitle: parent ? `将在「${parent.title}」下扩展子节点` : '将在顶层扩展',
          width: 480,
          fields: [
            { key: 'count', label: '生成数量', type: 'select', options: [['3', '3 个'], ['4', '4 个'], ['5', '5 个'], ['6', '6 个']], default: '3' },
            { key: 'guidance', label: '方向提示（可选）', type: 'textarea', rows: 3, placeholder: '例如：这里该进入低谷了，主角要失去一个重要的人' }
          ],
          okText: '生成',
          onSubmit: async (v) => {
            await runGenTask(c, {
              title: 'AI 正在生成大纲…', icon: '🗂', kind: 'outline',
              params: {
                parentId: parent ? parent.id : null,
                count: Number(v.count),
                guidance: v.guidance
              },
              applyTitle: '生成的大纲节点',
              render: (it) => `<b>${esc(it.title)}</b><span class="gen-type">${esc(c.meta.typeLabel[it.type] || it.type)}</span><p>${esc(it.summary || '')}</p>`,
              apply: async (it) => {
                await c.create('outline', { ...it, parentId: parent ? parent.id : null });
              }
            });
          }
        });
      });
    }
  };
}

function outlineTree(nodes, parentId, ctx) {
  const kids = childrenOf(nodes, parentId);
  if (!kids.length) return '';
  return `<ul class="tree">${kids.map((n) => {
    const subs = childrenOf(nodes, n.id);
    const collapsed = ctx.collapsed.has(n.id);
    const kidsCount = nodes.filter((x) => x.parentId === n.id).length;
    return `
      <li>
        <div class="tree-row ${ctx.sel.nodeId === n.id ? 'active' : ''}" data-id="${n.id}" draggable="true">
          <button class="caret" data-act="toggle" data-id="${n.id}" aria-label="展开/折叠">${subs.length ? (collapsed ? '▸' : '▾') : '·'}</button>
          <span class="type-badge t-${esc(n.type)}">${esc(ctx.meta.typeLabel[n.type] || n.type)}</span>
          <span class="tree-title" title="双击可直接改名">${esc(n.title)}</span>
          ${kidsCount ? `<span class="count-pill">${kidsCount}</span>` : ''}
          <span class="row-actions">
            <button data-act="rename" data-id="${n.id}" title="重命名（也可双击标题）">✎</button>
            <button data-act="add" data-id="${n.id}" title="新增子节点">＋</button>
            <button data-act="del" data-id="${n.id}" title="删除节点（含子级）">✕</button>
          </span>
        </div>
        ${(!collapsed) ? outlineTree(nodes, n.id, ctx) : ''}
      </li>`;
  }).join('')}</ul>`;
}

/** 大纲节点就地改名：回车/失焦保存，Esc 取消 */
function startRename(row, id, c) {
  const titleEl = row.querySelector('.tree-title');
  if (!titleEl || row.querySelector('.rename-input')) return;
  const old = titleEl.textContent;
  const wasDraggable = row.getAttribute('draggable');
  row.setAttribute('draggable', 'false');   // 拖拽会抢走输入框的选区

  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = old;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const val = input.value.trim();
    if (save && val && val !== old) {
      await c.patch('outline', id, { title: val });   // 内部会重绘，无需手动恢复
      toast('已改名', 'success');
    } else {
      row.setAttribute('draggable', wasDraggable || 'true');
      c.render();
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
  input.addEventListener('blur', () => finish(true));
}

function bindTree(root, c) {
  const d = c.data;
  root.querySelectorAll('.tree-row').forEach((row) => {
    const id = row.dataset.id;

    row.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (act) return;
      c.sel.nodeId = id;
      c.render();
    });

    // 双击标题 = 就地改名
    row.addEventListener('dblclick', (e) => {
      const t = e.target.closest('.tree-title');
      if (!t) return;
      e.preventDefault();
      startRename(row, id, c);
    });

    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', id);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop-as-child'); });
    row.addEventListener('dragleave', () => row.classList.remove('drop-as-child'));
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      row.classList.remove('drop-as-child');
      const dragId = e.dataTransfer.getData('text/plain');
      if (!dragId || dragId === id) return;
      if (hasDescendant(d.outline, dragId, id)) return toast('不能移动到自己的子节点下', 'error');
      await c.patch('outline', dragId, { parentId: id }, { silent: true });
      await c.reload();
      toast('已调整层级', 'success');
    });
  });

  root.querySelectorAll('[data-act="toggle"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (c.collapsed.has(id)) c.collapsed.delete(id); else c.collapsed.add(id);
      c.render();
    });
  });

  root.querySelectorAll('[data-act="rename"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = btn.closest('.tree-row');
      if (row) startRename(row, btn.dataset.id, c);
    });
  });

  root.querySelectorAll('[data-act="add"]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const parent = d.outline.find((n) => n.id === btn.dataset.id);
      openForm({
        title: `在「${parent.title}」下新增`, width: 460,
        fields: [
          { key: 'title', label: '标题' },
          { key: 'type', label: '层级', type: 'select', options: [['scene', '场景'], ['beat', '节拍'], ['chapter', '章'], ['act', '幕 / 卷']] },
          { key: 'summary', label: '梗概', type: 'textarea', rows: 3 }
        ],
        okText: '创建',
        onSubmit: async (v) => {
          if (!v.title) { toast('标题不能为空', 'error'); return false; }
          const n = await c.create('outline', { ...v, parentId: parent.id });
          c.collapsed.delete(parent.id);
          c.sel.nodeId = n.id;
          toast('已创建', 'success');
        }
      });
    });
  });

  root.querySelectorAll('[data-act="del"]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const node = d.outline.find((n) => n.id === btn.dataset.id);
      const sure = await openConfirm({
        title: '删除节点',
        message: `将删除「${node.title}」及其所有子级节点，此操作不可撤销。`,
        danger: true, okText: '删除'
      });
      if (!sure) return;
      if (c.sel.nodeId === node.id) c.sel.nodeId = null;
      await c.remove('outline', node.id);
      toast('已删除', 'success');
    });
  });
}

function nodeEditor(d, node, children, ctx) {
  const beats = d.beats.filter((b) => b.nodeId === node.id);
  const linkedChapters = d.chapters.filter((c) => c.nodeId === node.id);
  return `
    <div class="detail">
      <div class="detail-head">
        <span class="type-badge t-${esc(node.type)}">${esc(ctx.meta.typeLabel[node.type] || node.type)}</span>
        <span class="crumb">${esc(breadcrumb(d, node))}</span>
      </div>
      <input class="detail-title" id="nodeTitle" value="${esc(node.title)}" placeholder="节点标题" />
      <div class="field-row">
        <label><span>层级</span>
          <select id="nodeType">
            ${[['act', '幕 / 卷'], ['chapter', '章'], ['scene', '场景'], ['beat', '节拍']]
        .map(([v, l]) => `<option value="${v}" ${node.type === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
        <label><span>状态</span>
          <select id="nodeStatus">
            ${[['idea', '灵感'], ['todo', '待写'], ['draft', '草稿'], ['done', '完成']]
        .map(([v, l]) => `<option value="${v}" ${node.status === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
      </div>
      <label class="label-block"><span>梗概</span>
        <textarea id="nodeSummary" rows="7" placeholder="这一段发生什么？人物处境如何变化？留下什么悬念？">${esc(node.summary || '')}</textarea>
      </label>

      <div class="detail-acts">
        <button class="btn ghost sm" data-act="ai-detail">✨ AI 细化此节点</button>
        <button class="btn ghost sm" data-act="to-chapter">↳ 转为章节</button>
      </div>

      <div class="detail-stats">
        <span>子级 ${children.length}</span>
        <span>关联节拍 ${beats.length}</span>
        <span>关联章节 ${linkedChapters.length}</span>
      </div>

      ${beats.length ? `<div class="linked-block">
        <h5>关联的线路节拍</h5>
        ${beats.map((b) => {
      const line = d.lines.find((l) => l.id === b.lineId);
      return `<div class="linked-item"><i style="background:${esc(line ? line.color : '#ccc')}"></i><b>${esc(b.title)}</b><span>${esc(line ? line.name : '未知线路')}</span></div>`;
    }).join('')}
      </div>` : ''}

      ${children.length ? `<div class="linked-block">
        <h5>子节点</h5>
        ${children.map((c2) => `<div class="linked-item clickable" data-select-node="${c2.id}"><b>${esc(c2.title)}</b><span>${esc((c2.summary || '').slice(0, 30))}</span></div>`).join('')}
      </div>` : ''}
    </div>`;
}

function breadcrumb(d, node) {
  const parts = [];
  let cur = node;
  let guard = 0;
  while (cur && guard++ < 10) {
    parts.unshift(cur.title);
    cur = cur.parentId ? d.outline.find((n) => n.id === cur.parentId) : null;
  }
  return parts.join(' › ');
}

export function mountNodeEditor(root, c) {
  const node = c.data.outline.find((n) => n.id === c.sel.nodeId);
  if (!node) return;

  // 边打字边存：silent 避免重绘打断光标
  const patchNode = debounce((p) => c.patch('outline', node.id, p, { silent: true }).then(() => { c.dirtyLocal = true; }), 500);

  root.querySelector('#nodeTitle').addEventListener('input', (e) => patchNode({ title: e.target.value }));
  root.querySelector('#nodeSummary').addEventListener('input', (e) => patchNode({ summary: e.target.value }));
  root.querySelector('#nodeType').addEventListener('change', (e) => c.patch('outline', node.id, { type: e.target.value }).then(() => c.render()));
  root.querySelector('#nodeStatus').addEventListener('change', (e) => c.patch('outline', node.id, { status: e.target.value }).then(() => c.render()));

  root.querySelectorAll('[data-select-node]').forEach((el) => {
    el.addEventListener('click', () => { c.sel.nodeId = el.dataset.selectNode; c.render(); });
  });

  const detail = root.querySelector('[data-act="ai-detail"]');
  if (detail) detail.addEventListener('click', () => {
    c.askAI(`请围绕大纲节点「${node.title}」展开：给出它的核心冲突、人物处境变化、以及 3 个可以落笔的场景建议。当前梗概：${node.summary || '（暂无）'}`);
  });

  const toChap = root.querySelector('[data-act="to-chapter"]');
  if (toChap) toChap.addEventListener('click', async () => {
    const existed = c.data.chapters.find((ch) => ch.nodeId === node.id);
    if (existed) { toast('该节点已关联章节', 'info'); c.sel.chapterId = existed.id; c.setView('chapters'); return; }
    await c.create('chapters', { title: node.title, summary: node.summary || '', nodeId: node.id }, (ch) => {
      c.sel.chapterId = ch.id;
    });
    toast('已生成章节', 'success');
    c.setView('chapters');
  });
}

/* ==================================================================== 角色 */

export function characters(ctx) {
  const d = ctx.data;
  const graph = ctx.sel.charGraph;
  const focus = ctx.sel.focusChar;
  const lineFilter = ctx.sel.charLine || '';
  const lines = d.lines.slice().sort(byOrder);
  const lineById = new Map(lines.map((l) => [l.id, l]));

  // 线路绑定筛选：选了某条线，就只留这条线需要的角色（没勾它的隐藏）；选「未绑定」列出还没挂线的
  const onLine = (c) => {
    if (!lineFilter) return true;
    const ids = Array.isArray(c.lineIds) ? c.lineIds : [];
    if (lineFilter === '__none__') return ids.length === 0;
    return ids.includes(lineFilter);
  };

  const list = d.characters.filter(onLine).sort((a, b) => {
    const pin = (x) => (x.pinned ? 0 : 1);
    if (pin(a) !== pin(b)) return pin(a) - pin(b);
    const dn = (x) => (x.done ? 1 : 0);
    if (dn(a) !== dn(b)) return dn(a) - dn(b);
    return byRecent(a, b);
  });

  const focusChar = focus ? list.find((c) => c.id === focus) : null;
  // 关系图也跟着筛选：只画在场角色、以及两端都在场的关系（否则被隐藏的人还在图里连来连去）
  const graphIds = new Set(list.map((c) => c.id));
  const graphData = lineFilter
    ? { ...d, characters: list, relations: d.relations.filter((r) => graphIds.has(r.fromId) && graphIds.has(r.toId)) }
    : d;

  const lineName = lineFilter === '__none__'
    ? '未绑定线路'
    : (lineFilter ? ((lineById.get(lineFilter) || {}).name || '线路') : '');

  return {
    html: `
      <div class="page">
        ${toolbar(
      `<button class="btn primary sm" data-act="new">＋ 新建角色</button>
             <button class="btn ghost sm" data-act="ai">✨ AI 生成角色</button>
             <button class="btn ghost sm" data-act="export-cards">📄 导出人物卡</button>`,
      `${lines.length ? `<label class="line-filter" title="只看这条线需要的角色；不选则显示全部">
               <span>线路</span>
               <select id="charLineFilter">
                 <option value="">全部角色</option>
                 ${lines.map((l) => `<option value="${esc(l.id)}" ${lineFilter === l.id ? 'selected' : ''}>${esc(l.name)}${l.done ? ' · 已完成' : ''}</option>`).join('')}
                 <option value="__none__" ${lineFilter === '__none__' ? 'selected' : ''}>未绑定线路</option>
               </select>
             </label>` : ''}
             <label class="switch-inline"><input type="checkbox" id="toggleGraph" ${graph ? 'checked' : ''}/> 关系图</label>
             <input class="search" id="charSearch" placeholder="搜索角色…" value="${esc(ctx.sel.query || '')}" />`
    )}

        ${lineFilter ? `<div class="filter-note">
          <span>只看「<b>${esc(lineName)}</b>」需要的角色 · ${list.length} 个</span>
          <button class="btn ghost xs" id="clearLineFilter">✕ 显示全部</button>
        </div>` : ''}

        ${graph
        ? (graphData.characters.length
          ? `<section class="panel graph-panel">
             <div class="graph-bar">
               ${focusChar
                 ? `<span>🕸 聚焦：<b>${esc(focusChar.name)}</b> 的关系网</span><button class="btn ghost xs" id="clearFocus">✕ 查看全部</button>`
                 : `<span class="muted">点击任意节点，查看该角色的关系网与联系人</span>`}
             </div>
             <div class="graph-body">
               <div class="graph-svg-wrap">${relationGraph(graphData, focusChar ? focus : null)}</div>
               ${focusChar ? egoSide(d, focusChar) : ''}
             </div>
           </section>`
          : emptyBox('这条线路下还没有绑定的角色，先给角色勾上所属线路。'))
        : (list.length
          ? `<div class="char-grid">${list.map((c) => charCard(c, d, lineById)).join('')}</div>`
          : emptyBox(
            lineFilter
              ? (lineFilter === '__none__' ? '所有角色都已经绑定了线路。' : '这条线路下还没有绑定角色。打开角色卡，在「所属线路」里勾上这条线即可。')
              : '还没有角色。先建一个主角，或者让助手替你把人物补齐。',
            lineFilter ? '' : '<button class="btn primary sm" data-act="new">＋ 新建角色</button>'))}
      </div>`,

    mount(root, c) {
      const newBtn = () => openForm({
        title: '新建角色', width: 620,
        fields: characterFields(d.lines),
        okText: '创建',
        onSubmit: async (v) => {
          if (!v.name) { toast('请填写姓名', 'error'); return false; }
          const ch = await c.create('characters', v);
          openCharacter(c, ch.id);
        }
      });

      root.querySelectorAll('[data-act="new"]').forEach((b) => b.addEventListener('click', newBtn));

      const exportBtn = root.querySelector('[data-act="export-cards"]');
      if (exportBtn) exportBtn.addEventListener('click', () => openCharExport(c));

      root.querySelector('[data-act="ai"]').addEventListener('click', () => {
        openForm({
          title: 'AI 生成角色', subtitle: '会参考已有角色避免重复',
          width: 500,
          fields: [
            { key: 'count', label: '数量', type: 'select', options: [['1', '1 个'], ['2', '2 个'], ['3', '3 个']], default: '2' },
            { key: 'guidance', label: '需求描述', type: 'textarea', rows: 3, placeholder: '例如：需要一个能牵制主角的亦正亦邪的中间人' }
          ],
          okText: '生成',
          onSubmit: async (v) => {
            await runGenTask(c, {
              title: 'AI 正在设计人物…', icon: '🧑', kind: 'character',
              params: { count: Number(v.count), guidance: v.guidance },
              applyTitle: '生成的角色',
              render: (it) => `<b>${esc(it.name)}</b><span class="gen-type">${esc(it.role || '未定位')}</span>
                    <p>${esc(it.personality || '')}</p><p class="gen-muted">动机：${esc(it.motivation || '—')}</p>`,
              apply: async (it) => { await c.create('characters', it); }
            });
          }
        });
      });

      root.querySelector('#toggleGraph').addEventListener('change', (e) => {
        c.sel.charGraph = e.target.checked;
        c.render();
      });

      // 线路筛选：选一条线就只看这条线需要的角色
      const lineSel = root.querySelector('#charLineFilter');
      if (lineSel) lineSel.addEventListener('change', () => {
        c.sel.charLine = lineSel.value;
        c.sel.query = '';                 // 一起清掉搜索，避免「换了线路却看不到人」的困惑
        c.sel.focusChar = null;
        c.render();
      });
      const clrFilter = root.querySelector('#clearLineFilter');
      if (clrFilter) clrFilter.addEventListener('click', () => {
        c.sel.charLine = '';
        c.sel.focusChar = null;
        c.render();
      });

      const search = root.querySelector('#charSearch');
      search.addEventListener('input', () => {
        c.sel.query = search.value;
        const q = search.value.trim().toLowerCase();
        root.querySelectorAll('.char-card').forEach((el) => {
          const hay = (el.dataset.key || el.textContent).toLowerCase();
          el.style.display = !q || hay.includes(q) ? '' : 'none';
        });
      });

      root.querySelectorAll('.char-card').forEach((el) => {
        el.addEventListener('click', (e) => {
          if (e.target.closest('[data-pin]')) return; // 置顶按钮自己处理
          if (e.target.closest('[data-done]')) return; // 已完成按钮自己处理
          openCharacter(c, el.dataset.id);
        });
      });

      root.querySelectorAll('[data-pin]').forEach((b) => b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = b.dataset.pin;
        const ch = d.characters.find((x) => x.id === id);
        if (!ch) return;
        await c.patch('characters', id, { pinned: !ch.pinned }); // patch 默认会 reload + 重绘
      }));
      root.querySelectorAll('[data-done]').forEach((b) => b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = b.dataset.done;
        const ch = d.characters.find((x) => x.id === id);
        if (!ch) return;
        await c.patch('characters', id, { done: !ch.done });
      }));

      // 关系图：点击节点聚焦其关系网（再点同一节点取消聚焦）
      root.querySelectorAll('.rel-node').forEach((g) => {
        g.addEventListener('click', () => {
          const id = g.dataset.id;
          c.sel.focusChar = (c.sel.focusChar === id) ? null : id;
          c.render();
        });
      });

      const clearBtn = root.querySelector('#clearFocus');
      if (clearBtn) clearBtn.addEventListener('click', () => { c.sel.focusChar = null; c.render(); });

      // 聚焦侧栏里的「查看档案」
      const profileBtn = root.querySelector('[data-act="profile"]');
      if (profileBtn) profileBtn.addEventListener('click', () => openCharacter(c, focus));
    }
  };
}

function characterFields(lines = []) {
  return [
    { key: 'name', label: '姓名' },
    { key: 'role', label: '定位', type: 'select', options: ['主角', '重要配角', '配角', '反派', '群像'], default: '配角' },
    { key: 'alias', label: '别名 / 称号' },
    { key: 'age', label: '年龄' },
    { key: 'lineIds', label: '所属线路', type: 'checks', emptyText: '还没有线路（先去「线路」页建一条）', hint: '这条线需要他出场就勾上；角色页可按线路筛选', options: lines.map((l) => [l.id, l.name, l.color || '#6b8afd']) },
    { key: 'appearance', label: '外貌特征', type: 'textarea', rows: 2 },
    { key: 'personality', label: '性格层次', type: 'textarea', rows: 2, hint: '表面与内里的反差' },
    { key: 'motivation', label: '核心动机', type: 'textarea', rows: 2, hint: '他到底想要什么' },
    { key: 'flaw', label: '弱点 / 缺陷', type: 'textarea', rows: 2 },
    { key: 'arc', label: '人物弧光', type: 'textarea', rows: 2, hint: '从什么走向什么' },
    { key: 'beatNote', label: '关键转折节点', type: 'textarea', rows: 2 }
  ];
}

/**
 * 角色卡（紧凑型）。
 * 角色一多，大卡片就变成一堵墙——这里压成「两行 + 右侧操作」的小格子：
 * 第 1 行 名字 + 定位，第 2 行 所属线路 + 关系数；动机等长文本走 title 悬停看。
 */
function charCard(c, d, lineById = new Map()) {
  const rels = d.relations.filter((r) => r.fromId === c.id || r.toId === c.id).length;
  const myLines = (Array.isArray(c.lineIds) ? c.lineIds : []).map((id) => lineById.get(id)).filter(Boolean);
  const mot = String(c.motivation || c.personality || '').trim();
  const alias = String(c.alias || '').trim();
  // 卡片第三行：优先显示别名，没有就退而显示动机，让卡片不止「名字 + 定位」那么干
  const desc = alias ? `别名：${alias}` : mot;
  const key = [c.name, c.alias, c.role, mot, ...myLines.map((l) => l.name)].filter(Boolean).join(' ');
  return `
    <article class="char-card${c.pinned ? ' pinned' : ''}${c.done ? ' is-off' : ''}" data-id="${c.id}"
      data-key="${esc(key)}" title="${esc(mot || '（动机待补充）')}">
      <span class="avatar" style="background:${esc(c.color || '#6b8afd')}">${esc((c.name || '?').slice(0, 1))}</span>
      <div class="ch-main">
        <div class="ch-top">
          <b>${esc(c.name)}</b>
          <span class="role-badge">${esc(c.role || '未定位')}</span>
          <span class="ch-rel" title="${rels} 组关系">🔗 ${rels}</span>
        </div>
        <div class="ch-sub">
          ${myLines.length
      ? `<span class="ch-lines" title="线路：${esc(myLines.map((l) => l.name).join('、'))}">${myLines.map((l) => `<i class="ch-dot" style="background:${esc(l.color || '#6b8afd')}"></i>`).join('')}<em>${esc(myLines.map((l) => l.name).join('、'))}</em></span>`
      : '<span class="ch-noline">未绑线路</span>'}
        </div>
        ${desc ? `<div class="ch-desc" title="${esc(desc)}">${esc(desc)}</div>` : ''}
      </div>
      <div class="ch-acts">
        <button class="pin-btn${c.pinned ? ' on' : ''}" data-pin="${c.id}" title="${c.pinned ? '取消置顶' : '置顶'}" aria-label="置顶">📌</button>
        <button class="done-btn${c.done ? ' on' : ''}" data-done="${c.id}" title="${c.done ? '点击重新上线' : '点击下线：他的戏份已经演完'}" aria-label="下线">${c.done ? '已下线' : '下线'}</button>
      </div>
    </article>`;
}

function relationGraph(d, focusId) {
  const chars = d.characters;
  if (!chars.length) return emptyBox('还没有角色');
  // viewBox 要贴近实际渲染宽度：原来按 960 宽画，被容器压到一半后
  // 圆圈和名字小得几乎看不清（左边一撮小黑点、右边一块大卡片，比例就是这么崩的）
  const W = 560; const H = 400;
  const cx = W / 2; const cy = H / 2;
  const RX = cx - 62; const RY = cy - 56;
  const pos = new Map();
  const n = chars.length;
  chars.forEach((ch, i) => {
    if (n === 1) { pos.set(ch.id, { x: cx, y: cy }); return; }
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    pos.set(ch.id, { x: cx + Math.cos(a) * RX, y: cy + Math.sin(a) * RY });
  });

  // 聚焦时计算关系网节点集合（自己 + 直接相连的人）
  const neighbors = new Set();
  if (focusId) {
    neighbors.add(focusId);
    d.relations.forEach((r) => {
      if (r.fromId === focusId) neighbors.add(r.toId);
      if (r.toId === focusId) neighbors.add(r.fromId);
    });
  }

  const lines = d.relations.map((r) => {
    const a = pos.get(r.fromId); const b = pos.get(r.toId);
    if (!a || !b) return '';
    const touches = !focusId || r.fromId === focusId || r.toId === focusId;
    const volatile = r.state === 'volatile';
    const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
    const nx = -(b.y - a.y); const ny = (b.x - a.x);
    const len = Math.hypot(nx, ny) || 1;
    const off = 22;
    const lx = mx + (nx / len) * off; const ly = my + (ny / len) * off;
    const stroke = volatile ? '#e0a52e' : (focusId && touches ? '#8a7d5a' : '#cfc8ba');
    const dash = volatile ? ' stroke-dasharray="6 4"' : '';
    const op = focusId && !touches ? ' opacity="0.1"' : '';
    const w = focusId && touches ? 1.8 : 1.4;
    return `<g class="rel${volatile ? ' rel-volatile' : ''}${focusId && touches ? ' rel-focus' : ''}"${op}>
      <line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${stroke}" stroke-width="${w}"${dash} />
      <text x="${lx}" y="${ly}" class="rel-label">${esc(r.label)}</text>
    </g>`;
  }).join('');

  const nodes = chars.map((ch) => {
    const p = pos.get(ch.id);
    const isFocus = ch.id === focusId;
    const inNet = !focusId || neighbors.has(ch.id);
    const dim = focusId && !inNet;
    return `<g class="rel-node${isFocus ? ' rel-focus-node' : ''}${dim ? ' rel-dim-node' : ''}" data-id="${ch.id}">
      <circle cx="${p.x}" cy="${p.y}" r="${isFocus ? 32 : 26}" fill="${esc(ch.color || '#6b8afd')}"${isFocus ? ' stroke="#e0a52e" stroke-width="3"' : ''} />
      <text x="${p.x}" y="${p.y + 6}" class="rel-init">${esc((ch.name || '?').slice(0, 1))}</text>
      <text x="${p.x}" y="${p.y + (isFocus ? 50 : 45)}" class="rel-name">${esc(ch.name)}</text>
    </g>`;
  }).join('');

  return `<svg class="rel-svg" viewBox="0 0 ${W} ${H}">${lines}${nodes}</svg>`;
}

/** 聚焦角色时，右侧列出他的关系网：联系人、关系、稳定 / 可能变化 */
function egoSide(d, focusChar) {
  const rels = d.relations.filter((r) => r.fromId === focusChar.id || r.toId === focusChar.id);
  const nameOf = new Map(d.characters.map((x) => [x.id, x.name]));
  const roleOf = new Map(d.characters.map((x) => [x.id, x.role || '未定位']));
  return `
    <aside class="ego-side">
      <div class="ego-head">
        <span class="avatar" style="background:${esc(focusChar.color || '#6b8afd')}">${esc((focusChar.name || '?').slice(0, 1))}</span>
        <div class="ego-title"><b>${esc(focusChar.name)}</b><span class="role-badge">${esc(focusChar.role || '未定位')}</span></div>
        <button class="btn ghost xs" data-act="profile">查看档案</button>
      </div>
      <h5>关系网（${rels.length}）</h5>
      ${rels.length ? `<ul class="rel-list ego-rel">${rels.map((r) => {
        const other = r.fromId === focusChar.id ? r.toId : r.fromId;
        const dir = r.fromId === focusChar.id ? '→' : (r.toId === focusChar.id ? '←' : '↔');
        const volatile = r.state === 'volatile';
        return `<li>
          <b>${esc(nameOf.get(other) || '?')}</b>
          <span class="role-badge">${esc(roleOf.get(other) || '')}</span>
          <span class="rel-dir">${dir}</span> ${esc(r.label)}
          ${volatile ? '<span class="badge badge-volatile" title="该关系可能生变">可能变化</span>' : '<span class="badge badge-stable">稳定</span>'}
          ${volatile && r.trend ? `<em class="rel-trend">走向：${esc(r.trend)}</em>` : ''}
          ${r.description ? `<em>${esc(r.description)}</em>` : ''}
        </li>`;
      }).join('')}</ul>` : '<p class="muted small">暂无关系记录</p>'}
    </aside>`;
}

/** 单张人物卡 → 纯文本（导出 TXT 用） */
function charCardText(c, d) {
  const nameOf = new Map(d.characters.map((x) => [x.id, x.name]));
  const out = [`【${c.name}】${c.role ? `（${c.role}）` : ''}`];
  [['别名', c.alias], ['年龄', c.age], ['外貌', c.appearance], ['性格', c.personality],
    ['核心动机', c.motivation], ['弱点', c.flaw], ['人物弧光', c.arc], ['转折节点', c.beatNote]]
    .forEach(([k, v]) => out.push(`${k}：${String(v == null ? '' : v).trim() || '待补充'}`));

  const rels = d.relations.filter((r) => r.fromId === c.id || r.toId === c.id);
  if (rels.length) {
    out.push('', '· 人物关系');
    rels.forEach((r) => {
      const other = r.fromId === c.id ? r.toId : r.fromId;
      const dir = r.fromId === c.id ? '→' : '←';
      let s = `  ${nameOf.get(other) || '?'} ${dir} ${r.label || ''}`;
      if (r.state === 'volatile') s += `［可能变化${r.trend ? `：${r.trend}` : ''}］`;
      if (r.description) s += ` ${r.description}`;
      out.push(s);
    });
  }

  const safe = String(c.name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hits = safe ? d.beats.filter((b) => new RegExp(safe, 'i').test(`${b.title}${b.description || ''}`)) : [];
  if (hits.length) {
    out.push('', '· 出现在的线路');
    hits.forEach((b) => {
      const line = d.lines.find((l) => l.id === b.lineId);
      out.push(`  ${b.title}${line ? `（${line.name}）` : ''}`);
    });
  }
  return out.join('\n');
}

/** 多张人物卡合成一份 TXT：不同角色之间空一排 */
function charCardsText(list, d) {
  return list.map((c) => charCardText(c, d)).join('\n\n');
}

/** 勾选角色 → 导出人物卡 TXT（默认全选，可多选） */
function openCharExport(ctx) {
  const d = ctx.data;
  if (!d.characters.length) { toast('还没有角色可以导出', 'error'); return; }
  const list = d.characters.slice().sort((a, b) => {
    const pin = (x) => (x.pinned ? 0 : 1);
    if (pin(a) !== pin(b)) return pin(a) - pin(b);
    return byRecent(a, b);
  });

  openModal({
    title: '导出人物卡', subtitle: '导出为 TXT 文本文件', width: 540,
    html: `
      <div class="pick-wrap">
        <p class="muted small">勾选要导出的角色（可多选）；不同角色之间会自动空一排。</p>
        <div class="pick-tools">
          <button class="btn ghost xs" data-pick="all">全选</button>
          <button class="btn ghost xs" data-pick="none">全不选</button>
          <span class="muted small" id="pickCount"></span>
        </div>
        <ul class="pick-list">
          ${list.map((c) => `<li>
            <label><input type="checkbox" value="${c.id}" checked />
              <b>${esc(c.name)}</b><span class="role-badge">${esc(c.role || '未定位')}</span></label>
          </li>`).join('')}
        </ul>
      </div>`,
    buttons: [
      { label: '取消', kind: 'ghost' },
      { label: '导出 TXT', kind: 'primary', keepOpen: true, onClick: (body, wrap) => {
        const ids = [...body.querySelectorAll('input[type=checkbox]:checked')].map((el) => el.value);
        if (!ids.length) { toast('请至少勾选一个角色', 'error'); return; }
        const picked = list.filter((c) => ids.includes(c.id));
        const text = charCardsText(picked, d);
        const title = (d.project && d.project.title) || '作品';
        try {
          downloadText(picked.length === 1 ? `${title}-${picked[0].name}-人物卡` : `${title}-人物卡`, text);
          toast(`已导出 ${picked.length} 张人物卡`, 'success');
        } catch (_) {
          navigator.clipboard.writeText(text)
            .then(() => toast('无法直接保存，已复制到剪贴板', 'info'))
            .catch(() => toast('导出失败', 'error'));
        }
        closeModal(wrap);
      } }
    ],
    onMount: (body) => {
      const boxes = [...body.querySelectorAll('input[type=checkbox]')];
      const cnt = body.querySelector('#pickCount');
      const sync = () => { cnt.textContent = `已选 ${boxes.filter((b) => b.checked).length} / ${boxes.length}`; };
      sync();
      boxes.forEach((b) => b.addEventListener('change', sync));
      body.querySelector('[data-pick="all"]').addEventListener('click', () => { boxes.forEach((b) => { b.checked = true; }); sync(); });
      body.querySelector('[data-pick="none"]').addEventListener('click', () => { boxes.forEach((b) => { b.checked = false; }); sync(); });
    }
  });
}

export function openCharacter(ctx, charId) {
  const render = () => {
    const c = ctx.data.characters.find((x) => x.id === charId);
    if (!c) return;
    const rels = ctx.data.relations.filter((r) => r.fromId === charId || r.toId === charId);
    const nameOf = new Map(ctx.data.characters.map((x) => [x.id, x.name]));
    const roleOf = new Map(ctx.data.characters.map((x) => [x.id, x.role || '未定位']));

    // 改完数据后重开档案弹窗（直接清掉当前弹窗栈，避免叠加）
    const refresh = () => {
      document.querySelectorAll('.modal-mask').forEach((m) => m.remove());
      render();
    };

    // 总编辑：一次改完整张角色卡（弹窗底栏「编辑」与字段展开里的「编辑」共用）
    const editForm = () => openForm({
      title: `编辑 ${c.name}`, width: 620, fields: characterFields(ctx.data.lines), values: c, okText: '保存',
      onSubmit: async (v) => {
        await ctx.patch('characters', charId, v);
        toast('已保存', 'success');
        await ctx.reload();
        refresh();
      }
    });

    // 字段展开：档案里只显示部分，点开看全文（仍可一键转编辑）
    const openField = (label, key) => {
      const cur = ctx.data.characters.find((x) => x.id === charId) || c;
      openModal({
        title: `${cur.name} · ${label}`, width: 620,
        html: `<div class="note-full">${esc(String(cur[key] == null ? '' : cur[key]).trim() || '（未填写）')}</div>`,
        buttons: [
          { label: '编辑', kind: 'primary', keepOpen: true, onClick: () => editForm() },
          { label: '关闭', kind: 'ghost' }
        ]
      });
    };

    // 关系详情：列表里显示不全，点开看全部（可直接转编辑 / 删除）
    const openRelView = (r) => {
      const other = r.fromId === charId ? r.toId : r.fromId;
      const otherName = nameOf.get(other) || '?';
      const dirText = r.fromId === charId ? `${c.name} → ${otherName}` : `${otherName} → ${c.name}`;
      const volatile = r.state === 'volatile';
      openModal({
        title: `${otherName} · ${r.label || '关系'}`,
        subtitle: `${dirText} · ${volatile ? '可能变化' : '稳定'}`,
        width: 560,
        html: `
          <div class="rel-detail">
            <div class="rel-line"><span>关系</span><b>${esc(r.label || '—')}</b></div>
            <div class="rel-line"><span>对象</span><b>${esc(otherName)}（${esc(roleOf.get(other) || '未定位')}）</b></div>
            <div class="rel-line"><span>方向</span><b>${esc(dirText)}</b></div>
            <div class="rel-line"><span>状态</span><b>${volatile ? '可能变化' : '稳定'}</b></div>
            ${volatile && r.trend ? `<div class="rel-line"><span>走向</span><b>${esc(r.trend)}</b></div>` : ''}
            <div class="rel-full">${esc(String(r.description == null ? '' : r.description).trim() || '（这条关系还没有填写说明）')}</div>
          </div>`,
        buttons: [
          { label: '编辑', kind: 'primary', keepOpen: true, onClick: (_b, wrap) => {
            closeModal(wrap);
            openRelForm(r);
          } },
          { label: '删除', kind: 'danger', keepOpen: true, onClick: async (_b, wrap) => {
            const sure = await openConfirm({
              title: '删除关系',
              message: `将删除「${c.name}」与「${otherName}」的关系（${r.label || ''}）。`,
              danger: true, okText: '删除'
            });
            if (!sure) return;
            closeModal(wrap);
            await ctx.remove('relations', r.id);
            await ctx.reload();
            refresh();
          } },
          { label: '关闭', kind: 'ghost' }
        ]
      });
    };

    // 「出现在的线路」：节拍同理——只显示部分，点开看全部，可直接转编辑
    const safeName = String(c.name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const beatHits = safeName
      ? ctx.data.beats.filter((b) => new RegExp(safeName, 'i').test(`${b.title}${b.description || ''}`))
      : [];
    const lineOf = (b) => ctx.data.lines.find((l) => l.id === b.lineId) || null;
    const beatNo = (b) => {
      const sibs = ctx.data.beats.filter((x) => x.lineId === b.lineId).sort(byOrder);
      return sibs.findIndex((x) => x.id === b.id) + 1;
    };

    const openBeatView = (b) => {
      const line = lineOf(b);
      const node = b.nodeId ? ctx.data.outline.find((n) => n.id === b.nodeId) : null;
      const no = beatNo(b);
      openModal({
        title: b.title,
        subtitle: `${line ? line.name : '未归属线路'}${b.status ? ` · ${BEAT_STATUS[b.status] || b.status}` : ''}`,
        width: 560,
        html: `
          <div class="rel-detail">
            <div class="rel-line"><span>线路</span><b>${esc(line ? line.name : '—')}${line ? `（${esc(ctx.meta.lineLabel[line.kind] || line.kind)}）` : ''}</b></div>
            <div class="rel-line"><span>位置</span><b>${no > 0 ? `第 ${no} 拍` : '—'}</b></div>
            <div class="rel-line"><span>状态</span><b>${esc(BEAT_STATUS[b.status] || b.status || '未标注')}</b></div>
            ${node ? `<div class="rel-line"><span>大纲</span><b>${esc(node.title)}</b></div>` : ''}
            <div class="rel-full">${esc(String(b.description == null ? '' : b.description).trim() || '（这个节拍还没有填写说明）')}</div>
          </div>`,
        buttons: [
          { label: '编辑', kind: 'primary', keepOpen: true, onClick: (_x, wrap) => {
            closeModal(wrap);
            openBeat(ctx, b, async () => { await ctx.reload(); refresh(); });
          } },
          { label: '关闭', kind: 'ghost' }
        ]
      });
    };

    // 添加 / 编辑关系（含「可能变化」标记）
    const openRelForm = (existing) => {
      const isEdit = !!existing;
      const origOther = existing ? (existing.fromId === charId ? existing.toId : existing.fromId) : null;
      openForm({
        title: isEdit ? '编辑关系' : '添加关系', width: 480,
        fields: [
          { key: 'toId', label: '对方角色', type: 'select', options: ctx.data.characters.filter((x) => x.id !== charId).map((x) => [x.id, x.name]), default: origOther || '' },
          { key: 'label', label: '关系', placeholder: '如：师徒 / 宿敌 / 暗恋' },
          { key: 'state', label: '关系状态', type: 'select', options: [['stable', '稳定'], ['volatile', '可能变化']], default: existing ? (existing.state || 'stable') : 'stable' },
          { key: 'trend', label: '可能的变化方向', type: 'textarea', rows: 2, hint: '选「可能变化」时填写，例如：后期反目成仇' },
          { key: 'description', label: '说明', type: 'textarea', rows: 2 }
        ],
        values: existing ? { toId: origOther, label: existing.label, state: existing.state || 'stable', trend: existing.trend || '', description: existing.description } : {},
        okText: isEdit ? '保存' : '添加',
        onSubmit: async (v) => {
          if (!v.toId || !v.label) { toast('请填写完整', 'error'); return false; }
          const state = v.state || 'stable';
          const trend = state === 'volatile' ? (v.trend || '') : '';
          let fromId; let toId;
          if (isEdit) {
            // 保持原方向：该角色原本是 from 就仍是 from
            fromId = existing.fromId === charId ? charId : v.toId;
            toId = existing.fromId === charId ? v.toId : charId;
          } else {
            fromId = charId; toId = v.toId;
          }
          const payload = { fromId, toId, label: v.label, state, trend, description: v.description };
          if (isEdit) await ctx.patch('relations', existing.id, payload);
          else await ctx.create('relations', payload);
          toast(isEdit ? '已保存' : '已添加', 'success');
          await ctx.reload();
          refresh();
        }
      });
    };

    const myLineChips = (Array.isArray(c.lineIds) ? c.lineIds : [])
      .map((id) => ctx.data.lines.find((l) => l.id === id)).filter(Boolean);

    openModal({
      title: c.name, subtitle: c.role || '未定位', width: 860,
      html: `
        <div class="char-detail">
          <div class="cd-left">
            <div class="cd-field">
              <span>所属线路</span>
              <p>${myLineChips.length
          ? myLineChips.map((l) => `<span class="ch-lines"><i class="ch-dot" style="background:${esc(l.color || '#6b8afd')}"></i>${esc(l.name)}</span>`).join('')
          : '<i class="muted">未绑定 —— 点「编辑」在「所属线路」里勾选</i>'}</p>
            </div>
            ${[['别名', 'alias'], ['年龄', 'age'], ['外貌', 'appearance'], ['性格', 'personality'],
        ['核心动机', 'motivation'], ['弱点', 'flaw'], ['人物弧光', 'arc'], ['转折节点', 'beatNote']]
        .map(([k, key]) => {
          const v = String(c[key] == null ? '' : c[key]).trim();
          const long = v.length > 30;
          return `<div class="cd-field${long ? ' clamped' : ''}">
                    <span>${k}</span>
                    <p>${v ? esc(v) : '<i class="muted">待补充</i>'}</p>
                    ${long ? `<button class="cd-more" data-act="field" data-key="${key}" data-label="${k}">展开全文 · ${v.length} 字</button>` : ''}
                  </div>`;
        }).join('')}
          </div>
          <div class="cd-right">
            <h5>人物关系</h5>
            ${rels.length ? `<ul class="rel-list cd-rel-list">${rels.map((r) => {
        const other = r.fromId === charId ? r.toId : r.fromId;
        const dir = r.fromId === charId ? '→' : '←';
        const dirTitle = r.fromId === charId ? '从他出发' : '指向他';
        const volatile = r.state === 'volatile';
        const desc = String(r.description == null ? '' : r.description).trim();
        const trend = volatile ? String(r.trend || '').trim() : '';
        const long = desc.length > 22 || trend.length > 22;
        return `<li class="rel-item${long ? ' clamped' : ''}" data-view-rel="${r.id}" title="点开查看这条关系的全部信息">
                  <div class="rel-top">
                    <b>${esc(nameOf.get(other) || '?')}</b>
                    <span class="role-badge">${esc(roleOf.get(other) || '')}</span>
                    <span class="rel-dir" title="${dirTitle}">${dir}</span>
                    <span class="rel-label">${esc(r.label || '')}</span>
                    ${volatile ? '<span class="badge badge-volatile" title="该关系可能生变">可能变化</span>' : '<span class="badge badge-stable">稳定</span>'}
                  </div>
                  ${desc ? `<p class="rel-text rel-desc">${esc(desc)}</p>` : '<p class="rel-text rel-desc">（没有填写说明）</p>'}
                  ${trend ? `<p class="rel-text rel-trend-line">走向：${esc(trend)}</p>` : ''}
                  <div class="rel-foot">
                    <span class="rel-more">${long ? '点开看全部' : '点开查看'}</span>
                    <span class="rel-btns">
                      <button class="rel-act" data-edit-rel="${r.id}">编辑</button>
                      <button class="rel-act danger" data-del-rel="${r.id}">删除</button>
                    </span>
                  </div>
                </li>`;
      }).join('')}</ul>` : '<p class="muted small">暂无关系记录</p>'}
            <button class="btn ghost sm block" data-act="add-rel">＋ 添加关系</button>
            <h5 class="mt">出现在的线路</h5>
            ${beatHits.length
        ? `<ul class="rel-list cd-rel-list">${beatHits.map((b) => {
          const line = lineOf(b);
          const desc = String(b.description == null ? '' : b.description).trim();
          const long = desc.length > 22;
          return `<li class="rel-item${long ? ' clamped' : ''}" data-view-beat="${b.id}" title="点开查看这个节拍的全部信息">
                    <div class="rel-top">
                      <b>${esc(b.title)}</b>
                      ${line ? `<span class="kind-badge k-${esc(line.kind)}">${esc(ctx.meta.lineLabel[line.kind] || line.kind)}</span>` : ''}
                      ${line ? `<span class="rel-label">${esc(line.name)}</span>` : ''}
                      ${b.status ? `<span class="badge badge-stable">${esc(BEAT_STATUS[b.status] || b.status)}</span>` : ''}
                    </div>
                    ${desc ? `<p class="rel-text rel-desc">${esc(desc)}</p>` : '<p class="rel-text rel-desc">（没有填写说明）</p>'}
                    <div class="rel-foot">
                      <span class="rel-more">${long ? '点开看全部' : '点开查看'}</span>
                      <span class="rel-btns"><button class="rel-act" data-edit-beat="${b.id}">编辑</button></span>
                    </div>
                  </li>`;
        }).join('')}</ul>`
        : '<p class="muted small">线路中尚未提及该角色</p>'}
          </div>
        </div>`,
      buttons: [
        { label: c.pinned ? '📌 取消置顶' : '📌 置顶', kind: 'ghost', keepOpen: true, onClick: async () => {
          await ctx.patch('characters', charId, { pinned: !c.pinned });
          await ctx.reload();
          refresh();
        } },
        { label: '🕸 关系网', kind: 'ghost', keepOpen: true, onClick: (_body, wrap) => {
          closeModal(wrap);
          ctx.sel.focusChar = charId;
          ctx.sel.charGraph = true;
          if (typeof ctx.toggleAgent === 'function') ctx.toggleAgent(false);
          ctx.render();
        } },
        { label: '导出人物卡', kind: 'ghost', keepOpen: true, onClick: () => {
          const text = charCardText(c, ctx.data);
          const title = (ctx.data.project && ctx.data.project.title) || '作品';
          try {
            downloadText(`${title}-${c.name}-人物卡`, text);
            toast('已导出 TXT（可在系统弹窗里选择保存位置）', 'success');
          } catch (_) {
            navigator.clipboard.writeText(text)
              .then(() => toast('无法直接保存，已复制到剪贴板', 'info'))
              .catch(() => toast('导出失败', 'error'));
          }
        } },
        { label: '删除角色', kind: 'danger', keepOpen: true, onClick: async () => {
          const sure = await openConfirm({ title: '删除角色', message: `将删除「${c.name}」及其关系记录。`, danger: true, okText: '删除' });
          if (!sure) return;
          await ctx.remove('characters', charId);
          toast('已删除', 'success');
          document.querySelectorAll('.modal-mask').forEach((m) => m.remove());
        } },
        { label: 'AI 深化人设', kind: 'ghost', keepOpen: true, onClick: () => {
          ctx.askAI(`请深化角色「${c.name}」的人设：指出他当前设定里最薄弱的一环，补充童年经历与一个会让读者心疼的具体细节，然后直接更新到角色卡。`);
        } },
        { label: '编辑', kind: 'primary', keepOpen: true, onClick: () => editForm() }
      ],
      onMount: (body) => {
        body.querySelectorAll('[data-act="field"]').forEach((b) => b.addEventListener('click', () => openField(b.dataset.label, b.dataset.key)));
        body.querySelector('[data-act="add-rel"]').addEventListener('click', () => openRelForm(null));
        // 整行点开详情（关系 / 节拍各按自己的 data 属性分发）
        body.querySelectorAll('.rel-item').forEach((li) => li.addEventListener('click', (e) => {
          if (e.target.closest('[data-edit-rel],[data-del-rel],[data-edit-beat]')) return;
          const rid = li.dataset.viewRel;
          const bid = li.dataset.viewBeat;
          if (rid) {
            const r = ctx.data.relations.find((x) => x.id === rid);
            if (r) openRelView(r);
          } else if (bid) {
            const b = ctx.data.beats.find((x) => x.id === bid);
            if (b) openBeatView(b);
          }
        }));
        body.querySelectorAll('[data-edit-beat]').forEach((b) => b.addEventListener('click', (e) => {
          e.stopPropagation();
          const beat = ctx.data.beats.find((x) => x.id === b.dataset.editBeat);
          if (beat) openBeat(ctx, beat, async () => { await ctx.reload(); refresh(); });
        }));
        body.querySelectorAll('[data-edit-rel]').forEach((b) => b.addEventListener('click', (e) => {
          e.stopPropagation();
          const r = ctx.data.relations.find((x) => x.id === b.dataset.editRel);
          if (r) openRelForm(r);
        }));
        body.querySelectorAll('[data-del-rel]').forEach((b) => b.addEventListener('click', async (e) => {
          e.stopPropagation();
          const r = ctx.data.relations.find((x) => x.id === b.dataset.delRel);
          const other = r ? (r.fromId === charId ? r.toId : r.fromId) : '';
          const sure = await openConfirm({
            title: '删除关系',
            message: `将删除「${c.name}」与「${nameOf.get(other) || '?'}」的关系。`,
            danger: true, okText: '删除'
          });
          if (!sure) return;
          await ctx.remove('relations', b.dataset.delRel);
          await ctx.reload();
          refresh();
        }));
      }
    });
  };
  render();
}

/* ==================================================================== 故事线 */

const LINE_KINDS = [['main', '主线'], ['sub', '副线'], ['romance', '感情线'], ['mystery', '悬念线'], ['growth', '成长线'], ['other', '其他']];

export function lines(ctx) {
  const d = ctx.data;
  const ordered = d.lines.slice().sort((a, b) => {
    const pin = (x) => (x.pinned ? 0 : 1);
    if (pin(a) !== pin(b)) return pin(a) - pin(b);
    const dn = (x) => (x.done ? 1 : 0);
    if (dn(a) !== dn(b)) return dn(a) - dn(b);
    return byRecent(a, b);
  });

  return {
    html: `
      <div class="page">
        ${toolbar(
      `<button class="btn primary sm" data-act="new-line">＋ 新建线路</button>`,
      `<button class="btn ghost sm" data-act="ai">✨ AI 梳理线路</button>`
    )}
        ${ordered.length
        ? `<div class="lanes">${ordered.map((l) => laneHtml(l, d, ctx)).join('')}</div>`
        : emptyBox('还没有故事线。主线 + 两三条副线是长篇不塌的基本结构。', '<button class="btn primary sm" data-act="new-line">＋ 新建线路</button>')}
      </div>`,

    mount(root, c) {
      const openLineForm = (line) => openForm({
        title: line ? `编辑线路 · ${line.name}` : '新建线路', width: 520,
        fields: [
          { key: 'name', label: '线路名' },
          { key: 'kind', label: '类型', type: 'select', options: LINE_KINDS, default: 'sub' },
          { key: 'description', label: '这条线讲什么', type: 'textarea', rows: 3 },
          { key: 'color', label: '标记色', placeholder: '#6b8afd' }
        ],
        values: line || {},
        okText: line ? '保存' : '创建',
        onSubmit: async (v) => {
          if (!v.name) { toast('请填写线路名', 'error'); return false; }
          if (line) await c.patch('lines', line.id, v); else await c.create('lines', v);
          toast('已保存', 'success');
        }
      });

      root.querySelectorAll('[data-act="new-line"]').forEach((b) => b.addEventListener('click', () => openLineForm(null)));
      root.querySelectorAll('[data-act="pin-line"]').forEach((b) => b.addEventListener('click', async () => {
        const line = c.data.lines.find((l) => l.id === b.dataset.pinLine);
        if (!line) return;
        await c.patch('lines', line.id, { pinned: !line.pinned }); // patch 默认 reload + 重绘
      }));
      root.querySelectorAll('[data-act="done-line"]').forEach((b) => b.addEventListener('click', async () => {
        const line = c.data.lines.find((l) => l.id === b.dataset.doneLine);
        if (!line) return;
        await c.patch('lines', line.id, { done: !line.done });
      }));
      root.querySelectorAll('[data-act="edit-line"]').forEach((b) => b.addEventListener('click', () => {
        openLineForm(c.data.lines.find((l) => l.id === b.dataset.editLine));
      }));
      root.querySelectorAll('[data-act="del-line"]').forEach((b) => b.addEventListener('click', async () => {
        const line = c.data.lines.find((l) => l.id === b.dataset.delLine);
        const sure = await openConfirm({ title: '删除线路', message: `将删除「${line.name}」及全部节拍。`, danger: true, okText: '删除' });
        if (sure) { await c.remove('lines', line.id); toast('已删除', 'success'); }
      }));

      root.querySelectorAll('[data-act="add-beat"]').forEach((b) => b.addEventListener('click', () => {
        const lineId = b.dataset.addBeat;
        openForm({
          title: '新增节拍', width: 480,
          fields: [
            { key: 'title', label: '节拍标题' },
            { key: 'description', label: '发生什么', type: 'textarea', rows: 3 },
            { key: 'nodeId', label: '关联大纲节点', type: 'select', options: [['', '（不关联）'], ...flatOutlineOptions(c.data.outline)] }
          ],
          okText: '添加',
          onSubmit: async (v) => {
            if (!v.title) { toast('请填写标题', 'error'); return false; }
            await c.create('beats', { ...v, lineId });
            toast('已添加', 'success');
          }
        });
      }));

      root.querySelectorAll('.beat').forEach((el) => {
        el.addEventListener('click', (e) => {
          if (e.target.closest('[data-act]')) return;
          const beat = c.data.beats.find((b) => b.id === el.dataset.id);
          openBeat(c, beat);
        });
      });

      root.querySelectorAll('[data-act="move-beat"]').forEach((b) => b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const beat = c.data.beats.find((x) => x.id === b.dataset.moveBeat);
        const sibs = c.data.beats.filter((x) => x.lineId === beat.lineId).sort(byOrder);
        const i = sibs.findIndex((x) => x.id === beat.id);
        const j = Number(b.dataset.dir) > 0 ? i - 1 : i + 1;
        if (j < 0 || j >= sibs.length) return;
        await c.patch('beats', beat.id, { order: sibs[j].order }, { silent: true });
        await c.patch('beats', sibs[j].id, { order: beat.order }, { silent: true });
        await c.reload();
      }));

      root.querySelectorAll('[data-act="del-beat"]').forEach((b) => b.addEventListener('click', async (e) => {
        e.stopPropagation();
        await c.remove('beats', b.dataset.delBeat);
        toast('已删除', 'success');
      }));

      root.querySelector('[data-act="ai"]').addEventListener('click', () => {
        openForm({
          title: 'AI 梳理线路', subtitle: '将基于现有大纲与角色生成主线与副线',
          width: 500,
          fields: [{ key: 'guidance', label: '侧重方向（可选）', type: 'textarea', rows: 3, placeholder: '例如：想突出复仇线与救赎线的对立' }],
          okText: '生成',
          onSubmit: async (v) => {
            await runGenTask(c, {
              title: 'AI 正在梳理…', icon: '🧵', kind: 'plot',
              params: { guidance: v.guidance },
              applyTitle: '生成的线路',
              render: (it) => `<b>${esc(it.name)}</b><span class="gen-type">${esc(c.meta.lineLabel[it.kind] || it.kind)}</span>
                    <p>${esc(it.description || '')}</p>
                    <ol class="gen-beats">${(it.beats || []).map((b2) => `<li>${esc(b2.title)}</li>`).join('')}</ol>`,
              apply: async (it) => {
                const line = await c.create('lines', { name: it.name, kind: it.kind, description: it.description });
                for (const b2 of it.beats || []) await c.create('beats', { ...b2, lineId: line.id });
              }
            });
          }
        });
      });
    }
  };
}

function laneHtml(l, d, ctx) {
  const beats = d.beats.filter((b) => b.lineId === l.id).sort(byOrder);
  return `
    <div class="lane ${l.kind === 'main' ? 'is-main' : ''}${l.done ? ' is-done' : ''}" style="--lane:${esc(l.color || '#6b8afd')}">
      <div class="lane-head">
        <div class="lane-title">
          <span class="kind-badge k-${esc(l.kind)}">${esc(ctx.meta.lineLabel[l.kind] || l.kind)}</span>
          <b>${esc(l.name)}</b>
        </div>
        <p class="lane-desc">${esc(l.description || '（暂无说明）')}</p>
        <div class="lane-acts">
          <button class="btn ghost xs${l.pinned ? ' lane-pinned' : ''}" data-act="pin-line" data-pin-line="${l.id}" title="${l.pinned ? '取消置顶' : '置顶'}">📌 ${l.pinned ? '已置顶' : '置顶'}</button>
          <button class="btn ghost xs${l.done ? ' lane-done' : ''}" data-act="done-line" data-done-line="${l.id}" title="${l.done ? '标记未完成' : '标记已完成'}">${l.done ? '✓ 已完成' : '标记完成'}</button>
          <button class="btn ghost xs" data-act="edit-line" data-edit-line="${l.id}">编辑</button>
          <button class="btn ghost xs" data-act="del-line" data-del-line="${l.id}">删除</button>
        </div>
      </div>
      <div class="lane-track">
        ${beats.length
        ? beats.map((b, i) => `
            <div class="beat ${b.status === 'done' ? 'done' : ''}" data-id="${b.id}">
              <span class="beat-n">${i + 1}</span>
              <div class="beat-body">
                <b>${esc(b.title)}</b>
                ${b.description ? `<p>${esc(b.description)}</p>` : ''}
                ${b.nodeId ? (() => { const n = d.outline.find((x) => x.id === b.nodeId); return n ? `<span class="beat-link">🗂 ${esc(n.title)}</span>` : ''; })() : ''}
              </div>
              <div class="beat-acts">
                <button data-act="move-beat" data-move-beat="${b.id}" data-dir="1" title="前移">‹</button>
                <button data-act="move-beat" data-move-beat="${b.id}" data-dir="-1" title="后移">›</button>
                <button data-act="del-beat" data-del-beat="${b.id}" title="删除">✕</button>
              </div>
            </div>`).join('')
        : `<div class="lane-empty">尚未铺设节拍</div>`}
        <button class="beat-add" data-act="add-beat" data-add-beat="${l.id}">＋ 节拍</button>
      </div>
    </div>`;
}

function openBeat(ctx, beat, onSaved) {
  openForm({
    title: '编辑节拍', width: 480,
    fields: [
      { key: 'title', label: '标题' },
      { key: 'description', label: '发生什么', type: 'textarea', rows: 3 },
      { key: 'status', label: '状态', type: 'select', options: [['idea', '灵感'], ['planned', '已排'], ['done', '已完成']] },
      { key: 'nodeId', label: '关联大纲节点', type: 'select', options: [['', '（不关联）'], ...flatOutlineOptions(ctx.data.outline)] }
    ],
    values: beat,
    okText: '保存',
    onSubmit: async (v) => {
      await ctx.patch('beats', beat.id, v);
      toast('已保存', 'success');
      if (onSaved) await onSaved();
    }
  });
}

function flatOutlineOptions(nodes) {
  const out = [];
  const walk = (pid, depth) => {
    childrenOf(nodes, pid).forEach((n) => {
      out.push([n.id, `${'　'.repeat(depth)}${depth ? '└ ' : ''}${n.title}`]);
      walk(n.id, depth + 1);
    });
  };
  walk(null, 0);
  return out;
}

/* ==================================================================== 章节 */

/**
 * 正文字号：全屏写作顶栏的 A－ / A＋ 调节。
 * 存 localStorage，通过 CSS 变量 --editor-fs 生效（正文编辑区通用，全屏内外都跟手）。
 */
const FS_KEY = 'novel-studio:editor-font';
export const FONT_MIN = 13;
export const FONT_MAX = 30;
export const FONT_DEFAULT = 17;

// 会话内的「权威字号」。必须记在内存里：桌面端 localStorage 会随本地服务端口变化而清空，
// 只认 localStorage 的话，一旦打开/新建章节就会退回默认 17px，把启动时从服务端取回的字号当场盖掉。
let currentFont = null;

export function editorFontSize() {
  if (currentFont != null) return currentFont;
  try {
    const v = Number(localStorage.getItem(FS_KEY));
    if (Number.isFinite(v) && v >= FONT_MIN && v <= FONT_MAX) return Math.round(v);
  } catch (e) { /* 隐私模式等读不到就吃默认值 */ }
  return FONT_DEFAULT;
}

export function applyEditorFont(px, persist = true) {
  const v = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(Number(px) || FONT_DEFAULT)));
  currentFont = v;
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--editor-fs', `${v}px`);
    const lab = document.getElementById('fontSizeVal');
    if (lab) lab.textContent = `${v}px`;
    document.querySelectorAll('[data-act="font-dec"]').forEach((b) => { b.disabled = v <= FONT_MIN; });
    document.querySelectorAll('[data-act="font-inc"]').forEach((b) => { b.disabled = v >= FONT_MAX; });
  }
  if (persist) {
    // localStorage 在桌面端靠不住：本地服务端口每次启动都不同，「源」一变这份存储就等于换新，
    // 字号重启后必丢。真正要落盘的是服务端 settings.ui（userData/store.json，与端口无关）。
    try { localStorage.setItem(FS_KEY, String(v)); } catch (e) { /* 忽略 */ }
    try { const p = api.saveSettings({ ui: { editorFont: v } }); if (p && p.catch) p.catch(() => { /* 忽略 */ }); } catch (e) { /* 忽略 */ }
  }
  return v;
}

// 模块加载时就把上次存过的字号挂上去，避免打开正文先闪一下默认大小。
// 没存过就不设变量，交给 CSS 各自的默认值（非全屏 16px / 全屏 17px）。
if (typeof document !== 'undefined') {
  try {
    const saved = Number(localStorage.getItem(FS_KEY));
    if (Number.isFinite(saved) && saved >= FONT_MIN && saved <= FONT_MAX) {
      currentFont = Math.round(saved);
      document.documentElement.style.setProperty('--editor-fs', `${currentFont}px`);
    }
  } catch (e) { /* 忽略 */ }
}

/**
 * 全屏写作模式开关（沉浸写作）。
 * 用 body 上的类 + 固定定位的编辑器实现，不占用系统全屏，Esc 退出（在 app.js 统一监听）。
 */
export function setWritingFull(on) {
  const next = on === undefined ? !document.body.classList.contains('writing-full') : !!on;
  document.body.classList.toggle('writing-full', next);
  document.querySelectorAll('[data-act="full"]').forEach((b) => {
    if (b.closest('.editor-full-bar')) return;             // 顶栏那个固定写「退出全屏」
    b.textContent = next ? '⛶ 退出全屏' : '⛶ 全屏';
    b.title = next ? '退出全屏（Esc）' : '全屏写作（Esc 退出）';
  });
  if (next) {
    const ta = document.getElementById('chapterContent');
    if (ta) ta.focus();
  }
  return next;
}

const BEAT_STATUS = { idea: '灵感', planned: '已排', done: '已完成' };

/**
 * 章节列表：目录栏里的每一个条目统称为「卡片」（.chapter-card）。
 * 若存在关联大纲节点（如合并导入的「卷」），按卷分组显示，否则保持平铺。
 */
function chapterItemsHtml(list, d, cur, labels) {
  const stName = (s) => (labels && labels[s]) || { todo: '待写', draft: '草稿', done: '完成' }[s] || '';
  const row = (c) => `
              <div class="chapter-item chapter-card ${cur && cur.id === c.id ? 'active' : ''}" data-id="${c.id}" title="${esc(c.title)}">
                <span class="status-dot s-${esc(c.status)}"></span>
                <span class="cc-body">
                  <span class="ci-title">${esc(c.title)}</span>
                  <span class="cc-meta">${(c.content || '').length} 字 · ${esc(stName(c.status))}</span>
                </span>
              </div>`;

  if (!list.some((c) => c.nodeId)) return list.map(row).join('');

  const nameOf = new Map((d.outline || []).map((n) => [n.id, n.title]));
  let out = '';
  let last = null;
  for (const c of list) {
    const nid = c.nodeId || null;
    if (nid !== last) {
      const label = nid ? (nameOf.get(nid) || '未命名卷') : '未归卷';
      out += `<div class="chapter-group">${esc(label)}</div>`;
      last = nid;
    }
    out += row(c);
  }
  return out;
}

export function chapters(ctx) {
  const d = ctx.data;
  const list = d.chapters.slice().sort(byOrder);
  const cur = d.chapters.find((c) => c.id === ctx.sel.chapterId) || list[0];

  return {
    html: `
      <div class="page editor-view">
        <div class="chapter-list">
          <div class="chapter-list-head" title="目录：每一章都是一张卡片">
            <span class="clh-label">目录</span>
            <span class="clh-count">${list.length} 章</span>
            <button class="btn primary xs" data-act="new" title="新建章节">＋</button>
          </div>
          <div class="chapter-items">
            ${list.length ? chapterItemsHtml(list, d, cur, ctx.meta && ctx.meta.statusLabel) : '<p class="muted small pad">还没有章节</p>'}
          </div>
        </div>
        <div class="chapter-main">
          ${cur ? chapterEditor(cur, d, ctx) : `<div class="empty"><div class="empty-glyph">📄</div><p>选择或新建一章开始写作</p><button class="btn primary sm" data-act="new">＋ 新建章节</button></div>`}
        </div>
      </div>`,

    mount(root, c) {
      // 编辑框自动保存（防抖 700ms）。任何重绘前都会先 flush，避免丢最后一段输入。
      const save = debounce(async (patchObj) => {
        await c.patch('chapters', cur.id, patchObj, { silent: true });   // 静默：不重建编辑器，保住光标
        c.syncLocal();
      }, 700);

      // 重绘会重建 DOM：重绘前先把编辑框里没保存的内容落盘。
      // 点章节、改状态、新建、AI 插入正文都会触发重绘，任何一条路径漏了都会丢最后 700ms 的输入，
      // 所以这里把它注册成通用钩子（render/reload 前统一执行），而不只是点章节时手动调。
      const flushNow = () => {
        if (!cur) return;
        const t = root.querySelector('#chapterTitle'); if (!t) return;
        const s = root.querySelector('#chapterSummary');
        const cm = root.querySelector('#chapterContent');
        const patch = {};
        if (t.value !== (cur.title || '')) patch.title = cur.title = t.value;
        if (s && s.value !== (cur.summary || '')) patch.summary = cur.summary = s.value;
        if (cm && cm.value !== (cur.content || '')) patch.content = cur.content = cm.value;
        save.cancel();     // 挂起的防抖由这次写入替代，避免它稍后拿着旧值再覆盖一遍
        // 返回 promise：调用方（reload）可以等它写完再重新拉数据，避免「写后立刻读」读到旧值
        if (Object.keys(patch).length) return c.patch('chapters', cur.id, patch, { silent: true });
        return null;
      };
      if (c.registerFlush) c.registerFlush(flushNow);

      // 新建章节后把它滚进视野（列表滚动位置本身由 render() 统一保留，不会再跳回第一章）
      if (c.sel.chapterReveal) {
        const id = c.sel.chapterReveal;
        c.sel.chapterReveal = null;
        const ni = root.querySelector(`.chapter-item[data-id="${id}"]`);
        if (ni) ni.scrollIntoView({ block: 'nearest' });
      }

      const rerenderKeepScroll = () => {
        flushNow();
        c.render();                       // 滚动位置由 render() 统一保留
      };

      root.querySelectorAll('[data-act="new"]').forEach((b) => b.addEventListener('click', async () => {
        await c.create('chapters', { title: `第 ${c.data.chapters.length + 1} 章` }, (created) => {
          c.sel.chapterId = created.id;
          c.sel.chapterReveal = created.id;
        });
        toast('已创建', 'success');
      }));

      root.querySelectorAll('.chapter-item').forEach((el) => {
        el.addEventListener('click', () => {
          if (c.sel.chapterId === el.dataset.id) return; // 再点当前章不做任何事
          c.sel.chapterId = el.dataset.id;
          rerenderKeepScroll();
        });
      });

      if (!cur) return;

      const titleEl = root.querySelector('#chapterTitle');
      const summaryEl = root.querySelector('#chapterSummary');
      const contentEl = root.querySelector('#chapterContent');
      const wcEl = root.querySelector('#wordCount');

      titleEl.addEventListener('input', () => save({ title: titleEl.value }));
      summaryEl.addEventListener('input', () => save({ summary: summaryEl.value }));
      contentEl.addEventListener('input', () => {
        const n = contentEl.value.length;
        wcEl.textContent = `${n} 字`;
        const fw = root.querySelector('#fullWords');
        if (fw) fw.textContent = `${n} 字`;
        save({ content: contentEl.value });
      });
      root.querySelectorAll('[data-act="full"]').forEach((b) => b.addEventListener('click', () => setWritingFull()));

      // 全屏顶栏的 A－ / A＋：改的是 CSS 变量，正文立刻跟手，不用重绘（保住光标）
      const fsBtns = root.querySelectorAll('[data-act="font-dec"], [data-act="font-inc"]');
      if (fsBtns.length) {
        applyEditorFont(editorFontSize(), false);       // 顺带同步显示值与两端禁用态
        fsBtns.forEach((b) => b.addEventListener('click', () => {
          applyEditorFont(editorFontSize() + (b.dataset.act === 'font-inc' ? 1 : -1));
        }));
      }

      root.querySelector('#chapterStatus').addEventListener('change', (e) => c.patch('chapters', cur.id, { status: e.target.value }).then(() => c.syncLocal()));

      const nodeSel = root.querySelector('#chapterNode');
      if (nodeSel) nodeSel.addEventListener('change', (e) => c.patch('chapters', cur.id, { nodeId: e.target.value || null }, { silent: true }).then(() => { cur.nodeId = e.target.value || null; c.syncLocal(); }));

      root.querySelector('[data-act="chapter-ai"]').addEventListener('click', () => {
        if (!c.apiReady) {
          toast('尚未配置模型，当前续写为演示内容', 'info');
        }
        openForm({
          title: 'AI 续写', subtitle: cur.title, width: 480,
          fields: [
            { key: 'instruction', label: '本段指令', type: 'textarea', rows: 3, placeholder: '例如：让冲突升级，但不要揭穿真相' },
            { key: 'words', label: '目标字数', type: 'select', options: [['400', '约 400 字'], ['800', '约 800 字'], ['1500', '约 1500 字']], default: '800' }
          ],
          okText: '开始续写',
          onSubmit: async (v) => {
            const t = c.aiTask('AI 正在续写…', { icon: '✍', detail: '正在读取本章正文并构思…' });
            try {
              const res = await api.aiContinue(c.projectId, cur.id, v.instruction, Number(v.words), { signal: t.signal });
              const len = (res.text || '').length;
              t.progress(1, `已写出约 ${len} 字`);
              t.finish(`已续写完成，约 ${len} 字`);
              const sep = contentEl.value && !contentEl.value.endsWith('\n') ? '\n\n' : '';
              openModal({
                title: '续写结果', subtitle: `约 ${len} 字`, width: 640,
                html: `<div class="result-text">${md(res.text).replace(/<p>/g, '<p class="prose">')}</div>`,
                buttons: [
                  { label: '放弃', kind: 'ghost' },
                  { label: '插入到正文', kind: 'primary', onClick: async () => {
                    await c.patch('chapters', cur.id, { content: contentEl.value + sep + res.text }, { silent: true });
                    await c.reload();
                    toast('已插入', 'success');
                  } }
                ]
              });
            } catch (err) {
              if (t.stopped) { t.stop('续写已中断'); toast('已停止', 'info'); }
              else { t.fail(err.message || '续写失败'); toast(err.message || '续写失败', 'error'); }
            }
          }
        });
      });

      const askOutline = () => {
        c.askAI(`为章节「${cur.title}」写一份细纲：分成 3~5 个场景，每个场景说明出场人物、场景目标、冲突点、以及结尾钩子。${cur.summary ? `本章要点：${cur.summary}` : ''}`);
      };
      root.querySelector('[data-act="chapter-outline"]').addEventListener('click', askOutline);
      const hintOutline = root.querySelector('[data-act="hint-outline"]');
      if (hintOutline) hintOutline.addEventListener('click', askOutline);

      root.querySelector('[data-act="chapter-del"]').addEventListener('click', async () => {
        const sure = await openConfirm({ title: '删除章节', message: `将删除「${cur.title}」的全部正文。`, danger: true, okText: '删除' });
        if (!sure) return;
        if (c.sel.chapterId === cur.id) c.sel.chapterId = null;
        await c.remove('chapters', cur.id);
        toast('已删除', 'success');
      });
    }
  };
}

function chapterEditor(cur, d, ctx) {
  const isFull = typeof document !== 'undefined' && document.body.classList.contains('writing-full');
  const blank = !(cur.content || '').trim();
  return `
    <div class="editor">
      <div class="editor-full-bar">
        <span class="efb-tag">全屏写作</span>
        <span class="efb-title">${esc(cur.title)}</span>
        <span class="word-count" id="fullWords">${(cur.content || '').length} 字</span>
        <div class="efb-font" title="正文字号">
          <button class="btn ghost sm" data-act="font-dec" title="缩小字号">A－</button>
          <span class="font-size-val" id="fontSizeVal">${editorFontSize()}px</span>
          <button class="btn ghost sm" data-act="font-inc" title="放大字号">A＋</button>
        </div>
        <button class="btn ghost sm" data-act="full">⛶ 退出全屏（Esc）</button>
      </div>
      <div class="editor-sheet">
        <div class="editor-head">
          <input class="editor-title" id="chapterTitle" value="${esc(cur.title)}" placeholder="请输入章节标题" />
          <select id="chapterStatus" class="slim-select">
            ${[['todo', '待写'], ['draft', '草稿'], ['done', '完成']]
      .map(([v, l]) => `<option value="${v}" ${cur.status === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <button class="btn ghost sm" data-act="full" title="全屏写作（Esc 退出）">${isFull ? '⛶ 退出全屏' : '⛶ 全屏'}</button>
          <button class="btn ghost sm danger-text" data-act="chapter-del">删除</button>
        </div>

        <div class="editor-tools">
          <button class="btn primary sm" data-act="chapter-ai">✨ AI 续写</button>
          <button class="btn ghost sm" data-act="chapter-outline">🗂 生成细纲</button>
          <label class="inline-field"><span>挂靠大纲</span>
            <select id="chapterNode">
              <option value="">（无）</option>
              ${flatOutlineOptions(d.outline).map(([v, l]) => `<option value="${v}" ${cur.nodeId === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
            </select>
          </label>
          <span class="word-count" id="wordCount">${(cur.content || '').length} 字</span>
        </div>

        <textarea id="chapterSummary" class="editor-summary" rows="2" placeholder="本章要点：要推进什么、收束什么、埋什么">${esc(cur.summary || '')}</textarea>
        ${blank ? `<div class="editor-hint"><span class="eh-icon">✨</span><span>这一章还空着 —— 让 AI 先出一版细纲，或者直接落笔</span><button class="btn ghost xs" data-act="hint-outline">生成细纲</button></div>` : ''}
        <textarea id="chapterContent" class="editor-content" placeholder="从这里开始写……">${esc(cur.content || '')}</textarea>
      </div>
    </div>`;
}

/* ==================================================================== 设定 */

const WORLD_CATS = ['地理', '历史', '规则', '势力', '物品', '习俗', '种族', '其他'];

export function world(ctx) {
  const d = ctx.data;
  const groups = {};
  const wsort = (a, b) => {
    const pin = (x) => (x.pinned ? 0 : 1);
    if (pin(a) !== pin(b)) return pin(a) - pin(b);
    const dn = (x) => (x.done ? 1 : 0);
    if (dn(a) !== dn(b)) return dn(a) - dn(b);
    return byRecent(a, b);
  };
  d.world.slice().sort(wsort).forEach((w) => { (groups[w.category || '其他'] ||= []).push(w); });
  const cats = Object.keys(groups);

  return {
    html: `
      <div class="page">
        ${toolbar(
      `<button class="btn primary sm" data-act="new">＋ 新增设定</button>`,
      `<button class="btn ghost sm" data-act="ai">✨ AI 补全设定</button>`
    )}
        ${cats.length
        ? cats.map((cat) => `
            <section class="panel">
              <h4>${esc(cat)} <span class="chip-count">${groups[cat].length}</span></h4>
              <div class="card-grid">
                ${groups[cat].map((w) => `
                  <article class="mini-card${w.pinned ? ' pinned' : ''}${w.done ? ' done-item' : ''}" data-id="${w.id}">
                    <b>${esc(w.title)}</b>
                    <p>${esc((w.content || '').slice(0, 90))}${(w.content || '').length > 90 ? '…' : ''}</p>
                    <div class="mini-card-acts">
                      <button data-act="pin" data-id="${w.id}" title="${w.pinned ? '取消置顶' : '置顶'}">${w.pinned ? '📌 已置顶' : '📌 置顶'}</button>
                      <button data-act="done" data-id="${w.id}" title="${w.done ? '标记未完成' : '标记已完成'}">${w.done ? '✓ 已完成' : '标记完成'}</button>
                      <button data-act="edit" data-id="${w.id}">编辑</button>
                      <button data-act="del" data-id="${w.id}">删除</button>
                    </div>
                  </article>`).join('')}
              </div>
            </section>`).join('')
        : emptyBox('世界还没有被定义。哪怕只写清三条运行规则，故事也会立刻稳住。', '<button class="btn primary sm" data-act="new">＋ 新增设定</button>')}
      </div>`,

    mount(root, c) {
      const form = (item) => openForm({
        title: item ? '编辑设定' : '新增设定', width: 560,
        fields: [
          { key: 'title', label: '名称' },
          { key: 'category', label: '分类', type: 'select', options: WORLD_CATS, default: '规则' },
          { key: 'content', label: '内容', type: 'textarea', rows: 5, hint: '写清它对剧情的实际约束' }
        ],
        values: item || {},
        okText: '保存',
        onSubmit: async (v) => {
          if (!v.title) { toast('请填写名称', 'error'); return false; }
          if (item) await c.patch('world', item.id, v); else await c.create('world', v);
          toast('已保存', 'success');
        }
      });

      root.querySelectorAll('[data-act="new"]').forEach((b) => b.addEventListener('click', () => form(null)));
      root.querySelectorAll('[data-act="edit"]').forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation();
        form(c.data.world.find((w) => w.id === b.dataset.id));
      }));
      root.querySelectorAll('[data-act="del"]').forEach((b) => b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const w = c.data.world.find((x) => x.id === b.dataset.id);
        const sure = await openConfirm({ title: '删除设定', message: `将删除「${w ? w.title : ''}」，删除后不可恢复。确定？`, danger: true, okText: '删除' });
        if (!sure) return;
        await c.remove('world', b.dataset.id);
        toast('已删除', 'success');
      }));
      root.querySelectorAll('[data-act="pin"]').forEach((b) => b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const w = c.data.world.find((x) => x.id === b.dataset.id);
        if (!w) return;
        await c.patch('world', w.id, { pinned: !w.pinned });
      }));
      root.querySelectorAll('[data-act="done"]').forEach((b) => b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const w = c.data.world.find((x) => x.id === b.dataset.id);
        if (!w) return;
        await c.patch('world', w.id, { done: !w.done });
      }));

      root.querySelector('[data-act="ai"]').addEventListener('click', () => {
        openForm({
          title: 'AI 补全设定', width: 500,
          fields: [
            { key: 'count', label: '数量', type: 'select', options: [['3', '3 条'], ['4', '4 条'], ['6', '6 条']], default: '4' },
            { key: 'guidance', label: '方向', type: 'textarea', rows: 3, placeholder: '例如：重点补全势力格局与经济运转' }
          ],
          okText: '生成',
          onSubmit: async (v) => {
            await runGenTask(c, {
              title: 'AI 正在构建世界…', icon: '🌍', kind: 'world',
              params: { count: Number(v.count), guidance: v.guidance },
              applyTitle: '生成的设定',
              render: (it) => `<b>${esc(it.title)}</b><span class="gen-type">${esc(it.category)}</span><p>${esc(it.content || '')}</p>`,
              apply: async (it) => { await c.create('world', it); }
            });
          }
        });
      });
    }
  };
}

/* ==================================================================== 伏笔 */

export function foreshadow(ctx) {
  const d = ctx.data;
  // 置顶的最前；再看未回收的排前面；勾选回收的进入「已回收」组且组内按勾选时间倒序（刚勾的在该组最前）
  const list = d.foreshadow.slice().sort((a, b) => {
    const pin = (x) => (x.pinned ? 0 : 1);
    if (pin(a) !== pin(b)) return pin(a) - pin(b);
    const done = (x) => (x.status === 'paid-off' ? 1 : 0);
    if (done(a) !== done(b)) return done(a) - done(b);
    return byRecent(a, b);
  });
  const open = list.filter((f) => f.status !== 'paid-off').length;

  return {
    html: `
      <div class="page">
        ${toolbar(
      `<button class="btn primary sm" data-act="new">＋ 登记伏笔</button>`,
      `<span class="toolbar-note">已埋 <b>${open}</b> 条未回收</span>
           <button class="btn ghost sm" data-act="ai">✨ AI 检查回收</button>`
    )}
        ${list.length
        ? `<div class="table">
             ${list.map((f) => `
              <div class="tr ${f.status === 'paid-off' ? 'done-row' : ''}">
                <button class="check ${f.status === 'paid-off' ? 'on' : ''}" data-act="toggle" data-id="${f.id}" title="标记回收">${f.status === 'paid-off' ? '✓' : ''}</button>
                <div class="td-main">
                  <b>${esc(f.title)}</b>
                  ${f.payoffHint ? `<p>回收设想：${esc(f.payoffHint)}</p>` : '<p class="muted">尚未设想回收方式</p>'}
                  ${f.plantedChapter ? `<span class="tag">埋于 ${esc(f.plantedChapter)}</span>` : ''}
                </div>
                <div class="td-acts">
                  <button class="${f.pinned ? 'pinned' : ''}" data-act="pin" data-id="${f.id}" title="${f.pinned ? '取消置顶' : '置顶'}">${f.pinned ? '📌 已置顶' : '📌 置顶'}</button>
                  <button data-act="edit" data-id="${f.id}">编辑</button>
                  <button data-act="del" data-id="${f.id}">删除</button>
                </div>
              </div>`).join('')}
           </div>`
        : emptyBox('伏笔是长篇的复利。随手登记，结尾才收得住。', '<button class="btn primary sm" data-act="new">＋ 登记伏笔</button>')}
      </div>`,

    mount(root, c) {
      const form = (item) => openForm({
        title: item ? '编辑伏笔' : '登记伏笔', width: 520,
        fields: [
          { key: 'title', label: '伏笔内容', type: 'textarea', rows: 2 },
          { key: 'plantedChapter', label: '埋设位置', placeholder: '如：第 3 章' },
          { key: 'payoffHint', label: '回收设想', type: 'textarea', rows: 3 },
          { key: 'status', label: '状态', type: 'select', options: [['planted', '已埋'], ['paid-off', '已回收']], default: 'planted' }
        ],
        values: item || {},
        okText: '保存',
        onSubmit: async (v) => {
          if (!v.title) { toast('请填写内容', 'error'); return false; }
          if (item) await c.patch('foreshadow', item.id, v); else await c.create('foreshadow', v);
          toast('已保存', 'success');
        }
      });

      root.querySelectorAll('[data-act="new"]').forEach((b) => b.addEventListener('click', () => form(null)));
      root.querySelectorAll('[data-act="edit"]').forEach((b) => b.addEventListener('click', () => form(c.data.foreshadow.find((f) => f.id === b.dataset.id))));
      root.querySelectorAll('[data-act="del"]').forEach((b) => b.addEventListener('click', async () => {
        const f = c.data.foreshadow.find((x) => x.id === b.dataset.id);
        const sure = await openConfirm({ title: '删除伏笔', message: `将删除「${f ? f.title : ''}」，删除后不可恢复。确定？`, danger: true, okText: '删除' });
        if (!sure) return;
        await c.remove('foreshadow', b.dataset.id);
        toast('已删除', 'success');
      }));
      root.querySelectorAll('[data-act="toggle"]').forEach((b) => b.addEventListener('click', async () => {
        const f = c.data.foreshadow.find((x) => x.id === b.dataset.id);
        const paidOff = f.status === 'paid-off';
        await c.patch('foreshadow', f.id, paidOff
          ? { status: 'planted', paidOffAt: null }
          : { status: 'paid-off', paidOffAt: Date.now() });
      }));
      root.querySelectorAll('[data-act="pin"]').forEach((b) => b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const f = c.data.foreshadow.find((x) => x.id === b.dataset.id);
        if (!f) return;
        await c.patch('foreshadow', f.id, { pinned: !f.pinned });
      }));

      root.querySelector('[data-act="ai"]').addEventListener('click', () => {
        c.askAI('检查所有未回收的伏笔：指出哪些已经拖太久、哪些可能被读者遗忘，并给出在接下来三章内可以完成的回收方案。');
      });
    }
  };
}

/* ==================================================================== 备忘 */

const NOTE_CATS = ['灵感', '备忘', '待解决', '设定'];

export function notes(ctx) {
  const d = ctx.data;
  const list = d.notes.slice().sort((a, b) => {
    const pin = (x) => (x.pinned ? 0 : 1);
    if (pin(a) !== pin(b)) return pin(a) - pin(b);
    const dn = (x) => (x.done ? 1 : 0);
    if (dn(a) !== dn(b)) return dn(a) - dn(b);
    return byRecent(a, b);
  });

  return {
    html: `
      <div class="page">
        ${toolbar(
      `<button class="btn primary sm" data-act="new">＋ 记一笔</button>`,
      `<button class="btn ghost sm" data-act="brainstorm">✨ AI 脑暴</button>`
    )}
        ${list.length
        ? `<div class="note-grid">${list.map((n) => `
            <article class="note-card cat-${esc(n.category || '备忘')}${n.done ? ' done-item' : ''}" data-id="${n.id}">
              <header>
                <span class="cat-tag">${esc(n.category || '备忘')}</span>
                <span class="note-head-acts">
                  <button class="icon-btn ${n.pinned ? 'pinned' : ''}" data-act="pin" data-id="${n.id}" title="置顶">${n.pinned ? '★ 已置顶' : '☆ 置顶'}</button>
                  <button class="icon-btn ${n.done ? 'on' : ''}" data-act="done" data-id="${n.id}" title="${n.done ? '标记未完成' : '标记已完成'}">${n.done ? '✓ 已完成' : '标记完成'}</button>
                </span>
              </header>
              <b>${esc(n.title)}</b>
              ${n.content ? `<p class="note-brief">${esc(n.content)}</p>` : ''}
              <footer>
                <button data-act="view" data-id="${n.id}">展开全文</button>
                <button data-act="edit" data-id="${n.id}">编辑</button>
                <button data-act="del" data-id="${n.id}">删除</button>
              </footer>
            </article>`).join('')}</div>`
        : emptyBox('想到什么先扔进来。灵感不记，转身就忘。', '<button class="btn primary sm" data-act="new">＋ 记一笔</button>')}
      </div>`,

    mount(root, c) {
      const form = (item) => openForm({
        title: item ? '编辑备忘' : '新建备忘', width: 520,
        fields: [
          { key: 'title', label: '标题' },
          { key: 'category', label: '分类', type: 'select', options: NOTE_CATS, default: '备忘' },
          { key: 'content', label: '内容', type: 'textarea', rows: 4 }
        ],
        values: item || {},
        okText: '保存',
        onSubmit: async (v) => {
          if (!v.title) { toast('请填写标题', 'error'); return false; }
          if (item) await c.patch('notes', item.id, v); else await c.create('notes', v);
          toast('已保存', 'success');
        }
      });

      root.querySelectorAll('[data-act="new"]').forEach((b) => b.addEventListener('click', () => form(null)));
      root.querySelectorAll('[data-act="view"]').forEach((b) => b.addEventListener('click', () => {
        const n = c.data.notes.find((x) => x.id === b.dataset.id);
        if (!n) return;
        openModal({
          title: n.title, subtitle: n.category || '备忘', width: 620,
          html: `<div class="note-full">${esc(n.content || '（无内容）')}</div>`,
          buttons: [
            { label: '编辑', kind: 'primary', onClick: () => form(n) },
            { label: '关闭', kind: 'ghost' }
          ]
        });
      }));
      root.querySelectorAll('[data-act="edit"]').forEach((b) => b.addEventListener('click', () => form(c.data.notes.find((n) => n.id === b.dataset.id))));
      root.querySelectorAll('[data-act="del"]').forEach((b) => b.addEventListener('click', async () => {
        const n = c.data.notes.find((x) => x.id === b.dataset.id);
        const sure = await openConfirm({ title: '删除备忘', message: `将删除「${n ? n.title : ''}」，删除后不可恢复。确定？`, danger: true, okText: '删除' });
        if (!sure) return;
        await c.remove('notes', b.dataset.id);
        toast('已删除', 'success');
      }));
      root.querySelectorAll('[data-act="pin"]').forEach((b) => b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const n = c.data.notes.find((x) => x.id === b.dataset.id);
        await c.patch('notes', n.id, { pinned: !n.pinned });
      }));
      root.querySelectorAll('[data-act="done"]').forEach((b) => b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const n = c.data.notes.find((x) => x.id === b.dataset.id);
        if (!n) return;
        await c.patch('notes', n.id, { done: !n.done });
      }));

      root.querySelector('[data-act="brainstorm"]').addEventListener('click', () => {
        openForm({
          title: 'AI 脑暴', width: 520,
          fields: [
            { key: 'topic', label: '想解决什么', type: 'textarea', rows: 3, placeholder: '例如：主角中段失去动力，怎么让他重新上路' },
            { key: 'count', label: '方案数', type: 'select', options: [['3', '3 个'], ['4', '4 个'], ['5', '5 个']], default: '3' }
          ],
          okText: '开脑暴',
          onSubmit: async (v) => {
            await runGenTask(c, {
              title: 'AI 正在发散…', icon: '💡', kind: 'brainstorm',
              params: { topic: v.topic, count: Number(v.count) },
              applyTitle: '脑暴结果',
              render: (it) => `<b>${esc(it.title)}</b><p>${esc(it.detail || '')}</p>${it.risk ? `<p class="gen-muted">风险：${esc(it.risk)}</p>` : ''}`,
              apply: async (it) => { await c.create('notes', { title: it.title, content: `${it.detail || ''}\n\n风险提示：${it.risk || '—'}`, category: '灵感' }); }
            });
          }
        });
      });
    }
  };
}

/* ==================================================================== 素材箱 */

const MAT_SOURCES = ['智谱清言', 'ChatGPT', 'DeepSeek', 'Kimi', 'Claude', '其他'];

export function materials(ctx) {
  const d = ctx.data;
  const list = d.materials.slice().sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0));
  const usedTools = new Set();

  return {
    html: `
      <div class="page">
        ${toolbar(
      `<button class="btn primary sm" data-act="import">＋ 导入外部对话</button>`,
      `<span class="toolbar-note">助手可读的素材 <b>${list.length}</b> 段　这些内容会进入上下文索引，需要时由助手取全文</span>`
    )}

        ${list.length
        ? `<div class="mat-list">${list.map((m) => `
            <article class="mat-card" data-id="${m.id}">
              <header>
                <span class="source-badge">${esc(m.source || '外部导入')}</span>
                <span class="mat-count">${m.messageCount || '—'} 条对话</span>
              </header>
              <b>${esc(m.title)}</b>
              <p>${esc((m.content || '').slice(0, 130))}${(m.content || '').length > 130 ? '…' : ''}</p>
              <footer>
                <button data-act="view" data-id="${m.id}">查看全文</button>
                <button data-act="mine" data-id="${m.id}">✨ 让 AI 提炼</button>
                <button data-act="del" data-id="${m.id}">删除</button>
              </footer>
            </article>`).join('')}</div>`
        : `<div class="empty">
             <div class="empty-glyph">📥</div>
             <p>把其他平台上的对话搬进来——不当废聊天丢掉，让助手把它们变成大纲、角色和伏笔。</p>
             <button class="btn primary sm" data-act="import">＋ 导入外部对话</button>
             <p class="muted small" style="margin-top:14px">
               支持：智谱清言 / ChatGPT 等平台的 JSON 导出文件、Markdown、以及直接从网页复制粘贴的文本。
             </p>
           </div>`}
      </div>`,

    mount(root, c) {
      const openImport = () => openImportDialog(c);

      root.querySelectorAll('[data-act="import"]').forEach((b) => b.addEventListener('click', openImport));

      root.querySelectorAll('[data-act="view"]').forEach((b) => b.addEventListener('click', () => {
        const m = c.data.materials.find((x) => x.id === b.dataset.id);
        openModal({
          title: m.title, subtitle: `${m.source || '外部导入'}　${m.messageCount || '?'} 条对话`, width: 720,
          html: `<div class="result-text">${md(m.content).replace(/<p>/g, '<p class="prose">')}</div>`
        });
      }));

      root.querySelectorAll('[data-act="mine"]').forEach((b) => b.addEventListener('click', () => {
        const m = c.data.materials.find((x) => x.id === b.dataset.id);
        if (usedTools.has(m.id)) return toast('这段已经提炼过了', 'info');
        usedTools.add(m.id);
        c.askAI(`素材箱里有一段从「${m.source || '外部平台'}」导入的对话《${m.title}》，素材 id 是 ${m.id}。

请这样处理：
1. 先调用 read_material 读取全文（不要凭预览臆测）；
2. 把其中有创作价值的角色、设定、情节线索、伏笔分别提炼出来，**直接用工具创建进对应模块**；
3. 明确告诉我：你采纳了哪些、丢弃了哪些、为什么丢弃；
4. 如果这段对话里存在自相矛盾的设定，指出来。`);
      }));

      root.querySelectorAll('[data-act="del"]').forEach((b) => b.addEventListener('click', async () => {
        const m = c.data.materials.find((x) => x.id === b.dataset.id);
        const sure = await openConfirm({ title: '删除素材', message: `将删除《${m.title}》，原对话内容不可恢复。`, danger: true, okText: '删除' });
        if (sure) { await c.remove('materials', m.id); toast('已删除', 'success'); }
      }));
    }
  };
}

function openImportDialog(c) {
  let parsed = null;
  let source = MAT_SOURCES[0];

  const m = openModal({
    title: '导入外部对话',
    subtitle: '粘贴文本或选择文件，自动识别 JSON / Markdown / 纯文本',
    width: 700,
    footer: false,
    html: `
      <div class="import-wrap">
        <div class="import-actions">
          <label class="field inline-src"><span>来源</span>
            <select id="impSource">
              ${MAT_SOURCES.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}
            </select>
          </label>
          <button class="btn ghost sm" id="impFileBtn">📁 选择文件</button>
          <input type="file" id="impFile" accept=".json,.md,.markdown,.txt,application/json,text/plain" hidden />
          <span class="muted small" id="impFileInfo">未选择文件</span>
        </div>

        <textarea id="impText" rows="9" placeholder="把导出的 JSON 全文，或直接从对话页面复制的内容粘贴到这里。&#10;&#10;支持的常见写法：&#10;  我：……            GLM：……&#10;  用户：……          助手：……&#10;  **用户**：……      **助手**：……&#10;  # 标题 分段的 Markdown"></textarea>

        <div class="import-parse">
          <button class="btn primary sm" id="impParse">解析内容</button>
          <span class="muted small" id="impHint"></span>
        </div>

        <div id="impResult"></div>
      </div>`
  });

  const body = m.body;
  const textEl = body.querySelector('#impText');
  const resultEl = body.querySelector('#impResult');
  const hintEl = body.querySelector('#impHint');

  body.querySelector('#impSource').addEventListener('change', (e) => { source = e.target.value; });

  body.querySelector('#impFileBtn').addEventListener('click', () => body.querySelector('#impFile').click());
  body.querySelector('#impFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) return toast('文件过大（>8MB），请拆分后再导入', 'error');
    textEl.value = await file.text();
    body.querySelector('#impFileInfo').textContent = `${file.name}（${Math.round(file.size / 1024)} KB）`;
    hintEl.textContent = '文件已读入，点「解析内容」';
  });

  body.querySelector('#impParse').addEventListener('click', () => {
    const raw = textEl.value || '';
    if (!raw.trim()) return toast('请先粘贴内容或选择文件', 'error');
    parsed = parseImport(raw, source);

    if (!parsed.items.length) {
      resultEl.innerHTML = `<p class="empty-hint">没能识别出对话结构。${esc(parsed.error || '')}
        <br>可以检查一下：JSON 是否完整（未被截断）、文本里是否有「问：/ 答：」这类角色标记。</p>`;
      hintEl.textContent = '';
      return;
    }

    hintEl.textContent = `识别出 ${parsed.items.length} 段对话（${parsed.kind === 'json' ? 'JSON' : '文本'}格式）`;
    resultEl.innerHTML = `
      <div class="gen-list">
        ${parsed.items.map((it, i) => `
          <label class="gen-item">
            <input type="checkbox" checked data-i="${i}" />
            <div>
              <b>${esc(it.title)}</b>
              <span class="gen-type">${it.messageCount} 条</span>
              <p>${esc(it.content.slice(0, 150))}…</p>
            </div>
          </label>`).join('')}
      </div>
      <div class="import-foot">
        <button class="btn ghost sm" id="impCancel">取消</button>
        <button class="btn primary sm" id="impApply">导入选中的素材</button>
      </div>`;

    resultEl.querySelector('#impCancel').addEventListener('click', () => m.close());
    resultEl.querySelector('#impApply').addEventListener('click', async () => {
      const idxs = Array.from(resultEl.querySelectorAll('input[type=checkbox]'))
        .filter((x) => x.checked).map((x) => Number(x.dataset.i));
      if (!idxs.length) return toast('没有选中任何一段', 'error');
      const btn = resultEl.querySelector('#impApply');
      btn.disabled = true;
      btn.textContent = '导入中…';
      try {
        const res = await api.importMaterials(c.projectId, idxs.map((i) => parsed.items[i]), source);
        await c.reload();
        toast(`已导入 ${res.created} 段素材`, 'success');
        m.close();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = '导入选中的素材';
      }
    });
  });
}

/* ==================================================================== AI 生成结果应用弹窗 */

/**
 * 跑一个「AI 生成」任务：过程显示在 AI 助手里（会自动打开面板、可随时停止），
 * 勾选应用之后汇报最终执行了多少项。生成大纲 / 角色 / 线路 / 设定 / 脑暴都走这里，
 * 于是这些功能看起来就和「跟助手对话」一样。
 */
async function runGenTask(ctx, { title, icon, kind, params, applyTitle, render, apply }) {
  const t = ctx.aiTask(title, { icon, detail: '正在读取项目数据并思考…' });
  try {
    const res = await api.aiGenerate(ctx.projectId, kind, params, { signal: t.signal });
    const n = (res.data || []).length;
    if (!n) {
      t.fail(res.demo ? '演示模式没有产出内容（去「设置」配置模型后更好）' : '模型没有返回可用内容，可稍后重试');
      toast('没有生成结果', 'error');
      return;
    }
    t.progress(0, `已生成 ${n} 条候选`);
    t.note(`共 ${n} 条候选，勾选后写入项目`);
    aiApplyList(ctx, res, {
      title: applyTitle, render, apply,
      onApplied: (k) => {
        if (k) t.finish(`已完成：生成 ${n} 条候选，写入项目 ${k} 项`);
        else t.finish(`已生成 ${n} 条候选（未应用）`);
      }
    });
  } catch (err) {
    if (t.stopped) { t.stop('生成已中断'); toast('已停止', 'info'); } else {
      t.fail(err.message || '生成失败');
      toast(err.message || '生成失败', 'error');
    }
  }
}

function aiApplyList(ctx, res, { title, render, apply, onApplied }) {
  const items = res.data || [];
  if (!items.length) { toast('没有生成结果', 'error'); if (onApplied) onApplied(0); return; }

  openModal({
    title,
    subtitle: res.demo ? '演示模式结果 · 配置模型后质量更佳' : '勾选后应用到项目',
    width: 680,
    html: `<div class="gen-list">${items.map((it, i) => `
        <label class="gen-item">
          <input type="checkbox" checked data-i="${i}" />
          <div>${render(it)}</div>
        </label>`).join('')}</div>`,
    buttons: [
      { label: '取消', kind: 'ghost', onClick: () => { if (onApplied) onApplied(0); } },
      {
        label: '应用选中', kind: 'primary', keepOpen: true,
        onClick: async (body, wrap) => {
          const idxs = Array.from(body.querySelectorAll('input[type=checkbox]')).filter((x) => x.checked).map((x) => Number(x.dataset.i));
          if (!idxs.length) { toast('没有选中任何项', 'error'); return; }
          for (const i of idxs) await apply(items[i]);
          closeAndRefresh(wrap, ctx, idxs.length);
          if (onApplied) onApplied(idxs.length);
        }
      }
    ]
  });

  function closeAndRefresh(wrap, c, n) {
    wrap.classList.remove('in');
    setTimeout(() => wrap.remove(), 200);
    c.reload().then(() => toast(`已应用 ${n} 项`, 'success'));
  }
}

/* ================================================================ AI 记忆点 */

/** 单章一行：标题、字数对比、记忆点编辑框 */
function memoRow(c, i) {
  const memo = String(c.memo || '');
  const len = String(c.content || '').length;
  return `
    <div class="memo-row ${memo.trim() ? 'has-memo' : ''}" data-id="${c.id}">
      <div class="memo-row-head">
        <span class="memo-idx">${i + 1}</span>
        <span class="memo-title" title="${esc(c.title || '')}">${esc(c.title || '（无题）')}</span>
        <span class="memo-meta">正文 ${len} 字 · 记忆点 <b class="memo-len">${memo.length}</b> 字</span>
        <span class="memo-acts">
          <button class="btn primary xs" data-act="gen-one" title="AI 生成本章记忆点">✨ 生成</button>
          <button class="btn ghost xs" data-act="clear-one" title="清空本章记忆点">清空</button>
        </span>
      </div>
      <textarea class="memo-input" rows="2" placeholder="本章记忆点：出场人物 / 关键事件 / 推进到哪一步 / 埋下或回收的伏笔">${esc(memo)}</textarea>
    </div>`;
}

/** 把全书已生成的记忆点拼成一段纯文本（供复制给外部 AI 使用） */
function buildMemoAllText(list, title) {
  const lines = [`《${title}》剧情记忆点`, ''];
  list.forEach((c, i) => {
    const memo = String(c.memo || '').trim();
    if (memo) lines.push(`第${i + 1}章 ${c.title}：${memo}`);
  });
  return lines.join('\n');
}

/** 解码 TXT：优先 UTF-8，出现乱码就回退 GBK（很多 TXT 是 GBK 存的） */
function decodeTextBuf(buf) {
  try {
    const utf8 = new TextDecoder('utf-8').decode(buf);
    if (utf8.includes('\uFFFD')) {
      try { return new TextDecoder('gbk').decode(buf); } catch (_) { /* 浏览器不支持则用 utf-8 */ }
    }
    return utf8;
  } catch (_) { return ''; }
}

/**
 * 把记忆点 TXT 解析并对应到章节。认得四种写法；认不出来的行按顺序补进还没匹配的章节：
 *   第3章 主角登场…      → 按序号
 *   3. 主角登场…         → 按序号
 *   雨夜：主角登场…      → 按标题
 *   主角登场…            → 按顺序
 */
function parseMemoText(text, chapters) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const used = new Set();
  const entries = [];
  const pending = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let m = line.match(/^第\s*(\d+)\s*[章节節][^\n:：]*[:：\s]\s*(.*)$/);
    if (!m) m = line.match(/^第\s*(\d+)\s*[章节節]\s*(.*)$/);
    if (!m) m = line.match(/^(\d+)\s*[.、．)）]\s*(.*)$/);
    if (m) {
      const ch = chapters[Number(m[1]) - 1];
      const memo = String(m[2] || '').trim();
      if (ch && memo) { entries.push({ id: ch.id, title: ch.title, memo, by: 'index' }); used.add(ch.id); continue; }
    }
    // 《标题》：内容  /  标题：内容
    const tm = line.match(/^[《]?([^》]+)[》]?\s*[:：]\s*(.*)$/);
    if (tm) {
      const name = String(tm[1] || '').trim();
      const body = String(tm[2] || '').trim();
      const hit = name && body && chapters.find((c) => {
        const t = String(c.title || '').trim();
        return t === name || t.includes(name) || name.includes(t);
      });
      if (hit) { entries.push({ id: hit.id, title: hit.title, memo: body, by: 'title' }); used.add(hit.id); continue; }
    }
    pending.push(line);
  }

  let p = 0;
  for (const c of chapters) {
    if (used.has(c.id)) continue;
    if (p >= pending.length) break;
    entries.push({ id: c.id, title: c.title, memo: pending[p++], by: 'order' });
    used.add(c.id);
  }
  const order = new Map(chapters.map((c, i) => [c.id, i]));
  entries.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { entries, leftover: Math.max(0, pending.length - p) };
}

/** 导入预览：可勾选、可直接改，确认后再写回各章 */
function openMemoImportDialog(c, entries, leftover) {
  const byLabel = (b) => (b === 'index' ? '按序号' : b === 'title' ? '按标题' : '按顺序');
  openModal({
    title: '导入记忆点',
    subtitle: `识别到 ${entries.length} 条${leftover ? `（另有 ${leftover} 行没用上）` : ''} · 可在下面直接修改`,
    width: 720,
    footerLeft: '<span class="muted small">原本已有记忆点的默认不勾选，避免覆盖；要覆盖就手动勾上</span>',
    html: `
      <div class="memo-import-list">
        ${entries.map((e, i) => `
          <label class="memo-import-row ${e.hasMemo ? 'is-overwrite' : ''}" data-i="${i}">
            <input type="checkbox" ${e.hasMemo ? '' : 'checked'} />
            <div class="mi-head">
              <b>${esc(e.title || '（无题）')}</b>
              <span class="mi-by">${byLabel(e.by)}</span>
              ${e.hasMemo ? '<span class="mi-tag">已有记忆点 · 将覆盖</span>' : ''}
            </div>
            <textarea class="mi-memo" rows="2">${esc(e.memo)}</textarea>
          </label>`).join('')}
      </div>`,
    buttons: [
      { label: '取消', kind: 'ghost' },
      {
        label: '导入选中', kind: 'primary', keepOpen: true,
        onClick: async (body, wrap) => {
          const picked = [];
          [...body.querySelectorAll('.memo-import-row')].forEach((row) => {
            if (!row.querySelector('input[type=checkbox]').checked) return;
            const memo = row.querySelector('.mi-memo').value.trim();
            if (memo) picked.push({ id: entries[Number(row.dataset.i)].id, memo });
          });
          if (!picked.length) { toast('没有勾选任何条', 'error'); return false; }
          for (const it of picked) await c.patch('chapters', it.id, { memo: it.memo }, { silent: true });
          await c.reload();
          closeModal(wrap);
          toast(`已导入 ${picked.length} 条记忆点`, 'success');
        }
      }
    ]
  });
}

/**
 * AI 记忆点：把每章正文压缩成一小段剧情摘要，让 AI 用最少的字掌握全书剧情，
 * 不必每次都读取全文。数据保存在章节的 memo 字段上。
 */
export function memos(ctx) {
  const d = ctx.data;
  const list = d.chapters.slice().sort(byOrder);
  const srcWords = list.reduce((s, c) => s + String(c.content || '').length, 0);
  const memoWords = list.reduce((s, c) => s + String(c.memo || '').length, 0);
  const withContent = list.filter((c) => String(c.content || '').trim()).length;
  const doneCount = list.filter((c) => String(c.memo || '').trim()).length;
  const ratio = srcWords ? Math.round((memoWords / srcWords) * 1000) / 10 : 0;

  const stats = [
    { label: '章节总数', value: list.length, sub: `${withContent} 章有正文`, icon: '📄' },
    { label: '已生成记忆点', value: doneCount, sub: `待生成 ${Math.max(0, withContent - doneCount)} 章`, icon: '🧠' },
    { label: '正文总字数', value: fmtNum(srcWords), sub: '原文规模', icon: '✍' },
    { label: '记忆点字数', value: fmtNum(memoWords), sub: srcWords ? `约为原文 ${ratio}%` : '—', icon: '⚡' }
  ];

  return {
    html: `
      <div class="page memo-view">
        <section class="memo-head">
          <div class="memo-head-main">
            <h3>🧠 AI 记忆点</h3>
            <p class="muted small">把每章正文压成一小段剧情摘要。AI 助手读了它就知道全书讲了什么、讲到哪，不必每次都读原文。</p>
          </div>
          <div class="memo-head-stats">
            ${stats.map((s) => `
              <div class="memo-stat">
                <span class="memo-stat-ico">${s.icon}</span>
                <div><b>${esc(s.value)}</b><span>${esc(s.label)}</span><em>${esc(s.sub)}</em></div>
              </div>`).join('')}
          </div>
        </section>

        <div class="memo-toolbar">
          <button class="btn primary sm" data-act="gen-missing" ${withContent ? '' : 'disabled'}>✨ 生成缺失的记忆点</button>
          <button class="btn ghost sm" data-act="gen-all" ${withContent ? '' : 'disabled'}>↻ 全部重新生成</button>
          <button class="btn ghost sm" data-act="download" ${doneCount ? '' : 'disabled'}>⬇ 下载 TXT</button>
          <button class="btn ghost sm" data-act="import" ${list.length ? '' : 'disabled'}>📥 导入 TXT</button>
          <button class="btn ghost sm danger-text" data-act="clear" ${doneCount ? '' : 'disabled'}>清空全部</button>
          <span class="memo-tip">${ctx.apiReady ? '' : '未配置模型，将用本地压缩（较粗糙）；到右上「设置」配置后更佳'}</span>
        </div>

        <div class="memo-list">
          ${list.length
        ? list.map((c, i) => memoRow(c, i)).join('')
        : emptyBox('这部作品还没有章节。先去「章节」写下内容，再回来生成记忆点。', '<button class="btn primary sm" data-act="goto-chapters">去「章节」</button>')}
        </div>
      </div>`,

    mount(root, c) {
      let running = false;   // 防止重复点击「全部生成」并发跑批

      function applyToDom(id, memo) {
        const row = root.querySelector(`.memo-row[data-id="${id}"]`);
        if (row) {
          const ta = row.querySelector('.memo-input');
          if (ta) ta.value = memo;
          const lenEl = row.querySelector('.memo-len');
          if (lenEl) lenEl.textContent = String(memo.length);
          row.classList.toggle('has-memo', Boolean(memo.trim()));
        }
        // 同步内存数据，好让侧栏「已生成章节数」实时跟上（静默保存不会重拉数据）
        const item = c.data.chapters.find((x) => x.id === id);
        if (item) item.memo = memo;
        c.syncLocal();
      }

      async function runBatch(ids) {
        if (running || !ids.length) return;
        running = true;
        // 进度与结果并入 AI 助手对话流：自动打开面板 → 显示第几章 / 共几章 → 末尾汇报成功多少章
        const t = c.aiTask('AI 正在生成记忆点…', { icon: '🧠', total: ids.length, detail: `共 ${ids.length} 章待处理` });
        let ok = 0; let fail = 0;
        for (let i = 0; i < ids.length; i++) {
          if (t.stopped) break;
          const ch = c.data.chapters.find((x) => x.id === ids[i]);
          t.progress(i, `正在生成 ${i + 1} / ${ids.length}${ch ? `：${ch.title}` : ''}`);
          try {
            const res = await api.aiMemos(c.projectId, { chapterIds: [ids[i]], onlyMissing: false }, { signal: t.signal });
            const up = (res.updated && res.updated[0]) || null;
            if (up) { ok += 1; applyToDom(up.id, up.memo || ''); t.item(ch ? ch.title : ids[i]); }
            else fail += 1;
          } catch (_) { fail += 1; }
          t.progress(i + 1, `已完成 ${i + 1} / ${ids.length}（成功 ${ok}）`);
        }
        running = false;
        if (t.stopped) { t.stop(`已中断：成功生成 ${ok} 章`); toast('已停止', 'info'); }
        else {
          t.finish(`已完成：成功 ${ok} 章${fail ? `，失败 ${fail} 章` : ''}`);
          toast(`生成完成：成功 ${ok} 章${fail ? `，失败 ${fail} 章` : ''}`, fail && !ok ? 'error' : 'success');
        }
        await c.reload();
      }

      root.querySelectorAll('[data-act="gen-one"]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.closest('.memo-row').dataset.id;
        const ch = c.data.chapters.find((x) => x.id === id);
        const t = c.aiTask(`AI 正在生成「${ch ? ch.title : '本章'}」记忆点…`, { icon: '🧠', total: 1, detail: '正在读取本章正文…' });
        try {
          const res = await api.aiMemos(c.projectId, { chapterIds: [id], onlyMissing: false }, { signal: t.signal });
          const up = (res.updated && res.updated[0]) || null;
          if (up) { applyToDom(id, up.memo || ''); c.syncLocal(); t.progress(1, '已生成'); t.finish(`已生成「${ch ? ch.title : '本章'}」的记忆点`); toast('已生成', 'success'); }
          else { t.fail('该章暂无正文，无法生成'); toast('该章暂无正文，无法生成', 'error'); }
        } catch (err) {
          if (t.stopped) { t.stop('已中断'); toast('已停止', 'info'); }
          else { t.fail(err.message || '生成失败'); toast(err.message || '生成失败', 'error'); }
        }
      }));

      root.querySelectorAll('[data-act="clear-one"]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.closest('.memo-row').dataset.id;
        const title = b.closest('.memo-row').querySelector('.memo-title').textContent;
        const sure = await openConfirm({ title: '清空记忆点', message: `将清空「${title}」的记忆点（章节正文不受影响），确定？`, danger: true, okText: '清空' });
        if (!sure) return;
        await c.patch('chapters', id, { memo: '' }, { silent: true });
        applyToDom(id, '');
        c.syncLocal();
      }));

      root.querySelectorAll('.memo-input').forEach((ta) => {
        const row = ta.closest('.memo-row');
        const id = row.dataset.id;
        const save = debounce(() => {
          c.patch('chapters', id, { memo: ta.value }, { silent: true }).then(() => c.syncLocal());
          row.classList.toggle('has-memo', Boolean(ta.value.trim()));
          const lenEl = row.querySelector('.memo-len');
          if (lenEl) lenEl.textContent = String(ta.value.length);
        }, 600);
        ta.addEventListener('input', save);
      });

      const missingIds = () => list
        .filter((c2) => String(c2.content || '').trim() && !String(c2.memo || '').trim())
        .map((c2) => c2.id);
      const allContentIds = () => list.filter((c2) => String(c2.content || '').trim()).map((c2) => c2.id);

      const genMissing = root.querySelector('[data-act="gen-missing"]');
      if (genMissing) genMissing.addEventListener('click', () => runBatch(missingIds()));

      const genAll = root.querySelector('[data-act="gen-all"]');
      if (genAll) genAll.addEventListener('click', async () => {
        const ids = allContentIds();
        const yes = await openConfirm({
          title: '全部重新生成', message: `将重新生成 ${ids.length} 章的记忆点，覆盖现有内容。继续？`, okText: '开始生成'
        });
        if (yes) runBatch(ids);
      });

      const dlBtn = root.querySelector('[data-act="download"]');
      if (dlBtn) dlBtn.addEventListener('click', () => {
        const text = buildMemoAllText(list, d.project.title || '作品');
        const name = `${d.project.title || '作品'}-记忆点`;
        try {
          downloadText(name, text);
          toast('已导出 TXT（可在系统弹窗里选择保存位置）', 'success');
        } catch (_) {
          // 极少数环境拦截了自动下载：退回到手动复制
          navigator.clipboard.writeText(text)
            .then(() => toast('无法直接保存，已复制到剪贴板', 'info'))
            .catch(() => {
              openModal({
                title: '全书记忆点', subtitle: '复制下面这段即可交给外部 AI', width: 640, footer: false,
                html: `<textarea class="memo-copy" rows="16">${esc(text)}</textarea>`
              });
            });
        }
      });

      const clearBtn = root.querySelector('[data-act="clear"]');
      if (clearBtn) clearBtn.addEventListener('click', async () => {
        const yes = await openConfirm({ title: '清空全部记忆点', message: `将清空 ${doneCount} 章的记忆点（章节正文不受影响），之后可重新生成。确定？`, danger: true, okText: '清空' });
        if (!yes) return;
        for (const c2 of list) {
          if (String(c2.memo || '').trim()) await c.patch('chapters', c2.id, { memo: '' }, { silent: true });
        }
        await c.reload();
        toast('已清空', 'success');
      });

      const importBtn = root.querySelector('[data-act="import"]');
      if (importBtn) importBtn.addEventListener('click', () => {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.txt,text/plain';
        inp.hidden = true;
        document.body.appendChild(inp);
        inp.addEventListener('change', async () => {
          const file = inp.files && inp.files[0];
          inp.remove();
          if (!file) return;
          const text = stripBom(decodeTextBuf(await file.arrayBuffer()));
          const { entries, leftover } = parseMemoText(text, list);
          if (!entries.length) { toast('没从这个文件里识别出可用的记忆点', 'error'); return; }
          entries.forEach((e) => {
            const ch = list.find((x) => x.id === e.id);
            e.hasMemo = !!String((ch && ch.memo) || '').trim();
          });
          openMemoImportDialog(c, entries, leftover);
        });
        inp.click();
      });

      const gotoBtn = root.querySelector('[data-act="goto-chapters"]');
      if (gotoBtn) gotoBtn.addEventListener('click', () => c.setView('chapters'));
    }
  };
}
