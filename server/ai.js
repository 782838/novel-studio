'use strict';
/**
 * 智能体引擎。
 * 1) 通过 OpenAI 兼容接口驱动多轮工具调用，让模型直接读写项目数据；
 * 2) 模型不支持 function calling 时，自动降级为 JSON 文本协议；
 * 3) 未配置 API Key 时进入演示模式，仍然产出可用骨架，便于先体验流程。
 */
const store = require('./store');

const MAX_ROUNDS = 8;
const REQUEST_TIMEOUT = 180000;

// ---------------------------------------------------------------- 基础调用

/** 解析「高级请求参数」文本框里的 JSON，非法则忽略并在首次打印日志 */
function parseExtraBody(raw) {
  const text = String(raw || '').trim();
  if (!text) return {};
  try {
    const obj = JSON.parse(text);
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch (_) {
    if (!parseExtraBody.warned) {
      parseExtraBody.warned = true;
      console.warn('[settings] 高级请求参数不是合法 JSON，已忽略：', text.slice(0, 80));
    }
    return {};
  }
}

function settings() { return store.load().settings; }

function llmEnabled() {
  const s = settings();
  return Boolean(s.apiKey && s.endpoint);
}

function endpointUrl() {
  const s = settings();
  let base = String(s.endpoint || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('尚未配置模型接口地址');
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  if (/\/chat\/completions$/i.test(base)) return base;
  if (!/\/v\d+([a-z-]*)?$/i.test(base)) base += '/v1';
  return `${base}/chat/completions`;
}

async function callChat({ messages, tools, temperature, maxTokens }) {
  const s = settings();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
  try {
    const body = {
      model: s.model,
      messages,
      temperature: temperature ?? s.temperature ?? 0.85,
      max_tokens: maxTokens ?? s.maxTokens ?? 4096,
      stream: false
    };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    // 合并用户自定义的高级参数（例如 GLM 的 reasoning_effort）
    const extra = parseExtraBody(s.extraBody);
    Object.assign(body, extra);
    const res = await fetch(endpointUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s.apiKey}`
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`模型服务返回 ${res.status}: ${text.slice(0, 300)}`);
    let json;
    try { json = JSON.parse(text); } catch (_) {
      throw new Error(`模型服务返回非 JSON 内容: ${text.slice(0, 200)}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function testConnection() {
  if (!llmEnabled()) return { ok: false, message: '未配置 API Key', configured: false };
  const t0 = Date.now();
  const json = await callChat({
    messages: [
      { role: 'system', content: 'You are a connectivity probe.' },
      { role: 'user', content: '回复两个字：正常' }
    ],
    maxTokens: 16
  });
  return {
    ok: true,
    configured: true,
    model: settings().model,
    reply: json?.choices?.[0]?.message?.content || '',
    latency: Date.now() - t0
  };
}

// ---------------------------------------------------------------- 上下文

function trunc(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function buildOutlineText(projectId) {
  const nodes = store.byProject('outline', projectId, { sort: false });
  const byParent = new Map();
  nodes.forEach((n) => {
    const k = n.parentId || '#root';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(n);
  });
  byParent.forEach((l) => l.sort((a, b) => (a.order || 0) - (b.order || 0)));
  const out = [];
  const walk = (key, depth) => {
    (byParent.get(key) || []).forEach((n) => {
      out.push(`${'  '.repeat(depth)}- [${n.type}] ${n.title}${n.summary ? `：${trunc(n.summary, 100)}` : ''}${n.status ? `（${n.status}）` : ''}  ⟦id:${n.id}⟧`);
      walk(n.id, depth + 1);
    });
  };
  walk('#root', 0);
  return out.join('\n') || '（暂无大纲）';
}

function buildCharacterText(projectId) {
  const chars = store.byProject('characters', projectId, { sort: false });
  if (!chars.length) return '（暂无角色）';
  const relMap = store.byProject('relations', projectId, { sort: false });
  return chars.map((c) => {
    const rel = relMap.filter((r) => r.fromId === c.id)
      .map((r) => {
        const t = chars.find((x) => x.id === r.toId);
        return t ? `${t.name}(${r.label})` : null;
      }).filter(Boolean).join('、');
    const bits = [
      `## ${c.name}`,
      c.role ? `定位：${c.role}` : '',
      c.alias ? `别名：${c.alias}` : '',
      c.age ? `年龄：${c.age}` : '',
      c.personality ? `性格：${trunc(c.personality, 80)}` : '',
      c.motivation ? `动机：${trunc(c.motivation, 80)}` : '',
      c.arc ? `弧光：${trunc(c.arc, 80)}` : '',
      c.beatNote ? `节点：${trunc(c.beatNote, 60)}` : '',
      rel ? `关系：${rel}` : ''
    ].filter(Boolean);
    return bits.join('\n') + `\n⟦id:${c.id}⟧`;
  }).join('\n\n');
}

function buildLineText(projectId) {
  const lines = store.byProject('lines', projectId);
  if (!lines.length) return '（暂无故事线）';
  const beats = store.byProject('beats', projectId, { sort: false });
  return lines.map((l) => {
    const bs = beats.filter((b) => b.lineId === l.id).sort((a, b) => (a.order || 0) - (b.order || 0));
    const body = bs.length
      ? bs.map((b, i) => `   ${i + 1}. ${b.title}${b.description ? ` — ${trunc(b.description, 60)}` : ''}`).join('\n')
      : '   （尚未铺设节拍）';
    return `## [${l.kind}] ${l.name}  ⟦id:${l.id}⟧\n${l.description ? `梗概：${trunc(l.description, 120)}\n` : ''}${body}`;
  }).join('\n\n');
}

function buildChapterText(projectId) {
  const chapters = store.byProject('chapters', projectId)
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  if (!chapters.length) return '（暂无章节）';
  const MAX = 150;
  const list = chapters.slice(0, MAX).map((c) => {
    const wc = (c.content || '').length;
    const head = trunc((c.content || '').replace(/[#>*`]/g, ''), 60);
    return `- [${c.status || 'todo'}] ${c.title}（${wc}字）⟦id:${c.id}⟧${head ? ` 开头：${head}` : ''}`;
  });
  if (chapters.length > MAX) {
    list.push(`- ……（其余 ${chapters.length - MAX} 章未列出，可用 read_chapter 按 index 读取）`);
  }
  list.push('（注意：这里只有标题与开头 60 字，不含正文全文。要分析或续写某一章，先调用 read_chapter 读原文。）');
  return list.join('\n');
}

function buildWorldText(projectId) {
  const items = store.byProject('world', projectId, { sort: false });
  if (!items.length) return '（暂无设定）';
  return items.map((w) => `- [${w.category}] ${w.title}：${trunc(w.content, 80)}`).join('\n');
}

function buildForeshadowText(projectId) {
  const items = store.byProject('foreshadow', projectId, { sort: false });
  if (!items.length) return '（暂无伏笔）';
  return items.map((f) => `- [${f.status || 'planted'}] ${f.title}${f.payoffHint ? ` → 回收设想：${trunc(f.payoffHint, 60)}` : ''}`).join('\n');
}

function buildMaterialText(projectId) {
  const items = store.byProject('materials', projectId, { sort: false });
  if (!items.length) return '（暂无外部素材）';
  return items.slice(-20).map((m) => {
    const meta = [m.source && `来源：${m.source}`, m.messageCount && `${m.messageCount} 条对话`].filter(Boolean).join('　');
    return `- ${m.title} ⟦id:${m.id}⟧${meta ? `（${meta}）` : ''}\n  预览：${trunc(m.content, 160)}`;
  }).join('\n');
}

function buildNoteText(projectId) {
  const items = store.byProject('notes', projectId, { sort: false }).slice(-30);
  if (!items.length) return '（暂无备忘）';
  return items.map((n) => `- [${n.category || '备忘'}] ${n.title}：${trunc(n.content, 80)}`).join('\n');
}

function buildContext(projectId, currentChapterId) {
  const project = store.getProject(projectId);
  if (!project) throw new Error('项目不存在');
  const parts = [
    `# 《${project.title}》`,
    project.genre ? `类型：${project.genre}` : '',
    project.synopsis ? `一句话简介：${project.synopsis}` : '',
    '',
    '## 大纲结构',
    buildOutlineText(projectId),
    '',
    '## 角色档案',
    buildCharacterText(projectId),
    '',
    '## 故事线',
    buildLineText(projectId),
    '',
    '## 章节',
    buildChapterText(projectId),
    '',
    '## 世界设定',
    buildWorldText(projectId),
    '',
    '## 伏笔',
    buildForeshadowText(projectId),
    '',
    '## 创作备忘',
    buildNoteText(projectId),
    '',
    '## 外部素材（从其他平台导入的对话）',
    buildMaterialText(projectId)
  ].filter(Boolean);

  // 作者正打开的那一章，全文直接进上下文——这是最可能被讨论的内容
  if (currentChapterId) {
    const ch = store.find('chapters', currentChapterId);
    if (ch && ch.projectId === projectId) {
      const text = ch.content || '';
      parts.push('', `## 作者当前打开的章节（全文）：${ch.title}`,
        `（${text.length} 字）`, text || '（本章暂无正文）');
    }
  }

  return { project, text: parts.join('\n') };
}

// ---------------------------------------------------------------- 工具定义

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_outline_node',
      description: '在大纲中创建节点（卷/章/场景/节拍）。parentId 留空则创建顶层节点。',
      parameters: {
        type: 'object',
        properties: {
          parentId: { type: 'string', description: '父节点 id，可选' },
          type: { type: 'string', enum: ['act', 'chapter', 'scene', 'beat'], description: '节点类型' },
          title: { type: 'string', description: '标题' },
          summary: { type: 'string', description: '内容梗概，一到三句话' },
          status: { type: 'string', enum: ['idea', 'todo', 'draft', 'done'], description: '状态' }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_outline_node',
      description: '修改已有大纲节点的标题、梗概或状态。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: '节点 id' },
          title: { type: 'string' },
          summary: { type: 'string' },
          status: { type: 'string', enum: ['idea', 'todo', 'draft', 'done'] }
        },
        required: ['nodeId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_character',
      description: '创建角色卡，写入角色集。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          role: { type: 'string', description: '主角/重要配角/配角/反派/群像等' },
          alias: { type: 'string', description: '别名、称号' },
          age: { type: 'string' },
          appearance: { type: 'string', description: '外貌特征' },
          personality: { type: 'string', description: '性格' },
          motivation: { type: 'string', description: '核心动机与欲望' },
          flaw: { type: 'string', description: '弱点或缺陷' },
          arc: { type: 'string', description: '人物弧光走向' },
          beatNote: { type: 'string', description: '关键转折节点' },
          tags: { type: 'array', items: { type: 'string' } }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_character',
      description: '按 id 更新角色档案字段。',
      parameters: {
        type: 'object',
        properties: {
          characterId: { type: 'string' },
          name: { type: 'string' }, role: { type: 'string' }, alias: { type: 'string' },
          age: { type: 'string' }, appearance: { type: 'string' }, personality: { type: 'string' },
          motivation: { type: 'string' }, flaw: { type: 'string' }, arc: { type: 'string' }, beatNote: { type: 'string' }
        },
        required: ['characterId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_relation',
      description: '建立两个角色之间的关系。',
      parameters: {
        type: 'object',
        properties: {
          fromId: { type: 'string' }, toId: { type: 'string' },
          label: { type: 'string', description: '关系名，如：师徒 / 宿敌 / 暗恋' },
          description: { type: 'string' },
          strength: { type: 'number', description: '紧密程度 1-5' }
        },
        required: ['fromId', 'toId', 'label']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_plot_line',
      description: '创建主线或副线故事线。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          kind: { type: 'string', enum: ['main', 'sub', 'romance', 'mystery', 'growth', 'other'], description: '线路类型' },
          description: { type: 'string', description: '这条线讲什么' },
          color: { type: 'string', description: '十六进制颜色，如 #6b8afd' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_beat',
      description: '在某条故事线上添加节拍（关键情节点）。',
      parameters: {
        type: 'object',
        properties: {
          lineId: { type: 'string', description: '所属故事线 id' },
          title: { type: 'string' },
          description: { type: 'string' },
          nodeId: { type: 'string', description: '可关联的大纲节点 id，可选' },
          status: { type: 'string', enum: ['idea', 'planned', 'done'] }
        },
        required: ['lineId', 'title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_chapter',
      description: '创建章节条目，可空内容占位。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          nodeId: { type: 'string', description: '关联的大纲节点 id，可选' }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_foreshadow',
      description: '登记一处伏笔，便于后续回收。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '伏笔内容' },
          payoffHint: { type: 'string', description: '回收设想' },
          plantedChapter: { type: 'string', description: '埋设位置，可选' }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_note',
      description: '记录创作备忘、灵感或待解决问题，长期保存在项目里。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
          category: { type: 'string', enum: ['灵感', '备忘', '待解决', '设定'] }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_world_item',
      description: '补充世界观设定条目。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          category: { type: 'string', enum: ['地理', '历史', '规则', '势力', '物品', '习俗', '种族', '其他'] },
          content: { type: 'string' }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_material',
      description: '读取某段外部素材（导入的对话）的完整内容。上下文里只带素材索引与预览，需要细读时用这个工具取全文。',
      parameters: {
        type: 'object',
        properties: {
          materialId: { type: 'string', description: '素材 id' },
          limit: { type: 'number', description: '最多返回多少字符，默认 20000' }
        },
        required: ['materialId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_chapter',
      description: '读取某一章的完整正文。上下文里章节只有标题和开头 60 字，分析剧情、续写、改稿前必须先用这个工具读原文，不要凭标题臆测内容。',
      parameters: {
        type: 'object',
        properties: {
          chapterId: { type: 'string', description: '章节 id（上下文章节列表里的 ⟦id:xxx⟧）' },
          title: { type: 'string', description: '章节标题（模糊匹配，如「不愧是我的主子」）' },
          index: { type: 'number', description: '第几章（按顺序，从 1 开始）' },
          limit: { type: 'number', description: '最多返回多少字符，默认 24000' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_project_context',
      description: '重新拉取当前项目的完整上下文（大纲、角色、线路、设定等），在信息不足时调用。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: '思考与操作全部完成，输出给作者的总结。必须最后调用一次。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '面向作者的结论与建议，支持 Markdown' }
        },
        required: ['summary']
      }
    }
  }
];

// ---------------------------------------------------------------- 工具执行

function makeExecutor(projectId, ops) {
  const push = (action, label) => ops.push({ action, label, at: Date.now() });

  return {
    create_outline_node(a = {}) {
      const list = a.parentId
        ? store.where('outline', (n) => n.parentId === a.parentId)
        : store.where('outline', (n) => n.projectId === projectId && !n.parentId);
      const node = store.insert('outline', {
        projectId,
        parentId: a.parentId || null,
        type: a.type || 'chapter',
        title: a.title,
        summary: a.summary || '',
        status: a.status || 'idea',
        order: store.nextOrder(list)
      });
      push('create_outline_node', `大纲节点「${node.title}」`);
      return { ok: true, id: node.id, message: `已创建大纲节点「${node.title}」` };
    },

    update_outline_node(a = {}) {
      const patch = {};
      ['title', 'summary', 'status'].forEach((k) => { if (a[k] != null) patch[k] = a[k]; });
      const node = store.update('outline', a.nodeId, patch);
      if (!node) return { ok: false, message: '找不到该大纲节点' };
      push('update_outline_node', `更新大纲「${node.title}」`);
      return { ok: true, message: `已更新大纲节点「${node.title}」` };
    },

    create_character(a = {}) {
      const c = store.insert('characters', {
        projectId,
        name: a.name,
        role: a.role || '配角',
        alias: a.alias || '',
        age: a.age || '',
        appearance: a.appearance || '',
        personality: a.personality || '',
        motivation: a.motivation || '',
        flaw: a.flaw || '',
        arc: a.arc || '',
        beatNote: a.beatNote || '',
        tags: a.tags || [],
        color: pickColor(a.name),
        order: store.nextOrder(store.byProject('characters', projectId))
      });
      push('create_character', `角色「${c.name}」`);
      return { ok: true, id: c.id, message: `已创建角色「${c.name}」` };
    },

    update_character(a = {}) {
      const { characterId, ...rest } = a;
      const patch = {};
      Object.keys(rest).forEach((k) => { if (rest[k] != null) patch[k] = rest[k]; });
      const c = store.update('characters', characterId, patch);
      if (!c) return { ok: false, message: '找不到该角色' };
      push('update_character', `更新角色「${c.name}」`);
      return { ok: true, message: `已更新角色「${c.name}」` };
    },

    create_relation(a = {}) {
      const exists = store.find('characters', a.fromId) && store.find('characters', a.toId);
      if (!exists) return { ok: false, message: '角色 id 无效' };
      const r = store.insert('relations', {
        projectId, fromId: a.fromId, toId: a.toId,
        label: a.label, description: a.description || '', strength: a.strength || 3
      });
      const from = store.find('characters', a.fromId);
      const to = store.find('characters', a.toId);
      push('create_relation', `关系「${from.name} → ${to.name}：${a.label}」`);
      return { ok: true, id: r.id, message: `已建立关系「${from.name} → ${to.name}：${a.label}」` };
    },

    create_plot_line(a = {}) {
      const l = store.insert('lines', {
        projectId,
        name: a.name,
        kind: a.kind || 'sub',
        description: a.description || '',
        color: a.color || pickColor(a.name),
        status: 'active',
        order: store.nextOrder(store.byProject('lines', projectId))
      });
      push('create_plot_line', `故事线「${l.name}」`);
      return { ok: true, id: l.id, message: `已创建故事线「${l.name}」` };
    },

    create_beat(a = {}) {
      if (!store.find('lines', a.lineId)) return { ok: false, message: '找不到该故事线' };
      const b = store.insert('beats', {
        projectId,
        lineId: a.lineId,
        title: a.title,
        description: a.description || '',
        nodeId: a.nodeId || null,
        status: a.status || 'planned',
        order: store.nextOrder(store.byProject('beats', projectId, { lineId: a.lineId }))
      });
      push('create_beat', `节拍「${b.title}」`);
      return { ok: true, id: b.id, message: `已添加节拍「${b.title}」` };
    },

    create_chapter(a = {}) {
      const ch = store.insert('chapters', {
        projectId,
        title: a.title,
        summary: a.summary || '',
        content: '',
        nodeId: a.nodeId || null,
        status: 'todo',
        order: store.nextOrder(store.byProject('chapters', projectId))
      });
      push('create_chapter', `章节「${ch.title}」`);
      return { ok: true, id: ch.id, message: `已创建章节「${ch.title}」` };
    },

    add_foreshadow(a = {}) {
      const f = store.insert('foreshadow', {
        projectId,
        title: a.title,
        payoffHint: a.payoffHint || '',
        plantedChapter: a.plantedChapter || '',
        status: 'planted',
        order: store.nextOrder(store.byProject('foreshadow', projectId))
      });
      push('add_foreshadow', `伏笔「${f.title}」`);
      return { ok: true, id: f.id, message: `已登记伏笔「${f.title}」` };
    },

    add_note(a = {}) {
      const n = store.insert('notes', {
        projectId,
        title: a.title,
        content: a.content || '',
        category: a.category || '备忘',
        pinned: false,
        order: store.nextOrder(store.byProject('notes', projectId))
      });
      push('add_note', `备忘「${n.title}」`);
      return { ok: true, id: n.id, message: `已记录备忘「${n.title}」` };
    },

    add_world_item(a = {}) {
      const w = store.insert('world', {
        projectId,
        title: a.title,
        category: a.category || '其他',
        content: a.content || '',
        order: store.nextOrder(store.byProject('world', projectId))
      });
      push('add_world_item', `设定「${w.title}」`);
      return { ok: true, id: w.id, message: `已补充设定「${w.title}」` };
    },

    read_material(a = {}) {
      const m = store.find('materials', a.materialId);
      if (!m) return { ok: false, message: '找不到该素材' };
      const limit = a.limit || 20000;
      const text = m.content || '';
      return {
        ok: true,
        title: m.title,
        source: m.source || '',
        truncated: text.length > limit,
        content: text.slice(0, limit)
      };
    },

    read_chapter(a = {}) {
      const chapters = store.byProject('chapters', projectId)
        .slice()
        .sort((x, y) => (x.order || 0) - (y.order || 0));
      let ch = null;
      if (a.chapterId) ch = chapters.find((c) => c.id === a.chapterId) || null;
      if (!ch && a.title) {
        const key = String(a.title).trim();
        ch = chapters.find((c) => (c.title || '').trim() === key)
          || chapters.find((c) => (c.title || '').includes(key))
          || null;
      }
      if (!ch && a.index) ch = chapters[Number(a.index) - 1] || null;
      if (!ch) return { ok: false, message: '找不到章节。可传 chapterId、title（标题模糊匹配）或 index（第几章）' };
      const limit = a.limit || 24000;
      const text = ch.content || '';
      return {
        ok: true,
        id: ch.id,
        title: ch.title,
        summary: ch.summary || '',
        words: text.length,
        truncated: text.length > limit,
        content: text.slice(0, limit)
      };
    },

    get_project_context() {
      return { ok: true, context: buildContext(projectId).text };
    },

    finish(a = {}) {
      return { ok: true, __finish: true, summary: a.summary || '' };
    }
  };
}

const PALETTE = ['#6b8afd', '#8b5cf6', '#ec4899', '#f97316', '#10b981', '#06b6d4', '#f59e0b', '#ef4444', '#14b8a6', '#6366f1'];
function pickColor(seed = '') {
  let sum = 0;
  for (let i = 0; i < seed.length; i++) sum += seed.charCodeAt(i);
  return PALETTE[sum % PALETTE.length];
}

function parseArgs(raw) {
  if (typeof raw === 'object' && raw !== null) return raw;
  try { return JSON.parse(raw || '{}'); } catch (_) { return {}; }
}

// ---------------------------------------------------------------- 系统提示

function systemPrompt(projectId, useTools, currentChapterId) {
  const extra = settings().agentPersona;
  return [
    '你是一位资深小说策划编辑，协助作者完成长篇小说的构思、架构与落地。',
    '你的工作对象是作者项目里的真实数据——你会通过工具直接读写它，而不是只在嘴巴上建议。',
    '',
    '## 当前项目上下文',
    buildContext(projectId, currentChapterId).text,
    '',
    '## 行为准则',
    '1. 需要了解现状时先调用 get_project_context；上下文里已经带过完整数据，除非创建后需要校验，否则不要重复调用。',
    '2. 上下文里章节只有标题和开头 60 字。凡是涉及某一章的剧情细节、续写、改稿、找逻辑漏洞，必须先调用 read_chapter 读那章的原文，再开口。作者正打开的那一章全文已经直接给你了。',
    '3. 涉及新增或修改（角色、大纲、线路、节拍、伏笔、设定、章节）时，务必调用对应工具真正写入，"只说不做"是不可接受的。',
    '4. 每创造一条数据前先自查是否与既有设定冲突；发现矛盾要明确指出。',
    '5. 回答要具体、有判断力，敢于给出取舍建议；不要罗列一堆正确但没用的空话。',
    '6. 不要一次性塞太多内容——优先给出最有价值的骨架，作者确认后再展开。',
    '7. 「外部素材」是从其他平台导入的历史对话，可能是未经整理的原始想法。需要引用时先调用 read_material 读取全文，不要凭索引里的预览臆测内容。',
    '8. 从素材里提炼内容时，要转化为本项目结构化的大纲/角色/线路/设定，而不是照抄原话。',
    useTools ? '9. 全部操作完成后调用 finish，输出给作者的总结。' : '9. 完成后用 ACTION 之外的方式输出纯文本总结。',
    extra ? `\n## 作者额外要求\n${extra}` : ''
  ].filter(Boolean).join('\n');
}

const TEXT_PROTOCOL_HINT = [
  '',
  '【重要】当前接口不支持函数调用，你必须用文本协议下达操作：',
  '每次只输出一个操作块或最终总结，格式如下：',
  '```json',
  '{"tool":"工具名","args":{...}}',
  '```',
  '可用工具名（共 14 个，全部会被系统真正执行并把结果回传给你）：',
  'create_outline_node / update_outline_node / create_character / update_character / create_relation / create_plot_line / create_beat / create_chapter / add_foreshadow / add_note / add_world_item / read_chapter / read_material / get_project_context',
  '',
  '特别说明：read_chapter 是真的能拿到章节正文的——你发出 {"tool":"read_chapter","args":{"title":"某章"}} 后，系统会执行它，并把那一章的全文作为下一条消息回传给你，你就能基于原文继续分析。上下文里只有标题和开头 60 字，所以涉及正文必须先发 read_chapter。',
  '操作全部完毕后，直接输出纯文本总结（不要再出现 json 块）。'
].join('\n');

// ---------------------------------------------------------------- 主循环

function extractActions(text = '') {
  const blocks = [];
  const re = /```(?:json)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && obj.tool) blocks.push(obj);
    } catch (_) { /* 不是合法 JSON，忽略 */ }
  }
  return blocks;
}

async function runAgent({ projectId, message, history = [], chapterId = null }) {
  const ops = [];
  const project = store.getProject(projectId);
  if (!project) throw new Error('项目不存在');

  if (!llmEnabled()) return demoReply(projectId, message, ops);

  const exec = makeExecutor(projectId, ops);
  let useTools = true;
  let finishSummary = '';
  let finalText = '';
  const messages = [
    { role: 'system', content: systemPrompt(projectId, true, chapterId) + TEXT_PROTOCOL_HINT },
    ...history.slice(-12).map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: message }
  ];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let json;
    try {
      json = await callChat({ messages, tools: useTools ? TOOLS : null });
    } catch (err) {
      if (useTools && /tool|工具|400|不支持/i.test(err.message)) {
        useTools = false;
        messages.push({
          role: 'system',
          content: '函数调用不可用，切换到文本协议：每次只输出一个 ```json {"tool":...,"args":{...}}``` 块，或直接输出总结文本。'
        });
        continue;
      }
      throw err;
    }

    const assistant = json?.choices?.[0]?.message || {};
    const toolCalls = assistant.tool_calls || [];

    if (toolCalls.length) {
      messages.push({
        role: 'assistant',
        content: assistant.content || '',
        tool_calls: toolCalls
      });
      let finished = false;
      for (const tc of toolCalls) {
        const name = tc.function?.name;
        const args = parseArgs(tc.function?.arguments);
        let result;
        try {
          result = exec[name] ? exec[name](args) : { ok: false, message: `未知工具 ${name}` };
        } catch (err) {
          result = { ok: false, message: `执行失败：${err.message}` };
        }
        if (result && result.__finish) finishSummary = result.summary;
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name,
          content: JSON.stringify(result)
        });
      }
      if (finished) break;
      continue;
    }

    const content = assistant.content || '';
    messages.push({ role: 'assistant', content });

    if (!useTools) {
      const actions = extractActions(content);
      if (actions.length) {
        const results = actions.map((a) => {
          try {
            return exec[a.tool] ? exec[a.tool](a.args || {}) : { ok: false, message: `未知工具 ${a.tool}` };
          } catch (err) {
            return { ok: false, message: `执行失败：${err.message}` };
          }
        });
        messages.push({ role: 'user', content: `执行结果：\n${results.map((r) => JSON.stringify(r)).join('\n')}\n请继续，或输出总结。` });
        continue;
      }
    }

    finalText = content;
    break;
  }

  return {
    reply: finishSummary || finalText || '（模型未完成输出，请再试一次）',
    ops,
    demo: false
  };
}

// ---------------------------------------------------------------- 结构化生成

async function generateJSON(prompt, { maxTokens = 3000, temperature = 0.9 } = {}) {
  const json = await callChat({
    messages: [
      { role: 'system', content: '你输出的内容必须是可以被 JSON.parse 直接解析的纯 JSON，不要包含解释文字、不要包裹 ``` 代码块。' },
      { role: 'user', content: prompt }
    ],
    temperature,
    maxTokens
  });
  const text = json?.choices?.[0]?.message?.content || '';
  return parseLooseJSON(text);
}

function parseLooseJSON(text) {
  const cleaned = String(text).replace(/```(?:json)?/g, '').trim();
  try { return JSON.parse(cleaned); } catch (_) { /* 继续尝试截取 */ }
  const startArr = cleaned.indexOf('[');
  const startObj = cleaned.indexOf('{');
  const start = [startArr, startObj].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (start == null) throw new Error(`模型未返回合法 JSON：${cleaned.slice(0, 200)}`);
  const endArr = cleaned.lastIndexOf(']');
  const endObj = cleaned.lastIndexOf('}');
  const end = Math.max(endArr, endObj);
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (_) {
    throw new Error(`JSON 解析失败：${cleaned.slice(0, 200)}`);
  }
}

/** 统一的多形态生成入口 */
async function generate({ projectId, kind, params = {} }) {
  const ctx = buildContext(projectId);
  const p = ctx.project;
  const intro = `作品：《${p.title}》${p.genre ? `｜类型：${p.genre}` : ''}\n简介：${p.synopsis || '（暂无）'}\n`;

  if (!llmEnabled()) return demoGenerate(projectId, kind, params);

  if (kind === 'outline') {
    const anchor = params.parentId ? store.find('outline', params.parentId) : null;
    const data = await generateJSON([
      intro,
      '\n已有大纲：\n', buildOutlineText(projectId),
      anchor ? `\n请在「${anchor.title}」下继续扩展。` : '\n请在合适的位置继续扩展。',
      params.guidance ? `\n作者要求：${params.guidance}` : '',
      `\n生成 ${params.count || 3} 个大纲节点，按叙事顺序排列。`,
      'JSON 格式：{"nodes":[{"type":"act|chapter|scene|beat","title":"","summary":"三句话以内，要有画面感和冲突"}]}'
    ].join('\n'));
    return { kind, data: (data.nodes || []).slice(0, 12) };
  }

  if (kind === 'character') {
    const data = await generateJSON([
      intro,
      '\n已有角色：\n', buildCharacterText(projectId),
      `\n作者要求：${params.guidance || '补全缺失的重要角色'}`,
      `\n生成 ${params.count || 2} 个角色档案，避免与已有角色重复或撞名。`,
      'JSON 格式：{"characters":[{"name":"","role":"","alias":"","age":"","appearance":"","personality":"","motivation":"","flaw":"","arc":"","beatNote":""}]}',
      '\n要求：每个角色要有清晰动机与内在矛盾，不要脸谱化。'
    ].join('\n'));
    return { kind, data: (data.characters || []).slice(0, 8) };
  }

  if (kind === 'plot') {
    const data = await generateJSON([
      intro,
      '\n已有大纲：\n', buildOutlineText(projectId),
      '\n已有角色：\n', buildCharacterText(projectId),
      '\n已有故事线：\n', buildLineText(projectId),
      `\n作者要求：${params.guidance || '梳理主线与重要副线'}`,
      '\n梳理出 1 条主线 + 1~3 条副线，每条给出 3~6 个递进节拍。',
      'JSON 格式：{"lines":[{"name":"","kind":"main|sub|romance|mystery|growth","description":"","beats":[{"title":"","description":""}]}]}'
    ].join('\n'));
    return { kind, data: data.lines || [] };
  }

  if (kind === 'world') {
    const data = await generateJSON([
      intro,
      '\n已有设定：\n', buildWorldText(projectId),
      `\n方向：${params.guidance || '补全这个世界最关键的设定'}`,
      `\n生成 ${params.count || 4} 条设定。`,
      'JSON 格式：{"items":[{"category":"地理|历史|规则|势力|物品|习俗|种族|其他","title":"","content":""}]}'
    ].join('\n'));
    return { kind, data: data.items || [] };
  }

  if (kind === 'brainstorm') {
    const data = await generateJSON([
      intro,
      '\n上下文：\n', buildContext(projectId).text.slice(0, 4000),
      `\n脑暴问题：${params.topic || '给出下一个阶段的创作建议'}`,
      `\n给出 ${params.count || 3} 个有执行价值的具体方案，每个含标题、展开说明与风险提示。`,
      'JSON 格式：{"ideas":[{"title":"","detail":"","risk":""}]}'
    ].join('\n'));
    return { kind, data: data.ideas || [] };
  }

  if (kind === 'audit') {
    const data = await generateJSON([
      intro,
      '\n完整上下文：\n', buildContext(projectId).text,
      '\n请做一次创作体检，找出设定矛盾、人物动机薄弱、线索断裂、节奏失衡等问题。',
      'JSON 格式：{"issues":[{"level":"high|mid|low","area":"人物|剧情|设定|节奏|线索","title":"","detail":"","fix":""}]}'
    ].join('\n'), { temperature: 0.5 });
    return { kind, data: data.issues || [] };
  }

  throw new Error(`未知的生成类型：${kind}`);
}

/**
 * 解析一部小说：从开头正文 + 章节目录中推断书名、类型、简介，并抽取核心角色、叙事阶段与世界观。
 * 未配置模型时返回 null（由导入流程退化为「仅分章入库」）。
 * @returns {Promise<object|null>}
 */
async function analyzeNovel({ titleHint, genreHint, sample, titles }) {
  if (!llmEnabled()) return null;
  const titlesText = (titles || [])
    .filter(Boolean)
    .slice(0, 220)
    .map((t, i) => `${i + 1}. ${t}`)
    .join('\n');
  const prompt = [
    '你是一位资深小说编辑。请基于下面这部小说的开头正文与章节目录，分析并抽取结构化档案，用于建立作品库。',
    '要求：只输出 JSON，不要解释文字；推断要保守，拿不准的字段填空字符串；角色取最核心的 3-8 个，避免路人甲。',
    '',
    `书名提示：${titleHint || '(未知，请据内容推断)'}`,
    genreHint ? `类型提示：${genreHint}` : '',
    '',
    '【开头正文与中段节选】',
    sample,
    '',
    `【章节目录（共 ${titles.length} 章）】`,
    titlesText || '(无分章标记)',
    '',
    '输出 JSON 结构：',
    '{"title":"书名","genre":"题材类型(如 东方玄幻/都市/悬疑/言情/科幻)","synopsis":"一句话故事梗概(20-40字)","characters":[{"name":"","role":"主角/重要配角/反派/群像","appearance":"","personality":"","motivation":""}],"outline":[{"title":"叙事阶段名","summary":"一句话","type":"act"}],"world":[{"category":"地理|势力|规则|习俗|其他","title":"","content":""}]}'
  ].filter(Boolean).join('\n');

  try {
    const data = await generateJSON(prompt, { maxTokens: 2600, temperature: 0.35 });
    return (data && (data.title || data.characters || data.synopsis)) ? data : null;
  } catch (err) {
    console.warn('[novel] AI 分析失败：', err.message);
    return null;
  }
}

/** AI 续写章节 */
async function continueChapter({ projectId, chapterId, instruction = '', words = 600 }) {
  const chapter = store.find('chapters', chapterId);
  if (!chapter) throw new Error('章节不存在');
  const ctx = buildContext(projectId);
  const p = ctx.project;

  if (!llmEnabled()) {
    return { text: demoContinue(p, chapter, instruction), demo: true };
  }

  const tail = (chapter.content || '').slice(-1200);
  const json = await callChat({
    messages: [
      {
        role: 'system',
        content: [
          `你正在为《${p.title}》续写正文。`,
          p.genre ? `类型：${p.genre}` : '',
          '要求：保持既有文风与人称，衔接上文不重复剧情，推进而不是原地打转，重视感官细节与人物内在反应。',
          '只输出正文，不要解释、不要标注、不要出现标题行。'
        ].filter(Boolean).join('\n')
      },
      {
        role: 'user',
        content: [
          `本章标题：${chapter.title}`,
          chapter.summary ? `本章要点：${chapter.summary}` : '',
          '\n【上文结尾】\n', tail || '（本章刚开始）',
          '\n【故事上下文】\n', buildOutlineText(projectId).slice(0, 2000),
          '\n【相关角色】\n', buildCharacterText(projectId).slice(0, 2000),
          instruction ? `\n【作者指令】${instruction}` : '',
          `\n请续写约 ${words} 字。`
        ].filter(Boolean).join('\n')
      }
    ],
    maxTokens: Math.min(4096, Math.round(words * 2.2) + 400)
  });
  return { text: json?.choices?.[0]?.message?.content || '', demo: false };
}

// ---------------------------------------------------------------- 演示模式

function demoReply(projectId, message, ops) {
  const exec = makeExecutor(projectId, ops);
  const text = String(message || '');
  const project = store.getProject(projectId) || { title: '未命名' };
  let reply = '';

  if (/角色|人设|人物/.test(text)) {
    const c = exec.create_character({
      name: pickName(project.title),
      role: '重要配角',
      appearance: '身形瘦削，左眉一道浅疤，习惯把袖口挽到手肘。',
      personality: '表面温和有礼，实则极度记仇，善于等待。',
      motivation: '想把某件旧事彻底了结，为此不惜借刀杀人。',
      flaw: '过度自信于自己的耐心，常常错过最佳时机。',
      arc: '从隐忍的旁观者走向主动掀桌的人。',
      beatNote: '中段背叛主角，后段为自保再次倒戈。'
    });
    reply = [
      `（演示模式）已为《${project.title}》补出一张角色卡：`,
      '',
      `- **${c.message.replace('已创建角色', '')}**`,
      '- 定位：重要配角',
      '- 核心冲突：他想要的"了结"与主角的目标正面相撞，且他习惯用等待代替行动 —— 这会让他在中段自动制造危机。',
      '',
      '提示：这是未配置模型时的占位内容。到「设置 → 模型」填入 API Key 后，助手会基于你真实的大纲与角色来构思。'
    ].join('\n');
  } else if (/大纲|剧情|情节|续写，.*下一章/.test(text)) {
    const list = store.where('outline', (n) => n.projectId === projectId && !n.parentId);
    const root = exec.create_outline_node({
      type: 'act',
      title: `第二幕 · ${project.title || '故事'}的代价`,
      summary: '主角为达成第一个目标付出真实代价，旧的解决方案失效，被迫换一条更危险的路。'
    });
    reply = [
      `（演示模式）已追加大纲节点 **${list.length + 1}**：`,
      '',
      `- ${root.message.replace('已创建大纲节点', '')}`,
      '- 设计理由：第一幕建立常态与欲望后，需要一个「代价事件」让主角无法回头，同时为副线提供交汇点。',
      '',
      '提示：填入 API Key 后会按你已有的大纲结构续写，而不是套模板。'
    ].join('\n');
  } else if (/线路|主线|副线/.test(text)) {
    const l = exec.create_plot_line({ name: `${project.title}·暗线`, kind: 'sub', description: '贯穿全书但始终未被主角察觉的幕后行动。' });
    exec.create_beat({ lineId: l.id, title: '第一次异常信号', description: '某个无关紧要的细节出现偏差。' });
    exec.create_beat({ lineId: l.id, title: '线索半遮半露', description: '主角得到答案的一半，并得出了错误结论。' });
    reply = `（演示模式）已创建副线「${project.title}·暗线」并铺设 2 个节拍。\n\n填入 API Key 后，助手会按真实主线脉络把副线的交汇点安排到具体章节。`;
  } else {
    reply = [
      `（演示模式）我理解你想要：${trunc(text, 40)}`,
      '',
      '当前尚未配置模型，助手无法真正参与思考。请到右上角「设置 → 模型」填写：',
      '- 接口地址（OpenAI 兼容，例如 https://api.deepseek.com/v1）',
      '- API Key',
      '- 模型名（例如 deepseek-chat）',
      '',
      '配置完成后，我会读取你项目里的全部大纲、角色与线路，既能给建议，也能直接动手改数据。'
    ].join('\n');
  }

  return { reply, ops, demo: true };
}

function demoGenerate(projectId, kind, params = {}) {
  const project = store.getProject(projectId) || { title: '未命名' };
  if (kind === 'outline') {
    const n = Math.min(8, params.count || 3);
    return {
      kind,
      demo: true,
      data: Array.from({ length: n }, (_, i) => ({
        type: 'chapter',
        title: `第 ${i + 1} 幕 · 待拟定`,
        summary: '（演示内容）此处应写入这一幕的核心事件、转折与人物处境变化。配置模型后将自动生成贴合你故事的内容。'
      }))
    };
  }
  if (kind === 'character') {
    const n = Math.min(6, params.count || 2);
    return {
      kind, demo: true,
      data: Array.from({ length: n }, (_, i) => ({
        name: `${pickName(project.title)}${i ? String(i + 1) : ''}`,
        role: i === 0 ? '主角' : '配角',
        alias: '', age: '',
        appearance: '（演示）待补充外貌特征。',
        personality: '（演示）待补充性格层次。',
        motivation: '（演示）待补充核心动机。',
        flaw: '（演示）待补充内在缺陷。',
        arc: '（演示）待补充弧光。',
        beatNote: ''
      }))
    };
  }
  if (kind === 'plot') {
    return {
      kind, demo: true,
      data: [{
        name: `${project.title}·主线`, kind: 'main',
        description: '（演示）主角的欲望与阻碍构成的推进链条。',
        beats: [
          { title: '失衡事件', description: '常态被打断，主角被迫回应。' },
          { title: '第一次选择', description: '主角做出代价最小的选择，问题暂时解决。' },
          { title: '代价浮现', description: '旧办法失效，代价开始累积。' }
        ]
      }]
    };
  }
  if (kind === 'world') {
    return { kind, demo: true, data: [{ category: '规则', title: '（演示）世界运转的核心规则', content: '待配置模型后生成。' }] };
  }
  if (kind === 'brainstorm') {
    return { kind, demo: true, data: [{ title: '（演示）建议方向', detail: '配置模型后可获得针对性方案。', risk: '' }] };
  }
  if (kind === 'audit') {
    return { kind, demo: true, data: [{ level: 'low', area: '整体', title: '尚未配置模型', detail: '当前的体检结果是占位内容。', fix: '在设置中填写 API Key。' }] };
  }
  return { kind, demo: true, data: [] };
}

function demoContinue(project, chapter, instruction) {
  return [
    '（演示段落，未连接模型）',
    '',
    `他站在${chapter.title || '这一章'}的开端处，风从远处的屋脊上滑下来，带着一点说不清的凉意。`,
    '这正是迟迟没有下笔的原因——真正重要的从来不是接下来发生了什么，而是他愿不愿意承认，自己已经没有退路。',
    instruction ? `（你的指令：${instruction}）` : '',
    '',
    '—— 到「设置 → 模型」填入 API Key 后，这里会输出贴合上文与设定的真实正文。'
  ].filter(Boolean).join('\n');
}

const SURNAME = ['沈', '陆', '苏', '江', '谢', '裴', '温', '顾', '叶', '燕', '贺', '梁'];
const GIVEN = ['砚', '知', '临', '昭', '照', '辞', '渊', '衡', '让', '野', '青', '砚之'];
function pickName(seed = '') {
  let n = 0;
  for (let i = 0; i < seed.length; i++) n += seed.charCodeAt(i);
  return SURNAME[n % SURNAME.length] + GIVEN[(n >> 2) % GIVEN.length];
}

module.exports = {
  settings, llmEnabled, endpointUrl, testConnection, callChat,
  buildContext, buildOutlineText, buildCharacterText, buildLineText,
  runAgent, generate, continueChapter, analyzeNovel, PALETTE, pickColor,
  makeExecutor
};
