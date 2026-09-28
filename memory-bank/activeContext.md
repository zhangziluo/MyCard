# Active Context — 当前焦点

> 更新时间：2026-09-28 ｜ APP `v0.5.6` / SW `v1.8.6` ｜ v0.4.13 ~ v0.5.6 已交付，**2093 条校验全绿**

## 当前状态
**v0.4.13（导出扩展）→ v0.5.6（抽题快路径补全）连续多轮功能均已实现、校验全绿**。**没有进行中的功能**。

## 最近完成（倒序）
1. **v0.5.6 抽题快路径补全**：`test-engine.js` 新增**快路径 B**——「带优先池且词数 ≥ 题数」时非优先槽位用**「交换删除」的部分洗牌** O(1) 取「尚未用过的词」（优先槽位取走的词用 `posOf` O(1) 摘除），优先槽位仍走错题池 `pickLeastUsed`；`pickLeastUsed`/`lastUse`/`used`/`seq` 提升为共享状态。复杂度 O(词数 + 题数)，**1 万词 / 150 题 + 40 题优先池 ~47ms → ~4ms**；4 组配置 × 2 万次采样验证与逐次「最少用量」分布相对偏差 < 0.1%。测试：`test-perf` 用 **Proxy 计数卡组读取次数**（~3 万 vs 慢路径 ~75 万，断言 < 10 万）+ `test-deck-test` 新增不变量段
2. **v0.5.5 表格编辑页增强**：`table-editor.js` 新增**粘贴多行**（`gridFromPaste`/`applyPaste`：Tab/换行解析、自动补行至 5000、超 6 列截断、**单格不拦截**；`bindPasteOnce()` 文档级绑定且只绑一次）、**单元格改 `<textarea rows=1>` 自适应高度**（封顶 200px）、**导入前预览 / 校验报告**（`importPreviewRows`/`importReport`/`importPreviewHtml`/`openTableImportPreview`，`te-import-deck` 确认后才写库）
3. **v0.5.4 模版增强**：新增 **JSON 模版**（`jsonTemplate`/`jsonTemplateText`/`downloadJsonTemplate`/`jsonTemplateButtonHtml`，含 1 完整 + 1 最简示例）；**CSV 模版示例行可选**（`CSV_TEMPLATE_VARIANTS` = 仅表头 / 1 行 / 多行示例，`openCsvTemplateDialog()` 下载前先选，默认仍 1 行）
4. **v0.5.3 表格编辑页 `#/editor`（导入流程的「网页内录入」入口）**：新增 `js/table-editor.js`（列 = `CSV_TEMPLATE_COLUMNS` 同源；纯函数内核 `normalizeTable`/`cleanRows`/`tableToWords`/`wordsToTable`/`tableStats`/`setCell`/`addRow`/`removeRow`/`moveRow`/`alignToTemplate`/`tableCsvRows`/`tableCsvText`；UI = 表格 ＋ 统计条 ＋ 工具栏）；支持逐格录入、**从文件载入**（CSV/TSV/XLSX/JSON）、**下载 CSV**、**草稿**（`mycard-table-draft`）、**导入为卡组**（新建 / 追加）。导入复用新抽出的 `import-file.importWordsToDeck` → `validatePayload` → `seedBuiltinDeck`/`addManyCards` → `recordImport` → `importSuccessHtml`，**导入历史 / 撤销 / 去重与文件导入完全一致**；首页导入栏新增「在网页里填表格」入口
5. **v0.5.2 标准 CSV 模版**：导入栏（拖拽区下方）新增「下载 CSV 模版」——`csvTemplateText()`（UTF-8 BOM + 中文规范列名 `单词/释义/例句/例句翻译/音标/标签`（可自动对号）+ **1 行示例**）、`downloadCsvTemplate()`、`csvTemplateButtonHtml()`；UI/README 均提示「导入前请删除示例行」
6. **v0.5.1 关卡测试题型收敛**：`js/test.js` 的 `typesForRetry()` 改用 `cfg.QUESTION_TYPES`（基础 5 种），**关卡测试不再混入 `eng_eng`/`multi_sense`**；整卡组可配置测试不受影响（仍按配置启用可选题型）
7. **v0.5.0 导入增强**：新增 **`.xlsx`**（`js/xlsx.js` 零依赖：自写 ZIP 读取 + 最小 XML 扫描 → 同一套预览/字段映射）、**多文件批量**（选择器/拖拽多选 → 每文件各建一卡组 + 批量汇总）、**导入历史 / 回滚**（`js/import-history.js`：撤销 = 删新建卡组 / 只移除追加的新增卡片，cardIds 存 IDB）
8. **v0.4.19 非文字前景随主色**：CSS 8 处非文字 `var(--accent)` → `var(--accent-tx)`（焦点环 / 输入与高亮边框 / `.q-blank` 下划线 / 原生 `accent-color`），浅色系主色下同样醒目
9. **v0.4.18 卡片管理分页**：`CARDS_PER_PAGE = 100` + `cards-page`，万级卡组不再一次性塞入上万 DOM 节点；并做仓库瘦身（删 `backup-before-rewrite` 与 Cline 检查点 refs + gc → `.git` 49M → 2.4M）
10. **v0.4.17 大卡组性能**：`deckStats` 单遍遍历、`levelStates(deck, levels)` 复用分组、抽题 O(n) 快路径（万级 150 题 ~400ms → ~10ms）；新增 `test-perf.mjs`
11. **v0.4.16 复习进度迁移**：`.apkg` `cards` 表按进度写调度（`cardToAnkiSched`）+ **JSON 完整导出/导入**（无损往返，含多释义/分组）
12. **v0.4.15 对比度求解 + `--accent-tx`**：WCAG 相对亮度二分（任意自定义色两底色都 ≥4.5:1）+ 深色底提亮一档
13. **v0.4.14 主题对比度**：`--tag-tx` 随 accent 派生（深/浅二档）
14. **v0.4.13 导出扩展**：新增 CSV（RFC 4180）与 Markdown 导出 + `.apkg` 补 `meta` protobuf
（更早版本见 `progress.md`）

## 关键决策（近期）
- 需求若来自其它栈（Vue/React/TS/Dexie/PapaParse），先确认再**适配到纯 JS 栈**（已发生 3 次）
- 词库与词条的落库策略：新牌组走 `seedBuiltinDeck`（难度分层+错峰编排）；追加到已有牌组走 `addManyCards`（重拆关卡）；均按单词去重
- 「我的生词」用 `deck.source==='custom'` 识别，不再用 `level:'custom'`
- 导出 apkg 采用**内置 sql.js**（用户明确选择，接受打破「零依赖」）而非手写 SQLite
- `.apkg` 的 `meta` 取 **`LEGACY_1(1)` + 保留 `collection.anki2`**（而非 Anki 自身 legacy 导出的 `LEGACY_2(2)` + `collection.anki21`）：两者新版 Anki 都认，但 LEGACY_1 与 schema v11 自洽且**不破坏 <2.1.50 老版 Anki**；protobuf 仅 `field1=varint`，故自写 2 字节编码 `08 01`，不引 protobuf 库
- 主题「强调文字色」由 JS 按 accent 派生（`--tag-tx-dark`/`--tag-tx-light`）写 `<html>`，CSS 按 `data-theme` 二选一 → 切色/切模式解耦（`applyMode` 不必知道 accent）；算法 = **保持色相 / 饱和度 + 用 WCAG 相对亮度对 HSL 亮度二分**（目标 4.5:1，任意自定义色均成立，v0.4.15 起替换固定混色）；`--accent-tx` 是 `--tag-tx` 的别名，统一所有「accent 作文字色」的入口；`--soft-danger-tx` 属危险语义色**刻意不跟随** accent
- 复习进度迁移走两条路：**`.apkg`（→Anki，日粒度近似 due）** 与 **JSON（↔Mycard，无损往返）**；txt/CSV/Markdown 刻意保持纯「词表」。导入侧进度校验统一走 `store.pickScheduling`（state 白名单 / easeFactor 1.3–3.0 / 数值钳制），非法值回退新卡
- 大卡组性能约定（v0.4.17；v0.5.6 补齐带优先池一侧）：渲染前**只算一次 `deckLevels` 并复用**（`levelStates(deck, levels)`）；统计一律**单遍遍历**；抽题在「词数 ≥ 题数」时一律走 **O(词数 + 题数) 的部分洗牌快路径**——**无优先池** = 部分 Fisher-Yates；**有优先池** = 非优先槽位「交换删除」取未用过的词（优先槽位取走的词从候选池 O(1) 摘除），优先槽位仍从 `prio` 取「用量最少」；两条路径都与逐次「最少用量」**分布等价**（关键前提：`words >= n` 时 `minGap = 1` 且「未用过的词总还存在」→ 非优先槽位等价于「在所有未用过的词里均匀抽」）。**回归守卫用 Proxy 计数卡组元素读取次数**（与机器速度无关），而不是只看耗时
- 优先池配额语义（v0.5.6 明确）：`prioCap = min(floor(n/2), n)`，**不按优先池大小收敛**——池比配额小时优先槽位会重复取错题卡（这是「错题约占 50% 配额」的既有语义，快路径刻意保持一致）；因此「词数 ≥ 题数不重复」只对**非优先槽位**成立
- 模版（v0.5.2 / v0.5.4）：CSV 表头用**中文规范列名**（全部命中 `FIELD_ALIASES` → 导入自动对号），**示例行可选**（仅表头 / 1 行 / 多行——多行示例专门覆盖一词多义、无例句、格子里有逗号需引号；因 CSV/JSON 无法写注释，故在**下载 toast / 按钮 title / 弹窗说明**三处提示「导入前请删除示例行」）；JSON 模版 `{name, description, tags, words:[…]}` 含 1 完整 + 1 最简示例，下载即可直接回灌导入
- 表格编辑页（v0.5.3 / v0.5.5）：**列以模版为准**（`TABLE_COLUMNS = CSV_TEMPLATE_COLUMNS`，一处改列三处生效：模版下载 / 文件导入对号 / 表格页）；**导入只留一条落库链路**——抽出 `importWordsToDeck`，文件导入与表格录入共用（校验 / 去重 / 新建或追加 / 导入历史 / 撤销行为必然一致，`systemPatterns.md` 第 9 条）；**粘贴多行做成纯函数内核**（`gridFromPaste`/`applyPaste`）以便单测，**单格粘贴刻意不拦截**（交回浏览器默认行为）、超列**截断**而不报错（返回 `truncated` 由 UI 提示）；**写库前必须先出预览报告**（`openTableImportPreview`），报告里的「已存在」按**唯一单词数**统计（不是行数）
- 表格单元格输入**只刷新统计**（`refreshStats()`），不整页重渲染 → 保住光标与输入法候选框；对比 `te-add-row` 等结构性操作才 `rerender()`
- 考试词库**不入库**（用户确认），本地保留仅供测试

## 下一步候选（未排期，需用户确认）
- [ ] `.xlsx` 增强：多工作表选择、公式求值、合并单元格（当前仅取第一个 sheet）
- [ ] 复习进度进一步保真：apkg 的 learning 步进 / `revlog` 逐次历史（当前为「日粒度近似」）
- [ ] 「我的生词」与在线查词的批量管理（去重合并、按标签整理）
- [ ] 可访问性：键盘焦点环、`aria-*` 补全、`prefers-reduced-motion`
- [x] ~~模版增强：JSON 模版下载 / CSV 模版可选多行示例~~ → **v0.5.4 已交付**（`CSV_TEMPLATE_VARIANTS` = 仅表头 / 1 行 / 多行示例 + JSON 模版）
- [x] ~~表格编辑增强：粘贴多行文本 / 单元格长文本体验 / 导入前预览报告~~ → **v0.5.5 已交付**（`gridFromPaste`+`applyPaste` / `<textarea>` 自适应高度 / `openTableImportPreview`）
- [x] ~~带优先池的抽题：词数 ≥ 题数时非优先槽位也走部分洗牌快路径~~ → **v0.5.6 已交付**（快路径 B；`test-perf` 用 Proxy 读取次数守住）

## 待决问题
- `memory-bank/` 已随仓库纳入版本控制（每次功能收尾时同步更新本目录）
- （已解决）非文字前景（`.q-blank` 底边 / 焦点环 / 输入边框 / 原生 `accent-color`）已于 v0.4.19 统一改走 `--accent-tx`
