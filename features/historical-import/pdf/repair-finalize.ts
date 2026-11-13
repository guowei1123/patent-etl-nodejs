import { spawn } from 'node:child_process'
import path from 'node:path'
import type pg from 'pg'

type Note = {number:string;batch:string;note?:string|null}
export async function finalizeRepairs(pool: pg.Pool, publications?: string[], options?:{expected?:{number:string;batch:string}[];notes?:Note[];storageNotes?:Note[]}) {
  const records = await pool.query<{number:string; batch:string; pdf_hash:string}>(`
    SELECT b.publication_number AS number, p.batch_id AS batch, b.pdf_hash
    FROM cnipa.pdf_image_repair_backup b
    JOIN cnipa.patent p ON p.id=b.patent_id
    WHERE p.batch_id IS NOT NULL AND cardinality(b.new_image_ids)>0
      AND ($1::text[] IS NULL OR b.publication_number=ANY($1::text[]))
      AND (SELECT array_agg(i.id ORDER BY i.id) FROM cnipa.patent_image i
           WHERE i.patent_id=p.id AND i.image_role='drawing' AND NOT i.is_abstract)
          = (SELECT array_agg(x ORDER BY x) FROM unnest(b.new_image_ids) x)
  `, [publications ?? null])
  if(options?.expected) {
    const found=new Set(records.rows.map(row=>`${row.number}\0${row.batch}`))
    if(options.expected.some(item=>!found.has(`${item.number}\0${item.batch}`))) throw new Error('部分专利的附图关联已变化，未更新 Excel 或删除 PDF')
  }
  if (!records.rows.length && !options?.notes?.length && !options?.storageNotes?.length) return { marked:0, deleted:0, retained:[] }
  const python = process.env.PDF_PYTHON || path.resolve('.venv-pdf', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  return new Promise<{marked:number;deleted:number;retained:string[]}>((resolve,reject)=>{
    const child=spawn(python,[path.resolve('features/historical-import/pdf/repair-finalize.py')],{cwd:process.cwd(),windowsHide:true,env:{...process.env,PYTHONUTF8:'1'},stdio:['pipe','pipe','pipe']})
    let out='',err=''
    child.stdout.on('data',chunk=>{out+=String(chunk)})
    child.stderr.on('data',chunk=>{err+=String(chunk)})
    child.once('error',()=>reject(new Error('无法启动 Excel 状态更新，请检查 Python 环境；PDF 已保留')))
    child.once('close',code=>{
      if(code!==0) { let message='Excel 更新失败，PDF 已保留';try {message=JSON.parse(err).error || message} catch {/* Keep the fallback message. */} reject(new Error(message));return }
      try { resolve(JSON.parse(out)) } catch { reject(new Error('Excel 更新结果无效，请核查；PDF 可能未清理')) }
    })
    child.stdin.end(JSON.stringify(options ? {items:records.rows,notes:options.notes||[],storage_notes:options.storageNotes||[]} : records.rows))
  })
}
