#!/usr/bin/env node
// ============================================================================
// test-sync.mjs — 多端同步（v0.8.0，js/webdav.js + js/sync.js + store 同步接口）
//   运行: node scripts/test-sync.mjs
// 覆盖：① WebDAV 客户端（URL 规范化 / Basic 认证 / PROPFIND·MKCOL·GET·PUT·DELETE /
//          错误映射 / 超时 / 无 fetch 环境）
//       ② 合并内核（纯函数：卡片内容按 updatedAt、进度按 lastReview、日志并集、
//          删除墓碑与「复活」判定、卡组合并、设置取舍、幂等、变更统计）
//       ③ 快照往返（本地 → 快照 → 清库 → 应用快照 → 数据 / id / 进度 / 日志全部还原）
//       ④ 存储层配套（updatedAt 记账、删除墓碑、applySyncDecks 的增删）
//       ⑤ 配置（记住密码 / 清除凭据 / 状态文案）
// ============================================================================

import { installFakeIndexedDB } from './fake-idb.mjs';

/* ------------------------------ 浏览器桩 ------------------------------ */

const mem = {};
const storage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => {
    mem[k] = String(v);
  },
  removeItem: (k) => {
    delete mem[k];
  },
  clear: () => {
    for (const k of Object.keys(mem)) delete mem[k];
  }
};
globalThis.localStorage = storage;
globalThis.sessionStorage = storage;
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
// 默认按「已部署在 https」模拟（真实浏览器下 location 一定有协议）；测试里需要 http 场景时再覆盖
globalThis.location = { protocol: 'https:', hostname: 'mycard.example', href: 'https://mycard.example/' };
// Node ≥21 的 navigator 是只读 getter（不可赋值）→ 不强行覆盖；deviceName() 会自行降级为 'device-x'
installFakeIndexedDB();

/* ------------------------------ fetch 桩 ------------------------------ */

let routes = [];
let calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const method = String(opts.method || 'GET').toUpperCase();
  const u = String(url);
  calls.push({ method, url: u, headers: opts.headers || {}, body: opts.body, mode: opts.mode || '' });
  // 路由**按顺序消费**（同一方法连续多次调用时，依次匹配第 1、2… 条）
  const idx = routes.findIndex((r) => {
    if (String(r.method || 'GET').toUpperCase() !== method) return false;
    return typeof r.match === 'function' ? r.match(u) : r.match == null;
  });
  const hit = idx >= 0 ? routes.splice(idx, 1)[0] : null;
  if (hit && hit.throws) throw hit.throws;
  if (!hit) return { status: 404, text: async () => '' };
  return { status: hit.status == null ? 200 : hit.status, text: async () => hit.body || '' };
};
const resetFetch = (next = []) => {
  routes = next;
  calls = [];
};
const baseFetch = globalThis.fetch; // 需要装「假 WebDAV 服务端」的用例跑完后还原

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + msg);
  } else {
    fail++;
    console.error('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

const webdav = await import('../js/webdav.js');
const syncMod = await import('../js/sync.js');
const store = await import('../js/store.js');

/* ==========================================================================
 * ① WebDAV 客户端
 * ========================================================================== */

console.log('\n[WebDAV：URL 规范化与认证]');
ok(webdav.normalizeBase('dav.example.com/dav/') === 'https://dav.example.com/dav', '缺协议 → 补 https://，尾部斜杠去掉');
ok(webdav.normalizeBase('http://nas.local:5005/dav///') === 'http://nas.local:5005/dav', 'http 保留，多重尾斜杠收敛');
ok(webdav.normalizeDir('/a/b/') === 'a/b' && webdav.normalizeDir('  ') === '' && webdav.normalizeDir('a//b') === 'a/b', '目录规范化');
ok(webdav.buildUrl('https://d.example/dav/', 'mycard', 'a b.json') === 'https://d.example/dav/mycard/a%20b.json', '路径段逐个编码（空格）');
ok(decodeURIComponent(webdav.buildUrl('https://d.example/dav', '我的网盘/x')) === 'https://d.example/dav/我的网盘/x', '中文目录可用');
ok(webdav.buildUrl('https://d.example/dav/', '') === 'https://d.example/dav', '空目录段忽略');
let threw = null;
try {
  webdav.normalizeBase('   ');
} catch (e) {
  threw = e;
}
ok(threw && /地址/.test(threw.message), '空地址 → 明确报错');
ok(webdav.authHeader('u', 'p') === 'Basic ' + Buffer.from('u:p', 'utf8').toString('base64'), 'Basic 认证头（base64）');
ok(
  webdav.authHeader('用户', '密') === 'Basic ' + Buffer.from('用户:密', 'utf8').toString('base64'),
  'Basic 认证头对非 ASCII 用户名也正确（UTF-8）'
);
ok(webdav.authHeader('', 'p') === '', '无用户名 → 不生成认证头');

console.log('\n[WebDAV：PROPFIND / MKCOL / GET / PUT / DELETE]');
resetFetch([{ method: 'PROPFIND', status: 207 }]);
const probed = await webdav.probe('https://d.example/dav/', { auth: { user: 'u', pass: 'p' }, dir: 'mycard' });
ok(probed.ok && probed.status === 207 && probed.url === 'https://d.example/dav/mycard', 'probe：207 → 可用，地址正确');
ok(calls[0].headers.Authorization && calls[0].headers.Depth === '0', 'probe 带 Authorization 与 Depth: 0');

resetFetch([{ method: 'MKCOL', status: 405 }, { method: 'MKCOL', status: 201 }]);
const col = await webdav.ensureCollection('https://d.example/dav/', 'a/b');
ok(col.created.join() === 'b' && calls.length === 2, 'ensureCollection：逐级 MKCOL（已存在 405 视为成功）');
ok(calls[0].url.endsWith('/a') && calls[1].url.endsWith('/a/b'), '先建父目录再建子目录（避免 409）');
resetFetch([{ method: 'MKCOL', status: 409 }]);
threw = null;
try {
  await webdav.ensureCollection('https://d.example/dav/', 'x');
} catch (e) {
  threw = e;
}
ok(threw && threw.status === 409, 'MKCOL 409 → 抛 WebdavError(409)');

resetFetch([{ method: 'GET', status: 200, body: '{"a":1}' }]);
const got = await webdav.getText('https://d.example/dav/', 'mycard-sync.json', { dir: 'mycard' });
ok(got.exists === true && got.text === '{"a":1}', 'getText：200 → 文本');
resetFetch([{ method: 'GET', status: 404 }]);
ok((await webdav.getText('https://d.example/dav/', 'none.json')).exists === false, 'getText：404 → exists:false（不是错误）');
resetFetch([{ method: 'GET', status: 500 }]);
threw = null;
try {
  await webdav.getText('https://d.example/dav/', 'x.json');
} catch (e) {
  threw = e;
}
ok(threw && threw.status === 500 && /服务器错误/.test(webdav.explainError(threw)), 'getText：500 → 抛错并给出「服务器错误」提示');

resetFetch([{ method: 'PUT', status: 201 }]);
ok((await webdav.putText('https://d.example/dav/', 'a.json', '{}', { dir: 'a b' })).ok === true, 'putText：201 → 成功');
ok(calls[0].headers['Content-Type'].includes('json') && calls[0].body === '{}', 'putText 带 JSON Content-Type 与正文');
resetFetch([{ method: 'PUT', status: 412 }]);
threw = null;
try {
  await webdav.putText('https://d.example/dav/', 'lock.json', '{}', { createOnly: true });
} catch (e) {
  threw = e;
}
ok(threw && threw.status === 412 && calls[0].headers['If-None-Match'] === '*', 'createOnly：带 If-None-Match，412 → 「资源已存在」');

resetFetch([{ method: 'DELETE', status: 204 }]);
ok((await webdav.remove('https://d.example/dav/', 'x.json')).ok === true, 'remove：204 → 成功');
resetFetch([{ method: 'DELETE', status: 404 }]);
ok((await webdav.remove('https://d.example/dav/', 'x.json')).ok === true, 'remove：404 也算成功（已不存在）');

console.log('\n[WebDAV：错误说明 / 超时 / 无 fetch]');
ok(webdav.explainError({ status: 401 }).includes('认证失败'), '401 → 认证失败');
ok(webdav.explainError({ status: 403 }).includes('权限'), '403 → 无权限');
ok(webdav.explainError({ status: 423 }).includes('锁定'), '423 → 被锁定');
ok(webdav.explainError({ status: 507 }).includes('空间不足'), '507 → 空间不足');
ok(webdav.explainError({ status: 0, message: 'Failed to fetch' }).includes('跨域'), '网络失败 → 跨域提示');
resetFetch([{ method: 'PROPFIND', throws: Object.assign(new Error('aborted'), { name: 'AbortError' }) }]);
threw = null;
try {
  await webdav.probe('https://d.example/dav/', { timeout: 5000 });
} catch (e) {
  threw = e;
}
ok(threw instanceof webdav.WebdavError && /超时/.test(threw.message), 'AbortError → 请求超时（WebdavError）');
const savedFetch = globalThis.fetch;
delete globalThis.fetch;
threw = null;
try {
  await webdav.probe('https://d.example/dav/');
} catch (e) {
  threw = e;
}
ok(threw && /不支持 fetch/.test(threw.message), '无 fetch 环境 → 明确报错');
globalThis.fetch = savedFetch;



/* ==========================================================================
 * ② 合并内核（纯函数）
 * ========================================================================== */

console.log('\n[合并内核：卡片]');
const mkCard = (id, over = {}) => ({
  id,
  front: 'w' + id,
  back: '义' + id,
  example: '',
  exampleZh: '',
  phonetic: '',
  tags: [],
  groups: [],
  extraBacks: [],
  createdAt: 1000,
  updatedAt: 1000,
  level: 0,
  state: 'new',
  repetitions: 0,
  interval: 0,
  easeFactor: 2.5,
  due: 0,
  lastReview: null,
  src: null,
  addedAt: null,
  ...over
});
const mkDeck = (id, over = {}) => ({
  id,
  name: '卡组' + id,
  description: '',
  tags: [],
  paused: false,
  cardsPerLevel: null,
  createdAt: 1000,
  updatedAt: 1000,
  demo: false,
  source: null,
  passedLevels: {},
  cards: [],
  revlog: [],
  ...over
});
const mkSnap = (decks, over = {}) => ({
  app: 'mycard',
  formatVersion: 1,
  savedAt: 1000,
  device: 'A',
  settings: {},
  decks,
  tombstones: { decks: {}, cards: {} },
  ...over
});

const cContent = syncMod.mergeCard(mkCard('1', { updatedAt: 2000, front: '新释义' }), mkCard('1', { updatedAt: 1000, front: '旧释义' }));
ok(cContent.front === '新释义' && cContent.updatedAt === 2000, '内容：updatedAt 新者胜');
const cProg = syncMod.mergeCard(
  mkCard('1', { updatedAt: 9000, front: 'A 改过', lastReview: 1000 }),
  mkCard('1', { updatedAt: 1000, front: 'B 旧', lastReview: 5000, state: 'review', repetitions: 4, interval: 6, easeFactor: 2.7, due: 9000 })
);
ok(cProg.front === 'A 改过', '内容取 A（updatedAt 更新）');
ok(cProg.lastReview === 5000 && cProg.state === 'review' && cProg.repetitions === 4 && cProg.interval === 6, '进度取 B（lastReview 更新）→ 学习进度不回退');
ok(cProg.updatedAt === 9000 && cProg.createdAt === 1000, 'updatedAt 取最大、createdAt 取最小');
const cTie = syncMod.mergeCard(mkCard('1', { lastReview: 5000 }), mkCard('1', { lastReview: 5000, state: 'review' }));
ok(cTie.state === 'new', 'lastReview 打平时以本地（第一个）为准（结果可复现）');

console.log('\n[合并内核：复习日志 / 墓碑]');
const logs = syncMod.mergeRevlog(
  [
    { id: 'e1', cardId: 'c1', ts: 100, ease: 3 },
    { id: 'e2', cardId: 'c1', ts: 300, ease: 1 }
  ],
  [
    { id: 'e2', cardId: 'c1', ts: 300, ease: 1 },
    { id: 'e3', cardId: 'c2', ts: 200, ease: 4 }
  ]
);
ok(logs.length === 3 && logs.map((e) => e.id).join() === 'e1,e3,e2', '日志并集：去重 + 按 ts 升序');
ok(syncMod.mergeRevlog([], null).length === 0 && syncMod.mergeRevlog(null, [{ id: 'x', cardId: 'c', ts: 1 }]).length === 1, '空输入安全');

const tombs = syncMod.mergeTombstones({ decks: { d1: 100 }, cards: { c1: 100 } }, { decks: { d1: 200, d2: 50 }, cards: {} });
ok(tombs.decks.d1 === 200 && tombs.decks.d2 === 50 && tombs.cards.c1 === 100, '墓碑并集：同 id 取更晚的删除时间');

ok(syncMod.cardDeletedAt(mkCard('1', { updatedAt: 1000, lastReview: 2000 }), 3000) === true, '删除时间晚于「最后修改 / 复习」→ 真删');
ok(syncMod.cardDeletedAt(mkCard('1', { updatedAt: 1000, lastReview: 2000 }), 1500) === false, '对方在删除后又学过 → 保留（复活）');
ok(syncMod.cardDeletedAt(mkCard('1'), 0) === false, '没有墓碑 → 不删');
ok(
  syncMod.deckDeletedAt(mkDeck('d', { updatedAt: 1000, cards: [mkCard('1', { lastReview: 5000 })] }), 3000) === false,
  '卡组墓碑：组内有卡片在删除后学习过 → 保留整个卡组'
);
ok(syncMod.deckDeletedAt(mkDeck('d', { updatedAt: 1000, cards: [mkCard('1', { lastReview: 100 })] }), 3000) === true, '卡组与卡片都早于删除时间 → 真删');


console.log('\n[合并内核：卡组 / 快照]');
const dMerged = syncMod.mergeDeckEntry(
  mkDeck('d1', {
    updatedAt: 2000,
    name: '本地新名',
    passedLevels: { 0: true },
    cards: [mkCard('c1', { updatedAt: 2000, front: '本地释义' })],
    revlog: [{ id: 'e1', cardId: 'c1', ts: 10 }]
  }),
  mkDeck('d1', {
    updatedAt: 1000,
    name: '远端旧名',
    passedLevels: { 1: true },
    cards: [mkCard('c1', { lastReview: 5000, state: 'review' }), mkCard('c2')],
    revlog: [{ id: 'e2', cardId: 'c2', ts: 20 }]
  })
);
ok(dMerged.name === '本地新名' && dMerged.passedLevels[0] === true && dMerged.passedLevels[1] === true, '卡组名取 updatedAt 新者，通关记录取并集');
ok(dMerged.cards.length === 2 && dMerged.cards.find((c) => c.id === 'c1').front === '本地释义', '本地独有的卡片保留');
ok(dMerged.cards.find((c) => c.id === 'c1').state === 'review', '同卡：内容取本地、进度取远端（lastReview 更晚）');
ok(dMerged.revlog.length === 2, '日志并集（跨卡）');

const localSnap = mkSnap(
  [
    mkDeck('d1', {
      updatedAt: 3000,
      name: 'A 端卡组',
      cards: [mkCard('c1', { updatedAt: 3000, front: 'A 义', lastReview: 1000 })],
      revlog: [{ id: 'a1', cardId: 'c1', ts: 100 }]
    })
  ],
  { device: 'A', settings: { cardsPerLevel: 20 }, savedAt: 100 }
);
const remoteSnap = mkSnap(
  [
    mkDeck('d1', {
      updatedAt: 2000,
      name: 'B 端卡组',
      passedLevels: { 0: true },
      cards: [mkCard('c1', { lastReview: 5000, state: 'review' }), mkCard('c9', { front: '只有 B 有' })]
    }),
    mkDeck('d2', { name: 'B 独有卡组', cards: [mkCard('x1')] })
  ],
  { device: 'B', settings: { cardsPerLevel: 30 }, savedAt: 9999 }
);
const m1 = syncMod.mergeSnapshots(localSnap, remoteSnap, { now: 20000, device: 'A' });
ok(m1.snapshot.decks.length === 2, '合并后：A 的 d1 + B 独有 d2（并集）');
const md1 = m1.snapshot.decks.find((d) => d.id === 'd1');
ok(md1.name === 'A 端卡组' && md1.cards.find((c) => c.id === 'c1').front === 'A 义', '同卡组：内容取 A（updatedAt 更新）');
ok(md1.cards.find((c) => c.id === 'c1').state === 'review' && md1.cards.length === 2, '同卡组：进度取 B，且 B 的新卡 c9 也进来');
ok(md1.passedLevels[0] === true, '关卡通关记录并集');
ok(m1.snapshot.savedAt === 20000 && m1.snapshot.device === 'A', '快照写入新的 savedAt / 本机标识');
ok(m1.snapshot.settings.cardsPerLevel === 30, '设置取 savedAt 更新的那一方（B）');
// v0.9.0：设置优先比「最后改动时间」（老数据没这个字段才退回 savedAt）——否则本地 savedAt 恒为 now，远端永远赢不了
const stLocal = syncMod.mergeSnapshots(
  mkSnap([], { savedAt: 9000, settings: { cardsPerLevel: 20, updatedAt: 100 } }),
  mkSnap([], { savedAt: 100, settings: { cardsPerLevel: 25, updatedAt: 500 } })
);
ok(stLocal.snapshot.settings.cardsPerLevel === 25, '设置按「改动时间」合并：远端改得更晚 → 取远端（即使本地快照 savedAt 更大）');
const stRemote = syncMod.mergeSnapshots(
  mkSnap([], { savedAt: 100, settings: { cardsPerLevel: 20, updatedAt: 900 } }),
  mkSnap([], { savedAt: 9000, settings: { cardsPerLevel: 25, updatedAt: 500 } })
);
ok(stRemote.snapshot.settings.cardsPerLevel === 20, '设置按「改动时间」合并：本地改得更晚 → 取本地');
ok(stRemote.snapshot.settings.updatedAt === 900, '合并结果保留「改动时间」（下一次合并才不会来回翻烙饼）');
ok(
  m1.stats.decksAdded === 1 && m1.stats.decksUpdated === 1 && m1.stats.cardsAdded === 2 && m1.stats.cardsUpdated === 1,
  '变更统计：新增卡组 1 / 更新卡组 1 / 新增卡片 2（B 独有卡组 + d1 的新卡）/ 更新卡片 1',
  m1.stats
);
ok(m1.stats.revlogs === 0, '变更统计：日志无新增（B 没带日志）');
ok(syncMod.statsText(m1.stats).includes('新增卡组 1'), '摘要文案：' + syncMod.statsText(m1.stats));
ok(syncMod.statsText({}) === '已是最新', '无变化 → 「已是最新」');

const again = syncMod.mergeSnapshots(m1.snapshot, m1.snapshot, { now: 20001, device: 'A' });
ok(JSON.stringify(again.snapshot.decks) === JSON.stringify(m1.snapshot.decks), '幂等：把合并结果再合并一次，卡组不变');
ok(again.stats.cardsAdded === 0 && again.stats.cardsUpdated === 0 && again.stats.decksUpdated === 0, '幂等：第二次没有变更');

console.log('\n[合并内核：删除同步]');
const delDeck = syncMod.mergeSnapshots(
  mkSnap([], { tombstones: { decks: { d1: 5000 }, cards: {} } }),
  mkSnap([mkDeck('d1', { updatedAt: 1000 })])
);
ok(delDeck.snapshot.decks.length === 0, '卡组墓碑生效 → 合并结果里不再有它（远端文件里的那个卡组会被删掉）');
ok(delDeck.stats.decksRemoved === 0 && delDeck.snapshot.tombstones.decks.d1 === 5000, '本地本来就没有它 → 本地无「移除卡组」，墓碑随快照保留');
const keepDeck = syncMod.mergeSnapshots(
  mkSnap([], { tombstones: { decks: { d1: 5000 }, cards: {} } }),
  mkSnap([mkDeck('d1', { updatedAt: 9000, name: '删除后又改过' })])
);
ok(keepDeck.snapshot.decks.length === 1, '卡组在删除之后又被改过 → 不删（防误删）');

const delCard = syncMod.mergeSnapshots(
  mkSnap([mkDeck('d1', { cards: [] })], { tombstones: { decks: {}, cards: { c1: 5000 } } }),
  mkSnap([mkDeck('d1', { cards: [mkCard('c1', { updatedAt: 1000 }), mkCard('c2')] })])
);
ok(delCard.snapshot.decks[0].cards.length === 1 && delCard.snapshot.decks[0].cards[0].id === 'c2', '卡片墓碑生效 → 该卡删除，其它卡保留');
const reviveCard = syncMod.mergeSnapshots(
  mkSnap([mkDeck('d1', { cards: [] })], { tombstones: { decks: {}, cards: { c1: 5000 } } }),
  mkSnap([mkDeck('d1', { cards: [mkCard('c1', { lastReview: 8000, state: 'review' })] })])
);
ok(reviveCard.snapshot.decks[0].cards.length === 1, '另一端在删除后又复习过这张卡 → 不删（进度优先）');
ok(delCard.snapshot.tombstones.cards.c1 === 5000, '墓碑会随快照带出去（其它设备下次也能删）');
ok(syncMod.lastResultText(null) === '尚未同步' && syncMod.lastResultText({ ok: false, error: '认证失败' }).includes('认证失败'), '上次同步结果文案');


/* ==========================================================================
 * ③ 快照往返（真实 store + 假 IndexedDB）
 * ========================================================================== */

console.log('\n[快照往返：本地 → 快照 → 清库 → 应用快照]');
await store.init();
const deck = store.createDeck({ name: '同步测试卡组', description: '往返', tags: ['t'] });
ok(!!deck.updatedAt && Math.abs(deck.updatedAt - Date.now()) < 5000, 'createDeck 打上 updatedAt');
const added = store.addCard(deck.id, { front: 'apple', back: '苹果' });
ok(added.updatedAt >= added.createdAt, 'addCard 打上 updatedAt');
store.updateCard(deck.id, added.id, { back: '苹果（修订）' });
const afterContent = store.getDeck(deck.id).cards[0].updatedAt;
ok(store.getDeck(deck.id).cards[0].back === '苹果（修订）' && afterContent >= added.updatedAt, '内容编辑生效且 updatedAt 不早于创建时间');
store.updateCard(deck.id, added.id, {
  state: 'review',
  repetitions: 2,
  interval: 3,
  easeFactor: 2.6,
  due: Date.now() + 1e6,
  lastReview: Date.now()
});
ok(store.getDeck(deck.id).cards[0].updatedAt === afterContent, '纯学习动作（只有调度字段）不推进 updatedAt');
store.recordReview(
  deck.id,
  { id: added.id, state: 'new', interval: 0, easeFactor: 2.5, lastReview: null },
  'good',
  { state: 'review', interval: 3, easeFactor: 2.6, lastReview: Date.now() },
  { now: Date.now(), timeMs: 1200 }
);
store.markLevelPassed(deck.id, 0);
await store.flushPending(); // 复习日志是防抖落盘的，测试里显式等待写完
const snap = await syncMod.buildSnapshot();
ok(snap.decks.length === 1 && snap.decks[0].id === deck.id, 'buildSnapshot：卡组进入快照（id 保留）');
ok(snap.decks[0].cards.length === 1 && snap.decks[0].cards[0].id === added.id, '快照保留卡片 id');
ok(snap.decks[0].cards[0].state === 'review' && snap.decks[0].cards[0].interval === 3, '快照带上复习进度');
ok(Array.isArray(snap.decks[0].revlog) && snap.decks[0].revlog.length === 1, '快照带上复习日志');
ok(snap.decks[0].passedLevels['0'] === true, '快照带上关卡通关记录');
ok(snap.settings.cardsPerLevel === store.getDb().settings.cardsPerLevel, '快照带上「每关词数」设置');
ok(snap.decks[0].updatedAt > 0 && snap.decks[0].cards[0].updatedAt > 0, '快照带上内容修改时间（冲突判定依据）');

store.resetAll();
ok(store.getDb().decks.length === 0 && Object.keys(store.syncTombstones().cards).length === 0, 'resetAll 清空卡组与墓碑');
const applied = store.applySyncDecks(snap.decks, { settings: snap.settings });
const restored = store.getDeck(deck.id);
ok(!!restored && restored.name === '同步测试卡组' && restored.cards.length === 1, 'applySyncDecks：卡组与卡片还原（id 保留）');
ok(restored.cards[0].id === added.id && restored.cards[0].back === '苹果（修订）', '卡片 id 与内容一致');
ok(restored.cards[0].state === 'review' && restored.cards[0].interval === 3 && restored.cards[0].lastReview > 0, '复习进度一致');
ok(restored.passedLevels['0'] === true, '关卡通关记录一致');
const restoredLogs = await store.revlogsOfDeck(deck.id);
ok(restoredLogs.length === 1 && restoredLogs[0].cardId === added.id, '复习日志也落库了（revlog 回写）');
ok(applied.decks === 1 && applied.cards === 1 && applied.logsWritten === 1, 'applySyncDecks 返回落库统计', applied);

console.log('\n[存储层：删除墓碑]');
const d2 = store.createDeck({ name: '待删卡组' });
const c2 = store.addCard(d2.id, { front: 'x', back: 'y' });
store.deleteCard(d2.id, c2.id);
ok(!!store.syncTombstones().cards[c2.id], 'deleteCard → 记卡片墓碑');
store.deleteDeck(d2.id);
ok(!!store.syncTombstones().decks[d2.id], 'deleteDeck → 记卡组墓碑');
store.setTombstones({ decks: { keep: Date.now() }, cards: { old: Date.now() - 200 * 24 * 3600 * 1000 } });
ok(
  Object.keys(store.syncTombstones().decks).length === 1 && Object.keys(store.syncTombstones().cards).length === 0,
  'setTombstones：超过 90 天的墓碑自动丢弃'
);
store.clearTombstones();
ok(Object.keys(store.syncTombstones().decks).length === 0, 'clearTombstones 清空');

/** v0.9.2：连不上时「说得清」——错误分类 / 逐步诊断 / 可复制报告 */
console.log('\n[v0.9.2 连不上也说得清：错误分类 + 逐步诊断 + 报告]');
{
  // ① 网络类异常：保住原始信息 + 分类为 network（不再是一句 request failed）
  const netErr = Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' });
  resetFetch([{ method: 'PROPFIND', throws: netErr }]);
  let e1 = null;
  try {
    await webdav.probe('https://dav.example.com/dav', { auth: { user: 'me', pass: 'pw' } });
  } catch (err) {
    e1 = err;
  }
  ok(e1 && e1.kind === 'network', 'fetch 抛错 → kind = network（不再是无信息的 request failed）');
  ok(webdav.causeText(e1) === 'TypeError: Failed to fetch', '保留底层原始异常文本：' + webdav.causeText(e1));
  const msg1 = webdav.explainError(e1);
  ok(!/^request failed$/.test(msg1) && msg1.includes('连不上服务器'), '解释文案不再是「request failed」：' + msg1.slice(0, 40) + '…');
  ok(msg1.includes('TypeError: Failed to fetch'), '解释里带上浏览器原始信息（可据此判断是不是被拦）');
  ok(msg1.includes('dav.example.com') && msg1.includes('跨域'), '解释里带 URL 与「跨域」可能原因');
  ok(msg1.includes('诊断连接'), '解释里告诉用户可以「诊断连接」定位');

  // ② 超时：单独分类
  resetFetch([{ method: 'PROPFIND', throws: Object.assign(new Error('aborted'), { name: 'AbortError' }) }]);
  let e2 = null;
  try {
    await webdav.probe('https://dav.example.com/dav', { timeout: 5000 });
  } catch (err) {
    e2 = err;
  }
  ok(e2 && e2.kind === 'timeout' && webdav.explainError(e2).includes('连接超时'), 'AbortError → kind=timeout + 「连接超时」解释');

  // ③ 混合内容：https 页面访问 http 地址 —— 本地就拦下，fetch 根本不发
  const savedLoc = globalThis.location;
  globalThis.location = { protocol: 'https:', href: 'https://app.example/' };
  resetFetch([{ method: 'GET', status: 200, body: 'x' }]);
  let e3 = null;
  try {
    await webdav.getText('http://nas.local:5005/dav', 'a.json');
  } catch (err) {
    e3 = err;
  }
  ok(e3 && e3.kind === 'mixed-content', 'HTTPS 页面 + http:// 地址 → kind = mixed-content');
  ok(webdav.explainError(e3).includes('改成 https'), '解释文案给出可执行建议：改用 https 地址');
  ok(calls.length === 0, '混合内容被拦时不发任何请求（浏览器本来就会拦）');
  globalThis.location = savedLoc;
}

console.log('\n[v0.9.2 逐步诊断 diagnose()：每一步都给结论]');
{
  const netErr = Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' });

  // ④-1 全通
  resetFetch([
    { method: 'GET', status: 401, body: '' },
    { method: 'PROPFIND', status: 207, body: '' },
    { method: 'PROPFIND', status: 207, body: '' }
  ]);
  const dOk = await webdav.diagnose('https://dav.example.com/dav', { auth: { user: 'me', pass: 'pw' }, dir: 'mycard' });
  ok(dOk.ok === true && /连接正常/.test(dOk.verdict), '诊断：三步都通 → 结论「连接正常」：' + dOk.verdict);
  ok(
    dOk.steps.map((s) => s.id).join(',') === 'url,env,simple,preflight,auth',
    '诊断按固定顺序探测：地址 → 环境 → 连通性 → 跨域预检 → 认证',
    dOk.steps.map((s) => s.id)
  );
  ok(dOk.steps.every((s) => s.status === 'ok'), '每步都标为通过');

  // ④-2 连通 OK、预检与带认证的 PROPFIND 都抛错 → 明确指向 CORS
  resetFetch([
    { method: 'GET', status: 401, body: '' },
    { method: 'PROPFIND', throws: netErr },
    { method: 'PROPFIND', throws: netErr }
  ]);
  const dCors = await webdav.diagnose('https://dav.example.com/dav', { auth: { user: 'me', pass: 'pw' } });
  ok(dCors.ok === false && /跨域预检/.test(dCors.verdict), '诊断：连通但预检失败 → 结论指向「跨域被拦」：' + dCors.verdict);
  ok(
    dCors.steps.find((s) => s.id === 'simple').status === 'ok' && dCors.steps.find((s) => s.id === 'preflight').status === 'fail',
    '分步结论：连通性 ✓ / 预检 ✗（用户能看懂卡在哪一步）'
  );

  // ④-3 连 GET 与 no-cors 探测都不通 → 明确是网络层面（v0.9.3 起会多探一步）
  resetFetch([
    { method: 'GET', throws: netErr },
    { method: 'GET', throws: netErr },
    { method: 'PROPFIND', throws: netErr },
    { method: 'PROPFIND', throws: netErr }
  ]);
  const dDown = await webdav.diagnose('https://dav.example.com/dav', { auth: { user: 'me', pass: 'pw' } });
  ok(dDown.ok === false && /根本到不了服务器/.test(dDown.verdict), '诊断：连通性与可达性都不通 → 结论「根本到不了服务器」');

  // ④-4 跨域 OK 但 401（坚果云典型：用了登录密码 / 用户名填成昵称）
  resetFetch([
    { method: 'GET', status: 401, body: '' },
    { method: 'PROPFIND', status: 207, body: '' },
    { method: 'PROPFIND', status: 401, body: '' }
  ]);
  const dAuth = await webdav.diagnose('https://dav.jianguoyun.com/dav', { auth: { user: 'me', pass: 'bad' } });
  ok(dAuth.ok === false && /应用密码/.test(dAuth.verdict), '诊断：跨域没问题但 401 → 指向「账号 / 应用密码」：' + dAuth.verdict);

  // ④-5 403 / 404
  resetFetch([
    { method: 'GET', status: 401, body: '' },
    { method: 'PROPFIND', status: 207, body: '' },
    { method: 'PROPFIND', status: 403, body: '' }
  ]);
  const dForbidden = await webdav.diagnose('https://dav.example.com/dav', { auth: { user: 'me', pass: 'pw' } });
  ok(dForbidden.ok === false && /权限/.test(dForbidden.verdict), '诊断：403 → 结论「目录没有读写权限」');
  resetFetch([
    { method: 'GET', status: 401, body: '' },
    { method: 'PROPFIND', status: 207, body: '' },
    { method: 'PROPFIND', status: 404, body: '' }
  ]);
  const d404 = await webdav.diagnose('https://dav.example.com/dav/nope', { auth: { user: 'me', pass: 'pw' } });
  ok(d404.ok === false && /路径不存在/.test(d404.verdict), '诊断：404 → 结论「路径不存在」');

  // ④-6 无 fetch / 地址非法：诊断永不抛错，也要给结论
  const savedFetch2 = globalThis.fetch;
  globalThis.fetch = undefined;
  const dNoFetch = await webdav.diagnose('https://dav.example.com/dav');
  ok(dNoFetch.ok === false && dNoFetch.steps.some((s) => s.status === 'fail'), '无 fetch 环境下诊断不抛错，仍给出结论');
  globalThis.fetch = savedFetch2;
  const dBad = await webdav.diagnose('::::', {});
  ok(dBad.ok === false && dBad.steps.some((s) => s.status === 'fail'), '地址非法时诊断也不抛错（给出失败步骤）');
}

console.log('\n[v0.9.2 诊断报告与自查清单（可复制 / 不含密码）]');
{
  const rep = {
    ok: false,
    verdict: '服务器拒绝了浏览器的跨域预检（CORS）',
    steps: [
      { id: 'url', label: '解析服务器地址', status: 'ok', detail: 'https://dav.jianguoyun.com/dav/mycard' },
      { id: 'simple', label: '基础连通性（GET，不带认证）', status: 'ok', detail: '服务器有响应：HTTP 401' },
      { id: 'preflight', label: '跨域预检（PROPFIND，不带认证）', status: 'fail', detail: '连不上服务器｜浏览器原始信息：TypeError: Failed to fetch' }
    ]
  };
  const text = webdav.diagnoseReport(rep, {
    url: 'https://dav.jianguoyun.com/dav',
    dir: 'mycard',
    user: 'me@example.com',
    pass: 'SUPER-SECRET-APP-PASSWORD'
  });
  ok(/Mycard 同步诊断报告/.test(text) && /结论：/.test(text) && /\[✗\]/.test(text), '报告含标题 / 结论 / 逐步结果');
  ok(text.includes('me@example.com') && text.includes('mycard') && text.includes('https://dav.jianguoyun.com/dav'), '报告含地址 / 用户名 / 目录（便于他人排查）');
  ok(!text.includes('SUPER-SECRET-APP-PASSWORD') && !/SUPER/.test(text), '报告绝不含密码');
  ok(/自查清单/.test(text) && /应用密码/.test(text), '报告附带自查清单');

  const jgyHints = webdav.setupHints('https://dav.jianguoyun.com/dav/');
  ok(jgyHints.some((h) => /应用密码/.test(h)) && jgyHints.some((h) => /注册邮箱/.test(h)), '坚果云：清单提示「用户名 = 注册邮箱、密码 = 应用密码」');
  ok(jgyHints.some((h) => /dav\.jianguoyun\.com\/dav/.test(h)), '坚果云：清单给出正确端点 https://dav.jianguoyun.com/dav/');
  ok(jgyHints.some((h) => /跨域|CORS/.test(h)) && jgyHints.some((h) => /插件|代理/.test(h)), '清单覆盖「跨域」与「插件 / 代理」两类常见原因');
  const nasHints = webdav.setupHints('https://nas.local:5006/dav');
  ok(!nasHints.some((h) => /坚果云在网页端/.test(h)) && nasHints.some((h) => /应用专用密码/.test(h)), '非坚果云地址：不塞坚果云专属提示，但保留「用应用密码」的通用建议');
}

console.log('\n[v0.9.3 no-cors 探测：把「网络不通」与「缺 CORS 头」分开]');
{
  const netErr = Object.assign(new TypeError('Load failed'), { name: 'TypeError' }); // Safari 的文案

  // ① 探测本身：no-cors 简单 GET；resolve → 可达；reject → 不可达
  resetFetch([{ method: 'GET', status: 0, body: '' }]);
  const r1 = await webdav.probeReachable('https://dav.example.com/dav/mycard', { timeout: 5000 });
  ok(r1.ok === true, 'no-cors 探测：请求完成 → 视为「服务器可达」');
  ok(calls.length === 1 && calls[0].mode === 'no-cors', '确实用了 mode: "no-cors"（不要求跨域头）');
  ok(calls[0].method === 'GET' && !calls[0].headers.Authorization, '探测不带认证头（只是连通性探测）');

  resetFetch([{ method: 'GET', throws: netErr }]);
  const r2 = await webdav.probeReachable('https://dav.example.com/dav/mycard');
  ok(r2.ok === false && r2.reason === 'unreachable' && webdav.causeText(r2.cause) === 'TypeError: Load failed', '请求抛错 → 不可达（并保留 Load failed 原文）');

  const savedF = globalThis.fetch;
  globalThis.fetch = undefined;
  const r3 = await webdav.probeReachable('https://dav.example.com/dav');
  ok(r3.ok === false && r3.reason === 'no-fetch', '无 fetch 环境 → 直接判不可达（不抛错）');
  globalThis.fetch = savedF;

  // ② 把探测接进诊断：GET 失败但 no-cors 可达 → 明确结论「缺跨域许可」
  resetFetch([
    { method: 'GET', throws: netErr },
    { method: 'GET', status: 0, body: '' }, // no-cors 探测（同一方法，第二条路由）
    { method: 'PROPFIND', throws: netErr },
    { method: 'PROPFIND', throws: netErr }
  ]);
  const dCors2 = await webdav.diagnose('https://dav.jianguoyun.com/dav', { auth: { user: 'me', pass: 'pw' }, dir: 'mycard' });
  ok(
    dCors2.steps.map((s) => s.id).join(',') === 'url,env,simple,reach,preflight,auth',
    '简单请求失败时会插入「服务器可达性」这一步',
    dCors2.steps.map((s) => s.id)
  );
  ok(dCors2.steps.find((s) => s.id === 'reach').status === 'ok', '可达性探测标为通过（服务器可达）');
  ok(dCors2.ok === false && /可达/.test(dCors2.verdict) && /CORS/.test(dCors2.verdict), '结论：「服务器可达，但缺少跨域许可」：' + dCors2.verdict);
  ok(/Worker|Nextcloud/.test(dCors2.verdict), '结论里给出可执行的出路（换支持跨域的网盘 / Worker 反代）');
  ok(calls.some((c) => c.mode === 'no-cors'), '诊断期间确实发出了 no-cors 探测');

  // ③ 两条都失败 → 结论「根本到不了服务器」，且不再误导用户去查 CORS
  resetFetch([
    { method: 'GET', throws: netErr },
    { method: 'GET', throws: netErr },
    { method: 'PROPFIND', throws: netErr },
    { method: 'PROPFIND', throws: netErr }
  ]);
  const dDown2 = await webdav.diagnose('https://dav.jianguoyun.com/dav', { auth: { user: 'me', pass: 'pw' } });
  ok(dDown2.steps.find((s) => s.id === 'reach').status === 'fail', '可达性探测标为失败');
  ok(dDown2.ok === false && /根本到不了服务器/.test(dDown2.verdict), '结论：「这台设备根本到不了服务器」（网络 / DNS / 证书 / 拦截）');
  ok(/手机热点|换网络/.test(dDown2.verdict) && !/CORS/.test(dDown2.verdict), '结论给网络层面的可执行建议、且不再扯 CORS');

  // ④ 清单：覆盖「可达但缺 CORS」与「根本到不了」两条分支
  const hints = webdav.setupHints('https://dav.jianguoyun.com/dav/');
  ok(hints.some((h) => /服务器可达性/.test(h) && /CORS/.test(h)), '清单解释「可达性通过但连通性失败 = 缺跨域头」');
  ok(hints.some((h) => /服务器可达性/.test(h) && /没完成|压根没完成/.test(h)), '清单解释「可达性也失败 = 网络层面」，并给出换网络 / 关拦截器');
  ok(hints.some((h) => /Worker/.test(h)), '清单给出「Worker 反代」这条出路');
}

console.log('\n[v0.9.4 跨域场景一键方案：reason 标记 + Worker 反代代码]');
{
  const netErr = Object.assign(new TypeError('Load failed'), { name: 'TypeError' });

  // ① 诊断结果带机器可读的 reason（UI 据此渲染「怎么修」）
  resetFetch([
    { method: 'GET', throws: netErr },
    { method: 'GET', status: 0, body: '' }, // no-cors 可达
    { method: 'PROPFIND', throws: netErr },
    { method: 'PROPFIND', throws: netErr }
  ]);
  const rCors = await webdav.diagnose('https://dav.jianguoyun.com/dav', { auth: { user: 'me', pass: 'pw' } });
  ok(rCors.reason === 'cors', '「可达但缺跨域头」→ reason = "cors"');
  resetFetch([
    { method: 'GET', throws: netErr },
    { method: 'GET', throws: netErr },
    { method: 'PROPFIND', throws: netErr },
    { method: 'PROPFIND', throws: netErr }
  ]);
  const rNet = await webdav.diagnose('https://dav.example.com/dav', { auth: { user: 'me', pass: 'pw' } });
  ok(rNet.reason === 'network', '「连不上」→ reason = "network"');
  resetFetch([
    { method: 'GET', status: 401, body: '' },
    { method: 'PROPFIND', status: 207, body: '' },
    { method: 'PROPFIND', status: 401, body: '' }
  ]);
  const rAuth = await webdav.diagnose('https://dav.example.com/dav', { auth: { user: 'me', pass: 'bad' } });
  ok(rAuth.reason === 'auth', '401 → reason = "auth"');
  resetFetch([
    { method: 'GET', status: 401, body: '' },
    { method: 'PROPFIND', status: 207, body: '' },
    { method: 'PROPFIND', status: 207, body: '' }
  ]);
  const rOk = await webdav.diagnose('https://dav.example.com/dav', { auth: { user: 'me', pass: 'pw' } });
  ok(rOk.reason === 'ok' && rOk.ok === true, '全通 → reason = "ok"');
  const rBad = await webdav.diagnose('', {});
  ok(rBad.reason === 'address' && rBad.ok === false, '地址为空/非法 → reason = "address"');

  // ② Worker 反代代码：目标服务器按用户地址自动推导，且带齐 CORS 头 / 预检放行
  const worker = webdav.workerProxyCode('https://dav.jianguoyun.com/dav/');
  ok(/const TARGET = 'https:\/\/dav\.jianguoyun\.com'/.test(worker), 'Worker 代码里 TARGET 自动填成用户填的网盘域名');
  ok(/Access-Control-Allow-Origin/.test(worker) && /Access-Control-Allow-Headers'?:\s*'Authorization/.test(worker), '补齐 CORS 头（含 Authorization / Depth / If-None-Match）');
  ok(/req\.method === 'OPTIONS'/.test(worker) && /status: 204/.test(worker), '预检 OPTIONS 直接 204 放行');
  ok(/PROPFIND/.test(worker) && /MKCOL/.test(worker), 'Allow-Methods 覆盖 WebDAV 方法（PROPFIND / MKCOL 等）');
  ok(/export default \{/.test(worker) && /async fetch\(req\)/.test(worker), '是一个可直接粘贴部署的 Cloudflare Worker 模块');
  ok(!/YOUR_|TODO|请填写/.test(worker), '不需要用户改任何占位符即可部署');
  const worker2 = webdav.workerProxyCode('not a url');
  ok(/TARGET = 'https:\/\/dav\.jianguoyun\.com'/.test(worker2), '地址非法时回退到示例域名（不抛错）');
  const worker3 = webdav.workerProxyCode('http://nas.local:5005/dav');
  ok(/TARGET = 'http:\/\/nas\.local:5005'/.test(worker3), '局域网地址也能正确推导（协议 + 端口保留）');
}

console.log('\n[v0.9.5 报告自带「怎么修」+ 生成的 Worker 代码必须真能跑]');
{
  const netErr = Object.assign(new TypeError('Load failed'), { name: 'TypeError' });
  resetFetch([
    { method: 'GET', throws: netErr },
    { method: 'GET', status: 0, body: '' },
    { method: 'PROPFIND', throws: netErr },
    { method: 'PROPFIND', throws: netErr }
  ]);
  const cors = await webdav.diagnose('https://dav.jianguoyun.com/dav', { auth: { user: 'me@example.com', pass: 'PW' }, dir: 'mycard' });
  const cfg = { url: 'https://dav.jianguoyun.com/dav', dir: 'mycard', user: 'me@example.com', pass: 'SUPER-SECRET-PW' };
  const rep = webdav.diagnoseReport(cors, cfg);
  ok(/怎么修：/.test(rep), '报告里直接带「怎么修」（不用另外去翻文档）');
  ok(/复制 Worker 反代代码|Cloudflare/.test(rep) && /workers\.dev/.test(rep), '跨域结论的修复步骤写清「去哪建 Worker / 地址改成什么」');
  ok(/附：修好它的 Worker 反代代码/.test(rep) && /export default \{/.test(rep), '跨域结论下附完整 Worker 代码（复制报告即可直接部署）');
  ok(!rep.includes('SUPER-SECRET-PW'), '报告依然绝不含密码');

  // 生成的 Worker 代码必须是**合法可导入的模块**（v0.9.4 曾因模板里重复声明 url 而报错）
  const { writeFileSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const tmp = `${process.cwd()}/scripts/.tmp-worker-check.mjs`;
  writeFileSync(tmp, webdav.workerProxyCode('https://dav.jianguoyun.com/dav'), 'utf8');
  let workerMod = null;
  let importErr = null;
  try {
    workerMod = await import(pathToFileURL(tmp).href);
  } catch (e) {
    importErr = e;
  }
  const { unlinkSync } = await import('node:fs');
  try {
    unlinkSync(tmp);
  } catch (e) {}
  ok(!importErr, '生成的 Worker 代码能作为 ES 模块加载（无语法/重复声明错误）：' + (importErr ? importErr.message : 'ok'));
  ok(workerMod && workerMod.default && typeof workerMod.default.fetch === 'function', 'Worker 导出 default.fetch（Cloudflare 模块格式正确）');

  // 非跨域结论不硬塞 Worker 代码，但仍给对应建议
  resetFetch([
    { method: 'GET', throws: netErr },
    { method: 'GET', throws: netErr },
    { method: 'PROPFIND', throws: netErr },
    { method: 'PROPFIND', throws: netErr }
  ]);
  const netRep = webdav.diagnoseReport(await webdav.diagnose('https://nas.local/dav', { auth: { user: 'me', pass: 'pw' } }), {
    url: 'https://nas.local/dav',
    dir: 'mycard',
    user: 'me'
  });
  ok(!/Worker 反代代码/.test(netRep) && /手机热点/.test(netRep), '网络类结论给网络建议、不硬塞 Worker 代码');
  ok(webdav.fixSteps({ reason: 'auth' }).length > 0 && /注册邮箱/.test(webdav.fixSteps({ reason: 'auth' })[0]), 'fixSteps 覆盖 401（注册邮箱 / 应用密码）');
  ok(webdav.fixSteps({ reason: 'path' })[0].includes('/dav'), 'fixSteps 覆盖路径问题');
  ok(webdav.fixSteps({ ok: true, reason: 'ok' })[0].includes('立即同步'), 'fixSteps 通过时提示直接同步');
  ok(Array.isArray(webdav.fixSteps({ reason: 'unknown-x' })) && webdav.fixSteps({ reason: 'unknown-x' }).length === 0, '未知 reason 不编造建议');
}

console.log('\n[v0.9.6 页面非 HTTPS / 本机运行：警告 + 本机代理方案]');
{
  // http + 非本机 → 警告步骤（但结论不受影响）
  const saved = globalThis.location;
  globalThis.location = { protocol: 'http:', hostname: '192.168.1.9', href: 'http://192.168.1.9:8080/' };
  resetFetch([
    { method: 'GET', status: 401, body: '' },
    { method: 'PROPFIND', status: 207, body: '' },
    { method: 'PROPFIND', status: 207, body: '' }
  ]);
  const dHttp = await webdav.diagnose('https://dav.example.com/dav', { auth: { user: 'me', pass: 'pw' } });
  const secure = dHttp.steps.find((s) => s.id === 'secure');
  ok(!!secure && secure.status === 'warn', 'http 页面 → 多一个「页面安全性」警告步骤（不算失败）');
  ok(/Service Worker|剪贴板/.test(secure.detail), '警告说明具体后果（Service Worker / 剪贴板不可用）');
  ok(dHttp.ok === true, '警告不影响连接判定（该通还是通）');

  // http + localhost → 修复步骤优先给「本机代理脚本」（零账号）
  globalThis.location = { protocol: 'http:', hostname: 'localhost', href: 'http://localhost:8080/' };
  ok(webdav.isLocalPage() === true, 'isLocalPage：localhost 判定为真');
  resetFetch([
    { method: 'GET', throws: Object.assign(new TypeError('Load failed'), { name: 'TypeError' }) },
    { method: 'GET', status: 0, body: '' },
    { method: 'PROPFIND', throws: Object.assign(new TypeError('Load failed'), { name: 'TypeError' }) },
    { method: 'PROPFIND', throws: Object.assign(new TypeError('Load failed'), { name: 'TypeError' }) }
  ]);
  const localCors = await webdav.diagnose('https://dav.jianguoyun.com/dav', { auth: { user: 'me@example.com', pass: 'pw' }, dir: 'mycard' });
  const localSteps = webdav.fixSteps(localCors, { dir: 'mycard' });
  ok(localSteps[0].includes('dav-proxy.py'), '本机运行时，首要建议是 scripts/dav-proxy.py（零账号）');
  ok(localSteps.some((s) => s.includes('localhost:8080/dav')), '并给出该填的服务器地址 http://localhost:8080/dav');
  ok(localSteps.some((s) => s.includes('python3 -m http.server')), '说明它就是静态站点服务器（可替代 python3 -m http.server）');
  ok(webdav.diagnoseReport(localCors, { url: 'https://dav.jianguoyun.com/dav', dir: 'mycard', user: 'me' }).includes('dav-proxy.py'), '报告里同样给出本机代理方案');
  ok(webdav.setupHints('https://dav.jianguoyun.com/dav').some((h) => h.includes('dav-proxy.py')), '自查清单也提到本机代理脚本');
  ok(webdav.setupHints('https://x.pages.dev/dav').some((h) => h.includes('functions/dav')), '自查清单提到 Pages Function 方案');

  // 非本机 http（局域网）→ 不推本机脚本，走 Worker 方案
  globalThis.location = saved;
  const remoteSteps = webdav.fixSteps({ reason: 'cors', steps: [] }, { dir: 'mycard' });
  ok(remoteSteps[0].includes('Worker') && !remoteSteps[0].includes('dav-proxy.py'), '非本机页面：修复步骤走 Worker 方案（不推本机脚本）');
  ok(remoteSteps.some((s) => s.includes('functions/dav/[[path]].js')), '非本机页面：同时提示「Pages Function」这条同源方案');
  ok(webdav.isLocalPage() === false, 'isLocalPage：非本机页面为假');
}

console.log('\n[配置 / 状态]');
syncMod.clearCredentials();
syncMod.saveConfig({ url: 'https://dav.example.com/dav/', user: 'me', pass: 'secret', dir: 'mybackup', remember: false });
let cfg = syncMod.loadConfig();
ok(cfg.url.endsWith('/dav') && cfg.user === 'me' && cfg.dir === 'mybackup', '保存 URL / 用户名 / 目录（URL 规范化）');
ok(cfg.pass === 'secret' && !mem[syncMod.CONFIG_KEY].includes('secret'), '未勾「记住密码」→ 密码只在内存，不落 localStorage');
ok(syncMod.isConfigured(cfg) === true && syncMod.isConfigured({ url: 'x', user: 'y', pass: '' }) === false, 'isConfigured 判定');
syncMod.saveConfig({ remember: true });
ok(syncMod.loadConfig().pass === 'secret' && mem[syncMod.CONFIG_KEY].includes('secret'), '勾「记住密码」→ 密码落本机（便于自动同步）');
const device = syncMod.deviceName();
ok(/^[a-z]+-[a-z0-9]{4}$/.test(device), 'deviceName 形如 device-xxxx：' + device);
syncMod.saveConfig({ pass: 'p2', lastSyncAt: 1700000000000, lastResult: { ok: true, stats: { cardsAdded: 2 } } });
ok(
  syncMod.loadConfig().lastSyncAt === 1700000000000 && /新增卡片 2/.test(syncMod.lastResultText(syncMod.loadConfig().lastResult)),
  '同步状态可读写（含结果文案）'
);
syncMod.clearCredentials();
cfg = syncMod.loadConfig();
ok(cfg.pass === '' && cfg.remember === false && cfg.url === 'https://dav.example.com/dav', 'clearCredentials：清密码但保留地址 / 用户名');
ok(syncMod.isConfigured(cfg) === false, '清密码后视为未配置（不会误触发自动同步）');
ok(syncMod.signature().includes(':'), 'signature() 生成数据指纹：' + syncMod.signature());
ok(syncMod.syncStatus().configured === false, 'syncStatus 反映未配置');
ok(syncMod.initAutoSync() === false, '未配置时 initAutoSync 不挂任何定时器（返回 false）');
ok((await syncMod.notifyDataChanged()) === null, '未配置时 notifyDataChanged 直接跳过（不发请求）');
syncMod.saveConfig({ url: 'https://dav.example.com/dav', user: 'me', pass: 'pw', autoOnLoad: false, autoOnChange: true });
ok(syncMod.initAutoSync({ runNow: false, interval: 50 }) === true, '配置齐全 → initAutoSync 挂上自动同步');
syncMod.stopAutoSync();
ok(syncMod.isSyncing() === false, 'isSyncing 反映「当前没有在同步」');
syncMod.clearCredentials();
ok(syncMod.loadConfig().autoOnChange === true, '清凭据不影响开关偏好（下次填完密码即可继续自动同步）');

/* ==========================================================================
 * ⑤ v0.9.0：增量传输（索引 + 分卡组文件）/ 预览差异 / 本机专用卡组 / 旧版兼容
 * ========================================================================== */

const SYNC_BASE = 'https://dav.example.com/dav';
const SYNC_DIR = 'mybackup';

/** 极简 WebDAV 服务端桩：按路径存文本（GET / PUT / MKCOL / PROPFIND / DELETE） */
function makeServer(seed = {}) {
  const files = new Map(Object.entries(seed));
  const ops = [];
  return {
    files,
    ops,
    snapshot: () => JSON.stringify([...files.entries()].sort()),
    fetch: async (url, opts = {}) => {
      const method = String(opts.method || 'GET').toUpperCase();
      const path = decodeURIComponent(String(url).replace(`${SYNC_BASE}/`, ''));
      const rel = path === SYNC_DIR ? '' : path.startsWith(`${SYNC_DIR}/`) ? path.slice(SYNC_DIR.length + 1) : path;
      ops.push({ method, path: rel });
      if (method === 'MKCOL') return { status: 201, text: async () => '' };
      if (method === 'PROPFIND') return { status: 207, text: async () => '' };
      if (method === 'GET') {
        return files.has(rel) ? { status: 200, text: async () => files.get(rel) } : { status: 404, text: async () => '' };
      }
      if (method === 'PUT') {
        const existed = files.has(rel);
        files.set(rel, String(opts.body == null ? '' : opts.body));
        return { status: existed ? 204 : 201, text: async () => '' };
      }
      if (method === 'DELETE') {
        files.delete(rel);
        return { status: 204, text: async () => '' };
      }
      return { status: 405, text: async () => '' };
    }
  };
}

/** 接上假服务端 + 配置齐全（同步用例的统一入口） */
function useServer(server) {
  globalThis.fetch = server.fetch;
  syncMod.saveConfig({ url: SYNC_BASE, user: 'u', pass: 'p', dir: SYNC_DIR, remember: true });
}

console.log('\n[「每关词数」也双向同步（v0.9.0 修）]');
{
  store.setSetting('cardsPerLevel', 18);
  const per1 = store.getDb().settings.updatedAt;
  ok(per1 > 0, 'setSetting 记下「每关词数」的改动时间');
  store.setSetting('cardsPerLevel', 18); // 值没变
  ok(store.getDb().settings.updatedAt === per1, '设成同一个值不推进改动时间');
  const snapPer = await syncMod.buildSnapshot();
  ok(snapPer.settings.cardsPerLevel === 18 && snapPer.settings.updatedAt === per1, '快照带上「每关词数」与其改动时间');
  store.applySyncDecks([], { settings: { cardsPerLevel: 26, updatedAt: per1 + 1000 } });
  ok(store.getDb().settings.cardsPerLevel === 26, '落库时采用合并结果里的「每关词数」');
  ok(store.getDb().settings.updatedAt === per1 + 1000, '并采用合并结果里的改动时间（不会把本机当成更新的一方）');
  store.setSetting('cardsPerLevel', 20);
}

console.log('\n[增量布局：索引 + 分卡组文件]');
store.resetAll();
await store.init();
const deckA = store.createDeck({ name: 'A 组' });
const cardA = store.addCard(deckA.id, { front: 'apple', back: '苹果' });
const deckB = store.createDeck({ name: 'B 组' });
store.addCard(deckB.id, { front: 'banana', back: '香蕉' });
const s1 = makeServer();
useServer(s1);
const r1 = await syncMod.syncNow();
ok(r1.ok && r1.uploaded === 2, '首次同步：两个卡组都上传（uploaded=' + r1.uploaded + '）');
const man1 = JSON.parse(s1.files.get('mycard-sync.json'));
ok(man1.app === 'mycard' && man1.formatVersion === 2, '索引文件是新格式（formatVersion 2）');
ok(man1.decks.length === 2 && man1.decks.every((d) => !!d.hash && d.cards === undefined), '索引里只有摘要 + 指纹，没有卡片内容');
ok(s1.files.has(`mycard-decks/${deckA.id}.json`) && s1.files.has(`mycard-decks/${deckB.id}.json`), '每个卡组一个文件：mycard-decks/{id}.json');
ok(!s1.files.has('mycard-sync.prev.json'), '首次同步没有旧索引 → 不产生 prev 备份');
const upA = JSON.parse(s1.files.get(`mycard-decks/${deckA.id}.json`));
ok(upA.cards.length === 1 && upA.cards[0].front === 'apple' && Array.isArray(upA.revlog), '卡组文件里带完整卡片与日志');
ok(man1.settings.cardsPerLevel === store.getDb().settings.cardsPerLevel, '索引带上「每关词数」设置');
ok(syncMod.deckFileOf('plain-id') === 'mycard-decks/plain-id.json', '普通 id 原样作为文件名');
ok(
  syncMod.deckFileName('中文/组') !== syncMod.deckFileName('中文-组') && syncMod.deckFileName('中文/组').startsWith('中文-组-'),
  '含特殊字符的 id → 安全名 + 指纹（不会互相覆盖）'
);

console.log('\n[增量：数据没变 → 一个卡组都不传]');
s1.ops.length = 0;
const r2 = await syncMod.syncNow();
ok(r2.ok && r2.uploaded === 0, '没有变化 → 不重传任何卡组文件');
ok(!s1.ops.some((o) => o.method === 'PUT' && o.path.startsWith('mycard-decks/')), '没有卡组 PUT 请求');
ok(!s1.ops.some((o) => o.method === 'GET' && o.path.startsWith('mycard-decks/')), '内容一致 → 连下载都跳过（只读索引）');
ok(s1.ops.some((o) => o.method === 'PUT' && o.path === 'mycard-sync.json'), '只重写了索引（很小）');
ok(s1.files.has('mycard-sync.prev.json'), '覆盖索引前留了一份 prev 备份');
ok(JSON.parse(s1.files.get('mycard-sync.json')).decks.length === 2, '索引依旧完整（两个卡组）');

console.log('\n[增量：只传被改动的那一个卡组]');
store.updateCard(deckA.id, cardA.id, { back: '苹果（改）' });
s1.ops.length = 0;
const r3 = await syncMod.syncNow();
const deckPuts = s1.ops.filter((o) => o.method === 'PUT' && o.path.startsWith('mycard-decks/') && !o.path.endsWith('.prev.json'));
ok(r3.uploaded === 1 && deckPuts.length === 1, '只重新上传了 1 个卡组');
ok(deckPuts[0] && deckPuts[0].path === `mycard-decks/${deckA.id}.json`, 'PUT 的正是被改的卡组：' + (deckPuts[0] || {}).path);
ok(s1.ops.some((o) => o.method === 'PUT' && o.path.endsWith('.prev.json')), '覆盖旧卡组文件前先备份成 .prev.json');
ok(JSON.parse(s1.files.get(`mycard-decks/${deckA.id}.json`)).cards[0].back === '苹果（改）', '远端内容已更新');

console.log('\n[增量：另一端新增卡组 → 只下载它]');
const bDeck = {
  id: 'devB-deck',
  name: 'B 端新卡组',
  description: '',
  tags: [],
  paused: false,
  cardsPerLevel: null,
  createdAt: 1000,
  updatedAt: 1000,
  demo: false,
  source: null,
  passedLevels: { 0: true },
  cards: [
    {
      id: 'bc1',
      front: 'cherry',
      back: '樱桃',
      createdAt: 1000,
      updatedAt: 1000,
      state: 'review',
      repetitions: 3,
      interval: 7,
      easeFactor: 2.6,
      due: 9e15,
      lastReview: 2000
    }
  ],
  revlog: [{ id: 'br1', cardId: 'bc1', ts: 2000, ease: 1, type: 0, ivl: 7, lastIvl: 3, factor: 2.6, time: 900 }]
};
const manB = JSON.parse(s1.files.get('mycard-sync.json'));
// 用 normalizeSnapshot 生成「另一台设备用本版本写出的文件」（字段已规范化），
// 这样能顺带验证：内容一致时即使跨端也不会白白重传。
const bDeckNorm = syncMod.normalizeSnapshot({ decks: [bDeck] }, 1000).decks[0];
manB.decks.push(syncMod.manifestEntry(bDeckNorm));
manB.savedAt = 5000;
manB.device = 'devB';
s1.files.set('mycard-sync.json', JSON.stringify(manB));
s1.files.set('mycard-decks/devB-deck.json', JSON.stringify(bDeckNorm));
s1.ops.length = 0;
const r4 = await syncMod.syncNow();
const gotB = store.getDeck('devB-deck');
ok(!!gotB && gotB.cards.length === 1 && gotB.cards[0].front === 'cherry', '远端新增的卡组落到本地了');
ok(gotB.cards[0].interval === 7 && gotB.cards[0].lastReview === 2000, '远端的学习进度一起带过来');
ok(gotB.passedLevels[0] === true, '关卡通关记录一起带过来');
ok(r4.uploaded === 0, '本地没有新内容 → 不往上写任何卡组文件');
const deckGets = s1.ops.filter((o) => o.method === 'GET' && o.path.startsWith('mycard-decks/'));
ok(deckGets.length === 1 && deckGets[0].path === 'mycard-decks/devB-deck.json', '只下载变化的那一个卡组：' + deckGets.map((g) => g.path).join(','));
await store.flushPending();
ok((await store.revlogsOfDeck('devB-deck')).length === 1, '远端日志也落库了');

console.log('\n[增量：删除走墓碑；合并后消失的卡组连文件一起删]');
store.deleteCard(deckB.id, store.getDeck(deckB.id).cards[0].id);
s1.ops.length = 0;
const r5 = await syncMod.syncNow();
const remB = JSON.parse(s1.files.get(`mycard-decks/${deckB.id}.json`));
ok(remB.cards.length === 0 && remB.revlog.length === 0, '被删卡片不再出现在远端卡组文件里');
ok(Object.keys(JSON.parse(s1.files.get('mycard-sync.json')).tombstones.cards).length >= 1, '索引带上卡片墓碑（其它设备才会跟着删）');
ok(r5.uploaded === 1, '删除也算变化 → 只重传这个卡组');
store.deleteDeck('devB-deck'); // 记卡组墓碑（删除时间 > 远端副本最后修改/复习 → 真删）
s1.ops.length = 0;
await syncMod.syncNow();
ok(!s1.files.has('mycard-decks/devB-deck.json'), '合并后消失的卡组 → 远端文件也被删掉（不留垃圾）');
ok(!JSON.parse(s1.files.get('mycard-sync.json')).decks.some((d) => d.id === 'devB-deck'), '索引里也不再有它');
ok(s1.ops.some((o) => o.method === 'DELETE'), '确实发了 DELETE');

console.log('\n[本机专用：不上传 / 不被覆盖 / 删除不外传]');
const localDeck = store.createDeck({ name: '私人卡组' });
const secret = store.addCard(localDeck.id, { front: 'secret', back: '私密' });
store.updateDeck(localDeck.id, { syncLocal: true });
ok(store.getDeck(localDeck.id).syncLocal === true, 'updateDeck 支持 syncLocal（会随元信息落盘）');
const snapL = await syncMod.buildSnapshot();
ok(!snapL.decks.some((d) => d.id === localDeck.id), 'buildSnapshot 跳过本机专用卡组');
ok(syncMod.localOnlyDeckIds().includes(localDeck.id) && syncMod.isLocalOnlyDeck(store.getDeck(localDeck.id)), 'localOnlyDeckIds / isLocalOnlyDeck 认得它');
const sigLocal = syncMod.signature();
store.addCard(localDeck.id, { front: 'secret2', back: '私密2' });
ok(syncMod.signature() === sigLocal, '改本机专用卡组不影响数据指纹（不会触发自动同步）');
s1.ops.length = 0;
const r6 = await syncMod.syncNow();
ok(!JSON.parse(s1.files.get('mycard-sync.json')).decks.some((d) => d.id === localDeck.id), '索引里没有本机专用卡组');
ok(!s1.files.has(`mycard-decks/${localDeck.id}.json`), '也不会生成它的卡组文件');
ok(r6.localOnly === 1, '同步结果里报告「本机专用卡组 1 个」');
ok(!!store.getDeck(localDeck.id) && store.getDeck(localDeck.id).cards.length === 2, '同步后它在本地完好无损');
store.deleteCard(localDeck.id, secret.id);
ok(!store.syncTombstones().cards[secret.id], '本机专用卡组里的删除不记墓碑');
ok(!(await syncMod.buildSnapshot()).tombstones.cards[secret.id], '它的墓碑也不会被带出去');
const othersKept = (await syncMod.buildSnapshot()).decks; // 其余可同步卡组（本机专用的不在其中）
const keptL = store.applySyncDecks(othersKept, { keepDeckIds: [localDeck.id] });
ok(!!store.getDeck(localDeck.id) && keptL.removedDecks === 0, 'applySyncDecks 不会删掉本机专用卡组（keepDeckIds）');
store.deleteDeck(localDeck.id);
ok(!store.syncTombstones().decks[localDeck.id], '删掉本机专用卡组也不记墓碑（不会连累别的设备）');
store.setTombstones({ decks: {}, cards: {} });

console.log('\n[预览差异：只读、能看到冲突与传输量]');
store.updateCard(deckA.id, cardA.id, { front: 'apple（本机改）' });
const remA = JSON.parse(s1.files.get(`mycard-decks/${deckA.id}.json`));
remA.cards[0].front = 'apple（远端改）';
remA.cards[0].updatedAt = 500; // 比本机旧 → 内容应取本机
remA.cards[0].lastReview = Date.now() + 10000; // 比本机新 → 进度应取远端
s1.files.set(`mycard-decks/${deckA.id}.json`, JSON.stringify(remA));
const manP = JSON.parse(s1.files.get('mycard-sync.json'));
manP.decks = manP.decks.map((d) => (d.id === deckA.id ? syncMod.manifestEntry(remA) : d));
s1.files.set('mycard-sync.json', JSON.stringify(manP));
const serverBefore = s1.snapshot();
s1.ops.length = 0;
const pv = await syncMod.previewSync();
ok(!s1.ops.some((o) => ['PUT', 'DELETE', 'MKCOL'].includes(o.method)), '预览只发 GET，没有任何写请求');
ok(s1.snapshot() === serverBefore, '预览没有改动网盘上的任何文件');
ok(
  pv.counts.local.decks === 2 && pv.counts.remote.decks === 2 && pv.counts.merged.decks === 2 && pv.counts.merged.cards === pv.counts.local.cards,
  '预览给出本机 / 网盘 / 合并后的规模',
  pv.counts
);
ok(pv.toUpload.includes(deckA.id), '预览指出要上传的卡组');
ok(pv.fetched.includes(deckA.id), '预览指出要下载的卡组（指纹不同）');
const rowA = pv.report.decks.find((d) => d.id === deckA.id);
ok(
  !!rowA && rowA.conflicts.length === 1 && rowA.conflicts[0].contentFrom === 'local' && rowA.conflicts[0].progressFrom === 'remote',
  '冲突明细：内容取本机、进度取远端',
  rowA && rowA.conflicts
);
ok(pv.report.conflicts === 1 && /合并后/.test(syncMod.previewText(pv)), '冲突计数与结论文案：' + syncMod.previewText(pv));
await syncMod.syncNow();
const mergedA = store.getDeck(deckA.id);
ok(mergedA.cards[0].front === 'apple（本机改）', '按预览的结论落库：内容取本机');
ok(mergedA.cards[0].lastReview > Date.now(), '按预览的结论落库：进度取远端');

console.log('\n[兼容 v0.8 单文件快照 → 自动升级为新布局]');
const legacy = {
  app: 'mycard',
  formatVersion: 1,
  savedAt: 777,
  device: 'old',
  settings: { cardsPerLevel: 20 },
  decks: [
    {
      id: 'old-deck',
      name: '老卡组',
      description: '',
      tags: [],
      paused: false,
      cardsPerLevel: null,
      createdAt: 1,
      updatedAt: 1,
      demo: false,
      source: null,
      passedLevels: {},
      cards: [{ id: 'oc1', front: 'old', back: '旧', createdAt: 1, updatedAt: 1 }],
      revlog: []
    }
  ],
  tombstones: { decks: {}, cards: {} }
};
const legacyText = JSON.stringify(legacy);
const s2 = makeServer({ 'mycard-sync.json': legacyText });
useServer(s2);
const pv2 = await syncMod.previewSync();
ok(pv2.legacy === true && pv2.counts.remote.decks === 1, '识别旧版单文件并读出里面的卡组');
ok(pv2.remoteSavedAt === 777 && pv2.remoteDevice === 'old', '旧文件的 savedAt / 设备标识也能读出来');
s2.ops.length = 0;
await syncMod.syncNow();
ok(s2.files.get('mycard-sync.prev.json') === legacyText, '旧文件原样备份到 mycard-sync.prev.json');
const man2nd = JSON.parse(s2.files.get('mycard-sync.json'));
ok(man2nd.formatVersion === 2 && man2nd.decks.every((d) => !d.cards), '索引升级为新格式');
ok(s2.files.has('mycard-decks/old-deck.json'), '旧数据被拆成「按卡组」的文件');
ok(!!store.getDeck('old-deck') && store.getDeck('old-deck').name === '老卡组', '旧数据合并进本地库');

globalThis.fetch = baseFetch;
syncMod.clearCredentials();

/* ==========================================================================
 * 汇总
 * ========================================================================== */

console.log(`\n多端同步测试: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
