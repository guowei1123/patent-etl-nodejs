import type pg from 'pg'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  announcementBatch,
  type ImportConfig,
  type ImportRecord,
} from './model.ts'
import {
  validateManifest,
  readVerifiedImage,
  type PdfManifest,
} from './pdf/historical-pdf.ts'
import type { putPatentImage } from '../../lib/oss-client.ts'
import { publishImages } from './images.ts'
import { applicationKey, applicationSql } from './identity.ts'
export { applicationSql } from './identity.ts'

function optionalApplication(value?: string | null) {
  if (!value) return null
  try {
    return applicationKey(value)
  } catch {
    return null
  }
}

const completeSql = `NULLIF(btrim(p.title),'') IS NOT NULL AND NULLIF(p.pub_date,'') IS NOT NULL
  AND NULLIF(p.app_number,'') IS NOT NULL
  AND p.description IS NOT NULL AND regexp_replace(p.description::text,'[[:space:]]','','g') NOT IN ('null','{}','""','{"embodiment":""}')
  AND p.claims IS NOT NULL AND regexp_replace(p.claims::text,'[[:space:]]','','g') NOT IN ('null','[]','{}','""')
  AND (EXISTS(SELECT 1 FROM cnipa.history_import_part h WHERE h.patent_id=p.id AND h.part='images')
    OR EXISTS(SELECT 1 FROM cnipa.patent_image i WHERE i.patent_id=p.id AND i.image_role='drawing'))`

export async function setupHistorySchema(pool: pg.Pool) {
  const client = await pool.connect()
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtextextended('historical-import-schema',0))",
    )
    await client.query('BEGIN')
    // The application's own initialization creates the business tables; never run its FTP scheduler here.
    const result = await client.query(
      "SELECT to_regclass('cnipa.patent') AS patent,to_regclass('cnipa.image_asset') AS asset",
    )
    if (!result.rows[0]?.patent || !result.rows[0]?.asset)
      throw new Error('数据库尚未初始化，请先打开专利数据页面')
    await client.query(`CREATE TABLE IF NOT EXISTS cnipa.history_import_source (
    patent_id UUID PRIMARY KEY REFERENCES cnipa.patent(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL, announcement_batch TEXT, publication TEXT NOT NULL,
    metadata JSONB NOT NULL, source_file TEXT NOT NULL, fingerprint TEXT NOT NULL,
    pdf_source JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
    await client.query(
      'ALTER TABLE cnipa.history_import_source ALTER COLUMN announcement_batch DROP NOT NULL',
    )
    await client.query(`CREATE TABLE IF NOT EXISTS cnipa.history_image_cleanup (
    oss_key TEXT PRIMARY KEY, job_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
    await client.query(`CREATE TABLE IF NOT EXISTS cnipa.history_import_part (
    patent_id UUID NOT NULL REFERENCES cnipa.patent(id) ON DELETE CASCADE,
    part TEXT NOT NULL, fingerprint TEXT NOT NULL, job_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(patent_id,part))`)
    await client.query('COMMIT')
    // Existing FTP tables can contain millions of rows; build without blocking their writes.
    const index = await client.query<{
      indisvalid: boolean
    }>(`SELECT i.indisvalid FROM pg_index i
      JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='cnipa' AND c.relname='idx_history_application_core'`)
    if (index.rows[0] && !index.rows[0].indisvalid)
      await client.query(
        'DROP INDEX CONCURRENTLY IF EXISTS cnipa.idx_history_application_core',
      )
    await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_history_application_core
      ON cnipa.patent ((${applicationSql})) WHERE kind ~ '^[ABC]'`)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    try {
      await client.query(
        "SELECT pg_advisory_unlock(hashtextextended('historical-import-schema',0))",
      )
    } finally {
      client.release()
    }
  }
}

export async function publishRecord(
  pool: pg.Pool,
  record: ImportRecord,
  config: ImportConfig,
  jobId: string,
  upload: typeof putPatentImage,
  identityRetry = 0,
) {
  if (record.status !== 'ready') throw new Error('不完整的文献不能发布')
  const stage = config.stage || 'all'
  const metadata = ['metadata', 'all'].includes(stage)
  const text = ['text', 'all'].includes(stage)
  const images = ['images', 'all'].includes(stage)
  if (
    !/^CN\d{7,12}[ABCUY]\d?$/.test(record.publication) ||
    record.publication.match(/[ABCUY]\d?$/)?.[0] !== record.kind
  )
    throw new Error('公开号与种类码不一致')
  if (record.application && !optionalApplication(record.application))
    throw new Error('申请号格式无效')
  let batch: string | null = record.date
    ? announcementBatch(record.date, record.kind)
    : null
  const digits = record.publication
    .replace(/^CN/, '')
    .replace(/[ABCUY]\d?$/, '')
  // Runtime output paths differ for every job; hash source content and PDF identity instead.
  let manifest: PdfManifest | undefined
  const contents: Buffer[] = []
  if (images && record.pdfManifest) {
    manifest = JSON.parse(await readFile(record.pdfManifest, 'utf8'))
    validateManifest(manifest!, 'HISTORY')
    if (manifest!.patent_number !== record.publication)
      throw new Error('PDF 与目标文献版本不一致')
    if (manifest!.publication_date) {
      if (record.date && record.date !== manifest!.publication_date)
        throw new Error('PDF 公告日期与基础信息不一致，请核对')
      record.date ||= manifest!.publication_date
    }
    for (const image of manifest!.images)
      contents.push(
        await readVerifiedImage(path.dirname(record.pdfManifest), image),
      )
  } else if (images && !config.noDrawingNumbers.includes(record.publication))
    throw new Error('缺少已确认的附图或无附图声明')
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        publication: record.publication,
        metadata: metadata
          ? {
              application: record.application,
              date: record.date,
              title: record.title,
              abstract: record.abstract,
              applicant: record.applicant,
              inventor: record.inventor,
              ipc: record.ipc,
              grant: record.grant,
              grantDate: record.grantDate,
              raw: record.raw,
            }
          : null,
        description: text ? record.description : '',
        claims: text ? record.claims : '',
        pdfHash: manifest?.pdf_hash || null,
        imageStorageLayout: images ? 'batch-number-image-v1' : null,
        images:
          manifest?.images.map((image) => ({
            file: image.file_name,
            hash: image.content_hash,
            page: image.page,
            role: image.image_role || 'drawing',
            label: image.figure_label,
          })) || [],
        cleanupApplications: config.cleanupApplications,
        stage,
      }),
    )
    .digest('hex')
  const client = await pool.connect()
  let removed = 0
  try {
    await client.query('BEGIN')
    const prior = await client.query<{ app_number: string | null }>(
      `SELECT app_number FROM cnipa.patent WHERE doc_number=ANY($1::text[]) AND kind=$2 AND COALESCE(pub_country,'CN')='CN'`,
      [[digits, `CN${digits}`, record.publication], record.kind],
    )
    const application =
      optionalApplication(record.application) ||
      optionalApplication(prior.rows[0]?.app_number)
    // Application lock comes first, so grant cleanup cannot deadlock another publication's writer.
    if (application)
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`CN${application}`],
      )
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `publication:${record.publication}`,
    ])
    const old = await client.query<{
      id: string
      fingerprint: string | null
      app_number?: string | null
      pub_date?: string | null
      title?: string | null
      batch_id?: string | null
      ftp_folder?: string | null
    }>(
      `SELECT p.id,part.fingerprint,p.app_number,p.pub_date,p.title,p.batch_id,b.ftp_folder FROM cnipa.patent p
      LEFT JOIN cnipa.history_import_source s ON s.patent_id=p.id
      LEFT JOIN cnipa.history_import_part part ON part.patent_id=p.id AND part.part=$3
      LEFT JOIN sync_batches b ON b.batch_code=p.batch_id
      WHERE p.doc_number=ANY($1::text[]) AND p.kind=$2 AND COALESCE(p.pub_country,'CN')='CN' FOR UPDATE OF p`,
      [[digits, `CN${digits}`, record.publication], record.kind, stage],
    )
    if ((old.rowCount || 0) > 1) throw new Error('数据库存在冲突的文献记录')
    const existing = old.rows[0]
    const storedApplication = optionalApplication(existing?.app_number)
    if (
      storedApplication &&
      record.application &&
      storedApplication !== optionalApplication(record.application)
    )
      throw new Error('同一公开号的申请号冲突，请核对基础信息')
    if (storedApplication && storedApplication !== application) {
      // Metadata was filled between the initial read and publication lock. Retry with the known application.
      await client.query('ROLLBACK')
      if (identityRetry >= 2)
        throw new Error('基础信息正在更新，请重新预览后重试')
      return publishRecord(
        pool,
        { ...record, application: `CN${storedApplication}` },
        config,
        jobId,
        upload,
        identityRetry + 1,
      )
    }
    const storedDate = (existing?.pub_date || '').replace(
      /^(\d{4})(\d{2})(\d{2})$/,
      '$1-$2-$3',
    )
    if (images && manifest?.publication_date && storedDate && manifest.publication_date !== storedDate)
      throw new Error("PDF 公告日期与数据库不一致，请核对")
    const effectiveDate = metadata
      ? record.date || storedDate
      : storedDate || record.date
    if (effectiveDate && effectiveDate >= config.beforeDate)
      throw new Error('公告日期超出处理范围，请调整日期后重试')
    batch = effectiveDate ? announcementBatch(effectiveDate, record.kind) : null
    record.metadataPending =
      !application || !effectiveDate || !(record.title || existing?.title)
    if (
      record.kind.startsWith('A') &&
      application &&
      !existing &&
      config.cleanupApplications
    ) {
      const grant = await client.query(
        `SELECT p.id FROM cnipa.patent p WHERE ${applicationSql}=$1 AND kind ~ '^[ABC]' AND kind ~ '^[BC]' AND ${completeSql} LIMIT 1`,
        [application],
      )
      if (grant.rowCount) {
        await client.query('COMMIT')
        return { skipped: true, removed: 0 }
      }
    }
    if (old.rows[0]?.fingerprint === fingerprint) {
      await client.query('COMMIT')
      return { skipped: true, removed: 0 }
    }
    if (batch)
      await client.query(
        `INSERT INTO sync_batches(batch_code,data_type,status,total_patents,started_at)
      VALUES ($1,$2,'importing',0,now()) ON CONFLICT(batch_code) DO NOTHING`,
        [
          batch,
          record.kind.startsWith('A')
            ? 'invention_application'
            : /^[UY]/.test(record.kind)
              ? 'utility_model'
              : 'invention',
        ],
      )
    let id = old.rows[0]?.id
    if (!id) {
      const created = await client.query<{ id: string }>(
        `INSERT INTO cnipa.patent
        (doc_number,kind,pub_country,pub_date,app_number,title,abstract,description,claims,batch_id,source_file,grant_number,grant_date,lang)
        VALUES ($1,$2,'CN',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'zh') RETURNING id`,
        [
          digits,
          record.kind,
          effectiveDate || null,
          record.application || null,
          record.title || null,
          record.abstract || null,
          text && record.description
            ? JSON.stringify({ embodiment: record.description })
            : null,
          text && record.claims ? JSON.stringify(record.claims) : null,
          batch,
          record.source,
          record.grant || null,
          record.grantDate || null,
        ],
      )
      id = created.rows[0].id
    } else if (!metadata && effectiveDate && !existing?.pub_date) {
      await client.query(
        `UPDATE cnipa.patent SET pub_date=COALESCE(NULLIF(pub_date,''),$2),
        batch_id=CASE WHEN $4::boolean THEN COALESCE(batch_id,$3) ELSE batch_id END,
        updated_at=now() WHERE id=$1`,
        [id, effectiveDate, batch, !existing?.ftp_folder],
      )
    } else if (metadata) {
      // Preserve the existing source batch on FTP records; reconstructed batch is also kept in provenance.
      await client.query(
        `UPDATE cnipa.patent SET title=COALESCE(NULLIF($2,''),title),abstract=COALESCE(NULLIF($3,''),abstract),
        description=COALESCE($4::jsonb,description),claims=COALESCE($5::jsonb,claims),app_number=COALESCE(NULLIF($6,''),app_number),
        pub_date=CASE WHEN $11::boolean THEN COALESCE(NULLIF($7,''),pub_date) ELSE COALESCE(NULLIF(pub_date,''),NULLIF($7,'')) END,
        grant_number=COALESCE(NULLIF($8,''),grant_number),grant_date=COALESCE(NULLIF($9,''),grant_date),
        batch_id=CASE WHEN $11::boolean THEN $10 ELSE batch_id END,updated_at=now() WHERE id=$1`,
        [
          id,
          record.title,
          record.abstract,
          text && record.description
            ? JSON.stringify({ embodiment: record.description })
            : null,
          text && record.claims ? JSON.stringify(record.claims) : null,
          record.application,
          record.date,
          record.grant,
          record.grantDate,
          batch,
          !existing?.ftp_folder,
        ],
      )
    }
    if (text && !metadata)
      await client.query(
        `UPDATE cnipa.patent SET
      description=COALESCE($2::jsonb,description),claims=COALESCE($3::jsonb,claims),updated_at=now() WHERE id=$1`,
        [
          id,
          record.description
            ? JSON.stringify({ embodiment: record.description })
            : null,
          record.claims ? JSON.stringify(record.claims) : null,
        ],
      )
    for (const [table, column, value] of [
      ['patent_applicant', 'name', record.applicant],
      ['patent_inventor', 'name', record.inventor],
    ] as const) {
      for (const name of (metadata ? value : '')
        .split(/[;；\n]/)
        .map((x) => x.trim())
        .filter(Boolean)) {
        await client.query(
          `INSERT INTO cnipa.${table}(patent_id,${column}) SELECT $1,$2 WHERE NOT EXISTS (SELECT 1 FROM cnipa.${table} WHERE patent_id=$1 AND ${column}=$2)`,
          [id, name],
        )
      }
    }
    for (const code of (metadata ? record.ipc : '')
      .split(/[;；\n]/)
      .map((x) => x.trim())
      .filter(Boolean)) {
      const normalized = code.replace(/\s/g, '').toUpperCase()
      await client.query(
        `INSERT INTO cnipa.patent_ipc(patent_id,ipc_code,code_norm) SELECT $1,$2,$3 WHERE NOT EXISTS(SELECT 1 FROM cnipa.patent_ipc WHERE patent_id=$1 AND code_norm=$3)`,
        [id, code, normalized],
      )
    }
    if (manifest) {
      await publishImages(
        client,
        id!,
        batch || 'PENDING',
        manifest,
        contents,
        upload,
        jobId,
      )
    }
    await client.query(
      `INSERT INTO cnipa.history_import_source(patent_id,job_id,announcement_batch,publication,metadata,source_file,fingerprint,pdf_source)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(patent_id) DO UPDATE SET job_id=EXCLUDED.job_id,
      announcement_batch=EXCLUDED.announcement_batch,publication=EXCLUDED.publication,
      source_file=CASE WHEN $9::boolean THEN EXCLUDED.source_file ELSE cnipa.history_import_source.source_file END,
      metadata=CASE WHEN $9::boolean THEN cnipa.history_import_source.metadata || jsonb_strip_nulls(EXCLUDED.metadata) ELSE cnipa.history_import_source.metadata END,
      fingerprint=EXCLUDED.fingerprint,pdf_source=COALESCE(EXCLUDED.pdf_source,cnipa.history_import_source.pdf_source),updated_at=now()`,
      [
        id,
        jobId,
        batch,
        record.publication,
        JSON.stringify(record.raw),
        record.source,
        fingerprint,
        manifest
          ? JSON.stringify({
              source: manifest.source,
              hash: manifest.pdf_hash,
              publication_date: manifest.publication_date,
              announcement_batch: batch,
              date_source: manifest.date_source,
              pages: manifest.images.map((i) => i.page),
              images: manifest.images.map((i) => ({
                file_name: i.file_name,
                page: i.page,
                role: i.image_role || 'drawing',
                figure_label: i.figure_label,
                bbox: i.bbox,
                method: i.extraction_method,
              })),
            })
          : null,
        metadata,
      ],
    )
    const parts = [
      stage,
      ...(metadata ? ['metadata'] : []),
      ...(text && record.description ? ['description'] : []),
      ...(text && record.claims ? ['claims'] : []),
      ...(images ? ['images'] : []),
    ]
    for (const part of new Set(parts))
      await client.query(
        `INSERT INTO cnipa.history_import_part(patent_id,part,fingerprint,job_id)
      VALUES($1,$2,$3,$4) ON CONFLICT(patent_id,part) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,job_id=EXCLUDED.job_id,updated_at=now()`,
        [id, part, fingerprint, jobId],
      )
    const affectedBatches = new Set(
      [batch, existing?.batch_id].filter((value): value is string => !!value),
    )
    const completion = await client.query<{ complete: boolean }>(
      `SELECT ${completeSql} AS complete
      FROM cnipa.patent p WHERE p.id=$1`,
      [id],
    )
    if (
      /^[ABC]/.test(record.kind) &&
      application &&
      config.cleanupApplications &&
      (/^[BC]/.test(record.kind)
        ? completion.rows[0]?.complete
        : (
            await client.query(
              `SELECT p.id FROM cnipa.patent p WHERE ${applicationSql}=$1 AND kind ~ '^[ABC]' AND kind ~ '^[BC]' AND ${completeSql} LIMIT 1`,
              [application],
            )
          ).rowCount)
    ) {
      const applications = await client.query<{
        id: string
        batch_id?: string | null
      }>(
        `SELECT id,batch_id FROM cnipa.patent WHERE ${applicationSql}=$1 AND kind ~ '^[ABC]' AND kind ~ '^A' FOR UPDATE`,
        [application],
      )
      const ids = applications.rows.map((r) => r.id)
      for (const row of applications.rows)
        if (row.batch_id) affectedBatches.add(row.batch_id)
      if (ids.length) {
        await client.query(
          `INSERT INTO cnipa.history_image_cleanup(oss_key,job_id)
          SELECT DISTINCT COALESCE(a.oss_key,i.oss_key),$2 FROM cnipa.patent_image i LEFT JOIN cnipa.image_asset a ON a.id=i.asset_id
          WHERE i.patent_id=ANY($1::uuid[]) AND COALESCE(a.oss_key,i.oss_key) IS NOT NULL
          ON CONFLICT(oss_key) DO UPDATE SET job_id=EXCLUDED.job_id,status='pending'`,
          [ids, jobId],
        )
        await client.query(
          'DELETE FROM cnipa.patent WHERE id=ANY($1::uuid[])',
          [ids],
        )
        removed = ids.length
      }
    }
    for (const affectedBatch of affectedBatches)
      await client.query(
        `UPDATE sync_batches SET status='completed',completed_at=now(),
      total_patents=(SELECT count(*) FROM cnipa.patent WHERE batch_id=$1),
      imported_patents=(SELECT count(*) FROM cnipa.patent WHERE batch_id=$1) WHERE batch_code=$1 AND ftp_folder IS NULL`,
        [affectedBatch],
      )
    await client.query('COMMIT')
    return { skipped: false, removed }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
