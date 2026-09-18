'use strict';
/**
 * e2e-update 专用 preload：把 GitHub Release 接口换成可控的假数据。
 * 必须用 contextIsolation:false 的窗口加载，这样改写的是页面里的 window.fetch。
 *
 * 通过 window.__updStub 控制返回：
 *   { mode: 'ok', tag: 'v9.9.9', body: '...', asset: 'xxx.exe' }   正常返回
 *   { mode: 'fail' }   模拟断网
 *   { mode: 'slow' }   模拟超时（AbortError）
 */
const realFetch = window.fetch.bind(window);

window.__updStub = { mode: 'ok', tag: 'v9.9.9' };

window.fetch = function (url, opts) {
  const u = String(url || '');
  if (!u.includes('api.github.com')) return realFetch(url, opts);

  const s = window.__updStub || {};
  if (s.mode === 'fail') return Promise.reject(new TypeError('Failed to fetch'));
  if (s.mode === 'slow') {
    return new Promise((_, reject) => {
      setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 60);
    });
  }
  const tag = s.tag || 'v9.9.9';
  const body = {
    tag_name: tag,
    name: s.name || `${tag} · 小说创作工作台`,
    body: s.body === undefined ? '### 新增\n- 假更新说明：修了三个 bug' : s.body,
    html_url: `https://github.com/782838/novel-studio/releases/tag/${tag}`,
    published_at: s.published || '2026-09-18T12:00:00Z',
    assets: s.asset === null ? [] : [{
      name: s.asset || 'novel-studio-setup-9.9.9.exe',
      browser_download_url: `https://github.com/782838/novel-studio/releases/download/${tag}/${s.asset || 'novel-studio-setup-9.9.9.exe'}`
    }]
  };
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  }));
};
