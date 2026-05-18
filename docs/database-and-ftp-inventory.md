# 数据库结构与 FTP 数据源清册

> 记录日期：2026-05-11

## 一、PostgreSQL 数据库

### 连接信息

| 项目   | 值                                           |
| ------ | -------------------------------------------- |
| 主机   | `pgm-wz9r894win313slqpo.pg.rds.aliyuncs.com` |
| 端口   | `5432`                                       |
| 数据库 | `patent-dev`                                 |
| 用户   | `patent`                                     |

### 当前状态

三张业务表均已初始化完毕（通过 `initializeDatabase()` 创建）。

### 表结构

#### sync_batches（同步批次）

| 列名             | 类型         | 约束                      | 说明                                                                                                         |
| ---------------- | ------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| id               | SERIAL       | PRIMARY KEY               |                                                                                                              |
| batch_code       | VARCHAR(50)  | UNIQUE NOT NULL           | 批次编号，如 `2024-W01-INV`                                                                                  |
| data_type        | VARCHAR(20)  | NOT NULL                  | `invention` / `utility_model`                                                                                |
| ftp_folder       | VARCHAR(500) |                           | FTP 源文件夹路径                                                                                             |
| status           | VARCHAR(20)  | DEFAULT 'pending'         | `pending` → `downloading` → `downloaded` → `processing` → `processed` → `importing` → `completed` / `failed` |
| total_files      | INTEGER      | DEFAULT 0                 | 下载的文件数                                                                                                 |
| processed_files  | INTEGER      | DEFAULT 0                 | 已处理的文件数                                                                                               |
| total_patents    | INTEGER      | DEFAULT 0                 | 解析出的专利 XML 数                                                                                          |
| imported_patents | INTEGER      | DEFAULT 0                 | 导入数据库的专利数                                                                                           |
| error_message    | TEXT         |                           | 失败时的错误信息                                                                                             |
| started_at       | TIMESTAMP    |                           | 任务开始时间                                                                                                 |
| completed_at     | TIMESTAMP    |                           | 任务完成时间                                                                                                 |
| created_at       | TIMESTAMP    | DEFAULT CURRENT_TIMESTAMP |                                                                                                              |

#### patents（专利数据）

| 列名               | 类型        | 约束                                    | 说明                          |
| ------------------ | ----------- | --------------------------------------- | ----------------------------- |
| id                 | SERIAL      | PRIMARY KEY                             |                               |
| batch_id           | INTEGER     | FK → sync_batches(id) ON DELETE CASCADE | 所属批次                      |
| patent_number      | VARCHAR(50) | UNIQUE NOT NULL                         | 专利号                        |
| patent_type        | VARCHAR(20) | NOT NULL                                | `invention` / `utility_model` |
| title              | TEXT        | NOT NULL                                | 专利标题                      |
| abstract           | TEXT        |                                         | 摘要                          |
| claims             | TEXT        |                                         | 权利要求                      |
| applicant          | TEXT        |                                         | 申请人                        |
| inventor           | TEXT        |                                         | 发明人                        |
| application_number | VARCHAR(50) |                                         | 申请号                        |
| application_date   | DATE        |                                         | 申请日期                      |
| publication_number | VARCHAR(50) |                                         | 公开号                        |
| publication_date   | DATE        |                                         | 公开日期                      |
| grant_number       | VARCHAR(50) |                                         | 授权号                        |
| grant_date         | DATE        |                                         | 授权日期                      |
| ipc_codes          | TEXT[]      |                                         | IPC 分类号数组                |
| agency             | TEXT        |                                         | 代理机构                      |
| agent              | TEXT        |                                         | 代理人                        |
| priority_info      | JSONB       |                                         | 优先权信息                    |
| raw_xml            | TEXT        |                                         | 原始 XML                      |
| created_at         | TIMESTAMP   | DEFAULT CURRENT_TIMESTAMP               |                               |
| updated_at         | TIMESTAMP   | DEFAULT CURRENT_TIMESTAMP               |                               |

索引：`patent_type`、`grant_date`、`batch_id`

#### sync_logs（同步日志）

| 列名       | 类型        | 约束                                    | 说明                      |
| ---------- | ----------- | --------------------------------------- | ------------------------- |
| id         | SERIAL      | PRIMARY KEY                             |                           |
| batch_id   | INTEGER     | FK → sync_batches(id) ON DELETE CASCADE | 所属批次                  |
| level      | VARCHAR(10) |                                         | `info` / `warn` / `error` |
| message    | TEXT        |                                         | 日志内容                  |
| details    | JSONB       |                                         | 附加详情                  |
| created_at | TIMESTAMP   | DEFAULT CURRENT_TIMESTAMP               |                           |

索引：`batch_id`

### 其他表

| 表名              | 说明                         |
| ----------------- | ---------------------------- |
| `jieba_user_dict` | 不属于本项目，为其他工具所建 |

---

## 二、FTP 数据源

### 连接信息

| 项目     | 值                        |
| -------- | ------------------------- |
| 主机     | `ftp2.ipdps.cnipa.gov.cn` |
| 端口     | `21`                      |
| 用户     | `zexd`                    |
| 连接测试 | 通过                      |

### 数据路径

| 路径                                                                  | 数据类型     | 子目录数 |
| --------------------------------------------------------------------- | ------------ | -------- |
| `/CN/CN-PA-TXTS-10-B_中国发明专利授权公告标准化全文文本数据/data`     | 发明授权     | **272**  |
| `/CN/CN-PA-TXTS-20-U_中国实用新型专利授权公告标准化全文文本数据/data` | 实用新型授权 | **269**  |

**合计约 541 个批次待同步。**

### 目录结构

```
/CN/
├── CN-PA-TXTS-10-B_中国发明专利授权公告标准化全文文本数据/
│   └── data/
│       ├── 20231003/       # 每周一批，命名格式 YYYYMMDD
│       ├── 20231010/
│       ├── 20231013/
│       ├── ...
│       ├── 20260508/
│       ├── 生物序列2023年/   # 特殊目录（非专利 XML）
│       ├── 生物序列2024年/
│       └── 生物序列2025年/
│
└── CN-PA-TXTS-20-U_中国实用新型专利授权公告标准化全文文本数据/
    └── data/
        ├── 20231003/
        ├── 20231010/
        ├── ...
        ├── 20260505/
        ├── 20260505rawdata/   # 原始数据变体
        └── 20260508rawdata/
```

### 单批次目录内容

以 `20231003`（发明）为例：

| 文件名         | 大小    | 说明        |
| -------------- | ------- | ----------- |
| `20231003.zip` | 780 MB  | 主 zip 文件 |
| `20231003.z01` | 1.07 GB | 分包 1      |
| `20231003.z02` | 1.07 GB | 分包 2      |
| `20231003.z03` | 1.07 GB | 分包 3      |
| `20231003.z04` | 1.07 GB | 分包 4      |

> 每个批次约 **5 GB**，解压后为大量 XML 专利文件。

---

## 三、已发现的问题

### 1. 分包压缩文件下载过滤遗漏（P0）— 已修复

下载过滤器已补充 `.z01`~`.z99` 的匹配（`lib/etl-pipeline.ts:187-201`）。分卷 ZIP 解压也已支持：`lib/file-processor.ts` 中的 `withPreparedArchiveFiles` 会在解压前将分卷拼接为单文件 ZIP。

### 2. XML 解析器未处理 CNIPA 命名空间（P0）— 已修复

CNIPA 专利 XML 使用带命名空间的元素名（`business:PatentDocumentAndRelated`、`business:BibliographicData`、`base:DocNumber` 等），但 `lib/xml-parser.ts` 仅匹配非命名空间名称（`cn-patent-document`、`bibliographic-data` 等），导致所有 XML 文件解析返回 `null`，报错"未解析到任何专利数据"。修复方案：在 XMLParser 配置中启用 `removeNSPrefix: true` 自动剥离命名空间前缀，并将所有字段提取路径更新为 CNIPA 实际使用的 PascalCase 元素名。同时增强了 `getNestedValue` 以支持数组穿透（PublicationReference、ApplicantDetails 等为数组类型）。

### 3. 缺少批量扫描和导入能力（P1）

目前 `POST /api/sync/start` 只支持单批次手动传入 `ftp_folder`。面对 541 个批次，需要增加：

- 自动扫描 FTP 子目录并批量创建 batch 记录
- 支持按数据类型、日期范围筛选
- 排除非专利数据目录（如 `生物序列*`、`*rawdata`）

### 4. `CNIPA_FTP_DATA_PATHS` 环境变量未充分利用

`.env` 中定义了：

```
CNIPA_FTP_DATA_PATHS=/CN/.../data,/CN/.../data
```

但代码中未读取此配置进行目录遍历和批量导入。

### 5. 特殊目录需要排查

- `生物序列2023年` / `生物序列2024年` / `生物序列2025年`：确认是否包含 XML 专利数据
- `*rawdata` 目录：确认内容格式是否与标准批次相同

---

## 四、建议实施顺序

1. ~~**修复分包过滤器** — 补充 `.z01` ~ `.z99` 的匹配~~ ✅ 已完成
2. ~~**修复 XML 命名空间解析** — 适配 CNIPA 带命名空间的 XML 元素~~ ✅ 已完成
3. **手动运行 1 个批次** — 验证下载 → 解压 → 解析 → 入库全流程（解析问题已修复，待端到端验证）
4. **实现批量扫描和同步** — 自动遍历子目录，批量创建等待队列
5. **持续同步** — 每周新数据到达后自动识别并导入
