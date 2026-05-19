# 数据库结构与 FTP 数据源清册

> 记录日期：2026-05-11 | 更新日期：2026-05-19

## 一、PostgreSQL 数据库

### 连接信息

| 项目   | 值                                           |
| ------ | -------------------------------------------- |
| 主机   | `pgm-wz9r894win313slqpo.pg.rds.aliyuncs.com` |
| 端口   | `5432`                                       |
| 数据库 | `patent-dev`                                 |
| 用户   | `patent`                                     |

### 当前状态

数据库中存在 **两套 schema**，分别由不同系统管理。

---

### Schema A：`public` — 本项目 Next.js 应用管理

通过 `lib/db.ts` 的 `initializeDatabase()` 创建和维护。

#### 表结构

##### sync_batches（同步批次）

| 列名             | 类型         | 约束                      | 说明                                                                                                         |
| ---------------- | ------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| batch_code       | VARCHAR(50)  | PRIMARY KEY               | 批次编号，如 `CN-PA-TXTS-20-U-20231003`                                                                      |
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

**行数**：2

##### patents（专利数据 — 宽表）

| 列名               | 类型        | 约束                                  | 说明                          |
| ------------------ | ----------- | ------------------------------------- | ----------------------------- |
| id                 | SERIAL      | PRIMARY KEY                           |                               |
| batch_code         | VARCHAR(50) | FK → sync_batches(batch_code) CASCADE | 所属批次                      |
| patent_number      | VARCHAR(50) | UNIQUE NOT NULL                       | 专利号                        |
| patent_type        | VARCHAR(20) | NOT NULL                              | `invention` / `utility_model` |
| title              | TEXT        | NOT NULL                              | 专利标题                      |
| abstract           | TEXT        |                                       | 摘要                          |
| claims             | TEXT        |                                       | 权利要求（纯文本拼接）        |
| applicant          | TEXT        |                                       | 申请人（`;` 拼接）            |
| inventor           | TEXT        |                                       | 发明人（`;` 拼接）            |
| application_number | VARCHAR(50) |                                       | 申请号                        |
| application_date   | DATE        |                                       | 申请日期                      |
| publication_number | VARCHAR(50) |                                       | 公开号                        |
| publication_date   | DATE        |                                       | 公开日期                      |
| grant_number       | VARCHAR(50) |                                       | 授权号                        |
| grant_date         | DATE        |                                       | 授权日期                      |
| ipc_codes          | TEXT[]      |                                       | IPC 分类号数组                |
| agency             | TEXT        |                                       | 代理机构（`;` 拼接）          |
| agent              | TEXT        |                                       | 代理人（`;` 拼接）            |
| priority_info      | JSONB       |                                       | 优先权信息                    |
| raw_xml            | TEXT        |                                       | 原始 XML                      |
| created_at         | TIMESTAMP   | DEFAULT CURRENT_TIMESTAMP             |                               |
| updated_at         | TIMESTAMP   | DEFAULT CURRENT_TIMESTAMP             |                               |

索引：`patent_type`、`grant_date`、`batch_code`、`patent_number`(unique)

**行数**：0

##### sync_logs（同步日志）

| 列名       | 类型        | 约束                                  | 说明                      |
| ---------- | ----------- | ------------------------------------- | ------------------------- |
| id         | SERIAL      | PRIMARY KEY                           |                           |
| batch_code | VARCHAR(50) | FK → sync_batches(batch_code) CASCADE | 所属批次                  |
| level      | VARCHAR(10) |                                       | `info` / `warn` / `error` |
| message    | TEXT        |                                       | 日志内容                  |
| details    | JSONB       |                                       | 附加详情                  |
| created_at | TIMESTAMP   | DEFAULT CURRENT_TIMESTAMP             |                           |

索引：`batch_code`

**行数**：75

##### 其他表

| 表名              | 说明                         |
| ----------------- | ---------------------------- |
| `jieba_user_dict` | 不属于本项目，为其他工具所建 |

---

### Schema B：`cnipa` — 外部系统管理（已对齐解析器字段）

本项目代码中 **不包含** cnipa schema 的任何创建或写入逻辑。以下是实际查库获取的结构。

> 2026-05-20 已 ALTER 对齐实际 XML 字段：新增 grant_number/grant_date、patent_claim 表、county/city 等字段。

##### patent（专利主表）

| 列名               | 类型         | 约束                      | 说明                                                                                        |
| ------------------ | ------------ | ------------------------- | ------------------------------------------------------------------------------------------- |
| id                 | UUID         | PK                        | `gen_random_uuid()`                                                                         |
| doc_number         | VARCHAR(50)  | NOT NULL                  | 公开/授权号                                                                                 |
| kind               | CHAR(1)      | NOT NULL                  | 类型码：`B`=发明, `U`=实用新型                                                              |
| pub_country        | CHAR(2)      | DEFAULT 'CN'              | 公开国别                                                                                    |
| pub_date           | DATE         |                           | 公开日期                                                                                    |
| app_number         | VARCHAR(50)  |                           | 申请号                                                                                      |
| app_date           | DATE         |                           | 申请日期                                                                                    |
| app_country        | CHAR(2)      | DEFAULT 'CN'              | 申请国别                                                                                    |
| app_type           | VARCHAR(2)   |                           | 申请类型码：`10`=发明, `20`=实用新型                                                        |
| app_type_label     | VARCHAR(20)  |                           | 类型标签                                                                                    |
| title              | TEXT         | NOT NULL                  | 标题                                                                                        |
| kind_label         | VARCHAR(20)  |                           | 类型标签                                                                                    |
| abstract           | TEXT         |                           | 摘要                                                                                        |
| description        | JSONB        |                           | 说明书（结构化：technical_field/background_art/disclosure/drawings_description/embodiment） |
| claims             | JSONB        |                           | 权利要求（JSONB 概览，详见 patent_claim）                                                   |
| status             | VARCHAR(5)   |                           | 文档状态码（XML `@_status`，如 `C`）                                                        |
| status_label       | VARCHAR(10)  |                           | 状态标签                                                                                    |
| abstract_fig_key   | TEXT         |                           | 摘要附图文件名                                                                              |
| drawings           | JSONB        |                           | 附图元数据                                                                                  |
| xml_oss_key        | TEXT         |                           | 原始 XML 的 OSS 存储路径                                                                    |
| batch_id           | VARCHAR(100) |                           | 所属同步批次                                                                                |
| source_file        | VARCHAR(500) |                           | 来源文件名                                                                                  |
| grant_number       | VARCHAR(50)  |                           | 授权号                                                                                      |
| grant_date         | DATE         |                           | 授权日期                                                                                    |
| priority_info      | JSONB        |                           | 优先权信息（结构化）                                                                        |
| raw_xml            | TEXT         |                           | 原始 XML（与 xml_oss_key 互补）                                                             |
| created_at         | TIMESTAMP    | DEFAULT CURRENT_TIMESTAMP |                                                                                             |
| updated_at         | TIMESTAMP    | DEFAULT CURRENT_TIMESTAMP |                                                                                             |
| tsv                | TSVECTOR     |                           | 全文检索向量                                                                                |
| title_embedding    | VECTOR       |                           | 标题语义向量                                                                                |
| abstract_embedding | VECTOR       |                           | 摘要语义向量                                                                                |

唯一约束：`(doc_number, kind)`

**行数**：0

##### patent_claim（权利要求 — 结构化）

| 列名       | 类型    | 说明         |
| ---------- | ------- | ------------ |
| id         | UUID PK |              |
| patent_id  | UUID FK | → patent.id  |
| claim_num  | INTEGER | 权利要求编号 |
| claim_text | TEXT    | 权利要求全文 |

**行数**：0

##### patent_applicant（申请人）

| 列名      | 类型        | 说明        |
| --------- | ----------- | ----------- |
| id        | UUID PK     |             |
| patent_id | UUID FK     | → patent.id |
| name      | TEXT        | 申请人名称  |
| address   | TEXT        | 完整地址    |
| province  | VARCHAR(50) | 省份        |
| city      | VARCHAR(50) | 城市        |
| county    | VARCHAR(50) | 区县        |
| postcode  | VARCHAR(10) | 邮编        |

**行数**：0

##### patent_inventor（发明人）

| 列名      | 类型    | 说明        |
| --------- | ------- | ----------- |
| id        | UUID PK |             |
| patent_id | UUID FK | → patent.id |
| name      | TEXT    | 发明人名    |

**行数**：0

##### patent_agent（代理机构/代理人）

| 列名            | 类型        | 说明         |
| --------------- | ----------- | ------------ |
| id              | UUID PK     |              |
| patent_id       | UUID FK     | → patent.id  |
| agency          | TEXT        | 代理机构名称 |
| agent           | TEXT        | 代理人姓名   |
| customer_number | VARCHAR(20) | 代理机构编号 |

**行数**：0

##### patent_assignee（受让人/权利人）

| 列名      | 类型        | 说明        |
| --------- | ----------- | ----------- |
| id        | UUID PK     |             |
| patent_id | UUID FK     | → patent.id |
| name      | TEXT        | 名称        |
| address   | TEXT        | 地址        |
| province  | VARCHAR(50) | 省份        |
| city      | VARCHAR(50) | 城市        |
| postcode  | VARCHAR(10) | 邮编        |

**行数**：0

##### patent_citation（引用文献）

| 列名       | 类型        | 说明                 |
| ---------- | ----------- | -------------------- |
| id         | UUID PK     |                      |
| patent_id  | UUID FK     | → patent.id          |
| country    | CHAR(2)     | 国别                 |
| doc_number | VARCHAR(20) | 文献号               |
| kind       | CHAR(1)     | 类型码               |
| pub_date   | DATE        | 公开日期             |
| srep_phase | VARCHAR(10) | 审查阶段（如 `SEA`） |

**行数**：0

##### patent_examiner（审查员）

| 列名      | 类型    | 说明        |
| --------- | ------- | ----------- |
| id        | UUID PK |             |
| patent_id | UUID FK | → patent.id |
| name      | TEXT    | 审查员名    |

**行数**：0

##### patent_ipc（专利-IPC关联）

| 列名             | 类型    | 说明         |
| ---------------- | ------- | ------------ |
| id               | UUID PK |              |
| patent_id        | UUID FK | → patent.id  |
| ipc_code         | TEXT    | IPC 分类号   |
| ipc_version_date | DATE    | IPC 版本日期 |

**行数**：0

##### patent_related_doc（相关文档/优先权）

| 列名       | 类型        | 说明        |
| ---------- | ----------- | ----------- |
| id         | UUID PK     |             |
| patent_id  | UUID FK     | → patent.id |
| country    | CHAR(2)     | 国别        |
| doc_number | VARCHAR(20) | 文献号      |
| kind       | CHAR(1)     | 类型码      |
| pub_date   | DATE        | 公开日期    |

**行数**：0

##### ipc（IPC 分类码字典）

| 列名           | 类型      | 说明     |
| -------------- | --------- | -------- |
| code           | TEXT PK   | IPC 编码 |
| level          | VARCHAR   | 层级     |
| description_zh | TEXT      | 中文描述 |
| description_en | TEXT      | 英文描述 |
| note           | TEXT      | 备注     |
| vector         | VECTOR    | 语义向量 |
| created_at     | TIMESTAMP |          |
| updated_at     | TIMESTAMP |          |

**行数**：100

##### sync_task（同步任务）

| 列名               | 类型         | 说明                  |
| ------------------ | ------------ | --------------------- |
| id                 | UUID PK      |                       |
| batch_name         | VARCHAR(100) | 批次名称              |
| data_type          | VARCHAR(10)  | 数据类型              |
| local_name         | VARCHAR(150) | 本地名称              |
| ftp_path           | TEXT         | FTP 路径（唯一约束）  |
| is_rawdata         | BOOLEAN      | 是否原始数据          |
| status             | VARCHAR(20)  | 状态（默认 `queued`） |
| total_files        | INTEGER      | 总文件数              |
| processed_files    | INTEGER      | 已处理文件数          |
| bytes_total        | BIGINT       | 总字节数              |
| bytes_done         | BIGINT       | 已下载字节            |
| current_file       | VARCHAR(255) | 当前处理文件          |
| patents_processed  | INTEGER      | 已处理专利数          |
| patents_skipped    | INTEGER      | 跳过专利数            |
| patents_failed     | INTEGER      | 失败专利数            |
| current_file_size  | BIGINT       | 当前文件总大小        |
| current_file_bytes | BIGINT       | 当前文件已下载字节    |
| download_speed     | BIGINT       | 下载速度              |
| download_files     | JSONB        | 下载文件列表          |
| ftp_size           | BIGINT       | FTP 端文件大小        |
| ftp_modified       | TIMESTAMP    | FTP 端修改时间        |
| error_message      | TEXT         | 错误信息              |
| created_at         | TIMESTAMP    |                       |
| started_at         | TIMESTAMP    |                       |
| completed_at       | TIMESTAMP    |                       |
| updated_at         | TIMESTAMP    |                       |

唯一约束：`ftp_path`

**行数**：536

##### v_patent_stats_by_type（统计视图）

| 列名              | 类型    |
| ----------------- | ------- |
| app_type          | VARCHAR |
| app_type_label    | VARCHAR |
| kind              | CHAR    |
| kind_label        | VARCHAR |
| total             | BIGINT  |
| earliest_pub_date | DATE    |
| latest_pub_date   | DATE    |

##### v_patent_monthly（月度统计视图）

| 列名  | 类型   |
| ----- | ------ |
| month | TEXT   |
| kind  | CHAR   |
| total | BIGINT |

##### cnipa schema 索引一览

| 类型   | 涉及字段/表                                                |
| ------ | ---------------------------------------------------------- |
| GIN    | patent.title, patent.abstract (trigram), patent.tsv        |
| GIN    | patent.description, patent.claims (JSONB)                  |
| GIN    | patent_applicant.name, patent_inventor.name (trigram)      |
| GIN    | patent_ipc.ipc_code (trigram)                              |
| HNSW   | patent.title_embedding, patent.abstract_embedding (vector) |
| HNSW   | ipc.vector (vector)                                        |
| B-tree | 所有 FK 列、日期列、状态列、county、city                   |

---

## 二、CNIPA XML 字段完整解析

### XML 根元素属性

```xml
<business:PatentDocumentAndRelated
  xsdVersion="V2.2.1"
  file="CN102015000163325CN00001047518250BFULZH20231003CN00Q.XML"
  dateProduced="20230930"
  status="C"
  lang="zh"
  country="CN"
  docNumber="104751825"
  kind="B"
  datePublication="20231003">
```

| 属性              | 说明                           | 发明 | 实用新型 |
| ----------------- | ------------------------------ | ---- | -------- |
| `country`         | 国家代码（CN）                 | ✅   | ✅       |
| `docNumber`       | 文献号                         | ✅   | ✅       |
| `kind`            | 类型码：`B`=发明, `U`=实用新型 | ✅   | ✅       |
| `datePublication` | 公告日期                       | ✅   | ✅       |
| `status`          | 文档状态                       | ✅   | ✅       |
| `file`            | 来源文件名                     | ✅   | ✅       |

### XML → 数据库字段完整映射表

下表列出 CNIPA XML 中实际存在的所有数据元素，以及当前解析器和两个 schema 的覆盖情况。

| #                            | XML 路径 (去命名空间后)                                            | 字段语义          | ParsedPatent 已提取                   | public.patents        | cnipa 对应                         | XML 示例值                             |
| ---------------------------- | ------------------------------------------------------------------ | ----------------- | ------------------------------------- | --------------------- | ---------------------------------- | -------------------------------------- |
| **1. 根元素属性**            |
| 1.1                          | `root.@_docNumber`                                                 | 文献号            | ✅ → `patent_number`                  | `patent_number`       | `doc_number`                       | `104751825`                            |
| 1.2                          | `root.@_kind`                                                      | 类型码            | ⚠️ 仅用于 `detectPatentType()` 未保存 | —                     | `kind`                             | `B` / `U`                              |
| 1.3                          | `root.@_country`                                                   | 国家代码          | ❌                                    | —                     | `pub_country`                      | `CN`                                   |
| 1.4                          | `root.@_datePublication`                                           | 公告日期          | ✅ → `grant_date` (降级)              | `grant_date`          | `pub_date`                         | `20231003`                             |
| 1.5                          | `root.@_status`                                                    | 文档状态          | ❌                                    | —                     | `status`                           | `C`                                    |
| 1.6                          | `root.@_file`                                                      | 来源文件名        | ❌                                    | —                     | `source_file`                      | `CN102015...XML`                       |
| **2. BibliographicData**     |
| 2.1                          | `PublicationReference[].DocumentID.DocNumber`                      | 公开号            | ✅ → `publication_number`             | `publication_number`  | 即 `doc_number`                    | `104751825`                            |
| 2.2                          | `PublicationReference[].DocumentID.Kind`                           | 公开类型          | ❌                                    | —                     | `kind`                             | `B`                                    |
| 2.3                          | `PublicationReference[].DocumentID.Date`                           | 公开日期          | ✅ → `publication_date`               | `publication_date`    | `pub_date`                         | `20231003`                             |
| 2.4                          | `PublicationReference[].DocumentID.WIPOST3Code`                    | 公开国别          | ❌                                    | —                     | `pub_country`                      | `CN`                                   |
| 2.5                          | `ApplicationReference[].@_applType`                                | 申请类型码        | ❌                                    | —                     | `app_type`                         | `10` / `20`                            |
| 2.6                          | `ApplicationReference[].DocumentID.DocNumber`                      | 申请号            | ✅ → `application_number`             | `application_number`  | `app_number`                       | `201510163325.6`                       |
| 2.7                          | `ApplicationReference[].DocumentID.Date`                           | 申请日期          | ✅ → `application_date`               | `application_date`    | `app_date`                         | `20150408`                             |
| 2.8                          | `ApplicationReference[].DocumentID.WIPOST3Code`                    | 申请国别          | ❌                                    | —                     | `app_country`                      | `CN`                                   |
| **3. 分类**                  |
| 3.1                          | `ClassificationIPCRDetails.ClassificationIPCR[]`                   | IPC 分类          | ✅ → `ipc_codes` (文本数组)           | `ipc_codes TEXT[]`    | `patent_ipc` 表                    | —                                      |
| 3.2                          | `ClassificationIPCR.Text`                                          | IPC 文本          | ✅ (拼接进数组)                       | 同上                  | `patent_ipc.ipc_code`              | `G09G 5/10 (2006.01)`                  |
| 3.3                          | `ClassificationIPCR.Section/MainClass/Subclass/MainGroup/Subgroup` | IPC 拆分字段      | ❌                                    | —                     | — (可推算)                         | `G, 09, G, 5, 10`                      |
| 3.4                          | `ClassificationIPCR.IPCVersionDate`                                | IPC 版本日期      | ❌                                    | —                     | —                                  | `20060101`                             |
| **4. Parties — 申请人**      |
| 4.1                          | `ApplicantDetails.Applicant[].AddressBook.Name`                    | 申请人名称        | ✅ → `applicant` (`;` 拼接)           | `applicant TEXT`      | `patent_applicant.name`            | `恒银金融科技股份有限公司`             |
| 4.2                          | `Applicant[].AddressBook.Address.Province`                         | 省份              | ❌                                    | —                     | `patent_applicant.province`        | `天津市`                               |
| 4.3                          | `Applicant[].AddressBook.Address.City`                             | 城市              | ❌                                    | —                     | `patent_applicant.city`            | `市辖区`                               |
| 4.4                          | `Applicant[].AddressBook.Address.County`                           | 区县              | ❌                                    | —                     | —                                  | `滨海新区`                             |
| 4.5                          | `Applicant[].AddressBook.Address.PostCode`                         | 邮编              | ❌                                    | —                     | `patent_applicant.postcode`        | `300308`                               |
| 4.6                          | `Applicant[].AddressBook.Address.Text`                             | 完整地址          | ❌                                    | —                     | `patent_applicant.address`         | `300308 天津市...`                     |
| **5. Parties — 发明人**      |
| 5.1                          | `InventorDetails.Inventor[].AddressBook.Name`                      | 发明人名          | ✅ → `inventor` (`;` 拼接)            | `inventor TEXT`       | `patent_inventor.name`             | `江浩然`                               |
| **6. Parties — 代理人/机构** |
| 6.1                          | `AgentDetails.Agent[].Agency.AddressBook.OrganizationName`         | 代理机构          | ✅ → `agency` (`;` 拼接)              | `agency TEXT`         | `patent_agent.agency`              | `天津市三利专利商标代理有限公司 12107` |
| 6.2                          | `AgentDetails.Agent[].AddressBook.Name`                            | 代理人            | ✅ → `agent` (`;` 拼接)               | `agent TEXT`          | `patent_agent.agent`               | `周庆路`                               |
| 6.3                          | `AgentDetails.CustomerNumber`                                      | 代理机构编号      | ❌                                    | —                     | —                                  | `12107`                                |
| 6.4                          | _Agent 与 Agency 的配对关系_                                       |                   | ❌ 丢失                               | —                     | `patent_agent` (每行一对)          | —                                      |
| **7. 受让人**                |
| 7.1                          | `AssigneeDetails.Assignee[].AddressBook.Name`                      | 受让人名称        | ❌                                    | —                     | `patent_assignee.name`             | `恒银金融科技股份有限公司`             |
| 7.2                          | `AssigneeDetails.Assignee[].AddressBook.Address.*`                 | 受让人地址        | ❌                                    | —                     | `patent_assignee.address/province` | —                                      |
| **8. 审查员 (仅发明)**       |
| 8.1                          | `ExaminerDetails.Examiner[].Name`                                  | 审查员            | ❌                                    | —                     | `patent_examiner.name`             | `李尊懋`                               |
|                              |                                                                    |                   |                                       |                       |                                    | _实用新型无此节点_                     |
| **9. 引用文献 (仅发明)**     |
| 9.1                          | `ReferencesCited.Citation[].ApplicationCitation`                   | 引用文献          | ❌                                    | —                     | `patent_citation` 表               | —                                      |
| 9.2                          | `.PublicationReference[].DocumentID.WIPOST3Code`                   | 国别              | ❌                                    | —                     | `patent_citation.country`          | `CN`                                   |
| 9.3                          | `.PublicationReference[].DocumentID.DocNumber`                     | 文献号            | ❌                                    | —                     | `patent_citation.doc_number`       | `203232659`                            |
| 9.4                          | `.PublicationReference[].DocumentID.Kind`                          | 类型码            | ❌                                    | —                     | `patent_citation.kind`             | `U`                                    |
| 9.5                          | `.PublicationReference[].DocumentID.Date`                          | 公开日期          | ❌                                    | —                     | `patent_citation.pub_date`         | `20131009`                             |
|                              |                                                                    |                   |                                       |                       |                                    | _实用新型无此节点_                     |
| **10. 摘要**                 |
| 10.1                         | `Abstract.Paragraphs`                                              | 摘要文本          | ✅ → `abstract`                       | `abstract TEXT`       | `abstract TEXT`                    | —                                      |
| 10.2                         | `Abstract.AbstractFigure.Figure.Image.@_file`                      | 摘要附图文件名    | ❌                                    | —                     | `abstract_fig_key`                 | `201510163325.JPG`                     |
| 10.3                         | `Abstract.AbstractFigure.Figure.Image.@_he/@_wi`                   | 附图尺寸          | ❌                                    | —                     | `drawings` JSONB                   | `he="341" wi="1000"`                   |
| **11. 权利要求**             |
| 11.1                         | `Claims.Claim[].ClaimText[]`                                       | 权利要求文本      | ✅ → `claims` (文本拼接)              | `claims TEXT`         | `claims JSONB` (结构化)            | —                                      |
| **12. 说明书**               |
| 12.1                         | `Description.TechnicalField`                                       | 技术领域          | ❌                                    | —                     | `description JSONB`                | —                                      |
| 12.2                         | `Description.BackgroundArt`                                        | 背景技术          | ❌                                    | —                     | `description JSONB`                | —                                      |
| 12.3                         | `Description.Disclosure`                                           | 发明/实用新型内容 | ❌                                    | —                     | `description JSONB`                | —                                      |
| 12.4                         | `Description.DrawingsDescription`                                  | 附图说明          | ❌                                    | —                     | `description JSONB`                | —                                      |
| 12.5                         | `Description.InventionMode`                                        | 具体实施方式      | ❌                                    | —                     | `description JSONB`                | —                                      |
| **13. 附图文件**             |
| 13.1                         | ZIP 内 `*.JPG` 文件                                                | 附图图片          | ❌                                    | —                     | `drawings` JSONB                   | `HDA0000695450590000011.JPG`           |
| **14. 优先权**               |
| 14.1                         | `PriorityClaim`                                                    | 优先权声明        | ⚠️ 仅 legacy 路径                     | `priority_info JSONB` | `patent_related_doc` 表            | 本批次样本中未出现                     |

### 两种专利类型的 XML 差异

| 特征              | 发明专利 (kind=`B`)                                                               | 实用新型 (kind=`U`)        |
| ----------------- | --------------------------------------------------------------------------------- | -------------------------- |
| 根节点            | `PatentDocumentAndRelated`                                                        | `PatentDocumentAndRelated` |
| `applType`        | `10`                                                                              | `20`                       |
| `ExaminerDetails` | ✅ 有审查员                                                                       | ❌ 无                      |
| `ReferencesCited` | ✅ 有引用文献                                                                     | ❌ 无                      |
| `PriorityClaim`   | 可能存在                                                                          | 可能存在（样本中均无）     |
| `AssigneeDetails` | ✅                                                                                | ✅                         |
| 说明书结构        | TechnicalField → BackgroundArt → Disclosure → DrawingsDescription → InventionMode | 同左                       |
| ZIP 内附图        | `HDA*.JPG` + `{申请号}.JPG`                                                       | 同左                       |

---

## 三、两套 Schema 对比总结

### 数据模型差异

| 维度        | public                  | cnipa                     |
| ----------- | ----------------------- | ------------------------- |
| 设计风格    | 宽表（1 张 patents 表） | 规范化（1 主表 + 8 子表） |
| 多值字段    | 拼接为字符串或 TEXT[]   | 拆分为独立行（子表）      |
| 主键类型    | SERIAL INT              | UUID                      |
| claims 存储 | TEXT（纯文本）          | JSONB（结构化）           |
| 说明书      | 不存储                  | JSONB（结构化）           |
| raw_xml     | 存库（TEXT）            | OSS 引用（xml_oss_key）   |
| 地址/地理   | 不存储                  | 省/市/邮编                |
| 全文检索    | ILIKE                   | tsvector + GIN            |
| 模糊搜索    | 无                      | trigram GIN               |
| 语义搜索    | 无                      | vector + HNSW             |
| IPC 字典    | 无                      | 独立表 + 向量             |
| 数据状态    | **0 行专利**            | **0 行专利**              |

### 字段覆盖率

| 数据来源    | 可提取字段数 | ParsedPatent 已提取 | public.patents 存储 | cnipa 覆盖    |
| ----------- | ------------ | ------------------- | ------------------- | ------------- |
| XML 根属性  | 6            | 3                   | 2                   | 6             |
| 书目数据    | 8            | 6                   | 6                   | 8             |
| IPC 分类    | 4            | 1 (文本数组)        | 1                   | 1 (+字典关联) |
| 申请人      | 6            | 1 (拼接名)          | 1                   | 6             |
| 发明人      | 1            | 1 (拼接名)          | 1                   | 1             |
| 代理人/机构 | 3            | 2 (各自拼接)        | 2                   | 3 (配对保留)  |
| 受让人      | 3            | 0                   | 0                   | 3             |
| 审查员      | 1            | 0                   | 0                   | 1             |
| 引用文献    | 5            | 0                   | 0                   | 5             |
| 摘要+附图   | 3            | 1                   | 1                   | 3             |
| 权利要求    | 1            | 1 (TEXT)            | 1 (TEXT)            | 1 (JSONB)     |
| 说明书      | 5            | 0                   | 0                   | 5 (JSONB)     |
| **合计**    | **47**       | **16**              | **14**              | **44**        |

---

## 四、FTP 数据源

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
│       ├── ...
│       ├── 20260508/
│       ├── 生物序列2023年/   # 特殊目录（非专利 XML）
│       ├── 生物序列2024年/
│       └── 生物序列2025年/
│
└── CN-PA-TXTS-20-U_中国实用新型专利授权公告标准化全文文本数据/
    └── data/
        ├── 20231003/
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

> 每个批次约 **5 GB**，解压后内含多个子 ZIP，每个子 ZIP 含 ~2000 个专利 XML + 附图 JPG。

### 单条专利 ZIP 结构

```
CN102015000163325CN00001047518250BFULZH20231003CN00Q/
├── CN102015000163325CN00001047518250BFULZH20231003CN00Q.XML  ← 专利XML
├── 201510163325.JPG                                          ← 摘要附图
├── HDA0000695450590000011.JPG                                ← 说明书附图
└── ...
```

---

## 五、已发现的问题

### 1. 分包压缩文件下载过滤遗漏（P0）— ✅ 已修复

### 2. XML 解析器未处理 CNIPA 命名空间（P0）— ✅ 已修复

### 3. 缺少批量扫描和导入能力（P1）

目前 `POST /api/sync/start` 只支持单批次手动传入 `ftp_folder`。面对 541 个批次，需要增加：

- 自动扫描 FTP 子目录并批量创建 batch 记录
- 支持按数据类型、日期范围筛选
- 排除非专利数据目录（如 `生物序列*`、`*rawdata`）

### 4. `CNIPA_FTP_DATA_PATHS` 环境变量未充分利用

### 5. 特殊目录需要排查

- `生物序列2023年` / `生物序列2024年` / `生物序列2025年`
- `*rawdata` 目录

### 6. 两套 Schema 数据不同步（P1）

cnipa schema 有 536 个 sync_task 但 patent 表为空。public schema 有 2 个 sync_batches 但 patents 也为空。两套系统各自为政，无数据共享。

### 7. XML 解析器覆盖率不足（P1）

当前仅提取 47 个可用字段中的 16 个（34%），遗漏了说明书、受让人、审查员、引用文献、结构化地址、附图等重要数据。

---

## 六、建议实施顺序

1. ~~修复分包过滤器~~ ✅
2. ~~修复 XML 命名空间解析~~ ✅
3. **手动运行 1 个批次** — 验证下载 → 解压 → 解析 → 入库全流程（端到端验证）
4. **增强 XML 解析器** — 补充提取 kind、description、结构化申请人/代理人、审查员、引用文献等
5. **演进 public schema** — 新增规范化子表（patent_applicant 等），向 cnipa 设计对齐
6. **实现批量扫描和同步** — 自动遍历 541 个 FTP 子目录
7. **全文检索与语义搜索** — 添加 tsvector、trigram、vector 能力
