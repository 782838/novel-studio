'use strict';
/**
 * AI 助手记忆箱（全局助手档案）。
 * 入口 openMinds(ctx)：列表 + 总开关 + 新建/编辑/切换/删除/导入导出。
 * 单个助手编辑器含：名字、头像（内置 emoji 库 + 上传图片圆形裁剪）、人设、长期记忆条、
 * 以及「从对话一键提炼」。所有改动通过 api.minds* 落盘，并触发 ctx.refreshMinds() 让助手面板同步。
 */
import api from './api.js';
import { esc, openModal, openConfirm, toast, closeModal, openAiWaiting } from './ui.js';

// 内置 emoji 头像库（不依赖任何图片资源，永远可用）
const ICON_AVATARS = [
  '🤖', '✨', '📚', '🦊', '🐱', '🐶', '🌟', '🎭', '💡', '🌈',
  '🔮', '⚔️', '🌙', '☀️', '🍀', '🎯', '👑', '🐉', '🦄', '❄️',
  '🔥', '🌸', '💎', '🍎', '🐺', '🦅', '🌊', '🍂', '⚡', '🪶'
];
const FALLBACK_EMOJI = '🤖';

function isEmoji(s) {
  return typeof s === 'string' && /^\p{Extended_Pictographic}(‍\p{Extended_Pictographic})*$/u.test(s.trim());
}

/** 给所有带 data-fallback 的头像图绑定加载失败的回退（图坏了就显示 emoji，绝不破图） */
function bindAvatarFallback(scope) {
  (scope || document).querySelectorAll('img.avatar-img[data-fallback]').forEach((img) => {
    img.addEventListener('error', () => {
      const s = document.createElement('span');
      s.className = img.className + ' avatar-emoji';
      s.textContent = img.dataset.fallback || FALLBACK_EMOJI;
      if (img.parentNode) img.replaceWith(s);
    });
  });
}

/** 统一的头像渲染：dataURL / emoji / 默认（露西图，失败回退 emoji） */
function avatarHtml(avatar, defaultAvatar, cls) {
  const def = defaultAvatar || '/img/avatar-lucy.png';
  if (avatar && avatar.startsWith('data:')) {
    return `<img class="${cls} avatar-img" src="${esc(avatar)}" alt="">`;
  }
  if (isEmoji(avatar)) {
    return `<span class="${cls} avatar-emoji">${esc(avatar)}</span>`;
  }
  return `<img class="${cls} avatar-img" src="${esc(def)}" alt="" data-fallback="${FALLBACK_EMOJI}">`;
}

function downloadJson(name, obj) {
  const text = JSON.stringify(obj, null, 2);
  const blob = new Blob(['﻿' + text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (name || 'data') + '.json';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1500);
}

// ---------------------------------------------------------------- 主弹窗

export async function openMinds(ctx) {
  let box = await api.minds();
  const limits = box.limits || { text: 500, count: 100, persona: 4000 };
  // render 必须声明在 openMinds 作用域：bindList（编辑/设为生效/删除 的按钮回调）定义在
  // openMinds 内而非 onMount 内，否则点击时引用不到 render 会抛 "render is not defined"，
  // 表现为这些按钮「点不动」。onMount 里对它赋值。
  let render = () => {};
  // 保存/删除后必须重新拉取列表再重绘：box 是 openMinds 的局部变量，
  // 只 render() 不重取的话列表看到的还是旧数据（新增/改名不显示）。
  const refreshList = async () => { box = await api.minds(); render(); };

  const { body, close } = openModal({
    title: '🧠 AI 助手记忆箱',
    subtitle: '调教属于你的 AI 助手：人设、长期习惯与头像。全局生效，每一本书都带着。',
    width: 740,
    footer: false,
    html: `
      <div class="mind-top">
        <label class="switch">
          <input type="checkbox" id="mindEnabled" ${(box.mindBoxEnabled !== false) ? 'checked' : ''}>
          <span class="switch-track"></span>
          <span class="switch-label">记忆箱总开关 · 关闭后助手回到「未被调教」的原始状态</span>
        </label>
      </div>
      <div class="mind-list" id="mindList"></div>
      <div class="mind-actions">
        <button class="btn primary sm" id="mindNew">＋ 新建助手</button>
        <button class="btn ghost sm" id="mindImport">导入 .json</button>
        <button class="btn ghost sm" id="mindExportAll">导出全部</button>
      </div>
      <input type="file" id="mindImportFile" accept="application/json,.json" hidden>
    `,
    onMount(b) {
      const listEl = b.querySelector('#mindList');
      render = () => { listEl.innerHTML = listHtml(); bindList(b); bindAvatarFallback(b); };

      b.querySelector('#mindEnabled').addEventListener('change', async (e) => {
        try {
          const r = await api.mindToggle({ enabled: e.target.checked });
          box.mindBoxEnabled = r.mindBoxEnabled;
          ctx.refreshMinds && await ctx.refreshMinds();
        } catch (err) { toast(err.message, 'error'); }
      });
      b.querySelector('#mindNew').addEventListener('click', () => openMindEditor(ctx, null, limits, refreshList));
      b.querySelector('#mindImport').addEventListener('click', () => b.querySelector('#mindImportFile').click());
      b.querySelector('#mindImportFile').addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          const payload = JSON.parse(text);
          const r = await api.mindImport(payload, 'append');
          toast(`导入完成：新增 ${r.added}，更新 ${r.updated}`, 'success');
          box = await api.minds();
          render();
        } catch (err) { toast('导入失败：' + err.message, 'error'); }
        e.target.value = '';
      });
      b.querySelector('#mindExportAll').addEventListener('click', async () => {
        try { downloadJson('AI助手记忆箱-全部', await api.mindExport('all')); }
        catch (err) { toast(err.message, 'error'); }
      });

      render();
    }
  });

  function listHtml() {
    const minds = box.minds || [];
    if (!minds.length) return '<div class="mind-empty">还没有助手，点「新建助手」开始调教。</div>';
    return minds.map((m) => {
      const active = m.id === box.activeMindId;
      const memCount = (m.memories || []).length;
      return `<div class="mind-card ${active ? 'is-active' : ''}" data-id="${esc(m.id)}">
        <div class="mind-card-avatar">${avatarHtml(m.avatar, box.defaultAvatar, 'avatar-sm')}</div>
        <div class="mind-card-body">
          <div class="mind-card-name">${esc(m.name)}
            ${active ? '<span class="mind-badge">生效中</span>' : ''}
            ${m.builtin ? '<span class="mind-badge builtin">内置</span>' : ''}
          </div>
          <div class="mind-card-meta">${memCount} 条记忆 · ${m.persona ? '有人设' : '无设定'}${m.builtin ? ' · 不可删可改' : ''}</div>
        </div>
        <div class="mind-card-acts">
          ${active ? '' : '<button class="btn ghost xs" data-act="activate">设为生效</button>'}
          <button class="btn ghost xs" data-act="edit">编辑</button>
          <button class="btn ghost xs" data-act="export">导出</button>
          ${m.builtin ? '' : '<button class="btn ghost xs danger-text" data-act="remove">删除</button>'}
        </div>
      </div>`;
    }).join('');
  }

  function bindList(b) {
    b.querySelectorAll('.mind-card').forEach((card) => {
      const id = card.dataset.id;
      const m = (box.minds || []).find((x) => x.id === id);
      if (!m) return;
      const act = card.querySelector('[data-act="activate"]');
      if (act) act.addEventListener('click', async () => {
        try {
          await api.mindActivate(id);
          await refreshList();
          ctx.refreshMinds && await ctx.refreshMinds();
          toast('已切换生效助手：' + m.name, 'success');
        } catch (err) { toast(err.message, 'error'); }
      });
      card.querySelector('[data-act="edit"]').addEventListener('click', () => openMindEditor(ctx, m, limits, refreshList));
      card.querySelector('[data-act="export"]').addEventListener('click', async () => {
        try {
          const data = await api.mindExport('current');
          data.minds = (data.minds || []).filter((x) => x.name === m.name);
          downloadJson('AI助手-' + m.name, data);
        } catch (err) { toast(err.message, 'error'); }
      });
      const rem = card.querySelector('[data-act="remove"]');
      if (rem) rem.addEventListener('click', async () => {
        const sure = await openConfirm({ title: '删除助手', message: '确定删除「' + m.name + '」？该操作不可恢复。', danger: true, okText: '删除' });
        if (!sure) return;
        try {
          await api.mindRemove(id);
          await refreshList();
          ctx.refreshMinds && await ctx.refreshMinds();
          toast('已删除', 'success');
        } catch (err) { toast(err.message, 'error'); }
      });
    });
  }

  // 关闭主弹窗时把引用交还，避免外部持有过期 DOM
  void close;
}

// ---------------------------------------------------------------- 单个助手编辑器

async function openMindEditor(ctx, mind, limits, onSaved) {
  const L = limits || { text: 500, count: 100, persona: 4000 };
  const isNew = !mind;
  const cur = mind ? JSON.parse(JSON.stringify(mind)) : { name: '', avatar: '', persona: '', memories: [] };
  let avatar = cur.avatar || '';
  const defAvatar = (ctx.mindBox && ctx.mindBox.defaultAvatar) || '/img/avatar-lucy.png';

  openModal({
    title: isNew ? '新建 AI 助手' : '编辑：' + cur.name,
    width: 640,
    footer: false,
    html: `
      <div class="me">
        <div class="me-head">
          <div class="me-avatar" id="meAvatar">${avatarHtml(avatar, defAvatar, 'avatar-md')}</div>
          <div class="me-head-info">
            <label class="field"><span>助手名字</span><input id="meName" value="${esc(cur.name)}" maxlength="24" placeholder="例如：毒舌编辑露西"></label>
            <button class="btn ghost sm" id="meAvatarBtn">换头像</button>
          </div>
        </div>
        <label class="field field-area"><span>助手人设（persona）</span><textarea id="mePersona" rows="3" maxlength="${L.persona}">${esc(cur.persona || '')}</textarea></label>
        <div class="me-mem-head">
          <span>长期记忆条（<b id="meMemCount">${cur.memories.length}</b>/${L.count}，每条≤${L.text}字，单条可开关）</span>
          <button class="btn ghost xs" id="meDistill">从对话一键提炼</button>
        </div>
        <div class="me-mem-list" id="meMemList"></div>
        <button class="btn ghost sm" id="meAddMem">＋ 添加记忆条</button>
        <div class="me-foot">
          <button class="btn ghost" id="meCancel">取消</button>
          <button class="btn primary" id="meSave">保存</button>
        </div>
      </div>
    `,
    onMount(b) {
      const memList = b.querySelector('#meMemList');
      const memCountEl = b.querySelector('#meMemCount');
      const renderMem = () => {
        memList.innerHTML = memHtml();
        bindMem();
        bindAvatarFallback(b);
        if (memCountEl) memCountEl.textContent = String(cur.memories.length);
      };
      const memHtml = () => {
        if (!cur.memories.length) return '<div class="me-mem-empty">还没有记忆条。直接写，或点「从对话一键提炼」。</div>';
        return cur.memories.map((m, i) => `
          <div class="me-mem" data-i="${i}">
            <textarea class="me-mem-text" maxlength="${L.text}" placeholder="一条长期要求，例如：对话要短，少写景">${esc(m.text || '')}</textarea>
            <label class="me-mem-on"><input type="checkbox" ${m.enabled !== false ? 'checked' : ''}> 启用</label>
            <button class="me-mem-del" data-del="${i}" title="删除">✕</button>
          </div>`).join('');
      };
      const bindMem = () => {
        memList.querySelectorAll('.me-mem').forEach((row) => {
          const i = Number(row.dataset.i);
          row.querySelector('.me-mem-text').addEventListener('input', (e) => { cur.memories[i].text = e.target.value; });
          row.querySelector('input[type=checkbox]').addEventListener('change', (e) => { cur.memories[i].enabled = e.target.checked; });
          row.querySelector('[data-del]').addEventListener('click', () => { cur.memories.splice(i, 1); renderMem(); });
        });
      };

      b.querySelector('#meAvatarBtn').addEventListener('click', async () => {
        const picked = await openAvatarEditor(avatar);
        if (picked === undefined || picked === null) return; // 取消
        avatar = picked;
        b.querySelector('#meAvatar').innerHTML = avatarHtml(avatar, defAvatar, 'avatar-md');
        bindAvatarFallback(b);
      });
      b.querySelector('#meAddMem').addEventListener('click', () => {
        if (cur.memories.length >= L.count) { toast('已达上限 ' + L.count + ' 条', 'info'); return; }
        cur.memories.push({ text: '', enabled: true });
        renderMem();
        const rows = memList.querySelectorAll('.me-mem-text');
        if (rows.length) rows[rows.length - 1].focus();
      });
      b.querySelector('#meDistill').addEventListener('click', async () => {
        if (!ctx.projectId) {
          toast('提炼要读某本书的对话：先在左侧打开一本书，再回来点这里', 'info');
          return;
        }
        const current = cur.memories.map((m) => m.text).filter(Boolean);
        // 提炼是非流式的一次请求，模型繁忙时会重试；不给反馈容易被当成「点了没反应」。
        const wait = openAiWaiting({ title: '正在从对话提炼…', hint: '模型繁忙会自动重试，可随时点「停止」' });
        try {
          const lines = await api.mindDistill(ctx.projectId, current, wait.signal);
          wait.close();
          if (!lines || !lines.length) { toast('这段对话里没提炼出可长期记住的要求', 'info'); return; }
          let added = 0;
          lines.forEach((t) => { if (cur.memories.length < L.count) { cur.memories.push({ text: t, enabled: true }); added++; } });
          renderMem();
          toast('已提炼 ' + added + ' 条，确认无误后点「保存」', 'success');
        } catch (err) {
          wait.close();
          if (err && err.name === 'AbortError') { toast('已停止提炼', 'info'); return; }
          toast((err && err.message) || '提炼失败', 'error');
        }
      });
      b.querySelector('#meCancel').addEventListener('click', () => closeModal(b.closest('.modal-mask')));
      b.querySelector('#meSave').addEventListener('click', async () => {
        const name = b.querySelector('#meName').value.trim();
        const persona = b.querySelector('#mePersona').value;
        if (!name) { toast('请填写助手名字', 'info'); return; }
        const memories = cur.memories
          .filter((m) => String(m.text || '').trim())
          .map((m) => ({ text: m.text.trim().slice(0, L.text), enabled: m.enabled !== false }));
        const patch = { name, avatar, persona: persona.slice(0, L.persona), memories };
        try {
          if (isNew) {
            const r = await api.mindCreate(patch);
            await api.mindActivate(r.id);
          } else {
            await api.mindUpdate(cur.id, patch);
          }
          await ctx.refreshMinds();
          if (onSaved) await onSaved();
          closeModal(b.closest('.modal-mask'));
          toast('已保存', 'success');
        } catch (err) { toast(err.message, 'error'); }
      });

      renderMem();
      bindAvatarFallback(b);
    }
  });
}

// ---------------------------------------------------------------- 头像编辑器（emoji + 圆形裁剪）

function openAvatarEditor(current) {
  return new Promise((resolve) => {
    let imgSrc = (current && current.startsWith('data:')) ? current : null;
    let scale = 1, offX = 0, offY = 0;

    openModal({
      title: '选择头像',
      width: 460,
      footer: false,
      html: `
        <div class="av">
          <div class="av-emojis">
            ${ICON_AVATARS.map((e) => `<button class="av-emoji" data-emoji="${e}">${e}</button>`).join('')}
          </div>
          <div class="av-or">或上传图片（自动圆形裁剪）</div>
          <div class="av-crop" id="avCrop">
            ${imgSrc ? `<img class="av-crop-img" id="avImg" src="${esc(imgSrc)}">` : '<div class="av-crop-hint">上传后在此拖动裁剪</div>'}
          </div>
          <input type="range" id="avScale" min="1" max="3" step="0.01" value="1" ${imgSrc ? '' : 'disabled'}>
          <div class="av-row">
            <button class="btn ghost sm" id="avUpload">上传图片</button>
            <input type="file" id="avFile" accept="image/*" hidden>
            <button class="btn ghost sm" id="avClear">清空图片</button>
          </div>
          <div class="av-foot">
            <button class="btn ghost" id="avCancel">取消</button>
            <button class="btn primary" id="avOk">确定</button>
          </div>
        </div>
      `,
      onMount(b) {
        const crop = b.querySelector('#avCrop');
        const scaleEl = b.querySelector('#avScale');

        b.querySelectorAll('.av-emoji').forEach((btn) => btn.addEventListener('click', () => {
          resolve(btn.dataset.emoji);
          closeModal(b.closest('.modal-mask'));
        }));
        b.querySelector('#avUpload').addEventListener('click', () => b.querySelector('#avFile').click());
        b.querySelector('#avFile').addEventListener('change', (e) => {
          const f = e.target.files && e.target.files[0];
          if (!f) return;
          const reader = new FileReader();
          reader.onload = () => {
            imgSrc = reader.result;
            crop.innerHTML = `<img class="av-crop-img" id="avImg" src="${esc(imgSrc)}">`;
            scaleEl.disabled = false;
            scaleEl.value = '1';
            scale = 1; offX = 0; offY = 0;
            bindImg();
          };
          reader.readAsDataURL(f);
          e.target.value = '';
        });
        b.querySelector('#avClear').addEventListener('click', () => {
          imgSrc = null;
          crop.innerHTML = '<div class="av-crop-hint">上传后在此拖动裁剪</div>';
          scaleEl.disabled = true;
        });
        b.querySelector('#avCancel').addEventListener('click', () => { resolve(undefined); closeModal(b.closest('.modal-mask')); });
        b.querySelector('#avOk').addEventListener('click', async () => {
          if (imgSrc) {
            const d = await cropToDataUrl(imgSrc, scale, offX, offY);
            resolve(d || current || '');
          } else {
            resolve(current || '');
          }
          closeModal(b.closest('.modal-mask'));
        });

        function bindImg() {
          const img = b.querySelector('#avImg');
          if (!img) return;
          const apply = () => {
            const size = 200 * scale;
            img.style.width = size + 'px';
            img.style.height = size + 'px';
            img.style.left = offX + 'px';
            img.style.top = offY + 'px';
          };
          img.addEventListener('load', apply);
          if (img.complete) apply();
          scaleEl.addEventListener('input', () => { scale = parseFloat(scaleEl.value); apply(); });
          let dragging = false, sx0 = 0, sy0 = 0, ox0 = 0, oy0 = 0;
          img.addEventListener('mousedown', (e) => { dragging = true; sx0 = e.clientX; sy0 = e.clientY; ox0 = offX; oy0 = offY; });
          window.addEventListener('mousemove', (e) => { if (!dragging) return; offX = ox0 + (e.clientX - sx0); offY = oy0 + (e.clientY - sy0); apply(); });
          window.addEventListener('mouseup', () => { dragging = false; });
          img.addEventListener('touchstart', (e) => { dragging = true; const t = e.touches[0]; sx0 = t.clientX; sy0 = t.clientY; ox0 = offX; oy0 = offY; }, { passive: true });
          img.addEventListener('touchmove', (e) => { if (!dragging) return; const t = e.touches[0]; offX = ox0 + (t.clientX - sx0); offY = oy0 + (t.clientY - sy0); apply(); }, { passive: true });
          img.addEventListener('touchend', () => { dragging = false; });
        }
        if (imgSrc) bindImg();
      }
    });
  });
}

/** 把当前裁剪状态（dataURL + 缩放 + 偏移）输出成 128px 圆形 PNG dataURL */
function cropToDataUrl(src, scale, offX, offY) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const out = 128;
        const W = 200 * scale;
        const H = 200 * scale;
        const cs = Math.max(W / img.naturalWidth, H / img.naturalHeight); // cover 缩放
        const cw = img.naturalWidth * cs;
        const ch = img.naturalHeight * cs;
        const oX0 = (W - cw) / 2;
        const oY0 = (H - ch) / 2;
        const sx = -(oX0 + offX) / cs;
        const sy = -(oY0 + offY) / cs;
        const sw = W / cs;
        const sh = H / cs;
        const c = document.createElement('canvas');
        c.width = out;
        c.height = out;
        const x = c.getContext('2d');
        x.beginPath();
        x.arc(out / 2, out / 2, out / 2, 0, Math.PI * 2);
        x.closePath();
        x.clip();
        x.drawImage(img, sx, sy, sw, sh, 0, 0, out, out);
        resolve(c.toDataURL('image/png'));
      } catch (e) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
