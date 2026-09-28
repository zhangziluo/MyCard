# Progress — 完成度与遗留

> 更新时间：2026-09-28 ｜ APP `v0.5.6` / SW `v1.8.6` ｜ **2093 条校验全绿**

## 已交付（按版本）

**v0.2 / v0.3（早期）**
- 卡片模型、翻转记忆（键盘/鼠标/触摸三端一致）、艾宾浩斯调度（10 分钟 → 60 天）
- 关卡系统（每关 15–30、顺序解锁、≥80% 通关）、卡组管理（增删改/暂停/标签筛选）
- 干扰项生成（自身多义 → 同易混组 → 随机兜底）、三种基础题型随机混合

**v0.4（存储与编排大版本）**
- IndexedDB 迁移（`mycard` v2：decks/cards/meta/lookup）+ 旧库自动迁移
- 难度判定 `difficulty.js`（词频/词长/音节/熟悉度/语种特性）、关卡编排 `arrange.js`（平缓进阶/错峰/动态调序）
- 关卡分页（>15 关，每页 15 关，URL `?page=2`）
- 整卡组翻转循环（困难词前置）、整卡组可配置测试（20~150 题、错题优先池、续做）

**v0.4.1 ~ v0.4.5**
- 主题色自定义（8 预设 + 自定义，CSS 变量全局跟随）
- 五种基础题型齐备：`word2def` / `def2word` / `sentence2word` / `fill`（含容错/提示/🔊）/ `listen`（TTS）
- 可选题型 `eng_eng`（GCIDE 英英，子模式 A/B）、`multi_sense`（多义多选，全对才算对）

**v0.4.8（本轮最大）**
- 首页统一「添加单词/词表」面板：单词语 / 词表（≤1000） / 大段文本分词 → 在线查词（Free Dictionary / Jisho，100ms 限速 + 重试 + `lookup` 缓存）→ 写入「我的生词」（首义 `back`、其余义 `extraBacks`）
- 本地文件导入 `import-file.js`：CSV/TSV/JSON 解析（零依赖，引号/BOM/分隔符嗅探/中英文表头）→ **前 10 行预览弹窗** → **逐列字段映射** → **目标牌组（已有/新建）** → 去重追加 → 成功提示 + 「去学习」
- 移除 10 本内置考试词库（清单/预缓存/首页区块/启动导入），README 全量同步

**v0.4.9** 启动清理旧版遗留内置词库（`purgeRemovedBuiltins`，幂等，仅按 source 命中）

**v0.4.10** 明暗模式三档（浅色/深色/跟随系统）+ 顶栏快捷切换 + 防闪屏 + 全站 CSS 变量化

**v0.4.11** 导出：标准 txt（TSV，带 BOM）与 Anki `.apkg`（sql.js 生成 collection.anki2 + 最小 ZIP 写出器；测试用 Python `zipfile`+`sqlite3` 独立校验）

**v0.4.12** 修复浅色模式弹窗仍为深色（`.modal` 渐变变量化）＋同类暗底文字变量化

**v0.4.13** 导出格式扩展：新增 **CSV（带表头，RFC 4180 转义）** 与 **Markdown（表格）**；`.apkg` 补新版 Anki（≥2.1.50）要求的 **`meta`（`PackageMetadata` protobuf，`version = LEGACY_1`，2 字节 `08 01`）**，老版 Anki 忽略该条目仍读 `collection.anki2`；卡组菜单扩至 4 个导出入口（v0.4.16 起为 **5 个**，含 JSON 完整导出）

**v0.4.14** 主题对比度：`--tag-tx`（标签 / 强调文字）改为**随 accent 派生**——`theme.js` 输出 `--tag-tx-dark`/`--tag-tx-light`，CSS 按 `data-theme` 二选一；修掉「浅色系 accent（青碧/翠绿）下标签文字仍是蓝色」的不一致

**v0.4.15** 对比度求解 + `--accent-tx` 统一：
- 派生算法由**固定混色**改为 **WCAG 相对亮度二分**（`relativeLuminance`/`contrastRatio`/`ensureTextContrast`，保持色相与饱和度、只调 HSL 亮度），**任意自定义色**（亮黄 / 极浅 / 近黑 / 灰）在两种底色下都严格 ≥ 4.5:1；移除 `mixHex`
- **深色底统一「提亮一档」**：`textOnDark` 先用 `lightenHex` 把 HSL 亮度 +`TEXT_LIGHTEN_STEP(0.12)`（只会变亮、不会超过白），再走对比度求解 → 深色底不再直接用原始主色（观感更亮更接近原主色系）
- 新增 `--accent-tx`（`var(--tag-tx)` 别名）统一「accent 作文字色」的入口，迁移 9 处 `color: var(--accent)`（`.pill-live`/`.empty-icon`/`.q-blank`/`.fill-hint b`/`.multi-badge`/`.opt-mark-pick`/`.dropzone-icon`/`.import-ok b`/`.seg-btn.is-active`）；当时边框 / `accent-color` 仍用原始 accent（**v0.4.19 起已一并改为 `--accent-tx`**）

**v0.4.16** 导出/导入携带**复习进度**（范围 = apkg + JSON）：
- `.apkg`：新增 `cardToAnkiSched`，`cards` 表按进度写调度（`state→type/queue`、`interval→ivl`、`easeFactor→factor`、`repetitions→reps`、`due→今天+相对天数`），Anki 导入后可直接续学；`revlog` 仍空（无逐次历史可迁移）
- 新增 **JSON 完整导出** `deckToJson` / `exportDeckJson`（卡组菜单第 5 个入口）：含内容 + 进度 + 卡组元信息，结构与导入侧兼容，**可无损往返**
- 导入侧新增 `store.pickScheduling`（统一校验/钳制进度：state 白名单、easeFactor 1.3–3.0、数值钳制）与 `import-file.pickSchedFields`（透传 + 兼容 `reps/ivl/ef/last_review` 简写）；`seedBuiltinDeck` / `addManyCards` 保留进度，并支持 `extraBacks`/`groups` 随 JSON 往返
- txt/CSV/Markdown 仍为纯「词表」（不含调度）

**v0.4.17** 大卡组性能（万级，实测 = 生成 `scripts/test-perf.mjs` 金丝雀）：
- `levels.js`：`deckStats` 改**单遍遍历**；`levelStates(deck, levels = deckLevels(deck))` 支持**复用**已算好的分组
- `decks.js`：首页/详情渲染复用同一份 `levels`（`levelStates` 不再重复整卡组遍历）；`hw.hardCount` 由 hero 里 2 次读 localStorage 改为 1 次
- `test-engine.js`：`pickLeastUsed` 由「filter → min → filter」三段合并为**单趟扫描**；**新增 O(n) 快路径**——「词数 ≥ 题数 且无优先池」时用部分 Fisher-Yates 取 n 个不同词（分布等价），**万级 150 题由 ~400ms 降到 ~10ms**；`byId` 懒建
- 实测（1 万词 / 500 关）：`deckStats` ~6ms、`deckLevels` ~3ms、`levelStates` 复用后 ~0.5ms、`samplePlan(150)` **~10ms**（带优先池 ~110ms）

**v0.4.18** 卡片管理分页（万级 DOM 规模）：
- `decks.js` 新增 `CARDS_PER_PAGE = 100` 与 `cardsPagerHtml`；`renderCards` 只渲染当前页（URL `#/deck/{id}/cards?page=2`），越界页号夹取；新增 `cards-page` 动作
- 万级卡组「卡片管理」不再一次性写入上万 DOM 节点（此前是真正的卡顿源）
- 顺带（仓库瘦身）：删除 `backup-before-rewrite` 分支 + **Cline 检查点 refs**（`refs/cline/checkpoints/*` 共 29 条，是重写前 4 个 gcide 大文件的真正持有者）→ `git reflog expire --expire=now --all` + `git gc --prune=now` 后 **`.git` 49M → 2.4M**（`git fsck --strict` 干净）

**v0.4.19** 非文字前景也跟随主色：
- `css/style.css` 把 8 处非文字 `var(--accent)` 改为 `var(--accent-tx)`——焦点环（`*:focus-visible` 的 `outline`）、输入/填空/查词聚焦边框（`border-color`）、`.q-blank` 下划线（`border-bottom`）、拖拽高亮边框（`.dropzone.is-drag`）、原生 `accent-color`（`.test-range` / `.weight-toggle input`）
- 因此浅色系主色（青碧/翠绿）下这些元素也足够醒目，与文字/图标口径一致（零 JS 改动，复用现成派生色）
- 仍保留原始 `--accent` 的：按钮渐变填充、`.opt-picked .opt-key`（主色底 + 白字）、`.about-list li::before` 装饰圆点

**v0.5.0** 导入增强（Excel / 多文件批量 / 历史回滚）：
- **`.xlsx`**：新增 `js/xlsx.js`（**零依赖**：自写 ZIP 读取 `unzip`（STORED + DEFLATE 经 `DecompressionStream('deflate-raw')`）+ 最小 XML 扫描 `parseXlsxRows`/`parseSheet`；共享/内联字符串、数值/布尔/日期、跳列补空；workbook+rels 定位首个 sheet，回退 sheet1.xml）；`import-file.js` 走二进制读取 + 「预览表格 + 同套字段映射」；ACCEPT/isSupportedFile 加 `.xlsx`
- **多文件批量**：选择器 `multiple`、拖拽区收多文件 → 「每个文件各建一个卡组」（自动映射），完成弹批量汇总；新增 `openBatchImport`/`runBatchImport`/`batchSuccessHtml`
- **导入历史 / 回滚**：新增 `js/import-history.js`——`recordImport` 记摘要（localStorage，最近 20 条），追加导入的 `cardIds` 存 **IndexedDB `meta`**（`import-rollback:{id}`，最近 5 次）；`undoImport` 撤销（new → `deleteDeck`；append → `store.deleteCards` 只删本次新增）；首页「导入历史」入口 + 「导入完成 / 批量完成」弹窗内直接「撤销」
- 配套：`store.deleteCards(deckId, ids)`；`commitWords` 返回 `mode`/`addedCardIds`/`fileName`

**v0.5.1** 关卡测试固定五种基础题型（不含英英 / 多义）：
- 根因：关卡测试题型来自 `typesForRetry()` → `enabledTypes()`（基础 5 + 配置里开启的可选题型），
  故在「整卡组测试」里勾选 `eng_eng`/`multi_sense` 后，关卡测试也会混入这两种题型
- 修复：`js/test.js` 的 `typesForRetry()` 改用 `cfg.QUESTION_TYPES`（**基础 5 种**）；重刷加权逻辑不变
- 整卡组可配置测试**不受影响**（仍走 `test-engine.samplePlan` 的 `enabled` 配置）

**v0.5.2** 标准 CSV 模版下载（导入栏）：
- `js/import-file.js` 新增 `CSV_TEMPLATE_COLUMNS`（中文规范列名 `单词,释义,例句,例句翻译,音标,标签`，均在 `FIELD_ALIASES` 内可自动对号）、
  `CSV_TEMPLATE_EXAMPLE`（1 行示例：演示音标写法 + 「标签用逗号分隔」需引号）、`csvTemplateText()`（UTF-8 BOM + CRLF）、
  `downloadCsvTemplate()`（本地 Blob 下载，非浏览器环境安全返回 null）、`csvTemplateButtonHtml()` + `on('download-csv-template')`
- `js/decks.js`：首页拖拽区下方渲染「没有模版？下载 CSV 模版（…含 1 行示例，导入前请删除）」
- 决策：**带 1 行示例**（用户要求），并在 UI/README 明确提示「导入前请删除示例行」

**v0.5.3** 表格编辑页 `#/editor`（导入流程的「网页内录入」入口）：
- 新增 `js/table-editor.js`：**列以模版为准**——`TABLE_COLUMNS = CSV_TEMPLATE_COLUMNS`（`单词/释义/例句/例句翻译/音标/标签`，不再重复维护列名），`TABLE_FIELDS` 按序映射到 `front/back/example/exampleZh/phonetic/tags`
- **纯函数内核**（可单测、不碰 DOM/存储）：`normalizeTable`/`cleanRows`/`tableToWords`/`wordsToTable`/`tableStats`/`setCell`/`addRow`/`removeRow`/`moveRow`/`alignToTemplate`/`tableCsvRows`/`tableCsvText`；`alignToTemplate` 支持**无表头按位置**与**有表头按别名（任意顺序）**两种对齐
- **薄 UI**：`tableEditorHtml` + `renderTableEditor`（路由 `#/editor`）；模块级状态 `rows/target/deckName` 跨重渲染保留；单元格输入走 `input` 事件 + `refreshStats()` **只刷新统计与重复行高亮**（不整页重建 → 光标不丢）；行为动作 `te-cell`/`te-target`/`te-deck-name`/`te-add-row`/`te-move-up`/`te-move-down`/`te-del-row`/`te-clear`/`te-download`/`te-load-file`/`te-import-deck`
- **草稿**：`mycard-table-draft`（localStorage，防抖写入，最多 5000 行 `MAX_TABLE_ROWS`）；重新进入 / 刷新自动恢复；「清空」与「从文件载入」前 `confirmDialog` 确认
- **从文件载入**：复用 `parseByFilename`/`parseCsv`/`parseXlsxRows`（CSV / TSV / XLSX / JSON，含内容嗅探），自动识别表头并 `alignToTemplate` 对号
- **下载 CSV**：`downloadCsvRows`（从 import-file 抽出的通用下载器，`csvText` 亦抽为内部复用），文件名 `Mycard-表格.csv`，表头即模版列名 → **可直接用首页导入回灌**
- **导入为卡组**：新增 `importWordsToDeck(words, { mode, deckName, deckId, fileName })`（`js/import-file.js`）——复用同一套 `validatePayload` → `seedBuiltinDeck`（新建）/ `addManyCards`（追加）→ `recordImport` → `importSuccessHtml`，因此**导入历史 / 撤销 / 去重语义与文件导入完全一致**；卡片 `src: 'table_editor'`
- 入口与路由：`decks.js` 导入栏新增「在网页里填表格」（`tableEditorLinkHtml` + `open-table-editor`），`app.js` 解析 `#/editor` 并设顶栏标题「表格编辑」；`css/style.css` 新增 `.te-*`（全部走既有 CSS 变量）；`sw.js` 预缓存 + `APP_VERSION`/`SW VERSION` 递增
- 顺带修复：新建卡组导入结果的**重复条数**不再恒为 0（`duplicates: payload.duplicates || duplicates || 0`）

**v0.5.4** 模版增强（导入栏）：JSON 模版 + CSV 模版示例行可选
- `js/import-file.js`：新增 **JSON 模版**——`jsonTemplate()`（`{name, description, tags, words:[…]}`，words 含 1 条完整示例 + 1 条只填 `front`/`back` 的最简示例）、`jsonTemplateText()`（2 空格缩进 + 末尾换行）、`downloadJsonTemplate()`（复用 `downloadTextFile`，`text/json`）、`jsonTemplateButtonHtml()` + `on('download-json-template')`
- **CSV 模版变体**：`CSV_TEMPLATE_VARIANTS`（`head` 仅表头 / `single` 1 行示例 / `multi` 多行示例）与 `CSV_TEMPLATE_EXAMPLES`（覆盖「一词多义」「无例句」「格子里有逗号需引号」）；`csvTemplateExampleRows(variant)` / `csvTemplateRows({variant})` / `csvTemplateText({variant})` / `downloadCsvTemplate({variant})` 全部参数化，**默认仍是 1 行示例**（不破坏既有行为）
- **下载前先选**：`csvTemplateDialogHtml()` + `openCsvTemplateDialog()`（`ui.openModal` + `readForm` 读下拉），按钮文案/title/toast 都按变体给出「含 N 行示例，导入前请删除」提示
- `js/decks.js` 导入栏提示同步为「CSV（示例行可选）＋ JSON（name / tags / words）」；`css/style.css` 新增 `.tpl-notes` 说明列表
- 决策：**JSON 示例行不删也能导入吗？**——JSON 模版必须自带示例（否则用户看不出结构），故模版文案明确提示「示例条会被一起导入」，导入前请删

**v0.5.5** 表格编辑页增强（粘贴多行 / 长文本单元格 / 导入前预览报告）
- **粘贴多行**（纯函数内核，可单测）：`gridFromPaste(text)`（Tab = 列分隔、换行 = 行分隔、`\r\n` 归一化；**只有单个单元格时返回 `[]`** → 交给浏览器默认粘贴）+ `applyPaste(rows, startRow, startCol, grid)`（从落点铺开，行数不足自动补行至 `MAX_TABLE_ROWS = 5000`，列数超出 6 列模版**截断**，返回 `{ rows, last, added, truncated }`，非法落点/空网格返回 `null`）
- **绑定一次**：`bindPasteOnce()`（`document.addEventListener('paste', …, true)`）在 `renderTableEditor` 里惰性绑定；命中表格单元格才 `preventDefault`，单格粘贴不拦截 → 不破坏原有体验
- **单元格改 `<textarea rows="1">`**：`autoGrow` / `autoGrowAll` 随内容长高（封顶 `TE_CELL_MAX_H = 200`，超出内部滚动），保留「输入只 `refreshStats()` 不整页重渲染」的光标策略
- **导入前预览 / 校验报告**：`importPreviewRows(rows)`（去重 + 只留合法行）、`importReport(rows, deck)`（可导入条数 / 缺单词 / 表内重复去重 / 目标卡组已存在的**唯一单词数**）、`importPreviewHtml(rows, deck)`（复用 `import-file.previewTableHtml` 显示前 `PREVIEW_ROWS` 行）、`openTableImportPreview()`——`te-import-deck` 先弹宽版预览，**确认后才**调 `importTableToDeck`
- 测试：`scripts/test-table-editor.mjs` 新增粘贴内核 / 扩行截断 / 预览报告 / 事件链路断言；`smoke-dom.mjs` 断言 18 个 `textarea.te-cell` + 文档级 paste 绑定；`verify-assets.mjs` 断言内核 / 绑定 / 预览报告 / CSS

**v0.5.6** 抽题快路径补全（带优先池且词数 ≥ 题数，`js/test-engine.js`）
- 旧状：只有「词数 ≥ 题数且**无**优先池」才走 O(n) 部分洗牌；**带优先池**时即使词多题少也退回 O(题数×词数) 全量扫描（万级 1 万词 / 150 题实测 ~47ms，v0.4.17 起记录的已知技术债）
- 新增**快路径 B**（`prio.length && words >= n`）：非优先槽位用**「交换删除」的部分洗牌**——候选池 `pool[0, cursor)` 恒为「尚未被取用的词」，取词 = `pool[random*cursor]` 后与末尾交换、`cursor--`（O(1)）；**优先槽位仍走错题池的 `pickLeastUsed`**，被优先槽位取走的词用 `posOf`（卡下标 → 池中位置）**O(1) 摘除**；`pickLeastUsed` 与 `lastUse`/`used`/`seq` 提升为两条快路径与慢路径**共享**（语义完全一致）
- **分布等价性**（关键）：`words >= n` 时 `minGap` 恒为 1 且「未用过的词总还存在」，故慢路径的非优先槽位等价于「在所有未用过的词里均匀抽」——新快路径用交换删除的部分洗牌给出同一分布；用 4 组配置 × 各 2 万次采样的对比脚本验证：错题命中率/平均不同词数相对偏差 **< 0.1%**，且「非优先槽位取到的词永不重复」不变量 0 反例
- 复杂度：O(词数 + 题数)（万级 1 万词 / 150 题 + 40 题优先池实测 **~4ms**）
- 测试：`test-perf.mjs` 新增「带优先池且词数 ≥ 题数」段落——用 **Proxy 计数卡组元素读取次数**（快路径 ~3 万次 vs 慢路径 ~75 万次，断言 < 10 万），这是与机器速度无关的回归守卫；`test-deck-test.mjs` 新增「优先池快路径」不变量（优先槽位全部命中 / 错题命中 ≤ 优先槽位 + 池内词数 / **只有错题可能重复** / 同随机源可复现 / 词数 = 题数仍取满）
- 注意（语义澄清，非 bug）：`prioCap = min(floor(n/2), n)` **不按优先池大小收敛**——池比配额小时优先槽位会重复取错题（这是「错题占 50% 配额」的既有语义），新快路径**保持**该行为

## 测试资产（23 个 test-*.mjs + `smoke-dom` + `verify-assets` = 25 个脚本 / 2093 条断言）
| 分类 | 脚本 |
| --- | --- |
| 核心纯函数 | `test-core`(43) `test-difficulty`(39) `test-arrange`(22) `test-pagination`(25) `test-resplit-levels`(26) |
| 学习与题型 | `test-confusables`(82) `test-hardwords`(26) `test-level-retry`(78) `test-fill`(85) `test-listen`(21) `test-deck-test`(92) `test-eng-eng`(34) `test-multi-sense`(39) `test-review-complete`(11) `test-review-interaction`(12) |
| 存储与主题 | `test-idb-store`(42) `test-theme`(150) |
| 新功能 | `test-add-words`(82) `test-import-file`(299) `test-table-editor`(219) `test-export`(133) `test-xlsx`(33) |
| DOM / 资源 | `smoke-dom`(170) `verify-assets`(301) |
| 性能金丝雀 | `test-perf`(29，1 万词 / 500 关：统计/分组/抽题（含优先池读取次数）+ 耗时) |

## 已知问题 / 技术债
- （v0.5.6 已清偿）~~**带优先池的抽题**：优先池非空时仍走 O(题数×词数) 全量扫描~~ → 已实现快路径 B（词数 ≥ 题数时非优先槽位也走部分洗牌，O(词数 + 题数)），见 v0.5.6
- **注意**：`refs/cline/checkpoints/*` 已被清理（v0.4.18）；Cline 扩展在后续会话中可能**重建**同类检查点并再次持有大对象——若 `.git` 再度膨胀，用同样方式（`for-each-ref refs/cline` → `update-ref -d` → `gc --prune=now`）回收即可

## 刻意决定 / 已知限制（非技术债）
- **apkg 复习进度为「近似迁移」**：`due` 用「今天 + 相对天数」（Anki review 本就是日粒度），learning 的分钟级步进不映射、`revlog` 为空——因 Mycard 不存逐次复习历史 / 无 learning 步进子模型，**明确不做**（需先改存储模型）
- **`--soft-danger-tx` 刻意固定**：它是「危险/错误」语义色，**不应**跟随 accent（浅色 `#c6283b` / 深色 `#ff9ba6`）
- **原始 `--accent` 仅用于「填充/品牌底」**：按钮渐变、`.opt-picked .opt-key`（主色底 + 白字）、`.about-list li::before` 装饰圆点；**前景类**（文字 / 图标 / 焦点环 / 边框 / 原生 `accent-color`）一律走 `--accent-tx`（v0.4.19 起）

## 明确的非目标（不做）
云同步/账号、社交排行、服务端、构建工具、TypeScript、前端框架、ORM（Dexie）
