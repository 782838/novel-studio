'use strict';

/* ---------------- 转义 ---------------- */
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function uid(p = 'id') {
  return `${p}_${Math.random().toString(36).slice(2, 9)}`;
}

export function debounce(fn, ms = 500) {
  let t;
  let last = [];
  const wrapped = (...a) => { last = a; clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  wrapped.cancel = () => clearTimeout(t);
  /** 立即执行挂起的调用（用于刷新前保存草稿） */
  wrapped.flush = () => { clearTimeout(t); if (last.length) fn(...last); last = []; };
  return wrapped;
}

/* ---------------- 下载 ---------------- */
/** 文件名去掉 Windows 不允许的字符，避免保存失败 */
export function safeFileName(name, ext = 'txt') {
  const clean = String(name || '未命名')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/^\.+/, '')
    .trim() || '未命名';
  return clean.endsWith(`.${ext}`) ? clean : `${clean}.${ext}`;
}

/**
 * 把一段文本存成文件下载。
 * 加 UTF-8 BOM，保证 Windows 记事本打开中文不乱码（读取时用 stripBom 去掉）。
 * 桌面端（Electron）会弹系统「另存为」对话框，由用户选保存位置。
 */
export function downloadText(fileName, text) {
  const blob = new Blob([`\uFEFF${text}`], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFileName(fileName, 'txt');
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1500);
  return a.download;
}

/** 去掉文件开头的 UTF-8 BOM（我们自己导出的 TXT 会带） */
export function stripBom(text) {
  return String(text || '').replace(/^\uFEFF/, '');
}

/* ---------------- Toast ---------------- */
let toastRoot = null;
export function toast(message, kind = 'info', ms = 2600) {
  if (!toastRoot) toastRoot = document.getElementById('toastRoot');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.innerHTML = `<span class="toast-icon">${kind === 'error' ? '!' : kind === 'success' ? '✓' : '·'}</span><span>${esc(message)}</span>`;
  toastRoot.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 300); }, ms);
}

/* ---------------- 极简 Markdown ---------------- */
export function md(src) {
  if (!src) return '';
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null;
  let para = [];
  let code = null;   // ``` 代码块缓冲

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${inline(para.join('\n'))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  const flushCode = () => {
    if (code === null) return;
    // AI 下达的 json 操作块走这里，显示成代码块，不会裸露成一堆乱码段落
    out.push(`<pre class="md-pre"><code>${esc(code.join('\n'))}</code></pre>`);
    code = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (/^\s*```/.test(line)) {
      if (code === null) { flushPara(); flushList(); code = []; }
      else flushCode();
      continue;
    }
    if (code !== null) { code.push(raw); continue; }

    if (!line.trim()) { flushPara(); flushList(); continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); flushList(); const lv = Math.min(6, h[1].length); out.push(`<h${lv}>${inline(h[2])}</h${lv}>`); continue; }

    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { flushPara(); flushList(); out.push('<hr>'); continue; }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) { flushPara(); flushList(); out.push(`<blockquote>${inline(quote[1])}</blockquote>`); continue; }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
      list.items.push(ul[1]);
      continue;
    }
    const ol = line.match(/^\s*\d+[.、]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
      list.items.push(ol[1]);
      continue;
    }

    flushList();
    para.push(line);
  }
  flushPara(); flushList(); flushCode();
  return out.join('');

  function inline(text) {
    // 顺序很重要：先转义、再把换行换成 <br>。反过来会把 <br> 本身也转义成文本，
    // 界面上就会冒出一堆字面量 <br>（之前就是这个 bug）。
    return esc(text)
      .replace(/\n/g, '<br>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  }
}

/* ---------------- Modal ---------------- */
let modalRoot = null;

export function closeModal(el) {
  if (el && el.classList) el.classList.remove('in');
  const node = el || (modalRoot && modalRoot.lastElementChild);
  if (!node) return;
  setTimeout(() => node.remove(), 200);
}

/**
 * 打开弹窗。
 * @param {object} opt {title, subtitle, html, width, footer, buttons:[{label,kind,onClick,keepOpen}], onMount}
 */
export function openModal(opt = {}) {
  if (!modalRoot) modalRoot = document.getElementById('modalRoot');
  const wrap = document.createElement('div');
  wrap.className = 'modal-mask';
  wrap.innerHTML = `
    <div class="modal" style="width:${opt.width || 560}px">
      <div class="modal-head">
        <div>
          <h3>${esc(opt.title || '')}</h3>
          ${opt.subtitle ? `<p class="modal-sub">${esc(opt.subtitle)}</p>` : ''}
        </div>
        <button class="icon-btn" data-close aria-label="关闭">✕</button>
      </div>
      <div class="modal-body">${opt.html || ''}</div>
      ${(opt.buttons && opt.buttons.length) || opt.footer !== false ? `
      <div class="modal-foot">
        <div class="foot-left">${opt.footerLeft || ''}</div>
        <div class="foot-right">
          ${(opt.buttons || [{ label: '关闭', kind: 'ghost', onClick: () => {} }]).map((b, i) =>
            `<button class="btn ${b.kind || 'ghost'}" data-btn="${i}">${esc(b.label)}</button>`).join('')}
        </div>
      </div>` : ''}
    </div>`;

  modalRoot.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('in'));

  const bodyEl = wrap.querySelector('.modal-body');
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) { closeModal(wrap); return; }
    const b = e.target.closest('[data-btn]');
    if (b) {
      const def = (opt.buttons || [{}])[Number(b.dataset.btn)];
      const proceed = def.onClick ? def.onClick(bodyEl, wrap) : undefined;
      if (proceed !== false && !def.keepOpen) closeModal(wrap);
    }
  });
  if (opt.onMount) opt.onMount(bodyEl, wrap);
  return { wrap, body: bodyEl, close: () => closeModal(wrap) };
}

/** 表单弹窗：fields 为 [{key,label,type,options,placeholder,rows,hint}] */
export function openForm({ title, subtitle, fields = [], values = {}, okText = '保存', width = 560, onSubmit }) {
  return openModal({
    title, subtitle, width,
    html: `<form class="form" autocomplete="off">${fields.map(f => {
      const v = values[f.key] != null ? values[f.key] : (f.default != null ? f.default : '');
      const common = `name="${f.key}" ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}`;
      let ctrl;
      if (f.type === 'textarea') ctrl = `<textarea ${common} rows="${f.rows || 4}">${esc(v)}</textarea>`;
      else if (f.type === 'select') ctrl = `<select ${common}>${(f.options || []).map(o => {
        const [val, lab] = Array.isArray(o) ? o : [o, o];
        return `<option value="${esc(val)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(lab)}</option>`;
      }).join('')}</select>`;
      else ctrl = `<input type="${f.type || 'text'}" ${common} value="${esc(v)}">`;
      return `<label class="field ${f.type === 'textarea' ? 'field-area' : ''}">
        <span>${esc(f.label)}${f.hint ? `<em>${esc(f.hint)}</em>` : ''}</span>
        ${ctrl}
      </label>`;
    }).join('')}</form>`,
    buttons: [
      { label: '取消', kind: 'ghost', onClick: () => {} },
      {
        label: okText, kind: 'primary', keepOpen: true,
        onClick: (body, wrap) => {
          const form = body.querySelector('form');
          const data = {};
          fields.forEach((f) => {
            const el = form.elements[f.key];
            if (!el) return;
            data[f.key] = f.type === 'number' ? Number(el.value) : el.value.trim();
          });
          if (onSubmit(data, wrap) !== false) closeModal(wrap);
        }
      }
    ],
    onMount: (body) => {
      const first = body.querySelector('input,textarea,select');
      if (first) first.focus();
      body.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          const btn = body.closest('.modal').querySelector('[data-btn="1"]');
          if (btn) btn.click();
        }
      });
    }
  });
}

export function openConfirm({ title = '确认操作', message, danger = false, okText = '确定' }) {
  return new Promise((resolve) => {
    openModal({
      title, width: 420,
      html: `<p class="confirm-text">${esc(message || '')}</p>`,
      buttons: [
        { label: '取消', kind: 'ghost', onClick: () => resolve(false) },
        { label: okText, kind: danger ? 'danger' : 'primary', onClick: () => resolve(true) }
      ],
      onMount: () => {}
    });
  });
}

/**
 * AI 长任务等待浮层：免费模型繁忙/限流时会一直重试，但前端看不到进度，容易以为「卡死/失败了」。
 * 这个浮层实时显示「已等待 N 秒」并提示「模型繁忙会自动重试」，且提供「停止」按钮——
 * 点停止即 abort 这次请求，后端会在下一次重试前检测到断开并中止，与聊天助手的停止一致。
 * @returns {{ close: Function, signal: AbortSignal, abort: Function }}
 */
export function openAiWaiting({ title = 'AI 正在生成…', hint = '免费模型繁忙时会自动重试，可随时点「停止」' } = {}) {
  const ctrl = new AbortController();
  let stopped = false;
  const { wrap, close } = openModal({
    title, width: 440, footer: false,
    html: `
      <div class="ai-wait">
        <div class="ai-wait-row"><span class="dot-typing sm"><i></i><i></i><i></i></span><span>正在请求模型…</span></div>
        <div class="ai-wait-tip">${esc(hint)}</div>
        <div class="ai-wait-time">已等待 <b id="aiWaitSec">0</b> 秒</div>
        <button class="btn danger xs" id="aiWaitStop">■ 停止</button>
      </div>`,
    onMount: (body) => {
      const secEl = body.querySelector('#aiWaitSec');
      const stopBtn = body.querySelector('#aiWaitStop');
      const timer = setInterval(() => {
        if (secEl) secEl.textContent = String((Number(secEl.textContent || 0) + 1));
      }, 1000);
      wrap._aiTimer = timer;
      stopBtn.addEventListener('click', () => {
        if (stopped) return;
        stopped = true;
        ctrl.abort();
        stopBtn.textContent = '正在停止…';
        stopBtn.disabled = true;
      });
    }
  });
  const closeAll = () => { if (wrap._aiTimer) clearInterval(wrap._aiTimer); close(); };
  return { close: closeAll, signal: ctrl.signal, abort: () => ctrl.abort() };
}
