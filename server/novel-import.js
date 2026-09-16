'use strict';
/**
 * TXT 小说解析：把纯文本切分为章节，并提取章节元信息。
 * 同时供「分章预览」与「导入归档」两个接口复用。
 */

const CN = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };

/** 中文 / 阿拉伯数字章号转整数 */
function cnToNumber(s) {
  s = String(s).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let total = 0, num = 0;
  for (const ch of s) {
    if (CN[ch] !== undefined) num = num * 10 + CN[ch];
    else if (ch === '十') { total += (num || 1) * 10; num = 0; }
    else if (ch === '百') { total += (num || 1) * 100; num = 0; }
    else if (ch === '千') { total += (num || 1) * 1000; num = 0; }
    else if (ch === '万') { total = total * 10000 + num * 10000; num = 0; }
    else return NaN; // 含无法识别字符
  }
  total += num;
  return total;
}

const NUM_CHARS = '0-9零一二三四五六七八九十百千两〇';
const NUM_RE = new RegExp(`^\\s*第\\s*([${NUM_CHARS}]+)\\s*(章|卷|回|节|篇|部|幕)\\s*[：:．.、\\-—]?\\s*(.*)$`);
const CHAP_RE = /^[Cc]hapter\s+([0-9]+)\s*[：:.\-—]?\s*(.*)$/;
const SPECIAL = new Set([
  '序章', '序言', '楔子', '引子', '前言', '后记', '後记', '终章', '終章',
  '尾声', '尾聲', '番外', '附录', '附錄', '序幕', '卷首语', '卷首語',
  '作者的话', '作者语', '后记感言', '内容简介', '简介'
]);

function isHeading(line) {
  const t = line.trim();
  if (!t) return null;
  let m = NUM_RE.exec(t);
  if (m) {
    const num = cnToNumber(m[1]);
    if (!Number.isNaN(num)) return { kind: 'num', num, label: m[2], title: (m[3] || '').trim() };
  }
  m = CHAP_RE.exec(t);
  if (m) return { kind: 'num', num: parseInt(m[1], 10), label: '章', title: (m[2] || '').trim() };
  const base = t.split(/[\s：:]/)[0];
  if (SPECIAL.has(base)) return { kind: 'special', title: t };
  return null;
}

function wordCount(s) {
  return String(s).replace(/\s/g, '').length;
}

/**
 * 把整本小说切成章节。
 * @returns {Array<{index,title,num,kind,content,words}>}
 */
function detectChapters(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const h = isHeading(lines[i]);
    if (h) heads.push({ line: i, ...h });
  }

  let chapters = [];
  if (heads.length) {
    for (let k = 0; k < heads.length; k++) {
      const h = heads[k];
      const start = h.line + 1;
      const end = k + 1 < heads.length ? heads[k + 1].line : lines.length;
      const body = lines.slice(start, end).join('\n');
      let title = h.title;
      // 标题为空时，用紧随其后的第一行非空内容作标题
      if (!title) {
        const rest = lines.slice(start, end);
        const nxt = rest.find((l) => l.trim());
        if (nxt) title = nxt.trim().slice(0, 40);
      }
      const content = body.replace(/\n{3,}/g, '\n\n').trim();
      if (!content) continue; // 跳过空章节（例如只有卷名没有正文）
      chapters.push({
        title: title || `第 ${h.num || (k + 1)} ${h.label || '节'}`,
        num: h.kind === 'num' ? h.num : 0,
        kind: h.kind,
        content
      });
    }
  }

  if (!chapters.length) {
    const content = String(text).replace(/\r\n/g, '\n').trim();
    if (!content) return [];
    chapters = [{ title: '正文', num: 1, kind: 'num', content }];
  }

  return chapters.map((c, i) => ({ index: i + 1, ...c, words: wordCount(c.content) }));
}

/** 取开头 + 中段样本，用于在有限 token 内尽量看清人物与基调 */
function summarize(text, max = 6000) {
  const t = String(text).replace(/\r\n/g, '\n');
  const lines = t.split('\n');
  const head = lines.slice(0, 240).join('\n');
  const midStart = Math.floor(lines.length * 0.4);
  const mid = lines.slice(midStart, midStart + 90).join('\n');
  const combined = `${head}\n\n……（中段节选）……\n\n${mid}`;
  return combined.length > max ? combined.slice(0, max) : combined;
}

module.exports = { cnToNumber, detectChapters, summarize, wordCount };
