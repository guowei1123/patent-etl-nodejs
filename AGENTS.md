<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

开发注意事项：

1. 本地访问的用户名和密码就在 .env 文件中。

## 项目运行与验证

- 包管理器使用 `pnpm`。
- 常用验证命令：
  - `pnpm lint`
  - `pnpm test`
  - `pnpm build`
- `pnpm build` 使用 Turbopack，沙箱环境可能因内部 worker 绑定端口失败；如出现 `Operation not permitted (os error 1)`，需要在授权环境下重跑。
- `pnpm exec tsc --noEmit` 当前可能受既有 UI 组件类型问题影响，不作为改动验收的唯一依据。

## 本地访问

- 默认开发服务地址是 `http://localhost:3000`。
- 登录账号密码从 `.env` 的 `AUTH_USERNAME` / `AUTH_PASSWORD` 读取。

## 数据同步注意事项

- FTP/数据库/OSS 配置均来自 `.env`，不要在代码或回复中泄露真实密钥。
- FTP 下载支持断点续传，相关调参项：
  - `FTP_TIMEOUT`
  - `FTP_CONCURRENCY`
  - `FTP_RETRY_ATTEMPTS`
  - `FTP_RETRY_DELAY_MS`
- 大批次下载体积可能约 5GB，除非用户明确要求，不要随意启动完整下载任务。

## 开发约束

- 修改 Next.js App Router、Route Handler、Client Component 相关代码前，先查阅 `node_modules/next/dist/docs/` 中对应文档。
- 这个项目使用 Next.js 16，Route Handler 的动态 `params` 是 Promise 形态，保持现有写法。
- 不要格式化或重写无关文件；`.env` 只用于本地读取配置，不要提交真实凭据。
