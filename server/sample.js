'use strict';
/**
 * 示例作品《雾隐城》的种子数据。
 * 前端的「载入示例作品」按钮与展示端的 --seed 自动初始化共用这一份，避免两处维护。
 */
const store = require('./store');

const PALETTE = ['#6b8afd', '#8b5cf6', '#ec4899', '#f97316', '#10b981', '#06b6d4', '#f59e0b', '#ef4444'];

function pickColor(seed = '') {
  let sum = 0;
  for (let i = 0; i < seed.length; i++) sum += seed.charCodeAt(i);
  return PALETTE[sum % PALETTE.length];
}

const ACTS = [
  ['第一幕 · 入雾',
    '沈砚抵达雾隐城，凭替人画遗容的手艺落脚。第一张画像在三天后应验，他以为是巧合。',
    [
      ['第一章 · 渡口的白事铺', '沈砚接下第一单生意，埋下"三日应验"这条规矩的伏笔。', 'done'],
      ['第二章 · 井中的第二张脸', '死者下葬当日，沈砚在井底石壁上看见与自己笔触相同的画像。', 'draft']
    ]
  ],
  ['第二幕 · 追问',
    '第二、第三张脸接连应验，城内三家白事铺开始注意他；沈砚发现兄长三年前接过同样的活计。',
    [
      ['第三章 · 被抹去的那一页', '台账上三年前的记录整页消失，掌柜傅青的解释前后矛盾。', 'todo']
    ]
  ],
  ['第三幕 · 换笔',
    '沈砚终于窥见雾城的规矩：画的是死期，收笔的人才定生死。他必须决定要不要替自己画一张。',
    []
  ]
];

const CHARACTERS = [
  {
    name: '沈砚', role: '主角', alias: '画尸人', age: '26',
    appearance: '左手指节有一道旧墨痕，常年不肯洗净；衣袖总比旁人短一截。',
    personality: '表面散漫寡言，实则执着到偏执；越是害怕的事越要画下来，仿佛画出来就能掌控。',
    motivation: '找回失踪三年的兄长，证明他不是逃走而是被害。',
    flaw: '习惯把活人当素材，先观察后共情，往往慢半拍——等他想救人时人已经凉了。',
    arc: '从一个旁观的记录者，变成不得不落笔决定他人生死的人。',
    beatNote: '第二幕末发现兄长的最后一笔与自己的手法相同。'
  },
  {
    name: '傅青', role: '重要配角', alias: '白事铺掌柜', age: '31',
    appearance: '笑起来眼角有细纹，指甲缝里总有洗不掉的朱砂。',
    personality: '热情周到，从不正面回答问题；擅长用善意把人推到自己想要的位置。',
    motivation: '保住铺子，也保住某个她始终不肯说出口的人。',
    flaw: '把愧疚当成筹码，一边偿还一边操控。',
    arc: '从隐瞒者转为告解者，代价是失去最后一位亲人。',
    beatNote: '第三幕主动交出那半页台账，随即死于自己设下的规矩。'
  },
  {
    name: '沈辞', role: '反派', alias: '前任画师', age: '34',
    appearance: '总戴一双手套，指尖从不示人。',
    personality: '温和有礼，言辞恳切；可怕之处不在于狠，而在于他完全不觉得自己有错。',
    motivation: '维持雾城的"规矩"，替整座城挡灾。',
    flaw: '坚信自己是被选中的那个人，于是听不进任何反证。',
    arc: '从守规矩的人，走向被规矩吞噬的人。',
    beatNote: '第二幕中段就已认出沈砚，却一直按下不表。'
  }
];

const RELATIONS = [
  [0, 1, '雇主与雇工', '她给他活计，也给他线索，但每一条都恰好缺一半。'],
  [0, 2, '同门宿敌', '同出一脉，却对"规矩该不该继续"给出完全相反的答案。'],
  [1, 2, '旧识', '两人有一段谁都不肯先提起的往事。']
];

const LINES = [
  ['寻兄主线', 'main', '沈砚顺着三年前的接活记录，一步步逼近兄长失踪的真相。',
    [
      ['渡口的第一单', '沈砚为无名死者画脸，埋下应验规矩的第一枚种子。'],
      ['重复出现的笔触', '他发现某种收笔方式只属于兄长。'],
      ['记录被抹去', '三年前那一页台账整体消失，有人不想被查到。']
    ]
  ],
  ['画尸规矩线', 'mystery', '雾城的白事行规背后，藏着一套需要付出代价的机制。',
    [
      ['三日应验', '第一张脸应验，被所有人解释为巧合。'],
      ['规矩的反噬', '试图改写台账的人会失去自己的手。']
    ]
  ],
  ['傅青的愧疚线', 'sub', '她每一次示好都是在偿还，但债主并不知道。',
    [
      ['多算的那笔账', '她悄悄多给了沈砚三成工钱。']
    ]
  ]
];

const FORESHADOW = [
  ['沈砚指尖洗不掉的墨痕', '第一章', '第三幕揭示：那是他亲手为兄长画的最后一笔蹭上的。'],
  ['井底石壁上的画像', '第二章', '笔触属于沈砚自己——他曾在梦游中画过。'],
  ['傅青指甲缝的朱砂', '第一章', '她一直在偷偷改写死者的名帖。'],
  ['那声"师兄"', '第二章', '沈辞早在认出沈砚身份后才这样称呼他。']
];

const WORLD = [
  ['雾的机制', '规则',
    '雾每天子时涨一次，能暂时覆盖城中一切痕迹；任何在雾中被记住的面孔，雾散后会保持三天不褪——"三日应验"正来源于此。'],
  ['白事行的规矩', '势力',
    '全城只有三家有资格画遗容。画师不得主动上门，不得问死者姓名，不得替活人画像。'],
  ['渡口', '地理',
    '唯一进出雾城的水路。雾浓时渡船靠记忆而非眼睛靠岸，所以船夫记性都极好。']
];

const NOTES = [
  ['别让巧合推动剧情', '待解决',
    '主角每次"刚好看见"都要给出前置动机，否则读者会觉得被安排。第二章的井底画像，需要先埋他梦游的习惯。'],
  ['中段危机的一个想法', '灵感',
    '让沈砚被迫替一个无辜者画脸，用来验证规矩是否真的不可违——这也能把傅青推到必须坦白的境地。']
];

/** 创建示例作品，返回新建的 project */
function seedSampleProject(titleOverride) {
  const project = store.insert('projects', {
    title: titleOverride || '雾隐城',
    genre: '东方奇幻 / 悬疑',
    targetWords: 300000,
    synopsis: '落第画师沈砚为寻失踪的兄长来到终年不散雾的雾隐城，却在替人画遗容的过程中发现：自己画的每一张脸，都会在三日后死去。',
    cover: 'indigo'
  });
  const pid = project.id;

  const charIds = [];
  CHARACTERS.forEach((c) => {
    const created = store.insert('characters', {
      projectId: pid,
      color: pickColor(c.name),
      order: charIds.length,
      ...c
    });
    charIds.push(created.id);
  });

  RELATIONS.forEach(([a, b, label, desc]) => {
    store.insert('relations', {
      projectId: pid,
      fromId: charIds[a], toId: charIds[b],
      label, description: desc, strength: 3
    });
  });

  ACTS.forEach(([actTitle, actSummary, chapters], actIndex) => {
    const act = store.insert('outline', {
      projectId: pid, parentId: null, type: 'act',
      title: actTitle, summary: actSummary, status: 'todo', order: actIndex
    });
    chapters.forEach(([chTitle, chSummary, status], i) => {
      store.insert('outline', {
        projectId: pid, parentId: act.id, type: 'chapter',
        title: chTitle, summary: chSummary, status, order: i
      });
    });
  });

  LINES.forEach(([name, kind, description, beats], i) => {
    const line = store.insert('lines', {
      projectId: pid, name, kind, description,
      color: pickColor(name), status: 'active', order: i
    });
    beats.forEach(([title, desc], j) => {
      store.insert('beats', {
        projectId: pid, lineId: line.id,
        title, description: desc, status: 'planned', order: j
      });
    });
  });

  FORESHADOW.forEach(([title, planted, hint], i) => {
    store.insert('foreshadow', {
      projectId: pid, title, plantedChapter: planted,
      payoffHint: hint, status: 'planted', order: i
    });
  });

  WORLD.forEach(([title, category, content], i) => {
    store.insert('world', { projectId: pid, title, category, content, order: i });
  });

  NOTES.forEach(([title, category, content], i) => {
    store.insert('notes', { projectId: pid, title, category, content, pinned: false, order: i });
  });

  store.flush();
  return project;
}

module.exports = { seedSampleProject };
