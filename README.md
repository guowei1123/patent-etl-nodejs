# 专利 ETL 工作台

本项目用于从 CNIPA FTP 批次数据中下载、处理、导入专利全文数据，并管理专利附图在 OSS 中的存储与读取。

## 本地运行

```bash
pnpm dev
```

默认访问地址：

```text
http://localhost:3000
```

登录账号密码从 `.env` 的 `AUTH_USERNAME` / `AUTH_PASSWORD` 读取。FTP、数据库和 OSS 配置也来自 `.env`，不要在代码、日志或文档中提交真实密钥。

## 同步流程

批次同步拆分为 3 个手动步骤：

```text
创建批次 -> 下载 -> 处理 -> 导入
```

- 下载：从 CNIPA FTP 下载外层分卷 ZIP 到 `data/<batch_code>/`
- 处理：解压外层包，校验内层 ZIP CRC，流式解析 XML，并将内层 ZIP 中引用到的 JPG/JPEG 附图上传到 OSS
- 导入：读取 `data/<batch_code>/parsed.json`，写入 `cnipa.patent`、结构化子表和 `cnipa.patent_image`

图片读取统一通过后端代理：

```text
GET /api/patent-images/{image_id}
```

前端不直接暴露 OSS key、bucket、密钥或签名 URL。

完整流程说明见 [docs/data-pipeline.md](docs/data-pipeline.md)。

## 常用验证

```bash
pnpm lint
pnpm test
pnpm build
```

`pnpm build` 使用 Turbopack，沙箱环境可能因内部 worker 绑定端口失败；如出现 `Operation not permitted (os error 1)`，需要在授权环境下重跑。

## 相关文档

- [数据处理流程与原始数据包说明](docs/data-pipeline.md)
- [数据库结构与 FTP 数据源清册](docs/database-and-ftp-inventory.md)
- [IPC/CPC 数据源说明](docs/ipc-cpc-data-sources.md)
