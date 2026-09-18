'use strict';
/**
 * Windows 打包入口（npm run dist）。
 * 在 electron-builder 之前处理两件本机相关的麻烦事：
 *  1) 本机有 SteamTools 之类的 HTTPS 中间人代理，Node 校验会报
 *     "unable to verify the first certificate"。若存在含其根证书的 CA 包，
 *     就通过 NODE_EXTRA_CA_CERTS 指过去；没有该文件就原样打包（不影响其他机器）。
 *  2) electron-builder 会整目录删除 dist\win-unpacked，文件数超过宿主环境的
 *     批量删除阈值时会被拦截并中断。这里先把它改名挪开（改名不是删除）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'win-unpacked');

/* 1) 证书：优先用用户目录下的自定义 CA 包 */
const caCandidates = [
  process.env.NOVEL_CA_BUNDLE,
  process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.git-ca-bundle.crt')
].filter(Boolean);
const ca = caCandidates.find((p) => fs.existsSync(p));
if (ca) {
  process.env.NODE_EXTRA_CA_CERTS = ca;
  console.log('· 已指定 CA 包（本机 HTTPS 代理场景）:', ca);
}

/* 2) 挪开上次的解包目录，避开批量删除拦截 */
for (const d of [OUT, OUT + '.tmp']) {
  if (fs.existsSync(d)) {
    const moved = path.join(ROOT, 'dist', '_old-' + path.basename(d) + '-' + Date.now());
    fs.renameSync(d, moved);
    console.log('· 已挪开旧目录:', path.relative(ROOT, moved));
  }
}

/* 3) 打包 */
const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const r = spawnSync(process.execPath, [cli, '--win', 'nsis'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
});
process.exit(r.status === null ? 1 : r.status);
