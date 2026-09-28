# Active Context — 当前焦点

> 更新时间：2026-09-28 ｜ APP `v0.5.3` / SW `v1.8.3` ｜ v0.4.13 ~ v0.5.3 已交付，**1936 条校验全绿**

## 当前状态
**v0.4.13（导出扩展）→ v0.5.3（表格编辑页 `#/editor`）连续多轮功能均已实现、校验全绿**。**没有进行中的功能**。

## 最近完成（倒序）
1. **v0.5.3 表格编辑页 `#/editor`（导入流程的「网页内录入」入口）**：新增 `js/table-editor.js`（列 = `CSV_TEMPLATE_COLUMNS` 同源；纯函数内核 `normalizeTable`/`cleanRows`/`tableToWords`/`wordsToTable`/`tableStats`/`setCell`/`addRow`/`removeRow`/`moveRow`/`alignToTemplate`/`tableCsvRows`/`tableCsvText`；UI = 表格 ＋ 统计条 ＋ 工具栏）；支持逐格录入、**从文件载入**（CSV/TSV/XLSX/JSON）、**下载 CSV**、**草稿**（`mycard-table-draft`）、**导入为卡组**（新建 / 追加）。导入复用新抽出的 `import-file.importWordsToDeck` → `validatePayload` → `seedBuiltinDeck`/`addManyCards` → `recordImport` → `importSuccessHtml`，**导入历史 / 撤销 / 去重与文件导入完全一致**；首页导入栏新增「在网页里填表格」入口
2. **v0.5.2 标准 CSV 模版**：导入栏（拖拽区下方）新增「下载 CSV 模版」——`csvTemplateText()`（UTF-8 BOM + 中文规范列名 `单词/释义/例句/例句翻译/音标/标签`（可自动对号）+ **1 行示例**）、`downloadCsvTemplate()`、`csvTemplateButtonHtml()`；UI/README 均提示「导入前请删除示例行」
3. **v0.5.1 关卡测试题型收敛**：`js/test.js` 的 `typesForRetry()` 改用 `cfg.QUESTION_TYPES`（基础 5 种），**关卡测试不再混入 `eng_eng`/`multi_sense`**；整卡组可配置测试不受影响（仍按配置启用可选题型）
4. **v0.5.0 导入增强**：新增 **`.xlsx`**（`js/xlsx.js` 零依赖：自写 ZIP 读取 + 最小 XML 扫描 → 同一套预览/字段映射）、**多文件批量**（选择器/拖拽多选 → 每文件各建一卡组 + 批量汇总）、**导入历史 / 回滚**（`js/import-history.js`：撤销 = 删新建卡组 / 只移除追加的新增卡片，cardIds 存 IDB）
5. **v0.4.19 非文字前景随主色**：CSS 8 处非文字 `var(--accent)` → `var(--accent-tx)`（焦点环 / 输入与高亮边框 / `.q-blank` 下划线 / 原生 `accent-color`），浅色系主色下同样醒目
6. **v0.4.18 卡片管理分页**：`CARDS_PER_PAGE = 100` + `cards-page`，万级卡组不再一次性塞入上万 DOM 节点；并做仓库瘦身（删 `backup-before-rewrite` 与 Cline 检查点 refs + gc → `.git` 49M → 2.4M）
7. **v0.4.17 大卡组性能**：`deckStats` 单遍遍历、`levelStates(deck, levels)` 复用分组、抽题 O(n) 快路径（万级 150 题 ~400ms → ~10ms）；新增 `test-perf.mjs`
8. **v0.4.16 复习进度迁移**：`.apkg` `cards` 表按进度写调度（`cardToAnkiSched`）+ **JSON 完整导出/导入**（无损往返，含多释义/分组）
9. **v0.4.15 对比度求解 + `--accent-tx`**：WCAG 相对亮度二分（任意自定义色两底色都 ≥4.5:1）+ 深色底提亮一档
10. **v0.4.14 主题对比度**：`--tag-tx` 随 accent 派生（深/浅二档）
11. **v0.4.13 导出扩展**：新增 CSV（RFC 4180）与 Markdown 导出 + `.apkg` 补 `meta` protobuf
（更早版本见 `progress.md`）

## 关键决策（近期）
- 需求若来自其它栈（Vue/React/TS/Dexie/PapaParse），先确认再**适配到纯 JS 栈**（已发生 3 次）
- 词库与词条的落库策略：新牌组走 `seedBuiltinDeck`（难度分层+错峰编排）；追加到已有牌组走 `addManyCards`（重拆关卡）；均按单词去重
- 「我的生词」用 `deck.source==='custom'` 识别，不再用 `level:'custom'`
- 导出 apkg 采用**内置 sql.js**（用户明确选择，接受打破「零依赖」）而非手写 SQLite
- `.apkg` 的 `meta` 取 **`LEGACY_1(1)` + 保留 `collection.anki2`**（而非 Anki 自身 legacy 导出的 `LEGACY_2(2)` + `collection.anki21`）：两者新版 Anki 都认，但 LEGACY_1 与 schema v11 自洽且**不破坏 <2.1.50 老版 Anki**；protobuf 仅 `field1=varint`，故自写 2 字节编码 `08 01`，不引 protobuf 库
- 主题「强调文字色」由 JS 按 accent 派生（`--tag-tx-dark`/`--tag-tx-light`）写 `<html>`，CSS 按 `data-theme` 二选一 → 切色/切模式解耦（`applyMode` 不必知道 accent）；算法 = **保持色相 / 饱和度 + 用 WCAG 相对亮度对 HSL 亮度二分**（目标 4.5:1，任意自定义色均成立，v0.4.15 起替换固定混色）；`--accent-tx` 是 `--tag-tx` 的别名，统一所有「accent 作文字色」的入口；`--soft-danger-tx` 属危险语义色**刻意不跟随** accent
- 复习进度迁移走两条路：**`.apkg`（→Anki，日粒度近似 due）** 与 **JSON（↔Mycard，无损往返）**；txt/CSV/Markdown 刻意保持纯「词表」。导入侧进度校验统一走 `store.pickScheduling`（state 白名单 / easeFactor 1.3–3.0 / 数值钳制），非法值回退新卡
- 大卡组性能约定（v0.4.17）：渲染前**只算一次 `deckLevels` 并复用**（`levelStates(deck, levels)`）；统计一律**单遍遍历**；抽题在「词数 ≥ 题数且无优先池」时走 **O(n) 部分洗牌快路径**（与逐次「最少用量」分布等价），避免 O(题数×词数)
- CSV 模版（v0.5.2）：表头用**中文规范列名**（全部命中 `FIELD_ALIASES` → 导入自动对号）；**含 1 行示例**（用户要求，演示音标写法与「标签用逗号分隔需引号」）——因 CSV 无法写注释，故在**下载 toast / 按钮 title / 页面文案**三处提示「导入前请删除示例行」
- 表格编辑页（v0.5.3）：**列以模版为准**（`TABLE_COLUMNS = CSV_TEMPLATE_COLUMNS`，一处改列三处生效：模版下载 / 文件导入对号 / 表格页）；**导入只留一条落库链路**——抽出 `importWordsToDeck`，文件导入与表格录入共用（校验 / 去重 / 新建或追加 / 导入历史 / 撤销行为必然一致，`systemPatterns.md` 第 9 条）
- 表格单元格输入**只刷新统计**（`refreshStats()`），不整页重渲染 → 保住光标与输入法候选框；对比 `te-add-row` 等结构性操作才 `rerender()`
- 考试词库**不入库**（用户确认），本地保留仅供测试

## 下一步候选（未排期，需用户确认）
- [ ] `.xlsx` 增强：多工作表选择、公式求值、合并单元格（当前仅取第一个 sheet）
- [ ] 复习进度进一步保真：apkg 的 learning 步进 / `revlog` 逐次历史（当前为「日粒度近似」）
- [ ] 「我的生词」与在线查词的批量管理（去重合并、按标签整理）
- [ ] 可访问性：键盘焦点环、`aria-*` 补全、`prefers-reduced-motion`
- [ ] 模版增强：JSON 模版下载 / CSV 模版可选多行示例（演示多义词、无例句等情形）
- [ ] 表格编辑增强候选：整行**粘贴多行文本自动多行**（当前需点「＋ 添加一行」）、单元格内长文本编辑体验（受 `<input>` 限制）、导入前**预览/校验报告**（当前统计条已给出「重复 / 缺单词」）
- [ ] 带优先池的抽题：词数 ≥ 题数时非优先槽位也走部分洗牌快路径（方案已记入 progress，当前万级 ~110ms 暂无感）

## 待决问题
- `memory-bank/` 已随仓库纳入版本控制（每次功能收尾时同步更新本目录）
- （已解决）非文字前景（`.q-blank` 底边 / 焦点环 / 输入边框 / 原生 `accent-color`）已于 v0.4.19 统一改走 `--accent-tx`
