import importlib.util
import unittest
from unittest.mock import patch, mock_open, MagicMock
from pathlib import Path

import requests
import pymupdf
from patent_downloader.exceptions import PatentNotFoundError

spec = importlib.util.spec_from_file_location(
    'repair_download', Path(__file__).resolve().parents[1] / 'pdf/repair-download.py'
)
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


def response(html):
    result = requests.Response()
    result.status_code = 200
    result.url = 'https://patents.google.com/patent/CN222254999U/en'
    result._content = html.encode('utf-8')
    return result


class RepairDownloadTests(unittest.TestCase):
    def test_batch_prioritizes_but_does_not_replace_application_versions(self):
        lines = '\n'.join(['{"publication_number":"CN116661005A"}',
                           '{"publication_number":"CN116661005B"}',
                           '{"publication_number":"CN222254999U"}'])
        with patch.object(Path, 'open', mock_open(read_data=lines)):
            values = [item['publication_number'] for item in repair.candidates(Path('unused'), set())]
        self.assertEqual(values, ['CN116661005B', 'CN116661005A', 'CN222254999U'])

    def test_grant_cover_prefers_actual_publication_over_earlier_application(self):
        doc = pymupdf.open()
        page = doc.new_page(width=600, height=800)
        page.insert_text((40, 220), 'CN 116661005 A')
        page.insert_text((420, 100), 'CN 116661005 B')
        self.assertEqual(repair.extractor.publication_number_on_page(page, page.get_text()), 'CN116661005B')
        doc.close()

    def test_ambiguous_cover_does_not_guess_version(self):
        doc = pymupdf.open()
        page = doc.new_page(width=600, height=800)
        page.insert_text((40, 220), 'CN 116661005 A')
        page.insert_text((40, 260), 'CN 116661005 B')
        with self.assertRaisesRegex(ValueError, '多个文献号'):
            repair.extractor.publication_number_on_page(page, page.get_text())
        doc.close()

    def test_no_published_pdf_does_not_probe_guessed_endpoints(self):
        downloader = repair.PagePdfDownloader()
        page = response('<html><body>Patent without PDF</body></html>')
        self.assertEqual(downloader._build_pdf_candidate_urls(page, 'CN222254999U'), [])
        with self.assertRaisesRegex(PatentNotFoundError, '未提供 PDF'):
            downloader._retrieve_pdf_link('CN222254999U', page)

    def test_accepts_published_pdf_and_rejects_unrelated_hosts(self):
        downloader = repair.PagePdfDownloader()
        page = response('<meta name="citation_pdf_url" content="https://patentimages.storage.googleapis.com/a/b.pdf">'
                        '<a href="https://example.com/other.pdf">PDF</a>')
        self.assertEqual(downloader._build_pdf_candidate_urls(page, 'CN222254999U'),
                         ['https://patentimages.storage.googleapis.com/a/b.pdf'])

    def test_rate_limit_found_in_exception_chain(self):
        r = requests.Response()
        r.status_code = 429
        source = requests.HTTPError(response=r)
        wrapper = RuntimeError('request failed')
        wrapper.__cause__ = source
        self.assertTrue(repair.is_rate_limited(wrapper))
        self.assertFalse(repair.is_rate_limited(ValueError('other failure')))

    def test_existing_pdf_link_reports_actual_http_failure(self):
        downloader = repair.PagePdfDownloader()
        page = response('<meta name="citation_pdf_url" content="https://patentimages.storage.googleapis.com/a/b.pdf">')
        failed = MagicMock()
        failed.__enter__.return_value = failed
        failed.ok = False
        failed.status_code = 403
        downloader.session.get = MagicMock(return_value=failed)
        with self.assertRaisesRegex(PatentNotFoundError, 'HTTP 403'):
            downloader._retrieve_pdf_link('CN222254999U', page)

    def test_existing_pdf_link_is_accepted_by_pdf_signature(self):
        downloader = repair.PagePdfDownloader()
        url = 'https://patentimages.storage.googleapis.com/a/b.pdf'
        page = response(f'<meta name="citation_pdf_url" content="{url}">')
        downloaded = MagicMock()
        downloaded.__enter__.return_value = downloaded
        downloaded.ok = True
        downloaded.status_code = 200
        downloaded.url = url
        downloaded.iter_content.return_value = iter([b'%PDF-1.4'])
        downloader.session.get = MagicMock(return_value=downloaded)
        self.assertEqual(downloader._retrieve_pdf_link('CN222254999U', page), url)


if __name__ == '__main__':
    unittest.main()
