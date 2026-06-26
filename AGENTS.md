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

## UI 设计规范

### 产品气质

- 这是一个面向专利数据同步、检索和运维的工作台，不做营销式首页、夸张 Hero、装饰性渐变或大面积插画。
- 视觉目标是“安静、密集、可信、可扫描”：优先信息层级、状态判断、批次进度、表格效率和长文本可读性。
- 界面语言保持中文、短句、动作明确。按钮文案使用具体动词，如“新建批次”“开始同步”“重置”，不要使用“提交”“继续”这类含义模糊的词。

### 技术边界

- 不引入新的 UI 库。优先使用仓库已有 `@/components/ui/*` shadcn/ui 源码组件和已有业务组件。
- 当前 shadcn 配置来自 `components.json`：`style` 为 `new-york`，`rsc` 为 `true`，组件别名为 `@/components/ui`，工具函数别名为 `@/lib/utils`，图标库为 `lucide-react`。
- 修改或新增 shadcn 组件前，先检查 `components/ui` 是否已有对应组件；只在确实缺组件时再用 `pnpm shadcn ...`，并避免覆盖本地改动。
- 本项目不要直接运行裸 `pnpm dlx shadcn@latest ...`；使用 `pnpm shadcn ...` 脚本。`pnpm-workspace.yaml` 关闭了 pnpm 运行脚本前的依赖状态检查，脚本会为 shadcn CLI 注入兼容的 `zod@3.25.76`，同时保留业务依赖中的 `zod@4.4.3`。
- Client Component 中使用状态、事件、浏览器 API 时保留 `"use client"`；App Router、Route Handler 仍遵守上方 Next.js 16 约束。

### Tailwind 与设计 Token

- Tailwind 使用 v4 CSS-first 方式，主题 token 集中在 `app/globals.css` 的 `:root`、`.dark` 和 `@theme inline` 中维护，不新增独立 Tailwind 配置文件。
- 颜色必须优先使用语义 token：`bg-background`、`text-foreground`、`bg-card`、`text-muted-foreground`、`border-border`、`bg-primary`、`text-destructive`、`bg-success`、`bg-warning`、`bg-info` 等。
- 不在业务组件里使用裸色值或临时色阶，如 `bg-blue-500`、`text-green-600`。如果需要新增状态色，先在 `app/globals.css` 定义语义 CSS 变量，再通过 `@theme inline` 暴露。
- 暗色模式通过 CSS 变量自动适配，避免手写 `dark:bg-*`、`dark:text-*` 的颜色分支。只有布局、透明度或非颜色差异确有必要时才使用 `dark:`。
- 间距使用 `gap-*`，不要新增 `space-x-*` / `space-y-*` 写法。等宽高元素使用 `size-*`；长文本使用 `truncate`、`line-clamp-*` 或 `break-words`。
- 条件 class 使用 `cn()`，不要在 `className` 中堆手写字符串拼接。若文件内已有临时 `cn`，新增代码应改用 `@/lib/utils` 的 `cn`。
- 卡片圆角保持克制，默认沿用 `--radius` 派生值；业务卡片和面板通常使用 `rounded-lg`，不要新增超大圆角、胶囊化容器或装饰性阴影。

### 布局与信息架构

- 主应用继续采用 `AppShell` + `Sidebar` + sticky `Header` 的工作台结构。新增主页面应复用 `Header` 呈现页面标题、说明、刷新和主要操作。
- 页面内容区域保持密集但有呼吸感：外层通常使用 `p-6`，区块间使用 `gap-4` 或 `gap-6`；不要把页面段落再包进多层嵌套卡片。
- 仪表盘、批次、专利数据等页面优先使用栅格、表格、列表和进度组件；只有重复条目、独立工具、弹窗内容适合使用 `Card`。
- 数据多的界面要优先可扫描：数字右对齐或使用 `tabular-nums`，状态用 `Badge`、语义色点和进度条辅助，但不要只靠颜色表达状态。
- 移动端优先保证可操作性：工具栏可以纵向堆叠，按钮宽度可占满；表格应考虑横向滚动、列裁剪或摘要视图，避免文本互相挤压。

### shadcn/ui 组件用法

- 按钮使用 `Button` 的内置 `variant` 和 `size`，不要用 `className` 重写颜色和字号。导航使用 `Link`/`asChild`，动作使用 `button`。
- 图标使用 `lucide-react`。按钮内图标使用 `data-icon="inline-start"` 或 `data-icon="inline-end"`，不要再写 `mr-2 h-4 w-4` 这类尺寸和间距 class；纯图标按钮必须有 `aria-label`。
- 表单新代码使用 `FieldGroup`、`Field`、`FieldLabel`、`FieldDescription`、`FieldSet`、`FieldLegend` 组织，不再新增裸 `div` + `Label` 的表单布局。
- 输入组合使用 `InputGroup`、`InputGroupInput`、`InputGroupAddon`；不要用绝对定位把按钮塞进 `Input`。
- 2 到 7 个互斥/切换选项使用 `ToggleGroup` 或合适的 `RadioGroup`，不要手写一组 `Button` 维护 active 状态。
- `SelectItem` 放在 `SelectGroup` 内；`DropdownMenuItem` 放在 `DropdownMenuGroup` 内；`CommandItem` 放在 `CommandGroup` 内。
- `Dialog`、`Sheet`、`Drawer` 必须有对应 Title；如果视觉上不显示，用 `sr-only`，不要省略。
- 空状态使用 `Empty`，加载占位使用 `Skeleton`，提示/警告使用 `Alert`，分隔线使用 `Separator`，状态标签使用 `Badge`，反馈消息使用 `sonner` 的 `toast()`。
- `Card` 使用完整结构：`CardHeader`、`CardTitle`、`CardDescription`、`CardContent`、`CardFooter` 按需组合，不把标题、说明和内容全部塞进 `CardContent`。
- 加载中的按钮使用 `Spinner` 或图标组件组合并设置 `disabled`，不要给 `Button` 发明 `isLoading` / `isPending` 之类非组件 API。

### 表格、筛选与批次状态

- 专利列表、批次列表这类高密度区域优先保留原生语义表格或 shadcn `Table`，表头清晰、分页明确、空状态和错误状态完整。
- 筛选、搜索、分页、标签页等会影响结果集的状态，应尽量同步到 URL query，便于刷新、分享和返回。
- 大列表超过 50 行且明显影响性能时，考虑虚拟列表或分页，不直接渲染大数组。
- 批次状态文案保持一致：待处理、下载中、已下载、处理中、已处理、导入中、已完成、失败。新增状态必须同时定义标签、图标、颜色语义和终态/运行态行为。
- 进度信息要同时显示文本和视觉进度，例如“已导入 1,200 / 5,000”和 `Progress`，避免只有百分比或只有颜色。

### 可访问性与交互

- 所有表单控件必须有可点击 label 或 `aria-label`；错误信息放在字段附近，并在提交失败时让用户能定位到第一个错误。
- 交互元素必须可键盘访问。不要给 `div` / `span` 添加点击事件来充当按钮或链接。
- 焦点态必须可见，使用 shadcn 默认 focus ring 或 `focus-visible:*`，不要使用没有替代方案的 `outline-none`。
- 异步反馈使用 toast、inline error 或状态区域；需要被读屏感知的动态更新应具备 `aria-live="polite"`。
- 动画只用于状态变化、加载、展开收起等功能性反馈；尊重 `prefers-reduced-motion`，避免 `transition-all`。
- 日期和数字用 `Intl.DateTimeFormat`、`Intl.NumberFormat` 或明确的本地化工具格式化，不手写难维护格式。中文界面中代码、批次号、专利号等标识可用 `translate="no"`。
- 长字段必须处理溢出：申请人、专利名、FTP 路径、错误信息、批次号等使用 `min-w-0`、`truncate`、`line-clamp-*` 或 `break-words`。

### 文案规则

- 标题说明当前页面或区块的工作对象；描述补充范围或状态，不写宣传语。
- 错误文案包含下一步，例如“数据库未连接，请前往设置页面完成配置”，不要只写“失败”。
- 加载文案使用省略号字符“…”；中文界面避免英文占位，除非是协议、字段名或代码标识。
- 空状态要给出下一步操作；例如无批次时提供“创建新批次”，无搜索结果时提供“重置筛选”。

### UI 改动验收

- 提交 UI 改动前至少运行相关静态检查或构建命令；常规优先级为 `pnpm lint`，必要时再运行 `pnpm test` 或 `pnpm build`。
- 手动检查浅色和深色模式、桌面和移动宽度、键盘 Tab 顺序、表单错误、空状态、加载状态、长文本和无数据场景。
- 检查是否违反关键反模式：新 UI 库、裸色值、无 label 输入框、无 `aria-label` 图标按钮、`div onClick` 导航、`transition-all`、无尺寸图片、无法截断的长文本。
