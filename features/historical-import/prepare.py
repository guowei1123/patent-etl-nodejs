"""Build a disk-backed Excel/Parquet/PDF join. No writes to source files."""
import argparse
import datetime
import hashlib
import importlib.util
import json
import re
import sqlite3
import sys
from pathlib import Path

import duckdb
import openpyxl

MODULE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("pdf_extract", MODULE / "pdf/extract-patent-pdf.py")
pdf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pdf)


def publication(value):
    text = re.sub(r"\s+", "", str(value or "")).upper()
    if re.fullmatch(r"\d{7,12}[ABCUY]\d?", text):
        text = "CN" + text
    if not re.fullmatch(r"CN\d{7,12}[ABCUY]\d?", text):
        raise ValueError("公开号必须包含 A/B/C/U/Y 种类码")
    return text


def application(value):
    if not isinstance(value, str):
        raise ValueError("申请号必须为文本，防止 Excel 数值精度丢失")
    result = re.sub(r"[\s.]", "", value.upper())
    result = re.sub(r"^(CN|ZL)", "", result)
    if re.fullmatch(r"(?:\d{8}|\d{12})[\dX]", result):
        result = result[:-1]
    elif not re.fullmatch(r"(?:\d{8}|\d{12})", result):
        raise ValueError("申请号格式无效")
    return "CN" + result


def date(value):
    if isinstance(value, (datetime.date, datetime.datetime)):
        return value.strftime("%Y-%m-%d")
    text = str(value or "").strip().replace("年", "-").replace("月", "-").replace("日", "")
    text = text.replace("/", "-").replace(".", "-")
    if re.fullmatch(r"\d{8}", text):
        text = f"{text[:4]}-{text[4:6]}-{text[6:]}"
    try:
        parts = text.split(" ")[0].split("-")
        return datetime.date(*map(int, parts)).isoformat()
    except (ValueError, TypeError):
        raise ValueError("公开／公告日期无效")


def files(source, extension):
    path = Path(source)
    result = sorted(path.rglob(f"*{extension}")) if path.is_dir() else [path]
    result = [p for p in result if p.is_file() and p.suffix.lower() == extension and not p.name.startswith("~$")]
    if not result:
        raise ValueError(f"来源中未找到 {extension} 文件")
    return result


def inspect(config):
    result = {}
    if config.get('stage') == 'images':
        samples = []
        for origin, name in pdf.pdf_names(Path(config['pdfPath']), 9999):
            samples.append({'file': origin, 'columns': [name]})
            if len(samples) >= 10:
                break
        result['pdfPath'] = {'fileCount': len(samples), 'samples': samples}
        return result
    for key in ("excelPath", "descriptionPath", "claimsPath"):
        stage = config.get('stage', 'all')
        if not config.get(key) or (stage == 'metadata' and key != 'excelPath') or stage == 'images' or (stage == 'text' and key == 'excelPath'):
            continue
        paths = files(config[key], ".xlsx" if key == "excelPath" else ".parquet")
        columns = []
        for path in paths[:10]:
            if key == "excelPath":
                book = openpyxl.load_workbook(path, read_only=True, data_only=True)
                try:
                    sheet = book[config["sheet"]] if config.get("sheet") else book.worksheets[0]
                    columns.append({"file": str(path), "columns": [str(c or "") for c in next(sheet.iter_rows(values_only=True))], "sheets": book.sheetnames})
                finally:
                    book.close()
            else:
                connection = duckdb.connect()
                try:
                    columns.append({"file": str(path), "columns": [r[0] for r in connection.execute("DESCRIBE SELECT * FROM read_parquet(?)", [str(path)]).fetchall()]})
                finally:
                    connection.close()
        result[key] = {"fileCount": len(paths), "samples": columns}
    return result


def progress(message):
    print(json.dumps({"message": message}, ensure_ascii=False), flush=True)


def prepare(config, output):
    stage = config.get('stage', 'all')
    connection = sqlite3.connect(output / "index.sqlite")
    connection.executescript("""DROP TABLE IF EXISTS metadata; DROP TABLE IF EXISTS chosen; DROP TABLE IF EXISTS body;
      CREATE TABLE metadata(pub TEXT PRIMARY KEY, app TEXT, data TEXT, conflict INTEGER DEFAULT 0);
      CREATE INDEX metadata_app ON metadata(app);
      CREATE TABLE chosen(pub TEXT PRIMARY KEY, data TEXT);
      CREATE TABLE body(pub TEXT, section TEXT, content TEXT, conflict INTEGER DEFAULT 0, PRIMARY KEY(pub,section));""")
    errors = (output / "source-errors.jsonl").open("w", encoding="utf-8")
    row_count = 0
    if stage in ('text', 'images'):
        with (output / 'database-records.jsonl').open(encoding='utf-8') as snapshot:
            for line in snapshot:
                record = json.loads(line)
                record['application'] = application(record['application']) if record.get('application') else ''
                connection.execute('INSERT OR IGNORE INTO metadata(pub,app,data) VALUES (?,?,?)',
                                   (record['publication'], record['application'], json.dumps(record, ensure_ascii=False)))
    for path in (files(config["excelPath"], ".xlsx") if stage in ('metadata', 'all') else []):
        book = openpyxl.load_workbook(path, read_only=True, data_only=True)
        try:
            sheet = book[config["sheet"]] if config["sheet"] else book.worksheets[0]
            rows = sheet.iter_rows(values_only=True)
            headers = [str(x or "").strip() for x in next(rows)]
            required = [config["columns"]["publication"]]
            if any(x not in headers for x in required) or len(set(headers)) != len(headers):
                raise ValueError("Excel 缺少必需映射列或含重复列名")
            for row_number, row in enumerate(rows, 2):
                if not any(v is not None for v in row):
                    continue
                row_count += 1
                raw = dict(zip(headers, row))
                def field(key):
                    return raw.get(config["columns"][key])
                try:
                    pub = publication(field("publication"))
                    app = application(field("application")) if field("application") else ''
                    kind = re.search(r"[ABCUY]\d?$", pub)[0]
                    record = {"publication": pub, "application": app, "kind": kind, "date": date(field("date")) if field('date') else '',
                              "grant": publication(field("grant")) if field("grant") else "",
                              "grantDate": date(field("grantDate")) if field("grantDate") else "",
                              "raw": {k: str(v) if isinstance(v, (datetime.date, datetime.datetime)) else v for k, v in raw.items()},
                              "source": f"{path}::{sheet.title}::row={row_number}"}
                    for key in ("title", "abstract", "applicant", "inventor", "ipc"):
                        record[key] = str(field(key) or "").strip()
                    old = connection.execute("SELECT data FROM metadata WHERE pub=?", (pub,)).fetchone()
                    if old:
                        previous = json.loads(old[0])
                        if any(previous[k] != record[k] for k in ("application", "kind", "date", "grant", "title")):
                            connection.execute("UPDATE metadata SET conflict=1 WHERE pub=?", (pub,))
                    else:
                        connection.execute("INSERT INTO metadata(pub,app,data) VALUES (?,?,?)", (pub, app, json.dumps(record, ensure_ascii=False)))
                except ValueError as error:
                    errors.write(json.dumps({"source": str(path), "row": row_number, "error": str(error)}, ensure_ascii=False) + "\n")
                if row_count % 1000 == 0:
                    connection.commit()
                    progress(f"已检查基础信息 {row_count} 行")
        finally:
            book.close()
    connection.commit()
    progress("正在按完整公开号关联本阶段数据")
    selected = 0
    # Every publication can already hold another stage's data. Fill all supplied versions;
    # only transactional grant cleanup may remove A after all grant content is complete.
    for pub, data, conflict in connection.execute("SELECT pub,data,conflict FROM metadata ORDER BY CASE WHEN substr(json_extract(data,'$.kind'),1,1) IN ('B','C') THEN 0 ELSE 1 END,pub"):
        record = json.loads(data)
        reasons = []
        if conflict:
            reasons.append("同一公开号的基础信息冲突，请核对来源")
        if record['kind'][0] in 'BC':
            record["date"] = record["grantDate"] or record["date"]
        if record.get('date'):
            try:
                record['date'] = date(record['date'])
            except ValueError:
                reasons.append('已有公告日期无效，请补入正确基础信息')
        if record["date"] and record["date"] >= config["beforeDate"]:
            continue
        if config["limit"] and selected >= config["limit"]:
            break
        record.update({"status": "blocked" if reasons else "ready", "reasons": reasons, "description": "", "claims": "",
                       "metadataPending": not all(record.get(key) for key in ('application', 'date', 'title'))})
        connection.execute("INSERT INTO chosen VALUES (?,?)", (record["publication"], json.dumps(record, ensure_ascii=False)))
        selected += 1
    connection.commit()
    progress(f"已选择 {selected} 件本阶段候选专利")
    engine = duckdb.connect(str(output / "join.duckdb"))
    engine.execute("CREATE OR REPLACE TABLE selected(pub VARCHAR)")
    selected_numbers = [(pub,) for (pub,) in connection.execute("SELECT pub FROM chosen")]
    if selected_numbers:
        engine.executemany("INSERT INTO selected VALUES (?)", selected_numbers)
    for section, source_key, key_name, text_name in (
        ("description", "descriptionPath", "descriptionKey", "descriptionText"),
        ("claims", "claimsPath", "claimsKey", "claimsText"),
    ):
        if stage not in ('text', 'all') or not config.get(source_key):
            continue
        key = '"' + config[key_name].replace('"', '""') + '"'
        text = '"' + config[text_name].replace('"', '""') + '"'
        for path in files(config[source_key], ".parquet"):
            # Projection and filtering happen in DuckDB; only selected versions return to Python.
            query = f"""SELECT p.publication_key,p.body_text FROM
                        (SELECT upper(regexp_replace(CAST({key} AS VARCHAR), '\\s', '', 'g')) AS publication_key,
                        CAST({text} AS VARCHAR) AS body_text FROM read_parquet(?)) p
                        JOIN selected s ON s.pub=p.publication_key OR s.pub=('CN' || p.publication_key)"""
            cursor = engine.execute(query, [str(path)])
            while batch_rows := cursor.fetchmany(100):
                for number, content in batch_rows:
                    pub = publication(number)
                    content = (content or "").strip()
                    old = connection.execute("SELECT content FROM body WHERE pub=? AND section=?", (pub, section)).fetchone()
                    if old and old[0] != content:
                        connection.execute("UPDATE body SET conflict=1 WHERE pub=? AND section=?", (pub, section))
                    elif not old:
                        connection.execute("INSERT INTO body(pub,section,content) VALUES (?,?,?)", (pub, section, content))
            connection.commit()
    engine.close()
    if stage in ('images', 'all'):
        progress("正在解压目标版本 PDF 并提取附图")
    reader = pdf.TextReader(config["ocr"])
    pdf_args = argparse.Namespace(output=str(output / "images"), batch="HISTORY", dpi=300, pages=None, max_pages=500, before_year=9999, save_pdf=False, figures=True)
    targets = {row[0] for row in connection.execute('SELECT pub FROM chosen')}
    # Archives are source containers; labelled PDF dates can supply announcement batches.
    entries = pdf.prepared_pdf_entries(Path(config['pdfPath']), 9999, 100 * 1024**2, output / 'unpacked', targets) if stage in ('images', 'all') else []
    for origin, name, content in entries:
        number = pdf.patent_number(Path(name).name)
        if not number:
            continue
        chosen = connection.execute("SELECT data FROM chosen WHERE pub=?", (number,)).fetchone()
        if not chosen:
            continue
        record = json.loads(chosen[0])
        if record["status"] == "blocked" or number in config["noDrawingNumbers"]:
            continue
        try:
            pdf_args.publication_date = record.get("date") or None
            result = pdf.extract(content, name, origin, pdf_args, reader)
            if result["status"] == "extracted":
                pdf_date = result.get('publication_date')
                if pdf_date:
                    if record.get('date') and record['date'] != pdf_date:
                        record['reasons'].append('PDF 公告日期与基础信息不一致，请核对')
                    elif not record.get('date'):
                        record['date'] = pdf_date
                    if pdf_date >= config['beforeDate']:
                        record['reasons'].append('PDF 公告日期超出处理范围，请调整日期')
                record['metadataPending'] = not all(record.get(key) for key in ('application','date','title'))
                manifest = str(Path(result["directory"]) / "manifest.json")
                if record.get("pdfManifest") and record["pdfManifest"] != manifest:
                    record["reasons"].append("同一公开号存在不同 PDF，请核对版本")
                else:
                    record["pdfManifest"] = manifest
            else:
                record["reasons"].append("PDF 未识别附图，请核对页码或确认无附图")
        except Exception:
            record["reasons"].append("PDF 解析失败，请检查文件及 OCR 依赖")
        connection.execute("UPDATE chosen SET data=? WHERE pub=?", (json.dumps(record, ensure_ascii=False), number))
        connection.commit()
        progress(f"已检查 PDF：{number}")
    total = ready = blocked = 0
    with (output / "records.jsonl").open("w", encoding="utf-8") as destination:
        for pub, data in connection.execute("SELECT pub,data FROM chosen ORDER BY pub"):
            record = json.loads(data)
            for section in ("description", "claims"):
                if stage not in ('text', 'all') or not config.get(section + 'Path'):
                    continue
                body = connection.execute("SELECT content,conflict FROM body WHERE pub=? AND section=?", (pub, section)).fetchone()
                if not body or not body[0]:
                    record["reasons"].append(f"缺少对应版本的{'说明书' if section == 'description' else '权利要求'}")
                elif body[1]:
                    record["reasons"].append(f"{section} 存在冲突的重复正文")
                else:
                    record[section] = body[0]
            if stage in ('images', 'all') and not record.get("pdfManifest") and pub not in config["noDrawingNumbers"]:
                record["reasons"].append("缺少附图 PDF 或未识别附图")
            record["status"] = "blocked" if record["reasons"] else "ready"
            total += 1
            ready += record["status"] == "ready"
            blocked += record["status"] == "blocked"
            destination.write(json.dumps(record, ensure_ascii=False) + "\n")
    errors.close()
    connection.close()
    progress(f"已完成文件关联：候选 {total}，可导入 {ready}，待补齐 {blocked}")


def requested_numbers(config, output):
    """Disk-backed distinct source keys; database lookup never scans the entire patent table."""
    engine = duckdb.connect(str(output / 'requested.duckdb'))
    engine.execute('CREATE OR REPLACE TABLE requested(pub VARCHAR PRIMARY KEY)')
    if config['stage'] == 'text':
        for source, key_name in [('descriptionPath', 'descriptionKey'), ('claimsPath', 'claimsKey')]:
            if not config.get(source):
                continue
            key = '"' + config[key_name].replace('"', '""') + '"'
            for file in files(config[source], '.parquet'):
                engine.execute(f'''INSERT OR IGNORE INTO requested SELECT DISTINCT
                  CASE WHEN starts_with(number,'CN') THEN number ELSE 'CN' || number END
                  FROM (SELECT upper(regexp_replace(CAST({key} AS VARCHAR),'\\s','','g')) number FROM read_parquet(?))
                  WHERE regexp_full_match(number,'(CN)?[0-9]{{7,12}}[ABCUY][0-9]?')''', [str(file)])
    else:
        for _, name in pdf.pdf_names(Path(config['pdfPath']), 9999):
            number = pdf.patent_number(Path(name).name)
            if number:
                engine.execute('INSERT OR IGNORE INTO requested VALUES (?)', [number])
        for number in config.get('noDrawingNumbers', []):
            engine.execute('INSERT OR IGNORE INTO requested VALUES (?)', [number])
    cursor = engine.execute('SELECT pub FROM requested ORDER BY pub')
    with (output / 'requested.jsonl').open('w', encoding='utf-8') as target:
        while rows := cursor.fetchmany(500):
            for (number,) in rows:
                target.write(json.dumps(number) + '\n')
    engine.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--inspect", action="store_true")
    parser.add_argument('--keys', action='store_true')
    args = parser.parse_args()
    config = json.load(sys.stdin) if args.config == "-" else json.loads(Path(args.config).read_text(encoding="utf-8"))
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if args.keys:
        requested_numbers(config, output)
    elif args.inspect:
        print(json.dumps(inspect(config), ensure_ascii=False))
    else:
        prepare(config, output)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), flush=True)
        sys.exit(1)
