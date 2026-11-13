import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace

import pymupdf

spec = importlib.util.spec_from_file_location('figures', Path(__file__).resolve().parents[1] / 'pdf/figures.py')
figures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(figures)


class DrawingCleanupTests(unittest.TestCase):
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
