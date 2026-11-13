import pg from 'pg'
import { finalizeRepairs } from './repair-finalize.ts'

type Item = {id:string;kind:'mark'|'pdf-note'|'storage-note';number:string;batch:string;note?:string|null}
const chunks:Buffer[]=[]
for await(const chunk of process.stdin) chunks.push(Buffer.from(chunk))
const items=JSON.parse(Buffer.concat(chunks).toString('utf8')) as Item[]
if(!Array.isArray(items) || items.some(item=>!item.id || !/^CN\d{7,12}[ABCUSY]\d?$/.test(item.number) || !/^[A-Za-z0-9_-]+$/.test(item.batch) || !['mark','pdf-note','storage-note'].includes(item.kind) || (item.kind==='pdf-note' && ![null,undefined,'Google Patents 未提供 PDF 链接'].includes(item.note)))) throw new Error('Excel 同步记录无效')
const marks=items.filter(item=>item.kind==='mark')
const notes=items.filter(item=>item.kind==='pdf-note')
const storageNotes=items.filter(item=>item.kind==='storage-note')
const pool=new pg.Pool(process.env.DATABASE_URL ? {connectionString:process.env.DATABASE_URL} : {host:process.env.CNIPA_PG_HOST,port:Number(process.env.CNIPA_PG_PORT||5432),database:process.env.CNIPA_PG_DB,user:process.env.CNIPA_PG_USER,password:process.env.CNIPA_PG_PASSWORD,connectionTimeoutMillis:10000})
try {
  const result=await finalizeRepairs(pool,[...new Set(marks.map(item=>item.number))],{expected:marks,notes,storageNotes})
  if(result.retained.length) throw new Error(`Excel 已更新，但 ${result.retained.length} 个 PDF 未能清理，请检查文件占用或哈希`)
  console.log(JSON.stringify({status:'finalized',...result}))
} catch(error) {
  console.error(JSON.stringify({status:'failed',error:error instanceof Error?error.message:String(error)}))
  process.exitCode=1
} finally {await pool.end()}
