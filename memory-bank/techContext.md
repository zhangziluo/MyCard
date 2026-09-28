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

# 全量校验（25 个 test-*.mjs + smoke-dom + verify-assets = 27 个脚本，2604 条断言）
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

# 数据准备（可选，需本地具备 gcide-0.51/）
node scripts/split-gcide.mjs
node scripts/build-engdefs.mjs
# 例句生成（--data 必填）
LLM_API_KEY=sk-xxx node scripts/gen-examples-llm.mjs --data data/words.json --sample 6
node scripts/gen-examples.mjs --data data/words.json --sample 8
```

## 版本号约定
- **两处必须同步递增**：`sw.js` 的 `VERSION`（缓存键）与 `js/app.js` 的 `APP_VERSION`（顶栏显示）
- 当前：`APP v0.5.9` / `SW v1.9.0`

## 测试工程要点（写新测试时照抄）
- 每个测试是独立 `.mjs`，自建浏览器桩（localStorage/document/window/location/requestAnimationFrame/HashChangeEvent）
- IndexedDB 用 `scripts/fake-idb.mjs` 的 `installFakeIndexedDB()`（含 `dumpStore()` 断言）
- 断言统一 `ok(cond, msg, extra)` + 末尾 `process.exit(fail ? 1 : 0)`
- DOM 冒烟用 `scripts/smoke-dom.mjs` 的轻量 fakeEl + `fire(action, dataset)` 走真实事件委托
- 资源一致性用 `scripts/verify-assets.mjs`（读源码字符串 + 解析 data/*.json）
- **xlsx 测试**：用 `export.js` 的 `zipStore`（STORED）+ Node `zlib.deflateRawSync` 手工拼**真实 ZIP**（`scripts/test-xlsx.mjs`），既覆盖 STORED 也覆盖 DEFLATE 解压路径；多工作表用例额外拼 `xl/workbook.xml` + `xl/_rels/workbook.xml.rels`，公式/合并用例直接拼 `<f>`（含 `<v>` 缓存）与 `<mergeCells>`

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
