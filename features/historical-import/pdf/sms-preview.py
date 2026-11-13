"""Prepare review-only SMS candidates from embedded description images.

The output is not proof of correspondence to the original SMS names and this
command does not modify object storage or the database.
"""
import argparse
import hashlib
import importlib.util
import io
import json
import re
import sys
from pathlib import Path

import pymupdf
from PIL import Image

spec = importlib.util.spec_from_file_location('pdf_figures', Path(__file__).with_name('figures.py'))
figures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(figures)
extract_spec = importlib.util.spec_from_file_location('pdf_extract', Path(__file__).with_name('extract-patent-pdf.py'))
extractor = importlib.util.module_from_spec(extract_spec)
extract_spec.loader.exec_module(extractor)


def candidates(document):
    for index, page in enumerate(document):
        header_rect = pymupdf.Rect(page.rect.x0, page.rect.y0, page.rect.x1,
                                   page.rect.y0 + page.rect.height * .07)
        header = ''.join(page.get_text(clip=header_rect).split())
        if not ('说明书' in header or '說明書' in header) or '附图' in header or '附圖' in header:
            continue
        masks = {item[0]: item[1] for item in page.get_images(full=True)}
        for rect, xref in figures.sms_embedded_regions(page, figures.body_clip(page)):
            yield index + 1, rect, xref, masks.get(xref, 0)


def jpeg_bytes(document, xref, mask):
    pix = pymupdf.Pixmap(document, xref)
    if mask:
        pix = pymupdf.Pixmap(pix, pymupdf.Pixmap(document, mask))
    if pix.n - pix.alpha > 3:
        pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
    image = Image.open(io.BytesIO(pix.tobytes('png'))).convert('RGBA')
    background = Image.new('RGBA', image.size, 'white')
    background.alpha_composite(image)
    result = io.BytesIO()
    background.convert('RGB').save(result, format='JPEG', quality=95, optimize=True)
    return result.getvalue(), image.size


def image_text_context(page, box, other_boxes=()):
    """Return text on both sides of an image on the same line, when clear."""
    chars = []
    for block in page.get_text('rawdict', clip=figures.body_clip(page))['blocks']:
        for line in block.get('lines', []):
            for span in line.get('spans', []):
                for char in span.get('chars', []):
                    rect = pymupdf.Rect(char['bbox'])
                    overlap = min(rect.y1, box.y1) - max(rect.y0, box.y0)
                    if overlap > 0 and overlap >= min(rect.height, box.height) * .25:
                        chars.append((rect, char['c']))
    left = sorted((item for item in chars if item[0].x1 <= box.x0 + 1), key=lambda x: x[0].x0)
    right = sorted((item for item in chars if item[0].x0 >= box.x1 - 1), key=lambda x: x[0].x0)
    if not left or not right or box.x0-left[-1][0].x1 > 30 or right[0][0].x0-box.x1 > 30:
        return None
    gap = pymupdf.Rect(left[-1][0].x1, box.y0, right[0][0].x0, box.y1)
    if any(other != box and (other & gap).get_area() > 0 for other in other_boxes):
        return None
    before = ''.join(item[1] for item in left).strip()[-24:]
    after = ''.join(item[1] for item in right).strip()[:24]
    return {'before': before, 'after': after} if before and after else None


def main():
    parser = argparse.ArgumentParser(description='从 PDF 生成只供核对的正文 SMS 候选')
    parser.add_argument('--pdf', required=True)
    parser.add_argument('--publication', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--skip-context', action='store_true', help='保留正文原有图片位置，不提取 PDF 图片上下文')
    parser.add_argument('--download-if-missing', action='store_true', help='本地 PDF 缺失时从专利页面下载')
    args = parser.parse_args()
    if not re.fullmatch(r'CN\d{7,12}[ABCUSY]\d?', args.publication):
        parser.error('请输入完整公开号')
    if not Path(args.pdf).is_file() and args.download_if_missing:
        download_spec = importlib.util.spec_from_file_location('repair_download', Path(__file__).with_name('repair-download.py'))
        downloader = importlib.util.module_from_spec(download_spec)
        download_spec.loader.exec_module(downloader)
        pdf_path = Path(args.pdf)
        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        if not downloader.PagePdfDownloader().download_patent(args.publication, str(pdf_path.parent)):
            raise ValueError('PDF 下载失败，请检查代理和网络后重试')
    if not Path(args.pdf).is_file():
        raise ValueError('本地 PDF 不存在，请先下载该专利 PDF 再提取')
    pdf = Path(args.pdf).read_bytes()
    with pymupdf.open(stream=pdf, filetype='pdf') as doc:
        if not doc.page_count or extractor.publication_number_on_page(doc[0], doc[0].get_text()) != args.publication:
            raise ValueError('PDF 首页未识别到指定公开号，未提取')
        output = Path(args.output)
        output.mkdir(parents=True, exist_ok=True)
        images = []
        regions = list(candidates(doc))
        for number, (page, box, xref, mask) in enumerate(regions, 1):
            name = f'SMS_{number}.JPG'
            context = None if args.skip_context else image_text_context(doc[page-1], box, [rect for p, rect, _, _ in regions if p == page])
            if not xref:
                images.append({'file_name': name, 'page': page, 'bbox': list(box), 'xref': 0,
                               'text_context': context, 'status': 'needs_review', 'error': 'PDF 内联图片无可提取资源编号'})
                continue
            content, (width, height) = jpeg_bytes(doc, xref, mask)
            with (output / name).open('xb') as target:
                target.write(content)
            images.append({'file_name': name, 'page': page, 'bbox': list(box), 'xref': xref, 'status': 'extracted',
                           'text_context': context, 'width': width, 'height': height, 'sha256': hashlib.sha256(content).hexdigest()})
        manifest = {'publication_number': args.publication, 'pdf_sha256': hashlib.sha256(pdf).hexdigest(),
                    'mapping_verified': False, 'limitations': ['仅提取有可识别页眉的说明书页面中的嵌入图片；扫描件、矢量或文字公式需另行核查'], 'images': images}
        with (output / 'manifest.json').open('x', encoding='utf-8') as target:
            json.dump(manifest, target, ensure_ascii=False, indent=2)
        print(json.dumps({'status': 'sms_ready', 'publication_number': args.publication, 'candidates': len(images),
                          'needs_review': sum(image['status'] == 'needs_review' for image in images),
                          'mapping_verified': False, 'directory': str(output.resolve())}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'failed', 'error': str(error)}, ensure_ascii=False), file=sys.stderr, flush=True)
        raise SystemExit(1)
