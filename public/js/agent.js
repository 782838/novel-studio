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

  function statusHtml() {
    const configured = ctx.settings.hasKey;
    return `<span id="aiStatus" class="ai-status ${configured ? 'on' : 'off'}">
      <i></i>${configured ? esc(ctx.settings.model || '已就绪') : '演示模式'}
    </span>`;
  }

  const secs = (ms) => (ms / 1000).toFixed(1);

  /** 助手「思考过程」折叠块——实时与历史消息共用 */
  function thinkBlock(thinking, thinkMs, open) {
    if (!thinking) return '';
    return `<details class="think"${open ? ' open' : ''}>
      <summary>🧠 思考过程${thinkMs ? `（${secs(thinkMs)} 秒）` : ''}</summary>
      <div class="think-body" id="liveThink">${esc(thinking)}</div>
    </details>`;
  }

  function msgsHtml() {
    const msgs = ctx.data.messages || [];
    // 作者刚发出、服务端还在处理的那条问题——必须立刻显示，否则看起来像"被吞了"
    const mine = pendingText
      ? `<div class="bubble user"><div class="bubble-body plain">${esc(pendingText)}</div></div>` : '';
    if (!msgs.length && !pendingText && !live) {
      return `<div class="agent-welcome">
        <div class="welcome-glyph">✦</div>
        <h4>我能读到你项目里的一切</h4>
        <p>大纲、角色、线路、设定都会进入我的上下文；章节会带标题和开头，你正打开的那一章我会直接读到全文，其它章节你说一声我就能去读。你既可以让我想，也可以让我直接动手改——新建角色、补大纲、铺节拍都行。</p>
      </div>`;
    }
    return msgs.map((m) => bubble(m)).join('') + mine + liveHtml();
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
    return `<div class="bubble assistant">
      <div class="bubble-avatar">✦</div>
      <div class="bubble-body">
        ${thinkBlock(live.thinking, live.thinkMs, true)}
        ${idle ? `<div class="live-status"><span class="dot-typing"><i></i><i></i><i></i></span><em>正在读取项目数据并思考…</em></div>` : ''}
        ${notes}
        ${ops}
        ${answer}
        <div class="live-foot"><span class="dot-typing sm"><i></i><i></i><i></i></span>已等待 <b id="liveWaited">${waited}</b> 秒 · 可随时点「停止」
        </div>
      </div>
    </div>`;
  }

  function bubble(m) {
    const mine = m.role === 'user';
    if (mine) return `<div class="bubble user"><div class="bubble-body plain">${esc(m.content)}</div></div>`;
    const meta = [];
    if (m.thinkMs) meta.push(`思考 ${secs(m.thinkMs)} 秒`);
    if (m.latency) meta.push(`用时 ${secs(m.latency)} 秒`);
    return `<div class="bubble assistant">
      <div class="bubble-avatar">✦</div>
      <div class="bubble-body">
        ${thinkBlock(m.thinking, m.thinkMs, false)}
        ${md(m.content)}${opsHtml(m.ops)}
        ${meta.length ? `<div class="bubble-meta">${meta.join(' · ')}</div>` : ''}
      </div>
    </div>`;
  }

  function opsHtml(ops) {
    if (!ops || !ops.length) return '';
    return `<details class="ops"><summary>已执行 ${ops.length} 项操作</summary>
      <ul>${ops.map((o) => `<li><span class="op-dot"></span>${esc(o.label || o.action)}</li>`).join('')}</ul>
    </details>`;
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
        <textarea id="agentInput" rows="2" placeholder="让我帮你什么？Ctrl + Enter 发送"></textarea>
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
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
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
  }

  /** 按钮在「发送 / 停止」之间切换 */
  function syncSend() {
    const btn = root.querySelector('#agentSend');
    if (!btn) return;
    btn.textContent = busy ? '■ 停止' : '发送';
    btn.className = `btn sm ${busy ? 'danger' : 'primary'}`;
    btn.title = busy ? '停止这次回答' : '发送（Ctrl + Enter）';
    btn.disabled = false;   // 一度点过「停止」的话，这里要把它解回来，否则之后再发不出去
  }

  function paint() {
    if (!built) build();
    const st = root.querySelector('#aiStatus');
    if (st) st.outerHTML = statusHtml();
    const box = root.querySelector('#agentMsgs');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    box.innerHTML = msgsHtml();
    if (nearBottom) box.scrollTop = box.scrollHeight;
    syncSend();
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

  return { paint, send };
}

/* ---------------------------------------------------------------- 设置弹窗 */

export function openSettings(ctx) {
  const s = ctx.settings;
  const presetKeys = Object.keys(PRESETS);

  const m = openModal({
    title: '模型设置',
    subtitle: '支持任何 OpenAI 兼容接口，数据只在本机流转',
    width: 640,
    html: `
      <div class="settings-wrap">
        <label class="field">
          <span>服务商预设</span>
          <select id="setProvider">
            ${presetKeys.map((k) => `<option value="${k}" ${s.provider === k ? 'selected' : ''}>${esc(PRESETS[k].label)}</option>`).join('')}
          </select>
          <em class="field-hint">选择后会自动填入常用地址与模型名，可再手动改</em>
        </label>
        <label class="field"><span>接口地址</span><input id="setEndpoint" value="${esc(s.endpoint || '')}" placeholder="https://api.deepseek.com/v1" /></label>
        <label class="field"><span>API Key</span><input id="setKey" type="password" value="${esc(s.apiKey || '')}" placeholder="sk-..." /></label>
        <label class="field"><span>模型名</span><input id="setModel" value="${esc(s.model || '')}" placeholder="deepseek-chat" /></label>
        <div class="field-row">
          <label class="field"><span>温度 <b id="tempVal">${esc(s.temperature)}</b></span>
            <input id="setTemp" type="range" min="0" max="2" step="0.05" value="${esc(s.temperature)}" />
          </label>
          <label class="field"><span>最大输出</span><input id="setMax" type="number" value="${esc(s.maxTokens)}" min="256" max="131072" step="256" /></label>
        </div>
        <label class="field"><span>高级请求参数（JSON）<em>模型特有参数走这里</em></span>
          <textarea id="setExtra" rows="2" placeholder='{"reasoning_effort":"low"}'>${esc(s.extraBody || '')}</textarea>
          <em class="field-hint">会原样合并进请求体。GLM-5.x 可用 <code>reasoning_effort</code> 控制思考强度（low/high/max，不传默认 max，输出会明显变长）。留空即可。</em>
        </label>
        <label class="field"><span>助手人格 / 写作偏好</span>
          <textarea id="setPersona" rows="3" placeholder="例如：偏好克制冷峻的文风，讨厌巧合推动剧情，所有建议必须落到具体章节">${esc(s.agentPersona || '')}</textarea>
          <em class="field-hint">这段会进入系统提示词，长期影响助手的判断标准</em>
        </label>
        <div class="settings-test">
          <button class="btn ghost sm" id="btnTest">测试连接</button>
          <span id="testResult" class="muted small">未测试</span>
        </div>
      </div>`,
    buttons: [
      { label: '取消', kind: 'ghost' },
      {
        label: '保存', kind: 'primary', keepOpen: true,
        onClick: async (body, wrap) => {
          await api.saveSettings({
            provider: body.querySelector('#setProvider').value,
            endpoint: body.querySelector('#setEndpoint').value,
            apiKey: body.querySelector('#setKey').value,
            model: body.querySelector('#setModel').value,
            temperature: Number(body.querySelector('#setTemp').value),
            maxTokens: Number(body.querySelector('#setMax').value),
            agentPersona: body.querySelector('#setPersona').value,
            extraBody: body.querySelector('#setExtra') ? body.querySelector('#setExtra').value : ''
          });
          await ctx.refreshSettings();
          wrap.classList.remove('in');
          setTimeout(() => wrap.remove(), 200);
          toast('设置已保存', 'success');
        }
      }
    ],
    onMount: (body) => {
      body.querySelector('#setProvider').addEventListener('change', (e) => {
        const p = PRESETS[e.target.value];
        if (!p || !p.endpoint) return;
        body.querySelector('#setEndpoint').value = p.endpoint;
        body.querySelector('#setModel').value = p.model;
      });
      body.querySelector('#setTemp').addEventListener('input', (e) => {
        body.querySelector('#tempVal').textContent = e.target.value;
      });
      body.querySelector('#btnTest').addEventListener('click', async () => {
        const out = body.querySelector('#testResult');
        out.textContent = '正在连接…';
        // 测试前先落盘当前填写的值
        await api.saveSettings({
          provider: body.querySelector('#setProvider').value,
          endpoint: body.querySelector('#setEndpoint').value,
          apiKey: body.querySelector('#setKey').value,
          model: body.querySelector('#setModel').value,
          temperature: Number(body.querySelector('#setTemp').value),
          maxTokens: Number(body.querySelector('#setMax').value),
          agentPersona: body.querySelector('#setPersona').value,
            extraBody: body.querySelector('#setExtra') ? body.querySelector('#setExtra').value : ''
        });
        try {
          const r = await api.aiTest();
          out.innerHTML = r.ok
            ? `<span class="success-text">✓ 连通（${esc(r.model)} · ${r.latency}ms）</span>`
            : `<span class="error-text">✕ ${esc(r.message || '连接失败')}</span>`;
        } catch (err) {
          out.innerHTML = `<span class="error-text">✕ ${esc(err.message)}</span>`;
        }
      });
    }
  });
  return m;
}
