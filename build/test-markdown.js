'use strict';
/**
 * 渲染层测试：md()（把助手输出的 Markdown 转成 HTML）
 *  1) 多行段落不能出现字面量 <br>（之前先拼 <br> 再转义，界面上满屏 <br>）
 *  2) ``` 代码块要渲染成 <pre>（AI 下达的 json 操作块就走这里）
 *  3) 原有语法（标题/引用/列表/加粗/行内码）仍正常
 *  4) HTML 注入必须被转义
 *
 * public/js/ui.js 是 ES Module（项目里 Node 默认按 CJS 解析 .js），
 * 所以复制成 .mjs 再动态 import，不改动源码。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };

const PROJ = path.join(__dirname, '..');
const tmp = path.join(os.tmpdir(), `ns-ui-${Date.now()}.mjs`);
fs.copyFileSync(path.join(PROJ, 'public', 'js', 'ui.js'), tmp);

(async () => {
  const { md, esc } = await import(`file://${tmp.replace(/\\/g, '/')}`);

  console.log('== 1. 多行段落 ==');
  const html = md('第一行\n第二行');
  check('换行渲染成真正的 <br>', html.includes('<br>'), html);
  check('没有字面量 <br>（&lt;br&gt;）', !html.includes('&lt;br&gt;'), html);

  console.log('\n== 2. 代码块 ==');
  const withFence = md('先读这几章：\n\n```json\n{"tool":"read_chapter","args":{"chapterId":"c1"}}\n```\n\n然后给我总结。');
  check('渲染出 <pre class="md-pre">', withFence.includes('<pre class="md-pre">'), withFence.slice(0, 160));
  check('代码内容完整保留', withFence.includes('&quot;tool&quot;') || withFence.includes('"tool"'), withFence.slice(0, 200));
  check('代码块的 ``` 标记本身不显示', !withFence.includes('```'), withFence.slice(0, 200));
  check('代码块前后的正文都在', withFence.includes('先读这几章') && withFence.includes('然后给我总结'));
  const twoBlocks = md('```json\n{"a":1}\n```\n```json\n{"b":2}\n```');
  check('连续两个代码块分别成块', (twoBlocks.match(/<pre class="md-pre">/g) || []).length === 2, twoBlocks);

  console.log('\n== 3. 其它语法 ==');
  check('标题', md('## 小标题').includes('<h2>小标题</h2>'));
  check('引用', md('> 一句引用').includes('<blockquote>一句引用</blockquote>'));
  check('无序列表', md('- 甲\n- 乙').includes('<ul><li>甲</li><li>乙</li></ul>'));
  check('有序列表', md('1. 甲\n2. 乙').includes('<ol><li>甲</li><li>乙</li></ol>'));
  check('加粗', md('这是**重点**').includes('<strong>重点</strong>'));
  check('行内代码', md('用 `read_chapter` 读').includes('<code>read_chapter</code>'));
  check('分隔线', md('---').includes('<hr>'));

  console.log('\n== 4. 安全 ==');
  check('HTML 被转义（md）', !md('<script>alert(1)</script>').includes('<script>'), md('<script>alert(1)</script>'));
  check('HTML 被转义（esc）', esc('<img onerror=x>').includes('&lt;img'), esc('<img onerror=x>'));
  check('代码块里的 HTML 也被转义', !md('```\n<b>粗</b>\n```').includes('<b>粗</b>'), md('```\n<b>粗</b>\n```'));

  fs.rmSync(tmp, { force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('测试异常：', err);
  fs.rmSync(tmp, { force: true });
  process.exit(1);
});
