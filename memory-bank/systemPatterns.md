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
                 ├─ table-editor.js（#/editor 表格编辑页：模版列同源 + 表格内核 +
                 │           草稿 + 从文件载入 + 下载 CSV；导入复用 import-file.js 链路）
                 ├─ wordbook.js + wordbook-view.js（#/words 生词本批量整理：归并/标签/筛排内核 + 薄页面）
                 ├─ match.js（#/match 明牌配对游戏：分轮建牌 + 六态点击状态机 + 点击只局部打补丁）
                 ├─ crossword.js（#/crossword 填字游戏：按当前词库交叉排版生成棋盘 +
                 │           逐格填写状态机 + 输入只局部打补丁）
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
8. **大卡组（万级）性能**（v0.4.17/18）：渲染前**只算一次 `deckLevels` 并复用**（`levelStates(deck, levels)`）；统计一律**单遍遍历**；列表类视图**分页**（关卡 15/页、卡片管理 `CARDS_PER_PAGE = 100`），避免一次性写入上万 DOM 节点；抽题在「词数 ≥ 题数」时**一律走 O(词数 + 题数) 的部分洗牌快路径**（v0.5.6 补齐带优先池一侧：非优先槽位用「交换删除」取未用过的词并从候选池 O(1) 摘除优先槽位已取走的词，优先槽位仍取「最少用量」；分布等价于逐次「最少用量」）。`scripts/test-perf.mjs` 是万级金丝雀——**用 Proxy 计数卡组元素读取次数**（与机器速度无关）＋ 宽松耗时上限，防回归成 O(n²)
9. **导入只有一条落库链路**（v0.5.3）：文件导入与 `#/editor` 表格录入都收敛到 `import-file.js` 的 `importWordsToDeck(words, { mode, deckName, deckId })` → `validatePayload` → `seedBuiltinDeck`（新建）/ `addManyCards`（追加）→ `recordImport` → `importSuccessHtml`。**新增导入入口时不要另写写库逻辑**，直接调它即可自动获得相同的校验 / 去重 / 关卡编排 / 导入历史 / 撤销。
10. **导入模版与表格页同源**（v0.5.2 / v0.5.4）：`CSV_TEMPLATE_COLUMNS` 是唯一列定义（模版下载、文件导入的表头对号、`#/editor` 表格列都读它）。模版**无法写注释** → 「示例行」只是普通行，故下载 toast / 按钮 title / 弹窗说明**三处**提示「导入前请删除」；示例行可选（仅表头 / 1 行 / 多行示例，`head`/`single`/`multi`），JSON 模版另给「1 完整 + 1 最简」两条示例。
11. **表格页的输入增强走纯函数内核**（v0.5.5）：粘贴解析 `gridFromPaste`（Tab/换行，**单格返回空 → 不拦截浏览器默认粘贴**）与铺开 `applyPaste`（自动补行至 `MAX_TABLE_ROWS`、超列**截断**并由 UI 提示）都是纯函数，可被 `test-table-editor.mjs` 直接单测；文档级 paste 监听用 `bindPasteOnce()` 惰性绑定且**只绑一次**（视图重渲染不重复绑定）。
12. **写库前先出预览 / 校验报告**（v0.5.5）：`#/editor` 点「导入为卡组」先 `openTableImportPreview()`（宽版弹窗：可导入条数 / 缺单词 / 表内重复去重 / 目标卡组已存在的**唯一单词数** / 前 `PREVIEW_ROWS` 行预览），**确认后才**调 `importWordsToDeck`。同类「不可逆操作前先给报告」是本项目的既定交互模式。

13. **评分要记日志，且必须先「快照」再改卡**（v0.5.8）：`review.js` 的 `rate()` 里 `store.updateCard` 会**原地修改**卡片对象，因此日志参数要用**评分前**的 `{id, state, interval, easeFactor}` 快照（否则 `lastIvl` / `type` 会被污染）；日志写入是**同步、非阻塞**的（`store.recordReview` → `pendingRevlogs` 防抖落盘），绝不 await 进渲染链路。
14. **导 Anki 的字段语义别混用**（v0.5.8）：`cards` 表里**学习卡** `due` = 到期时刻（epoch 秒）、`ivl` = 剩余秒、`left` = 剩余步数、`type/queue = 1`；**复习卡** `due` = 相对天数、`ivl` = 整天、`type/queue = 2`。`revlog` 表 `ivl`/`lastIvl` 用**符号区分单位**（正数 = 天、负数 = 秒），`time` 是**毫秒**、`factor` 是 `×1000` 的整数、`id` 是**毫秒主键且必须唯一**（同毫秒逐条 +1 探测）。改这些映射时同步跑 `test-export.mjs`（用 Python `sqlite3` 独立校验产物）。

15. **整理 / 批量改数据也是「纯函数内核 + 薄页面」**（v0.5.9）：`js/wordbook.js` 负责「什么算同一个词（`normKey`）、保留哪张（`keepScore`/`pickKeeper`）、合并成什么（`mergeGroup`/`mergePlans`）、怎么筛排（`filterWords`/`sortWords`）」——全部无 DOM 无存储、可直接单测；`js/wordbook-view.js` 只做渲染与事件，落库交给 `store.mergeCards`/`updateCards`。**新增「批量整理类」功能照此分层**（同 `test-engine`/`table-editor` 的做法）。
16. **合并 / 删除这类不可逆操作先出报告**（v0.5.9）：整理页点「合并重复词」先 `openDedupeReport()`（合并报告 + 保留规则说明），确认后才 `runMerge()` 写库；批量删除走 `confirmDialog`。与「导入先预览」（第 12 条）同一交互约定。
17. **页面状态分家：易失的放内存，可分享 / 可回退的进 URL**（v0.5.9）：`#/words` 的搜索 / 筛选 / 排序 / 选中都在模块级 `S`（重渲染与翻页不丢，卡片删除 / 合并后用 `limitSelection` 收敛），**只有页码进 URL**（`#/words?page=N`）以支持浏览器前进后退；UI 用 `replaceState` 以外的 `navigate()` 改 hash（与关卡分页、卡片管理分页一致）。
18. **重渲染型输入框要手动救回焦点**（v0.5.9）：`wb-search` 输入防抖 180ms 后整体重渲染，必须记下 `selectionStart` 并在新 DOM 上 `restoreSearchFocus(caret)`（`type=search` 的 `setSelectionRange` 可能抛错 → try/catch 忽略）。这与 `#/editor` 里「单元格输入只 `refreshStats()`、不整页重渲染」（第 11 条）是两种合法策略：**需要重排列表**（搜索 / 筛选 / 排序）就重渲染 + 救焦点，**只是补统计**就别重渲染。
19. **键盘可达性与读屏标注（v0.5.10，统一约定）**：① 可点击但**不是** `<button>` 的容器（卡组磁贴 / 示范横幅 / 翻卡 / 拖拽导入区）一律写成 `role="button" tabindex="0" data-action="…"`，键盘激活交给 `ui.activateOnKey` 统一处理（**不要**各模块自己写 keydown，原生 `<button>` 由它自动跳过）；② 这类容器**内部不得再嵌套可聚焦控件**（ARIA 规定 `role=button` 不含交互后代）——外层已是按钮时，里面的标签 / chips 用纯 `<span>`，把同一功能放到别处的可聚焦控件上（首页 chips 行 / 卡组详情页标签按钮）；③ 状态必须可读：筛选 chips `aria-pressed`、进度条 `role="progressbar"`＋`aria-valuemin/max/now`、分页 `role="navigation"`＋`aria-label`、图标按钮**必须有中文 `aria-label`**、纯装饰元素 `aria-hidden="true"`；④ 弹窗**只用** `ui.openModal`（自带 `role=dialog`＋`aria-modal`＋`aria-labelledby`（无标题回退 `aria-label`）＋首元素聚焦＋`Tab`/`Shift+Tab` 焦点陷阱＋`Esc` 关闭并把焦点还给触发元素），不要自拼 overlay；⑤ 需要让读屏感知的变化（如路由切换）用 `ui.announce(msg)`（先清空再写，同一句可重复读出；**不要**给 `<main>` 这类大容器挂 `aria-live`，否则每次重渲染整页重读）；⑥ 样式里**禁止**裸 `:focus { outline: none }`，一律收敛为 `:focus:not(:focus-visible)`，且必须留可见焦点指示（输入框去轮廓的场合，由外层容器 `:focus-within` 补环）；⑦ 新动画 / 过渡要能被全局 `@media (prefers-reduced-motion: reduce)` 覆盖（时长 → `0.001s`、`animation-iteration-count: 1`、`scroll-behavior: auto`，含 `::before`/`::after`）；⑧ 以上每一条都要在 `scripts/test-a11y.mjs` 里有对应断言。

20. **游戏 / 交互页＝「纯函数内核 + 薄 UI + 点击只打局部补丁」**（v0.5.11 / v0.5.12 / v0.5.13，以明牌配对 `js/match.js` 为例）：① **内核**只做状态推演、不碰 DOM——`splitRounds`/`buildBoard(cards, rng, per = ROUND_PAIRS = 5)`（每关按每轮 5 对切分，**每轮各自洗牌** → 不会出现「整轮全是词牌」的死局；多余的对数自动溢到后面的轮次）→ `buildTiles`（随机源**可注入** → 单测用 LCG 完全复现洗牌）、`roundTiles`/`roundStats`/`liveTiles`/`roundCount`/`roundLeft`（棋盘只画**当前轮**）、`nextSelection(state, tileId)`（返回 `select`/`cancel`/`replace`/`match`/`miss`/`ignore` 六态）、`applyPick(state, id)`（**不改入参**，返回 `{state, event, pair, roundCleared}`——连击 / 失误 / 轮次推进 / `endedAt` 都在这里算）、`boardStats`/`playStats`/`formatDuration`；UI 只负责「把状态画出来 + 把事件喂回内核」。② **点击绝不整页重渲染**：`paintPick()` 只改 class → `aria-pressed` → `disabled` → 连击提示 → 轮次行 → 统计文本，配对成功的那一对在 `BOOM_MS`（420ms）后用 `removePair()` **真的从 DOM 上摘掉**（棋盘随之变短）。**理由**：整页重建会让**已消除的牌复活**、**金光重复播放**（animation 随新节点重新触发）并**丢键盘焦点**；整页 `innerHTML` 只留给「开局 / 换关 / 重开 / 铺下一轮 / 主题切换」这类低频时刻（**内存里的会话**保证同一页内的重渲染**沿用同一副牌**）。③ **一次性动画**：`match-goldflash` / `match-burst`（挂 `is-matched::after`）/ **`match-boom`（爆炸消除）/ `match-shake` / `combo-pop` / `combo-kick` 一律不写 `infinite`**，这样全局 `@media (prefers-reduced-motion: reduce)` 的 `animation-duration: 0.001s` 能自然把它们降级（第 19 条第 ⑦ 款）；JS 侧 `boomMs()` 在「减少动效」下**直接返回 0**，不让玩家空等动画。④ **焦点跟着状态走**：配对成功后 `focusNextPlayable()` 把焦点交给**下一张还能点的牌**（键盘可连玩），铺下一轮时焦点落到新铺的第一张牌，全部配完把焦点交给结算面板的「再玩一次」；状态变化用 `announce()` 播报（「配对成功，连击 ×N」/「第 N 轮开始，本轮 M 对」/「全部配对完成，用时 …」）。⑤ **牌面用原生 `<button>`**（不用 `role=button` + `activateOnKey`），配 `aria-pressed` 反映选中、`aria-label` 带上「单词 / 释义」语义前缀；纯装饰的「combo✖️N」提示（**v0.5.13 起贴棋盘右下角**：落点 `right / bottom: 0`，位于 `.match-board-wrap` 的 `padding-bottom: clamp(28px, 8vw, 34px)` 底部留白条内 → **不遮挡牌面文字**；`combo-kick` 绕 `transform-origin: 100% 100%` 缩放 / 轻抖）写 `aria-hidden="true"`（读屏只认 `announce()`），已配对的那对爆炸后**离开 DOM** 而不是留在 Tab 序列里。⑥ 会话 / 计时器 / 抖动定时器 / **爆炸定时器**同生共死：`clearMatchSession()` 一并清掉（`hashchange`、重置数据、离开棋局都调它），Node 侧给 timer 加 `unref()` 以免阻塞单测退出。**v0.6.1 起棋局只存内存、不再落 `sessionStorage`**：`renderMatch` 只在「内存里已有本卡组的会话」时沿用（= 同一页内的重渲染，切主题 / 切主色不重排、不丢选中态），**其余任何一次进入（首次加载 / 刷新 / 路由切换 / 点入口 / 点同一关 / 再玩一次）都 `startGame` 重新洗牌开局**；原来用于「从缓存复活损坏棋局」的 `isRoundComplete` / `isBoardComplete` 随之下线（同一性质改在 `test-match.mjs` 里对 `buildBoard` 产物直接断言）。

21. **第二个游戏（填字 `js/crossword.js`）沿用第 20 条分层，但多了「生成器」与「表单输入」两件事**（v0.6.0）：① **内核 = 生成器 + 状态机**——`entryFromCard`/`candidateEntries`（词条清洗：`sanitizeAnswer` 只留 A–Z 并转大写、长度 2–12、按答案去重）、`canPlace`（四条排版规则：交叉字母一致 / 不叠加同向词 / 空格子的垂直邻居必须空 / 词首词尾必须空）、`findPlacement`（评分 = 交叉数 × 10000 − 外框面积）、`generateCrossword(cards, { size, rng })`（**最长词打底 → 逐个找落点 → 交叉不上的跳过**，随机源可注入 → 完全可复现）、`buildBoard`（归一化坐标 + 逐行扫描编号 + 格子挂线索 id）；状态机 `newGame`/`setLetter`/`checkAll`/`hintCell`/`revealCell`/`revealWord`/`progress` 全是**不改入参**的纯函数（`finalize()` 统一维护 `solved` 与 `endedAt`）。② **词源与规模是可切换的生成参数**：`sourceCards(deck, source)` 把「整卡组 / 某一已通关关卡」收敛成一个数组，`SIZES = [6,8,10,12]` 决定抽词数——**同一套生成器服务所有入口**（换词源 / 换词数 / 换一批都只是重新调 `generateCrossword`），这样「按当前词库自定义生成」只有一条代码路径。③ **输入类 UI 绝不能整页重渲染**：`paintCells()` / `paintClues()` / `paintStatus()` 只打补丁（格子的 `value` · `is-wrong` · `is-revealed` · `is-active`、线索的 `is-correct` · `aria-pressed`、状态行 + 四个统计格 + 进度条），否则每敲一个字母都会**丢焦点、丢光标、丢输入法候选框**；整页 `innerHTML` 只留给「开局 / 换词源 / 换词数 / 换一批 / 重新开始」。④ **键盘 / 焦点走文档级委托且只绑一次**：`bindKeysOnce()`（模块级 `keysBound` 守卫）注册 `keydown`（方向键找最近有字母格 + 切方向、Backspace 空退回上一格、Delete 清格、空格拦截）与 `focusin`（按当前方向自动选中所属线索）；**不要**在每次渲染时 `addEventListener`。⑤ **答题格用原生 `<input maxlength=1 inputmode="latin" autocapitalize="characters">`**（Tab / 输入法 / 移动端拉丁键盘天然可用），`aria-label` 含「第 R 行第 C 列 / 线索号 / 已填字母」；线索是原生 `<button>` + `aria-pressed`；棋盘 / 词源 / 词数 chips 用 `role="group"` + `aria-label`。⑥ **会话守门**：`sessionStorage['mycard-crossword-session']` 里存**含答案的棋盘**，复活时逐项校验（格子 / 线索非空、字母 key 必须落在棋盘内、`wrong`/`revealed` 过滤、选中线索有效、跑一次 `finalize` 纠正 `solved`），损坏一律丢弃重开；`clearCrosswordSession()` 连计时器一起清。
22. **可复现用「可注入随机源」，紧凑排版用「外框面积惩罚」**（v0.6.0，通用经验）：凡是「随机生成 + 需要单测断言」的功能，都把 `rng = Math.random` 作为**最后一个可注入参数**（`generateCrossword(cards, { rng })` / `shuffle(list, rng)` / `hintCell(state, rng)`），测试传 LCG 即可断言「同一 seed → 结果逐字节相同」、并断言「换 seed → 结果变化」；生成类算法用**整数评分 + 严格大于才替换**（同分保留先遍历到的）来同时满足「紧凑」与「确定」。

## 数据模型（store.js）
- **Card**：`id, front, back, example, exampleZh, phonetic, tags[], groups[], extraBacks[], createdAt, level, state('new'|'learning'|'review'), repetitions, interval, easeFactor, due, lastReview, src, addedAt`
- **导入时的复习进度**：`store.pickScheduling()` 统一校验（state 白名单 / easeFactor 1.3–3.0 / 数值钳制，非法 → 新卡）；`seedBuiltinDeck` 与 `addManyCards` 均调用 → JSON 完整导出可无损回导
- **复习日志（RevlogEntry，v0.5.8）**：`id('ts-cardId'), cardId, ts, ease(1–4), type(0 学习/1 复习/2 重学), ivl(天), lastIvl(天), factor(easeFactor×1000), time(毫秒)`；`ivl`/`lastIvl` **本机统一存「天」**，仅导出 Anki 时换算（`>=1 天 = 正数天`、`不足 1 天的学习步 = 负秒数`，与 Anki 的 `interval_secs()` 一致）；校验 / 截断 / 换算全在纯函数模块 `js/revlog.js`
- **多释义（`extraBacks`）与合并语义（v0.5.9）**：首义永远在 `back`、其余义按顺序在 `extraBacks`（自动去重）；「我的生词」整理页合并重复卡时，**保留卡片的 `back` 仍是第一义**（不会被副卡覆盖），副卡释义追加进 `extraBacks`、标签取并集，**复习进度 / `lastReview` / revlog 一律不动**；「同一个词」= `wordbook.normKey(front)`（`trim` + 小写，不做空格 / 连字符归一）
- **Deck**：`id, name, description, tags[], paused, cardsPerLevel(null=跟随全局), createdAt, demo, source, passedLevels{}, cards[]`
  - `source`：`'demo'`（内置示范）/ `'custom'`（我的生词）/ `null`（用户自建/导入）/ `'online_lookup'` 等（卡片级 src）
- **关卡**：`level` 即关卡索引（整数），每关 `clampPerLevel(15–30, 默认 20)`；`LEVELS_PER_PAGE = 15`

## 存储与迁移
- IndexedDB 库 `mycard` **v3**：`decks`(id) / `cards`(id, 索引 byDeck=deckId) / `meta`(key) / `lookup`(key=`${lang}_${word}`) / **`revlog`**(id, 索引 byDeck=deckId / byCard=cardId)
  - **升级策略**：`onupgradeneeded` 里用 `objectStoreNames.contains()` **逐 store 增量补建**（v2→v3 只加 `revlog`，既有数据不动）；`clearAll()` 清空时**必须把所有业务 store 都列上**（漏一个就会「清空后又读回旧数据」）
  - **复习日志落盘**：`pendingRevlogs` 并入 `flushPending()` 的写穿队列；查询 `revlogsOfDeck()` = IDB ∪ 未落盘 ∪ 回退模式内存（`deck.revlogs`）；删卡片 / 删卡组走 `purgeRevlogs()` **异步级联清理**（不阻塞 UI）
- localStorage：`mycard-meta`（设置+卡组清单）、`mycard-accent`、`mycard-mode`、`mycard-active-tag`、`mycard-hard-words`、`mycard-test-config`、`mycard-test-priority`、`mycard-import-history`（导入历史摘要，最近 20 条）、`mycard-table-draft`（`#/editor` 表格草稿，防抖写入，≤5000 行）、`mycard-aw-merge`（首页添加单词的「重复词自动合并」偏好，v0.5.9，默认开）、`test_progress_{deckId}[__wrong]`；IndexedDB `meta` 另存 `import-rollback:{id}`（追加导入的 cardIds，最近 5 次可精确回滚）；sessionStorage：`mycard-level-stats`、`mycard-review-session`、`mycard-review-all-session`、`mycard-test-session`、`mycard-crossword-session`（填字棋盘：词源 / 每局词数 / 含答案的排版结果 / 已填与已提示的格 / 提示次数与用时）——**明牌配对的棋局不落盘（v0.6.1 起只存内存）**，故这里没有 `mycard-match-session`
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
