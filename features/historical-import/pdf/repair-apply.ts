import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { isOssConfigured, putPatentImage, patentImageExists, getPatentImage, removePatentImage } from '../../../lib/oss-client.ts'
import { parsePublicationNumber, readVerifiedImage, validateManifest, type PdfManifest } from './historical-pdf.ts'
import { finalizeRepairs } from './repair-finalize.ts'
import { repairImageKey } from './repair-key.ts'
import { encodeRepairJpeg } from './repair-jpeg.ts'
import { cleanupReplacedDrawings } from './repair-clean-old.ts'
import { prepareReplacements, recoverReplacements } from './repair-replacement.ts'
import { loadRepairAbstracts, matchRepairAbstracts, type ReusedAbstract } from './repair-dedup.ts'

type Ready = { status: string; repair_revision?: number; publication_number: string; batch: string; pdf: string; pdf_hash: string; manifest: string; candidate_image_names: string[] }
const args = process.argv.slice(2)
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
const report = option('--report') || 'data/patent-image-repair/report.jsonl'
const chosen = option('--publication')
const limit = Number(option('--limit') || 10)
const commit = args.includes('--apply')
async function inspectStoredImage<T>(operation:()=>Promise<T>):Promise<T> {
  try { return await operation() }
  catch(error) {
    if (error instanceof Error && /(?:HTTP status:|HTTP)\s*500\b/i.test(error.message)) throw new Error('对象存储读取旧图时返回 HTTP 500，请检查存储服务和原图完整性；旧图尚未替换')
    throw error
  }
}
if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit 必须是正整数')
if (chosen) parsePublicationNumber(chosen)
if (args.includes('--cleanup-only') && (!commit || !chosen)) throw new Error('--cleanup-only 需要同时提供 --apply 和 --publication')
if (commit && !isOssConfigured()) throw new Error('对象存储未配置')
const pool = new pg.Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {
  host: process.env.CNIPA_PG_HOST, port: Number(process.env.CNIPA_PG_PORT || 5432),
  database: process.env.CNIPA_PG_DB, user: process.env.CNIPA_PG_USER,
  password: process.env.CNIPA_PG_PASSWORD, connectionTimeoutMillis: 10000,
})

async function main() {
  const records = args.includes('--finalize-only') || args.includes('--cleanup-only') ? [] : (await readFile(report, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Ready)
  const seen = new Set<string>()
  let processed = 0
  let failed = false
  let cleanupFailed = false
  let skipped = 0
  const cleanupNumbers = new Set<string>()
  if (args.includes('--cleanup-only') && chosen) cleanupNumbers.add(chosen)
  if (commit) await pool.query(`CREATE TABLE IF NOT EXISTS cnipa.pdf_image_repair_backup (
    id bigserial PRIMARY KEY, patent_id uuid NOT NULL, publication_number text NOT NULL,
    pdf_hash text NOT NULL, original_images jsonb NOT NULL, new_image_ids uuid[] NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(patent_id,pdf_hash))`)
  const backupExists = Boolean((await pool.query<{name: string | null}>("SELECT to_regclass('cnipa.pdf_image_repair_backup')::text AS name")).rows[0].name)
  const completed = new Set<string>()
  if (backupExists && records.length) {
    const existing = await pool.query<{publication_number:string;batch_id:string}>(`SELECT DISTINCT b.publication_number,p.batch_id FROM cnipa.pdf_image_repair_backup b JOIN cnipa.patent p ON p.id=b.patent_id WHERE cardinality(b.new_image_ids)>0`)
    for (const row of existing.rows) completed.add(JSON.stringify([row.publication_number,row.batch_id]))
  }
  for (const item of records.reverse()) {
    if (item.status !== 'ready' || item.repair_revision !== 3 || (chosen && item.publication_number !== chosen) || seen.has(item.publication_number)) continue
    seen.add(item.publication_number)
    if (completed.has(JSON.stringify([item.publication_number,item.batch]))) { skipped++; continue }
    if (++processed > limit) break
    const client = await pool.connect()
    let replacementsPrepared = false
    let committed = false
    let commitStarted = false
    let recoveryPrefix = ''
    try {
      const pub = parsePublicationNumber(item.publication_number)
      const manifest = JSON.parse(await readFile(item.manifest, 'utf8')) as PdfManifest
      validateManifest(manifest, 'repair')
      if (manifest.version !== 'pdf-figures-v2' || manifest.images.some(image => image.image_role !== 'drawing')) throw new Error('提取结果不是当前版本的说明书附图')
      const pdf = await readFile(item.pdf).catch((error:NodeJS.ErrnoException) => { if(error.code==='ENOENT') return null; throw error })
      if (manifest.patent_number !== item.publication_number || manifest.pdf_hash !== item.pdf_hash || (pdf && createHash('sha256').update(pdf).digest('hex') !== item.pdf_hash)) throw new Error('PDF、公开号或哈希不一致')
      const images = await Promise.all(manifest.images.map(image => readVerifiedImage(path.dirname(item.manifest), image)))
      await client.query('BEGIN')
      const patent = await client.query<{id: string; abstract_fig_key:string|null}>(`SELECT id,abstract_fig_key FROM cnipa.patent WHERE batch_id=$1 AND upper(doc_number)=ANY($2::text[]) AND upper(kind)=$3 FOR UPDATE`, [item.batch, [pub.number, `CN${pub.number}`], pub.kind])
      if (patent.rowCount !== 1) throw new Error('批次及公开号没有唯一对应专利')
      const patentId = patent.rows[0].id
      const prior = backupExists ? await client.query<{new_image_ids:string[]}>('SELECT new_image_ids FROM cnipa.pdf_image_repair_backup WHERE patent_id=$1 AND cardinality(new_image_ids)>0 ORDER BY created_at DESC LIMIT 1 FOR UPDATE', [patentId]) : { rowCount: 0, rows: [] }
      if (prior.rowCount) { await client.query('ROLLBACK'); skipped++; processed--; continue }
      recoveryPrefix=`patents/${item.batch}/${pub.number}/`
      if (commit) await recoverReplacements(item.publication_number,recoveryPrefix)
      const old = await client.query<{id:string;asset_id:string;file_name:string;oss_key:string;content_hash:string}>("SELECT i.*,a.content_hash FROM cnipa.patent_image i LEFT JOIN cnipa.image_asset a ON a.id=i.asset_id WHERE i.patent_id=$1 AND i.image_role='drawing' AND NOT i.is_abstract FOR UPDATE OF i", [patentId])
      const names = new Set(item.candidate_image_names.map(name => name.toLowerCase()))
      if (!old.rowCount || old.rows.some(image => !names.has(image.file_name.toLowerCase()))) throw new Error('附图不全属于重名候选，跳过以免替换正确图片')
      if (!pdf) throw new Error('原 PDF 已清理，重新提取前请先重新下载')
      if (!commit) { await client.query('ROLLBACK'); console.log(JSON.stringify({number:item.publication_number,status:'ready',old:old.rowCount,pages:images.length})); continue }
      const abstracts=await loadRepairAbstracts(client,patentId,patent.rows[0].abstract_fig_key)
      const reuse=await matchRepairAbstracts(abstracts,manifest.images,images)
      const plans: {image:PdfManifest['images'][number];jpeg:Awaited<ReturnType<typeof encodeRepairJpeg>>|null;key:string;old:typeof old.rows[number]|null;reuse:ReusedAbstract|null}[] = []
      for (const [index,image] of manifest.images.entries()) {
        const reused=reuse.get(index) || null
        const jpeg=reused ? null : await encodeRepairJpeg(images[index])
        plans.push({image,jpeg,key:jpeg ? repairImageKey(item.batch,item.publication_number,jpeg.hash,index+1) : reused!.asset.oss_key,old:null,reuse:reused})
      }
      const replacements:typeof plans = []
      for (const plan of plans) {
        if(plan.reuse) continue
        const jpeg=plan.jpeg!
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`object:${plan.key.toLowerCase()}`])
        if (!(await inspectStoredImage(()=>patentImageExists(plan.key)))) continue
        const current=(await inspectStoredImage(()=>getPatentImage(plan.key))).content
        if (createHash('sha256').update(current).digest('hex')===jpeg.hash) continue
        const matches=old.rows.filter(image=>image.oss_key.toLowerCase()===plan.key.toLowerCase())
        if(matches.length!==1 || !matches[0].asset_id || !matches[0].oss_key.startsWith(recoveryPrefix)) throw new Error(`目标图片 ${path.posix.basename(plan.key)} 已存在但不属于待替换旧附图`)
        const original=(await inspectStoredImage(()=>getPatentImage(matches[0].oss_key))).content
        if (!current.equals(original)) throw new Error(`目标图片 ${path.posix.basename(plan.key)} 与待替换旧图不一致`)
        plan.old=matches[0]
        replacements.push(plan)
      }
      if (replacements.length) {
        const assetIds=replacements.map(plan=>plan.old!.asset_id)
        const keys=replacements.map(plan=>plan.old!.oss_key.toLowerCase())
        await client.query('SELECT id FROM cnipa.image_asset WHERE id=ANY($1::uuid[]) FOR UPDATE',[assetIds])
        const refs=await client.query<{id:string}>(`SELECT id FROM cnipa.patent_image WHERE asset_id=ANY($1::uuid[]) OR lower(oss_key)=ANY($2::text[])`,[assetIds,keys])
        const allowed=new Set(replacements.map(plan=>plan.old!.id))
        if(refs.rows.some(row=>!allowed.has(row.id))) throw new Error('同名旧图被其他图片记录引用，已停止更新')
        const abstracts=await client.query('SELECT 1 FROM cnipa.patent WHERE lower(abstract_fig_key)=ANY($1::text[]) LIMIT 1',[keys])
        if(abstracts.rowCount) throw new Error('同名旧图被摘要图引用，已停止更新')
        await prepareReplacements(item.publication_number,replacements.map(plan=>({oldKey:plan.old!.oss_key,newHash:plan.jpeg!.hash})))
        replacementsPrepared=true
      }
      const ids: string[] = []
      for (const [index, plan] of plans.entries()) {
        const {image,key}=plan
        if(plan.reuse) {
          const {asset,match,displayRotation}=plan.reuse
          const inserted=await client.query<{id:string}>(`INSERT INTO cnipa.patent_image(patent_id,asset_id,file_name,oss_key,content_type,size,width,height,is_abstract,image_role,figure_label,source_section,sort_order,display_rotation,match_method,match_score,matched_file_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,false,'drawing',$9,'PDF-repair',$10,$11,$12,$13,$14) RETURNING id`,[patentId,asset.id,asset.file_name,asset.oss_key,asset.content_type,asset.content.length,asset.width,asset.height,image.figure_label,index,displayRotation,match.method,match.score,asset.file_name])
          ids.push(inserted.rows[0].id)
          continue
        }
        const jpeg=plan.jpeg!
        const existingAsset = await client.query<{content_hash:string}>('SELECT content_hash FROM cnipa.image_asset WHERE oss_key=$1 FOR UPDATE',[key])
        if (existingAsset.rowCount && existingAsset.rows[0].content_hash!==jpeg.hash && plan.old?.oss_key!==key) throw new Error(`目标图片 ${path.posix.basename(key)} 已被其他图片使用，已停止更新`)
        if (plan.old) {
          await removePatentImage(plan.old.oss_key)
          await putPatentImage(key,jpeg.content,'image/jpeg')
          if(createHash('sha256').update((await getPatentImage(key)).content).digest('hex')!==jpeg.hash) throw new Error(`新附图 ${path.posix.basename(key)} 校验失败`)
        } else if (await patentImageExists(key)) {
          const existing = await getPatentImage(key)
          if (createHash('sha256').update(existing.content).digest('hex') !== jpeg.hash) throw new Error(`目标图片 ${path.posix.basename(key)} 已存在但内容不同，已停止更新`)
        } else await putPatentImage(key, jpeg.content, 'image/jpeg')
        const asset = await client.query<{id:string}>(`INSERT INTO cnipa.image_asset(oss_key,content_hash,content_type,size,width,height) VALUES($1,$2,'image/jpeg',$3,$4,$5) ON CONFLICT(oss_key) DO UPDATE SET content_hash=EXCLUDED.content_hash,content_type=EXCLUDED.content_type,size=EXCLUDED.size,width=EXCLUDED.width,height=EXCLUDED.height WHERE cnipa.image_asset.content_hash=EXCLUDED.content_hash OR cnipa.image_asset.id=$6::uuid RETURNING id`, [key,jpeg.hash,jpeg.content.length,image.width,image.height,plan.old?.oss_key===key ? plan.old.asset_id : null])
        if (!asset.rowCount) throw new Error(`目标图片 ${path.posix.basename(key)} 的资产记录冲突，已停止更新`)
        const inserted = await client.query<{id:string}>(`INSERT INTO cnipa.patent_image(patent_id,asset_id,file_name,oss_key,content_type,size,width,height,is_abstract,image_role,figure_label,source_section,sort_order) VALUES($1,$2,$3,$4,'image/jpeg',$5,$6,$7,false,'drawing',$8,'PDF-repair',$9) RETURNING id`, [patentId,asset.rows[0].id,path.posix.basename(key),key,jpeg.content.length,image.width,image.height,image.figure_label,index])
        ids.push(inserted.rows[0].id)
      }
      await client.query('INSERT INTO cnipa.pdf_image_repair_backup(patent_id,publication_number,pdf_hash,original_images,new_image_ids) VALUES($1,$2,$3,$4::jsonb,$5::uuid[])', [patentId,item.publication_number,item.pdf_hash,JSON.stringify(old.rows),ids])
      await client.query('DELETE FROM cnipa.patent_image WHERE id=ANY($1::uuid[])', [old.rows.map(x=>x.id)])
      commitStarted=true
      await client.query('COMMIT')
      committed=true
      cleanupNumbers.add(item.publication_number)
      console.log(JSON.stringify({number:item.publication_number,status:'applied',old:old.rowCount,pages:images.length,reused:reuse.size,oversized:plans.filter(plan=>plan.jpeg&&!plan.jpeg.targetReached).length}))
    } catch (error) {
      failed = true
      if (replacementsPrepared && !committed && !commitStarted) {
        try { await recoverReplacements(item.publication_number,recoveryPrefix) }
        catch (restoreError) { console.error(JSON.stringify({number:item.publication_number,status:'finalize_failed',error:`旧图自动恢复失败，请保留本地备份并检查：${restoreError instanceof Error?restoreError.message:String(restoreError)}`})) }
      }
      if (replacementsPrepared && !committed && commitStarted) console.error(JSON.stringify({number:item.publication_number,status:'finalize_failed',error:'数据库提交结果不确定，请重新运行以检查记录和恢复旧图'}))
      await client.query('ROLLBACK').catch(() => {})
      console.error(JSON.stringify({number:item.publication_number,status:'failed',error:error instanceof Error ? error.message : String(error)}))
    } finally { client.release() }
  }
  if (skipped) console.log(JSON.stringify({status:'skipped_applied',count:skipped}))
  if (!processed && !args.includes('--cleanup-only')) console.log(skipped ? '已跳过已更新专利，没有待更新记录' : '没有符合条件的已准备记录')
  for(const number of cleanupNumbers) {
    try {
      const result=await cleanupReplacedDrawings(pool,number)
      console.log(JSON.stringify({number,status:'old_images_cleaned',...result}))
    } catch(error) {
      failed=true
      cleanupFailed=true
      console.error(JSON.stringify({number,status:'finalize_failed',error:error instanceof Error?error.message:'旧图清理失败，请检查存储连接'}))
    }
  }
  if (commit && !cleanupFailed && !args.includes('--defer-finalize') && (cleanupNumbers.size || args.includes('--finalize-only'))) {
    try {
      const result = await finalizeRepairs(pool, args.includes('--finalize-only') ? (chosen ? [chosen] : undefined) : [...cleanupNumbers])
      console.log(JSON.stringify({status:'finalized',...result}))
      if (result.retained.length) { failed=true; console.error(JSON.stringify({status:'finalize_failed',error:'部分 PDF 因哈希不一致或文件占用而保留，请检查后重试'})) }
    } catch(error) {
      failed=true
      console.error(JSON.stringify({status:'finalize_failed',error:error instanceof Error ? error.message : 'Excel 标记失败，PDF 已保留'}))
    }
  }
  if (failed) process.exitCode = 1
}
main().finally(() => pool.end())
