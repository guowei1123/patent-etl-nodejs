"""Mark verified repairs in the candidate workbook, then remove their local PDFs."""
import hashlib
import json
import os
import re
import shutil
import sys
import uuid
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from xml.sax.saxutils import unescape

ROOT = Path.cwd().resolve()
WORKBOOK = ROOT / 'outputs/repeated-image-audit/重名图片专利公开号.xlsx'
PDF_DIR = ROOT / 'data/patent-image-repair/pdf'
SHEET = 'xl/worksheets/sheet1.xml'
MARK = '说明书附图已更新'
NO_PDF = 'Google Patents 未提供 PDF 链接'
UNVERIFIED_PDF = '未找到可验证的 PDF 链接'


def iter_candidate_rows(source):
    header = False
    for _, row in ET.iterparse(source, events=('end',)):
        if row.tag.rsplit('}', 1)[-1] != 'row':
            continue
        values = {}
        for cell in row:
            if cell.tag.rsplit('}', 1)[-1] != 'c':
                continue
            column = re.match(r'[A-Z]+', cell.get('r', ''))
            if not column:
                continue
            if cell.get('t') != 'inlineStr':
                if column.group() in 'ABCD':
                    raise ValueError('候选表含不支持的单元格格式')
                continue
            values[column.group()] = ''.join(node.text or '' for node in cell.iter() if node.tag.rsplit('}', 1)[-1] == 't')
        if not header:
            if [values.get(col) for col in 'ABCD'] != ['公开号', '批次', '专利名称', '重名图片']:
                raise ValueError('候选表表头已变化，请检查 Excel')
            header = True
        else:
            number, batch = values.get('A', '').strip(), values.get('B', '').strip()
            if number and batch:
                yield {'publication_number': number, 'batch': batch,
                       'image_names': [name.strip() for name in re.split(r'[,，、]', values.get('D', '')) if name.strip()],
                       'repair_status': values.get('E', '').strip()}
        row.clear()
    if not header:
        raise ValueError('候选表为空')


def cell_text(row, column):
    match = re.search(rb'<c\s+r="' + column.encode() + rb'\d+"[^>]*\bt="inlineStr"[^>]*>\s*<is>\s*<t(?:\s+[^>]*)?>(.*?)</t>\s*</is>\s*</c>', row, re.S)
    return unescape(match.group(1).decode('utf-8')) if match else None


def ensure_supported_cell(row, column, value, index):
    if value is None and re.search(rb'<c\s+r="' + column.encode() + str(index).encode() + rb'"', row):
        raise ValueError(f'第 {index} 行 {column} 列格式不受支持，未修改文件')


def rewrite_sheet(source, target, expected, notes=None, storage_notes=None):
    found = set()
    count = 0
    header = False
    buffer = b''
    prefix_done = False
    while True:
        chunk = source.read(1024 * 1024)
        buffer += chunk
        while True:
            start = buffer.find(b'<row ')
            if start < 0:
                break
            end = buffer.find(b'</row>', start)
            if end < 0:
                break
            prefix, row, buffer = buffer[:start], buffer[start:end + 6], buffer[end + 6:]
            if not prefix_done:
                if not re.search(rb'<dimension ref="A1:[DEFG]\d+"', prefix):
                    raise ValueError('工作表结构已变化，无法安全添加状态列')
                if storage_notes is not None:
                    prefix = re.sub(rb'<dimension ref="A1:[DEF](\d+)"', rb'<dimension ref="A1:G\1"', prefix, count=1)
                elif notes is not None:
                    prefix = re.sub(rb'<dimension ref="A1:[DE](\d+)"', rb'<dimension ref="A1:F\1"', prefix, count=1)
                else:
                    prefix = re.sub(rb'<dimension ref="A1:D(\d+)"', rb'<dimension ref="A1:E\1"', prefix, count=1)
                if b'<col min="5" ' not in prefix:
                    prefix = prefix.replace(b'</cols>', b'<col min="5" max="5" width="23" customWidth="1"/></cols>', 1)
                if notes is not None and b'<col min="6" ' not in prefix:
                    prefix = prefix.replace(b'</cols>', b'<col min="6" max="6" width="36" customWidth="1"/></cols>', 1)
                if storage_notes is not None and b'<col min="7" ' not in prefix:
                    prefix = prefix.replace(b'</cols>', b'<col min="7" max="7" width="36" customWidth="1"/></cols>', 1)
                prefix_done = True
            target.write(prefix)
            row_num = re.match(rb'<row\s+r="(\d+)"', row)
            if not row_num:
                raise ValueError('工作表行格式不受支持')
            index = int(row_num.group(1))
            if index == 1:
                if [cell_text(row, col) for col in 'ABCD'] != ['公开号', '批次', '专利名称', '重名图片']:
                    raise ValueError('候选表表头已变化，未修改文件')
                existing = cell_text(row, 'E')
                ensure_supported_cell(row, 'E', existing, index)
                if existing not in (None, '修复状态'):
                    raise ValueError('E 列已有其他内容，未修改文件')
                if existing is None:
                    row = insert_cell(row, 'E', '<c r="E1" s="1" t="inlineStr"><is><t>修复状态</t></is></c>'.encode())
                if notes is not None:
                    existing_note = cell_text(row, 'F')
                    ensure_supported_cell(row, 'F', existing_note, index)
                    if existing_note not in (None, 'PDF下载备注'):
                        raise ValueError('F 列已有其他内容，未修改文件')
                    if existing_note is None:
                        row = insert_cell(row, 'F', '<c r="F1" s="1" t="inlineStr"><is><t>PDF下载备注</t></is></c>'.encode())
                if storage_notes is not None:
                    existing_storage = cell_text(row, 'G')
                    ensure_supported_cell(row, 'G', existing_storage, index)
                    if existing_storage not in (None, '附图存储备注'):
                        raise ValueError('G 列已有其他内容，未修改文件')
                    if existing_storage is None:
                        row = insert_cell(row, 'G', '<c r="G1" s="1" t="inlineStr"><is><t>附图存储备注</t></is></c>'.encode())
                header = True
            else:
                number, batch = cell_text(row, 'A'), cell_text(row, 'B')
                existing = cell_text(row, 'E')
                if (number, batch) in expected:
                    ensure_supported_cell(row, 'E', existing, index)
                    if existing not in (None, MARK):
                        raise ValueError(f'第 {index} 行状态列已有其他内容，未修改文件')
                    found.add((number, batch))
                    if existing is None:
                        row = insert_cell(row, 'E', f'<c r="E{index}" t="inlineStr"><is><t>{MARK}</t></is></c>'.encode())
                if notes is not None and (number, batch) in notes:
                    existing_note = cell_text(row, 'F')
                    ensure_supported_cell(row, 'F', existing_note, index)
                    if existing_note not in (None, NO_PDF, UNVERIFIED_PDF):
                        raise ValueError(f'第 {index} 行备注列已有其他内容，未修改文件')
                    if existing_note in (NO_PDF, UNVERIFIED_PDF):
                        row = re.sub(rb'<c\s+r="F\d+"[^>]*>.*?</c>', b'', row, count=1, flags=re.S)
                    if notes[(number, batch)] in (NO_PDF, UNVERIFIED_PDF):
                        row = insert_cell(row, 'F', f'<c r="F{index}" t="inlineStr"><is><t>{notes[(number, batch)]}</t></is></c>'.encode())
                    found.add((number, batch))
                if storage_notes is not None and (number, batch) in storage_notes:
                    existing_storage = cell_text(row, 'G')
                    ensure_supported_cell(row, 'G', existing_storage, index)
                    if existing_storage not in (None, '对象存储中附图不存在'):
                        raise ValueError(f'第 {index} 行存储备注已有其他内容，未修改文件')
                    if existing_storage is None:
                        row = insert_cell(row, 'G', f'<c r="G{index}" t="inlineStr"><is><t>对象存储中附图不存在</t></is></c>'.encode())
                    found.add((number, batch))
                count += 1
            target.write(row)
        if not chunk:
            break
        if len(buffer) > 10 * 1024 * 1024:
            raise ValueError('工作表包含过长的行，未修改文件')
    wanted = expected | (set(notes) if notes is not None else set()) | (set(storage_notes) if storage_notes is not None else set())
    if not header or found != wanted:
        raise ValueError(f'工作表未找到全部记录，缺失 {len(wanted - found)} 项')
    if storage_notes is not None:
        buffer = re.sub(rb'<autoFilter ref="A1:[DEF](\d+)"', rb'<autoFilter ref="A1:G\1"', buffer)
    elif notes is not None:
        buffer = re.sub(rb'<autoFilter ref="A1:[DE](\d+)"', rb'<autoFilter ref="A1:F\1"', buffer)
    else:
        buffer = re.sub(rb'<autoFilter ref="A1:D(\d+)"', rb'<autoFilter ref="A1:E\1"', buffer)
    target.write(buffer)
    return count, found


def insert_cell(row, column, cell):
    pattern = re.compile(rb'<c\s+r="([A-Z]+)\d+"')
    next_cell = pattern.search(row)
    while next_cell and next_cell.group(1).decode() <= column:
        next_cell = pattern.search(row, next_cell.end())
    position = next_cell.start() if next_cell else len(row) - 6
    return row[:position] + cell + row[position:]


def update_workbook(expected, notes=None, storage_notes=None):
    if not WORKBOOK.is_file():
        raise ValueError('候选 Excel 不存在，请恢复文件后重试；未删除 PDF')
    if WORKBOOK.with_name('~$' + WORKBOOK.name).exists():
        raise ValueError('候选 Excel 正在打开，请关闭工作簿后重试；PDF 已保留')
    original = WORKBOOK.stat()
    staged = WORKBOOK.with_name(WORKBOOK.name + '.' + uuid.uuid4().hex + '.part')
    with zipfile.ZipFile(WORKBOOK, 'r') as src, zipfile.ZipFile(staged, 'x', allowZip64=True) as dst:
        if SHEET not in src.namelist() or 'xl/sharedStrings.xml' in src.namelist():
            raise ValueError('工作簿结构已变化，未修改文件')
        for info in src.infolist():
            with src.open(info) as reader, dst.open(info, 'w', force_zip64=True) as writer:
                if info.filename == SHEET:
                    rows, found = rewrite_sheet(reader, writer, expected, notes, storage_notes)
                else:
                    shutil.copyfileobj(reader, writer, 1024 * 1024)
    with zipfile.ZipFile(staged) as check:
        if check.testzip() is not None:
            raise ValueError('更新后的 Excel 校验失败，未删除 PDF')
    current = WORKBOOK.stat()
    if (original.st_size, original.st_mtime_ns) != (current.st_size, current.st_mtime_ns):
        raise ValueError('Excel 在更新期间发生变化，未覆盖文件或删除 PDF')
    try:
        os.replace(staged, WORKBOOK)
    except PermissionError as error:
        raise ValueError('候选 Excel 无法写入，请关闭工作簿后重试；PDF 已保留') from error
    return rows, found


def finalize(items, notes=None, storage_notes=None):
    expected = {(x['number'], x['batch']) for x in items}
    if not expected and not notes and not storage_notes:
        return {'marked': 0, 'deleted': 0}
    rows, found = update_workbook(expected, notes, storage_notes)
    deleted = []
    retained = []
    for item in items:
        number = item['number']
        if not re.fullmatch(r'CN\d{7,12}[ABCUSY]\d?', number):
            raise ValueError('公开号格式无效')
        pdf = PDF_DIR / (number + '.pdf')
        if not pdf.exists():
            continue
        if pdf.is_symlink() or pdf.resolve().parent != PDF_DIR.resolve():
            retained.append(number)
            continue
        digest = hashlib.sha256()
        with pdf.open('rb') as f:
            for block in iter(lambda: f.read(1024 * 1024), b''):
                digest.update(block)
        if digest.hexdigest() != item['pdf_hash']:
            retained.append(number)
            continue
        try:
            pdf.unlink()
            deleted.append(number)
        except OSError:
            retained.append(number)
    return {'marked': len(found & expected), 'rows': rows, 'deleted': len(deleted), 'retained': retained}


def notes_from_report(report):
    latest = {}
    previously_missing = set()
    with report.open(encoding='utf-8') as source:
        for line in source:
            record = json.loads(line)
            key = (record.get('publication_number'), record.get('batch'))
            if all(key):
                latest[key] = record
                if record.get('error_code') == 'no_pdf_link' or record.get('error') == 'Google Patents 页面未提供 PDF 下载链接，无法从该来源提取附图' or record.get('error') == f'Could not find a verified PDF download link for patent {key[0]}':
                    previously_missing.add(key)
    notes = {}
    for key, record in latest.items():
        if record.get('status') == 'ready' and key in previously_missing:
            notes[key] = None
            continue
        if record.get('status') != 'failed':
            continue
        error = record.get('error', '')
        if record.get('error_code') == 'no_pdf_link' or error == 'Google Patents 页面未提供 PDF 下载链接，无法从该来源提取附图':
            notes[key] = NO_PDF
        elif error == f'Could not find a verified PDF download link for patent {key[0]}':
            notes[key] = UNVERIFIED_PDF
    return notes


if __name__ == '__main__':
    try:
        if '--list-candidates' in sys.argv:
            with zipfile.ZipFile(WORKBOOK, 'r') as workbook:
                if SHEET not in workbook.namelist() or 'xl/sharedStrings.xml' in workbook.namelist():
                    raise ValueError('候选 Excel 结构不受支持，请使用原导出表格')
                with workbook.open(SHEET) as source:
                    for item in iter_candidate_rows(source):
                        print(json.dumps(item, ensure_ascii=False), flush=True)
        elif '--storage-notes' in sys.argv:
            data = json.load(sys.stdin)
            update_workbook(set(), storage_notes={(item['number'], item['batch']) for item in data})
            print(json.dumps({'notes_updated': len(data)}, ensure_ascii=False), flush=True)
        elif '--sync-notes' in sys.argv:
            notes = notes_from_report(ROOT / 'data/patent-image-repair/report.jsonl')
            if notes:
                update_workbook(set(), notes)
            print(json.dumps({'notes_updated': len(notes)}, ensure_ascii=False), flush=True)
        else:
            data = json.load(sys.stdin)
            if isinstance(data, dict):
                notes = {(item['number'], item['batch']): item.get('note') for item in data.get('notes', [])}
                storage = {(item['number'], item['batch']) for item in data.get('storage_notes', [])}
                print(json.dumps(finalize(data.get('items', []), notes or None, storage or None), ensure_ascii=False), flush=True)
            else:
                print(json.dumps(finalize(data), ensure_ascii=False), flush=True)
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False), file=sys.stderr, flush=True)
        sys.exit(1)
