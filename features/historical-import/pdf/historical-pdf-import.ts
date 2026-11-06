import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type pg from 'pg'
import type { putPatentImage } from '../../../lib/oss-client.ts'
import {
  parsePublicationNumber,
  readVerifiedImage,
  validateManifest,
  type PdfManifest,
} from './historical-pdf.ts'

export async function importPdfManifest(
  file: string,
  batch: string,
  commit: boolean,
  pool: pg.Pool,
  upload: typeof putPatentImage,
) {
  const manifest: PdfManifest = JSON.parse(await readFile(file, 'utf8'))
  validateManifest(manifest, batch)
  const publication = parsePublicationNumber(manifest.patent_number)
  const rows = await pool.query<{ id: string; app_number: string | null }>(
    `
    SELECT id, app_number FROM cnipa.patent
    WHERE upper(regexp_replace(doc_number, '\\s', '', 'g')) = ANY($1::text[]) AND upper(kind)=$2`,
    [
      [publication.number, `CN${publication.number}`, manifest.patent_number],
      publication.kind,
    ],
  )
  if (rows.rowCount !== 1)
    return {
      status: 'unmatched',
      number: manifest.patent_number,
      reason: '数据库没有唯一对应版本，先导入历史专利元数据',
    }
  const patent = rows.rows[0]
  if (publication.kind.startsWith('A') && patent.app_number) {
    const granted = await pool.query(
      "SELECT 1 FROM cnipa.patent WHERE app_number=$1 AND kind ~ '^[BC]' LIMIT 1",
      [patent.app_number],
    )
    if (granted.rowCount)
      return {
        status: 'superseded',
        number: manifest.patent_number,
        reason: '该申请已有授权版本，跳过申请版附图',
      }
  }
  // Verify every image even in preview mode. No database or object-store writes in preview.
  for (const image of manifest.images)
    await readVerifiedImage(path.dirname(file), image)
  if (!commit)
    return {
      status: 'ready',
      number: manifest.patent_number,
      images: manifest.images.length,
    }

  const client = await pool.connect()
  let imported = 0
  let skipped = 0
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM cnipa.patent WHERE id=$1 FOR UPDATE', [
      patent.id,
    ])
    for (const [order, image] of manifest.images.entries()) {
      const existing = await client.query(
        `SELECT p.id FROM cnipa.historical_pdf_image h
        JOIN cnipa.patent_image p ON p.id=h.image_id
        WHERE h.patent_id=$1 AND h.pdf_hash=$2 AND h.page_number=$3`,
        [patent.id, manifest.pdf_hash, image.page],
      )
      if (existing.rowCount) {
        skipped++
        continue
      }
      const content = await readVerifiedImage(path.dirname(file), image)
      const key = `patents/${batch}/${manifest.patent_number}/${manifest.pdf_hash}/${image.file_name}`
      await upload(key, content, 'image/png')
      const asset = await client.query<{ id: string }>(
        `INSERT INTO cnipa.image_asset
        (oss_key,content_hash,content_type,size,width,height) VALUES ($1,$2,'image/png',$3,$4,$5)
        ON CONFLICT (oss_key) DO UPDATE SET content_hash=EXCLUDED.content_hash,size=EXCLUDED.size,width=EXCLUDED.width,height=EXCLUDED.height RETURNING id`,
        [key, image.content_hash, content.length, image.width, image.height],
      )
      const result = await client.query<{ id: string }>(
        `INSERT INTO cnipa.patent_image
        (patent_id,asset_id,file_name,oss_key,content_type,size,width,height,is_abstract,image_role,figure_label,source_section,sort_order)
        VALUES ($1,$2,$3,$4,'image/png',$5,$6,$7,false,'drawing',$8,'PDF',$9) RETURNING id`,
        [
          patent.id,
          asset.rows[0].id,
          image.file_name,
          key,
          content.length,
          image.width,
          image.height,
          image.figure_label,
          order,
        ],
      )
      await client.query(
        `INSERT INTO cnipa.historical_pdf_image
        (patent_id,pdf_hash,page_number,image_id,batch_code,source_file,extraction_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          patent.id,
          manifest.pdf_hash,
          image.page,
          result.rows[0].id,
          batch,
          manifest.source,
          manifest.version,
        ],
      )
      imported++
    }
    await client.query('COMMIT')
    return {
      status: imported ? 'imported' : 'skipped',
      number: manifest.patent_number,
      images: imported,
      skipped,
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
