import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import path from 'node:path'
import { getPatentImage, putPatentImage } from '../../../lib/oss-client.ts'
import { parsePublicationNumber } from './historical-pdf.ts'

export type Replacement = { oldKey:string; newHash:string; oldHash:string; backup:string }
const digest = (data:Buffer) => createHash('sha256').update(data).digest('hex')
const root = path.resolve('data/patent-image-repair/original-object-backups')

function directory(number:string) {
  parsePublicationNumber(number)
  return path.join(root, number)
}

async function durableWrite(file:string, data:Buffer|string) {
  const handle = await open(file, 'w')
  try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
}

/** Persist all original bytes and a recovery journal before overwriting any object. */
export async function prepareReplacements(number:string, entries:{oldKey:string;newHash:string}[]) {
  const dir=directory(number)
  await mkdir(dir,{recursive:true})
  const saved:Replacement[]=[]
  for (const entry of entries) {
    const fileName=path.posix.basename(entry.oldKey)
    if (!/^FT_\d+\.jpe?g$/i.test(fileName) || !/^[a-f0-9]{64}$/.test(entry.newHash)) throw new Error('待替换图片名称或哈希无效')
    const content=(await getPatentImage(entry.oldKey)).content
    const oldHash=digest(content)
    const backup=`${oldHash}-${fileName}`
    const file=path.join(dir,backup)
    await durableWrite(file,content)
    if (digest(await readFile(file))!==oldHash) throw new Error('旧图备份校验失败')
    saved.push({...entry,oldHash,backup})
  }
  await durableWrite(path.join(dir,'replacement-journal.json'),JSON.stringify({number,entries:saved}))
  return saved
}

/** Restore only known partially replaced objects; refuse unexpected content. */
export async function recoverReplacements(number:string, expectedPrefix:string) {
  const dir=directory(number)
  let text:string
  try { text=await readFile(path.join(dir,'replacement-journal.json'),'utf8') }
  catch(error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return; throw error }
  const journal=JSON.parse(text) as {number:string;entries:Replacement[]}
  if (journal.number!==number || !Array.isArray(journal.entries)) throw new Error('旧图恢复记录无效，请人工检查')
  for (const entry of journal.entries) {
    const fileName=path.posix.basename(entry.oldKey)
    if (!entry.oldKey.startsWith(expectedPrefix) || entry.oldKey!==expectedPrefix+fileName || !/^FT_\d+\.jpe?g$/i.test(fileName) || !/^[a-f0-9]{64}$/.test(entry.oldHash) || !/^[a-f0-9]{64}$/.test(entry.newHash) || entry.backup!==`${entry.oldHash}-${fileName}`) throw new Error('旧图恢复记录路径无效，请人工检查')
    const original=await readFile(path.join(dir,entry.backup))
    if(digest(original)!==entry.oldHash) throw new Error('旧图备份校验失败，请人工检查')
    let existing:Buffer|null
    try { existing=(await getPatentImage(entry.oldKey)).content }
    catch(error) { if (['NoSuchKey','NotFound'].includes((error as {code?:string}).code||'')) existing=null; else throw error }
    const hash=existing && digest(existing)
    if(hash===entry.oldHash) continue
    if(hash!==null && hash!==entry.newHash) throw new Error('待恢复的旧图已被其他操作修改，请人工检查')
    await putPatentImage(entry.oldKey,original,'image/jpeg')
    if(digest((await getPatentImage(entry.oldKey)).content)!==entry.oldHash) throw new Error('旧图恢复校验失败，请人工检查')
  }
}
