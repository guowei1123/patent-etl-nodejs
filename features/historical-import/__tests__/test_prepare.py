"""Integration fixtures stay under data/historical-import/validation for review."""
import importlib.util
import json
import unittest
import zipfile
import tarfile
from pathlib import Path

import duckdb
import openpyxl
import pymupdf
import numpy as np
from types import SimpleNamespace

MODULE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("history_prepare", MODULE / "prepare.py")
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)
ROOT = Path(__file__).resolve().parents[3] / "data/historical-import/validation"


def fixture(name, metadata, body_numbers):
    root = ROOT / name
    root.mkdir(parents=True, exist_ok=True)
    pdf_dir = root / 'pdf'
    pdf_dir.mkdir(exist_ok=True)
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.append(['pub', 'app', 'title', 'date', 'grant', 'grantDate'])
    for row in metadata:
        sheet.append(row)
    book.save(root / 'metadata.xlsx')
    engine = duckdb.connect()
    for section in ['description', 'claims']:
        engine.execute('CREATE OR REPLACE TABLE documents(pub VARCHAR, body VARCHAR)')
        for number in body_numbers:
            engine.execute('INSERT INTO documents VALUES (?,?)', [number, section + ' version ' + number])
        engine.table('documents').write_parquet(str(root / (section + '.parquet')))
    engine.close()
    for number in body_numbers:
        document = pymupdf.open()
        page = document.new_page()
        page.insert_text((40, 40), number)
        page = document.new_page()
        page.insert_text((40, 40), '说明书附图', fontname='china-s')
        page.draw_rect(pymupdf.Rect(100, 100, 300, 300))
        document.save(pdf_dir / (number + '.pdf'))
        document.close()
    config = dict(excelPath=str(root / 'metadata.xlsx'), descriptionPath=str(root / 'description.parquet'),
                  claimsPath=str(root / 'claims.parquet'), pdfPath=str(pdf_dir), sheet='',
                  columns=dict(publication='pub', application='app', title='title', date='date', grant='grant',
                               grantDate='grantDate', abstract='', applicant='', inventor='', ipc=''),
                  descriptionKey='pub', descriptionText='body', claimsKey='pub', claimsText='body',
                  limit=100, beforeDate='2023-01-01', cleanupApplications=True, ocr=False, noDrawingNumbers=[])
    output = root / 'output'
    output.mkdir(exist_ok=True)
    (root / 'config.json').write_text(json.dumps(config), encoding='utf-8')
    return root, config, output


class HistoryPrepareTests(unittest.TestCase):
    def test_utility_model_full_pipeline_keeps_kind_and_exact_key(self):
        for kind in ['U', 'Y']:
            number = 'CN201234567' + kind
            _, config, output = fixture('utility-' + kind, [
                [number, '200820058724.8', '实用新型', '2008-01-01', number, '2008-01-01'],
            ], [number])
            prepare.prepare(config, output)
            record = json.loads((output / 'records.jsonl').read_text(encoding='utf-8'))
            self.assertEqual(record['status'], 'ready')
            self.assertEqual(record['publication'], number)
            self.assertEqual(record['kind'], kind)
            self.assertIn(number, record['description'])
            self.assertIn(number, record['claims'])
            config.update(stage='text', excelPath='', pdfPath='')
            prepare.requested_numbers(config, output)
            self.assertEqual(json.loads((output / 'requested.jsonl').read_text()), number)

    def test_metadata_stage_needs_no_parquet_or_pdf(self):
        _, config, output = fixture('stage-metadata', [
            ['CN1577321B', '200410058724.8', '授权版', '2008-01-01', '', ''],
        ], [])
        config.update(stage='metadata', descriptionPath='', claimsPath='', pdfPath='')
        prepare.prepare(config, output)
        record = json.loads((output / 'records.jsonl').read_text(encoding='utf-8'))
        self.assertEqual(record['status'], 'ready')
        self.assertEqual(record['description'], '')
        self.assertNotIn('pdfManifest', record)

    def test_excel_publication_only_creates_distinct_partial_candidates(self):
        root, config, output = fixture('metadata-publication-only', [], [])
        book = openpyxl.Workbook()
        sheet = book.active
        sheet.append(['pub'])
        sheet.append(['CN999999999991B'])
        sheet.append(['CN999999999992B'])
        book.save(root/'metadata.xlsx')
        book.close()
        config.update(stage='metadata',descriptionPath='',claimsPath='',pdfPath='')
        prepare.prepare(config, output)
        rows = [json.loads(line) for line in (output/'records.jsonl').read_text(encoding='utf-8').splitlines()]
        self.assertEqual(len(rows),2)
        self.assertTrue(all(r['status']=='ready' and r['metadataPending'] for r in rows))
        self.assertTrue(all(r['application']=='' and r['date']=='' and r['title']=='' for r in rows))

    def stage_fixture(self, name):
        root, config, output = fixture(name, [
            ['CN1577321B', '200410058724.8', '授权版', '2008-01-01', '', ''],
        ], ['CN1577321B'])
        config['stage'] = 'metadata'
        prepare.prepare(config, output)
        (output / 'database-records.jsonl').write_text((output / 'records.jsonl').read_text(encoding='utf-8'), encoding='utf-8')
        return root, config, output

    def test_description_only_stage_uses_database_key(self):
        _, config, output = self.stage_fixture('stage-description')
        config.update(stage='text', excelPath='', claimsPath='', pdfPath='')
        prepare.requested_numbers(config, output)
        self.assertEqual(json.loads((output / 'requested.jsonl').read_text()), 'CN1577321B')
        prepare.prepare(config, output)
        record = json.loads((output / 'records.jsonl').read_text(encoding='utf-8'))
        self.assertEqual(record['status'], 'ready')
        self.assertIn('CN1577321B', record['description'])
        self.assertEqual(record['claims'], '')

    def test_archive_unpacked_before_image_extraction(self):
        root, config, output = self.stage_fixture('stage-zip')
        archive = root / 'export-2024.zip'
        with zipfile.ZipFile(archive, 'w') as package:
            package.write(root / 'pdf/CN1577321B.pdf', 'nested/CN1577321B.pdf')
        config.update(stage='images', excelPath='', descriptionPath='', claimsPath='', pdfPath=str(archive))
        prepare.requested_numbers(config, output)
        prepare.prepare(config, output)
        record = json.loads((output / 'records.jsonl').read_text(encoding='utf-8'))
        self.assertEqual(record['status'], 'ready')
        self.assertTrue(list((output / 'unpacked').rglob('CN1577321B.pdf')))
        self.assertIn('export-2024.zip::nested/', json.loads(Path(record['pdfManifest']).read_text(encoding='utf-8'))['source'])
        archive_tar = root / 'documents.tar.gz'
        with tarfile.open(archive_tar,'w:gz') as package:
            package.add(root / 'pdf/CN1577321B.pdf',arcname='nested/CN1577321B.pdf')
        entries = list(prepare.pdf.prepared_pdf_entries(archive_tar,9999,100*1024**2,output/'unpacked-tar',{'CN1577321B'}))
        self.assertEqual(len(entries),1)
        self.assertTrue(list((output/'unpacked-tar').rglob('*.pdf')))

    def test_unsafe_archive_member_rejected(self):
        root, _, output = self.stage_fixture('stage-unsafe')
        archive = root / 'unsafe.zip'
        with zipfile.ZipFile(archive, 'w') as package:
            package.write(root / 'pdf/CN1577321B.pdf', '../CN1577321B.pdf')
        with self.assertRaisesRegex(ValueError, '成员路径不安全'):
            list(prepare.pdf.prepared_pdf_entries(archive,9999,100*1024**2,output/'unpacked',{'CN1577321B'}))

    def test_abstract_and_drawing_regions_retained(self):
        root, config, output = self.stage_fixture('stage-figures')
        document = pymupdf.open()
        for role in ['摘要附图','说明书附图']:
            page = document.new_page()
            page.insert_text((40,40),'CN1577321B')
            page.insert_text((40,60),role,fontname='china-s')
            page.draw_rect(pymupdf.Rect(100,400,300,600))
            page.draw_line(pymupdf.Point(100,400),pymupdf.Point(300,600))
        document.save(root/'figures.pdf')
        document.close()
        config.update(stage='images',excelPath='',descriptionPath='',claimsPath='',pdfPath=str(root/'figures.pdf'))
        # A PDF filename must contain its complete publication number.
        args = prepare.argparse.Namespace(output=str(output/'images'),batch='HISTORY',dpi=300,pages=None,max_pages=500,before_year=9999,save_pdf=False,figures=True)
        manifest = prepare.pdf.extract((root/'figures.pdf').read_bytes(),'CN1577321B.pdf','fixture',args,prepare.pdf.TextReader(False))
        self.assertEqual({image['image_role'] for image in manifest['images']},{'abstract','drawing'})
        self.assertEqual(len(manifest['images']),2)

    def extract_fixture(self, doc, name):
        output = ROOT / name
        args = prepare.argparse.Namespace(output=str(output), batch='HISTORY', dpi=120,
                                         pages=None,max_pages=500,before_year=9999,save_pdf=False,figures=True)
        return prepare.pdf.extract(doc.tobytes(), 'CN1577321B.pdf', 'fixture', args, prepare.pdf.TextReader(False))

    def test_top_crossing_figure_and_footer_number(self):
        doc = pymupdf.open()
        page = doc.new_page(width=595,height=842)
        page.insert_text((40,40),'CN1577321B')
        page.insert_text((240,40),'说明书附图',fontname='china-s')
        # Reproduce the real PDF: real image begins at y=63, footer at y=774.
        raster = pymupdf.open()
        graphic = raster.new_page(width=400,height=650)
        graphic.draw_rect(pymupdf.Rect(10,10,380,630))
        graphic.draw_line((20,20),(350,600))
        page.insert_image(pymupdf.Rect(98,63,496,711),stream=graphic.get_pixmap().tobytes('png'))
        graphic.insert_text((160,200),'160',fontsize=30)
        page.insert_image(pymupdf.Rect(217,774,337,788),stream=graphic.get_pixmap().tobytes('png'))
        result = self.extract_fixture(doc,'figure-footer-regression')
        drawings = [i for i in result['images'] if i['image_role']=='drawing']
        self.assertEqual(len(drawings),1)
        self.assertLessEqual(drawings[0]['bbox'][1],63)
        self.assertGreaterEqual(drawings[0]['bbox'][3],711)
        self.assertLess(drawings[0]['bbox'][3],774)
        self.assertGreater(drawings[0]['height'],1000)
        doc.close()
        raster.close()

    def test_body_only_table_formula_and_vector_structure(self):
        doc = pymupdf.open()
        page = doc.new_page()
        page.insert_text((40,40),'CN1577321B')
        page.insert_text((240,40),'说明书',fontname='china-s')
        for x in [100,200,300]:
            page.draw_line((x,150),(x,250))
        for y in [150,200,250]:
            page.draw_line((100,y),(300,y))
        page.insert_text((110,175),'A')
        page.insert_text((210,175),'B')
        page.insert_text((110,225),'1')
        page.insert_text((210,225),'2')
        page.insert_text((150,350),'E = mc2',fontsize=16)
        points = [(160,480),(200,460),(240,480),(240,520),(200,540),(160,520),(160,480)]
        for start,end in zip(points,points[1:]):
            page.draw_line(start,end)
        result = self.extract_fixture(doc,'body-graphics-regression')
        roles = {i['image_role'] for i in result['images']}
        self.assertEqual(result['status'],'extracted')
        self.assertTrue({'table','formula','body_figure'}.issubset(roles))
        self.assertNotIn('drawing',roles)
        doc.close()

    def test_multiple_figures_on_one_page_split_with_captions(self):
        for horizontal in [False, True]:
            doc = pymupdf.open()
            page = doc.new_page(width=595,height=842)
            page.insert_text((40,40),'CN1577321B')
            page.insert_text((240,40),'说明书附图',fontname='china-s')
            boxes = [pymupdf.Rect(70,110,240,290),pymupdf.Rect(350,110,520,290)] if horizontal else [pymupdf.Rect(130,100,430,300),pymupdf.Rect(130,420,430,650)]
            for number,box in enumerate(boxes,7):
                page.draw_rect(box)
                page.draw_line(box.top_left,box.bottom_right)
                page.insert_text((box.x0+60,box.y1+25),'图'+str(number),fontname='china-s')
            result = self.extract_fixture(doc,'multi-figure-horizontal' if horizontal else 'multi-figure-vertical')
            images = [i for i in result['images'] if i['image_role']=='drawing']
            self.assertEqual(len(images),2)
            self.assertEqual({i['figure_label'] for i in images},{'图7','图8'})
            self.assertTrue(all(i['page']==1 and i['extraction_method']=='figure-caption-region' for i in images))
            first,second = sorted(images,key=lambda i:i['bbox'][0 if horizontal else 1])
            self.assertLessEqual(first['bbox'][2 if horizontal else 3],second['bbox'][0 if horizontal else 1])
            doc.close()

    def test_three_figures_keep_body_with_caption_across_wide_gap(self):
        doc = pymupdf.open()
        page = doc.new_page(width=595,height=842)
        page.insert_text((240,40),'说明书附图',fontname='china-s')
        boxes = [pymupdf.Rect(100,80,480,200),pymupdf.Rect(100,310,480,440),pymupdf.Rect(120,560,460,690)]
        for label,box,y in zip(['图2B','图2C','图3'],boxes,[260,520,735]):
            page.draw_rect(box)
            page.draw_line(box.top_left,box.bottom_right)
            page.insert_text((270,y),label,fontname='china-s')
        images = self.extract_fixture(doc,'three-caption-wide-gap')['images']
        self.assertEqual(len(images),3)
        for image,box in zip(sorted(images,key=lambda i:i['bbox'][1]),boxes):
            crop = pymupdf.Rect(image['bbox'])
            self.assertTrue(crop.contains(box))
        self.assertEqual({i['figure_label'] for i in images},{'图2B','图2C','图3'})
        doc.close()

    def test_mixed_columns_and_full_width_figure(self):
        doc = pymupdf.open()
        page = doc.new_page(width=595,height=842)
        page.insert_text((240,40),'说明书附图',fontname='china-s')
        boxes = [pymupdf.Rect(60,100,240,300),pymupdf.Rect(350,120,535,330),pymupdf.Rect(80,450,510,670)]
        for n,box in enumerate(boxes,1):
            page.draw_rect(box)
            page.draw_line(box.top_left,box.bottom_right)
            page.insert_text(((box.x0+box.x1)/2-10,box.y1+30),'图'+str(n),fontname='china-s')
        images = self.extract_fixture(doc,'mixed-column-captions')['images']
        self.assertEqual(len(images),3)
        for n,box in enumerate(boxes,1):
            image = next(i for i in images if i['figure_label']=='图'+str(n))
            self.assertTrue(pymupdf.Rect(image['bbox']).contains(box))
        doc.close()

    def test_connected_cross_column_drawing_falls_back_without_clipping(self):
        doc = pymupdf.open()
        page = doc.new_page(width=595,height=842)
        page.insert_text((240,40),'说明书附图',fontname='china-s')
        box = pymupdf.Rect(60,100,530,300)
        page.draw_rect(box)
        page.draw_line(box.top_left,box.bottom_right)
        page.insert_text((140,330),'图1',fontname='china-s')
        page.insert_text((420,330),'图2',fontname='china-s')
        images = self.extract_fixture(doc,'cross-column-fallback')['images']
        self.assertEqual(len(images),1)
        self.assertEqual(images[0]['extraction_method'],'drawing-page-body')
        self.assertTrue(pymupdf.Rect(images[0]['bbox']).contains(box))
        doc.close()

    def test_same_figure_panels_keep_one_complete_image(self):
        doc = pymupdf.open()
        page = doc.new_page()
        page.insert_text((40,40),'CN1577321B')
        page.insert_text((240,40),'说明书附图',fontname='china-s')
        for y in [100,450]:
            page.draw_rect(pymupdf.Rect(130,y,430,y+180))
            page.insert_text((270,y+205),'图1',fontname='china-s')
        result = self.extract_fixture(doc,'same-figure-panels')
        self.assertEqual(len(result['images']),1)
        self.assertEqual(result['images'][0]['extraction_method'],'drawing-page-body')
        doc.close()

    def test_large_gap_before_caption_does_not_isolate_caption(self):
        doc = pymupdf.open()
        page = doc.new_page()
        page.insert_text((40,40),'CN1577321B')
        page.insert_text((240,40),'说明书附图',fontname='china-s')
        page.draw_rect(pymupdf.Rect(130,100,430,250))
        page.insert_text((270,275),'图7',fontname='china-s')
        page.draw_rect(pymupdf.Rect(130,330,430,580))
        page.insert_text((270,730),'图8',fontname='china-s')
        result = self.extract_fixture(doc,'caption-gap-regression')
        self.assertEqual(len(result['images']),2)
        second = next(i for i in result['images'] if i['figure_label']=='图8')
        self.assertLessEqual(second['bbox'][1],330)
        self.assertGreaterEqual(second['bbox'][3],730)
        doc.close()

    def test_caption_anchors_split_without_wide_blank_gutter(self):
        doc = pymupdf.open()
        page = doc.new_page()
        page.insert_text((40,40),'CN1577321B')
        page.insert_text((240,40),'说明书附图',fontname='china-s')
        for number,top in [(7,100),(8,294)]:
            page.draw_rect(pymupdf.Rect(130,top,430,top+180))
            page.insert_text((270,top+190),'图'+str(number),fontname='china-s',fontsize=5)
        result = self.extract_fixture(doc,'caption-anchor-tight-gap')
        self.assertEqual(len(result['images']),2)
        self.assertEqual({i['figure_label'] for i in result['images']},{'图7','图8'})
        self.assertTrue(all(i['extraction_method']=='figure-caption-region' for i in result['images']))
        doc.close()

    def test_figure_subnames_are_distinct_and_body_rules_unchanged(self):
        doc = pymupdf.open()
        page = doc.new_page()
        page.insert_text((40,40),'CN1577321B')
        page.insert_text((240,40),'说明书附图',fontname='china-s')
        for label,top in [('图1(a)',100),('图1(b)',450)]:
            page.draw_rect(pymupdf.Rect(130,top,430,top+180))
            page.insert_text((270,top+205),label,fontname='china-s')
        result = self.extract_fixture(doc,'caption-subnames')
        self.assertEqual({i['figure_label'] for i in result['images']},{'图1(a)','图1(b)'})
        doc.close()

    def test_partial_text_layer_is_completed_by_ocr(self):
        doc = pymupdf.open()
        page = doc.new_page(width=595,height=842)
        page.insert_text((40,40),'CN1577321B')
        page.insert_text((240,40),'说明书附图',fontname='china-s')
        for top in [100,420]:
            page.draw_rect(pymupdf.Rect(130,top,430,top+180))
        page.insert_text((270,305),'图7',fontname='china-s')
        # The second caption is absent from the native text layer.
        page.draw_rect(pymupdf.Rect(270,615,290,625))
        reader = prepare.pdf.TextReader(True)
        clip_height = 842*(.91-.07)
        sx,sy = 992/595,1180/clip_height
        box = np.array([[(270*sx,(615-842*.07)*sy),(290*sx,(615-842*.07)*sy),
                         (290*sx,(625-842*.07)*sy),(270*sx,(625-842*.07)*sy)]])
        called = []
        def recognize(pixels):
            called.append(True)
            return SimpleNamespace(boxes=box,txts=['图8'])
        reader.ensure_engine = lambda: recognize
        args = prepare.argparse.Namespace(output=str(ROOT/'caption-partial-text'),batch='HISTORY',dpi=120,
                                         pages=None,max_pages=500,before_year=9999,save_pdf=False,figures=True)
        result = prepare.pdf.extract(doc.tobytes(),'CN1577321B.pdf','fixture',args,reader)
        self.assertTrue(called)
        self.assertEqual({i['figure_label'] for i in result['images']},{'图7','图8'})
        doc.close()

    def test_grant_selected_before_limit_and_joins_exact_version(self):
        _, config, output = fixture('grant', [
            ['CN1577321A', '200410058724.8', '申请版', '2005-01-26', 'CN1577321B', '2008-01-01'],
            ['CN1577321B', '200410058724.8', '授权版', '2008-01-01', 'CN1577321B', '2008-01-01'],
        ], ['CN1577321A', 'CN1577321B'])
        config['limit'] = 1
        prepare.prepare(config, output)
        rows = [json.loads(line) for line in (output / 'records.jsonl').read_text(encoding='utf-8').splitlines()]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['publication'], 'CN1577321B')
        self.assertEqual(rows[0]['status'], 'ready')
        self.assertIn('CN1577321B', rows[0]['description'])
        self.assertNotIn('CN1577321A', rows[0]['claims'])
        self.assertFalse(list((output / 'images').rglob('*.pdf')))

    def test_application_body_cannot_fill_grant(self):
        _, config, output = fixture('missing-grant', [
            ['CN1577321B', '200410058724.8', '授权版', '2008-01-01', 'CN1577321B', '2008-01-01'],
        ], ['CN1577321A'])
        prepare.prepare(config, output)
        record = json.loads((output / 'records.jsonl').read_text(encoding='utf-8'))
        self.assertEqual(record['status'], 'blocked')
        self.assertEqual(record['description'], '')
        self.assertEqual(record['claims'], '')

    def test_known_grant_without_metadata_preserves_application_until_grant_complete(self):
        _, config, output = fixture('known-grant', [
            ['CN1577321A', '200410058724.8', '申请版', '2005-01-26', 'CN1577321B', '2008-01-01'],
        ], ['CN1577321A'])
        prepare.prepare(config, output)
        record = json.loads((output / 'records.jsonl').read_text(encoding='utf-8'))
        self.assertEqual(record['status'], 'ready')

    def test_text_first_keeps_all_publications_without_application(self):
        _, config, output = fixture('text-first', [], ['CN1577321A', 'CN1577321B'])
        config.update(stage='text', excelPath='', pdfPath='')
        records = [dict(publication=number,kind=number[-1],application='',date='',title='',abstract='',grant='',grantDate='',raw={},source='publication:'+number) for number in ['CN1577321A','CN1577321B']]
        (output/'database-records.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in records),encoding='utf-8')
        prepare.prepare(config, output)
        rows = [json.loads(line) for line in (output/'records.jsonl').read_text(encoding='utf-8').splitlines()]
        self.assertEqual({r['publication'] for r in rows},{'CN1577321A','CN1577321B'})
        self.assertTrue(all(r['status']=='ready' and r['metadataPending'] for r in rows))
        for row in rows:
            self.assertIn(row['publication'],row['description'])
            self.assertIn(row['publication'],row['claims'])

    def test_pdf_first_extracts_archive_without_metadata(self):
        number = 'CN999999999991B'
        root, config, output = fixture('pdf-first', [], [number])
        archive = root/'pdf-first.zip'
        with zipfile.ZipFile(archive,'w') as package:
            package.write(root/'pdf'/f'{number}.pdf',f'{number}.pdf')
        config.update(stage='images',excelPath='',descriptionPath='',claimsPath='',pdfPath=str(archive))
        record = dict(publication=number,kind='B',application='',date='',title='',abstract='',grant='',grantDate='',raw={},source='publication:'+number)
        (output/'database-records.jsonl').write_text(json.dumps(record)+'\n',encoding='utf-8')
        prepare.prepare(config, output)
        record = json.loads((output/'records.jsonl').read_text(encoding='utf-8'))
        self.assertEqual(record['status'],'ready')
        self.assertTrue(record['metadataPending'])
        self.assertTrue(Path(record['pdfManifest']).is_file())

    def test_metadata_all_publications_fill_existing_partial_versions(self):
        _, config, output = fixture('metadata-all-versions', [
            ['CN1577321A','200410058724.8','申请版','2005-01-26','CN1577321B','2008-01-01'],
            ['CN1577321B','200410058724.8','授权版','2008-01-01','CN1577321B','2008-01-01'],
        ], [])
        config.update(stage='metadata',descriptionPath='',claimsPath='',pdfPath='')
        prepare.prepare(config,output)
        rows = [json.loads(line) for line in (output/'records.jsonl').read_text(encoding='utf-8').splitlines()]
        self.assertEqual({r['publication'] for r in rows},{'CN1577321A','CN1577321B'})
        self.assertTrue(all(r['status']=='ready' for r in rows))

    def test_pdf_date_and_original_figure_filename(self):
        self.assertEqual(prepare.pdf.publication_date('(22)申请日 2004.01.01\n(43)申请公布日 2008.01.02'), '2008-01-02')
        self.assertEqual(prepare.pdf.publication_date('(45)授权公告日 2009年2月3日'), '2009-02-03')
        self.assertIsNone(prepare.pdf.publication_date('(22)申请日 2004.01.01'))
        with self.assertRaises(ValueError):
            prepare.pdf.publication_date('公布日 2008.02.30')
        doc = pymupdf.open()
        page = doc.new_page()
        page.insert_text((40,40),'CN1577321A')
        page.insert_text((40,60),'申请公布日',fontname='china-s')
        page.insert_text((40,90),'申请日 2004.01.01',fontname='china-s')
        # The labelled value is a later PDF object on the same visual line.
        page.insert_text((130,60),'2008.01.02')
        page = doc.new_page()
        page.insert_text((240,40),'说明书附图',fontname='china-s')
        for label,top in [('图1A',100),('图1B',420)]:
            page.draw_rect(pymupdf.Rect(130,top,430,top+180))
            page.insert_text((270,top+210),label,fontname='china-s')
        args = prepare.argparse.Namespace(output=str(ROOT/'pdf-date-names'),batch='HISTORY',dpi=120,pages=None,max_pages=500,before_year=9999,save_pdf=False,figures=True)
        result = prepare.pdf.extract(doc.tobytes(),'CN1577321A.pdf','fixture',args,prepare.pdf.TextReader(False))
        self.assertEqual(result['publication_date'],'2008-01-02')
        self.assertEqual(result['announcement_batch'],'CN-PA-TXTS-10-A-20080102')
        self.assertIn(result['announcement_batch'],result['directory'])
        self.assertEqual({i['file_name'] for i in result['images']},{'说明书-图1A.png','说明书-图1B.png'})
        doc.close()

    def test_number_and_date_validation(self):
        self.assertEqual(prepare.publication(' cn 1577321 b '), 'CN1577321B')
        self.assertEqual(prepare.application('CN200410058724.8'), 'CN200410058724')
        self.assertEqual(prepare.application('200410058724'), 'CN200410058724')
        with self.assertRaises(ValueError):
            prepare.application(200410058724.8)
        with self.assertRaises(ValueError):
            prepare.publication('1577321')
        with self.assertRaises(ValueError):
            prepare.date('2020-02-30')


if __name__ == '__main__':
    unittest.main()
