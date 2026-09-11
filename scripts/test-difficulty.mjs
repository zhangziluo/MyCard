#!/usr/bin/env node
// ============================================================================
// test-difficulty.mjs — 难度判定维度测试（词频/词长/音节/熟悉度/语种特性）
//   运行: node scripts/test-difficulty.mjs
// ============================================================================

import * as d from '../js/difficulty.js';

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/* ---------- 模拟外部词频数据（词表：序号越小越高频） ---------- */
d.setFrequency({
  the: 1, time: 20, cat: 300, book: 900, water: 1500,
  engineer: 4000, pronunciation: 9000, ubiquitous: 15000, onomatopoeia: 19000
});

console.log('\n[词频数据]');
ok(d.FREQ_MAX === 20000, 'FREQ_MAX = 20000');
ok(d.frequencyLoaded() === true, '词频表已注入');
ok(d.freqRank('the') === 1, 'the → 1');
ok(d.freqRank(' Time ') === 20, '大小写/空格归一（Time → 20）', d.freqRank(' Time '));
ok(d.freqRank('zzzz') === d.FREQ_UNKNOWN, '未收录词 → FREQ_UNKNOWN');
ok(d.frequencyScore('the') < d.frequencyScore('onomatopoeia'), '高频词词频分更低（更简单）');
ok(d.frequencyScore('the') === 0 + Math.log10(2) / Math.log10(20001) || d.frequencyScore('the') < 0.2, '第 1 名词频分接近 0');

console.log('\n[基础特征：词长 / 音节]');
ok(d.wordLength('hello') === 5, '英文按字母数（hello=5）');
ok(d.wordLength('中文词') === 3, '中文按字数（中文词=3）');
ok(d.wordLength('  ab  ') === 2, '忽略首尾空格');
ok(d.estimateSyllables('make') === 1, 'make → 1 音节（词尾 e 不发音）');
ok(d.estimateSyllables('cat') === 1, 'cat → 1 音节');
ok(d.estimateSyllables('beautiful') === 3, 'beautiful → 3 音节', d.estimateSyllables('beautiful'));
ok(d.estimateSyllables('table') === 2, 'table → 2 音节（-le 保留）', d.estimateSyllables('table'));
ok(d.estimateSyllables('') === 0, '空词 → 0');

console.log('\n[语种特性：英文不规则拼写]');
ok(d.englishSpellingScore('though') > d.englishSpellingScore('dog'), '不规则拼写 though > dog');
ok(d.englishSpellingScore('knight') > d.englishSpellingScore('cat'), 'kn/gh 组合更难（knight > cat）');
ok(d.englishSpellingScore('cat') < 0.2, '规则短词拼写分低');

console.log('\n[语种特性：古文 / 日语]');
{
  const common = new Set('我等你好世界花草');
  ok(d.rareCharRatio('我等你', common) === 0, '全为常用字 → 生僻占比 0');
  ok(d.rareCharRatio('我黼', common) === 0.5, '含 1 个生僻字 → 0.5', d.rareCharRatio('我黼', common));
  ok(d.languageScore('我黼', 'zh-classic', { commonChars: common }) === 0.5, '古文维度走生僻字占比');
  ok(d.languageScore('日本語', 'ja') === 1, '日语维度走汉字占比');
  ok(d.japaneseKanjiScore('かな') === 0, '纯假名 → 0');
}

console.log('\n[熟悉度]');
{
  const fresh = { front: 'time', lastReview: null, repetitions: 0, easeFactor: 2.5 };
  const learned = { front: 'time', lastReview: 1700000000000, repetitions: 6, easeFactor: 2.8 };
  const mastered = { front: 'time', lastReview: 1700000000000, repetitions: 6, easeFactor: 3.0 };
  const struggling = { front: 'time', lastReview: 1700000000000, repetitions: 1, easeFactor: 2.0 };
  ok(d.familiarity(fresh) === 0, '新卡熟悉度 0');
  ok(d.familiarity(mastered) === 1, '连续答对 6 次 + 最高 ease → 熟悉度 1', d.familiarity(mastered));
  ok(d.familiarity(learned) > 0.9, '连续答对 6 次 → 熟悉度 > 0.9', d.familiarity(learned));
  ok(d.familiarity(struggling) < d.familiarity(learned), '吃力卡熟悉度更低');
  ok(d.familiarity(learned, { hardCount: 3 }) < d.familiarity(learned), '困难词标记降低熟悉度');
}

console.log('\n[综合难度]');
{
  const newCard = (front) => ({ front, lastReview: null, repetitions: 0, easeFactor: 2.5 });
  const cat = d.cardDifficulty(newCard('cat'), { lang: 'en' });
  const long = d.cardDifficulty(newCard('pronunciation'), { lang: 'en' });
  ok(cat >= 0 && cat <= 100, '难度分在 0–100 之间');
  ok(cat < long, '短高频词难度低于长低频词', { cat, long });
  const the = d.cardDifficulty(newCard('the'), { lang: 'en' });
  ok(the < d.cardDifficulty(newCard('ubiquitous'), { lang: 'en' }), 'the 比 ubiquitous 简单');
  const learned = d.cardDifficulty({ front: 'pronunciation', lastReview: 1, repetitions: 6, easeFactor: 2.8 }, { lang: 'en' });
  ok(learned < long, '熟悉度降低难度', { learned, long });
}

console.log('\n[缓存不污染数据]');
{
  const cards = [{ front: 'time', lastReview: null }];
  d.scoreCards(cards, { lang: 'en' });
  ok(!Object.keys(cards[0]).includes('__difficulty'), '缓存键不可枚举（不会被 JSON 序列化）');
  ok(JSON.stringify(cards[0]).indexOf('__difficulty') === -1, 'JSON 输出不含缓存');
  d.clearScoreCache(cards);
  ok(cards[0].__difficulty === undefined, 'clearScoreCache 可清除');
}

console.log('\n[难度分档]');
{
  const bands = d.difficultyBands(60, 3);
  ok(bands.length === 3, '60 张分 3 档');
  ok(bands[0].start === 0 && bands[1].start === 20 && bands[2].start === 40, '档位起点正确', bands);
  ok(bands.every((b) => b.end - b.start === 20), '每档 20 张');
  ok(d.difficultyBands(0, 3).length === 0, '空输入 → 空档位');
}

console.log(`\n难度判定结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
