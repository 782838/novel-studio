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

function git(args, opts = {}) {
  const r = spawnSync(GIT, args, { cwd: ROOT, encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：\n${(r.stderr || r.stdout || '').trim()}`);
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

  // 5) 创建 Release
  console.log('\n== 5. 创建 Release ==');
  let rel = await api('POST', `/repos/${owner}/${REPO}/releases`, {
    tag_name: tag,
    name: `${tag} · 小说创作工作台`,
    body: [
      '## 小说创作工作台 v' + version,
      '',
      '本地运行的小说辅助创作工具：**零依赖、无需构建**，数据全部留在本机。',
      '',
      '### 亮点',
      '- 九个模块（总览 / 大纲 / 角色集 / 线路 / 章节 / 设定 / 伏笔 / 备忘 / 素材箱），靠"关联"串成一体',
      '- AI 助手 14 个工具，可直接改写大纲、补节拍、建角色；支持原生 function calling / JSON 协议 / 演示模式三重降级',
      '- 小说 TXT 批量导入（最多 20 个）：自动分章，可各自归档或合并为一本（每文件一卷），逐本进度 + 失败重试',
      '- Windows 桌面安装包：目标电脑无需 Node、无需浏览器',
      '',
      '### 下载',
      '- 见下方 Assets 中的 `小说创作工作台-安装包-' + version + '-setup.exe`（约 106 MB）',
      '- 双击安装，按用户安装、不需要管理员权限；数据存 `%APPDATA%\\小说创作工作台\\data\\`',
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
    ].join('\n')
  });
  if (rel.status === 201) console.log(`  ✓ Release 已创建：${rel.json.html_url}`);
  else if (rel.status === 422) {
    console.log('  · Release 已存在，改为查找并复用');
    const found = await api('GET', `/repos/${owner}/${REPO}/releases/tags/${tag}`);
    rel = found;
  } else {
    console.error(`  ✗ 创建 Release 失败（HTTP ${rel.status}）：${rel.json && rel.json.message}`);
    process.exit(1);
  }
  const release = rel.json;

  // 6) 上传安装包
  const distDir = path.join(ROOT, 'dist');
  const assets = fs.existsSync(distDir)
    ? fs.readdirSync(distDir).filter((f) => f.endsWith('.exe'))
    : [];
  if (!assets.length) {
    console.log('\n== 6. 上传安装包 ==');
    console.log('  · dist 下没有 .exe，跳过（可先运行 npm run dist）');
  } else {
    console.log('\n== 6. 上传安装包 ==');
    const existing = (release.assets || []).map((a) => a.name);
    for (const name of assets) {
      const full = path.join(distDir, name);
      const size = fs.statSync(full).size;
      if (existing.includes(name)) { console.log(`  · ${name} 已存在，跳过`); continue; }
      process.stdout.write(`  上传 ${name}（${(size / 1048576).toFixed(1)} MB）…`);
      const up = await fetch(
        `https://uploads.github.com/repos/${owner}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
        {
          method: 'POST',
          headers: { ...H, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
          body: fs.createReadStream(full),
          duplex: 'half'
        }
      );
      if (up.status === 201) console.log(' 完成');
      else console.log(` 失败（HTTP ${up.status}）：${(await up.text()).slice(0, 200)}`);
    }
  }

  console.log(`\n全部完成：${release.html_url}`);
})().catch((e) => {
  console.error('\n发布失败：', e.message);
  process.exit(1);
});
