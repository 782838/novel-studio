'use strict';
/**
 * 版本检测：启动时自动查一次最新 Release，也支持手动检测。
 *
 * 走渲染进程的 fetch 而不是服务端请求 —— Chromium 用系统证书库，
 * 在本机（有 SteamTools 之类的 HTTPS 中间人）也能正常校验证书；
 * Node 自带 CA 包在同样环境下会报 unable to verify the first certificate。
 */
import { esc, openModal, toast } from './ui.js';

const REPO = '782838/novel-studio';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const PAGE = `https://github.com/${REPO}/releases`;
const SKIP_KEY = 'ns_skip_update_version';
const TIMEOUT = 8000;

/** 语义化版本比较：a > b 返回 1，a < b 返回 -1，相等返回 0 */
export function cmpVersion(a, b) {
  const pa = String(a == null ? '' : a).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b == null ? '' : b).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 拉取 GitHub 最新 Release（失败抛错，调用方负责兜底） */
async function fetchLatest() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(API, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
      signal: ctl.signal
    });
    if (!res.ok) {
      throw new Error(res.status === 404 ? '仓库还没有发布过版本' : `GitHub 返回 ${res.status}`);
    }
    const j = await res.json();
    const tag = String(j.tag_name || j.name || '').trim();
    const assets = Array.isArray(j.assets) ? j.assets : [];
    const exe = assets.find((a) => /\.exe$/i.test(a.name || '')) || null;
    return {
      tag,
      latest: tag.replace(/^v/i, ''),
      title: j.name || tag,
      notes: String(j.body || '').trim(),
      url: j.html_url || PAGE,
      assetUrl: exe ? exe.browser_download_url : '',
      assetName: exe ? exe.name : '',
      publishedAt: j.published_at || ''
    };
  } catch (err) {
    if (err && (err.name === 'AbortError' || /aborted/i.test(err.message || ''))) throw new Error('联网超时，请检查网络后重试');
    if (err && /Failed to fetch|NetworkError|fetch failed/i.test(err.message || '')) throw new Error('无法连接 GitHub，请检查网络');
    throw new Error((err && err.message) || '检测失败');
  } finally {
    clearTimeout(timer);
  }
}

/** 只做检测（不改界面）：便于测试与复用 */
export async function checkForUpdate(current) {
  try {
    const info = await fetchLatest();
    return { ...info, ok: true, current, hasUpdate: cmpVersion(info.latest, current) > 0 };
  } catch (err) {
    return { ok: false, current, error: (err && err.message) || '检测失败' };
  }
}

const readSkip = () => {
  try { return localStorage.getItem(SKIP_KEY) || ''; } catch (_) { return ''; }
};
const writeSkip = (v) => {
  try { localStorage.setItem(SKIP_KEY, String(v || '')); } catch (_) { /* 忽略 */ }
};

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 新版本详情弹窗 */
export function openUpdateDialog(info, current) {
  openModal({
    title: '发现新版本',
    subtitle: `v${info.latest}`,
    width: 580,
    html: `
      <div class="upd-box">
        <div class="upd-line"><span>当前版本</span><b>v${esc(current)}</b></div>
        <div class="upd-line"><span>最新版本</span><b class="upd-new">v${esc(info.latest)}</b></div>
        ${info.publishedAt ? `<div class="upd-line"><span>发布时间</span><b>${esc(fmtDate(info.publishedAt))}</b></div>` : ''}
        ${info.assetName ? `<div class="upd-line"><span>安装包</span><b>${esc(info.assetName)}</b></div>` : ''}
        <div class="upd-notes">${esc(info.notes || '（这次发布没有填写更新说明，可前往发布页查看）')}</div>
      </div>`,
    buttons: [
      { label: '跳过此版本', kind: 'ghost', keepOpen: true, onClick: () => {
        writeSkip(info.latest);
        toast(`已跳过 v${info.latest}，下次启动不再提示`, 'info');
      } },
      { label: '前往下载', kind: 'primary', keepOpen: true, onClick: () => {
        window.open(info.assetUrl || info.url, '_blank');
        toast('已在浏览器中打开下载页', 'success');
      } },
      { label: '关闭', kind: 'ghost' }
    ]
  });
}

/**
 * 绑定顶栏「检测更新」按钮，并在启动时自动检测一次。
 * @param {{current:string, keepQuiet?:boolean}} opt
 */
export function initUpdate({ current = '0.0.0', keepQuiet = false } = {}) {
  const btn = document.getElementById('btnUpdate');
  const state = { current, checking: false, last: null, autoChecked: false };

  const paint = (info) => {
    if (!btn) return;
    if (info && info.ok && info.hasUpdate) {
      btn.textContent = `⬆ 新版本 ${info.latest}`;
      btn.classList.add('has-update');
      btn.title = `发现新版本 v${info.latest}（当前 v${current}）· 点击查看`;
    } else {
      btn.textContent = '检测更新';
      btn.classList.remove('has-update');
      btn.title = `当前版本 v${current} · 点击检测是否有新版本`;
    }
  };

  const run = async ({ silent = false } = {}) => {
    state.checking = true;
    if (btn) {
      btn.disabled = true;
      if (!silent) btn.textContent = '检测中…';
    }
    const info = await checkForUpdate(current);
    state.checking = false;
    state.last = info;
    if (btn) btn.disabled = false;
    paint(info);

    if (!info.ok) {
      if (!silent) toast(`检测失败：${info.error}`, 'error', 4200);
      return info;
    }
    if (info.hasUpdate) {
      // 自动检测时：被「跳过此版本」的版本不再打扰
      if (!silent) toast(`发现新版本 v${info.latest}`, 'success', 4200);
      else if (readSkip() !== info.latest) toast(`发现新版本 v${info.latest}，点右上角查看`, 'success', 5200);
    } else if (!silent) {
      toast(`已是最新版本 v${current}`, 'success');
    }
    return info;
  };

  if (btn) {
    paint(null);
    btn.addEventListener('click', () => {
      const info = state.last;
      if (!state.checking && info && info.ok && info.hasUpdate) openUpdateDialog(info, current);
      else run({ silent: false }).then((r) => { if (r.ok && r.hasUpdate) openUpdateDialog(r, current); });
    });
  }

  // 启动自动检测：不阻塞界面、失败也不打扰
  const auto = (async () => {
    state.autoChecked = true;
    await run({ silent: true });
    return state.last;
  })();

  return { state, run, auto, openDialog: (info) => openUpdateDialog(info || state.last, current), keepQuiet };
}
