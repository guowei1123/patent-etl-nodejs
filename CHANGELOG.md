# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [未发布]

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
