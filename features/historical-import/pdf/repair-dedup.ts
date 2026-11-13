import { createHash } from 'node:crypto'
import type pg from 'pg'
import { getPatentImage } from '../../../lib/oss-client.ts'
import { matchPatentAbstractToDrawing, type PatentImageMatch } from '../../../lib/patent-image-matcher.ts'
import type { PdfManifest } from './historical-pdf.ts'

export type AbstractAsset = {
  id:string; oss_key:string; content_hash:string; content_type:string; size:number;
  width:number|null; height:number|null; file_name:string; content:Buffer
}
export type ReusedAbstract = { asset:AbstractAsset; match:PatentImageMatch; displayRotation:number }

/** Load the same patent's real abstract objects and verify their stored hashes. */
export async function loadRepairAbstracts(client:pg.PoolClient, patentId:string, abstractKey:string|null) {
  const result=await client.query<Omit<AbstractAsset,'content'>>(`SELECT DISTINCT a.id,a.oss_key,a.content_hash,a.content_type,a.size,a.width,a.height,i.file_name
    FROM cnipa.patent_image i JOIN cnipa.image_asset a ON a.id=i.asset_id
    WHERE i.patent_id=$1 AND (i.is_abstract OR i.image_role='abstract')`,[patentId])
  const rows=result.rows
  const bareName=Boolean(abstractKey && !/[\\/]/.test(abstractKey))
  const keyMatches=abstractKey ? rows.filter(row=>row.oss_key===abstractKey || (bareName && (row.file_name.toLowerCase()===abstractKey.toLowerCase() || row.oss_key.split('/').at(-1)?.toLowerCase()===abstractKey.toLowerCase()))) : []
  if(new Set(keyMatches.map(row=>row.id)).size>1) throw new Error('摘要图文件名对应多个资源，无法安全去重')
  if(abstractKey && !keyMatches.length) {
    const fallback=bareName
      ? await client.query<Omit<AbstractAsset,'content'>>(`SELECT a.id,a.oss_key,a.content_hash,a.content_type,a.size,a.width,a.height,$2::text AS file_name FROM cnipa.patent p JOIN cnipa.image_asset a ON a.oss_key=('patents/'||p.batch_id||'/'||regexp_replace(p.doc_number,'^CN','','i')||'/'||$2) WHERE p.id=$1`,[patentId,abstractKey])
      : await client.query<Omit<AbstractAsset,'content'>>(`SELECT id,oss_key,content_hash,content_type,size,width,height,regexp_replace(oss_key,'^.*/','') AS file_name FROM cnipa.image_asset WHERE oss_key=$1`,[abstractKey])
    if(!fallback.rowCount) throw new Error('摘要图资源记录缺失，无法安全去重')
    rows.push(fallback.rows[0])
  }
  const unique=new Map<string,AbstractAsset>()
  for(const row of rows) {
    if(unique.has(row.id)) continue
    const locked=await client.query<{oss_key:string;content_hash:string}>('SELECT oss_key,content_hash FROM cnipa.image_asset WHERE id=$1 FOR UPDATE',[row.id])
    if(locked.rowCount!==1 || locked.rows[0].oss_key!==row.oss_key || locked.rows[0].content_hash!==row.content_hash) throw new Error('摘要图资源已变化，请重试')
    let content:Buffer
    try { content=(await getPatentImage(row.oss_key)).content }
    catch(error) {
      const reason=error instanceof Error ? error.message : String(error)
      const code=typeof error==='object' && error!==null && 'code' in error ? String(error.code) : ''
      throw new Error(`摘要图无法读取（对象：${row.oss_key}${code ? `，错误码：${code}` : ''}）：${reason}；无法安全去重`)
    }
    const hash=createHash('sha256').update(content).digest('hex')
    if(row.content_hash.startsWith('legacy:')) {
      await client.query('UPDATE cnipa.image_asset SET content_hash=$2 WHERE id=$1 AND content_hash=$3',[row.id,hash,row.content_hash])
      row.content_hash=hash
    } else if(row.content_hash!==hash) throw new Error('摘要图内容与资源哈希不一致，无法安全去重')
    unique.set(row.id,{...row,content})
  }
  return [...unique.values()]
}

/** Reuse the existing SHA/visual matcher before JPG compression or uploads. */
export async function matchRepairAbstracts(abstracts:AbstractAsset[], images:PdfManifest['images'], contents:Buffer[]) {
  const matches=new Map<number,ReusedAbstract>()
  const drawings=images.map((image,index)=>({fileName:image.file_name,content:contents[index],contentHash:image.content_hash,width:image.width,height:image.height}))
  for(const asset of abstracts) {
    const match=await matchPatentAbstractToDrawing({fileName:asset.file_name,content:asset.content,contentHash:asset.content_hash,width:asset.width ?? undefined,height:asset.height ?? undefined},drawings)
    if(!match) continue
    const index=images.findIndex(image=>image.file_name===match.drawingFileName)
    if(index<0) continue
    for(const [candidate,image] of images.entries()) {
      if(image.content_hash!==images[index].content_hash) continue
      const previous=matches.get(candidate)
      if(!previous || match.score>previous.match.score) matches.set(candidate,{asset,match,displayRotation:(360-match.rotation)%360})
    }
  }
  return matches
}
