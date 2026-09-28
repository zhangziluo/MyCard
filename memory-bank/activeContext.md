# Active Context — 当前焦点

> 更新时间：2026-09-28 ｜ APP `v0.5.9` / SW `v1.9.0` ｜ v0.4.13 ~ v0.5.9 已交付，**2604 条校验全绿**

## 当前状态
**v0.4.13（导出扩展）→ v0.5.9（「我的生词」批量整理）连续多轮功能均已实现、校验全绿**。**没有进行中的功能**。

## 最近完成（倒序）
1. **v0.5.9「我的生词」批量整理（`#/words`）**：新增 `js/wordbook.js`（纯函数内核：`normKey`（正面 `trim` + 小写 = 「同一个词」）、`STATE_RANK`/`keepScore`/`pickKeeper`（保留优先级：复习状态 > 次数 > 间隔 > easeFactor > 加入最早 > id）、`dupGroups`/`dedupeStats`、`mergeText`/`mergeInto`/`mergeGroup`/`mergePlans`（首义仍为第一义、其余义进 `extraBacks` 去重、标签取并集、进度与 revlog 不动）、`tagCounts`/`applyTagEdit`/`tagPatchPlans`/`renameTagPlans`（`from` 空 = 删除）、`filterWords`/`sortWords`/`SORTS`/`ALL`/`UNTAGGED`/`statsOf`、`toggleId`/`idsOf`/`isAllSelected`/`isPartialSelected`/`limitSelection`/`lookupTargets`）；新增 `js/wordbook-view.js`（`#/words` 页：概览下钻 / 搜索（防抖 180ms + 重渲染后**恢复焦点与光标**）/ 标签·来源 chips / 排序 / 每页 `WORDS_PER_PAGE = 100` 分页走 URL、合并报告 → 确认后落库、多选批量（加·去标签 / 在线补查 / 删除）、标签管理（重命名 / 删除））；`js/store.js` 新增 `mergeCards`（删副卡 + `purgeRevlogs` 级联）/`updateCards`（批量写）/`addWords({merge})`；`js/add-words.js` 新增「重复词自动合并」偏好（`MERGE_PREF_KEY = 'mycard-aw-merge'`，默认开，`isMergeEnabled`/`setMergeEnabled`，`addWords` 报告 `merged`/`skipped`）+ `prefillInput`/`peekPendingPrefill`（补查回填查词框）；`js/app.js` 路由 `#/words?page=N` + `APP_VERSION v0.5.9`、`js/decks.js` 两处入口（卡组页图标 + 菜单）、`js/ui.js` 共享 `icon`；`sw.js` `v1.9.0`
2. **v0.5.8 复习日志（revlog）与 apkg 学习步保真**：新增 `js/revlog.js`（纯函数）——`REVIEW_TYPES`/`EASE_BY_FEEDBACK`/`FEEDBACK_BY_EASE`、`makeEntry`（`id = ts-cardId`、`ivl`/`lastIvl` 统一存**天**、`factor = easeFactor×1000`、`time` 停留毫秒封顶 1h）、`reviewTypeOf`（学习 0 / 复习 1 / 重学 2）、`sanitizeEntry`/`pickReviewLog`（兼容 `reviewLog`/`revlog`/`cid`，去重、单卡上限 `MAX_IMPORT_LOG=500`、越界一律钳制）、`sortEntries`/`lapsesOf`/`summarize`、`reattach`（回导时重新归属卡片并刷新主键）、`entryToAnkiIvl`/`toAnkiRow`（**不足 1 天的学习步 = 负数秒**，≥1 天 = 正数天，Anki 约定）；`idb.js` **库 v2 → v3**（新增 `revlog` store：keyPath `id` + `byDeck`/`byCard` 索引，增量升级只补建、旧数据不动，`clearAll` 一并清空）；`store.js` 新增 `recordReview`/`queueRevlog`/`importRevlogs`/`revlogsOfDeck`/`revlogsOfCard`/`revlogStats`（`pendingRevlogs` 写穿队列并入 `flushPending`，回退模式随卡组存整库），删卡片 / 删卡组 `purgeRevlogs` **级联清理**；`review.js` 评分时快照「评分前」字段（`updateCard` 会原地改对象）+ 记录 `S.shownAt` 停留时长后写日志；`export.js` `cardToAnkiSched` 补 `lapses`/`left`/`mod`、**学习卡 `due` = 到期 epoch 秒、`ivl` = 剩余秒**，`buildCollection` 逐条 `INSERT INTO revlog`（同毫秒主键递增去重），`deckToJson` 升 `formatVersion: 2` + 每卡 `reviewLog`，`exportDeckJson`/`exportDeckApkg` 导出前 `store.revlogsOfDeck`；`import-file.js` `pickLogFields`/`collectReviewLogs`/`attachReviewLogs`（按 front 匹配、落库后重新归属）+ 成功提示显示「恢复复习日志 N 条」
2. **v0.5.7 `.xlsx` 多工作表 / 公式 / 合并单元格**：`js/xlsx.js` 升级——`workbookSheets()`（解析 `xl/workbook.xml` + `xl/_rels/workbook.xml.rels`，含隐藏表标注）/`listXlsxSheets()`/`openXlsx()`（一次读字节 + 多表）/`parseXlsxSheets()`；**公式**自写分词-解析-求值（`evalFormula`/`isFormulaSupported`/`FORMULA_MODE`：算术 `+-*/^`、比较、`&`、区域引用，函数 `SUM/AVERAGE/COUNT/COUNTA/MIN/MAX/ROUND/ABS/INT/MOD/POWER/SQRT/LEN/LEFT/RIGHT/MID/UPPER/LOWER/TRIM/CONCAT/IF/IFERROR/AND/OR/NOT/TRUE/FALSE`，`IF/IFERROR` 惰性），**默认优先用 Excel 缓存 `<v>`**，缓存缺失或 `formulaMode:`evaluate`` 才求值，循环引用 / 不支持函数（`VLOOKUP`、跨表）回退缓存；**合并单元格** `parseMerges`/`applyMerges`（默认 `MERGE_FILL` 左上角值填充 + 区域外自动补齐行列，可切 `MERGE_BLANK`）；`parseSheetDetailed()` 输出 `{rows, merges, notices}`；导入侧 `rowsPreview` 带 `sheet`/`notices`，新增 `xlsxWorkbookPreview`/`sheetPickerHtml`/`bindSheetPicker`（**仅多表时渲染**切换器，预览内实时切表）、`previewMetaHtml` 显示工作表名与「已计算 N 个公式 / M 个用缓存 / 补全 K 格」，`importMapped`/`runMappedImport`/表格编辑页 `loadFileIntoTable` 均支持 `{ sheet }`
2. **v0.5.6 抽题快路径补全**：`test-engine.js` 新增**快路径 B**——「带优先池且词数 ≥ 题数」时非优先槽位用**「交换删除」的部分洗牌** O(1) 取「尚未用过的词」（优先槽位取走的词用 `posOf` O(1) 摘除），优先槽位仍走错题池 `pickLeastUsed`；`pickLeastUsed`/`lastUse`/`used`/`seq` 提升为共享状态。复杂度 O(词数 + 题数)，**1 万词 / 150 题 + 40 题优先池 ~47ms → ~4ms**；4 组配置 × 2 万次采样验证与逐次「最少用量」分布相对偏差 < 0.1%。测试：`test-perf` 用 **Proxy 计数卡组读取次数**（~3 万 vs 慢路径 ~75 万，断言 < 10 万）+ `test-deck-test` 新增不变量段
3. **v0.5.5 表格编辑页增强**：`table-editor.js` 新增**粘贴多行**（`gridFromPaste`/`applyPaste`：Tab/换行解析、自动补行至 5000、超 6 列截断、**单格不拦截**；`bindPasteOnce()` 文档级绑定且只绑一次）、**单元格改 `<textarea rows=1>` 自适应高度**（封顶 200px）、**导入前预览 / 校验报告**（`importPreviewRows`/`importReport`/`importPreviewHtml`/`openTableImportPreview`，`te-import-deck` 确认后才写库）
4. **v0.5.4 模版增强**：新增 **JSON 模版**（`jsonTemplate`/`jsonTemplateText`/`downloadJsonTemplate`/`jsonTemplateButtonHtml`，含 1 完整 + 1 最简示例）；**CSV 模版示例行可选**（`CSV_TEMPLATE_VARIANTS` = 仅表头 / 1 行 / 多行示例，`openCsvTemplateDialog()` 下载前先选，默认仍 1 行）
5. **v0.5.3 表格编辑页 `#/editor`（导入流程的「网页内录入」入口）**：新增 `js/table-editor.js`（列 = `CSV_TEMPLATE_COLUMNS` 同源；纯函数内核 `normalizeTable`/`cleanRows`/`tableToWords`/`wordsToTable`/`tableStats`/`setCell`/`addRow`/`removeRow`/`moveRow`/`alignToTemplate`/`tableCsvRows`/`tableCsvText`；UI = 表格 ＋ 统计条 ＋ 工具栏）；支持逐格录入、**从文件载入**（CSV/TSV/XLSX/JSON）、**下载 CSV**、**草稿**（`mycard-table-draft`）、**导入为卡组**（新建 / 追加）。导入复用新抽出的 `import-file.importWordsToDeck` → `validatePayload` → `seedBuiltinDeck`/`addManyCards` → `recordImport` → `importSuccessHtml`，**导入历史 / 撤销 / 去重与文件导入完全一致**；首页导入栏新增「在网页里填表格」入口
6. **v0.5.2 标准 CSV 模版**：导入栏（拖拽区下方）新增「下载 CSV 模版」——`csvTemplateText()`（UTF-8 BOM + 中文规范列名 `单词/释义/例句/例句翻译/音标/标签`（可自动对号）+ **1 行示例**）、`downloadCsvTemplate()`、`csvTemplateButtonHtml()`；UI/README 均提示「导入前请删除示例行」
7. **v0.5.1 关卡测试题型收敛**：`js/test.js` 的 `typesForRetry()` 改用 `cfg.QUESTION_TYPES`（基础 5 种），**关卡测试不再混入 `eng_eng`/`multi_sense`**；整卡组可配置测试不受影响（仍按配置启用可选题型）
8. **v0.5.0 导入增强**：新增 **`.xlsx`**（`js/xlsx.js` 零依赖：自写 ZIP 读取 + 最小 XML 扫描 → 同一套预览/字段映射）、**多文件批量**（选择器/拖拽多选 → 每文件各建一卡组 + 批量汇总）、**导入历史 / 回滚**（`js/import-history.js`：撤销 = 删新建卡组 / 只移除追加的新增卡片，cardIds 存 IDB）
9. **v0.4.19 非文字前景随主色**：CSS 8 处非文字 `var(--accent)` → `var(--accent-tx)`（焦点环 / 输入与高亮边框 / `.q-blank` 下划线 / 原生 `accent-color`），浅色系主色下同样醒目
10. **v0.4.18 卡片管理分页**：`CARDS_PER_PAGE = 100` + `cards-page`，万级卡组不再一次性塞入上万 DOM 节点；并做仓库瘦身（删 `backup-before-rewrite` 与 Cline 检查点 refs + gc → `.git` 49M → 2.4M）
11. **v0.4.17 大卡组性能**：`deckStats` 单遍遍历、`levelStates(deck, levels)` 复用分组、抽题 O(n) 快路径（万级 150 题 ~400ms → ~10ms）；新增 `test-perf.mjs`
12. **v0.4.16 复习进度迁移**：`.apkg` `cards` 表按进度写调度（`cardToAnkiSched`）+ **JSON 完整导出/导入**（无损往返，含多释义/分组）
13. **v0.4.15 对比度求解 + `--accent-tx`**：WCAG 相对亮度二分（任意自定义色两底色都 ≥4.5:1）+ 深色底提亮一档
14. **v0.4.14 主题对比度**：`--tag-tx` 随 accent 派生（深/浅二档）
15. **v0.4.13 导出扩展**：新增 CSV（RFC 4180）与 Markdown 导出 + `.apkg` 补 `meta` protobuf
（更早版本见 `progress.md`）

## 关键决策（近期）
- 需求若来自其它栈（Vue/React/TS/Dexie/PapaParse），先确认再**适配到纯 JS 栈**（已发生 3 次）
- 词库与词条的落库策略：新牌组走 `seedBuiltinDeck`（难度分层+错峰编排）；追加到已有牌组走 `addManyCards`（重拆关卡）；均按单词去重
- 「我的生词」用 `deck.source==='custom'` 识别，不再用 `level:'custom'`
- 导出 apkg 采用**内置 sql.js**（用户明确选择，接受打破「零依赖」）而非手写 SQLite
- `.apkg` 的 `meta` 取 **`LEGACY_1(1)` + 保留 `collection.anki2`**（而非 Anki 自身 legacy 导出的 `LEGACY_2(2)` + `collection.anki21`）：两者新版 Anki 都认，但 LEGACY_1 与 schema v11 自洽且**不破坏 <2.1.50 老版 Anki**；protobuf 仅 `field1=varint`，故自写 2 字节编码 `08 01`，不引 protobuf 库
- 主题「强调文字色」由 JS 按 accent 派生（`--tag-tx-dark`/`--tag-tx-light`）写 `<html>`，CSS 按 `data-theme` 二选一 → 切色/切模式解耦（`applyMode` 不必知道 accent）；算法 = **保持色相 / 饱和度 + 用 WCAG 相对亮度对 HSL 亮度二分**（目标 4.5:1，任意自定义色均成立，v0.4.15 起替换固定混色）；`--accent-tx` 是 `--tag-tx` 的别名，统一所有「accent 作文字色」的入口；`--soft-danger-tx` 属危险语义色**刻意不跟随** accent
- 复习进度迁移走两条路：**`.apkg`（→Anki，日粒度近似 due）** 与 **JSON（↔Mycard，无损往返）**；txt/CSV/Markdown 刻意保持纯「词表」。导入侧进度校验统一走 `store.pickScheduling`（state 白名单 / easeFactor 1.3–3.0 / 数值钳制），非法值回退新卡
- 复习日志（v0.5.8）三处约定：①**本机单位统一为「天」**（`ivl`/`lastIvl` 存浮点天数），只有导出 Anki 时才换算，**≥1 天 = 正数天、不足 1 天的学习步 = 负数秒**（Anki 的 `interval_secs()` 正是这么解读的，正数秒会被当成「600 天」）；②**日志只追加、不覆盖**（本机不设上限，只有「从外部 JSON 导入」按 `MAX_IMPORT_LOG=500` 截断 + 越界钳制），删卡片 / 删卡组 `purgeRevlogs` 级联清理；③**回导按单词重新归属**：落库会重排关卡、卡片 id 全变，故 `attachReviewLogs` 用 `front` 小写匹配再 `revlog.reattach`（同步刷新 `id = ts-cardId`，避免跨卡重号）；`deckToJson` 因此升到 `formatVersion: 2`
- Anki `cards` 表对学习卡的语义与复习卡不同：学习卡 `due` = **到期时刻（epoch 秒）**、`ivl` = **剩余秒**、`left` = 剩余步数（复习卡才是「相对天数 + 整天」）；`mod` 取 `lastReview`、`lapses` 由日志里 type=2（重学）条数推导 —— 别把学习卡按复习卡写（否则 Anki 会当成「几天后才到期」）
- `review.js` 评分链路必须**先快照「评分前」字段再 `applyFeedback`**：`store.updateCard` 会**原地修改**卡片对象，若把 `card` 直接传给 `recordReview`，日志里的 `lastIvl`（评分前间隔）与 `type`（学习/复习/重学判定）都会被污染（`test-review-interaction` 已守住这条）
- 大卡组性能约定（v0.4.17；v0.5.6 补齐带优先池一侧）：渲染前**只算一次 `deckLevels` 并复用**（`levelStates(deck, levels)`）；统计一律**单遍遍历**；抽题在「词数 ≥ 题数」时一律走 **O(词数 + 题数) 的部分洗牌快路径**——**无优先池** = 部分 Fisher-Yates；**有优先池** = 非优先槽位「交换删除」取未用过的词（优先槽位取走的词从候选池 O(1) 摘除），优先槽位仍从 `prio` 取「用量最少」；两条路径都与逐次「最少用量」**分布等价**（关键前提：`words >= n` 时 `minGap = 1` 且「未用过的词总还存在」→ 非优先槽位等价于「在所有未用过的词里均匀抽」）。**回归守卫用 Proxy 计数卡组元素读取次数**（与机器速度无关），而不是只看耗时
- 优先池配额语义（v0.5.6 明确）：`prioCap = min(floor(n/2), n)`，**不按优先池大小收敛**——池比配额小时优先槽位会重复取错题卡（这是「错题约占 50% 配额」的既有语义，快路径刻意保持一致）；因此「词数 ≥ 题数不重复」只对**非优先槽位**成立
- `.xlsx` 公式策略（v0.5.7）：**Excel 缓存优先**——只有缓存缺失或显式 `formulaMode:`evaluate`` 才自行求值；循环引用 / 不支持函数 / 跨表引用**一律回退缓存值而不是猜**；共享公式的从属格（只有 `si` 无表达式）永不求值；`^` 用 Excel 语义**左结合**（`2^3^2 = 64`）且 `-2^2 = 4`；合并单元格默认 `fill`（左上角值填充、区域超出自动补齐且不覆盖已有数据），可切 `blank`
- 模版（v0.5.2 / v0.5.4）：CSV 表头用**中文规范列名**（全部命中 `FIELD_ALIASES` → 导入自动对号），**示例行可选**（仅表头 / 1 行 / 多行——多行示例专门覆盖一词多义、无例句、格子里有逗号需引号；因 CSV/JSON 无法写注释，故在**下载 toast / 按钮 title / 弹窗说明**三处提示「导入前请删除示例行」）；JSON 模版 `{name, description, tags, words:[…]}` 含 1 完整 + 1 最简示例，下载即可直接回灌导入
- 表格编辑页（v0.5.3 / v0.5.5）：**列以模版为准**（`TABLE_COLUMNS = CSV_TEMPLATE_COLUMNS`，一处改列三处生效：模版下载 / 文件导入对号 / 表格页）；**导入只留一条落库链路**——抽出 `importWordsToDeck`，文件导入与表格录入共用（校验 / 去重 / 新建或追加 / 导入历史 / 撤销行为必然一致，`systemPatterns.md` 第 9 条）；**粘贴多行做成纯函数内核**（`gridFromPaste`/`applyPaste`）以便单测，**单格粘贴刻意不拦截**（交回浏览器默认行为）、超列**截断**而不报错（返回 `truncated` 由 UI 提示）；**写库前必须先出预览报告**（`openTableImportPreview`），报告里的「已存在」按**唯一单词数**统计（不是行数）
- 表格单元格输入**只刷新统计**（`refreshStats()`），不整页重渲染 → 保住光标与输入法候选框；对比 `te-add-row` 等结构性操作才 `rerender()`
- v0.5.9「同一个词」= `wordbook.normKey(front)`（**只做 `trim` + 小写**，不做空格/连字符归一 → `ice cream` ≠ `icecream`，「保留哪张」的兜底 id 比较保证结果可复现）
- v0.5.9 合并语义（不可破坏）：**保留卡片的原 `back` 永远是第一义**，副卡释义按顺序进 `extraBacks`（自动去重、不做翻译/润色）、标签取并集，**复习进度与 revlog 一律不动**，被删副卡的 revlog 由 `store` 级联清理；测试里造「重复卡」必须用 `store.addCard`（`addWords` 遇重复默认**跳过**，造不出重复卡）
- v0.5.9 整理页状态分家：**筛选 / 排序 / 选中放内存**（切页、重渲染都不丢，卡片被删/合并后 `limitSelection` 自动收敛），**只有页码进 URL**（`#/words?page=N`，浏览器前进后退可用）——与「关卡分页 / 卡片管理分页」同一套约定
- v0.5.9 页面级测试可直调导出函数（`openDedupeReport`/`mergeDuplicates`/`applyTagEdit`/`deleteCardsByIds`/`lookupSelected`/`renderWordbook`），不必模拟点击；搜索重渲染后靠 `restoreSearchFocus(caret)` 还原焦点与光标（`type=search` 的 `setSelectionRange` 允许抛错并忽略）
- 考试词库**不入库**（用户确认），本地保留仅供测试

## 下一步候选（未排期，需用户确认）
- [x] ~~`.xlsx` 增强：多工作表选择、公式求值、合并单元格~~ → **v0.5.7 已交付**（`workbookSheets` 多表切换 / 公式求值 / 合并单元格填充）
- [x] ~~复习进度进一步保真：apkg 的 learning 步进 / `revlog` 逐次历史~~ → **v0.5.8 已交付**（`js/revlog.js` + IDB v3 `revlog` store；apkg 写 `revlog` 表、学习卡按 epoch 秒 / 剩余秒 / `left` 写、`cards.lapses` 由日志推导；JSON `formatVersion: 2` + 每卡 `reviewLog` 可回导还原）
- [x] ~~「我的生词」与在线查词的批量管理（去重合并、按标签整理）~~ → **v0.5.9 已交付**（`#/words` 整理页：去重合并报告 + 保留优先级 / 标签重命名·删除 / 关键词·标签·来源筛选 + 三种排序 / 每页 100 分页 / 多选批量加·去标签·在线补查·删除；首页查词框新增「重复词自动合并」偏好）
- [ ] 可访问性：键盘焦点环、`aria-*` 补全、`prefers-reduced-motion`
- [x] ~~模版增强：JSON 模版下载 / CSV 模版可选多行示例~~ → **v0.5.4 已交付**（`CSV_TEMPLATE_VARIANTS` = 仅表头 / 1 行 / 多行示例 + JSON 模版）
- [x] ~~表格编辑增强：粘贴多行文本 / 单元格长文本体验 / 导入前预览报告~~ → **v0.5.5 已交付**（`gridFromPaste`+`applyPaste` / `<textarea>` 自适应高度 / `openTableImportPreview`）
- [x] ~~带优先池的抽题：词数 ≥ 题数时非优先槽位也走部分洗牌快路径~~ → **v0.5.6 已交付**（快路径 B；`test-perf` 用 Proxy 读取次数守住）

## 待决问题
- `memory-bank/` 已随仓库纳入版本控制（每次功能收尾时同步更新本目录）
- （已解决）非文字前景（`.q-blank` 底边 / 焦点环 / 输入边框 / 原生 `accent-color`）已于 v0.4.19 统一改走 `--accent-tx`
