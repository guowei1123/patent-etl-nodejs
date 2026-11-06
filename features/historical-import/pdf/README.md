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

