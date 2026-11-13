import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type pg from 'pg'
import { getPatentImage, removePatentImage } from '../../../lib/oss-client.ts'
import { parsePublicationNumber } from './historical-pdf.ts'

type OldImage = { asset_id:string; oss_key:string; file_name:string; image_role:string; is_abstract:boolean }
const sha = (value:Buffer) => createHash('sha256').update(value).digest('hex')

/** Remove only unreferenced original drawing objects after verifying current replacements. */
export async function cleanupReplacedDrawings(pool:pg.Pool, number:string, options:{dryRun?:boolean} = {}) {
  const publication=parsePublicationNumber(number)
  const client=await pool.connect()
  try {
    await client.query('BEGIN')
    const result=await client.query<{patent_id:string; batch_id:string; original_images:OldImage[]; new_image_ids:string[]}>(`SELECT b.patent_id,p.batch_id,b.original_images,b.new_image_ids FROM cnipa.pdf_image_repair_backup b JOIN cnipa.patent p ON p.id=b.patent_id WHERE b.publication_number=$1 ORDER BY b.created_at DESC LIMIT 1 FOR UPDATE OF b,p`,[number])
    if(result.rowCount!==1) throw new Error('没有找到修复备份，旧图未删除')
    const record=result.rows[0]
    const current=await client.query<{id:string;oss_key:string;content_hash:string}>(`SELECT i.id,a.oss_key,a.content_hash FROM cnipa.patent_image i JOIN cnipa.image_asset a ON a.id=i.asset_id WHERE i.patent_id=$1 AND i.image_role='drawing' AND NOT i.is_abstract FOR UPDATE OF i,a`,[record.patent_id])
    const expected=new Set(record.new_image_ids)
    if(!expected.size || current.rows.length!==expected.size || current.rows.some(i=>!expected.has(i.id))) throw new Error('当前附图与修复记录不一致，旧图未删除')
    for(const image of current.rows) {
      const object=await getPatentImage(image.oss_key)
      if(sha(object.content)!==image.content_hash) throw new Error('新附图校验失败，旧图未删除')
    }
    const prefix=`patents/${record.batch_id}/${publication.number}/`
    const old=record.original_images.filter(i=>i.image_role==='drawing'&&!i.is_abstract)
    if(old.some(i=>!i.asset_id||!i.oss_key?.startsWith(prefix)||i.oss_key.slice(prefix.length)!==i.file_name||!/^FT_\d+\.(?:jpe?g|tif{1,2}|png)$/i.test(i.file_name))) throw new Error('旧图路径或格式不符合清理范围，旧图未删除')
    const ids=old.map(i=>i.asset_id),keys=old.map(i=>i.oss_key)
    await client.query('SELECT id FROM cnipa.image_asset WHERE id=ANY($1::uuid[]) FOR UPDATE',[ids])
    const refs=await client.query<{oss_key:string}>(`SELECT DISTINCT i.oss_key FROM cnipa.patent_image i WHERE i.asset_id=ANY($1::uuid[]) OR i.oss_key=ANY($2::text[])`,[ids,keys])
    const abstract=await client.query<{abstract_fig_key:string}>(`SELECT DISTINCT abstract_fig_key FROM cnipa.patent WHERE abstract_fig_key=ANY($1::text[])`,[keys])
    const referenced=new Set([...refs.rows.map(r=>r.oss_key),...abstract.rows.map(r=>r.abstract_fig_key)])
    // If a shared asset is referenced under another key, retain all old assets.
    const assetRefs=await client.query<{asset_id:string}>('SELECT DISTINCT asset_id FROM cnipa.patent_image WHERE asset_id=ANY($1::uuid[])',[ids])
    const shared=new Set(assetRefs.rows.map(r=>r.asset_id))
    const directory=path.resolve('data/patent-image-repair/original-object-backups',number)
    if (!options.dryRun) await mkdir(directory,{recursive:true})
    let removed=0, retained=0
    for(const image of old) {
      if(referenced.has(image.oss_key)||shared.has(image.asset_id)) {retained++;continue}
      let content:Buffer
      try { content=(await getPatentImage(image.oss_key)).content }
      catch(error) { if(['NoSuchKey','NotFound'].includes((error as {code?:string}).code||'')) continue; throw error }
      // Case-insensitive storage may resolve the old key to the new object.
      // Never delete it when the content is now the verified replacement.
      const replacement=current.rows.find(row=>row.oss_key.toLowerCase()===image.oss_key.toLowerCase())
      if (replacement && sha(content)===replacement.content_hash) continue
      if (options.dryRun) { removed++; continue }
      const file=path.join(directory,`${sha(content)}-${image.file_name}`)
      try { await writeFile(file,content,{flag:'wx'}) } catch(error) { if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error }
      if(sha(await readFile(file))!==sha(content)) throw new Error('旧图本地备份校验失败')
      await removePatentImage(image.oss_key)
      removed++
    }
    await client.query('COMMIT')
    return { removed, retained }
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>{})
    throw error
  } finally { client.release() }
}
