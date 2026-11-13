"""Download candidate PDFs and prepare drawing-page manifests for review.

This command never writes to the database or object storage.
"""
import argparse
import importlib.util
import json
import logging
import re
import time
import sys
import io
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urljoin, urlparse

import pymupdf
import requests
from bs4 import BeautifulSoup
from patent_downloader import PatentDownloader
from patent_downloader.exceptions import PatentNotFoundError

spec = importlib.util.spec_from_file_location('pdf_extract', Path(__file__).with_name('extract-patent-pdf.py'))
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)
NUMBER = re.compile(r'^CN\d{7,12}[ABCUSY]\d?$')
REPAIR_REVISION = 3
NO_PDF_ERROR = 'Google Patents 页面未提供 PDF 下载链接，无法从该来源提取附图'


class PdfLinkMissing(PatentNotFoundError):
    pass


class PagePdfDownloader(PatentDownloader):
    """Only probe PDF links actually published on the requested patent page."""

    def _build_pdf_candidate_urls(self, patent_page, patent_number):
        soup = BeautifulSoup(patent_page.content, 'html.parser')
        candidates = []
        for meta in soup.select('meta[name="citation_pdf_url"][content]'):
            candidates.append(meta['content'])
        for link in soup.select('a[href]'):
            href = link['href']
            label = link.get_text(' ', strip=True).lower()
            if '.pdf' in urlparse(href).path.lower() or 'download pdf' in label:
                candidates.append(href)
        urls = []
        for candidate in candidates:
            url = urljoin(patent_page.url, candidate)
            parsed = urlparse(url)
            if parsed.scheme == 'https' and parsed.hostname in ('patents.google.com', 'patentimages.storage.googleapis.com') and url not in urls:
                urls.append(url)
        return urls

    def _retrieve_pdf_link(self, patent_number, patent_page):
        urls = self._build_pdf_candidate_urls(patent_page, patent_number)
        if not urls:
            raise PdfLinkMissing(NO_PDF_ERROR)
        failures = []
        for url in urls:
            try:
                with self.session.get(url, headers={'Referer': patent_page.url}, timeout=self.timeout,
                                      allow_redirects=True, stream=True) as response:
                    if response.status_code == 429:
                        response.raise_for_status()
                    if not response.ok:
                        failures.append(f'PDF 服务返回 HTTP {response.status_code}')
                        continue
                    header = next(response.iter_content(chunk_size=1024), b'')
                    if header.startswith(b'%PDF-'):
                        final = urlparse(response.url)
                        if final.scheme == 'https' and final.hostname in ('patents.google.com', 'patentimages.storage.googleapis.com'):
                            return response.url
                        failures.append('PDF 地址跳转到不受支持的站点')
                    else:
                        failures.append('下载地址返回的内容不是 PDF')
            except requests.HTTPError as error:
                if is_rate_limited(error):
                    raise
                failures.append(f'PDF 服务返回 HTTP {error.response.status_code}' if error.response is not None else 'PDF 服务请求失败')
            except requests.RequestException as error:
                failures.append('连接 PDF 服务超时' if isinstance(error, requests.Timeout) else '连接 PDF 服务失败，请检查代理和网络')
        raise PatentNotFoundError('页面有 PDF 链接，但无法下载：' + '；'.join(dict.fromkeys(failures)))


class RateLimitHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.limited = False

    def emit(self, record):
        if '429' in record.getMessage():
            self.limited = True


class RepairReader(extractor.TextReader):
    def read(self, page, header=False):
        text = super().read(page, header)
        # Some PDFs have a corrupted Chinese text layer despite having extractable
        # publication numbers. OCR the header so drawing pages are not missed.
        if header and self.ocr_enabled and ('\ufffd' in text or not re.search(r'[\u4e00-\u9fff]', text)):
            import cv2
            import numpy as np
            rect = page.rect
            clip = pymupdf.Rect(rect.x0, rect.y0, rect.x1, rect.y0 + rect.height * .23)
            pix = page.get_pixmap(dpi=150, clip=clip, colorspace=pymupdf.csRGB, alpha=False)
            pixels = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
            result = self.ensure_engine()(cv2.cvtColor(pixels, cv2.COLOR_RGB2BGR))
            return text + '\n' + '\n'.join(result.txts or [])
        return text


def candidates(source, selected):
    # Explicit requests retain their requested version. Batch processing scans
    # grant documents first without treating applications as equivalent records.
    for grant_pass in ([True, False] if not selected else [None]):
        with source.open(encoding='utf-8') as file:
            for line in file:
                item = json.loads(line)
                number = item.get('publication_number', '')
                if not NUMBER.fullmatch(number) or (selected and number not in selected):
                    continue
                if grant_pass is not None and bool(re.search(r'B\d?$', number)) != grant_pass:
                    continue
                yield item


def is_rate_limited(error):
    seen = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        if getattr(getattr(error, 'response', None), 'status_code', None) == 429:
            return True
        error = error.__cause__ or error.__context__
    return False


def main():
    parser = argparse.ArgumentParser(description='准备专利附图修复候选，不修改数据库')
    parser.add_argument('--input', default='outputs/repeated-image-audit/candidate-patents.jsonl')
    parser.add_argument('--output', default='data/patent-image-repair')
    parser.add_argument('--publication', action='append', default=[])
    parser.add_argument('--limit', type=int, default=10)
    parser.add_argument('--delay', type=float, default=3)
    parser.add_argument('--ocr', action='store_true')
    parser.add_argument('--retry-failed', action='store_true', help='重试报告中已失败的记录')
    parser.add_argument('--single-stdin', action='store_true', help='从标准输入读取单件候选；报告与表格由调用方维护')
    args = parser.parse_args()
    if args.limit < 1 or args.delay < 0 or any(not NUMBER.fullmatch(n) for n in args.publication):
        parser.error('limit 必须大于 0，delay 不得为负，公开号需为完整 CN 公开号')
    root = Path(args.output).resolve()
    downloads = root / 'pdf'
    downloads.mkdir(parents=True, exist_ok=True)
    report_path = root / 'report.jsonl'
    processed = set()
    previous = {}
    notes = {}
    if report_path.exists() and not args.single_stdin:
        with report_path.open(encoding='utf-8') as report:
            for line in report:
                record = json.loads(line)
                previous[(record.get('publication_number'), record.get('batch'))] = record
                if (record.get('status') == 'ready' and record.get('repair_revision') == REPAIR_REVISION) or (record.get('status') == 'failed' and not args.retry_failed and not args.publication):
                    processed.add(record['publication_number'])
    downloader = PagePdfDownloader()
    rate_limit = RateLimitHandler()
    logging.getLogger('patent_downloader').addHandler(rate_limit)
    reader = RepairReader(args.ocr)
    count = 0
    failed = False
    single_item = json.load(sys.stdin) if args.single_stdin else None
    if single_item and (not NUMBER.fullmatch(single_item.get('publication_number', '')) or not isinstance(single_item.get('batch'), str) or not isinstance(single_item.get('image_names'), list)):
        parser.error('候选记录无效')
    with (io.StringIO() if args.single_stdin else report_path.open('a', encoding='utf-8')) as report:
        for item in ([single_item] if args.single_stdin else candidates(Path(args.input), set(args.publication))):
            number = item['publication_number']
            if number in processed:
                continue
            count += 1
            result = {'publication_number': number, 'batch': item['batch'], 'candidate_image_names': item['image_names']}
            try:
                target = downloads / (number + '.pdf')
                if not target.exists():
                    if not downloader.download_patent(number, str(downloads)):
                        raise ValueError('已找到 PDF 链接，但下载失败，请检查代理后重试')
                if not target.is_file() or target.stat().st_size > 100 * 1024 * 1024:
                    raise ValueError('PDF 不存在或超过 100 MB')
                content = target.read_bytes()
                if not content.startswith(b'%PDF-'):
                    raise ValueError('下载内容不是 PDF')
                with pymupdf.open(stream=content, filetype='pdf') as doc:
                    if doc.needs_pass or not 1 <= len(doc) <= 500:
                        raise ValueError('PDF 加密或页数不符合要求')
                    first = reader.read(doc[0])
                    actual = extractor.publication_number_on_page(doc[0], first)
                    if actual != number:
                        raise ValueError(f'PDF 首页公开号不匹配或无法识别: {actual}')
                settings = SimpleNamespace(output=str(root / 'images-v3'), batch='repair', dpi=300,
                                           pages=None, before_year=9999, max_pages=500,
                                           figures=True, drawing_only=True, clean_drawing=True, save_pdf=False)
                manifest = extractor.extract(content, target.name, str(target), settings, reader)
                if manifest['status'] != 'extracted' or not manifest.get('images'):
                    raise ValueError(manifest.get('error', '无法确认说明书附图页'))
                result.update(status='ready', pdf=str(target), pdf_hash=manifest['pdf_hash'],
                              manifest=str(Path(manifest['directory']) / 'manifest.json'),
                              drawing_pages=len(manifest['images']), repair_revision=REPAIR_REVISION)
                processed.add(number)
                prior = previous.get((number, item['batch']), {})
                if prior.get('error_code') == 'no_pdf_link' or prior.get('error') in (NO_PDF_ERROR, f'Could not find a verified PDF download link for patent {number}'):
                    notes[(number, item['batch'])] = None
            except Exception as error:
                rate_limit.limited |= is_rate_limited(error)
                message = 'Google Patents 返回请求过于频繁，请稍后重试' if rate_limit.limited else str(error)
                result.update(status='failed', error=message)
                if isinstance(error, PdfLinkMissing):
                    result['error_code'] = 'no_pdf_link'
                    notes[(number, item['batch'])] = 'no_pdf_link'
                failed = True
            report.write(json.dumps(result, ensure_ascii=False) + '\n')
            report.flush()
            print(json.dumps(result, ensure_ascii=False), flush=True)
            if rate_limit.limited:
                print('检测到 HTTP 429，停止本次任务；请稍后重试。', flush=True)
                break
            if count >= args.limit:
                break
            time.sleep(args.delay)
    if notes and not args.single_stdin:
        try:
            spec = importlib.util.spec_from_file_location('repair_finalize', Path(__file__).with_name('repair-finalize.py'))
            finalizer = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(finalizer)
            finalizer.update_workbook(set(), {key: finalizer.NO_PDF if value else None for key, value in notes.items()})
            print(json.dumps({'status': 'notes_updated', 'count': len(notes)}, ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({'status': 'notes_failed', 'error': f'Excel 下载备注未写入：{error}；下载记录已保留'}, ensure_ascii=False), flush=True)
            failed = True
    if not count:
        print('没有需要处理的候选记录。', flush=True)
    return 1 if failed or rate_limit.limited else 0


if __name__ == '__main__':
    raise SystemExit(main())
