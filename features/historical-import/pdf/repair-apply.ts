import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { isOssConfigured, putPatentImage, getPatentImage, patentImageExists } from '../../../lib/oss-client.ts'
import { parsePublicationNumber, readVerifiedImage, validateManifest, type PdfManifest } from './historical-pdf.ts'
import { finalizeRepairs } from './repair-finalize.ts'
import { validateDrawingCount } from './repair-count.ts'
import { encodeRepairJpeg } from './repair-jpeg.ts'
import { monitorRepairConnection, prepareDrawingJpegs } from './repair-transaction.ts'
import { cleanupReplacedDrawings } from './repair-clean-old.ts'

type Ready = { status: string; repair_revision?: number; publication_number: string; batch: string; pdf: string; pdf_hash: string; manifest: string; candidate_image_names: string[] }
const args = process.argv.slice(2)
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
const report = option('--report') || 'data/patent-image-repair/report.jsonl'
const chosen = option('--publication')
const limit = Number(option('--limit') || 10)
const commit = args.includes('--apply')
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
  let checkedOldKeys:Set<string>|undefined
  if(args.includes('--checked-old-keys-stdin')) {
    if(!commit || !chosen) throw new Error('复用存在性检查结果需要指定单件专利并执行更新')
    let input=''
    for await(const chunk of process.stdin) input+=String(chunk)
    const keys:unknown=JSON.parse(input)
    if(!Array.isArray(keys) || keys.some(key=>typeof key!=='string')) throw new Error('旧图片存在性检查结果无效')
    checkedOldKeys=new Set(keys as string[])
  }
  const records = args.includes('--finalize-only') || args.includes('--cleanup-only') ? [] : (await readFile(report, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Ready)
  const seen = new Set<string>()
  let processed = 0
  let failed = false
  let cleanupFailed = false
  let skipped = 0
  const cleanupNumbers = new Set<string>()
  const updatedNumbers = new Set<string>()
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
    if (item.status !== 'ready' || item.repair_revision !== 4 || (chosen && item.publication_number !== chosen) || seen.has(item.publication_number)) continue
    seen.add(item.publication_number)
    if (completed.has(JSON.stringify([item.publication_number,item.batch]))) { skipped++; continue }
    if (++processed > limit) break
    const client = await pool.connect()
    const connection=monitorRepairConnection(client)
    let commitStarted = false
    let overwriteStarted = false
    try {
      const pub = parsePublicationNumber(item.publication_number)
      const manifest = JSON.parse(await readFile(item.manifest, 'utf8')) as PdfManifest
      validateManifest(manifest, 'repair')
      if (manifest.version !== 'pdf-figures-v2' || manifest.images.some(image => image.image_role !== 'drawing')) throw new Error('提取结果不是当前版本的说明书附图')
      const pdf = await readFile(item.pdf).catch((error:NodeJS.ErrnoException) => { if(error.code==='ENOENT') return null; throw error })
      if (manifest.patent_number !== item.publication_number || manifest.pdf_hash !== item.pdf_hash || (pdf && createHash('sha256').update(pdf).digest('hex') !== item.pdf_hash)) throw new Error('PDF、公开号或哈希不一致')
      const images = await Promise.all(manifest.images.map(image => readVerifiedImage(path.dirname(item.manifest), image)))
      // Encoding can take longer than the database's idle transaction timeout.
      // Keep failures per image: an image matched to the abstract needs no JPEG.
      const encoded=commit ? await prepareDrawingJpegs(images) : []
      connection.assert()
      await client.query('BEGIN')
      // Object storage verification and durable backup remain inside this
      // transaction. Allow those operations to finish without changing the
      // database-wide setting, while still retaining a bounded idle timeout.
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '10min'")
      const patent = await client.query<{id: string; abstract_fig_key:string|null}>(`SELECT id,abstract_fig_key FROM cnipa.patent WHERE batch_id=$1 AND doc_number=ANY($2::text[]) AND upper(kind)=$3 FOR UPDATE`, [item.batch, [pub.number, ...['CN','Cn','cN','cn'].map(prefix=>prefix+pub.number)], pub.kind])
      if (patent.rowCount !== 1) throw new Error('批次及公开号没有唯一对应专利')
      const patentId = patent.rows[0].id
      const prior = backupExists ? await client.query<{new_image_ids:string[]}>('SELECT new_image_ids FROM cnipa.pdf_image_repair_backup WHERE patent_id=$1 AND cardinality(new_image_ids)>0 ORDER BY created_at DESC LIMIT 1 FOR UPDATE', [patentId]) : { rowCount: 0, rows: [] }
      if (prior.rowCount) { await client.query('ROLLBACK'); skipped++; processed--; continue }
      if (commit) {
        const journal=path.resolve('data/patent-image-repair/original-object-backups',item.publication_number,'replacement-journal.json')
        try { await readFile(journal); throw new Error('存在旧图替换恢复记录，请先核查并恢复后再重试') }
        catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error }
      }
      const old = await client.query<{id:string;asset_id:string;file_name:string;oss_key:string;content_hash:string}>("SELECT i.*,a.content_hash FROM cnipa.patent_image i LEFT JOIN cnipa.image_asset a ON a.id=i.asset_id WHERE i.patent_id=$1 AND i.image_role='drawing' AND NOT i.is_abstract FOR UPDATE OF i", [patentId])
      const names = new Set(item.candidate_image_names.map(name => name.toLowerCase()))
      if (!old.rowCount || old.rows.some(image => !names.has(image.file_name.toLowerCase()))) throw new Error('附图不全属于重名候选，跳过以免替换正确图片')
      validateDrawingCount(old.rows.length, images.length)
      if(commit && checkedOldKeys) {
        if(old.rows.some(image=>!checkedOldKeys.has(image.oss_key))) throw new Error('旧附图路径已变化，请重新启动任务进行存在性检查')
      }
      if(commit && !checkedOldKeys) for(let i=0;i<old.rows.length;i+=8) {
        const group=old.rows.slice(i,i+8)
        const exists=await Promise.all(group.map(image=>patentImageExists(image.oss_key)))
        if(exists.some(value=>!value)) throw Object.assign(new Error('旧附图在对象存储中不存在，已跳过'),{code:'STORAGE_MISSING'})
      }
      if (!pdf) throw new Error('原 PDF 已清理，重新提取前请先重新下载')
      if (!commit) { await client.query('ROLLBACK'); console.log(JSON.stringify({number:item.publication_number,status:'ready',old:old.rowCount,pages:images.length})); continue }
      const orderedOld=[...old.rows].sort((a,b)=>a.file_name.localeCompare(b.file_name,'en',{numeric:true,sensitivity:'base'}))
      const prefix=`patents/${item.batch}/${pub.number}/`
      if(orderedOld.some(row=>!row.oss_key.startsWith(prefix) || row.oss_key!==prefix+row.file_name || !row.asset_id || !/\.jpe?g$/i.test(row.file_name)) || new Set(orderedOld.map(row=>row.oss_key.toLowerCase())).size!==orderedOld.length) throw new Error('旧附图路径、格式或关联不符合直接覆盖条件')
      const plans: {image:PdfManifest['images'][number];jpeg:Awaited<ReturnType<typeof encodeRepairJpeg>>;key:string;old:typeof old.rows[number]}[] = []
      for (const [index,image] of manifest.images.entries()) {
        if(encoded[index]?.error) throw encoded[index].error
        const jpeg=encoded[index]?.jpeg
        if(!jpeg) throw new Error('附图压缩结果缺失，请重试')
        plans.push({image,jpeg,key:orderedOld[index].oss_key,old:orderedOld[index]})
      }
      for(const plan of [...plans].sort((a,b)=>a.key.toLowerCase().localeCompare(b.key.toLowerCase()))) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`object:${plan.key.toLowerCase()}`])
        const existingAsset = await client.query<{id:string}>('SELECT id FROM cnipa.image_asset WHERE oss_key=$1 FOR UPDATE',[plan.key])
        if (existingAsset.rowCount!==1 || existingAsset.rows[0].id!==plan.old.asset_id) throw new Error(`目标图片 ${path.posix.basename(plan.key)} 的资产记录不一致`)
      }
      const ids: string[] = []
      for (const [index, plan] of plans.entries()) {
        const {image,key}=plan
        const jpeg=plan.jpeg
        connection.assert();overwriteStarted=true;await putPatentImage(key, jpeg.content, 'image/jpeg')
        if(createHash('sha256').update((await getPatentImage(key)).content).digest('hex')!==jpeg.hash) throw new Error(`新附图 ${path.posix.basename(key)} 校验失败`)
        connection.assert()
        const asset = await client.query<{id:string}>(`INSERT INTO cnipa.image_asset(oss_key,content_hash,content_type,size,width,height) VALUES($1,$2,'image/jpeg',$3,$4,$5) ON CONFLICT(oss_key) DO UPDATE SET content_hash=EXCLUDED.content_hash,content_type=EXCLUDED.content_type,size=EXCLUDED.size,width=EXCLUDED.width,height=EXCLUDED.height WHERE cnipa.image_asset.id=$6::uuid RETURNING id`, [key,jpeg.hash,jpeg.content.length,image.width,image.height,plan.old.asset_id])
        if (!asset.rowCount) throw new Error(`目标图片 ${path.posix.basename(key)} 的资产记录冲突，已停止更新`)
        const inserted = await client.query<{id:string}>(`INSERT INTO cnipa.patent_image(patent_id,asset_id,file_name,oss_key,content_type,size,width,height,is_abstract,image_role,figure_label,source_section,sort_order) VALUES($1,$2,$3,$4,'image/jpeg',$5,$6,$7,false,'drawing',$8,'PDF-repair',$9) RETURNING id`, [patentId,asset.rows[0].id,path.posix.basename(key),key,jpeg.content.length,image.width,image.height,image.figure_label,index])
        ids.push(inserted.rows[0].id)
      }
      await client.query('INSERT INTO cnipa.pdf_image_repair_backup(patent_id,publication_number,pdf_hash,original_images,new_image_ids) VALUES($1,$2,$3,$4::jsonb,$5::uuid[])', [patentId,item.publication_number,item.pdf_hash,JSON.stringify(old.rows),ids])
      await client.query('DELETE FROM cnipa.patent_image WHERE id=ANY($1::uuid[])', [old.rows.map(x=>x.id)])
      commitStarted=true
      await client.query('COMMIT')
      updatedNumbers.add(item.publication_number)
      console.log(JSON.stringify({number:item.publication_number,status:'applied',old:old.rowCount,pages:images.length,old_objects_retained:false,oversized:plans.filter(plan=>!plan.jpeg.targetReached).length}))
    } catch (error) {
      failed = true
      if(overwriteStarted) console.error(JSON.stringify({number:item.publication_number,status:'finalize_failed',error:commitStarted?'数据库提交结果不确定；旧图可能已被覆盖，请核对数据库和对象存储':'旧图可能已被覆盖且未备份，请核对对象存储后重试'}))
      await client.query('ROLLBACK').catch(() => {})
      console.error(JSON.stringify({number:item.publication_number,status:'failed',error:error instanceof Error ? error.message : String(error),error_code:(error as NodeJS.ErrnoException)?.code==='STORAGE_MISSING'?'storage_missing':undefined}))
    } finally { connection.release() }
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
  if (commit && !cleanupFailed && !args.includes('--defer-finalize') && (updatedNumbers.size || cleanupNumbers.size || args.includes('--finalize-only'))) {
    try {
      const result = await finalizeRepairs(pool, args.includes('--finalize-only') ? (chosen ? [chosen] : undefined) : [...new Set([...updatedNumbers,...cleanupNumbers])])
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
