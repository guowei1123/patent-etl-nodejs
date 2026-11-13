# 历史专利 PDF 附图导入

所有命令均在项目根目录运行。本工具的代码、测试和说明集中在当前目录：

```text
features/historical-import/pdf/
  extract-patent-pdf.ts       # 提取命令入口
  extract-patent-pdf.py       # PDF / OCR 解析及附图页保存
  import-patent-pdf.ts        # 导入命令入口
  historical-pdf.ts          # 清单及图片校验
  historical-pdf-import.ts   # 专利匹配及入库事务
  pdf-requirements.txt       # Python 依赖
  __tests__/                # 自动化测试
  README.md                 # 使用说明
```

共用的 OSS/MinIO 客户端仍引用项目的 `lib/oss-client.ts`。运行环境位于 `.venv-pdf`，结果位于 `data/historical-pdf`。

本目录提供独立附图补录命令；综合导入页面和流程见上级 README。支持目录、单份 PDF、TAR/TAR.GZ/TGZ 和 ZIP（仅读取包中的 PDF，不展开嵌套压缩包）。保留完整说明书附图页，不自动切分单幅图，也不自动提取摘要附图。

## 安装

需要 Python 3.10+，推荐项目专用环境：

```powershell
python -m venv .venv-pdf
uv pip install --python .venv-pdf/Scripts/python.exe -r features/historical-import/pdf/pdf-requirements.txt
```

若系统 Python 无法创建带 pip 的环境，可使用 `python -m venv --without-pip .venv-pdf` 后用 uv 安装。非 Windows 环境使用 `.venv-pdf/bin/python`。可用 `PDF_PYTHON` 指定已有环境的 Python。

## 提取

扫描 PDF 必须启用 OCR；默认最多处理 10 份，`--limit 0` 表示全部。

```powershell
pnpm pdf:extract --source "F:\历史数据\PDF文件-发明申请（第二部分）" --batch PDF-20261012-001 --limit 10 --ocr
```

默认跳过名称中年份全部在 2023 年及以后的输入文件，并检查识别到的公布／公告日期。无法识别日期时不会猜测，应检查来源和结果。完整公开号含 A/B/C 种类码作为文件名，匹配首页与文件名冲突时拒绝处理。

输出：`data/historical-pdf/{批次}/{公开号}/{PDF哈希}/`，包含原始 PDF、`{公开号}_drawing_001.png` 等附图页和 `manifest.json`。PDF 哈希放在目录中，避免同号不同文档相互覆盖；文件名仍按专利号命名。

批次目录中 `report.jsonl` 持续追加结果。扫描件通过 OCR 识别页眉“说明书附图”；未识别到时标记 `needs_review`，不把正文整页误认为附图。人工确认后可以处理单份 PDF 或仅含该文件的压缩包：

```powershell
pnpm pdf:extract --source "单份文件.pdf" --batch PDF-20261012-001 --limit 1 --pages 8,9
```

`--pages` 是原 PDF 的物理页码，从 1 开始；仅用于人工确认的文件。默认 300 DPI，可用 `--dpi` 调整。单文件默认最多 100 MB、500 页。

## 预览和入库

先确保应用数据库已经初始化，`.env` 中数据库和 OSS/MinIO 配置可用。预览只读取数据库、校验图片，不上传或修改数据库：

```powershell
pnpm pdf:import --batch PDF-20261012-001 --input data/historical-pdf/PDF-20261012-001
```

确认 `preview-results.jsonl` 中的结果和图片，再执行：

```powershell
pnpm pdf:import --batch PDF-20261012-001 --input data/historical-pdf/PDF-20261012-001 --commit
```

入库使用已有 `cnipa.image_asset` 和 `cnipa.patent_image`，现有专利详情页可直接显示。新建 `cnipa.historical_pdf_batch`、`cnipa.historical_pdf_image` 记录批次及来源页码；历史批次暂未接入 FTP 批次页面，避免触发 FTP 重试／下载动作。

本节独立 `pdf:import` 命令属于旧版附图补录工具，必须找到唯一、种类码一致的已有专利记录，否则标记 `unmatched`。需要先导入附图再补基础信息时，请使用「历史数据导入」页面的附图阶段：主流程支持任意顺序创建和补齐记录。旧命令若发现同申请 B/C 已存在会跳过 A 图片，不删除既有申请记录或 FTP 图片。

对象路径：`patents/{批次}/{公开号}/{PDF哈希}/{公开号}_drawing_001.png`。同一专利、PDF 哈希、页码入库一次，重跑会跳过。数据库每份 PDF 单独事务；上传失败回滚该文档关联，其他文档继续。事务失败可能留下未引用的对象，重试使用相同对象路径。

已入库的页不自动替换；调整 DPI 或页码后须先核对已有来源关联再决定更新。原 PDF 保留在本地输出目录，附图上传对象存储。日志不输出真实凭据。

## 验证

```powershell
pnpm lint
pnpm test -- features/historical-import/pdf/__tests__
```

先用 `--limit 1` 检查真实附图页及 OCR 结果，再逐步扩大批次。未识别、匹配冲突、损坏文件都记录结果并返回非零退出码。

# 重名附图修复

工作台侧边栏提供“专利附图修复”页面：可按公开号下载一件并预览，也可设置数量持续下载而不显示图片。下载和更新分别执行，单件及批量更新前会显示确认。页面刷新或关闭不会停止任务；服务进程重启会中断任务，可再次启动并利用已有报告跳过已处理记录。

从 `outputs/repeated-image-audit/candidate-patents.jsonl` 读取按批次筛选出的候选公开号，使用 Google Patents 下载 PDF。候选只表示文件名重复，不等于已确认出错。请先安装本目录的 Python 依赖；`patent-downloader` 已列入 `pdf-requirements.txt`。

PowerShell 中按需为当前进程设置代理（端口按本机配置调整）：

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:7897'
$env:HTTP_PROXY='http://127.0.0.1:7897'
$env:PYTHONUTF8='1'
.\.venv-pdf\Scripts\python.exe features/historical-import/pdf/repair-download.py --limit 10 --delay 3 --ocr
```

默认每次最多处理 10 项；批量任务优先处理 B 授权版，其余版本随后处理，绝不将 A 版当成 B 版。`--publication CN222254999U` 可指定候选，`--retry-failed` 可重新尝试失败记录。程序仅使用 Google Patents 页面实际提供的 PDF 链接；没有链接时记录失败并跳过，不猜测下载地址，且在候选 Excel 的“PDF下载备注”列记录；网络错误或链接存在但无法下载不会标为无链接。关闭 Excel 后可运行 `.venv-pdf/Scripts/python.exe features/historical-import/pdf/repair-finalize.py --sync-notes`，按报告中每件专利最新结果补写备注。程序仅接受首页公告号与候选完全一致的 PDF，复用历史导入的图形区域提取逻辑，移除页眉页脚，并生成 `data/patent-image-repair/report.jsonl`。预览阶段保留 PDF；附图更新成功并完成 Excel 标记后，自动删除哈希匹配的 PDF，报告和提取图片仍保留。已准备成功的当前版本记录跳过；未指定公开号时失败记录也跳过，避免每次从头重复失败。`--ocr` 用于读取乱码文字层及扫描页；部分 PDF 无法识别时会记录失败。

预演并校验已准备数据（不更新数据库或对象存储）：

```powershell
node --env-file=.env --experimental-strip-types features/historical-import/pdf/repair-apply.ts --limit 10
```

对核对过的候选执行替换：

```powershell
node --env-file=.env --experimental-strip-types features/historical-import/pdf/repair-apply.ts --publication CN222254999U --limit 1 --apply
```

每个专利单独事务；写入前核验 PDF 和图片哈希、批次及公开号，且仅当所有当前说明书附图文件名均出现在该专利的重名候选中才替换。已有修复记录的专利会跳过，不占待更新数量。摘要图及正文内嵌图片不替换。旧图片记录保存在 `cnipa.pdf_image_repair_backup`；核验新图并检查旧图引用后，将无引用的原说明书附图备份到 `data/patent-image-repair/original-object-backups` 并删除原对象，仍被引用的对象保留。清理失败会提示，可使用 `--cleanup-only --publication 完整公开号 --apply` 单独重试清理，不会重新更新图片。上传成功但事务失败时可能留下未引用的新对象。多图页会尝试按图号拆分，无法可靠拆分时保留无页眉页脚的主体区域。下载缺失、PDF 页眉识别失败、混有非候选附图的专利需要另行核查，不会自动修复。Google 限流时应停止并降低请求速度，不应反复重试。

新修复的说明书附图存储在 `patents/{原批次}/{公开号数字}/FT_{序号}.jpg`，以 JPEG 格式编码，图号保存在数据库 `figure_label`。本地提取预览仍使用 PNG，更新时转换为 JPG，支持此前已提取但尚未更新的图片。目标对象与待替换旧图同名时，程序先核对引用并备份旧图，再删除旧图、写入及校验新图；发生失败时尝试恢复备份，进程中断后重新处理该专利也会先检查恢复记录。其他记录引用的对象或无法确认归属的同名对象不会被替换；以前已修复的图片不变。旧 `pdf-repair` 路径的现有图片可使用 `repair-migrate.ts` 预演，加 `--apply` 后迁移关联；迁移前会校验源图片或哈希一致的本地提取文件，写入后会再次校验。迁移不删除旧对象，需另行核查共享引用和回退需求。

当前修复提取版本会识别并移除图号文字，按图形及部件标号的边界裁去外围空白；图号仍保存在图片元数据中。OCR 无法识别图号时可能仍需人工检查，避免将残留图号或误识别当作正常结果。

JPG 保存时保持像素尺寸不变，自动搜索压缩质量，黑白图尝试简化接近白色的背景，并检查整体失真、深色线条及局部笔画损失，选择通过检查的较小结果；未达到 40,000 字节时在运行记录中提示。自动检查不能替代人工确认图号和细节。已经更新的图片不会重新压缩。

正文 `SMS` 候选可单独使用 `sms-preview.py --pdf PDF路径 --publication 完整公开号 --output 新目录` 预览。它保留说明书页中的小尺寸嵌入图片和重复出现的符号，按 PDF 内容流顺序生成 `SMS_序号.JPG` 和含页码、位置的清单；不修改数据库或对象存储。原始编号与 PDF 顺序不一定相同，必须核验正文引用后才能替换。扫描页、矢量公式、无可提取资源编号的内联图片需要另行核查。

界面的 SMS 更新需要逐条确认正文引用与候选图，预检会核对图片哈希、存储路径和共享引用并列出待删除对象。确认后按旧对象删除、新对象写入校验、数据库事务提交的顺序执行。按当前设置不备份旧对象；仅保留操作指纹和旧对象哈希用于异常重试，不能恢复旧图。中断后须保持原候选与核对结果，重新预检并重试；若数据库提交结果不确定，应先核对数据库，不能盲目重试。SMS 更新与说明书附图更新目前分别执行。

更新前复用项目的 SHA-256 和结构匹配算法，对比同一专利的摘要图与新提取的说明书附图。命中时说明书附图直接引用摘要图片资源，不上传重复对象，并记录匹配方式、分数和显示旋转角度；摘要图和说明书附图仍保留各自用途与图号。摘要图不可读或其内容哈希异常时停止该项更新，避免未经比较直接覆盖。

每次更新后，程序会先按当前数据库备份和图片关联核对已完成记录，在候选 Excel 的“修复状态”列标记“说明书附图已更新”，再删除这些专利哈希一致的本地 PDF。未下载、未更新或文件哈希不一致的 PDF 不会被删除；若 Excel 正在打开或标记失败，PDF 会保留。关闭工作簿后可重试更新命令，或仅整理已完成记录：

```powershell
node --env-file=.env --experimental-strip-types features/historical-import/pdf/repair-apply.ts --apply --finalize-only
```

