import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cleanupCompletedArtifacts } from './cleanup'

describe('完成后的处理文件清理',()=>{
  it('仅删除属于已完成专利且校验一致的处理文件',async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'patent-cleanup-test-'))
    try {
      const drawing=path.join(root,'images-v3','batch','1234567')
      const sms=path.join(root,'sms-preview','CN1234567B-test')
      await Promise.all([mkdir(drawing,{recursive:true}),mkdir(sms,{recursive:true}),mkdir(path.join(root,'pdf'))])
      await writeFile(path.join(drawing,'manifest.json'),JSON.stringify({patent_number:'CN1234567B'}))
      await writeFile(path.join(sms,'manifest.json'),JSON.stringify({publication_number:'CN1234567B'}))
      const pdf=path.join(root,'pdf','CN1234567B.pdf')
      await writeFile(pdf,'pdf content')
      const hash=createHash('sha256').update('pdf content').digest('hex')
      expect(await cleanupCompletedArtifacts(root,'CN1234567B',{manifest:path.join(drawing,'manifest.json'),smsDirectory:sms,pdfHash:hash})).toEqual([])
      await expect(readFile(pdf)).rejects.toMatchObject({code:'ENOENT'})
      await expect(readFile(path.join(drawing,'manifest.json'))).rejects.toMatchObject({code:'ENOENT'})
      await expect(readFile(path.join(sms,'manifest.json'))).rejects.toMatchObject({code:'ENOENT'})
    } finally {await rm(root,{recursive:true,force:true})}
  })
  it('公开号不匹配、路径越界或 PDF 内容变化时保留文件',async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'patent-cleanup-test-'))
    try {
      const drawing=path.join(root,'images-v3','batch','1234567')
      const outside=path.join(root,'outside')
      await Promise.all([mkdir(drawing,{recursive:true}),mkdir(outside),mkdir(path.join(root,'sms-preview')),mkdir(path.join(root,'pdf'))])
      await writeFile(path.join(drawing,'manifest.json'),JSON.stringify({patent_number:'CN7654321B'}))
      await writeFile(path.join(outside,'manifest.json'),JSON.stringify({publication_number:'CN1234567B'}))
      const pdf=path.join(root,'pdf','CN1234567B.pdf')
      await writeFile(pdf,'changed')
      const errors=await cleanupCompletedArtifacts(root,'CN1234567B',{manifest:path.join(drawing,'manifest.json'),smsDirectory:outside,pdfHash:'a'.repeat(64)})
      expect(errors).toHaveLength(3)
      expect(await readFile(pdf,'utf8')).toBe('changed')
      expect(await readFile(path.join(drawing,'manifest.json'),'utf8')).toContain('CN7654321B')
      expect(await readFile(path.join(outside,'manifest.json'),'utf8')).toContain('CN1234567B')
    } finally {await rm(root,{recursive:true,force:true})}
  })
})
