#!/usr/bin/env node
// ============================================================================
// test-revlog.mjs — 复习日志（revlog）纯函数测试
//   运行: node scripts/test-revlog.mjs
// 覆盖：ease/type 映射（学习 / 复习 / 重学）、条目生成与单位（ivl = 天）、
//       非法输入清洗与截断、排序 / 汇总 / 遗忘次数、Anki revlog 换算（学习步=秒）
// ============================================================================

const revlog = await import('../js/revlog.js');

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
const sec = (t) => console.log('\n' + t);

const TS = 1700000000000;

/* ------------------------------------------------------------------ */
sec('1. 反馈档位 ↔ Anki ease / type');

ok(revlog.EASE_BY_FEEDBACK.again === 1 && revlog.EASE_BY_FEEDBACK.hard === 2, 'ease 映射：again=1 / hard=2');
ok(revlog.EASE_BY_FEEDBACK.good === 3 && revlog.EASE_BY_FEEDBACK.easy === 4, 'ease 映射：good=3 / easy=4');
ok(revlog.FEEDBACK_BY_EASE[4] === 'easy' && revlog.FEEDBACK_BY_EASE[1] === 'again', 'ease → 反馈档位可逆');
ok(revlog.easeOf('nope') === null, '未知档位 → ease 为 null');
ok(revlog.reviewTypeOf({ state: 'new' }, 'good') === revlog.REVIEW_TYPES.LEARN, '新卡答「记住」→ type 0（学习）');
ok(revlog.reviewTypeOf({ state: 'review' }, 'good') === revlog.REVIEW_TYPES.REVIEW, '复习卡答「记住」→ type 1（复习）');
ok(revlog.reviewTypeOf({ state: 'review' }, 'again') === revlog.REVIEW_TYPES.RELEARN, '复习卡答「重来」→ type 2（重学 / lapse）');
ok(revlog.reviewTypeOf({ state: 'learning' }, 'again') === revlog.REVIEW_TYPES.LEARN, '学习卡再答「重来」→ type 0（学习步）');
ok(revlog.reviewTypeOf({ state: 'learning' }, 'good') === revlog.REVIEW_TYPES.RELEARN, '学习卡答「记住」（出学习步）→ type 2');

/* ------------------------------------------------------------------ */
sec('2. makeEntry：条目生成与单位');

const before = { id: 'c1', state: 'review', interval: 4, easeFactor: 2.5 };
const after = { id: 'c1', state: 'review', interval: 10, easeFactor: 2.6 };
const e1 = revlog.makeEntry({ cardId: 'c1', ts: TS, feedback: 'good', before, after, timeMs: 3200 });
ok(e1 && e1.id === `${TS}-c1`, 'id = 时间戳-卡片 id，便于去重', e1 && e1.id);
ok(e1.cardId === 'c1' && e1.ts === TS && e1.ease === 3 && e1.type === 1, '基础字段正确', e1);
ok(e1.ivl === 10 && e1.lastIvl === 4, 'ivl / lastIvl 记录为「天」（本机统一单位）', [e1.ivl, e1.lastIvl]);
ok(e1.factor === 2600, 'factor = easeFactor × 1000（整数）', e1.factor);
ok(e1.time === 3200, 'time = 单卡停留毫秒', e1.time);

const e2 = revlog.makeEntry({
  cardId: 'c1',
  ts: TS,
  feedback: 'again',
  before,
  after: { interval: 10 / 1440, easeFactor: 2.3 },
  timeMs: 0
});
ok(e2.type === revlog.REVIEW_TYPES.RELEARN, '复习卡遗忘 → 重学日志', e2.type);
ok(Math.abs(e2.ivl - 10 / 1440) < 1e-9, '重学步间隔（10 分钟）按天保存', e2.ivl);

ok(revlog.makeEntry({ cardId: '', ts: TS, feedback: 'good' }) === null, '无卡片 id → null');
ok(revlog.makeEntry({ cardId: 'c1', ts: TS, feedback: 'meh' }) === null, '未知档位 → null');
ok(revlog.makeEntry({ cardId: 'c1', ts: 0, feedback: 'good' }) === null, '无时间戳 → null');
ok(revlog.clampFactor(99) === 3000 && revlog.clampFactor(1) === 1300, 'factor 钳制到 1300~3000');
ok(revlog.clampTime(-5) === 0 && revlog.clampTime(9e9) === revlog.MAX_TIME_MS, '停留时长钳制到 0~1 小时');

/* ------------------------------------------------------------------ */
sec('3. sanitizeEntry / pickReviewLog：外部 JSON 清洗');

ok(revlog.sanitizeEntry(null) === null && revlog.sanitizeEntry('x') === null, '非对象 → null');
ok(revlog.sanitizeEntry({ ts: 0 }) === null, '无 ts → null');
const noId = revlog.sanitizeEntry({ ts: TS, ease: 3, type: 1 });
ok(noId && noId.cardId === '', '允许缺少 cardId（由导入侧按单词回填）', noId);
ok(noId.id === `${TS}-`, 'id 缺省由 ts 生成，仍保证可去重', noId.id);
const s1 = revlog.sanitizeEntry({ ts: TS, ease: 9, type: 42, ivl: -3, lastIvl: 1e9, factor: 1, time: -1 }, 'card-x');
ok(s1 && s1.cardId === 'card-x', '缺少 cardId 时使用兜底 id', s1);
ok(s1.ease === 3 && s1.type === revlog.REVIEW_TYPES.REVIEW, 'ease / type 越界回落到默认值', [s1.ease, s1.type]);
ok(s1.ivl === 0 && s1.lastIvl === 36500, 'ivl 负数 → 0；lastIvl 超上限 → 36500 天', [s1.ivl, s1.lastIvl]);
ok(s1.factor === 1300 && s1.time === 0, 'factor / time 越界被钳制', [s1.factor, s1.time]);
ok(revlog.sanitizeEntry({ ts: TS, cid: 'card-y', factor: 2500 }).cardId === 'card-y', '兼容 Anki 的 cid 字段');

const picks = revlog.pickReviewLog({ reviewLog: [{ ts: TS, ease: 4 }, { ts: TS + 5, ease: 2 }, { ts: 0 }] });
ok(picks.length === 2, 'pickReviewLog 丢弃非法条目', picks.length);
ok(picks[0].ease === 4 && picks[1].ease === 2, 'pickReviewLog 按时间升序输出', picks.map((x) => x.ease));
ok(revlog.pickReviewLog({ revlog: [{ ts: TS, ease: 1 }] }).length === 1, '兼容 revlog 字段名');
ok(revlog.pickReviewLog({}).length === 0 && revlog.pickReviewLog(null).length === 0, '无日志 → 空数组');

const many = [];
for (let i = 0; i < revlog.MAX_IMPORT_LOG + 25; i++) many.push({ ts: TS + i, ease: 3 });
const cut = revlog.pickReviewLog({ reviewLog: many });
ok(cut.length === revlog.MAX_IMPORT_LOG, `导入单卡上限 ${revlog.MAX_IMPORT_LOG} 条`, cut.length);
ok(cut[cut.length - 1].ts === TS + revlog.MAX_IMPORT_LOG + 24, '截断保留最近的一批', cut[cut.length - 1].ts);

const dup = revlog.pickReviewLog({ reviewLog: [{ id: 'x', ts: TS, ease: 3 }, { id: 'x', ts: TS, ease: 1 }] });
ok(dup.length === 1 && dup[0].ease === 3, '同 id 条目去重（保留首次）', dup);

const cardBound = revlog.pickReviewLog({ id: 'c9', reviewLog: [{ ts: TS, ease: 2 }] });
ok(cardBound[0].cardId === 'c9', '顶层卡片有 id 时作为日志归属兜底', cardBound[0].cardId);
const moved = revlog.reattach(cardBound[0], 'new-id');
ok(moved.cardId === 'new-id' && moved.id === `${TS}-new-id`, 'reattach 重新归属并刷新主键', moved);
ok(revlog.reattach(cardBound[0], 'c9') === cardBound[0], 'reattach 归属相同则原样返回');

/* ------------------------------------------------------------------ */
sec('4. 排序 / 汇总 / 遗忘次数');

const list = [
  { id: 'b', ts: TS + 10, ease: 1, type: 2, ivl: 0.0069, lastIvl: 4, factor: 2300, time: 1000, cardId: 'c1' },
  { id: 'a', ts: TS, ease: 3, type: 1, ivl: 4, lastIvl: 0, factor: 2500, time: 2000, cardId: 'c1' },
  { id: 'c', ts: TS + 20, ease: 4, type: 1, ivl: 12, lastIvl: 0.0069, factor: 2500, time: 500, cardId: 'c1' }
];
ok(revlog.sortEntries(list).map((x) => x.id).join('') === 'abc', 'sortEntries 按 ts 升序');
ok(list[0].id === 'b', 'sortEntries 不修改原数组');
ok(revlog.lapsesOf(list) === 1, 'lapsesOf 统计 type=2（遗忘）条数');
const sum = revlog.summarize(list);
ok(sum.total === 3 && sum.lapses === 1 && sum.timeMs === 3500, 'summarize：条数 / 遗忘 / 总时长', sum);
ok(sum.ease.again === 1 && sum.ease.good === 1 && sum.ease.easy === 1, 'summarize：各档位次数', sum.ease);
ok(sum.first === TS && sum.last === TS + 20, 'summarize：首尾时间戳', [sum.first, sum.last]);
ok(revlog.summarize([]).total === 0, '空日志汇总为 0');

/* ------------------------------------------------------------------ */
sec('5. Anki revlog 行换算（学习步 = 负秒数，Anki 约定正=天 / 负=秒）');

const learn = revlog.makeEntry({
  cardId: 'c1',
  ts: TS,
  feedback: 'again',
  before: { state: 'new' },
  after: { interval: 10 / 1440, easeFactor: 2.3 }
});
ok(revlog.entryToAnkiIvl(learn) === -600, '学习步 ivl → -600 秒（10 分钟）', revlog.entryToAnkiIvl(learn));
ok(revlog.entryToAnkiLastIvl(learn) === 0, '新卡上一次间隔 → 0', revlog.entryToAnkiLastIvl(learn));
ok(revlog.entryToAnkiIvl({ type: revlog.REVIEW_TYPES.LEARN, ivl: 1 }) === 1, '满 1 天的步长 → 正数天（1）');
ok(revlog.entryToAnkiIvl({ type: revlog.REVIEW_TYPES.RELEARN, ivl: 0.5 }) === -43200, '半天的重学步 → -43200 秒');
const reviewRow = revlog.toAnkiRow(list[0], 12345, 1700000000010000);
ok(reviewRow.length === 9, 'toAnkiRow 输出 9 列（与 revlog 表一致）', reviewRow.length);
ok(reviewRow[0] === 1700000000010000 && reviewRow[1] === 12345 && reviewRow[2] === 0, 'id / cid / usn 正确', reviewRow.slice(0, 3));
ok(reviewRow[3] === 1 && reviewRow[8] === 2, 'ease / type 透传（重学 → 2）', [reviewRow[3], reviewRow[8]]);
ok(reviewRow[4] === -596 && reviewRow[5] === 4, '重学步 → -596 秒；遗忘前的间隔仍按天（4）', [reviewRow[4], reviewRow[5]]);
ok(reviewRow[6] === 2300 && reviewRow[7] === 1000, 'factor / time 正确', [reviewRow[6], reviewRow[7]]);
ok(revlog.entryToAnkiIvl({ type: revlog.REVIEW_TYPES.REVIEW, ivl: 0.2 }) === 1, '复习卡间隔不足 1 天 → 至少 1 天（与 cards.ivl 一致）');
ok(revlog.entryToAnkiLastIvl({ type: revlog.REVIEW_TYPES.REVIEW, lastIvl: 0 }) === 0, '复习卡首次评分 lastIvl = 0');

console.log(`\n复习日志（revlog）结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

