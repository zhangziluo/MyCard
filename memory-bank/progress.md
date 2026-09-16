# Progress — 完成度与遗留

> 更新时间：2026-09-16 ｜ APP `v0.4.12` / SW `v1.7.13` ｜ **1355 条校验全绿**

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

## 测试资产（20 个 test-*.mjs + `smoke-dom` + `verify-assets` = 22 个脚本 / 1355 条断言）
| 分类 | 脚本 |
| --- | --- |
| 核心纯函数 | `test-core`(43) `test-difficulty`(39) `test-arrange`(22) `test-pagination`(25) `test-resplit-levels`(26) |
| 学习与题型 | `test-confusables`(82) `test-hardwords`(26) `test-level-retry`(73) `test-fill`(85) `test-listen`(21) `test-deck-test`(81) `test-eng-eng`(34) `test-multi-sense`(39) `test-review-complete`(11) `test-review-interaction`(12) |
| 存储与主题 | `test-idb-store`(42) `test-theme`(60) |
| 新功能 | `test-add-words`(82) `test-import-file`(200) `test-export`(65) |
| DOM / 资源 | `smoke-dom`(124) `verify-assets`(163) |

## 已知问题 / 技术债
- **apkg 为旧版结构**（无新版 `meta` protobuf）：Anki 2.1.x 可导入；更严格的新版若报错需补 `meta`
- **导出不含复习进度**：txt/apkg 只导内容，学习状态（repetitions/interval/due）不随之迁移
- **大卡组性能**：万级卡片时首页关卡统计与整卡组测试抽题存在可优化空间（未实测到卡顿，仅静态分析）
- **浅色对比度**：固定色 `--tag-tx`/`--soft-danger-tx` 不随 accent 变化（见 activeContext 待决问题）
- **本地备份分支** `backup-before-rewrite` 仍指向重写前历史（含 56MB gcide），确认无误后可 `git branch -D` + `git gc` 回收

## 明确的非目标（不做）
云同步/账号、社交排行、服务端、构建工具、TypeScript、前端框架、ORM（Dexie）
