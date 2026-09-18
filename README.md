# Mycard 学习卡片（PWA）

基于**艾宾浩斯遗忘曲线**的间隔重复记忆应用 —— 纯前端、无后端、**零依赖、无构建工具**（原生 ES Module + 静态托管），可安装到手机主屏并**离线使用**。

## 功能

- **卡片模型**：正面（单词 / 问题）＋ 背面（释义 / 答案）＋ 例句 / 例句翻译 ＋ 音标 ＋ 所属卡组 ＋ 标签 ＋ 易混分组 ＋ 多释义 ＋ 复习状态
- **翻转记忆**：点击卡片 3D 翻转，底部四档反馈按钮 **重来 / 困难 / 记住 / 轻松**（支持键盘 / 鼠标拖拽 / 手机滑动手势，见下文）
- **间隔重复调度**：艾宾浩斯曲线间隔 `10分钟 → 1小时 → 12小时 → 1/2/4/7/15/30/60 天`，按反馈动态调节复习时间与 easeFactor
- **关卡系统**
  - 每个卡组默认启用关卡模式（设置中可调每关 **15–30** 张，默认 **20**）
  - 自动按关卡分组、**顺序解锁**（通关当前关卡才能进入下一关）；通关条件：该关所有卡片完成翻转记忆 **＋** 测试题正确率 **≥ 80%**
  - 小卡组（< 30 张）不拆分，作为单关卡
  - **关卡分页**：关卡数 > **15** 时按页展示（每页 15 关，分页条显示「第 2/45 页」，URL 支持 `#/deck/{id}?page=2`）
  - **卡片管理分页（v0.4.18）**：卡片数 > **100** 时按页渲染（每页 100 张，URL 支持 `#/deck/{id}/cards?page=2`）——万级卡组不再一次性写入上万 DOM 节点
- **难度判定（v0.4）**：词频（`data/frequency.json`，COCA 2 万高频词表 → 17634 条）＋ 词长 ＋ 音节数 ＋ 熟悉度 ＋ 语种特性（英文不规则拼写 / 日语汉字音读训读 / 古文生僻字占比）
- **关卡编排（v0.4）**：**平缓进阶**（前几关高频短词打基础，后续混入低频长难词）＋ **错峰排列**（同易混组词汇间隔 ≥2 关）＋ **动态调序**（错题池 / 困难词自动提升到当前关卡；卡组页提供「按难度重排关卡」）
- **卡组管理**：新建 / 编辑 / 删除 / 暂停 / 标签筛选 / 卡片增删改
- **干扰项生成（v0.2）**：示范词库按「形近 / 近义·反义 / 同根·同域」手动分组为易混组；出题时干扰项优先级为 **被考词自身其它释义（多义词的其它释义）→ 同组其它词 → 随机词兜底**，共 3 个干扰项且选项顺序随机打乱；`water / money / time` 等无强易混关系的词不分组，直接走随机兜底
- **作答交互**：选择题**答对**即提示并自动进入下一题；**答错**提示错误并允许重新选择（错误项被禁用），每题最多 **3 次**机会，用尽机会后自动跳下一题并短暂标出正确答案；**答错（机会用尽）时展示完整信息卡** `front ＋ back ＋ 例句`，便于即时巩固
- **测试题型**
  - **五种基础题型（v0.3）**：单词选释义 `word2def`、释义选单词 `def2word`、句子选单词 `sentence2word`、填空 `fill`、听音辨意 `listen`（浏览器 TTS，离线可用）
  - **两种可选题型（v0.5，默认关闭）**：*仅在「整卡组可配置测试」中按设置启用；**关卡测试固定使用五种基础题型**（v0.5.1）*
    - **英英选择 `eng_eng`**（*建议考研及以上水平使用（需较强英文阅读理解能力）*）：子模式 A「看单词选英文释义」/ 子模式 B「看英文释义猜单词」随机出现，释义取自 GCIDE
    - **多义多选 `multi_sense`**（*建议考研及以上水平使用*）：勾选该词**全部释义**后提交判分，**全对才算对**，漏选 / 多选 / 错选均算错；释义优先取卡组内中文释义（`back` ＋ 多释义），缺失时回退 GCIDE 英文释义
- **整卡组可配置测试**：题数 **20~150** 可调（快速 20 / 标准 50 / 挑战 150 ＋ 滑块，步长 10），题型按权重分配、词数不足时循环覆盖，错题进优先池，支持中途退出续做
- **导出词表 / Anki 卡包（v0.4.11，v0.4.13 扩至四种格式，v0.4.16 起带复习进度）**：卡组菜单（⋮）提供五种导出，纯前端下载（离线可用）；列序统一为 `正面 / 背面 / 例句 / 例句翻译 / 音标 / 标签(逗号)`，无正面的卡片不导出
  - **标准 txt（TSV）**：UTF-8 带 BOM、制表符分隔、一卡一行，首行为列名；单元格内的制表符与换行会被清洗为空格（保证「一卡一行」）
  - **CSV（带表头）**：UTF-8 带 BOM、逗号分隔、CRLF 行尾，首行为列名；按 **RFC 4180** 转义 —— 含 `,` / `"` / 换行的字段用双引号包裹、内部 `"` 加倍（因此多行释义在 Excel / 表格工具里也不会串行）
  - **Markdown**：`# 卡组名` 标题 ＋ 标准 Markdown 表格（表头 ＋ `|---|---|` 分隔行）；单元格内 `|` 转义为 `\|`、换行转 `<br>`、制表符转空格（可直接贴进笔记 / GitHub）
  - **JSON（含复习进度）**：`{formatVersion, name, description, tags, levelSize, cards:[…]}`，每张卡含内容 ＋ `state / repetitions / interval / easeFactor / due / lastReview`；结构与**导入侧完全兼容**，可「导出 → 导入」**无损往返**（复习状态、多释义、易混分组一并保留），用于整库备份 / 换设备迁移
  - **Anki 卡包 `.apkg`**：ZIP（`collection.anki2` + `media` + **`meta`**）内为 **Anki 2.1 schema 的 SQLite**（内置 `vendor/sql.js` WASM 生成），含 `col/notes/cards/revlog/graves` 与 **Basic 笔记模板**；卡组名沿用应用里的名称，正面含音标、背面含其余释义与例句/翻译，标签转为 Anki 标签；**`cards` 表按卡片复习进度写入调度**（`state→type/queue`、`interval→ivl`、`easeFactor→factor`、`repetitions→reps`、`due→相对天数`），导入 Anki 后可直接续学；`meta` 为新版 Anki（≥2.1.50）要求的 **`PackageMetadata` protobuf**（`version = LEGACY_1`，与 `collection.anki2` + schema v11 自洽），**新版 Anki 不再因缺 `meta` 报错，老版 Anki 忽略该条目仍读 `collection.anki2`**；可直接在 Anki「文件 → 导入」打开（注：`revlog` 仍为空——逐次复习历史不迁移，只迁移聚合状态）
- **明暗模式（v0.4.10）**：**浅色 / 深色 / 跟随系统** 三档，设置页顶部「外观」区块切换，顶栏右侧一键快捷切换（浅色 ⇄ 深色）；切换即时生效并保存在本机（`localStorage['mycard-mode']`）；跟随系统时监听 `prefers-color-scheme` 自动跟随，`<meta name="theme-color">` 与原生控件（`color-scheme`）一并跟随；`index.html` 首屏前内联读取模式写 `<html data-theme>`，**不会先闪一下深色**
- **主题色（v0.4.1，v0.4.14/15 补对比度，v0.4.19 覆盖非文字前景）**：设置页可切换主色调（8 个预设 ＋ 自定义取色），按钮 / 进度条 / 徽标 / 氛围光全局跟随（浅色 / 深色下均可用）；**所有「accent 作前景色」的地方都随主色派生**——文字 / 图标 / **焦点环 / 输入与高亮边框 / 原生 `accent-color`** 统一走 `--accent-tx`：保持主色色相与饱和度，**深色底统一提亮一档**（HSL 亮度 +0.12）、浅色底按需加深，再用 **WCAG 相对亮度对 HSL 亮度二分**保证与底色对比度 ≥ 4.5:1，**任意主色（含亮黄、极浅、近黑、灰）都成立（WCAG AA）**；`theme.js` 写入 `--tag-tx-dark`/`--tag-tx-light`，CSS 按 `data-theme` 二选一，故切色 / 切模式互不耦合
- **首页添加单词 / 词表（v0.6）**：首页顶部只有一个输入框，自动判断三种输入并统一走「查词 → 预览 → 加入『我的生词』」
  - **单个单词**：在线查词典（按字符范围自动判断语种：英 / 德 / 法 / 希腊语走 [Free Dictionary API](https://dictionaryapi.dev/)，日语走 [Jisho](https://jisho.org/api)），预览音标 ＋ 多条释义后一键加入
  - **词表（每行一个，≤1000 词）**：批量查词，进度条显示「已处理 23/100」，请求间隔 ≥ 100ms，未查到的词集中列出
  - **大段文本**：自动分词去重（默认勾选前 50 个）→ 勾选需要的词 → 查词 → 加入
  - **落库**：统一写入懒创建的「我的生词」卡组（`deck.source='custom'`），按单词去重、不覆盖已有词；首义存 `back`、其余义存 `extraBacks`（因此新词天然支持「多义多选」题型），并记录 `src` / `addedAt`；查询结果缓存进 IndexedDB `lookup` store（key = `${lang}_${word}`），重复查询不再联网，失败自动重试一次
- **本地文件导入词库（v0.6.1；v0.5.0 增 Excel / 多文件 / 历史回滚）**：首页「我的卡组」右上角 **导入** 按钮 / 下方**拖拽区**（拖入文件即可，含拖入高亮），选择本地 **CSV / TSV / JSON / XLSX** 文件（零第三方依赖，自带解析器）
  - **Excel `.xlsx`**：自写「ZIP 读取 + 最小 XML 扫描」（`js/xlsx.js`，支持 STORED/DEFLATE、共享/内联字符串、数值/布尔/日期），取**第一个工作表** → 走同一套「预览 + 字段映射」；不支持公式求值 / 合并单元格 / 多 sheet 选择（明确限制）
  - **多文件批量导入**：导入按钮可**多选**、拖拽区可**拖入多个**文件 → **每个文件各建一个卡组**（按表头/位置自动映射），完成后弹「批量导入完成」汇总
  - **导入历史 / 回滚（v0.5.0）**：每次导入都记入**导入历史**（首页历史图标进入）：可**撤销**——新建的卡组直接删除；追加进已有卡组的则**只移除本次新增的卡片**（`cardIds` 存 IndexedDB，保留最近 5 次可精确回滚）；「导入完成」弹窗也直接提供「撤销导入」
  - **先预览再导入**：读取文件后弹出**宽版预览弹窗**，显示**前 10 行**数据的表格（自动识别分隔符并显示「分隔符：逗号/Tab/分号」、行列统计、表头识别结果）；首行符合表头特征时用作列名，否则表头显示 **「列 1 / 列 2 …」**（深色主题 / 手机端横向滚动 + 粘性表头）
  - **字段映射（v0.6.2）**：表格下方按列给出下拉映射 —— **正面（单词）·必选 / 背面（释义）·必选 / 例句 / 例句翻译 / 音标 / 标签（逗号分隔）/ 忽略**；默认**第一列 = 正面、第二列 = 背面、其余忽略**（识别到表头时按中英文表头别名自动对号）；点「确认导入」时校验「正面/背面各恰一列」，不合法会提示并**保持弹窗**便于修改；表头行不会被当成卡片
  - **目标牌组（v0.6.2）**：可选**已有牌组**（下拉列出「名称（N 张）」，导入即**追加**并重新拆分关卡，牌组内已存在的单词自动跳过）或**新建牌组**（填名称 → 按难度分层＋错峰自动编排关卡）
  - **导入完成（v0.6.2）**：弹窗提示「共导入 X 张卡片到牌组「YYY」」（含跳过统计）+ **「去学习」**按钮直接进入该牌组
  - **CSV / TSV**：自动嗅探分隔符（`,` / `Tab` / `;`），支持引号包裹、引号内逗号与换行、`""` 转义、BOM；**表头中英文均可**（`word/单词/正面`、`meaning/释义/翻译`、`example/例句`、`exampleZh/例句翻译`、`phonetic/ipa/音标`、`tags/标签`）且列顺序不限；无表头时按 `front,back,example,exampleZh,phonetic,tags` 位置解析
  - **JSON**：兼容词库文件格式 `{name?, description?, tags?, levelSize?, words:[...]}` 与纯单词数组 `[{front|word, back|meaning, example, exampleZh, phonetic, tags}]`（预览显示「单词 / 释义」两列）
  - 整份文件解析后**一次事务批量写入**本地库，按单词去重并报告跳过数；新建牌组时 `source=null` 故可重复导入（各自新建卡组）
- **数据存储（v0.4）**：卡片正文与学习进度存 **IndexedDB**（库 `mycard` v2，stores：`decks` / `cards` / `meta` / `lookup`），localStorage 只保留设置与卡组清单（key `mycard-meta`）；旧版 `mycard-v1` 整库会在首次启动时**自动迁移**到 IndexedDB 并删除旧键，从而支持万词级词库
- **内置词库**：仅内置「英语高频词（示范）」约 60 词（`data/words.json` ＋ 易混分组 `data/confusables.json`），首次打开**自动导入**并按难度编排 3 关；应用不再内置其它词库，需要时可用首页「导入」按钮导入自己的 CSV / JSON 词表（见上一条）。旧版本曾内置的 10 本考试词库（考研 / 四级 / 六级 / 托福 / 雅思 / 专四 / 专八 / SAT / 初中 / 高中）已下线，浏览器里**遗留的历史卡组会在启动时自动清理**（按 `source` 精确匹配，仅删这些内置卡组，不影响你自建的卡组与「我的生词」）
- **PWA**：`manifest.json` ＋ `sw.js`；**代码 / 数据走网络优先**（在线总是最新，离线回退缓存），图片走缓存优先；新版本 SW 接管后自动刷新一次，通常**一次刷新即可看到新功能**；顶栏显示当前版本号（当前 `v0.5.1`），设置页另提供「强制刷新到最新版（清理离线缓存）」应对极端缓存情况
- **界面**：移动端优先、深色主题、毛玻璃（glassmorphism）卡片；**桌面端自适应** —— `#app` 按 640 / 960 / 1280 / 1600px 断点逐级放宽（600 → 760 → 1080 → 1280 → 1440px），卡组用 `auto-fill` 网格随宽度平铺 2–5 列，宽屏下关卡列表两列平铺

## 目录结构

```
├── index.html              # 单页应用入口（应用外壳）
├── manifest.json           # PWA manifest
├── sw.js                   # Service Worker（预缓存 App Shell + 示范词库）
├── package.json            # 仅元信息（零依赖、无构建脚本）
├── favicon.svg
├── icons/                  # 应用图标（192 / 512 / maskable / apple-touch）
├── css/style.css           # 深色毛玻璃样式（移动端优先 + 桌面自适应）
├── js/
│   ├── app.js              # 入口：路由 / 顶栏 / 设置页 / 启动引导（存储初始化 + 迁移）
│   ├── store.js            # 数据层（IndexedDB 优先，localStorage 回退）+ 示范词库导入 / addWords
│   ├── idb.js              # IndexedDB 极简封装（decks / cards / meta / lookup）
│   ├── scheduler.js        # 艾宾浩斯间隔重复调度（纯函数）
│   ├── levels.js           # 关卡拆分 / 解锁 / 通关判定 / 关卡分页（纯函数）
│   ├── difficulty.js       # 难度判定（词频 / 词长 / 音节 / 熟悉度 / 语种特性，纯函数）
│   ├── arrange.js          # 关卡编排（平缓进阶 / 错峰排列 / 动态调序，纯函数）
│   ├── theme.js            # 主题：明暗模式（浅色/深色/跟随系统）+ 主色调自定义（CSS 变量 + 本机持久化）
│   ├── engdefs.js          # GCIDE 英文释义表懒加载（英英题 / 多义题用）
│   ├── levelstats.js       # 关卡挑战统计（重刷次数 / 最佳成绩，sessionStorage）
│   ├── hardwords.js        # 困难词标记（翻转「不认识」记录，localStorage）
│   ├── ui.js               # 通用 UI：Action 委托 / toast / modal / 导航
│   ├── decks.js            # 卡组列表 / 详情（关卡分页）/ 卡片管理（分页）/ 表单
│   ├── review.js           # 翻转记忆模式（按关卡 / 整卡组循环 / 会话续学）
│   ├── test-config.js      # 测试配置（题数 20~150、档位、题型权重、可选题型、通关阈值）
│   ├── test-engine.js      # 测试引擎（抽题 / 循环 / 题型分配 / 优先池 / 进度）
│   ├── test.js             # 测试题模式（7 种题型 + 整卡组可配置测试）
│   ├── add-words.js        # 首页添加单词/词表：语种检测 / 分词 / 在线查词 / 缓存 / 预览
│   ├── import-file.js      # 本地文件导入：CSV/TSV/JSON/XLSX 解析（零依赖）+ 预览 + 字段映射 + 多文件批量 + 拖拽区
│   ├── import-history.js   # 导入历史与回滚（撤销导入：删新建卡组 / 移除追加卡片）
│   └── xlsx.js             # 极简 .xlsx 读取器（自写 ZIP 读取 + 最小 XML 扫描）
├── vendor/
│   └── sql.js/             # 内置 sql.js（MIT）：WASM 版 SQLite，用于导出 .apkg（含 package.json 声明 CommonJS）
├── data/
│   ├── words.json          # 示范词库（60 词 / 3 关）
│   ├── confusables.json    # 易混分组（39 组）+ 多释义（51 词）
│   ├── frequency.json      # 词频表（COCA 2 万高频词 → 17634 条，供难度判定）
│   └── eng-defs.json       # GCIDE 英文释义（14428 词 → 释义数组，按需加载，不进预缓存）
├── gcide-0.51/             # GCIDE 词典源（本地数据，已 .gitignore 不入库；约 60MB，用于生成 data/eng-defs.json）
└── scripts/
    ├── gen-icons.py        # Pillow 图标生成脚本（一次性）
    ├── gen-examples.mjs    # 抓取词库英文例句（freedictionaryapi.com，可选）
    ├── gen-examples-llm.mjs# 用大模型生成词库例句 + 整句中文翻译（需 LLM_API_KEY，可选）
    ├── build-engdefs.mjs   # 从本地 gcide-0.51/ 生成 data/eng-defs.json（英英题 / 多义题数据）
    ├── split-gcide.mjs     # 把本地 GCIDE 语料重打包为 3~4 个 <25MB 的文本分卷（一次性）
    ├── fake-idb.mjs        # Node 测试用的最小 IndexedDB 桩
    ├── test-core.mjs       # 核心逻辑（调度 / 关卡，43 项断言）
    ├── test-difficulty.mjs # 难度判定维度（39 项断言）
    ├── test-arrange.mjs    # 关卡编排（22 项断言）
    ├── test-pagination.mjs # 关卡分页（25 项断言）
    ├── test-resplit-levels.mjs # 修改每关词数后重新分组（26 项断言）
    ├── test-review-complete.mjs # 翻转完成页「进入测试」可跳转（11 项断言）
    ├── test-review-interaction.mjs # 翻转记忆键盘 / 手势交互链路（12 项断言）
    ├── test-theme.mjs      # 明暗模式 + 主题色 + 强调文字对比度（150 项断言）
    ├── test-confusables.mjs# 干扰项 + 三种题型（82 项断言）
    ├── test-hardwords.mjs  # 整卡组翻转循环 / 困难词标记（26 项断言）
    ├── test-level-retry.mjs# 关卡重新挑战 / 直接测试 / 题型微调（含「关卡测试不含可选题型」，78 项断言）
    ├── test-fill.mjs       # 填空题（85 项断言）
    ├── test-listen.mjs     # 听音辨意（21 项断言）
    ├── test-deck-test.mjs  # 整卡组可配置测试（81 项断言）
    ├── test-eng-eng.mjs    # 英英选择题型（34 项断言）
    ├── test-multi-sense.mjs# 多义多选题型（39 项断言）
    ├── test-idb-store.mjs  # 存储层（迁移 / 写穿 / 重载水合 / 重排 / 旧内置词库清理，42 项断言）
    ├── test-add-words.mjs  # 首页添加单词 / 词表（82 项断言）
    ├── test-import-file.mjs# 本地文件导入（解析/表头映射/预览/字段映射/目标牌组/追加/大词表/进度还原/XLSX/批量/历史回滚，246 项断言）
    ├── test-xlsx.mjs       # 极简 .xlsx 读取器（ZIP STORED/DEFLATE、共享字符串、日期、端到端，33 项断言）
    ├── test-export.mjs     # 导出 txt/CSV/Markdown/JSON/Anki apkg（RFC4180、meta protobuf、Anki 调度、ZIP+CRC32、Python sqlite3 校验产物，133 项断言）
    ├── smoke-dom.mjs       # 无头 DOM 冒烟（各界面渲染 + 分页 + 明暗切换 + 导出/导入入口，145 项断言）
    ├── test-perf.mjs       # 大卡组（1 万词 / 500 关）规模：统计/分组/抽题正确性 + 耗时金丝雀（26 项）
    └── verify-assets.mjs   # 资源完整性校验（218 项）
```

## 本地运行

```bash
# 任意静态服务器即可（纯静态，无构建、无依赖）
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

> 提示：Service Worker 需要 `http://localhost` / `https` 环境；用 `file://` 直接打开时模块加载会受浏览器限制。

## 测试与校验

全部测试均为 Node 原生脚本（无需安装任何依赖）：

```bash
node scripts/test-core.mjs            # 核心逻辑（调度 / 关卡，43 项断言）
node scripts/test-difficulty.mjs      # 难度判定维度（词频/词长/音节/熟悉度/语种/缓存，39 项）
node scripts/test-arrange.mjs         # 关卡编排（平缓进阶 / 错峰间隔 / 动态调序，22 项）
node scripts/test-pagination.mjs      # 关卡分页（> 15 关 → 第 2/X 页，25 项）
node scripts/test-resplit-levels.mjs  # 修改每关词数后旧关卡自动重新分组（26 项）
node scripts/test-review-complete.mjs # 翻转完成页「进入测试 · 冲刺通关」可跳转（11 项）
node scripts/test-review-interaction.mjs # 翻转记忆键盘 / 手势交互链路（12 项）
node scripts/test-theme.mjs           # 明暗模式（浅色/深色/跟随系统）+ 主题色 + 强调文字对比度（150 项）
node scripts/test-confusables.mjs     # 干扰项 + 三种题型（释义/同组/兜底/单词池/挖空，82 项）
node scripts/test-hardwords.mjs       # 整卡组翻转循环 / 困难词标记（26 项）
node scripts/test-level-retry.mjs     # 关卡重新挑战 / 直接测试 / 题型微调（含关卡测试不含可选题型，78 项）
node scripts/test-fill.mjs            # 填空题（判题容错 / 渲染 / 🔊 发音与降级，85 项）
node scripts/test-listen.mjs          # 听音辨意（出题 / TTS 播放与降级，21 项）
node scripts/test-deck-test.mjs       # 整卡组可配置测试（抽题/循环/优先池/权重/续做，81 项）
node scripts/test-eng-eng.mjs         # 英英选择题型（子模式 A/B、选项构成、回退，34 项）
node scripts/test-multi-sense.mjs     # 多义多选题型（中文优先→GCIDE 回退、多选判分，39 项）
node scripts/test-idb-store.mjs       # 存储层（迁移 / 写穿 / 重载水合 / 重排 / 旧内置词库清理，42 项）
node scripts/test-add-words.mjs       # 首页添加单词/词表（语种/分词/查词/缓存/限速/去重落库，82 项）
node scripts/test-import-file.mjs     # 本地文件导入（解析/预览/字段映射/目标牌组/追加/大词表/进度还原/XLSX/批量/历史回滚，246 项）
node scripts/test-xlsx.mjs            # 极简 .xlsx 读取器（ZIP STORED/DEFLATE、共享字符串、日期、端到端，33 项）
node scripts/test-export.mjs          # 导出 txt / CSV / Markdown / JSON / Anki apkg（RFC4180·meta protobuf·Anki 调度·ZIP·CRC32，Python sqlite3 校验，133 项）
node scripts/smoke-dom.mjs            # 无头 DOM 冒烟（各界面渲染 + 分页 + 明暗切换 + 导出/导入入口，145 项）
node scripts/test-perf.mjs            # 大卡组（1 万词）规模：单遍统计 / 复用关卡分组 / 抽题快路径 + 耗时（26 项）
node scripts/verify-assets.mjs        # PWA 资源完整性 + 字段映射 / 明暗模式 / 导出 / 导入增强 / 性能校验（218 项）
node --check js/*.js                  # 语法检查
```

当前合计 **1699 条校验**（各套件输出的 `✓`）**全部通过、0 失败**（含纯函数单测、无头 DOM 冒烟、IndexedDB 存储、大词表导入、Anki 卡包产物与万级性能金丝雀）。

## 部署：Cloudflare Pages

1. 将该目录推送到 Git 仓库；
2. Cloudflare Pages → **Create a project** → 连接仓库；
3. **Build command**: `exit 0`
4. **Build output directory**: `.`
5. 部署完成后即得到可安装的 HTTPS PWA 链接。

发布新版本如需更新缓存：修改 `sw.js` 顶部 `VERSION`（如 `v1.7.8`）即可触发 Service Worker 换新。

## 数据说明

- 卡片正文与学习进度保存在浏览器 **IndexedDB**（库 `mycard` v2：`decks` / `cards` / `meta` / `lookup`），全部在本机、不上传任何服务器；
- localStorage 只保留**设置与卡组清单**（key `mycard-meta`）以及少量本机状态，见下表；
- 旧版本数据（整库存在 `localStorage["mycard-v1"]`）在首次启动时**自动迁移到 IndexedDB** 并删除旧键，以释放 localStorage 配额；
- 设置页可一键清空全部数据，并显示当前存储方式、卡组 / 卡片数量与元数据占用；
- 在线查词只把**单词本身**发往词典接口（`api.dictionaryapi.dev` / `jisho.org`），结果缓存在 `lookup` store，清空数据时一并清除；
- 首次打开需联网一次：注册 Service Worker 并缓存应用外壳 ＋ 示范词库（`words.json` + `confusables.json` + `frequency.json`），随后自动导入示范卡组；之后即可**完全离线**使用。

### 本机存储一览

| 位置 | key | 内容 |
| --- | --- | --- |
| IndexedDB `mycard` | stores `decks` / `cards` | 卡组元信息、卡片正文与复习进度 |
| IndexedDB `mycard` | store `meta` | 迁移标记等少量元数据 |
| IndexedDB `mycard` | store `lookup` | 在线查词缓存（`${lang}_${word}` → 卡片） |
| localStorage | `mycard-meta` | 设置 ＋ 卡组清单（精简元数据） |
| localStorage | `mycard-v1` | **旧版整库**（仅迁移用，迁移完成后自动删除） |
| localStorage | `mycard-accent` | 主题色（主色调） |
| localStorage | `mycard-mode` | 明暗模式（`light` / `dark` / `system`） |
| localStorage | `mycard-active-tag` | 首页标签筛选 |
| localStorage | `mycard-hard-words` | 困难词标记 |
| localStorage | `mycard-test-config` | 测试配置（题数 / 题型权重 / 可选题型开关） |
| localStorage | `mycard-test-priority` | 错题优先池 |
| localStorage | `test_progress_{deckId}` / `test_progress_{deckId}__wrong` | 测试进度（常规 / 错题专项） |
| sessionStorage | `mycard-level-stats` | 关卡重刷次数与最佳成绩 |
| sessionStorage | `mycard-review-session` / `mycard-review-all-session` | 翻转记忆进度（按关卡 / 整卡组） |
| sessionStorage | `mycard-test-session` | 当前测试会话（含选项乱序种子） |

### 例句生成脚本（`scripts/gen-examples*.mjs`）

- `scripts/gen-examples-llm.mjs` 用**大模型**为词库 JSON 生成自然、简短的英文例句（8–20 词）与**整句中文翻译**（DeepSeek / OpenAI 兼容接口，Key 仅用环境变量传入，不写入仓库），用 `--data <词库 JSON>` 指定目标文件：
  ```bash
  LLM_API_KEY=sk-xxx node scripts/gen-examples-llm.mjs --data data/words.json --sample 6   # 抽样试跑
  LLM_API_KEY=sk-xxx node scripts/gen-examples-llm.mjs --data data/words.json              # 全量生成（批量+并发+断点续跑）
  LLM_API_KEY=sk-xxx node scripts/gen-examples-llm.mjs --data data/words.json --only-missing --clean
  ```
- 备选（离线 / 免费）：`scripts/gen-examples.mjs` 从 freedictionaryapi.com 抓取真实词典例句（Wiktionary 派生，CC BY-SA 4.0），中文侧以释义兜底；同样用 `--data <词库 JSON>` 指定目标，支持 `--sample N` / `--only-empty` / `--fix-bad` / `--clean`。
- 两个脚本都作用于**词库 JSON 文件**（含 `words[].example` / `exampleZh` 字段的任意词库）；未传 `--data` 会打印用法并退出，目标目录不存在时自动创建。

## 翻转记忆：操作方式（快捷键 / 手势）

卡片**翻面后**（看到答案）才能评分；三端方向一致：**右 = 轻松、上 = 记住、左 = 困难、下 = 重来**。

| 操作 | 桌面 · 键盘 | 桌面 · 鼠标 | 手机 · 触摸 |
| --- | --- | --- | --- |
| 翻面 | `空格` | 点击卡片 | 点按卡片 |
| 轻松（简单） | `→` 或 `Enter` | 向右拖拽 | 右滑 |
| 记住（一般） | `↑` 或 `Shift+Enter` | 向上拖拽 | 上滑 |
| 困难（错误） | `←` 或 `Backspace` | 向左拖拽 | 左滑 |
| 重来 | `↓` | 向下拖拽 | 下滑 |

- 拖拽 / 滑动位移需超过阈值（32px）才判定为评分，否则按「点击翻面」处理。
- 长按方向键不会连续触发（忽略自动重复）。
- 手机端若当前面内容超长，纵向拖拽会**优先滚动内容**，到达边界后继续拖拽才触发上 / 下滑评分。
- 反馈按钮右上角显示对应方向键提示（触摸设备自动隐藏）。

## 整卡组翻转记忆（顶部「翻转记忆」按钮）

进入卡组后，顶部按钮可进入**整卡组循环翻转**模式（路由 `#/review/{deck}`）：

- 进入时用 **Fisher-Yates** 洗牌**全部卡片**（突破每关 20 张的限制），并让**困难词排在最前**；
- 点卡片翻面显示 **释义 + 例句**；四档反馈沿用「重来 / 困难 / 记住 / 轻松」；
- 界面显示 **当前轮次 · 进度 · 困难词数量**；到最后一张自动回到第一张，`轮次 +1`；
- **即使全部点了「轻松」也不会自动退出**，持续循环，直到用户主动操作；
- **完成 ≥1 整轮**后 **「开始测试」** 由置灰变为高亮，点击进入「第一个未通关关卡」的测试；未完成 1 整轮前不可进入测试；
- **困难词**：翻转中点「重来 / 不认识」即标记（点「轻松」取消），保存在 `localStorage['mycard-hard-words']`；
  - 重新进入翻转时困难词**前置到前几张**；
  - 测试时困难词**被考概率更高**（额外多出一道题）且**更常作为干扰项**。

## 整卡组可配置测试（20~150 题）

卡组详情页顶部 **「整卡组测试 · 20~150 题」** → 路由 `#/test/{deck}`（与按关卡测试并存）：

- **题数可调**：预设档位 **快速 20 / 标准 50 / 挑战 150**，或拖动滑块 **20~150**（步长 10）；卡组 **< 20 词**时滑块与按钮禁用并提示「至少需要 20 个词才能开始测试」。
- **抽题规则**（`test-engine.js`）：
  - 词数 ≥ N：**无重复**（每个词最多一次）；
  - 词数 < N：**循环出题** —— 首轮每个词至少出现一次（随机顺序），其后「用量最少者优先 + 同一词两次出现间隔 ≥ `floor(N/词数)`」，**同词重复出现时优先分配不同题型**。
- **题型比例**：启用的题型按权重分配（默认五种基础题型各 20%），抽题后整体随机打乱顺序；配置页提供**「题型比例」编辑面板**（默认展开，滑块，拖动任一题型其余按比例自动分摊，**合计恒为 100%**），并提供 **「恢复默认（各 20%）」** 一键还原。勾选启用 `eng_eng` / `multi_sense` 后，权重变为**所有已启用题型等比分配**。该配置**只作用于整卡组可配置测试**；**关卡测试固定使用五种基础题型**（不含英英 / 多义，v0.5.1）。
- **判分 / 通关**：正确率 **≥ 80%** 通关；结果页显示正确率、对 / 错题数、通关状态、用时与**错题列表**。
- **错题优先池**：未达标的错题写入 `localStorage['mycard-test-priority']`，下一轮测试**优先占用约 50% 配额**（并在可行时仍保证覆盖全部词）；结果页提供 **「错题专项再练 · N 题」**（只抽优先池里的错题）。
- **中途退出续做**：
  - 常规测试进度写入 `localStorage['test_progress_{deckId}']`；
  - **错题专项**进度独立写入 `localStorage['test_progress_{deckId}__wrong']`（两套进度**互不覆盖**）；
  - 再次进入该卡组测试时弹窗列出未完成的进度（「常规测试 / 错题专项」各一行），可分别选择「**继续上次测试 / 继续错题专项**」或「重新开始（清空两套进度）」。

## 关卡：直接测试 / 重新挑战

- **直接测试（跳过翻面）**：翻转记忆页（学习模式）提供「跳过翻面 · 直接测试」入口；测试正确率 **≥ 80% 即通关**——该关尚未翻面的卡片会自动记为「已学」（按「记住」推进），且不会重置已有复习进度。
- **重新挑战**：已通关的关卡卡片显示「重新挑战」按钮，点击后：
  1. 清除该关通关标记（下一关会随之重新锁定，重新通关后再次解锁）；
  2. 清除测试会话 → **题目池重新洗牌**；
  3. 每道题的**选项重新随机排序、干扰项重新生成**；
  4. 重刷次数 +1，并跳转到该关测试。
- **重刷统计（sessionStorage，key `mycard-level-stats`）**：记录每关的「重刷次数」与「历史最佳正确率」，显示在测试结果页与已通关关卡卡片上；关闭标签页后重置。
- **题型比例微调**：首次测试题型等权；每次重刷按 `(重刷次数 − 1) % 5` 在**五种基础题型**内轮换侧重一种（权重 ×2），使每次重刷的题型分布略有变化；**不含英英 / 多义**（v0.5.1）。
- 「再测一次」（结果页）同样计入重刷次数并微调题型比例。

## 间隔重复算法（简版说明）

| 反馈 | 效果 |
| --- | --- |
| 重来 | 忘记 → 10 分钟后重学，easeFactor −0.2 |
| 困难 | 间隔 ×0.8，easeFactor −0.1 |
| 记住 | 标准曲线间隔，easeFactor 不变 |
| 轻松 | 跳一档复习节奏，easeFactor +0.05 |

复习间隔 = 艾宾浩斯曲线间隔（按连续答对次数）× 反馈系数 × easeFactor（1.3–3.0）。

## 干扰项生成（v0.2 说明）

每道选择题为「1 个正确释义 + 3 个干扰项」，选项顺序随机打乱。干扰项按以下优先级生成：

1. **被考词自身的其它释义**（多义词其它含义，与例句语境不匹配，最具迷惑性）
2. **同易混组其它词的释义**（形近 / 近义·反义 / 同根·同域）
3. **随机词 / 多释义兜底**

只有主释义 `back` 不会作为干扰项；同一释义文本全局去重。题目同时展示例句，题干提示「请选择与例句最匹配的释义」以区分多义词的哪个含义是正确答案。

> 数据：`data/confusables.json`（39 个易混组 + 51 词多释义）。`water / money / time` 等没有强易混关系的词不分组，直接走随机兜底。

## 测试题型（5 种基础 + 2 种可选）

| 题型 | id | 题干 | 作答方式 | 正确项 | 默认 |
| --- | --- | --- | --- | --- | --- |
| 单词选释义 | `word2def` | front | 从 4 个释义中选 | back | 启用 |
| 释义选单词 | `def2word` | back | 从 4 个单词中选 | front | 启用 |
| 句子选单词 | `sentence2word` | example 挖空 | 从 4 个单词中选 | front | 启用 |
| 填空 | `fill` | example 挖空 或 back（每题随机二选一） | 输入英文单词 | front | 启用 |
| 听音辨意 | `listen` | 🔊 单词发音（浏览器 TTS） | 从 4 个释义中选 | back | 启用 |
| 英英选择 | `eng_eng` | 单词 或 英文释义（子模式 A/B 随机） | 从 4 个**英文**选项中选择 | 对应英文释义 / 单词 | 可选（默认关） |
| 多义多选 | `multi_sense` | 单词 + 「多选」标识 | 勾选**全部**释义后提交 | 该词全部释义 | 可选（默认关） |

- 每张卡随机分配一种（已启用的）题型，选择题为「1 个正确项 + 3 个干扰项」并打乱顺序。
- 以「单词」为选项的两类题型，干扰项遵循「同易混组其它词优先 → 随机单词兜底」，且排除自身。
- 句子选单词只在例句确含目标词时生成，挖空会把词形变化一并匹配（如 `run→runs`、`play→playing`、`study→studies`、`word→words`）。
- **听音辨意**：题干为「🔊 播放发音」按钮（进入该题自动播放一次，可点击重播），用浏览器内置 **Web Speech API（`speechSynthesis`）** 合成英文发音，**离线可用、无需音频文件**；环境不支持 TTS 时降级为「显示单词」提示。选项与键盘操作（A–D / 1–4 / ↑↓←→ + Enter）与选择题完全一致。
- **英英选择 `eng_eng`（v0.5，可选）**：*建议考研及以上水平使用（需较强英文阅读理解能力）*。子模式 A「看单词选英文释义」/ 子模式 B「看英文释义猜单词」随机出现；选项均为英文，释义取自 **GCIDE**（`data/eng-defs.json`，14428 词，按需懒加载，不进 SW 预缓存）；词库缺少该词英文释义时自动回退到其它可用题型。
- **多义多选 `multi_sense`（v0.5，可选）**：*建议考研及以上水平使用*。一词多义，勾选该词的**全部释义**后点「提交」判分，**全对才算对**（漏选 / 多选 / 错选均算错，错题进优先池）；左上角有「多选」标识。释义优先取**卡组内中文释义**（`back` + `extraBacks`），缺失时回退 GCIDE 英文释义；正确项 2–4 个 + 1 个其它词干扰（正确项 4 个时共 5 个选项）。
- **填空题容错**：答案比对忽略**大小写**、**首尾 / 连续空格**，并容错**单复数与常见屈折**（`book`/`books`、`study`/`studies`、`run`/`runs`/`running` 均判对）；每题最多 3 次机会，输入框内 `Enter` 或点「提交」作答，用尽机会后展示完整信息卡。
- **填空 🔊 发音提示**：输入框右侧紧邻一个 **🔊 按钮**（32×32 圆形，触屏 ≥ 44px），点一下用浏览器 TTS 朗读**当前目标词**，**播放中再点即停止**（按钮变红 + 脉动动画），播放结束 / 出错后自动复原；切题或换词时先 `cancel()` 旧词，**同一时间只播放一个词**。语言自动判定（**英文 `en-US` / 中文 `zh-CN`**），语速 **0.8**。环境不支持 `speechSynthesis` 时降级为**音标 chip**：优先读卡片 `phonetic` 字段，无该数据则显示单词本身。
- **填空首字母提示**：可随时点「💡 首字母提示」按钮（**不消耗作答机会**、并保留已输入内容），答错时也会自动提示；每次**多揭示一个字母 + 词长**（如 `b•••••（共 6 个字母）`），最多揭示到「词长 − 1」，始终不给出完整答案，答对即消失。困难词在填空题中同样**前置并额外多出一题**。
- **答错（机会用尽）时**：除标出正确选项外，另展示完整信息卡 `front ＋ back ＋ example`（含例句翻译），便于即时回顾。
- **键盘作答（桌面端）**：按 **`A`–`D`** 或 **`1`–`4`** 直接选择选项；也可用 **`↑`/`↓`/`←`/`→` 移动高亮 + `Enter` / `空格` 确认**。作答后展示对 / 错反馈时，再按 **`Enter` / `空格` 可立即跳到下一题**（无需等待自动跳题）。选项左侧 `opt-key` 即为键位提示；已作答或已选错的选项不会再响应按键。

## 数据来源

- 英文释义（英英选择 / 多义多选）来自 **GCIDE**（GNU Collaborative International Dictionary of English），由 `scripts/build-engdefs.mjs` 生成 `data/eng-defs.json`（仓库内已提供；`gcide-0.51/` 源语料约 60MB、属本地数据不入库，需要重建时自行下载后放到该目录）；
- 词频表 `data/frequency.json` 由 COCA 2 万高频词表生成，用于难度判定；
- 在线查词使用 [Free Dictionary API](https://dictionaryapi.dev/) 与 [Jisho](https://jisho.org/api)；
- 导出 Anki 卡包所用的 SQLite 由内置的 [sql.js](https://github.com/sql-js/sql.js)（MIT）生成，已随仓库内置于 `vendor/sql.js/`。

本项目仅供学习用途。觉得有帮助的话，欢迎前往 [GitHub 项目主页](https://github.com/zhangziluo/MyCard) 点亮 Star ⭐
