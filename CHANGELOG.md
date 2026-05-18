# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [未发布]

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
