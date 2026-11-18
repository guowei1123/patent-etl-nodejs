import importlib.util
import unittest
import hashlib
import cv2
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pymupdf
import numpy as np

spec = importlib.util.spec_from_file_location('figures', Path(__file__).resolve().parents[1] / 'pdf/figures.py')
figures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(figures)


class DrawingCleanupTests(unittest.TestCase):
    def test_saved_drawing_preserves_color(self):
        doc = pymupdf.open()
        page = doc.new_page(width=100, height=100)
        page.draw_rect(pymupdf.Rect(20, 20, 80, 80), color=(1, 0, 0), fill=(1, 0, 0))
        reader = SimpleNamespace(ocr_enabled=False)
        args = SimpleNamespace(dpi=150, clean_drawing=True)
        with patch.object(figures, 'drawing_regions', return_value=[(page.rect, '图1', 'test')]), \
             patch.object(Path, 'write_bytes', autospec=True, return_value=0) as write:
            figures.extract_figures(doc, [0], Path('unused'), 'CN1234567B', args, reader, drawing_only=True)
        decoded = cv2.imdecode(np.frombuffer(write.call_args.args[1], dtype=np.uint8), cv2.IMREAD_COLOR)
        self.assertGreater(int(decoded[:, :, 2].max()), 200)
        self.assertTrue(np.any((decoded[:, :, 2] > 200) & (decoded[:, :, 1] < 50) & (decoded[:, :, 0] < 50)))
        doc.close()
    def test_reuse_falls_back_when_cached_box_erases_entire_image(self):
        doc = pymupdf.open()
        page = doc.new_page(width=100, height=100)
        page.draw_rect(pymupdf.Rect(10, 10, 90, 70), width=2)
        pix = page.get_pixmap(dpi=150, colorspace=pymupdf.csGRAY, alpha=False)
        result = SimpleNamespace(boxes=np.array([]), txts=[])
        from unittest.mock import Mock
        engine = Mock(return_value=result)
        reader = SimpleNamespace(ocr_enabled=True, reuse_caption_ocr=True,
                                 caption_ocr_cache=(page.number, [(page.rect, '图1')]),
                                 ensure_engine=lambda: engine)
        cleaned = figures.clean_drawing_image(page, page.rect, pix, reader)
        engine.assert_called_once()
        self.assertGreater(cleaned.size, 0)
        doc.close()

    def test_caption_cache_is_used_only_for_the_same_page_and_nonempty_box(self):
        doc = pymupdf.open()
        page = doc.new_page(width=100, height=100)
        page.draw_rect(pymupdf.Rect(10, 10, 90, 70), width=2)
        pix = page.get_pixmap(dpi=150, colorspace=pymupdf.csGRAY, alpha=False)
        result = SimpleNamespace(boxes=np.array([]), txts=[])
        from unittest.mock import Mock
        engine = Mock(return_value=result)
        reader = SimpleNamespace(ocr_enabled=True, reuse_caption_ocr=True,
                                 caption_ocr_cache=(page.number, [(pymupdf.Rect(40, 80, 60, 90), '图1')]),
                                 ensure_engine=lambda: engine)
        figures.clean_drawing_image(page, page.rect, pix, reader)
        engine.assert_not_called()
        reader.caption_ocr_cache = (page.number + 1, [(pymupdf.Rect(40, 80, 60, 90), '图1')])
        figures.clean_drawing_image(page, page.rect, pix, reader)
        engine.assert_called_once()
        doc.close()

    def test_saved_drawing_hash_uses_written_bytes_without_reading_file(self):
        doc = pymupdf.open()
        page = doc.new_page(width=100, height=100)
        page.draw_rect(pymupdf.Rect(20, 20, 80, 80), width=2)
        reader = SimpleNamespace(ocr_enabled=False, profile={})
        args = SimpleNamespace(dpi=150, clean_drawing=True)
        with patch.object(figures, 'drawing_regions', return_value=[(page.rect, '图1', 'test')]), \
             patch.object(Path, 'write_bytes', autospec=True, return_value=0) as write, \
             patch.object(Path, 'read_bytes', side_effect=AssertionError('不应重新读取图片')):
            images = figures.extract_figures(doc, [0], Path('unused'), 'CN1234567B', args, reader, drawing_only=True)
        self.assertEqual(images[0]['content_hash'], hashlib.sha256(write.call_args.args[1]).hexdigest())
        self.assertTrue({'regions_ms', 'render_ms', 'clean_ms', 'save_ms'} <= reader.profile.keys())
        doc.close()

    def test_removes_caption_and_outer_whitespace_without_clipping_drawing(self):
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=600)
        page.draw_rect(pymupdf.Rect(60, 80, 340, 280), width=2)
        page.insert_text((190, 340), '图 3', fontname='china-s', fontsize=12)
        pix = page.get_pixmap(dpi=150, colorspace=pymupdf.csGRAY, alpha=False)
        clean = figures.clean_drawing_image(page, page.rect, pix, SimpleNamespace(ocr_enabled=False))
        self.assertGreater(clean.shape[1], 280 * 150 / 72)
        self.assertLess(clean.shape[0], 250 * 150 / 72)
        self.assertLess(clean.shape[1], pix.width)
        doc.close()


if __name__ == '__main__':
    unittest.main()
