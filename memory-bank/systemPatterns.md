# System Patterns — 架构与关键设计

## 总体结构
原生 ES Module 的单页应用，**无构建**：`index.html` 只加载 `js/app.js`，其余模块通过 import 图引入。

```
index.html ──► js/app.js（入口：路由 / 顶栏 / 设置页 / boot）
                 ├─ store.js ── idb.js（IndexedDB 封装） + localStorage 回退
                 ├─ decks.js（首页 / 卡组详情 / 卡片管理 / 导入按钮与拖拽区）
                 │     ├─ add-words.js（首页在线查词面板）
                 │     ├─ import-file.js（CSV/TSV/JSON/XLSX 导入：预览 + 字段映射 + 目标牌组 + 多文件批量）
                 │     ├─ xlsx.js（零依赖 .xlsx 读取：自写 ZIP 读取 + 最小 XML 扫描）
                 │     ├─ import-history.js（导入历史 + 回滚/撤销）
                 │     └─ export.js（导出 txt / CSV / Markdown / JSON / Anki .apkg；
                 │           内置 ZIP 写出器 + meta protobuf + sql.js +
                 │           复习进度映射 cardToAnkiSched）
                 ├─ review.js（翻转记忆）· test.js（测试）+ test-engine.js + test-config.js
                 ├─ levels.js（关卡/分页）· levelstats.js · hardwords.js
                 ├─ difficulty.js（难度判定）· arrange.js（关卡编排）· engdefs.js（GCIDE 释义）
                 ├─ theme.js（明暗模式 + 主色调）· ui.js（事件委托 / modal / toast / 导航）
                 └─ scheduler.js（艾宾浩斯调度，纯函数）
```

## 关键模式（改代码时请沿用）

1. **Action 事件委托**：HTML 用 `data-action="xxx"`，模块顶层用 `ui.on('xxx', el => …)` 注册；`data-id` 等放在 dataset。**不要**给元素直接 addEventListener（`drag*` 这类 ui.js 不支持的除外）。
2. **状态集中**：所有业务状态在 `store.js`（`getDb()` 单例）；模块只读快照 + 调用 store 的变更函数；`persist()` 写 localStorage 元数据，`queueCard/queueCards/queueDeck` 走 IndexedDB 防抖批写，`flushPending()` 在 `pagehide` 落盘。
3. **纯函数内核 + 薄 UI**：`scheduler.js` / `levels.js` / `difficulty.js` / `arrange.js` / `test-engine.js` 不碰 DOM 与存储，便于单测。
4. **弹窗**：统一用 `ui.openModal({ title, body, actions, wide })`；`actions[].onClick` 返回 `false` 保持打开、返回 `true`/`undefined` 关闭。
5. **懒加载重资源**：`engdefs.js`（2.6MB 英文释义）与 `export.js` 的 sql.js 都是首次使用时才加载；启动不阻塞。
6. **渲染即重建**：视图函数把 `root.innerHTML` 整体重写，再绑定/重算；需要保留状态的用模块级变量（如 `add-words.js` 的面板状态、`decks.js` 的标签筛选）。
7. **降级优先**：任何外部能力（IndexedDB / fetch / matchMedia / crypto.subtle / TTS / URL.createObjectURL）都必须有安全回退，保证 Node 测试与老浏览器不炸。
8. **大卡组（万级）性能**（v0.4.17/18）：渲染前**只算一次 `deckLevels` 并复用**（`levelStates(deck, levels)`）；统计一律**单遍遍历**；列表类视图**分页**（关卡 15/页、卡片管理 `CARDS_PER_PAGE = 100`），避免一次性写入上万 DOM 节点；抽题在「词数 ≥ 题数且无优先池」走 **O(n) 部分洗牌快路径**（分布等价于逐次「最少用量」）。`scripts/test-perf.mjs` 是万级金丝雀（正确性 + 宽松耗时上限，防回归成 O(n²)）。

## 数据模型（store.js）
- **Card**：`id, front, back, example, exampleZh, phonetic, tags[], groups[], extraBacks[], createdAt, level, state('new'|'learning'|'review'), repetitions, interval, easeFactor, due, lastReview, src, addedAt`
- **导入时的复习进度**：`store.pickScheduling()` 统一校验（state 白名单 / easeFactor 1.3–3.0 / 数值钳制，非法 → 新卡）；`seedBuiltinDeck` 与 `addManyCards` 均调用 → JSON 完整导出可无损回导
- **Deck**：`id, name, description, tags[], paused, cardsPerLevel(null=跟随全局), createdAt, demo, source, passedLevels{}, cards[]`
  - `source`：`'demo'`（内置示范）/ `'custom'`（我的生词）/ `null`（用户自建/导入）/ `'online_lookup'` 等（卡片级 src）
- **关卡**：`level` 即关卡索引（整数），每关 `clampPerLevel(15–30, 默认 20)`；`LEVELS_PER_PAGE = 15`

## 存储与迁移
- IndexedDB 库 `mycard` **v2**：`decks`(id) / `cards`(id, 索引 byDeck=deckId) / `meta`(key) / `lookup`(key=`${lang}_${word}`)
- localStorage：`mycard-meta`（设置+卡组清单）、`mycard-accent`、`mycard-mode`、`mycard-active-tag`、`mycard-hard-words`、`mycard-test-config`、`mycard-test-priority`、`mycard-import-history`（导入历史摘要，最近 20 条）、`test_progress_{deckId}[__wrong]`；IndexedDB `meta` 另存 `import-rollback:{id}`（追加导入的 cardIds，最近 5 次可精确回滚）；sessionStorage：`mycard-level-stats`、`mycard-review-session`、`mycard-review-all-session`、`mycard-test-session`
- 旧库 `localStorage['mycard-v1']` 首启自动迁移到 IndexedDB 并删键
- **下线词库清理**：`store.purgeRemovedBuiltins()` 按 `REMOVED_BUILTIN_SOURCES`（kaoyan/cet4/… 共 10 本）删除旧版自动导入的内置卡组，启动时执行、幂等；只删 source 命中的，不影响 demo/custom/自建

## 主题系统（theme.js + style.css）
- `<html data-theme="dark|light">` + `color-scheme`；`--accent*` 由 theme.js 内联写到 `<html>`
- 所有中性色都是**语义变量**：`--bg/--bg2/--bg3`、`--tx/--tx2/--tx3`、`--glass-bg(-strong)/--glass-brd(-strong)`、`--ovl-0..4`、`--brd-soft/mid/dash`、`--divider`、`--panel-top/bottom`、`--modal-a/b`、`--field-bg(-mid/-soft/-strong)`、`--thead-bg`、`--appbar-solid/fade`、`--shadow`
- 暗底专用前景色也变量化：`--teal-tx/--warn-tx/--amber-tx/--fb-*-tx/--pill-*-tx/--tag-tx/--soft-danger-tx`
- **强调文字色随 accent 派生**（v0.4.14 起；v0.4.15 改为对比度求解）：`theme.js` 的 `accentVars` 额外输出 `--tag-tx-dark` / `--tag-tx-light`——保持主色**色相与饱和度不变**；**深色底先 `lightenHex` 统一提亮一档**（HSL 亮度 `+TEXT_LIGHTEN_STEP = 0.12`，只会变亮、不超过白），浅色底按需加深；两者最后用 **WCAG 相对亮度**（`relativeLuminance` / `contrastRatio`）对 **HSL 亮度做二分**（`ensureTextContrast`，目标 `TEXT_CONTRAST = 4.5`，参考底色 `TEXT_BG`），**任意自定义色**（亮黄 / 极浅 / 近黑 / 灰）都成立；写在 `<html>` 上后，CSS `:root` 里 `--tag-tx: var(--tag-tx-dark)`、`:root[data-theme='light']` 里 `--tag-tx: var(--tag-tx-light)` → **切色 / 切模式解耦**（JS 只按 accent 算，CSS 按 mode 选）
- **`--accent-tx`**：`--tag-tx` 的别名（`--accent-tx: var(--tag-tx)`），统一所有「accent 作**前景色**」的地方——文字/图标（`.pill-live`/`.empty-icon`/`.q-blank`/`.fill-hint b`/`.multi-badge`/`.opt-mark-pick`/`.dropzone-icon`/`.import-ok b`/`.seg-btn.is-active`）**以及非文字前景**（焦点环 `*:focus-visible`、输入/填空/查词聚焦 `border-color`、`.q-blank` 下划线、`.dropzone.is-drag` 边框、原生 `accent-color`，v0.4.19 起）。**原始 `--accent` 只用于填充/品牌底**（按钮渐变、`.opt-picked .opt-key`、`.about-list li::before`）。`--soft-danger-tx` 是危险语义色，**刻意不跟随** accent
- **铁律**：新增 UI 不要写死颜色（尤其 `rgba(...)` 深色底、浅色字），一律用上述变量；`verify-assets.mjs` 会审计（未定义 var、残留硬编码中性色、`.modal` 是否走变量）

## 忽略策略（.gitignore）
- `gcide-0.51/`（60MB 源语料，仅 `scripts/split-gcide.mjs`/`build-engdefs.mjs` 本地用；生成物 `data/eng-defs.json` 入库）
- `data/` 下考试词库（CET4/托福/… 10 本）为**本地测试文件**，不入库
- `.DS_Store`、`node_modules/`、`*.log`、`.env*`
