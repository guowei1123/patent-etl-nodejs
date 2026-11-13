import importlib.util
import io
import json
import unittest
from pathlib import Path
from unittest.mock import mock_open, patch

spec = importlib.util.spec_from_file_location('repair_finalize', Path(__file__).resolve().parents[1] / 'pdf/repair-finalize.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def cell(name, value):
    return f'<c r="{name}" t="inlineStr"><is><t>{value}</t></is></c>'


def workbook_xml():
    header = ''.join(cell(f'{col}1', value) for col, value in zip('ABCD', ['公开号', '批次', '专利名称', '重名图片']))
    row2 = cell('A2', 'CN222254999U') + cell('B2', 'batch-a') + cell('C2', '专利') + cell('D2', 'FT_1.JPG')
    row3 = cell('A3', 'CN221220117U') + cell('B3', 'batch-b')
    return f'<worksheet><dimension ref="A1:D3"/><cols></cols><sheetData><row r="1">{header}</row><row r="2">{row2}</row><row r="3">{row3}</row></sheetData><autoFilter ref="A1:D3"/></worksheet>'.encode()


class FinalizeTests(unittest.TestCase):
    def test_does_not_touch_pdf_when_excel_update_fails(self):
        items = [{'number': 'CN1234567B', 'batch': 'batch', 'pdf_hash': '0' * 64}]
        with patch.object(module, 'update_workbook', side_effect=ValueError('Excel 无法写入')):
            with patch.object(module, 'PDF_DIR') as pdf_dir:
                with self.assertRaisesRegex(ValueError, 'Excel 无法写入'):
                    module.finalize(items)
                pdf_dir.__truediv__.assert_not_called()

    def test_syncs_notes_without_marked_patents(self):
        notes = {('CN222254999U', 'batch-a'): module.NO_PDF}
        storage = {('CN221220117U', 'batch-b')}
        with patch.object(module, 'update_workbook', return_value=(2, set(notes) | storage)) as update:
            result = module.finalize([], notes, storage)
        update.assert_called_once_with(set(), notes, storage)
        self.assertEqual(result['deleted'], 0)
        self.assertEqual(result['marked'], 0)

    def test_reads_candidates_directly_from_workbook_rows(self):
        rows = list(module.iter_candidate_rows(io.BytesIO(workbook_xml())))
        self.assertEqual(rows[0], {'publication_number': 'CN222254999U', 'batch': 'batch-a', 'image_names': ['FT_1.JPG'], 'repair_status': ''})
        self.assertEqual(len(rows), 2)

    def test_storage_note_survives_later_status_and_pdf_note_updates(self):
        target = io.BytesIO()
        module.rewrite_sheet(io.BytesIO(workbook_xml()), target, set(), storage_notes={('CN222254999U', 'batch-a')})
        self.assertIn('对象存储中附图不存在'.encode(), target.getvalue())
        self.assertIn(b'autoFilter ref="A1:G3"', target.getvalue())
        again = io.BytesIO()
        module.rewrite_sheet(io.BytesIO(target.getvalue()), again, {('CN222254999U', 'batch-a')}, {('CN221220117U', 'batch-b'): module.NO_PDF})
        self.assertIn('对象存储中附图不存在'.encode(), again.getvalue())
        self.assertIn(module.NO_PDF.encode(), again.getvalue())

    def test_marks_exact_publication_and_batch_and_preserves_other_rows(self):
        target = io.BytesIO()
        count, found = module.rewrite_sheet(io.BytesIO(workbook_xml()), target, {('CN222254999U', 'batch-a')})
        output = target.getvalue()
        self.assertEqual(count, 2)
        self.assertEqual(found, {('CN222254999U', 'batch-a')})
        self.assertIn('修复状态'.encode(), output)
        self.assertIn(b'<c r="E2"', output)
        self.assertNotIn(b'<c r="E3"', output)
        self.assertIn(b'<autoFilter ref="A1:E3"', output)

    def test_refuses_missing_batch_match(self):
        with self.assertRaisesRegex(ValueError, '未找到'):
            module.rewrite_sheet(io.BytesIO(workbook_xml()), io.BytesIO(), {('CN222254999U', 'wrong')})

    def test_rejects_existing_unrelated_status(self):
        xml = workbook_xml().replace(b'</row><row r="3">', cell('E2', '用户备注').encode() + b'</row><row r="3">')
        with self.assertRaisesRegex(ValueError, '其他内容'):
            module.rewrite_sheet(io.BytesIO(xml), io.BytesIO(), {('CN222254999U', 'batch-a')})

    def test_notes_preserve_previously_marked_rows_and_match_batch(self):
        xml = workbook_xml().replace(b'</row><row r="3">', cell('E2', module.MARK).encode() + b'</row><row r="3">')
        target = io.BytesIO()
        module.rewrite_sheet(io.BytesIO(xml), target, set(), {('CN221220117U', 'batch-b'): module.NO_PDF})
        output = target.getvalue().decode()
        self.assertIn(f'<c r="E2" t="inlineStr"><is><t>{module.MARK}</t></is></c>', output)
        self.assertIn(f'<c r="F3" t="inlineStr"><is><t>{module.NO_PDF}</t></is></c>', output)
        self.assertIn('PDF下载备注', output)
        self.assertIn('autoFilter ref="A1:F3"', output)

    def test_later_updates_preserve_existing_status_and_pdf_note(self):
        target = io.BytesIO()
        module.rewrite_sheet(io.BytesIO(workbook_xml()), target, set(), {('CN221220117U', 'batch-b'): module.NO_PDF})
        again = io.BytesIO()
        module.rewrite_sheet(io.BytesIO(target.getvalue()), again, {('CN222254999U', 'batch-a')})
        self.assertIn(module.NO_PDF.encode(), again.getvalue())

    def test_note_does_not_overwrite_existing_user_content(self):
        xml = workbook_xml().replace(b'</row><row r="3">', cell('F2', '用户备注').encode() + b'</row><row r="3">')
        with self.assertRaisesRegex(ValueError, '备注列已有其他内容'):
            module.rewrite_sheet(io.BytesIO(xml), io.BytesIO(), set(), {('CN222254999U', 'batch-a'): module.NO_PDF})

    def test_latest_report_distinguishes_missing_link_from_ambiguous_failure(self):
        records = [
            {'publication_number':'CN222254999U','batch':'b','status':'failed','error_code':'no_pdf_link'},
            {'publication_number':'CN221220117U','batch':'b','status':'failed','error':'Could not find a verified PDF download link for patent CN221220117U'},
            {'publication_number':'CN221220118U','batch':'b','status':'failed','error':'HTTP 403'},
            {'publication_number':'CN222254999U','batch':'b','status':'ready'},
        ]
        with patch.object(Path, 'open', mock_open(read_data='\n'.join(map(json.dumps, records)))):
            notes = module.notes_from_report(Path('unused'))
        self.assertEqual(notes, {('CN221220117U', 'b'): module.UNVERIFIED_PDF, ('CN222254999U', 'b'): None})


if __name__ == '__main__':
    unittest.main()
