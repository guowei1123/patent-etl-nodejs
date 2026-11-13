import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const mocks=vi.hoisted(()=>({ files:new Map<string,Buffer>(), objects:new Map<string,Buffer>(), remove:vi.fn() }))
vi.mock('node:fs/promises',()=>({
  mkdir:vi.fn(),
  open:vi.fn(async (file:string)=>({writeFile:async (data:Buffer|string)=>{mocks.files.set(file,Buffer.from(data))},sync:async()=>{},close:async()=>{}})),
  readFile:vi.fn(async (file:string,encoding?:string)=>{
    const data=mocks.files.get(file)
    if (!data) throw Object.assign(new Error('missing'),{code:'ENOENT'})
    return encoding ? data.toString('utf8') : data
  }),
}))
vi.mock('../../../lib/oss-client.ts',()=>({
  getPatentImage:vi.fn(async (key:string)=>{
    const content=mocks.objects.get(key.toLowerCase())
    if (!content) throw Object.assign(new Error('missing'),{code:'NoSuchKey'})
    return {content}
  }),
  putPatentImage:vi.fn(async (key:string,content:Buffer)=>{mocks.objects.set(key.toLowerCase(),content)}),
  removePatentImage:mocks.remove,
}))

import { prepareReplacements, recoverReplacements } from '../pdf/repair-replacement'
import { cleanupReplacedDrawings } from '../pdf/repair-clean-old'

const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex')
const number='CN220242240U'
const prefix='patents/batch/220242240/'
const key=prefix+'FT_1.JPG'
const original=Buffer.from('old image')
const replacement=Buffer.from('new image')

beforeEach(()=>{mocks.files.clear();mocks.objects.clear();mocks.remove.mockReset();mocks.objects.set(key.toLowerCase(),original)})

describe('同名附图替换保护',()=>{
  it('删除旧图后发生中断时从已校验的备份恢复',async()=>{
    await prepareReplacements(number,[{oldKey:key,newHash:sha(replacement)}])
    mocks.objects.delete(key.toLowerCase())
    await recoverReplacements(number,prefix)
    expect(mocks.objects.get(key.toLowerCase())).toEqual(original)
  })
  it('新图写入后事务失败时恢复旧图',async()=>{
    await prepareReplacements(number,[{oldKey:key,newHash:sha(replacement)}])
    mocks.objects.set(key.toLowerCase(),replacement)
    await recoverReplacements(number,prefix)
    expect(mocks.objects.get(key.toLowerCase())).toEqual(original)
  })
  it('恢复时拒绝覆盖其他操作写入的内容',async()=>{
    await prepareReplacements(number,[{oldKey:key,newHash:sha(replacement)}])
    mocks.objects.set(key.toLowerCase(),Buffer.from('unrelated'))
    await expect(recoverReplacements(number,prefix)).rejects.toThrow('其他操作修改')
  })
  it('清理旧图时不会删除大小写不同但实际为同一对象的新图',async()=>{
    mocks.objects.set(key.toLowerCase(),replacement)
    const query=vi.fn(async (sql:string)=>{
      if(sql.includes('SELECT b.patent_id')) return {rowCount:1,rows:[{patent_id:'patent',batch_id:'batch',original_images:[{asset_id:'old',oss_key:key,file_name:'FT_1.JPG',image_role:'drawing',is_abstract:false}],new_image_ids:['new']}]}
      if(sql.includes('SELECT i.id,a.oss_key')) return {rows:[{id:'new',oss_key:prefix+'FT_1.jpg',content_hash:sha(replacement)}]}
      return {rows:[]}
    })
    const client={query,release:vi.fn()}
    const pool={connect:async()=>client}
    await expect(cleanupReplacedDrawings(pool as never,number)).resolves.toEqual({removed:0,retained:0})
    expect(mocks.remove).not.toHaveBeenCalled()
  })
})
