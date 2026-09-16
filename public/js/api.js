'use strict';

/* ---------------- 通用取值 ---------------- */
function req(url, options = {}) {
  const opts = { headers: { 'Content-Type': 'application/json' }, ...options };
  if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  return fetch(url, opts).then(async (res) => {
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* 非 JSON */ }
    if (!res.ok) throw new Error((json && json.error) || `请求失败 ${res.status}`);
    return json;
  });
}

const get = (url) => req(url);
const post = (url, body) => req(url, { method: 'POST', body });
const patch = (url, body) => req(url, { method: 'PATCH', body });
const put = (url, body) => req(url, { method: 'PUT', body });
const del = (url) => req(url, { method: 'DELETE' });

/* ---------------- API ---------------- */
export default {
  meta: () => get('/api/meta'),

  settings: () => get('/api/settings'),
  saveSettings: (body) => put('/api/settings', body),

  projects: () => get('/api/projects'),
  createProject: (body) => post('/api/projects', body),
  getProject: (id) => get(`/api/projects/${id}`),
  patchProject: (id, body) => patch(`/api/projects/${id}`, body),
  deleteProject: (id) => del(`/api/projects/${id}`),
  duplicateProject: (id, body = {}) => post(`/api/projects/${id}/duplicate`, body),
  exportProject: (id, format = 'json') => get(`/api/projects/${id}/export?format=${format}`),
  importProject: (bundle) => post('/api/projects/import', { bundle }),
  previewNovel: (body) => post('/api/novel/preview', body),
  importNovel: (body) => post('/api/projects/import/novel', body),
  previewNovelBatch: (files) => post('/api/novel/preview/batch', { files }),
  importNovelBatch: (payload) => post('/api/projects/import/novel/batch', payload),
  importNovelMerge: (payload) => post('/api/projects/import/novel/merge', payload),
  seedSample: () => post('/api/sample'),
  importMaterials: (pid, items, source) => post(`/api/projects/${pid}/materials/import`, { items, source }),

  create: (pid, coll, body) => post(`/api/projects/${pid}/${coll}`, body),
  patchItem: (coll, id, body) => patch(`/api/${coll}/${id}`, body),
  removeItem: (coll, id) => del(`/api/${coll}/${id}`),

  aiTest: () => post('/api/ai/test'),
  aiChat: (projectId, message, chapterId) => post('/api/ai/chat', { projectId, message, chapterId }),
  aiGenerate: (projectId, kind, params) => post('/api/ai/generate', { projectId, kind, params }),
  aiContinue: (projectId, chapterId, instruction, words) =>
    post('/api/ai/continue', { projectId, chapterId, instruction, words }),
  aiContext: (projectId) => get(`/api/ai/context/${projectId}`),
  clearMessages: (pid) => del(`/api/projects/${pid}/messages`)
};
