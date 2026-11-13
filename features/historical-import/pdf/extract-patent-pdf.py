"""Read PDFs/TARs/ZIPs without unpacking archives; retain full drawing pages."""
import argparse
import datetime
import hashlib
import json
import re
import sys
import tarfile
import zipfile
from pathlib import PurePosixPath
from pathlib import Path

import pymupdf

VERSION = "pdf-pages-v1"
NUMBER = re.compile(r"CN\s*(\d{7,12})\s*([ABCUSY]\d?)", re.I)


def patent_number(text):
    match = NUMBER.search(text)
    return "CN" + match[1] + match[2].upper() if match else None


def publication_number_on_page(page, text):
    """Prefer the cover's publication identifier over cited earlier documents."""
    rect = page.rect
    corner = pymupdf.Rect(rect.x0 + rect.width * .6, rect.y0,
                          rect.x1, rect.y0 + rect.height * .25)
    def matches(value):
        return {"CN" + m[1] + m[2].upper() for m in NUMBER.finditer(value)}
    top = matches(page.get_text(clip=corner))
    if len(top) == 1:
        return next(iter(top))
    if len(top) > 1:
        raise ValueError('PDF 首页公告号存在歧义，请人工核对')
    all_numbers = matches(text)
    if len(all_numbers) == 1:
        return next(iter(all_numbers))
    if len(all_numbers) > 1:
        raise ValueError('PDF 首页存在多个文献号且无法定位公告号，请人工核对')
    return None


def drawing_header(text):
    compact = re.sub(r"\s+", "", text)
    return "说明书附图" in compact or "說明書附圖" in compact


def pdf_names(source, before_year):
    for path in sorted(source.rglob('*')) if source.is_dir() else [source]:
        if not path.is_file():
            continue
        years = [int(y) for y in re.findall(r'(?<!\d)(?:19|20)\d{2}(?!\d)', path.stem)]
        if years and min(years) >= before_year:
            continue
        if path.suffix.lower() == '.pdf':
            yield str(path), path.name
        elif path.suffix.lower() == '.zip':
            with zipfile.ZipFile(path) as archive:
                for entry in archive.infolist():
                    if not entry.is_dir() and entry.filename.lower().endswith('.pdf'):
                        yield str(path), entry.filename
        elif path.name.lower().endswith(('.tar', '.tar.gz', '.tgz')):
            with tarfile.open(path, 'r|*') as archive:
                for entry in archive:
                    if entry.isfile() and entry.name.lower().endswith('.pdf'):
                        yield str(path), entry.name


def prepared_pdf_entries(source, before_year, max_bytes, unpacked, targets):
    """Extract selected PDFs to a controlled staging folder before parsing, never extractall."""
    unpacked = unpacked.resolve()
    unpacked.mkdir(parents=True, exist_ok=True)
    def save(stream, archive_path, name, size):
        safe = PurePosixPath(name.replace('\\', '/'))
        if safe.is_absolute() or '..' in safe.parts or ':' in name:
            raise ValueError('压缩包成员路径不安全')
        if size > max_bytes:
            return None
        archive_id = hashlib.sha256(str(archive_path.resolve()).encode()).hexdigest()[:16]
        member_id = hashlib.sha256(name.encode()).hexdigest()[:16]
        target = unpacked / archive_id / member_id / (patent_number(safe.name) + '.pdf')
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('wb') as destination:
            remaining = max_bytes + 1
            while remaining:
                chunk = stream.read(min(1024**2, remaining))
                if not chunk:
                    break
                destination.write(chunk)
                remaining -= len(chunk)
            if target.stat().st_size > max_bytes:
                raise ValueError('压缩包 PDF 解压后超过大小限制')
        print(json.dumps({'message': f'已解压目标 PDF：{safe.name}'}, ensure_ascii=False), flush=True)
        return target.read_bytes()
    for path in sorted(source.rglob('*')) if source.is_dir() else [source]:
        if not path.is_file():
            continue
        years = [int(y) for y in re.findall(r'(?<!\d)(?:19|20)\d{2}(?!\d)', path.stem)]
        if years and min(years) >= before_year:
            continue
        if path.suffix.lower() == '.pdf':
            if patent_number(path.name) in targets:
                yield str(path), path.name, path.read_bytes() if path.stat().st_size <= max_bytes else None
        elif path.suffix.lower() == '.zip':
            with zipfile.ZipFile(path) as archive:
                for member in archive.infolist():
                    if not member.is_dir() and member.filename.lower().endswith('.pdf') and patent_number(member.filename) in targets:
                        if (member.external_attr >> 16) & 0o170000 == 0o120000:
                            raise ValueError('压缩包包含符号链接 PDF')
                        with archive.open(member) as stream:
                            content = save(stream, path, member.filename, member.file_size)
                        yield f'{path}::{member.filename}', member.filename, content
        elif path.name.lower().endswith(('.tar', '.tar.gz', '.tgz')):
            with tarfile.open(path, 'r|*') as archive:
                for member in archive:
                    if member.isfile() and member.name.lower().endswith('.pdf') and patent_number(member.name) in targets:
                        with archive.extractfile(member) as stream:
                            content = save(stream, path, member.name, member.size)
                        yield f'{path}::{member.name}', member.name, content


def pdf_entries(source, before_year, max_bytes):
    paths = sorted(source.rglob("*")) if source.is_dir() else [source]
    for path in paths:
        if not path.is_file():
            continue
        years = [int(y) for y in re.findall(r"(?<!\d)(?:19|20)\d{2}(?!\d)", path.stem)]
        if years and min(years) >= before_year:
            continue
        if path.suffix.lower() == ".pdf":
            if path.stat().st_size > max_bytes:
                yield str(path), path.name, None
            else:
                yield str(path), path.name, path.read_bytes()
        elif path.suffix.lower() == ".zip":
            with zipfile.ZipFile(path) as archive:
                for member in archive.infolist():
                    if member.filename.lower().endswith(".pdf"):
                        content = archive.read(member) if member.file_size <= max_bytes else None
                        yield f"{path}::{member.filename}", member.filename, content
        elif path.name.lower().endswith((".tar", ".tar.gz", ".tgz")):
            with tarfile.open(path, "r|*") as archive:
                for member in archive:
                    if member.isfile() and member.name.lower().endswith(".pdf"):
                        stream = archive.extractfile(member)
                        content = stream.read() if member.size <= max_bytes else None
                        yield f"{path}::{member.name}", member.name, content


class TextReader:
    def __init__(self, ocr):
        self.ocr_enabled = ocr
        self.engine = None

    def ensure_engine(self):
        if self.engine is None:
            from rapidocr import RapidOCR
            self.engine = RapidOCR(params={"EngineConfig.onnxruntime.intra_op_num_threads": 2,
                                           "EngineConfig.onnxruntime.inter_op_num_threads": 1})
        return self.engine

    def read(self, page, header=False):
        rect = page.rect
        clip = pymupdf.Rect(rect.x0, rect.y0, rect.x1, rect.y0 + rect.height * .23) if header else rect
        text = page.get_text(clip=clip).strip()
        if text:
            return text
        if not self.ocr_enabled:
            raise ValueError("扫描件缺少文本层，请添加 --ocr 或明确指定 --pages")
        self.ensure_engine()
        import numpy as np
        pix = page.get_pixmap(dpi=150, clip=clip, colorspace=pymupdf.csRGB, alpha=False)
        pixels = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
        result = self.engine(pixels[:, :, ::-1].copy())
        return "\n".join(result.txts or [])


def publication_date(text):
    # Match only labelled publication/grant announcement dates, not filing dates.
    match = re.search(r"(?:公布日|公告日)\s*(?:[（(]\d+[）)]\s*)?([12]\d{3})[.年/\-]\s*(\d{1,2})[.月/\-]\s*(\d{1,2})", text)
    return datetime.date(*map(int, match.groups())).isoformat() if match else None


def announcement_batch(date, number):
    kind = re.search(r"([ABCUSY]\d?)$", number)[1]
    prefix = 'CN-PA-TXTS-10-A' if kind.startswith('A') else 'CN-PA-TXTS-10-B' if kind.startswith(('B','C')) else 'CN-PA-TXTS-20-U'
    return prefix + '-' + date.replace('-', '')


def extract(content, name, source, args, reader):
    if content is None:
        raise ValueError("PDF 超过单文件大小限制")
    digest = hashlib.sha256(content).hexdigest()
    with pymupdf.open(stream=content, filetype="pdf") as doc:
        if doc.needs_pass or len(doc) > args.max_pages:
            raise ValueError("PDF 加密或超过页数限制")
        first = reader.read(doc[0]) if not args.pages else doc[0].get_text()
        number = publication_number_on_page(doc[0], first)
        file_number = patent_number(Path(name).name)
        if number and file_number and number != file_number:
            raise ValueError("首页公开号与文件名不一致，请人工核对")
        number = number or file_number
        if not number:
            raise ValueError("未识别完整公开号，请检查文件名或首页")
        # Publication date is only taken from the labelled field, never application date.
        detected_date = publication_date(doc[0].get_text(sort=True)) or publication_date(first)
        date = detected_date or getattr(args, "publication_date", None)
        if date:
            datetime.date.fromisoformat(date)
        if date and int(date[:4]) >= args.before_year:
            return {"status": "outside_range", "patent_number": number, "source": source, "publication_date": date}
        announcement = announcement_batch(date, number) if date else None
        digits = re.sub(r'[ABCUSY]\d?$', '', number.removeprefix('CN'))
        directory = Path(args.output).resolve() / (announcement or 'PENDING') / digits
        manifest = directory / "manifest.json"
        if manifest.exists():
            cached = json.loads(manifest.read_text(encoding="utf-8"))
            if cached.get('pdf_hash') != digest or cached.get('patent_number') != number:
                raise ValueError('同一批次的数字公开号目录已有不同 PDF，请核对版本后清理旧提取结果')
            if cached.get("version") == ('pdf-figures-v2' if getattr(args,'figures',False) else VERSION) and (not getattr(args,'figures',False) or cached.get('figure_revision') == 9) and cached.get("dpi") == args.dpi and cached.get("pages_override") == args.pages and all((directory / i["file_name"]).exists() for i in cached["images"]):
                return cached
        headers = {}
        if args.pages:
            pages = sorted(set(int(p) - 1 for p in args.pages.split(",")))
            if not pages or min(pages) < 0 or max(pages) >= len(doc):
                raise ValueError("--pages 页码超出 PDF 范围（从 1 开始）")
        else:
            pages = []
            for i, page in enumerate(doc):
                headers[i] = reader.read(page, header=True)
                if drawing_header(headers[i]):
                    pages.append(i)
                if (i + 1) % 10 == 0:
                    print(f"{number}：已检查 {i + 1}/{len(doc)} 页", flush=True)
        if not pages and not getattr(args, 'figures', False):
            return {"status": "needs_review", "patent_number": number, "source": source, "error": "未识别附图页，请核对后使用 --pages"}
        directory.mkdir(parents=True, exist_ok=True)
        if getattr(args, 'save_pdf', True):
            (directory / f"{number}.pdf").write_bytes(content)
        images = []
        for order, page_index in enumerate([] if getattr(args,'figures',False) else pages, 1):
            pix = doc[page_index].get_pixmap(dpi=args.dpi, colorspace=pymupdf.csGRAY, alpha=False)
            file_name = f"说明书-图{order}.png"
            target = directory / file_name
            pix.save(target)
            images.append({"file_name": file_name, "page": page_index + 1, "width": pix.width, "height": pix.height,
                           "content_hash": hashlib.sha256(target.read_bytes()).hexdigest(), "figure_label": f"附图第 {order} 页"})
        if getattr(args,'figures',False):
            import importlib.util
            figure_spec = importlib.util.spec_from_file_location('pdf_figures', Path(__file__).parent / 'figures.py')
            figures = importlib.util.module_from_spec(figure_spec)
            figure_spec.loader.exec_module(figures)
            images = figures.extract_figures(doc, pages, directory, number, args, reader, headers,
                                             drawing_only=getattr(args, 'drawing_only', False))
            if not images:
                return {"status": "needs_review", "patent_number": number, "source": source, "error": "未识别附图或正文图形，请人工核对 PDF"}
        result = {"version": 'pdf-figures-v2' if getattr(args,'figures',False) else VERSION, "dpi": args.dpi, "pages_override": args.pages, "status": "extracted", "batch": args.batch,
                  "publication_date": date, "announcement_batch": announcement, "date_status": "extracted" if date else "needs_review", "date_source": "pdf" if detected_date else "metadata" if date else None,
                  "patent_number": number, "pdf_hash": digest, "source": source, "directory": str(directory),
                  "page_count": len(doc), "images": images}
        if getattr(args,'figures',False):
            result['figure_revision'] = 9
        temporary = manifest.with_suffix(".json.part")
        temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(manifest)
        return result


def main():
    parser = argparse.ArgumentParser(description="历史专利 PDF 附图提取（默认最多 10 份）")
    parser.add_argument("--source", required=True)
    parser.add_argument("--batch", required=True)
    parser.add_argument("--output", default="data/historical-pdf")
    parser.add_argument("--limit", type=int, default=10, help="0 表示全部")
    parser.add_argument("--dpi", type=int, default=300)
    parser.add_argument("--before-year", type=int, default=2023)
    parser.add_argument("--max-pages", type=int, default=500)
    parser.add_argument("--max-mb", type=int, default=100)
    parser.add_argument("--ocr", action="store_true")
    parser.add_argument("--pages", help="人工确认的附图页码，例如 8,9；仅允许 limit=1")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_-]+", args.batch) or args.limit < 0 or not 72 <= args.dpi <= 600 or args.max_mb < 1 or args.max_pages < 1:
        parser.error("批次号或处理参数无效")
    if args.pages and args.limit != 1:
        parser.error("--pages 必须配合 --limit 1 使用")
    source = Path(args.source).resolve()
    if not source.exists():
        parser.error("来源路径不存在")
    output = Path(args.output).resolve()
    if source == output or source in output.parents:
        parser.error("输出目录不能位于来源目录内")
    reader = TextReader(args.ocr)
    batch_dir = output / args.batch
    batch_dir.mkdir(parents=True, exist_ok=True)
    failed = False
    count = 0
    report_path = batch_dir / "report.jsonl"
    with report_path.open("a", encoding="utf-8") as report:
        for index, (origin, name, content) in enumerate(pdf_entries(source, args.before_year, args.max_mb * 1024**2)):
            count += 1
            try:
                result = extract(content, name, origin, args, reader)
            except Exception as error:
                result = {"status": "failed", "source": origin, "error": str(error)}
            failed |= result["status"] in ("failed", "needs_review")
            report.write(json.dumps(result, ensure_ascii=False) + "\n")
            report.flush()
            print(f'{index + 1}: {result.get("patent_number", name)} {result["status"]}', flush=True)
            if args.limit and index + 1 >= args.limit:
                break
    print(f"结果：{report_path}")
    if not count:
        print("未找到符合年份范围的 PDF；嵌套压缩包需要先单独整理。")
        return 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
