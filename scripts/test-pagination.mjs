#!/usr/bin/env node
// ============================================================================
// test-pagination.mjs — 关卡分页测试（关卡数 > 15 时按「第 2/X 页」展示）
//   运行: node scripts/test-pagination.mjs
// ============================================================================

import * as lv from '../js/levels.js';

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const mkLevels = (n) => Array.from({ length: n }, (_, i) => ({ index: i, cards: Array.from({ length: 20 }, () => ({})) }));

console.log('\n[每页关卡数]');
ok(lv.LEVELS_PER_PAGE === 15, '每页 15 关');

console.log('\n[总页数]');
ok(lv.levelPageCount(0) === 1, '0 关 → 1 页');
ok(lv.levelPageCount(15) === 1, '15 关 → 1 页（不触发分页）');
ok(lv.levelPageCount(16) === 2, '16 关 → 2 页');
ok(lv.levelPageCount(45) === 3, '45 关 → 3 页');
ok(lv.levelPageCount(674) === 45, '674 关 → 45 页', lv.levelPageCount(674));

console.log('\n[某关卡所在页]');
ok(lv.levelPageOf(0) === 0, '第 1 关 → 第 1 页');
ok(lv.levelPageOf(14) === 0, '第 15 关 → 第 1 页');
ok(lv.levelPageOf(15) === 1, '第 16 关 → 第 2 页');
ok(lv.levelPageOf(44) === 2, '第 45 关 → 第 3 页');

console.log('\n[页号夹取]');
ok(lv.clampLevelPage(-1, 45) === 0, '负页号 → 第 1 页');
ok(lv.clampLevelPage(9, 45) === 2, '超范围页号 → 末页');
ok(lv.clampLevelPage(1, 45) === 1, '合法页号原样返回');

console.log('\n[分页切片]');
{
  const levels = mkLevels(45);
  const p0 = lv.sliceLevelsPage(levels, 0);
  const p1 = lv.sliceLevelsPage(levels, 1);
  const p2 = lv.sliceLevelsPage(levels, 2);
  ok(p0.length === 15 && p1.length === 15 && p2.length === 15, '45 关分 3 页，每页 15 关');
  ok(p0[0].index === 0 && p0[14].index === 14, '第 1 页 = 第 1–15 关');
  ok(p1[0].index === 15 && p1[14].index === 29, '第 2 页 = 第 16–30 关');
  ok(p2[0].index === 30 && p2[14].index === 44, '第 3 页 = 第 31–45 关');
  ok(lv.sliceLevelsPage(levels, 99).length === 15, '越界页号自动夹取到末页');

  const lvls40 = mkLevels(40);
  ok(lv.sliceLevelsPage(lvls40, 2).length === 10, '40 关的末页为 10 关');
  ok(lv.sliceLevelsPage(lvls40, 2)[0].index === 30, '末页从第 31 关开始');
}

console.log('\n[分页文案（2/X 页）]');
ok(lv.levelPageLabel(1, 45) === '第 2/3 页', '45 关第 2 页 → 「第 2/3 页」', lv.levelPageLabel(1, 45));
ok(lv.levelPageLabel(0, 674) === '第 1/45 页', '第 1 页 → 「第 1/45 页」');
ok(lv.levelPageLabel(99, 45) === '第 3/3 页', '越界页号文案自动夹取');

console.log('\n[大词库规模（每关 20 词）]');
{
  const decks = [
    { name: 'A', words: 3223 },
    { name: 'B', words: 6008 },
    { name: 'C', words: 7508 },
    { name: 'D', words: 5651 },
    { name: 'E', words: 5057 },
    { name: 'F', words: 8887 },
    { name: 'G', words: 13477 },
    { name: 'H', words: 3427 },
    { name: 'I', words: 4616 },
    { name: 'J', words: 12175 }
  ];
  const rows = decks.map((x) => ({ ...x, levels: lv.computeLevelCount(x.words, 20) }));
  ok(rows.every((r) => r.levels > 15), '十个大词库的关卡数都 > 15（均会分页）');
  ok(rows.every((r) => lv.levelPageCount(r.levels) >= 2), '十个大词库都为多页');
  console.log('    ' + rows.map((r) => `${r.name}:${r.levels}关/${lv.levelPageCount(r.levels)}页`).join('  '));
}

console.log(`\n关卡分页结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
