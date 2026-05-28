# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [未发布]

## 0.6.1 - 2026-05-28

### 新增

- 批次编号自动生成：提取 `generateBatchCode` 到独立模块 `lib/batch-code.ts`，批次编号由数据类型 + FTP 文件夹路径自动推导，用户无需手动输入
- FTP 目录浏览缓存：`/api/ftp/browse` 接口支持服务端缓存（默认 3 天），减少重复 FTP 请求；支持 `?refresh=true` 强制刷新
- 批次创建去重：新增 `getBatchByFtpFolder` 查询，同一 FTP 文件夹不可重复创建批次；返回 409 状态码并附带已有批次信息
- FTP 浏览器刷新按钮与缓存时间展示

### 变更

- `new-batch-dialog` 批次编号字段改为只读自动展示，移除手动输入和"自动生成"按钮
- `lib/cache.ts` 新增 `getCacheEntry` / `bustCache` 方法，支持获取含过期时间的缓存条目和主动清除
- `/api/batches` 和 `/api/sync/start` 的 POST 接口不再要求 `batch_code` 参数，改为后端自动生成

## 0.6.0 - 2026-05-27

### 新增

- Docker 容器化部署：多阶段 Dockerfile（deps → build → standalone runner），输出 `output: 'standalone'` 精简镜像体积
- `.dockerignore` 排除无关文件（node_modules、.env、data、.git 等）
- GitHub Actions CI 工作流：手动触发构建并推送 Docker 镜像到 GHCR，自动清理旧版本保留最近 3 个
- `package.json` 声明 `packageManager` 字段，Dockerfile 通过 `corepack prepare` 锁定 pnpm 版本确保构建一致

## 0.5.6 - 2026-05-27

### 修复

- 批次详情页乐观状态增加 5 秒宽限期，防止启动竞态导致状态闪断；轮询根据 `is_running` 与宽限期联合判断是否清除乐观状态
- `patent_citation.kind` 从 `CHAR(1)` 迁移为 `TEXT`，兼容发明授权引用文献的多字符 kind（A1、B2 等）
- `patent_applicant` / `patent_assignee` 的字符串列自动检测并迁移为 `TEXT`，避免 `VARCHAR(n)` 截断
- XML 解析测试用例修正引用文献 kind 为 `A1`，并增加 kind 字段断言

### 变更

- 移除未使用的 placeholder 图片资源

## 0.5.5 - 2026-05-27

### 变更

- `insertPatents` 从逐条循环改为批量 INSERT，子表按更新行批量 DELETE 后统一写入，减少数据库往返次数
- 导入失败时自动二分重试，单条失败仅跳过该条而不回滚整批
- 导入完成后不再自动清理本地临时文件，改为在批次详情页手动确认清理
- 新增 `/api/sync/cleanup` 接口，支持对已完成批次的手动本地文件清理
- 批次详情页新增本地文件状态展示和清理按钮（含确认对话框）
- 校验按钮仅在本地文件存在时可点击

## 0.5.4 - 2026-05-27

### 修复

- `multiRowInsert` 超过参数上限时分批写入，不再静默丢弃多余行
- `IMPORT_CONCURRENCY` 环境变量增加最小值校验，避免 0 / 负数 / NaN 导致死循环
- 并发导入块失败时立即以 `AggregateError` 抛出，保留根因而非静默跳过

## 0.5.3 - 2026-05-26

### 变更

- 将 ETL 流程按下载、处理、导入 3 个环节拆分为独立模块，`lib/etl-pipeline.ts` 保留为对外门面
- 将导入续跑和去重测试移动到 `import-step` 对应测试文件
- 将 shadcn/ui 固定组件目录排除在 TypeScript 检查之外，保持与 lint/format 忽略规则一致

### 修复

- 导入前按 `(patent_number, kind)` 去重，并用唯一专利数更新导入总量，避免同批重复专利导致进度总量和入库数量不一致

## 0.5.2 - 2026-05-26

### 新增

- FTP 下载重试机制：可配置重试次数（`FTP_RETRY_ATTEMPTS`）和重试间隔（`FTP_RETRY_DELAY_MS`），下载失败自动重连重试
- 导入步骤断点续跑：导入前查询已入库专利，跳过已导入记录继续未完成批次，避免重复导入
- 下载步骤断点续跑：检测本地已有文件大小，区分 pending/partial/skipped 状态，支持从中断处继续下载
- `syncBatchRecord` 增量同步：根据数据库已导入数量智能判断批次状态，已完成导入的自动标记为 completed
- 导入进度实时显示：批次列表和详情页展示「已导入 N / M 条专利」进度信息
- 新增 `lib/__tests__/etl-pipeline.test.ts`，导入续跑过滤逻辑单元测试

### 变更

- 详情页轮询逻辑重构：用 `optimisticActiveStep` + SWR 函数式 `refreshInterval` 替代 `useRef` 状态同步，消除 React 渲染闭环问题
- 列表页和仪表盘 SWR `refreshInterval` 改为基于最新数据的函数式判断，不再依赖 `useRef`
- FTP 连接池 `downloadFiles` 内部重构：重试循环封装在单文件 worker 内，失败时关闭连接并重连
- `insertPatents` UPSERT 冲突时同时更新 `batch_id` 和 `source_file` 字段

## 0.5.1 - 2026-05-20

### 修复

- 修复列表页 fetcher 不检查 HTTP 状态码导致 SWR 永远不会进入 error 状态的问题，API 返回 500 时表格现在会正确显示"数据加载失败"而非"暂无数据"
- 修复详情页将服务端错误误判为"专利不存在"的问题，现在区分 404（专利不存在）和其他错误（数据加载失败 + 错误信息）
- 删除 `getPatents` 死代码，消除 `/api/patents` 从完整 `Patent` 切换到 `PatentListItem` 后的潜在隐患

## 0.5.0 - 2026-05-20

### 新增

- 新的 `cnipa.patent` 结构化数据模型：支持主表加申请人、发明人、代理人、IPC、引用文献、审查员、受让人、权利要求等子表聚合
- 专利列表与详情接口支持新的查询维度与聚合返回结构，包括 `kind`、`app_type`、`batch_id`、公开日期范围和申请人省份筛选
- 仪表盘新增申请人、发明人、引用文献统计指标
- 补充更完整的 XML 解析测试与文件处理测试，覆盖发明专利、实用新型以及旧格式兼容节点

### 变更

- `parsePatentXml` 扩展根属性、结构化说明书、结构化申请人/代理人、审查员、引用文献、受让人、摘要附图和结构化权利要求提取
- 专利导入流程改为写入 `cnipa` schema，并在查询时聚合子表数据返回给前端
- 专利列表页、详情页和 `/api/patents`、`/api/patents/[id]` 接口适配新的字段命名和 UUID 主键
- `initializeDatabase` 补齐 `cnipa` 子表初始化逻辑，便于新环境启动
- 处理步骤写入 `parsed.json` 前去除冗余说明书纯文本，降低大批量解析时的内存与文件体积压力
- 文档整理到 `docs/` 目录，并更新数据库和数据流水线说明

### 修复

- 修复专利导入时单条失败可能导致整批事务回滚但导入计数仍累加的问题
- 修复 `/api/patents/[id]` 对非法 UUID 请求返回数据库错误的问题
- 修复旧格式 XML 在解析后能保留扁平代理信息、但无法生成可入库结构化代理机构数据的问题

## 0.4.0 - 2025-05-18

### 新增

- 分卷 ZIP 自动检测与合并：支持 `.z01/.z02/.../zip` 分卷格式，自动合并后解压
- 新 XML 格式解析：支持 `PatentDocumentAndRelated` PascalCase 节点结构（BibliographicData、PublicationReference、Claims 等）
- `withPreparedArchiveFiles`：统一的归档文件准备流程（扫描→分卷合并→过滤）
- `openZipForVerify`：独立的 ZIP 完整性校验接口
- 新增 `lib/__tests__/file-processor.test.ts`，file-processor 单元测试
- 新增 `lib/__tests__/xml-parser.test.ts`，xml-parser 单元测试
- `vitest` 测试框架依赖

### 变更

- `extractZip` 改用 `decodeStrings: false` 模式，手动解码文件名以绕过 yauzl 对绝对路径的校验
- `parsePatentXml` 增加 `removeNSPrefix` 和扩展的 `isArray` 配置，同时兼容新旧两种 XML 命名风格
- 处理步骤在解压前先校验已有内层 ZIP 的结构完整性，损坏时自动重新解压
- 批次详情页 UI 调整
- 更新数据流水线和数据库文档

## 0.3.0 - 2025-05-13

### 新增

- 分步 ETL 流水线：将原一体化流程拆分为下载→校验→处理→导入四个独立步骤，支持单步执行和重试
- 新增 `app/api/sync/step` API，支持按步骤触发流水线
- 新增 `app/api/sync/verify` API，下载完整性校验（多卷 ZIP、CRC32）
- 新增 `app/api/sync/fix` API，同步修复批次状态
- 新增 `lib/integrity.ts`，CRC32 计算与 ZIP 结构完整性检测
- 新增 `lib/format.ts`，通用格式化工具函数
- 新增 `components/batches/step-progress-indicator.tsx`，分步进度指示器组件
- 新增 `components/batches/step-config.ts`，步骤配置常量
- 新增 `doc/data-pipeline.md`，数据流水线设计文档
- FTP 连接池（`FtpConnectionPool`）：支持并发下载、断点续传、进度回调
- 批次详情页大幅增强：实时下载进度、文件列表状态、分步操作按钮

### 变更

- 批次状态流从 `downloading→extracting→parsing→importing` 简化为 `downloading→processing→importing`
- `/api/sync/start` 改为仅创建批次记录，不再自动启动流水线
- `/api/sync/status` 重构进度计算逻辑，适配新状态流
- `/api/batches` 新增 `active` 查询参数，支持筛选活跃批次
- `lib/ftp-client.ts` 重写为连接池模式，支持多连接并发
- `lib/etl-pipeline.ts` 重构为分步执行架构
- `types/index.ts` 新增下载进度和文件状态类型定义

## 0.2.0 - 2025-05-11

### 新增

- 深色模式 / 主题切换支持（AppShell、ThemeToggle 组件）
- 批次详情页改用 `batch_code` 路由，替代数字 `id`
- 新增 `database-and-ftp-inventory.md` 文档

### 变更

- 重构布局：新增 AppShell 包装组件，更新侧边栏和顶部导航
- 重写设置页面和首页仪表盘
- 改进批次列表和新建批次对话框组件
- 更新专利详情页和专利列表页
- 重构 `lib/db.ts` 和 `lib/etl-pipeline.ts`，优化代码结构
- 全局样式和主题更新

## 0.1.0 - 2025-05-09

### 新增

- 初始专利 ETL 仪表盘和同步工作流
