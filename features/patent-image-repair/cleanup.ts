import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, rm, unlink } from 'node:fs/promises'
import path from 'node:path'

const numberPattern = /^CN\d{7,12}[ABCUSY]\d?$/

// Only remove the specific artifacts used by a successfully completed item.
export async function cleanupCompletedArtifacts(root:string, number:string, options:{manifest?:string;smsDirectory?:string;pdfHash?:string}) {
  if (!numberPattern.test(number)) throw new Error('清理失败：公开号无效')
  const errors:string[]=[]
  async function attempt(action:()=>Promise<void>) {
    try { await action() } catch(error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  async function removeDirectory(baseName:string, directory:string, manifestName:string, key:string) {
    const base=await realpath(path.join(root,baseName))
    const actual=await realpath(directory)
    const relative=path.relative(base,actual)
    if (!relative || relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) throw new Error(`${baseName} 清理路径无效`)
    const info=await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${baseName} 清理目录无效`)
    const manifest=JSON.parse(await readFile(path.join(actual,manifestName),'utf8')) as Record<string,unknown>
    if (manifest[key]!==number) throw new Error(`${baseName} 清单公开号不匹配`)
    await rm(actual,{recursive:true,force:true})
  }
  if (options.manifest) await attempt(()=>removeDirectory('images-v3',path.dirname(options.manifest!), 'manifest.json','patent_number'))
  if (options.smsDirectory) await attempt(()=>removeDirectory('sms-preview',options.smsDirectory!, 'manifest.json','publication_number'))
  if (options.pdfHash) await attempt(async()=>{
    if (!/^[a-f0-9]{64}$/.test(options.pdfHash!)) throw new Error('PDF 清理哈希无效')
    const base=await realpath(path.join(root,'pdf'))
    const file=path.join(base,`${number}.pdf`)
    const info=await lstat(file)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('PDF 清理路径无效')
    const hash=createHash('sha256').update(await readFile(file)).digest('hex')
    if (hash!==options.pdfHash) throw new Error('PDF 内容已变化，已保留')
    await unlink(file)
  })
  return errors
}
