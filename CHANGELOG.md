# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [未发布]

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
