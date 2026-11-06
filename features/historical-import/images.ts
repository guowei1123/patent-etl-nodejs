import type pg from 'pg'
import { matchPatentAbstractToDrawing } from '../../lib/patent-image-matcher.ts'
import type { PdfManifest } from './pdf/historical-pdf.ts'
import type { putPatentImage } from '../../lib/oss-client.ts'

export async function imageAssetPlan(
  manifest: PdfManifest,
  contents: Buffer[],
) {
  const plan = manifest.images.map((image, index) => ({
    image,
    index,
    canonical: index,
    rotation: 0,
    method: 'sha256',
    score: 1,
  }))
  const hashes = new Map<string, number>()
  for (const item of [...plan].sort(
    (a, b) =>
      Number(a.image.image_role === 'abstract') -
      Number(b.image.image_role === 'abstract'),
  )) {
    const old = hashes.get(item.image.content_hash)
    if (old !== undefined) item.canonical = old
    else hashes.set(item.image.content_hash, item.index)
  }
  const drawings = plan.filter(
    (item) => !item.image.image_role || item.image.image_role === 'drawing',
  )
  for (const item of plan.filter(
    (item) => item.image.image_role === 'abstract',
  )) {
    const match = await matchPatentAbstractToDrawing(
      {
        fileName: item.image.file_name,
        content: contents[item.index],
        contentHash: item.image.content_hash,
      },
      drawings.map((drawing) => ({
        fileName: drawing.image.file_name,
        content: contents[drawing.index],
        contentHash: drawing.image.content_hash,
      })),
    )
    if (match) {
      item.canonical = drawings.find(
        (drawing) => drawing.image.file_name === match.drawingFileName,
      )!.canonical
      item.rotation = match.rotation
      item.method = match.method
      item.score = match.score
    }
  }
  return plan
}

export async function publishImages(
  client: pg.PoolClient,
  patentId: string,
  batch: string,
  manifest: PdfManifest,
  contents: Buffer[],
  upload: typeof putPatentImage,
  jobId: string,
) {
  const plan = await imageAssetPlan(manifest, contents)
  const assets = new Map<number, { id: string; oss_key: string }>()
  // Materialize canonical drawings first; duplicate abstract references never upload a second object.
  for (const index of [...new Set(plan.map((item) => item.canonical))].sort(
    (a, b) =>
      manifest.images[a].content_hash.localeCompare(
        manifest.images[b].content_hash,
      ),
  )) {
    const image = manifest.images[index]
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `image:${image.content_hash}`,
    ])
    const existing = await client.query<{ id: string; oss_key: string }>(
      'SELECT id,oss_key FROM cnipa.image_asset WHERE content_hash=$1 ORDER BY created_at,id LIMIT 1 FOR UPDATE',
      [image.content_hash],
    )
    let asset = existing.rows[0]
    if (!asset) {
      const number = manifest.patent_number.replace(/^CN/, '').replace(/[ABCUSY]\d?$/, '')
      const key = `patents/${batch}/${number}/${image.file_name}`
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`object:${key}`])
      const conflict = await client.query(
        'SELECT id FROM cnipa.image_asset WHERE oss_key=$1 AND content_hash<>$2 FOR UPDATE',
        [key, image.content_hash],
      )
      if (conflict.rows.length) throw new Error('同名图片已有不同内容，请先清理原导入，避免覆盖共享资产')
      await upload(key, contents[index], 'image/png')
      const created = await client.query<{ id: string }>(
        `INSERT INTO cnipa.image_asset(oss_key,content_hash,content_type,size,width,height)
        VALUES($1,$2,'image/png',$3,$4,$5) ON CONFLICT(oss_key) DO UPDATE SET content_hash=EXCLUDED.content_hash RETURNING id`,
        [
          key,
          image.content_hash,
          contents[index].length,
          image.width,
          image.height,
        ],
      )
      asset = { id: created.rows[0].id, oss_key: key }
    }
    assets.set(index, asset)
  }
  // Replacement is transactional: old references stay intact if any upload fails.
  await client.query(
    `INSERT INTO cnipa.history_image_cleanup(oss_key,job_id)
    SELECT DISTINCT COALESCE(a.oss_key,i.oss_key),$2 FROM cnipa.patent_image i LEFT JOIN cnipa.image_asset a ON a.id=i.asset_id
    WHERE i.patent_id=$1 AND i.source_section='PDF-history'
    ON CONFLICT(oss_key) DO UPDATE SET job_id=EXCLUDED.job_id,status='pending'`,
    [patentId, jobId],
  )
  await client.query(
    "DELETE FROM cnipa.patent_image WHERE patent_id=$1 AND source_section='PDF-history'",
    [patentId],
  )
  for (const item of plan) {
    const asset = assets.get(item.canonical)!
    const image = manifest.images[item.canonical]
    const abstract = item.image.image_role === 'abstract'
    await client.query(
      `INSERT INTO cnipa.patent_image(patent_id,asset_id,file_name,oss_key,content_type,size,width,height,is_abstract,image_role,figure_label,source_section,sort_order,display_rotation,match_method,match_score,matched_file_name)
      VALUES($1,$2,$3,$4,'image/png',$5,$6,$7,$8,$9,$10,'PDF-history',$11,$12,$13,$14,$15)`,
      [
        patentId,
        asset.id,
        item.image.file_name,
        asset.oss_key,
        contents[item.canonical].length,
        image.width,
        image.height,
        abstract,
        item.image.image_role || 'drawing',
        item.image.figure_label,
        item.index,
        item.rotation,
        item.method,
        item.score,
        item.canonical !== item.index ? image.file_name : null,
      ],
    )
    if (abstract)
      await client.query(
        'UPDATE cnipa.patent SET abstract_fig_key=$2 WHERE id=$1',
        [patentId, asset.oss_key],
      )
  }
}
