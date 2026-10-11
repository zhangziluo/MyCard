# Tech Context — 技术栈、环境与命令

## 技术栈
| 项 | 说明 |
| --- | --- |
| 语言 | 原生 JavaScript（ES2020+，ES Module），**无 TypeScript** |
| 框架 | 无（自写 `ui.js` 事件委托 + `innerHTML` 渲染） |
| 构建 | **无**（静态托管即产物）；`package.json` 仅 `{"type":"module"}` 等元信息 |
| 依赖 | **零 npm 依赖**；唯一内置第三方：`vendor/sql.js/`（sql.js 1.13.0，MIT，WASM，用于生成 Anki SQLite）；`.xlsx` 读取（含多工作表 / 公式求值 / 合并单元格）为**自写**（`js/xlsx.js`，非第三方） |
| 存储 | IndexedDB（`js/idb.js` 自封装）+ localStorage/sessionStorage |
| 样式 | 单个 `css/style.css`，CSS 变量驱动主题，移动端优先 + 媒体查询自适应 |
| 离线 | `manifest.json` + `sw.js`：代码/数据**网络优先**、图片缓存优先；`VERSION` 递增即触发换新 |
| 部署 | Cloudflare Pages：Build `exit 0`、输出目录 `.` |

## 外部数据源与生成物
| 数据 | 来源 | 生成方式 |
| --- | --- | --- |
| `data/words.json`（示范 60 词） | 项目自编 | — |
| `data/confusables.json`（39 易混组 + 51 词多义） | 项目自编 | — |
| `data/frequency.json`（17634 词频序） | COCA 2 万高频词表 | — |
| `data/eng-defs.json`（14428 词英文释义） | GCIDE（`gcide-0.51/`，本地不入库） | `node scripts/build-engdefs.mjs` |
| 在线查词 | Free Dictionary API（英/德/法/希腊/…）+ Jisho（日语） | 运行时 fetch，结果缓存进 IDB `lookup` |

## 环境与命令
```bash
# 本地运行（必须 http(s)，file:// 下模块与 SW 受限）
python3 -m http.server 8080

# 全量校验（30 个 test-*.mjs + smoke-dom + verify-assets = 32 个脚本，3916 条断言）
for f in scripts/test-*.mjs scripts/smoke-dom.mjs scripts/verify-assets.mjs; do node "$f"; done
node --check js/*.js sw.js scripts/*.mjs      # 语法检查
node scripts/verify-assets.mjs                # 资源/一致性校验（含 CSS 变量审计）
node scripts/test-export.mjs                  # 会调用 python3（zipfile+sqlite3）校验 .apkg 产物（含 meta protobuf 字节）
node scripts/test-perf.mjs                    # 1 万词 / 500 关规模：统计·分组·抽题正确性（含优先池读取次数）+ 耗时金丝雀
node scripts/test-xlsx.mjs                    # 极简 .xlsx 读取器（ZIP STORED/DEFLATE、共享字符串、日期、多工作表 / 公式求值 / 合并单元格）
node scripts/test-revlog.mjs                  # 复习日志（ease/type 映射 / 清洗截断 / 排序汇总 / Anki 负秒换算）
node scripts/test-idb-store.mjs               # 存储层（v2→v3 升级 / 迁移 / 写穿 / 重载水合 / 复习日志 / 级联清理）
node scripts/test-table-editor.mjs            # 表格编辑页 #/editor（模版列一致性 / 表格内核 / 草稿 / 载入 / 粘贴多行 / 预览报告 / 渲染 / 事件 / 导入为卡组 / xlsx 指定工作表）
node scripts/test-wordbook.mjs                # 生词本整理 #/words（同词归并 / 保留优先级 / 合并语义 / 标签整理 / 筛选排序 / 多选批量 / 页面渲染分页）
node scripts/test-match.mjs                   # 明牌配对 #/match（解锁 ≥1 关 / **词源：整卡组与已通关关卡（normalizeSource·sourceCards·MAX_DECK_PAIRS）** / 分轮建牌（每轮 5 对）与可复现洗牌 / 六态点击状态机 / 连击·失误·用时 / 薄 UI 局部打补丁与入口横幅 / 连击提示贴棋盘右下角 / 棋局只存内存：同一页内重渲染不重排、**重进同一关重新洗牌**）
node scripts/test-crossword.mjs               # 填字游戏 #/crossword（解锁 ≥1 关 / 词条清洗（纯字母·长度·去重）/ canPlace 四条排版规则 · findPlacement 评分 / 棋盘生成与可复现 / 逐格状态机（检查·提示·显示本词）/ **移动端：cellSize 触屏下限 30px + 屏幕字母键盘** / 薄 UI（打字只打补丁、焦点推进、结算、会话复活与清场）与入口横幅）
node scripts/test-keyboard.mjs                # 移动端英文字母键盘 #kb-bar（环境判定 / 键位 HTML / open·hide·show·close 四态 / DOM 三态（键盘·迷你胶囊·隐藏）/ inputmode 同步 / 事件派发 / 视口监听只绑一次）
node scripts/test-sync.mjs                    # 多端同步（WebDAV 客户端：URL 规范化·Basic·PROPFIND/MKCOL/GET/PUT/DELETE·错误映射·超时·无 fetch；合并内核：内容按 updatedAt / 进度按 lastReview / 日志并集 / 墓碑与复活 / 幂等 / 变更统计；快照往返：本地→快照→清库→应用（id / 进度 / revlog 全还原）；墓碑与配置；**v0.9.0 增量布局：内存假 WebDAV 服务端 `makeServer` + 只传变化 / 只下载变化 / 预览只读 / 本机专用 / v1 单文件自动升级**）

# 数据准备（可选，需本地具备 gcide-0.51/）
node scripts/split-gcide.mjs
node scripts/build-engdefs.mjs
# 例句生成（--data 必填）
LLM_API_KEY=sk-xxx node scripts/gen-examples-llm.mjs --data data/words.json --sample 6
node scripts/gen-examples.mjs --data data/words.json --sample 8
```

## 版本号约定
- **两处必须同步递增**：`sw.js` 的 `VERSION`（缓存键）与 `js/app.js` 的 `APP_VERSION`（顶栏显示）
- 当前：`APP v0.9.2` / `SW v1.16.0`

## 测试工程要点（写新测试时照抄）
- 每个测试是独立 `.mjs`，自建浏览器桩（localStorage/document/window/location/requestAnimationFrame/HashChangeEvent）
- IndexedDB 用 `scripts/fake-idb.mjs` 的 `installFakeIndexedDB()`（含 `dumpStore()` 断言）
- 断言统一 `ok(cond, msg, extra)` + 末尾 `process.exit(fail ? 1 : 0)`
- DOM 冒烟用 `scripts/smoke-dom.mjs` 的轻量 fakeEl + `fire(action, dataset)` 走真实事件委托
- **交互页（棋盘类 UI）的 DOM 桩**：把「渲染」当事件源——给 `innerHTML` 加 setter，写入后就按当前会话重建「牌 / 统计格」的查询结果（`querySelectorAll('.match-tile')` / `[data-match]`），于是既能断言「点击**没有**写 `innerHTML`（只局部打补丁）」，也能在每次重渲染后拿到新节点（见 `scripts/test-match.mjs`）
- 资源一致性用 `scripts/verify-assets.mjs`（读源码字符串 + 解析 data/*.json）
- **xlsx 测试**：用 `export.js` 的 `zipStore`（STORED）+ Node `zlib.deflateRawSync` 手工拼**真实 ZIP**（`scripts/test-xlsx.mjs`），既覆盖 STORED 也覆盖 DEFLATE 解压路径；多工作表用例额外拼 `xl/workbook.xml` + `xl/_rels/workbook.xml.rels`，公式/合并用例直接拼 `<f>`（含 `<v>` 缓存）与 `<mergeCells>`
- **填字页（表单类 UI）的 DOM 桩**：答题格必须是**持久** `input` 节点（`innerHTML` 写入时按当前会话重建一次，之后打字只改 `value` / `class`），这样才能断言「打字**没有**写 `innerHTML`（只局部打补丁）」；统计格（`#cw-words` / `#cw-time` …）真实页面由 HTML 直接渲染初值，桩里在 `innerHTML` 写入时**按会话状态回填**（否则整页重渲染后的断言会读到陈旧值）。`--cw-cols` / `--cw-cell` 由 JS 内联覆盖，但仍需在 CSS `:root` 给出默认定义（`verify-assets` 会审计 `var()` 是否都有定义）

## 已知坑（务必记住）
1. **`vendor/sql.js/sql-wasm.js` 是 UMD 构建**：本项目 `package.json` 是 `"type":"module"`，Node 会把 `.js` 当 ESM，UMD 检测失效 → 返回 `{}`。**必须**保留 `vendor/sql.js/package.json`（`"type":"commonjs"`）才能 `createRequire` 加载。浏览器侧则用 `<script>` 注入 + `window.initSqlJs`。
2. **`crypto.subtle` 需要安全上下文**（https/localhost）；Node ≥20 有全局 `crypto`。`test-export.mjs` 里的 SHA-1 校验依赖它。
3. **`requestAnimationFrame` 在 Node 不存在**：任何测试只要触发 `openModal`（内部用它加 `.show`）就必须补桩。
4. **`matchMedia` 在 Node 不存在**：`theme.js` 要能降级（`systemPrefersDark()` 无 matchMedia → 视为深色）。
5. **CSS 新增颜色必须走变量**：否则浅色模式会出现「深底深字」类 bug（v0.4.12 就是 `.modal` 写死深色渐变导致）。
6. **终端 heredoc 在本机不稳定**：写多行脚本/文本请用编辑器工具或独立文件，避免 `python3 - <<'PY'` 被 shell 破坏。
7. **解压 `.xlsx` 依赖 `DecompressionStream('deflate-raw')`**：浏览器与 Node ≥18 原生支持；环境不支持时 **STORED** 的 xlsx 仍可解析（压缩条目会抛明确错误）——`js/xlsx.js` 已做降级提示。
8. **`.git` 体积易被 IDE 检查点撑大**：Cline 扩展会生成 `refs/cline/checkpoints/*`（可能持有重写前的大对象）。若 `.git` 膨胀，回收方式：`git for-each-ref refs/cline` 逐条 `git update-ref -d` → `git reflog expire --expire=now --all` → `git gc --prune=now`（v0.4.18 曾把 49M → 2.4M）。
9. **`scripts/fake-idb.mjs` 的 `open()` 必须按版本触发 `onupgradeneeded`**（v0.5.8 已修：`upgrading = isNew || version > db.version`）。否则测不出「v2 → v3 增量升级只补建新 store」这类真实升级路径。
10. **加 IDB store 时别忘了三处**：`idb.js` 的 `onupgradeneeded` 补建（用 `contains` 判空）、`clearAll()` 的 store 清单（漏写 = 清空后旧数据又读回来）、`scripts/fake-idb.mjs` 能力对齐（本项目只有 `put/get/delete/clear/getAll/index.getAll`）。
11. **Anki `revlog` 的学习步间隔是「负数秒」而非正数秒**：Anki 用 `interval_secs()` 按符号区分单位（正数 = 天 ×86400、负数 = 秒），写 `600` 会被读成「600 天」。`js/revlog.js` 的 `entryToAnkiIvl()` 已按此换算。
12. **评分日志必须传「评分前」快照**：`store.updateCard()` 原地改卡片对象，直接把卡片对象交给 `recordReview` 会让 `lastIvl` / `type` 失真（`test-review-interaction.mjs` 有守卫断言）。
13. **配对棋局不落盘（v0.6.1）**：`js/match.js` 的棋局只存在模块级 `S`（内存），**不写 sessionStorage**；`renderMatch` 只承认「内存里已有本卡组的会话」这一种沿用情形（= 同一页内的重渲染，如切主题），其余路（首次加载 / 刷新 / 路由切换 / 点入口）一律 `startGame` 重新洗牌。**别再把棋局写回 sessionStorage**——那等于把「重进同一关」变成「接着上一局」，与需求相反。随之下线的 `isRoundComplete` / `isBoardComplete`（只服务于「复活损坏棋局」）改由 `test-match.mjs` 直接断言 `buildBoard` 产物的「每轮词义成对完整」性质。
14. **移动端抑制系统输入法只能用 `inputmode="none"`（v0.7.0）**：自绘字母键盘（`js/keyboard.js`）靠把宿主输入框的 `inputmode` 在 `none` / `latin` 之间切换来「不弹系统键盘」。**不要改用 `readonly`**——`readonly` 会连 `input` 事件一起掐掉（物理键盘与部分浏览器的手写/语音输入就废了）；`inputmode="none"` 不支持时只会退化成「两种键盘都能用」，不会坏。另一个坑：`inputmode` 是**属性**，必须在 `focus` **之前**写到 DOM 上（所以 `renderCrossword` / `renderTest` 都是**先 `openKeyboard` / `attachFillKeyboard`，再写 `innerHTML`**，最后再 `syncInputs()` 一次），否则 iOS 可能已经按旧属性把系统键盘弹起来了。
15. **WebDAV 直连受 CORS 限制（v0.8.0）**：浏览器 `fetch` 打 WebDAV 会带 `Authorization` 且用 `PROPFIND` / `MKCOL` 等非简单方法 → **一定触发预检**，服务端必须允许跨域才行（坚果云 `dav.jianguoyun.com/dav`、Nextcloud `remote.php/dav/files/…` 通常可以；被拦时 fetch 直接抛错，`webdav.explainError()` 会提示「网络失败 / 跨域被拦」）。**不要**在文档或 UI 里承诺「任何 WebDAV 都能连」。另外：Node 单测里 `globalThis.navigator` 是只读 getter（≥21）**不可赋值**，桩里别写 `globalThis.navigator = {...}`。
16. **同步的落库入口只有一个（v0.8.0 起）**：`store.applySyncDecks(decks, { settings, keepDeckIds })` —— 保留 id、写卡片、**连 `revlog` 一起回写**、把本地多出来的卡组 / 卡片删掉，但**跳过 `keepDeckIds`（「本机专用」卡组）**。**新增任何同步相关写入都不要绕过它**，否则会出现「卡组回来了但日志没回来」这类半截状态。另：`store.flushPending()` 是 **async**，测试里要 `await`（复习日志是防抖落盘的）。
17. **同步「只传变化」靠内容指纹，且要按卡组粒度（v0.9.0）**：网盘上是 `mycard-sync.json`（索引：每卡组摘要 + `hash`）+ `mycard-decks/{deckId}.json`（内容）。指纹必须**与字段顺序无关**（`stableStringify` 先给键名排序再 `JSON.stringify`）——本地 payload（`deckPayload` 的字段顺序）与合并后 payload（`normalizeSnapshot` 的顺序）并不相同，若直接用 `JSON.stringify` 算指纹，**每次同步都会误判为「变了」而全量重传**（`test-sync` 有「数据没变 → 零卡组传输」的守卫断言）。`buildUrl` 会逐段 `encodeURIComponent`，所以**卡组文件名不能再预先 encode**（否则路径里出现 `%25`）；文件名只把 `/ \ : * ? " < > | %` 与控制字符换成 `-`，若改动过则追加 `deckHash(id)` 防撞。合并后消失的卡组要 `DELETE` 掉远端文件，否则网盘越积越多。
18. **`verify-assets` / 其他脚本里的正则字面量别再夹带 `/`**：写 `must(/…/.test(src), …)` 时，被匹配的片段本身若含 `/`（例如要匹配 `store.js` 里的 `!/deck.syncLocal/`），**必须先转义成 `\/` 或改用 `new RegExp(...)`**——否则正则提前结束、脚本直接 `SyntaxError`（本次 v0.9.0 就踩过一次；表现为「grep 不到 ✗ 但脚本没跑完」）。
19. **「最后改动时间」要落在数据自己身上，别借快照时间（v0.9.0）**：v0.8.0 用「快照 `savedAt`」决定「每关词数」取谁，但本地快照的 `savedAt` 恒为 `now` → **远端永远赢不了（等于单向同步）**。现在全局设置自带 `settings.updatedAt`（`setSetting` 只在值真变时推进），合并优先比它、老数据退回 `savedAt`；`applySyncDecks` 落库后要把它一起写回（否则「本机刚采纳」会被当成「本机刚改」）。**新增任何需要跨端比新旧的全局偏好，都照这个来：先给它一个自己的时间戳，再进合并规则。**
20. **测试里的服务端桩要「按路径存文本」而不是「按顺序消费路由」（v0.9.0）**：增量同步会出现「同一方法打不同路径」的请求（`GET mycard-sync.json` / `GET mycard-decks/x.json` / 多个 `PUT`），顺序消费的路由表非常容易写歪。`test-sync` 现在用内存假服务端 `makeServer()`（`Map<路径, 文本>` + 记录 `ops`），既能断言最终文件内容，也能断言「这次到底发了几个 PUT / 有没有多余的 GET」——**写「只传变化」这类断言时，记得把 `.prev.json` 备份 PUT 一起算或显式排除**（否则计数会多一个）。
21. **「允许出英文题」只有一个开关：`eng_eng`（v0.9.1）**：`allowEnSenses`（是否允许英文题）**必须由「英英选择」是否开启派生**，并**同时**传给两条链路——抽题计划（`samplePlan({ canType })`）与出题（`buildQuestionsFromPlan({ allowEnSenses })`）。只改其中一条就会出现「计划派了多义题、出题却回退成英文/基础题」的不一致。可用性判定统一走 `test.js` 的 `canBuildType(card, type, { allowEnSenses })`，别再各处自己写条件。另外 `multiSenseSet()` 的英文兜底是**显式参数**（`{ allowEnglish }`，默认 true 仅为兼容旧调用），新代码请按场景显式传入。
22. **测试里读「当前整卡组测试题目」要读对键（v0.9.1）**：整卡组测试（`startDeckTest`）的进度写的是 `engine.saveProgress(deckId, T, mode)` → `localStorage['test_progress_<deckId>']`，**不是** `mycard-test-session`（那个 key 只给关卡测试的 `sessionStorage` 用）。读错 key 会拿到上一次关卡测试的题目，断言「看起来过了」其实全是空转（本次就踩过：20 道 fill 被当成了整卡组测试的结果）。
23. **浏览器对「为什么连不上」是失明的（v0.9.2）**：`fetch` 失败在浏览器里**只有** `TypeError: Failed to fetch` —— DNS、自签证书、CORS 预检被拒、广告拦截插件、公司代理**全都长一个样**，网页拿不到任何区分信息（状态码、`response` 都不存在）。所以：
    - **不要把错误压成一句没信息的话**（v0.8.0 的 `'request failed'` 就是这么埋的坑：`explainError()` 认不出它、也没带 `cause`，用户只看到一句英文）—— 要保留 `cause`（`name` + `message`）、带上 `url` 与 `kind`（`timeout` / `offline` / `mixed-content` / `network`）；
    - **能本地判定的先判定**：HTTPS 页面 + `http://` 地址属**混合内容**，浏览器会直接拦（我们连 `fetch` 都不发，直接给结论）；
    - **用「简单请求」把 CORS 单独隔离出来**：`GET`（不带 `Authorization`、不带自定义头）不触发预检 → 能拿到状态码就说明「网络通 + 允许简单跨域」；再发 `PROPFIND`（必然触发预检）→ 若前者通过而后者失败，就是**网盘不允许浏览器跨域**（这个结论是可靠的，不是猜的）。诊断（`webdav.diagnose()`）就按这个顺序走，且**每步都不抛错**；
    - **报告不要带密码**（`diagnoseReport()` 只写地址 / 用户名 / 目录 / UA / 逐步结果），这样用户才敢复制求助。

24. **`flushPending()` 不许「先清空再写」（v0.9.2 修的真实竞态）**：Store 的增量落盘是「pending Map + 防抖 flush」。旧实现一进 `flushPending()` 就把四个容器（`pendingDecks` / `pendingCards` / `pendingRevlogs` / 删除集合）**同步清空**，然后才 `await` 写 IndexedDB —— 于是 `await` 期间存在**「pending 里没有、IDB 里也还没写」的空窗**：`revlogsOfDeck()`（合并 pending + IDB 读）会读到 0 条，而 `sync.buildSnapshot()` → `push` 的快照就会漏掉刚产生的复习日志（高负载下 `test-import-file` 的偶发失败正是这个，不是测试写错）。现在改为「**先取快照 → 写完（成功或失败）后在 `finally` 里只删掉快照中未被再次修改的条目**」：期间被改成新对象的条目留在 pending 等下一轮，新加入/新删除的条目不受影响。**同类代码（任何「清空待办 + 异步写」）都要避免这个空窗**：先移除会让读路径看不到、后移除只会导致重复写一次。
