# IPC/CPC 数据源整理

更新时间：2026-07-01

## 结论

本项目建议使用官方标题列表作为第一阶段 IPC/CPC 字典数据源，并只保留中文、英文标题：

- IPC：WIPO IPC 2026.01 English title list
- CPC：CPC 2026.05 Title List

这两类文件都足够支撑分类号规范化、英文标题展示、层级检索和字典表初始化。中文标题作为补充字段保留：

- IPC 中文：WIPO IPCPUB 指向 CNIPA 的 IPC national translation，可作为中文标题来源，但目前更偏在线查询入口，尚未确认稳定批量下载包。
- CPC 中文：暂未发现官方中文批量数据源。需要保留字段，但必须记录来源，避免把机器翻译或人工整理误标为官方标题。

完整 XML 和 definitions 可以作为第二阶段增强源，不建议阻塞本轮全量重新清洗。

## 官方数据源

### IPC

来源：WIPO International Patent Classification IT Support Area

- 版本：IPC 2026.01
- 下载基路径：`https://www.wipo.int/classifications/data/ipc/ITSupport_and_download_area/20260101/`
- 英文标题列表：
  `https://www.wipo.int/classifications/data/ipc/ITSupport_and_download_area/20260101/IPC_scheme_title_list/EN_ipc_title_list_20260101.zip`
- 中文标题来源：
  WIPO IPCPUB 的 `IPC National translations -> Chinese` 指向 CNIPA IPC 分类查询。该来源适合后续补齐 `title_zh`，但不作为第一阶段全量清洗的强依赖。
- 有效符号列表：
  `https://www.wipo.int/classifications/data/ipc/ITSupport_and_download_area/20260101/valid_symbol_list/ipc_valid_symbols_20260101.zip`
- 符号历史清单：
  `https://www.wipo.int/classifications/data/ipc/ITSupport_and_download_area/20260101/IPC_symbol_inventory/20260101_inventory_of_IPC_ever_used_symbols.csv`
- Master files 目录：
  `https://www.wipo.int/classifications/data/ipc/ITSupport_and_download_area/20260101/MasterFiles/`

本次抽样下载文件：

- `/private/tmp/EN_ipc_title_list_20260101.zip`
- 解压目录：`/private/tmp/ipc-title-202601`

文件结构：

```text
EN_ipc_section_A_title_list_20260101.txt
EN_ipc_section_B_title_list_20260101.txt
EN_ipc_section_C_title_list_20260101.txt
EN_ipc_section_D_title_list_20260101.txt
EN_ipc_section_E_title_list_20260101.txt
EN_ipc_section_F_title_list_20260101.txt
EN_ipc_section_G_title_list_20260101.txt
EN_ipc_section_H_title_list_20260101.txt
```

抽样统计：

```text
A: 10015
B: 18559
C: 15334
D:  3326
E:  3518
F:  9698
G:  9626
H: 10658
Total: 80734
```

样本：

```text
H	ELECTRICITY
H01	ELECTRIC ELEMENTS
H01B	CABLES; CONDUCTORS; INSULATORS; SELECTION OF MATERIALS...
H01B0001000000	Conductors or conductive bodies characterised by the conductive materials...
H01B0001020000	mainly consisting of metals or alloys
```

IPC title list 使用 WIPO 长格式符号，例如：

- `H01B0001000000` 表示 `H01B 1/00`
- `H01M0004130000` 表示 `H01M 4/13`
- `H04L0065101600` 表示 `H04L 65/1016`

入库时需要同时保留：

- `source_code`：原始长格式
- `code`：展示格式，如 `H01B 1/00`
- `code_norm`：查询格式，如 `H01B1/00`

### CPC

来源：Cooperative Patent Classification Bulk Data

- 版本：CPC 2026.05
- Bulk Data 页面：
  `https://www.cooperativepatentclassification.org/cpcSchemeAndDefinitions/bulk`
- CPC Valid symbols：
  `https://www.cooperativepatentclassification.org/sites/default/files/cpc/bulk/CPCSymbolList202605.zip`
- CPC Validity file：
  `https://www.cooperativepatentclassification.org/sites/default/files/cpc/bulk/CPCValidityFile202605.zip`
- CPC Title List：
  `https://www.cooperativepatentclassification.org/sites/default/files/cpc/bulk/CPCTitleList202605.zip`
- 中文标题来源：
  暂未确认官方 CPC 中文批量标题列表。第一阶段只导入英文标题，并保留 `title_zh` / `title_zh_source` 字段。
- Complete CPC scheme XML：
  `https://www.cooperativepatentclassification.org/sites/default/files/cpc/bulk/CPCSchemeXML202605.zip`
- Complete CPC Definitions XML：
  `https://www.cooperativepatentclassification.org/sites/default/files/cpc/bulk/FullCPCDefinitionXML202605.zip`
- CPC linked open data：
  `https://www.cooperativepatentclassification.org/cpcSchemeAndDefinitions/CPCopenLinkedData`

本次抽样下载文件：

- `/private/tmp/CPCTitleList202605.zip`
- 解压目录：`/private/tmp/cpc-title-202605`

文件结构：

```text
cpc-section-A_20260501.txt
cpc-section-B_20260501.txt
cpc-section-C_20260501.txt
cpc-section-D_20260501.txt
cpc-section-E_20260501.txt
cpc-section-F_20260501.txt
cpc-section-G_20260501.txt
cpc-section-H_20260501.txt
cpc-section-Y_20260501.txt
```

抽样统计：

```text
A:  29971
B:  56954
C:  38342
D:   5692
E:   9270
F:  28153
G:  38254
H:  32151
Y:  15487
Total: 254274
```

样本：

```text
H		ELECTRICITY
H01		ELECTRIC ELEMENTS
H01B		CABLES; CONDUCTORS; INSULATORS...
H01B1/00	0	Conductors or conductive bodies characterised by the conductive materials...
H01B1/02	1	mainly consisting of metals or alloys
H01B1/023	2	{Alloys based on aluminium}
```

CPC title list 已使用接近展示格式的分类号。第二列是层级缩进级别：

- section/class/subclass 行通常没有 level 值
- group/subgroup 行有 `0`, `1`, `2` 等 level 值
- `Y` 部是 CPC 特有，应保留

## 推荐数据库结构

因为本项目已经计划把专利命中的 IPC/CPC 拆成 `patent_ipc` 和 `patent_cpc` 两张关联表，字典表也建议分成 `ipc_classification` 和 `cpc_classification`。这样查询语义清晰，约束简单，后续也便于独立更新 IPC/CPC 版本。

### IPC 字典表

```sql
CREATE TABLE cnipa.ipc_classification (
  code_norm TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  source_code TEXT NOT NULL,
  version TEXT NOT NULL,
  section CHAR(1),
  class_code TEXT,
  subclass TEXT,
  main_group TEXT,
  subgroup TEXT,
  level INTEGER,
  title_en TEXT NOT NULL,
  title_zh TEXT,
  title_zh_source TEXT,
  source_file TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  CONSTRAINT chk_ipc_title_zh_source
    CHECK (title_zh_source IS NULL OR title_zh_source IN ('cnipa', 'manual', 'machine'))
);
```

字段说明：

- `code_norm`：查询主键，例如 `H01B1/00`
- `code`：展示格式，例如 `H01B 1/00`
- `source_code`：WIPO title list 原始长格式，例如 `H01B0001000000`
- `title_en`：WIPO 英文标题
- `title_zh`：中文标题，可后续补齐
- `title_zh_source`：中文标题来源，限定为 `cnipa`、`manual`、`machine`

### CPC 字典表

```sql
CREATE TABLE cnipa.cpc_classification (
  code_norm TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  source_code TEXT NOT NULL,
  version TEXT NOT NULL,
  section CHAR(1),
  class_code TEXT,
  subclass TEXT,
  main_group TEXT,
  subgroup TEXT,
  level INTEGER,
  title_en TEXT NOT NULL,
  title_zh TEXT,
  title_zh_source TEXT,
  source_file TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  CONSTRAINT chk_cpc_title_zh_source
    CHECK (title_zh_source IS NULL OR title_zh_source IN ('official', 'manual', 'machine'))
);
```

CPC 暂无已确认官方中文批量源，因此 `title_zh_source = 'official'` 只有在后续确认官方来源后才能使用。

### 专利-IPC 关联表

```sql
CREATE TABLE cnipa.patent_ipc (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patent_id UUID NOT NULL REFERENCES cnipa.patent(id) ON DELETE CASCADE,
  ipc_code TEXT NOT NULL,
  ipc_code_norm TEXT NOT NULL,
  ipc_version_date DATE,
  section CHAR(1),
  class_code TEXT,
  subclass TEXT,
  main_group TEXT,
  subgroup TEXT,
  position INTEGER,
  is_primary BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE (patent_id, ipc_code_norm)
);
```

### 专利-CPC 关联表

```sql
CREATE TABLE cnipa.patent_cpc (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patent_id UUID NOT NULL REFERENCES cnipa.patent(id) ON DELETE CASCADE,
  cpc_code TEXT NOT NULL,
  cpc_code_norm TEXT NOT NULL,
  cpc_version_date DATE,
  section CHAR(1),
  class_code TEXT,
  subclass TEXT,
  main_group TEXT,
  subgroup TEXT,
  position INTEGER,
  is_primary BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE (patent_id, cpc_code_norm)
);
```

关联表保留结构化字段，不只依赖字典表 join。原因：

- 专利清洗和查询可以不依赖字典表完整性。
- `section/class/subclass/group` 过滤可以直接走关联表索引。
- 字典表更新不会影响专利事实数据。

### 索引

```sql
CREATE INDEX idx_ipc_classification_section
  ON cnipa.ipc_classification(section);

CREATE INDEX idx_ipc_classification_subclass
  ON cnipa.ipc_classification(subclass);

CREATE INDEX idx_cpc_classification_section
  ON cnipa.cpc_classification(section);

CREATE INDEX idx_cpc_classification_subclass
  ON cnipa.cpc_classification(subclass);

CREATE INDEX idx_patent_ipc_patent_id
  ON cnipa.patent_ipc(patent_id);

CREATE INDEX idx_patent_ipc_code_norm
  ON cnipa.patent_ipc(ipc_code_norm);

CREATE INDEX idx_patent_ipc_code_norm_patent_id
  ON cnipa.patent_ipc(ipc_code_norm, patent_id);

CREATE INDEX idx_patent_ipc_section
  ON cnipa.patent_ipc(section);

CREATE INDEX idx_patent_ipc_subclass
  ON cnipa.patent_ipc(subclass);

CREATE INDEX idx_patent_cpc_patent_id
  ON cnipa.patent_cpc(patent_id);

CREATE INDEX idx_patent_cpc_code_norm
  ON cnipa.patent_cpc(cpc_code_norm);

CREATE INDEX idx_patent_cpc_code_norm_patent_id
  ON cnipa.patent_cpc(cpc_code_norm, patent_id);

CREATE INDEX idx_patent_cpc_section
  ON cnipa.patent_cpc(section);

CREATE INDEX idx_patent_cpc_subclass
  ON cnipa.patent_cpc(subclass);
```

如果仍需要任意包含查询，例如 `%H01M%`，再启用 trigram：

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX idx_patent_ipc_code_trgm
  ON cnipa.patent_ipc USING gin (ipc_code gin_trgm_ops);

CREATE INDEX idx_patent_cpc_code_trgm
  ON cnipa.patent_cpc USING gin (cpc_code gin_trgm_ops);
```

默认查询不应依赖 trigram。`IPC:H01M`、`CPC:H01M` 应编译为前缀查询：`code_norm LIKE 'H01M%'`。

## 解析规则

### IPC 长格式转展示格式

IPC title list 的长格式可按以下规则解析：

```text
H01B0001000000 -> H01B 1/00
H01M0004130000 -> H01M 4/13
H04L0065101600 -> H04L 65/1016
```

基本规则：

- 前 4 位：subclass，例如 `H01B`
- 剩余 10 位：group/subgroup 编码
- group：剩余 10 位前 4 位去前导零
- subgroup：剩余 10 位后 6 位去尾部零，至少保留 2 位
- `0001000000` -> `1/00`
- `0004130000` -> `4/13`
- `0065101600` -> `65/1016`

### CPC 格式规范化

```text
H01B1/00 -> H01B1/00
H01B 1/00 -> H01B1/00
H01B1/023 -> H01B1/023
Y02A20/108 -> Y02A20/108
```

规范化规则：

- 大写
- 删除空格
- 删除版本括号，例如 `(2006.01)`
- 保留 `/`

## 推荐导入顺序

1. 下载 IPC/CPC 英文 title list。
2. 解压到临时目录。
3. 逐行解析为统一结构。
4. 写入 `ipc_classification` / `cpc_classification`。
5. `title_zh` 字段先允许为空。
6. 后续单独补 IPC 中文标题；CPC 中文标题只有确认来源后再补。
7. 后续再用 valid symbols / validity file 补充有效期字段。
8. XML scheme 和 definitions 暂不进入主流程，仅作为增强源。

## 第一阶段不建议处理的数据

- PDF：只适合人工阅读，不适合入库。
- Definitions XML：内容更复杂，适合做详情说明和搜索辅助，不适合作为第一阶段必需字段。
- CPC linked open data：适合 RDF/SPARQL 场景；当前 PostgreSQL 关系模型直接解析 title list 更简单。
- 法文和其他语言标题：本项目当前不需要，避免增加导入和存储复杂度。
- IPC/CPC 历史版本全量：当前项目先服务重新清洗后的当前数据，历史版本可后补。

## 对当前项目的直接影响

本轮全量清洗建议新增：

- `scripts/import-ipc-cpc-classifications.ts`
- `lib/classification-code.ts`
- `cnipa.ipc_classification`
- `cnipa.cpc_classification`
- `cnipa.patent_ipc`
- `cnipa.patent_cpc`

专利清洗时：

- IPC/CPC 关联表只保存专利实际命中的分类号。
- 字典表保存官方分类号和中英文标题字段。
- 查询时优先查关联表的 `code_norm`，详情展示时再关联字典表标题。
