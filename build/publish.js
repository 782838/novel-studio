'use strict';
/**
 * 一键发布到 GitHub：
 *   1) 校验 token 并取得账号
 *   2) 创建公开仓库（已存在则复用）
 *   3) 推送 main 分支
 *   4) 打 tag v<version> 并推送
 *   5) 创建 Release，并把 dist 里的安装包作为附件上传
 *
 * 用法（token 只用于本次运行，不会写进 .git/config）：
 *   GITHUB_TOKEN=ghp_xxx node build/publish.js
 *   或  node build/publish.js ghp_xxx
 *
 * 可选环境变量：
 *   REPO_NAME   仓库名，默认 novel-studio
 *   REPO_DESC   仓库描述
 *   SKIP_RELEASE=1  只推代码，不发 Release
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const GIT = process.env.GIT_BIN
  || 'C:/Users/35546/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd/git.exe';

const TOKEN = process.env.GITHUB_TOKEN || process.argv[2];
const REPO = process.env.REPO_NAME || 'novel-studio';
const DESC = process.env.REPO_DESC || '本地运行的小说辅助创作工作台：大纲/角色/线路/章节/伏笔一站管理，AI 助手可直接读写项目数据。零依赖，数据全部留在本机。';
const SKIP_RELEASE = process.env.SKIP_RELEASE === '1';

if (!TOKEN) {
  console.error('缺少 token。用法：GITHUB_TOKEN=ghp_xxx node build/publish.js');
  process.exit(1);
}

const API = 'https://api.github.com';
const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'novel-studio-publisher'
};

/** 任何输出前先把 token 抹掉，避免它出现在日志/报错里 */
const redact = (s) => String(s == null ? '' : s).split(TOKEN).join('***');

function git(args, opts = {}) {
  const r = spawnSync(GIT, args, { cwd: ROOT, encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    throw new Error(`git ${args.map(redact).join(' ')} 失败：\n${redact(r.stderr || r.stdout).trim()}`);
  }
  return (r.stdout || '').trim();
}

async function api(method, url, body) {
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* 非 JSON */ }
  return { status: res.status, json, text };
}

(async () => {
  // 0) 前置检查
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const tag = `v${version}`;

  console.log('== 0. 检查本地仓库 ==');
  const status = git(['status', '--short']);
  if (status) {
    console.log('  ! 工作区有未提交改动，请先提交：\n' + status);
    process.exit(1);
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  console.log(`  分支 ${branch}，版本 ${version}，工作区干净`);

  // 1) 校验 token
  console.log('\n== 1. 校验 token ==');
  const me = await api('GET', '/user');
  if (me.status !== 200) {
    console.error(`  ✗ token 无效或无权限（HTTP ${me.status}）：${me.json && me.json.message}`);
    process.exit(1);
  }
  const owner = me.json.login;
  console.log(`  ✓ 已认证为 ${owner}${me.json.name ? `（${me.json.name}）` : ''}`);

  // 2) 创建仓库
  console.log('\n== 2. 创建仓库 ==');
  const created = await api('POST', '/user/repos', {
    name: REPO,
    description: DESC,
    private: false,
    has_issues: true,
    has_wiki: false,
    has_projects: false,
    auto_init: false,
    license_template: 'mit'
  });
  if (created.status === 201) {
    console.log(`  ✓ 已创建公开仓库 ${owner}/${REPO}`);
  } else if (created.status === 422) {
    console.log(`  · 仓库 ${owner}/${REPO} 已存在，复用`);
  } else {
    console.error(`  ✗ 创建失败（HTTP ${created.status}）：${created.json && created.json.message}`);
    console.error('    若 token 缺少 repo 权限，请在生成 token 时勾选 "repo" 与 "workflow"。');
    process.exit(1);
  }
  const repoUrl = `https://github.com/${owner}/${REPO}`;

  // 3) 推送代码（token 只在这一次命令里出现，不落盘）
  console.log('\n== 3. 推送代码 ==');
  const pushUrl = `https://x-access-token:${TOKEN}@github.com/${owner}/${REPO}.git`;
  git(['-c', 'credential.helper=', 'push', pushUrl, `${branch}:main`, '--force']);
  // 建立一个不带 token 的 origin，方便以后自己推
  try {
    const remotes = git(['remote']);
    if (remotes.split('\n').includes('origin')) git(['remote', 'set-url', 'origin', `${repoUrl}.git`]);
    else git(['remote', 'add', 'origin', `${repoUrl}.git`]);
  } catch (_) { /* 无所谓 */ }
  console.log(`  ✓ 已推送 ${branch} → main`);
  git(['config', 'branch.main.remote', 'origin']);
  git(['config', 'branch.main.merge', 'refs/heads/main']);

  // 4) 打 tag
  console.log('\n== 4. 打标签 ==');
  const tags = git(['tag']).split('\n');
  if (!tags.includes(tag)) {
    git(['tag', '-a', tag, '-m', `Release ${tag}`]);
    console.log(`  · 已本地创建 ${tag}`);
  } else {
    console.log(`  · ${tag} 已存在`);
  }
  git(['-c', 'credential.helper=', 'push', pushUrl, tag]);
  console.log(`  ✓ 已推送 ${tag}`);

  if (SKIP_RELEASE) {
    console.log(`\n完成（已跳过 Release）：${repoUrl}`);
    return;
  }

  // 5) 创建 Release（说明文字 = 固定头部 + CHANGELOG 对应版本段落）
  console.log('\n== 5. 创建 Release ==');
  const changelogPath = path.join(ROOT, 'CHANGELOG.md');
  const changelog = fs.existsSync(changelogPath)
    ? fs.readFileSync(changelogPath, 'utf8').trim()
    : `## v${version}\n\n- 详见仓库 CHANGELOG.md`;
  const releaseBody = [
    `## 小说创作工作台 v${version}`,
    '',
    '本地运行的小说辅助创作工具：**零依赖、无需构建**，数据全部留在本机。',
    '',
    '### 下载安装',
    '- 见下方 Assets 中的 `novel-studio-setup-' + version + '.exe`（约 106 MB）',
    '- 双击安装，按用户安装、不需要管理员权限；数据存 `%APPDATA%\\小说创作工作台\\data\\`',
    '- **覆盖升级不丢数据**：旧版本装的数据会原样保留',
    '- 注：GitHub API 会把非 ASCII 附件名损坏成乱码，故安装包统一用英文文件名发布',
    '',
    '### 更新日志',
    '',
    changelog,
    '',
    '### 从源码运行',
    '```bash',
    'node server/index.js 5367            # 写作端',
    'node server/index.js 5368 --data=.demo --seed   # 展示端',
    '```',
    '',
    '完整功能说明见 [docs/功能解析.md](docs/功能解析.md)。',
    '',
    'MIT License.'
  ].join('\n');
  let rel = await api('POST', `/repos/${owner}/${REPO}/releases`, {
    tag_name: tag,
    name: `${tag} · 小说创作工作台`,
    body: releaseBody
  });
  if (rel.status === 201) console.log(`  ✓ Release 已创建：${rel.json.html_url}`);
  else if (rel.status === 422) {
    console.log('  · Release 已存在，改为查找并复用');
    const found = await api('GET', `/repos/${owner}/${REPO}/releases/tags/${tag}`);
    rel = found;
    // 复用时把标题/说明刷新为最新模板（含最新 CHANGELOG 与正确的附件名）
    const upd = await api('PATCH', `/repos/${owner}/${REPO}/releases/${found.json.id}`, {
      name: `${tag} · 小说创作工作台`,
      body: releaseBody
    });
    if (upd.status === 200) console.log('  · 已刷新 Release 说明为最新内容');
    else console.log(`  ! 刷新 Release 说明失败（HTTP ${upd.status}），保留旧说明`);
  } else {
    console.error(`  ✗ 创建 Release 失败（HTTP ${rel.status}）：${rel.json && rel.json.message}`);
    process.exit(1);
  }
  const release = rel.json;

  // 6) 上传安装包
  // 坑（已实测）：GitHub API 会把附件名里的非 ASCII 字符规范化成乱码——
  // 「小说创作工作台-安装包-1.1.1-setup.exe」无论走 URL query 还是 JSON body（含 \uXXXX 转义），
  // 都会被存成「-.-1.1.1-setup.exe」。这是 GitHub 服务端行为，绕不过。
  // 所以公开发布名统一用纯 ASCII：novel-studio-setup-<版本>.exe；本地 dist 里的中文文件名不受影响。
  const distDir = path.join(ROOT, 'dist');
  const localExes = fs.existsSync(distDir)
    ? fs.readdirSync(distDir).filter((f) => f.endsWith('.exe'))
    : [];
  const publicNameOf = (local) => {
    const m = local.match(/([\d.]+)-setup\.exe$/);
    return m ? `novel-studio-setup-${m[1]}.exe` : local.replace(/[^\x20-\x7E]/g, '_');
  };
  if (!localExes.length) {
    console.log('\n== 6. 上传安装包 ==');
    console.log('  · dist 下没有 .exe，跳过（可先运行 npm run dist）');
  } else {
    console.log('\n== 6. 上传安装包 ==');
    for (const local of localExes) {
      const full = path.join(distDir, local);
      const size = fs.statSync(full).size;
      const publicName = publicNameOf(local);
      const live = release.assets || [];
      if (live.some((a) => a.name === publicName)) { console.log(`  · ${publicName} 已存在，跳过`); continue; }
      // 之前上传过但名字被损坏的（大小一致）→ 只改名，不重复上传
      const mangled = live.find((a) => a.size === size && a.name !== publicName);
      if (mangled) {
        const fixed = await api('PATCH', `/repos/${owner}/${REPO}/releases/assets/${mangled.id}`, { name: publicName });
        if (fixed.status === 200 && fixed.json && fixed.json.name === publicName) console.log(`  · 已修正附件名：${mangled.name} → ${publicName}`);
        else console.log(`  ! 修正附件名失败，仍是 ${mangled.name}`);
        continue;
      }
      process.stdout.write(`  上传 ${local} → ${publicName}（${(size / 1048576).toFixed(1)} MB）…`);
      const up = await fetch(
        `https://uploads.github.com/repos/${owner}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(publicName)}`,
        {
          method: 'POST',
          headers: { ...H, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
          body: fs.createReadStream(full),
          duplex: 'half'
        }
      );
      if (up.status !== 201) {
        console.log(` 失败（HTTP ${up.status}）：${(await up.text()).slice(0, 200)}`);
        continue;
      }
      const asset = await up.json();
      if (asset.name === publicName) console.log(' 完成');
      else console.log(` 完成，但附件名被 GitHub 存成了 ${asset.name}`);
    }
  }

  // 7) 顺手修正历史 Release 的乱码附件名（GitHub API 会把非 ASCII 名存成乱码，如「-.-1.0.0-setup.exe」）
  console.log('\n== 7. 检查历史 Release 附件名 ==');
  const rels = await api('GET', `/repos/${owner}/${REPO}/releases?per_page=20`);
  if (rels.status === 200 && Array.isArray(rels.json)) {
    let fixedCount = 0;
    for (const r of rels.json) {
      for (const a of r.assets || []) {
        const m = a.name.match(/([\d.]+)-setup\.exe$/) || a.name.match(/setup-([\d.]+)\.exe$/);
        const ver = m && m[1];
        const proper = ver ? `novel-studio-setup-${ver}.exe` : null;
        if (proper && a.name !== proper) {
          const fixed = await api('PATCH', `/repos/${owner}/${REPO}/releases/assets/${a.id}`, { name: proper });
          if (fixed.status === 200 && fixed.json && fixed.json.name === proper) { console.log(`  ✓ ${r.tag_name}: ${a.name} → ${proper}`); fixedCount++; }
          else console.log(`  ! ${r.tag_name}: 修正 ${a.name} 失败（HTTP ${fixed.status}）`);
        }
      }
    }
    if (!fixedCount) console.log('  · 历史附件名都正常');
  } else {
    console.log('  · 跳过（无法列出 Release）');
  }

  console.log(`\n全部完成：${release.html_url}`);
})().catch((e) => {
  console.error('\n发布失败：', redact(e.message));
  process.exit(1);
});
