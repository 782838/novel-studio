'use strict';
/**
 * 外部对话素材解析器。
 * 兼容三种输入：JSON（多种导出格式）、Markdown、纯文本。
 * 统一产出 [{title, source, content, messageCount}]
 */

const USER_ROLES = ['user', 'human', 'me', '我', '你'];

/** 常见的角色行写法：### 用户：  **You:**  用户：  我： */
const ROLE_LINE = /^\s*(?:[#*>~\-]*\s*)?\*{0,2}(user|human|you|me|我|你|用户|人类|提问|问|assistant|ai|gpt|bot|glm|chatglm|claude|助手|回答|答)\*{0,2}\s*[:：]\s*(.*)$/i;

function cleanText(s) {
  return String(s == null ? '' : s)
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function roleLabel(role) {
  const r = String(role).toLowerCase();
  if (USER_ROLES.some((u) => String(u).toLowerCase() === r)) return '我';
  return 'AI';
}

function renderConversation(messages) {
  return messages.map((m) => `**${roleLabel(m.role)}**：${cleanText(m.content)}`).join('\n\n');
}

/** 尝试把任意形状的对象还原成 {title, messages}[] —— 递归兜底 */
function normalizeJSON(data, source) {
  const conversations = [];

  const looksLikeMessage = (o) => o && typeof o === 'object' && ('role' in o || 'sender' in o || 'author' in o || 'from' in o)
    && (typeof o.content === 'string' || typeof o.text === 'string' || typeof o.message === 'string' || Array.isArray(o.content));

  const extractContent = (o) => {
    if (typeof o.content === 'string') return o.content;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.message === 'string') return o.message;
    if (Array.isArray(o.content)) {
      return o.content.map((c) => (typeof c === 'string' ? c : (c && (c.text || c.content)) || '')).join('');
    }
    if (o.parts && Array.isArray(o.parts)) return o.parts.map((p) => p.text || p.content || '').join('');
    return '';
  };

  const normalizeMessage = (o) => {
    let role = o.role || o.sender || o.author || o.from || 'user';
    role = String(role).toLowerCase();
    if (/assistant|ai|model|bot|glm|chatglm|gpt|助手/.test(role)) role = 'assistant';
    else role = 'user';
    return { role, content: cleanText(extractContent(o)) };
  };

  let handled = false;

  // 情形 1：直接是消息数组
  if (Array.isArray(data) && data.length && data.every(looksLikeMessage)) {
    conversations.push({ title: '未命名对话', messages: data.map(normalizeMessage) });
    handled = true;
  }

  // 情形 2：对象或数组里包着一个或多个会话，可多层嵌套
  if (!handled) {
    const containers = [];
    const walk = (node, depth) => {
      if (depth > 4 || !node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        if (node.length && node.every(looksLikeMessage)) { containers.push({ messages: node }); return; }
        node.forEach((n) => walk(n, depth + 1));
        return;
      }
      const convKeys = ['messages', 'chat_messages', 'conversation', 'turns', 'dialogue'];
      if (convKeys.some((k) => Array.isArray(node[k]) && node[k].some(looksLikeMessage))) containers.push(node);
      else {
        ['conversations', 'chats', 'data', 'list', 'items', 'history', 'records'].forEach((k) => {
          if (Array.isArray(node[k])) node[k].forEach((n) => walk(n, depth + 1));
        });
      }
    };
    walk(data, 0);

    containers.forEach((obj, i) => {
      const msgs = []
        .concat(obj.messages || obj.chat_messages || obj.conversation || obj.turns || obj.dialogue || [])
        .filter(looksLikeMessage)
        .map(normalizeMessage);
      if (!msgs.length) return;
      conversations.push({
        title: String(obj.title || obj.name || obj.summary || obj.topic || `对话 ${i + 1}`).slice(0, 80),
        messages: msgs
      });
    });

    // 情形 3：单个对话对象（containers 没兜住时）
    if (!conversations.length) {
      const msgs = []
        .concat(data.messages || data.chat_messages || data.conversation || data.turns || data.dialogue || [])
        .filter(looksLikeMessage)
        .map(normalizeMessage);
      if (msgs.length) conversations.push({ title: String(data.title || '导入的对话').slice(0, 80), messages: msgs });
    }
  }

  // 去重（标题 + 首条内容相同视为重复），再统一转成可导入结构
  const seen = new Set();
  return conversations.filter((c) => {
    const key = `${c.title}|${(c.messages[0] || {}).content || ''}`.slice(0, 120);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((c) => ({
    title: c.title,
    source: source || 'JSON 导入',
    content: renderConversation(c.messages),
    messageCount: c.messages.length
  })).filter((c) => c.content.length > 20);
}

/** 纯文本 / Markdown：按角色行切分 */
function parseText(text, source) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const conversations = [];
  let conv = null;   // {title, messages:[]}
  let turn = null;   // {role, lines:[]}

  const flushTurn = () => {
    if (!turn) return;
    const body = cleanText(turn.lines.join('\n'));
    const role = turn.role;
    turn = null;
    if (!body) return;
    if (!conv) conv = { title: '未命名对话', messages: [] };
    conv.messages.push({ role, content: body });
  };

  const flushConv = () => {
    flushTurn();
    if (conv && conv.messages.length) conversations.push(conv);
    conv = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    // 分隔线：一段对话结束
    if (/^\s*(-{3,}|\*{3,}|={3,})\s*$/.test(line)) { flushConv(); continue; }

    // 标题行，且不是角色行（防止 ### 用户：xxx 被当成标题）
    const heading = line.match(/^\s{0,3}(#{1,3})\s+(.+?)\s*$/);
    if (heading && !ROLE_LINE.test(line)) {
      flushConv();
      conv = { title: cleanText(heading[2]).slice(0, 80), messages: [] };
      continue;
    }

    // 角色行：结束上一段发言，开启新的一段
    const role = line.match(ROLE_LINE);
    if (role) {
      flushTurn();
      const speaker = /^(assistant|ai|gpt|bot|glm|chatglm|claude|助手|回答|答)/i.test(role[1]) ? 'assistant' : 'user';
      turn = { role: speaker, lines: role[2] ? [role[2]] : [] };
      continue;
    }

    if (turn) turn.lines.push(line);
    else if (conv) turn = { role: 'assistant', lines: [line] }; // 对话内无标注的裸文本，归到 AI
  }
  flushConv();

  return conversations.map((c, i) => ({
    title: c.title || `对话 ${i + 1}`,
    source: source || '文本导入',
    content: renderConversation(c.messages),
    messageCount: c.messages.length
  })).filter((c) => c.content.trim().length > 4);
}

/**
 * 统一入口：喂一段文本或文件内容的字符串，返回可导入的会话列表。
 * @returns {{kind:'json'|'text', items:Array, error?:string}}
 */
export function parseImport(raw, source) {
  const text = String(raw || '').trim();
  if (!text) return { kind: 'text', items: [], error: '内容为空' };

  // 先试 JSON（哪怕是嵌在 ```json ``` 里）
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonCandidate = fence ? fence[1] : text;
  if (jsonCandidate.trim().startsWith('{') || jsonCandidate.trim().startsWith('[')) {
    try {
      const data = JSON.parse(jsonCandidate.trim());
      const items = normalizeJSON(data, source);
      if (items.length) return { kind: 'json', items };
    } catch (_) { /* 不是合法 JSON，走文本解析 */ }
  }

  const items = parseText(text, source);
  return { kind: 'text', items, error: items.length ? undefined : '没能识别出对话结构，请检查格式' };
}
