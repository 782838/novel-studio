'use strict';
import api from './api.js';
import { esc, md, openModal, openForm, openConfirm, toast } from './ui.js';

export const PRESETS = {
  zhipu_flash: { label: '智谱 GLM-5.3-Flash（推荐）', endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash' },
  zhipu53: { label: '智谱 GLM-5.3', endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3' },
  zhipu_intl: { label: 'Z.ai 国际版', endpoint: 'https://api.z.ai/api/paas/v4', model: 'glm-5.3-flash' },
  zhipu_free: { label: '智谱 GLM-4.7-Flash（长期免费）', endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7-flash' },
  dashscope: { label: '阿里百炼（通义）', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  ark: { label: '火山方舟（豆包）', endpoint: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k' },
  openai: { label: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  ollama: { label: 'Ollama 本地模型', endpoint: 'http://localhost:11434/v1', model: 'qwen2.5:14b' },
  custom: { label: '自定义（兼容 OpenAI）', endpoint: '', model: '' }
};

const QUICK = [
  '帮我梳理主线，并把缺失的关键节拍补齐',
  '检查设定里自相矛盾的地方',
  '主角现在最大的问题是什么？',
  '接下来该写什么，给我一个明确建议',
  '给中段设计一个让读者无法弃书的转折',
  '把还没回收的伏笔整理成清单'
];

export function createAgent(ctx) {
  const root = document.getElementById('agentPanel');
  let built = false;
  let busy = false;
  let ctrl = null;          // 用于「停止」：中断这次请求
  let pendingText = '';
  let pendingStart = 0;
  let pendingTimer = null;
  let live = null;          // 流式中的现场（思考过程 / 正文 / 已执行操作）
  let lastPaint = 0;
  // 「其它 AI 功能」（生成记忆点、续写、生成大纲/角色/线路/设定/脑暴）的执行记录。
  // 这类任务不是对话，不写服务端 messages，只在本机内存里按时间并入对话流显示，
  // 这样点「全部生成」之后会像跟助手对话一样：自动打开面板 → 显示正在做什么 → 末尾汇报条数。
  let tasks = [];
  let taskTimer = null;

  function statusHtml() {
    const configured = ctx.settings.hasKey;
    const label = ctx.settings.activeName || ctx.settings.activeModel || '已就绪';
    return `<span id="aiStatus" class="ai-status ${configured ? 'on' : 'off'}">
      <i></i>${configured ? esc(label) : '演示模式'}
    </span>`;
  }

  const secs = (ms) => (ms / 1000).toFixed(1);

  /**
   * 助手「思考过程」折叠块——实时与历史消息共用。
   * key 用来在整体重绘时按块还原各自的 scrollTop：思考块内部是可滚动区域，
   * 若不给它一个稳定标识，用户一滚动就会被重绘弹回顶部。
   */
  function thinkBlock(thinking, thinkMs, open, key) {
    if (!thinking) return '';
    const attr = key ? ` data-think="${esc(key)}"` : '';
    const id = key === 'live' ? ' id="liveThink"' : '';
    return `<details class="think"${open ? ' open' : ''}>
      <summary>🧠 思考过程${thinkMs ? `（${secs(thinkMs)} 秒）` : ''}</summary>
      <div class="think-body"${attr}${id}>${esc(thinking)}</div>
    </details>`;
  }

  /** 一个 AI 任务的执行卡片：进度条 / 明细 / 结束汇报 */
  function taskHtml(t) {
    const running = t.status === 'running';
    const waited = Math.max(0, Math.round(((t.endedAt || Date.now()) - t.startedAt) / 1000));
    const pct = t.total > 0 ? Math.min(100, Math.round((t.done / t.total) * 100)) : 0;
    const bar = t.total > 0
      ? `<div class="task-bar"><i style="width:${t.status === 'done' ? 100 : pct}%"></i></div>` : '';
    const prog = t.total > 0
      ? `<div class="task-prog">已完成 <b>${t.done}</b> / ${t.total}${t.detail ? ` · ${esc(t.detail)}` : ''}</div>`
      : (t.detail && running ? `<div class="task-prog">${esc(t.detail)}</div>` : '');
    const busy = running
      ? `<div class="live-status"><span class="dot-typing"><i></i><i></i><i></i></span><em>正与模型通信中…模型繁忙会自动重试，不会中途放弃</em></div>` : '';
    const notes = t.notes.length
      ? `<div class="live-notes">${t.notes.map((n) => `<span class="live-note">· ${esc(n)}</span>`).join('')}</div>` : '';
    const items = t.items.length
      ? `<div class="live-ops">${t.items.slice(-14).map((s) => `<span class="live-op">✓ ${esc(s)}</span>`).join('')}</div>` : '';
    let foot;
    if (running) {
      foot = `<div class="task-foot run"><button class="btn ghost xs danger-text" data-task-stop="${t.id}">■ 停止</button>
        <span class="task-wait">已等待 <b data-task-secs="${t.id}">${waited}</b> 秒</span></div>`;
    } else if (t.status === 'done') {
      foot = `<div class="task-foot ok">✅ ${esc(t.summary || `已完成 ${t.done || t.items.length} 项`)}<span class="task-secs">用时 ${waited} 秒</span></div>`;
    } else if (t.status === 'stopped') {
      foot = `<div class="task-foot stopped">⏹ 已停止${t.summary ? ` · ${esc(t.summary)}` : ''}<span class="task-secs">用时 ${waited} 秒</span></div>`;
    } else {
      foot = `<div class="task-foot err">⚠️ ${esc(t.error || '执行失败')}<span class="task-secs">用时 ${waited} 秒</span></div>`;
    }
    return `<div class="bubble assistant task" data-task="${t.id}">
      <div class="bubble-avatar">✦</div>
      <div class="bubble-body">
        <div class="task-head"><span class="task-ico">${t.icon || '🧩'}</span><b>${esc(t.title)}</b></div>
        ${bar}${prog}${busy}${notes}${items}${foot}
      </div>
    </div>`;
  }

  function msgsHtml() {
    const msgs = ctx.data.messages || [];
    // 作者刚发出、服务端还在处理的那条问题——必须立刻显示，否则看起来像"被吞了"
    const mine = pendingText
      ? `<div class="bubble user"><div class="bubble-body plain">${esc(pendingText)}</div>
          <button class="bubble-copy" data-copy-mode="pending" title="复制这条消息">复制</button></div>` : '';
    if (!msgs.length && !pendingText && !live && !tasks.length) {
      return `<div class="agent-welcome">
        <div class="welcome-glyph">✦</div>
        <h4>我能读到你项目里的一切</h4>
        <p>大纲、角色、线路、设定都会进入我的上下文；章节会带标题和开头，你正打开的那一章我会直接读到全文，其它章节你说一声我就能去读。你既可以让我想，也可以让我直接动手改——新建角色、补大纲、铺节拍都行。</p>
      </div>`;
    }
    // 对话消息与「AI 任务执行记录」按时间合并成同一条流——切换任务就像助手在做同一件事
    const timeline = msgs.map((m, i) => ({ at: m.createdAt || 0, html: () => bubble(m, i) }));
    tasks.forEach((t) => timeline.push({ at: t.startedAt || 0, html: () => taskHtml(t) }));
    timeline.sort((a, b) => a.at - b.at);
    return timeline.map((x) => x.html()).join('') + mine + liveHtml();
  }

  function liveHtml() {
    if (!live) return '';
    const waited = Math.round((Date.now() - live.startedAt) / 1000);
    const ops = live.ops.length
      ? `<div class="live-ops" id="liveOps">${live.ops.map((o) => `<span class="live-op">✓ ${esc(o.label || o.action)}</span>`).join('')}</div>`
      : '';
    const notes = live.notes.length
      ? `<div class="live-notes">${live.notes.map((n) => `<span class="live-note">· ${esc(n)}</span>`).join('')}</div>`
      : '';
    const answer = live.answer ? `<div class="live-answer" id="liveAnswer">${esc(live.answer)}</div>` : '';
    const idle = !live.thinking && !live.answer && !live.notes.length;
    const copy = live.answer
      ? `<button class="bubble-copy" data-copy-mode="live" title="复制正在生成的回答">复制</button>` : '';
    return `<div class="bubble assistant">
      <div class="bubble-avatar">✦</div>
      <div class="bubble-body">
        ${thinkBlock(live.thinking, live.thinkMs, true, 'live')}
        ${idle ? `<div class="live-status"><span class="dot-typing"><i></i><i></i><i></i></span><em>正在读取项目数据并思考…</em></div>` : ''}
        ${notes}
        ${ops}
        ${answer}
        <div class="live-foot"><span class="dot-typing sm"><i></i><i></i><i></i></span>已等待 <b id="liveWaited">${waited}</b> 秒 · 可随时点「停止」
        </div>
      </div>
      ${copy}
    </div>`;
  }

  function bubble(m, idx) {
    const mine = m.role === 'user';
    const copy = `<button class="bubble-copy" data-copy-mode="msg" data-idx="${idx}" title="复制这条消息${mine ? '' : '（Ctrl+Shift+C 复制最后一条回答）'}">复制</button>`;
    if (mine) return `<div class="bubble user"><div class="bubble-body plain">${esc(m.content)}</div>${copy}</div>`;
    const meta = [];
    if (m.thinkMs) meta.push(`思考 ${secs(m.thinkMs)} 秒`);
    if (m.latency) meta.push(`用时 ${secs(m.latency)} 秒`);
    return `<div class="bubble assistant">
      <div class="bubble-avatar">✦</div>
      <div class="bubble-body">
        ${thinkBlock(m.thinking, m.thinkMs, false, `m${idx}`)}
        ${md(m.content)}${opsHtml(m.ops)}
        ${meta.length ? `<div class="bubble-meta">${meta.join(' · ')}</div>` : ''}
      </div>
      ${copy}
    </div>`;
  }

  function opsHtml(ops) {
    if (!ops || !ops.length) return '';
    return `<details class="ops"><summary>已执行 ${ops.length} 项操作</summary>
      <ul>${ops.map((o) => `<li><span class="op-dot"></span>${esc(o.label || o.action)}</li>`).join('')}</ul>
    </details>`;
  }

  /** 复制文本：优先 Clipboard API，失败退回临时 textarea（局域网 http 打开时也可用） */
  async function copyText(text) {
    const val = String(text || '');
    if (!val.trim()) return false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(val);
        return true;
      }
    } catch (_) { /* 落到下面的兜底 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = val;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-2000px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, val.length);
      const done = document.execCommand('copy');
      ta.remove();
      return done;
    } catch (_) { return false; }
  }

  /** 复制并给出反馈：按钮闪一下 ✓，同时 toast 说明复制了什么 */
  async function doCopy(text, btn, label) {
    const ok = await copyText(text);
    if (ok && btn) {
      btn.classList.add('done');
      btn.textContent = '已复制';
      setTimeout(() => { btn.classList.remove('done'); btn.textContent = '复制'; }, 1400);
    }
    toast(ok ? `${label}已复制` : '复制失败，请手动选中后按 Ctrl+C', ok ? 'success' : 'error', 1600);
    return ok;
  }

  /** 取消息原文（复制的是 Markdown 原文，不是渲染后的 HTML） */
  function textOf(btn) {
    const mode = btn.dataset.copyMode;
    if (mode === 'live') return live ? live.answer : '';
    if (mode === 'pending') return pendingText;
    const m = (ctx.data.messages || [])[Number(btn.dataset.idx)];
    return m ? m.content : '';
  }

  /** Ctrl / Cmd + Shift + C：复制最后一条回答 */
  function copyLastReply() {
    if (live && live.answer) {
      const btn = root.querySelector('[data-copy-mode="live"]');
      return doCopy(live.answer, btn, '正在生成的回答');
    }
    const list = (ctx.data.messages || []).filter((m) => m.role === 'assistant');
    if (!list.length) return toast('还没有助手的回答可以复制', 'info');
    const last = list[list.length - 1];
    const bubbles = root.querySelectorAll('#agentMsgs .bubble.assistant .bubble-copy');
    return doCopy(last.content, bubbles[bubbles.length - 1], '助手回答');
  }

  function onShortcut(e) {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
    if (String(e.key || '').toLowerCase() !== 'c') return;
    const panel = document.getElementById('agentPanel');
    if (!panel || !panel.classList.contains('open')) return;
    e.preventDefault();
    copyLastReply();
  }

  function build() {
    built = true;
    root.innerHTML = `
      <div class="agent-head">
        <div>
          <b>AI 助手</b>
          ${'<span id="aiStatus"></span>'}
        </div>
        <div class="agent-head-acts">
          <button class="icon-btn" data-act="clear" title="清空对话">🗑</button>
          <button class="icon-btn" data-act="settings" title="模型设置">⚙</button>
          <button class="icon-btn" data-act="close" title="收起面板">›</button>
        </div>
      </div>
      <div class="agent-msgs" id="agentMsgs"></div>
      <div class="agent-quick" id="agentQuick">
        ${QUICK.map((q) => `<button class="quick-chip" data-q="${esc(q)}">${esc(q)}</button>`).join('')}
      </div>
      <div class="agent-input">
        <textarea id="agentInput" rows="2" placeholder="让我帮你什么？Enter 发送，Shift + Enter 换行"></textarea>
        <button class="btn primary sm" id="agentSend">发送</button>
      </div>`;

    root.querySelectorAll('.quick-chip').forEach((b) => b.addEventListener('click', () => send(b.dataset.q)));
    // 一个按钮两副面孔：空闲时「发送」，回答中变「停止」
    root.querySelector('#agentSend').addEventListener('click', () => {
      if (busy) return stop();
      const el = root.querySelector('#agentInput');
      send(el.value);
      el.value = '';
    });
    root.querySelector('#agentInput').addEventListener('keydown', (e) => {
      // 纯 Enter 发送；Shift+Enter 换行；isComposing 时（中文输入法选词）不拦截，避免误发
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (busy) return toast('助手正在回答，可先点「停止」再发下一条', 'info');
        send(e.target.value);
        e.target.value = '';
      }
    });
    root.querySelector('[data-act="close"]').addEventListener('click', () => ctx.toggleAgent(false));
    root.querySelector('[data-act="settings"]').addEventListener('click', () => openSettings(ctx));
    root.querySelector('[data-act="clear"]').addEventListener('click', async () => {
      const sure = await openConfirm({ title: '清空对话', message: '将清除本项目与助手的全部历史对话（不影响已写入的数据）。', danger: true, okText: '清空' });
      if (!sure) return;
      await api.clearMessages(ctx.projectId);
      await ctx.reload();
      toast('已清空', 'success');
    });
    document.addEventListener('keydown', onShortcut);
  }

  /** 按钮在「发送 / 停止」之间切换 */
  function syncSend() {
    const btn = root.querySelector('#agentSend');
    if (!btn) return;
    btn.textContent = busy ? '■ 停止' : '发送';
    btn.className = `btn sm ${busy ? 'danger' : 'primary'}`;
    btn.title = busy ? '停止这次回答' : '发送（Enter）';
    btn.disabled = false;   // 一度点过「停止」的话，这里要把它解回来，否则之后再发不出去
  }

  function paint() {
    if (!built) build();
    const st = root.querySelector('#aiStatus');
    if (st) st.outerHTML = statusHtml();
    const box = root.querySelector('#agentMsgs');
    // 重绘会重建 #agentMsgs 的整个 DOM，内部滚动位置随之归零——
    // 用户读「思考过程」或往上翻历史时，就表现为"一滚动就被弹回顶部"。
    // 这里在重绘前记下主列表与每个思考块（按 data-think 键）的 scrollTop，重绘后还原。
    const prevTop = box.scrollTop;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    const savedThink = {};
    const savedOpen = new Set();
    box.querySelectorAll('.think-body[data-think]').forEach((el) => {
      if (el.scrollTop) savedThink[el.dataset.think] = el.scrollTop;
      if (el.closest('details.think') && el.closest('details.think').open) savedOpen.add(el.dataset.think);
    });
    box.innerHTML = msgsHtml();
    box.querySelectorAll('.think-body[data-think]').forEach((el) => {
      const det = el.closest('details.think');
      if (det && savedOpen.has(el.dataset.think)) det.open = true;   // 展开态别被重绘吃掉
      const top = savedThink[el.dataset.think];
      if (top) el.scrollTop = top;
    });
    // 贴着底部的照旧跟到底；用户手动上翻过，就停在原处，不要抢回顶部
    box.scrollTop = nearBottom ? box.scrollHeight : prevTop;
    bindCopy(box);
    bindTaskStop(box);
    syncSend();
    ensureTicker();
  }

  /** 任务卡上的「停止」：中断这次请求，并把任务记为已停止 */
  function stopTask(id) {
    const t = tasks.find((x) => x.id === id);
    if (!t || t.status !== 'running') return;
    t.abortFn();
    t.status = 'stopped';
    t.endedAt = Date.now();
    paint();
  }

  function bindTaskStop(box) {
    box.querySelectorAll('[data-task-stop]').forEach((b) => {
      b.addEventListener('click', () => stopTask(b.dataset.taskStop));
    });
  }

  /** 有任务在跑时每秒刷新「已等待 N 秒」——只改数字，不整体重绘，避免闪烁 */
  function ensureTicker() {
    const running = tasks.some((t) => t.status === 'running');
    if (running && !taskTimer) {
      taskTimer = setInterval(() => {
        tasks.forEach((t) => {
          if (t.status !== 'running') return;
          const el = root.querySelector(`[data-task-secs="${t.id}"]`);
          if (el) el.textContent = String(Math.round((Date.now() - t.startedAt) / 1000));
        });
      }, 1000);
    } else if (!running && taskTimer) {
      clearInterval(taskTimer);
      taskTimer = null;
    }
  }

  /**
   * 开一个「AI 任务」：其它 AI 功能（生成记忆点 / 续写 / 生成大纲 / 角色 / 线路 / 设定 / 脑暴）
   * 调用它之后，执行过程会像对话一样出现在助手里，结束时汇报执行了多少项。
   * 返回驱动器：signal 传给接口，点「停止」即可中断；另有 progress / item / note / finish / fail / stop。
   */
  function beginTask(title, opts = {}) {
    const t = {
      id: `task_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      title: String(title || 'AI 任务'),
      icon: opts.icon || '🧩',
      startedAt: Date.now(),
      endedAt: 0,
      status: 'running',
      detail: opts.detail || '',
      total: Number(opts.total) || 0,
      done: 0,
      items: [],
      notes: [],
      summary: '',
      error: ''
    };
    const ctrl = new AbortController();
    t.abortFn = () => { try { ctrl.abort(); } catch (_) { /* 已中断 */ } };
    tasks.push(t);
    paint();
    return {
      id: t.id,
      signal: ctrl.signal,
      get stopped() { return ctrl.signal.aborted; },
      total(n) { t.total = Number(n) || 0; livePaint(true); return this; },
      progress(done, detail) {
        t.done = Math.max(0, Number(done) || 0);
        if (detail != null) t.detail = String(detail);
        livePaint(true);
        return this;
      },
      item(label) { t.items.push(String(label)); livePaint(true); return this; },
      note(text) { t.notes.push(String(text)); livePaint(true); return this; },
      finish(summary) {
        t.status = 'done';
        t.endedAt = t.endedAt || Date.now();
        t.summary = summary || `已完成 ${t.done || t.items.length} 项`;
        t.detail = '';
        paint();
        return this;
      },
      fail(message) {
        t.status = 'error';
        t.endedAt = t.endedAt || Date.now();
        t.error = String(message || '执行失败');
        t.detail = '';
        paint();
        return this;
      },
      stop(summary) {
        t.abortFn();
        t.status = 'stopped';
        t.endedAt = t.endedAt || Date.now();
        if (summary) t.summary = String(summary);
        paint();
        return this;
      },
      abort() { t.abortFn(); }
    };
  }

  /** 每条消息（我的 / 助手的 / 正在生成的）都挂一个复制按钮 */
  function bindCopy(box) {
    box.querySelectorAll('.bubble-copy').forEach((b) => {
      const mode = b.dataset.copyMode;
      let label = '内容';
      if (mode === 'pending') label = '我的问题';
      else if (mode === 'live') label = '正在生成的回答';
      else {
        const m = (ctx.data.messages || [])[Number(b.dataset.idx)];
        label = m && m.role === 'user' ? '我的消息' : '助手回答';
      }
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        doCopy(textOf(b), b, label);
      });
    });
  }

  /** 流式期间约 10fps 重绘，既不卡又能实时看到思考与正文 */
  function livePaint(force) {
    const now = Date.now();
    if (!force && now - lastPaint < 90) return;
    lastPaint = now;
    paint();
  }

  function onEvent(ev) {
    if (!live) return;
    if (ev.type === 'round') {
      live.answer = '';        // 上一轮如果只是"下达操作指令"，这里清掉，避免误当成回答
      live.round = ev.n || live.round + 1;
      livePaint(true);
    } else if (ev.type === 'thinking') {
      const now = Date.now();
      if (!live.thinkStartAt) live.thinkStartAt = now;
      live.lastThinkAt = now;
      live.thinkMs = Math.max(0, now - live.thinkStartAt);
      live.thinking += ev.text;
      livePaint();
    } else if (ev.type === 'answer') {
      live.answer += ev.text;
      livePaint();
    } else if (ev.type === 'op') {
      live.ops.push(ev);
      livePaint(true);
    } else if (ev.type === 'note') {
      live.notes.push(ev.text);
      livePaint(true);
    }
  }

  function stop() {
    if (!busy) return;
    if (ctrl) ctrl.abort();
    const btn = root.querySelector('#agentSend');
    if (btn) { btn.textContent = '正在停止…'; btn.disabled = true; }
  }

  async function send(text) {
    const value = String(text || '').trim();
    if (busy) return toast('助手正在回答，可先点「停止」再发下一条', 'info');
    if (!value) return;
    if (!ctx.projectId) return toast('请先选择或新建一部作品', 'error');

    busy = true;
    ctrl = new AbortController();
    pendingText = value;
    pendingStart = Date.now();
    live = { thinking: '', answer: '', ops: [], notes: [], round: 1, startedAt: Date.now(), thinkMs: 0, thinkStartAt: 0, lastThinkAt: 0 };
    paint();
    pendingTimer = setInterval(() => {
      const el = root.querySelector('#liveWaited');
      if (el) el.textContent = Math.round((Date.now() - pendingStart) / 1000);
    }, 1000);

    let result = null;
    let aborted = false;
    try {
      result = await api.aiChatStream(ctx.projectId, value, ctx.sel.chapterId, {
        signal: ctrl.signal,
        onEvent
      });
    } catch (err) {
      aborted = err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
      if (!aborted) {
        result = {
          type: 'error',
          message: `调用失败：${err.message}\n\n你的问题已经保留在上面，可以直接重发，或到「设置 → 模型」检查接口地址、Key 与模型名。`
        };
      }
    } finally {
      clearInterval(pendingTimer);
      pendingTimer = null;
      pendingText = '';
      busy = false;
      live = null;
      ctrl = null;
      // 服务端在收到停止后才会落盘「已停止」那条消息，稍等一下再刷新
      if (aborted) await new Promise((r) => setTimeout(r, 350));
      await ctx.reload();
      paint();
    }

    if (!result) return;
    if (result.type === 'done' && result.demo) toast('演示模式：尚未配置可用的模型', 'info');
    if (result.type === 'stopped') toast('已停止这次回答', 'info');
    if (result.type === 'error') toast('调用失败，问题已保留', 'error');
  }

  return { paint, send, beginTask };
}

/* ---------------------------------------------------------------- 设置弹窗 */

export function openSettings(ctx) {
  const s = ctx.settings;
  const presetKeys = Object.keys(PRESETS);

  // 工作副本：所有编辑先落到这里，保存时一次性写回
  const working = {
    providers: (Array.isArray(s.providers) ? s.providers : []).map((p) => ({ ...p })),
    activeProvider: s.activeProvider || (s.providers && s.providers[0] && s.providers[0].id) || '',
    useDemo: s.useDemo !== false,
    agentPersona: s.agentPersona || '',
    autoApply: !!s.autoApply
  };
  if (!working.providers.length) {
    const p = blankProvider();
    working.providers.push(p);
    working.activeProvider = p.id;
  }
  let selIdx = Math.max(0, working.providers.findIndex((p) => p.id === working.activeProvider));

  function blankProvider() {
    return {
      id: `ai_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      name: '新的自定义 AI',
      provider: 'custom',
      endpoint: '', apiKey: '', model: '',
      temperature: 0.85, maxTokens: 4096, extraBody: ''
    };
  }

  const m = openModal({
    title: '模型设置',
    subtitle: '可接入多个自定义 AI，随时切换 · 数据只在本机流转',
    width: 760,
    html: `
      <div class="settings-wrap">
        <div class="provider-layout">
          <div class="provider-side">
            <div class="provider-side-head">
              <span>已接入的模型</span>
              <button class="btn ghost xs" id="btnAddProvider">+ 添加</button>
            </div>
            <div class="provider-list" id="providerList"></div>
          </div>
          <div class="provider-editor" id="providerEditor"></div>
        </div>
        <div class="settings-global">
          <label class="field"><span>助手人格 / 写作偏好</span>
            <textarea id="setPersona" rows="2" placeholder="例如：偏好克制冷峻的文风，讨厌巧合推动剧情，所有建议必须落到具体章节">${esc(working.agentPersona)}</textarea>
            <em class="field-hint">这段会进入系统提示词，长期影响助手的判断标准</em>
          </label>
          <label class="sw-check"><input type="checkbox" id="setUseDemo" ${working.useDemo ? 'checked' : ''}/> <span>所有模型都未配置 Key 时，使用演示模式产出占位内容</span></label>
        </div>
        <div class="settings-test">
          <button class="btn ghost sm" id="btnTest">测试当前编辑的模型连接</button>
          <span id="testResult" class="muted small">未测试</span>
        </div>
        <p class="settings-foot muted">每个自定义 AI 自带接口地址、Key、模型名与推理参数，可并存多个（如「我的智谱」「公司私有模型」）。点「设为使用」切换助手当前调用的模型，保存后立即生效。</p>
      </div>`,
    buttons: [
      { label: '取消', kind: 'ghost' },
      {
        label: '保存', kind: 'primary', keepOpen: true,
        onClick: async (body, wrap) => {
          // 保存前清洗：丢掉「只有名字、接口/Key/模型名全空」的草稿，
          // 否则列表里会堆一串空条目，看起来就像"配置被清空了"
          const isBlank = (p) => !String(p.endpoint || '').trim()
            && !String(p.apiKey || '').trim() && !String(p.model || '').trim();
          let list = working.providers.filter((p) => !isBlank(p));
          if (!list.length) list = [{ ...(working.providers[0] || blankProvider()) }];
          // 正在使用的模型：必须指向真实存在的条目，否则退回「接口+Key 都有的」那个，再退回第一个。
          // 关键：绝不能因为新增了一个空模型，就把原来能用的模型顶掉。
          let active = list.some((p) => p.id === working.activeProvider) ? working.activeProvider : '';
          const cur = list.find((p) => p.id === active);
          if (!cur || !cur.apiKey || !cur.endpoint) {
            const usable = list.find((p) => p.apiKey && p.endpoint);
            active = usable ? usable.id : (cur ? cur.id : list[0].id);
          }
          working.providers = list;
          working.activeProvider = active;
          await api.saveSettings({
            providers: list.map((p) => ({
              id: p.id, name: p.name, provider: p.provider, endpoint: p.endpoint,
              apiKey: p.apiKey, model: p.model,
              temperature: Number(p.temperature), maxTokens: Number(p.maxTokens), extraBody: p.extraBody
            })),
            activeProvider: active,
            useDemo: working.useDemo,
            agentPersona: body.querySelector('#setPersona').value,
            autoApply: working.autoApply
          });
          await ctx.refreshSettings();
          wrap.classList.remove('in');
          setTimeout(() => wrap.remove(), 200);
          toast('设置已保存', 'success');
        }
      }
    ],
    onMount: (body) => {
      const listEl = body.querySelector('#providerList');
      const editorEl = body.querySelector('#providerEditor');

      const renderList = () => {
        if (!working.providers.length) {
          listEl.innerHTML = '<div class="prov-empty muted small">还没有模型，点「+ 添加」</div>';
        } else {
          listEl.innerHTML = working.providers.map((p, i) => {
            const ready = Boolean(p.apiKey && p.endpoint);
            return `
            <div class="prov-card ${i === selIdx ? 'sel' : ''} ${working.activeProvider === p.id ? 'active' : ''} ${ready ? '' : 'unset'}" data-i="${i}">
              <div class="prov-main">
                <b>${esc(p.name || '未命名')}${ready ? '' : ' <i class="prov-tag">待填写</i>'}</b>
                <span class="prov-sub">${ready ? esc(p.model || p.endpoint) : '接口地址 / Key 还没填'}</span>
              </div>
              <div class="prov-acts">
                <button class="mini ${working.activeProvider === p.id ? 'on' : ''}" data-act="activate" data-i="${i}">${working.activeProvider === p.id ? '● 使用中' : '设为使用'}</button>
                <button class="mini danger" data-act="del" data-i="${i}" title="删除该模型">✕</button>
              </div>
            </div>`;
          }).join('');
        }
        listEl.querySelectorAll('[data-act]').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const i = Number(btn.dataset.i);
            const act = btn.dataset.act;
            if (act === 'activate') {
              working.activeProvider = working.providers[i].id;
              selIdx = i;
              renderList(); renderEditor();
            } else if (act === 'del') {
              const removedId = working.providers[i].id;
              working.providers.splice(i, 1);
              if (!working.providers.length) {
                const np = blankProvider();
                working.providers.push(np);
                working.activeProvider = np.id;
              } else if (working.activeProvider === removedId) {
                working.activeProvider = (working.providers.find((p) => p.apiKey && p.endpoint) || working.providers[0]).id;
              }
              selIdx = Math.min(i, working.providers.length - 1);
              renderList(); renderEditor();
            }
          });
        });
        listEl.querySelectorAll('.prov-card').forEach((card) => {
          card.addEventListener('click', () => { selIdx = Number(card.dataset.i); renderList(); renderEditor(); });
        });
      };

      const renderEditor = () => {
        const p = working.providers[selIdx];
        if (!p) { editorEl.innerHTML = ''; return; }
        editorEl.innerHTML = `
          <label class="field"><span>名称</span><input id="peName" value="${esc(p.name || '')}" placeholder="例如：我的智谱 / 公司私有模型" /></label>
          <label class="field"><span>服务商预设</span>
            <select id="peProvider">
              ${presetKeys.map((k) => `<option value="${k}" ${p.provider === k ? 'selected' : ''}>${esc(PRESETS[k].label)}</option>`).join('')}
            </select>
            <em class="field-hint">选择后会自动填入常用地址与模型名，可再手动改</em>
          </label>
          <label class="field"><span>接口地址</span><input id="peEndpoint" value="${esc(p.endpoint || '')}" placeholder="https://api.deepseek.com/v1" /></label>
          <label class="field"><span>API Key</span><input id="peKey" type="password" value="${esc(p.apiKey || '')}" placeholder="sk-..." /></label>
          <label class="field"><span>模型名</span><input id="peModel" value="${esc(p.model || '')}" placeholder="deepseek-chat" /></label>
          <div class="field-row">
            <label class="field"><span>温度 <b id="peTempVal">${esc(p.temperature)}</b></span>
              <input id="peTemp" type="range" min="0" max="2" step="0.05" value="${esc(p.temperature)}" />
            </label>
            <label class="field"><span>最大输出</span><input id="peMax" type="number" value="${esc(p.maxTokens)}" min="256" max="131072" step="256" /></label>
          </div>
          <label class="field"><span>高级请求参数（JSON）<em>模型特有参数走这里</em></span>
            <textarea id="peExtra" rows="2" placeholder='{"reasoning_effort":"low"}'>${esc(p.extraBody || '')}</textarea>
            <em class="field-hint">会原样合并进请求体。GLM-5.x 可用 <code>reasoning_effort</code> 控制思考强度（low/high/max）。留空即可。</em>
          </label>`;

        const bind = (sel, key, asNum) => {
          const el = editorEl.querySelector(sel);
          if (!el) return;
          el.addEventListener('input', () => { p[key] = asNum ? Number(el.value) : el.value; });
        };
        bind('#peName', 'name');
        bind('#peEndpoint', 'endpoint');
        bind('#peKey', 'apiKey');
        bind('#peModel', 'model');
        bind('#peExtra', 'extraBody');
        editorEl.querySelector('#peProvider').addEventListener('change', (e) => {
          const pr = PRESETS[e.target.value];
          p.provider = e.target.value;
          if (pr && pr.endpoint) { p.endpoint = pr.endpoint; p.model = pr.model; editorEl.querySelector('#peEndpoint').value = pr.endpoint; editorEl.querySelector('#peModel').value = pr.model; }
        });
        editorEl.querySelector('#peTemp').addEventListener('input', (e) => {
          p.temperature = Number(e.target.value);
          editorEl.querySelector('#peTempVal').textContent = e.target.value;
        });
        editorEl.querySelector('#peMax').addEventListener('input', (e) => { p.maxTokens = Number(e.target.value); });
      };

      body.querySelector('#btnAddProvider').addEventListener('click', () => {
        const np = blankProvider();
        working.providers.push(np);
        selIdx = working.providers.length - 1; // 编辑区切到新草稿，方便马上填
        // 刻意不动 working.activeProvider：新增一个还没填的模型，不能把正在用的模型顶掉，
        // 否则用户会以为"加了第二个，第一个被清空了"。
        renderList(); renderEditor();
      });
      body.querySelector('#setPersona').addEventListener('input', (e) => { working.agentPersona = e.target.value; });
      body.querySelector('#setUseDemo').addEventListener('change', (e) => { working.useDemo = e.target.checked; });

      body.querySelector('#btnTest').addEventListener('click', async () => {
        const p = working.providers[selIdx];
        const out = body.querySelector('#testResult');
        out.textContent = '正在连接…';
        try {
          const r = await api.aiTest({
            id: p.id, name: p.name, provider: p.provider, endpoint: p.endpoint,
            apiKey: p.apiKey, model: p.model, temperature: Number(p.temperature),
            maxTokens: Number(p.maxTokens), extraBody: p.extraBody
          });
          out.innerHTML = r.ok
            ? `<span class="success-text">✓ 连通（${esc(r.model)} · ${r.latency}ms）</span>`
            : `<span class="error-text">✕ ${esc(r.message || '连接失败')}</span>`;
        } catch (err) {
          out.innerHTML = `<span class="error-text">✕ ${esc(err.message)}</span>`;
        }
      });

      renderList();
      renderEditor();
    }
  });
  return m;
}
