import { createHash } from 'node:crypto'
import pg from 'pg'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { getPatentImage, patentImageExists, putPatentImage } from '../../../lib/oss-client.ts'
import { legacyRepairImageKey } from './repair-key.ts'
import { readVerifiedImage, validateManifest, type PdfManifest } from './historical-pdf.ts'

const apply = process.argv.includes('--apply')
const pool = new pg.Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {
  host: process.env.CNIPA_PG_HOST, port: Number(process.env.CNIPA_PG_PORT || 5432),
  database: process.env.CNIPA_PG_DB, user: process.env.CNIPA_PG_USER, password: process.env.CNIPA_PG_PASSWORD,
})
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex')
type Row = { image_id:string; asset_id:string; source_key:string; content_hash:string; content_type:string; size:number; width:number|null; height:number|null; batch_id:string; doc_number:string; kind:string; sort_order:number|null }

async function localFallback(row: Row, publication: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(row.batch_id) || !/^\d{7,12}$/.test(row.doc_number.replace(/^CN/i,''))) throw new Error('批次或专利号无效')
  const directory=path.resolve('data/patent-image-repair/images-v3',row.batch_id,row.doc_number.replace(/^CN/i,''))
  const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8')) as PdfManifest
  validateManifest(manifest,'repair')
  if(manifest.patent_number!==publication) throw new Error('本地图片清单公开号不一致')
  const image=manifest.images.find(x=>x.content_hash===row.content_hash && x.image_role==='drawing')
  if(!image) throw new Error('找不到与数据库哈希一致的本地说明书附图')
  return readVerifiedImage(directory,image)
}

async function main() {
  const patents = await pool.query<{patent_id:string}>(`SELECT DISTINCT i.patent_id FROM cnipa.patent_image i JOIN cnipa.image_asset a ON a.id=i.asset_id WHERE i.source_section='PDF-repair' AND a.oss_key LIKE 'patents/pdf-repair/%' ORDER BY i.patent_id`)
  let count=0, failures=0
  for (const {patent_id} of patents.rows) {
    const client=await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT id FROM cnipa.patent WHERE id=$1 FOR UPDATE',[patent_id])
      const result=await client.query<Row>(`SELECT i.id image_id,i.asset_id,a.oss_key source_key,a.content_hash,a.content_type,a.size,a.width,a.height,p.batch_id,p.doc_number,p.kind,i.sort_order FROM cnipa.patent_image i JOIN cnipa.image_asset a ON a.id=i.asset_id JOIN cnipa.patent p ON p.id=i.patent_id WHERE i.patent_id=$1 AND i.source_section='PDF-repair' AND i.image_role='drawing' AND NOT i.is_abstract AND a.oss_key LIKE 'patents/pdf-repair/%' ORDER BY i.sort_order NULLS LAST,i.id FOR UPDATE OF i,a`,[patent_id])
      for (const [index,row] of result.rows.entries()) {
        const publication=`CN${row.doc_number.replace(/^CN/i,'')}${row.kind}`
        const key=legacyRepairImageKey(row.batch_id, publication, row.content_hash, index+1)
        let content: Buffer
        try { content=(await getPatentImage(row.source_key)).content }
        catch(error) {
          const code=(error as {code?:string}).code
          if(code!=='NoSuchKey' && code!=='NotFound') throw error
          content=await localFallback(row,publication)
        }
        if (digest(content)!==row.content_hash) throw new Error('源图片哈希不一致')
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`object:${key}`])
        if (await patentImageExists(key)) {
          const existing=await getPatentImage(key)
          if(digest(existing.content)!==row.content_hash) throw new Error('目标对象内容不同，已停止迁移')
        } else if (apply) {
          await putPatentImage(key,content,row.content_type)
          const verified=await getPatentImage(key)
          if(digest(verified.content)!==row.content_hash) throw new Error('目标图片校验失败')
        }
        if (apply) {
          const asset=await client.query<{id:string;content_hash:string}>(`INSERT INTO cnipa.image_asset(oss_key,content_hash,content_type,size,width,height) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(oss_key) DO UPDATE SET oss_key=EXCLUDED.oss_key RETURNING id,content_hash`,[key,row.content_hash,row.content_type,row.size,row.width,row.height])
          if(asset.rows[0].content_hash!==row.content_hash) throw new Error('目标资产哈希冲突')
          await client.query('UPDATE cnipa.patent_image SET asset_id=$2,oss_key=$3,file_name=$4 WHERE id=$1',[row.image_id,asset.rows[0].id,key,path.posix.basename(key)])
        }
        count++
      }
      await client.query(apply?'COMMIT':'ROLLBACK')
      console.log(JSON.stringify({patent:patent_id,images:result.rowCount,status:apply?'migrated':'ready'}))
    } catch (error) {
      failures++
      await client.query('ROLLBACK').catch(()=>{})
      console.error(JSON.stringify({patent:patent_id,error:error instanceof Error?error.message:String(error)}))
    } finally { client.release() }
  }
  console.log(JSON.stringify({images:count,patents:patents.rowCount,failures,applied:apply}))
  if(failures) process.exitCode=1
}
main().finally(()=>pool.end())
