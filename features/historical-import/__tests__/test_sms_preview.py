import importlib.util
import io
import unittest
from pathlib import Path

import pymupdf
from PIL import Image

spec = importlib.util.spec_from_file_location('sms_preview', Path(__file__).resolve().parents[1] / 'pdf/sms-preview.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SmsPreviewTests(unittest.TestCase):
    def test_extracts_same_line_context_and_rejects_neighbor_images(self):
        doc = pymupdf.open()
        page = doc.new_page(width=595, height=842)
        page.insert_text((50, 100), 'abcdefgh', fontsize=10)
        page.insert_text((120, 100), 'ijklmnop', fontsize=10)
        box = pymupdf.Rect(105, 90, 115, 102)
        context = module.image_text_context(page, box)
        self.assertEqual(context, {'before': 'abcdefgh', 'after': 'ijklmnop'})
        self.assertIsNone(module.image_text_context(page, box, [box, pymupdf.Rect(117, 90, 119, 102)]))
        doc.close()

    def test_keeps_small_symbols_and_repeated_occurrences_excludes_footer(self):
        doc = pymupdf.open()
        page = doc.new_page(width=595, height=842)
        page.insert_text((240, 40), '说明书', fontname='china-s')
        bitmap = io.BytesIO()
        Image.new('RGB', (12, 12), 'black').save(bitmap, format='PNG')
        for rect in [pymupdf.Rect(100, 100, 110, 110), pymupdf.Rect(200, 100, 210, 110), pymupdf.Rect(250, 780, 260, 790)]:
            page.insert_image(rect, stream=bitmap.getvalue())
        found = list(module.candidates(doc))
        self.assertEqual(len(found), 2)
        self.assertEqual([int(rect.x0) for _, rect, _, _ in found], [100, 200])
        content, size = module.jpeg_bytes(doc, found[0][2], found[0][3])
        self.assertEqual(Image.open(io.BytesIO(content)).format, 'JPEG')
        self.assertEqual(size, (12, 12))
        doc.close()

    def test_excludes_drawing_pages(self):
        doc = pymupdf.open()
        page = doc.new_page(width=595, height=842)
        page.insert_text((240, 40), '说明书附图', fontname='china-s')
        bitmap = io.BytesIO()
        Image.new('RGB', (12, 12), 'black').save(bitmap, format='PNG')
        page.insert_image(pymupdf.Rect(100, 100, 110, 110), stream=bitmap.getvalue())
        self.assertEqual(list(module.candidates(doc)), [])
        doc.close()


if __name__ == '__main__':
    unittest.main()
