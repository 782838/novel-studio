'use strict';
import api from './api.js';
import { esc, md, openForm, openModal, openConfirm, toast, debounce } from './ui.js';
import { parseImport } from './importer.js';

const TYPE_ORDER = { act: 0, chapter: 1, scene: 2, beat: 3 };

function fmtNum(n) {
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
  return String(n);
}

function byOrder(a, b) {
  return (a.order || 0) - (b.order || 0);
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
            toast('AI 正在构思…');
            const res = await api.aiGenerate(c.projectId, 'outline', {
              parentId: parent ? parent.id : null,
              count: Number(v.count),
              guidance: v.guidance
            });
            aiApplyList(c, res, {
              title: '生成的大纲节点',
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
  const list = d.characters.slice().sort((a, b) => {
    const rank = (x) => (/主角/.test(x.role || '') ? 0 : /反派/.test(x.role || '') ? 1 : 2);
    return rank(a) - rank(b) || byOrder(a, b);
  });

  return {
    html: `
      <div class="page">
        ${toolbar(
      `<button class="btn primary sm" data-act="new">＋ 新建角色</button>
             <button class="btn ghost sm" data-act="ai">✨ AI 生成角色</button>`,
      `<label class="switch-inline"><input type="checkbox" id="toggleGraph" ${graph ? 'checked' : ''}/> 关系图</label>
             <input class="search" id="charSearch" placeholder="搜索角色…" value="${esc(ctx.sel.query || '')}" />`
    )}

        ${graph
        ? `<section class="panel graph-panel">${relationGraph(d)}</section>`
        : (list.length ? `<div class="char-grid">${list.map((c) => charCard(c, d)).join('')}</div>`
          : emptyBox('还没有角色。先建一个主角，或者让助手替你把人物补齐。', '<button class="btn primary sm" data-act="new">＋ 新建角色</button>'))}
      </div>`,

    mount(root, c) {
      const newBtn = () => openForm({
        title: '新建角色', width: 620,
        fields: characterFields(),
        okText: '创建',
        onSubmit: async (v) => {
          if (!v.name) { toast('请填写姓名', 'error'); return false; }
          const ch = await c.create('characters', v);
          openCharacter(c, ch.id);
        }
      });

      root.querySelectorAll('[data-act="new"]').forEach((b) => b.addEventListener('click', newBtn));

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
            toast('AI 正在设计人物…');
            const res = await api.aiGenerate(c.projectId, 'character', { count: Number(v.count), guidance: v.guidance });
            aiApplyList(c, res, {
              title: '生成的角色',
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

      const search = root.querySelector('#charSearch');
      search.addEventListener('input', () => {
        c.sel.query = search.value;
        const q = search.value.trim().toLowerCase();
        root.querySelectorAll('.char-card').forEach((el) => {
          const hay = el.textContent.toLowerCase();
          el.style.display = !q || hay.includes(q) ? '' : 'none';
        });
      });

      root.querySelectorAll('.char-card').forEach((el) => {
        el.addEventListener('click', () => openCharacter(c, el.dataset.id));
      });
    }
  };
}

function characterFields() {
  return [
    { key: 'name', label: '姓名' },
    { key: 'role', label: '定位', type: 'select', options: ['主角', '重要配角', '配角', '反派', '群像'], default: '配角' },
    { key: 'alias', label: '别名 / 称号' },
    { key: 'age', label: '年龄' },
    { key: 'appearance', label: '外貌特征', type: 'textarea', rows: 2 },
    { key: 'personality', label: '性格层次', type: 'textarea', rows: 2, hint: '表面与内里的反差' },
    { key: 'motivation', label: '核心动机', type: 'textarea', rows: 2, hint: '他到底想要什么' },
    { key: 'flaw', label: '弱点 / 缺陷', type: 'textarea', rows: 2 },
    { key: 'arc', label: '人物弧光', type: 'textarea', rows: 2, hint: '从什么走向什么' },
    { key: 'beatNote', label: '关键转折节点', type: 'textarea', rows: 2 }
  ];
}

function charCard(c, d) {
  const rels = d.relations.filter((r) => r.fromId === c.id || r.toId === c.id).length;
  return `
    <article class="char-card" data-id="${c.id}">
      <header>
        <span class="avatar" style="background:${esc(c.color || '#6b8afd')}">${esc((c.name || '?').slice(0, 1))}</span>
        <div class="char-head-text">
          <b>${esc(c.name)}</b>
          <span class="role-badge">${esc(c.role || '未定位')}</span>
        </div>
      </header>
      <p class="char-line">${esc((c.motivation || c.personality || '（动机待补充）'))}</p>
      <footer>
        ${c.arc ? `<span title="弧光">↗ ${esc(c.arc.slice(0, 18))}</span>` : ''}
        <span title="关系数">🔗 ${rels}</span>
      </footer>
    </article>`;
}

function relationGraph(d) {
  const chars = d.characters;
  if (!chars.length) return emptyBox('还没有角色');
  const W = 960; const H = 460;
  const cx = W / 2; const cy = H / 2;
  const R = Math.min(cx, cy) - 70;
  const pos = new Map();
  const n = chars.length;
  chars.forEach((ch, i) => {
    if (n === 1) { pos.set(ch.id, { x: cx, y: cy }); return; }
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    pos.set(ch.id, { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R * 0.82 });
  });

  const nameOf = new Map(chars.map((c) => [c.id, c.name]));
  const lines = d.relations.map((r) => {
    const a = pos.get(r.fromId); const b = pos.get(r.toId);
    if (!a || !b) return '';
    const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
    const nx = -(b.y - a.y); const ny = (b.x - a.x);
    const len = Math.hypot(nx, ny) || 1;
    const off = 22;
    const lx = mx + (nx / len) * off; const ly = my + (ny / len) * off;
    return `<g class="rel">
      <line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#cfc8ba" stroke-width="1.4" />
      <text x="${lx}" y="${ly}" class="rel-label">${esc(r.label)}</text>
    </g>`;
  }).join('');

  const nodes = chars.map((ch) => {
    const p = pos.get(ch.id);
    return `<g class="rel-node" data-id="${ch.id}">
      <circle cx="${p.x}" cy="${p.y}" r="26" fill="${esc(ch.color || '#6b8afd')}" />
      <text x="${p.x}" y="${p.y + 6}" class="rel-init">${esc((ch.name || '?').slice(0, 1))}</text>
      <text x="${p.x}" y="${p.y + 45}" class="rel-name">${esc(ch.name)}</text>
    </g>`;
  }).join('');

  return `<svg class="rel-svg" viewBox="0 0 ${W} ${H}">${lines}${nodes}</svg>`;
}

export function openCharacter(ctx, charId) {
  const render = () => {
    const c = ctx.data.characters.find((x) => x.id === charId);
    if (!c) return;
    const rels = ctx.data.relations.filter((r) => r.fromId === charId || r.toId === charId);
    const nameOf = new Map(ctx.data.characters.map((x) => [x.id, x.name]));

    openModal({
      title: c.name, subtitle: c.role || '未定位', width: 720,
      html: `
        <div class="char-detail">
          <div class="cd-left">
            ${[['别名', c.alias], ['年龄', c.age], ['外貌', c.appearance], ['性格', c.personality],
        ['核心动机', c.motivation], ['弱点', c.flaw], ['人物弧光', c.arc], ['转折节点', c.beatNote]]
        .map(([k, v]) => `<div class="cd-field"><span>${k}</span><p>${v ? esc(v) : '<i class="muted">待补充</i>'}</p></div>`).join('')}
          </div>
          <div class="cd-right">
            <h5>人物关系</h5>
            ${rels.length ? `<ul class="rel-list">${rels.map((r) => {
        const other = r.fromId === charId ? r.toId : r.fromId;
        const dir = r.fromId === charId ? '→' : '←';
        return `<li><b>${esc(nameOf.get(other) || '?')}</b> <span class="rel-dir">${dir}</span> ${esc(r.label)}
                  ${r.description ? `<em>${esc(r.description)}</em>` : ''}
                  <button class="icon-btn danger" data-del-rel="${r.id}" title="删除关系">✕</button></li>`;
      }).join('')}</ul>` : '<p class="muted small">暂无关系记录</p>'}
            <button class="btn ghost sm block" data-act="add-rel">＋ 添加关系</button>
            <h5 class="mt">出现在的线路</h5>
            ${(() => {
        const tagRe = new RegExp(c.name, 'i');
        const hits = ctx.data.beats.filter((b) => tagRe.test(`${b.title}${b.description || ''}`));
        return hits.length
          ? `<ul class="rel-list">${hits.map((b) => {
            const line = ctx.data.lines.find((l) => l.id === b.lineId);
            return `<li><b>${esc(b.title)}</b><em>${esc(line ? line.name : '')}</em></li>`;
          }).join('')}</ul>`
          : '<p class="muted small">线路中尚未提及该角色</p>';
      })()}
          </div>
        </div>`,
      buttons: [
        { label: '删除角色', kind: 'danger', keepOpen: true, onClick: async () => {
          const sure = await openConfirm({ title: '删除角色', message: `将删除「${c.name}」及其关系记录。`, danger: true, okText: '删除' });
          if (!sure) return;
          await ctx.remove('characters', charId);
          toast('已删除', 'success');
        } },
        { label: 'AI 深化人设', kind: 'ghost', keepOpen: true, onClick: () => {
          ctx.askAI(`请深化角色「${c.name}」的人设：指出他当前设定里最薄弱的一环，补充童年经历与一个会让读者心疼的具体细节，然后直接更新到角色卡。`);
        } },
        { label: '编辑', kind: 'primary', keepOpen: true, onClick: () => {
          openForm({
            title: `编辑 ${c.name}`, width: 620, fields: characterFields(), values: c, okText: '保存',
            onSubmit: async (v) => { await ctx.patch('characters', charId, v); toast('已保存', 'success'); }
          });
        } }
      ],
      onMount: (body) => {
        body.querySelector('[data-act="add-rel"]').addEventListener('click', () => {
          openForm({
            title: '添加关系', width: 480,
            fields: [
              { key: 'toId', label: '对方角色', type: 'select', options: ctx.data.characters.filter((x) => x.id !== charId).map((x) => [x.id, x.name]) },
              { key: 'label', label: '关系', placeholder: '如：师徒 / 宿敌 / 暗恋' },
              { key: 'description', label: '说明', type: 'textarea', rows: 2 }
            ],
            okText: '添加',
            onSubmit: async (v) => {
              if (!v.toId || !v.label) { toast('请填写完整', 'error'); return false; }
              await ctx.create('relations', { fromId: charId, toId: v.toId, label: v.label, description: v.description });
              toast('已添加', 'success');
              await ctx.reload();
              render();
            }
          });
        });
        body.querySelectorAll('[data-del-rel]').forEach((b) => b.addEventListener('click', async () => {
          await ctx.remove('relations', b.dataset.delRel);
          await ctx.reload();
          render();
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
    const rank = (x) => (x.kind === 'main' ? 0 : x.kind === 'romance' ? 1 : x.kind === 'mystery' ? 2 : 3);
    return rank(a) - rank(b) || byOrder(a, b);
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
            toast('AI 正在梳理…');
            const res = await api.aiGenerate(c.projectId, 'plot', { guidance: v.guidance });
            aiApplyList(c, res, {
              title: '生成的线路',
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
    <div class="lane ${l.kind === 'main' ? 'is-main' : ''}" style="--lane:${esc(l.color || '#6b8afd')}">
      <div class="lane-head">
        <div class="lane-title">
          <span class="kind-badge k-${esc(l.kind)}">${esc(ctx.meta.lineLabel[l.kind] || l.kind)}</span>
          <b>${esc(l.name)}</b>
        </div>
        <p class="lane-desc">${esc(l.description || '（暂无说明）')}</p>
        <div class="lane-acts">
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

function openBeat(ctx, beat) {
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
    onSubmit: async (v) => { await ctx.patch('beats', beat.id, v); toast('已保存', 'success'); }
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

/** 章节列表：若存在关联大纲节点（如合并导入的「卷」），按卷分组显示，否则保持平铺 */
function chapterItemsHtml(list, d, cur) {
  const row = (c) => `
              <div class="chapter-item ${cur && cur.id === c.id ? 'active' : ''}" data-id="${c.id}">
                <span class="ci-title">${esc(c.title)}</span>
                <span class="ci-words">${(c.content || '').length}</span>
                <span class="status-dot s-${esc(c.status)}"></span>
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
          <div class="chapter-list-head">
            <b>章节</b>
            <button class="btn primary xs" data-act="new">＋</button>
          </div>
          <div class="chapter-items">
            ${list.length ? chapterItemsHtml(list, d, cur) : '<p class="muted small pad">还没有章节</p>'}
          </div>
        </div>
        <div class="chapter-main">
          ${cur ? chapterEditor(cur, d, ctx) : `<div class="empty"><div class="empty-glyph">📄</div><p>选择或新建一章开始写作</p><button class="btn primary sm" data-act="new">＋ 新建章节</button></div>`}
        </div>
      </div>`,

    mount(root, c) {
      root.querySelectorAll('[data-act="new"]').forEach((b) => b.addEventListener('click', async () => {
        const ch = await c.create('chapters', { title: `第 ${c.data.chapters.length + 1} 章` }, (created) => { c.sel.chapterId = created.id; });
        toast('已创建', 'success');
      }));

      root.querySelectorAll('.chapter-item').forEach((el) => {
        el.addEventListener('click', () => { c.sel.chapterId = el.dataset.id; c.render(); });
      });

      if (!cur) return;

      const save = debounce(async (patchObj) => {
        await c.patch('chapters', cur.id, patchObj, { silent: true });   // 静默：不重建编辑器，保住光标
        c.syncLocal();
      }, 700);

      const titleEl = root.querySelector('#chapterTitle');
      const summaryEl = root.querySelector('#chapterSummary');
      const contentEl = root.querySelector('#chapterContent');
      const wcEl = root.querySelector('#wordCount');

      titleEl.addEventListener('input', () => save({ title: titleEl.value }));
      summaryEl.addEventListener('input', () => save({ summary: summaryEl.value }));
      contentEl.addEventListener('input', () => {
        wcEl.textContent = `${contentEl.value.length} 字`;
        save({ content: contentEl.value });
      });
      root.querySelector('#chapterStatus').addEventListener('change', (e) => c.patch('chapters', cur.id, { status: e.target.value }).then(() => c.syncLocal()));

      const nodeSel = root.querySelector('#chapterNode');
      if (nodeSel) nodeSel.addEventListener('change', (e) => c.patch('chapters', cur.id, { nodeId: e.target.value || null }).then(() => c.render()));

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
            const m = openModal({
              title: '正在续写…', width: 620,
              html: `<div class="loading-block"><div class="spinner"></div><p>助手正在读上下文并动笔</p></div>`,
              footer: false
            });
            try {
              const res = await api.aiContinue(c.projectId, cur.id, v.instruction, Number(v.words));
              m.close();
              const sep = contentEl.value && !contentEl.value.endsWith('\n') ? '\n\n' : '';
              openModal({
                title: '续写结果', subtitle: `约 ${(res.text || '').length} 字`, width: 640,
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
              m.close();
              toast(err.message, 'error');
            }
          }
        });
      });

      root.querySelector('[data-act="chapter-outline"]').addEventListener('click', () => {
        c.askAI(`为章节「${cur.title}」写一份细纲：分成 3~5 个场景，每个场景说明出场人物、场景目标、冲突点、以及结尾钩子。${cur.summary ? `本章要点：${cur.summary}` : ''}`);
      });

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
  return `
    <div class="editor">
      <div class="editor-head">
        <input class="editor-title" id="chapterTitle" value="${esc(cur.title)}" placeholder="章节标题" />
        <select id="chapterStatus" class="slim-select">
          ${[['todo', '待写'], ['draft', '草稿'], ['done', '完成']]
      .map(([v, l]) => `<option value="${v}" ${cur.status === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
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
      <textarea id="chapterContent" class="editor-content" placeholder="从这里开始写……">${esc(cur.content || '')}</textarea>
    </div>`;
}

/* ==================================================================== 设定 */

const WORLD_CATS = ['地理', '历史', '规则', '势力', '物品', '习俗', '种族', '其他'];

export function world(ctx) {
  const d = ctx.data;
  const groups = {};
  d.world.forEach((w) => { (groups[w.category || '其他'] ||= []).push(w); });
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
                  <article class="mini-card" data-id="${w.id}">
                    <b>${esc(w.title)}</b>
                    <p>${esc((w.content || '').slice(0, 90))}${(w.content || '').length > 90 ? '…' : ''}</p>
                    <div class="mini-card-acts">
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
        await c.remove('world', b.dataset.id);
        toast('已删除', 'success');
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
            toast('AI 正在构建世界…');
            const res = await api.aiGenerate(c.projectId, 'world', { count: Number(v.count), guidance: v.guidance });
            aiApplyList(c, res, {
              title: '生成的设定',
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
  const list = d.foreshadow.slice().sort((a, b) => (a.status === b.status ? byOrder(a, b) : (a.status === 'paid-off' ? 1 : -1)));
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
        await c.remove('foreshadow', b.dataset.id);
        toast('已删除', 'success');
      }));
      root.querySelectorAll('[data-act="toggle"]').forEach((b) => b.addEventListener('click', async () => {
        const f = c.data.foreshadow.find((x) => x.id === b.dataset.id);
        await c.patch('foreshadow', f.id, { status: f.status === 'paid-off' ? 'planted' : 'paid-off' });
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
  const list = d.notes.slice().sort((a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || (b.createdAt || 0) - (a.createdAt || 0));

  return {
    html: `
      <div class="page">
        ${toolbar(
      `<button class="btn primary sm" data-act="new">＋ 记一笔</button>`,
      `<button class="btn ghost sm" data-act="brainstorm">✨ AI 脑暴</button>`
    )}
        ${list.length
        ? `<div class="note-grid">${list.map((n) => `
            <article class="note-card cat-${esc(n.category || '备忘')}" data-id="${n.id}">
              <header>
                <span class="cat-tag">${esc(n.category || '备忘')}</span>
                <button class="icon-btn ${n.pinned ? 'pinned' : ''}" data-act="pin" data-id="${n.id}" title="置顶">${n.pinned ? '★' : '☆'}</button>
              </header>
              <b>${esc(n.title)}</b>
              ${n.content ? `<p>${esc(n.content)}</p>` : ''}
              <footer>
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
      root.querySelectorAll('[data-act="edit"]').forEach((b) => b.addEventListener('click', () => form(c.data.notes.find((n) => n.id === b.dataset.id))));
      root.querySelectorAll('[data-act="del"]').forEach((b) => b.addEventListener('click', async () => {
        await c.remove('notes', b.dataset.id);
        toast('已删除', 'success');
      }));
      root.querySelectorAll('[data-act="pin"]').forEach((b) => b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const n = c.data.notes.find((x) => x.id === b.dataset.id);
        await c.patch('notes', n.id, { pinned: !n.pinned });
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
            toast('AI 正在发散…');
            const res = await api.aiGenerate(c.projectId, 'brainstorm', { topic: v.topic, count: Number(v.count) });
            aiApplyList(c, res, {
              title: '脑暴结果',
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

function aiApplyList(ctx, res, { title, render, apply }) {
  const items = res.data || [];
  if (!items.length) return toast('没有生成结果', 'error');

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
      { label: '取消', kind: 'ghost' },
      {
        label: '应用选中', kind: 'primary', keepOpen: true,
        onClick: async (body, wrap) => {
          const idxs = Array.from(body.querySelectorAll('input[type=checkbox]')).filter((x) => x.checked).map((x) => Number(x.dataset.i));
          if (!idxs.length) { toast('没有选中任何项', 'error'); return; }
          for (const i of idxs) await apply(items[i]);
          closeAndRefresh(wrap, ctx, idxs.length);
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
