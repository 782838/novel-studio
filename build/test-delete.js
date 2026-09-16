'use strict';
/** 验证「删除作品」：连所有关联数据一起删，且不影响其它作品。用真实数据拷贝测。 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJ = path.join(__dirname, '..');
const USER_DATA = path.join(process.env.APPDATA, '小说创作工作台', 'data');
const DATA = path.join(PROJ, '.testdel');
process.env.NOVEL_DATA_DIR = DATA;

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.copyFileSync(path.join(USER_DATA, 'store.json'), path.join(DATA, 'store.json'));

const PORT = 5407;
const BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [path.join(PROJ, 'server', 'index.js'), String(PORT)],
  { env: { ...process.env }, stdio: 'ignore' });

(async () => {
  await new Promise((r) => setTimeout(r, 1500));
  const before = JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8'));
  const victim = before.projects.map((p) => ({ p, n: before.chapters.filter((c) => c.projectId === p.id).length }))
    .sort((a, b) => b.n - a.n)[0]; // 删章节最多的那部（105 章的「1-10」）
  console.log(`[删除目标]「${victim.p.title}」 ${victim.n} 章`);

  const res = await fetch(`${BASE}/api/projects/${victim.p.id}`, { method: 'DELETE' });
  check('DELETE 返回 200', res.status === 200, 'status=' + res.status);

  await new Promise((r) => setTimeout(r, 500)); // 等防抖写盘
  const after = JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8'));
  check('作品数 -1', after.projects.length === before.projects.length - 1);
  check('该作品的章节全部删除', after.chapters.every((c) => c.projectId !== victim.p.id));
  check('该作品的大纲/角色/线路/伏笔/备忘/消息全部删除',
    ['outline', 'characters', 'relations', 'lines', 'beats', 'world', 'foreshadow', 'notes', 'messages', 'materials']
      .every((c) => after[c].every((x) => x.projectId !== victim.p.id)));
  const others = before.projects.filter((p) => p.id !== victim.p.id).map((p) => p.id);
  check('其它作品还在', others.every((id) => after.projects.some((p) => p.id === id)));
  // 除被删作品外，任何集合的数据一条都不能少（其它作品本来可能就是 0 章）
  // 注意：projects 记录没有 projectId 字段，要用 id 过滤
  const intact = ['projects', 'outline', 'characters', 'relations', 'lines', 'beats', 'chapters',
    'world', 'foreshadow', 'notes', 'messages', 'materials'].every((c) => {
    const want = (before[c] || []).filter((x) => (c === 'projects' ? x.id : x.projectId) !== victim.p.id).length;
    return (after[c] || []).length === want;
  });
  check('其它作品的数据一条不少', intact);

  srv.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
