import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import type pg from 'pg'

const mocks=vi.hoisted(()=>({get:vi.fn()}))
vi.mock('../../../lib/oss-client.ts',()=>({getPatentImage:mocks.get}))
import { loadRepairAbstracts, matchRepairAbstracts, type AbstractAsset } from '../pdf/repair-dedup'

const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
async function sample() {
  const svg='<svg width="200" height="160"><rect width="200" height="160" fill="white"/><rect x="25" y="30" width="120" height="95" stroke="black" fill="none" stroke-width="5"/><path d="M25 30 L145 125" stroke="black" stroke-width="5"/><circle cx="60" cy="70" r="15" fill="black"/></svg>'
  const drawing=await sharp(Buffer.from(svg)).png().toBuffer()
  const abstract=await sharp(drawing).resize(150,120).jpeg().toBuffer()
  const blank=await sharp({create:{width:200,height:160,channels:3,background:'white'}}).png().toBuffer()
  const image=(file:string,content:Buffer)=>({file_name:file,page:1,width:200,height:160,content_hash:hash(content),figure_label:'图1',image_role:'drawing' as const})
  const asset:AbstractAsset={id:'abstract-id',oss_key:'patents/batch/123/abstract.jpg',content_hash:hash(abstract),content_type:'image/jpeg',size:abstract.length,width:150,height:120,file_name:'abstract.jpg',content:abstract}
  return {asset,images:[image('drawing_1.png',drawing),image('drawing_2.png',blank)],contents:[drawing,blank]}
}

describe('修复附图去重',()=>{
  it('相同字节复用摘要资源，只匹配对应的说明书图',async()=>{
    const {asset,images,contents}=await sample()
    images[0].content_hash=asset.content_hash
    contents[0]=asset.content
    const matches=await matchRepairAbstracts([asset],images,contents)
    expect(matches.size).toBe(1)
    expect(matches.get(0)?.asset.id).toBe('abstract-id')
    expect(matches.get(0)?.match.method).toBe('sha256')
    expect(matches.get(0)?.displayRotation).toBe(0)
  })
  it('多张完全相同的说明书图均复用摘要资源',async()=>{
    const {asset,images,contents}=await sample()
    images[0].content_hash=asset.content_hash
    contents[0]=asset.content
    images[1]={...images[0],file_name:'drawing_2.png'}
    contents[1]=asset.content
    const matches=await matchRepairAbstracts([asset],images,contents)
    expect([...matches.keys()]).toEqual([0,1])
  })
  it('不同尺寸及格式的同图通过项目现有结构匹配器识别',async()=>{
    const {asset,images,contents}=await sample()
    const script=`import {readFileSync} from 'node:fs';import {matchRepairAbstracts} from './features/historical-import/pdf/repair-dedup.ts';const x=JSON.parse(readFileSync(0,'utf8'));x.asset.content=Buffer.from(x.asset.content,'base64');const matches=await matchRepairAbstracts([x.asset],x.images,x.contents.map(v=>Buffer.from(v,'base64')));process.stdout.write(JSON.stringify([...matches].map(([i,v])=>({index:i,method:v.match.method}))));`
    const result=JSON.parse(execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',script],{input:JSON.stringify({asset:{...asset,content:asset.content.toString('base64')},images,contents:contents.map(b=>b.toString('base64'))}),encoding:'utf8',windowsHide:true,timeout:20000}))
    expect(result).toEqual([{index:0,method:'hash-top5-binary-structure'}])
  })
  it('匹配器识别旋转后，复用摘要图时按相反方向显示',async()=>{
    const {asset,images,contents}=await sample()
    const rotated=await sharp(contents[0]).rotate(90).jpeg().toBuffer()
    const script=`import {readFileSync} from 'node:fs';import {matchRepairAbstracts} from './features/historical-import/pdf/repair-dedup.ts';const x=JSON.parse(readFileSync(0,'utf8'));x.asset.content=Buffer.from(x.asset.content,'base64');const matches=await matchRepairAbstracts([x.asset],x.images,x.contents.map(v=>Buffer.from(v,'base64')));const v=matches.get(0);process.stdout.write(JSON.stringify({rotation:v?.match.rotation,display:v?.displayRotation}));`
    const rotatedAsset={...asset,content_hash:hash(rotated),content:rotated.toString('base64')}
    const result=JSON.parse(execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',script],{input:JSON.stringify({asset:rotatedAsset,images:images.slice(0,1),contents:contents.slice(0,1).map(b=>b.toString('base64'))}),encoding:'utf8',windowsHide:true,timeout:20000}))
    expect(result).toEqual({rotation:90,display:270})
  })
  it('摘要资源哈希不一致时停止而不是复用错误图片',async()=>{
    const {asset}=await sample()
    mocks.get.mockResolvedValue({content:Buffer.from('other')})
    const query=vi.fn(async(sql:string)=>sql.includes('SELECT DISTINCT')?{rows:[asset],rowCount:1}:{rows:[{oss_key:asset.oss_key,content_hash:asset.content_hash}],rowCount:1})
    await expect(loadRepairAbstracts({query} as unknown as pg.PoolClient,'patent',null)).rejects.toThrow('哈希不一致')
  })
  it('摘要路径仅保存文件名时，使用当前专利已有的完整资源路径',async()=>{
    const {asset}=await sample()
    mocks.get.mockResolvedValue({content:asset.content})
    const query=vi.fn(async(sql:string)=>sql.includes('SELECT DISTINCT')?{rows:[asset],rowCount:1}:{rows:[{oss_key:asset.oss_key,content_hash:asset.content_hash}],rowCount:1})
    const result=await loadRepairAbstracts({query} as unknown as pg.PoolClient,'patent','abstract.jpg')
    expect(result).toHaveLength(1)
    expect(result[0].oss_key).toBe(asset.oss_key)
    expect(mocks.get).toHaveBeenCalledWith(asset.oss_key)
    expect(query.mock.calls.some(([sql])=>sql.includes('regexp_replace'))).toBe(false)
  })
  it('同一文件名匹配多个摘要资源时停止',async()=>{
    const {asset}=await sample()
    const query=vi.fn(async()=>({rows:[asset,{...asset,id:'other',oss_key:'patents/other/abstract.jpg'}],rowCount:2}))
    await expect(loadRepairAbstracts({query} as unknown as pg.PoolClient,'patent','abstract.jpg')).rejects.toThrow('多个资源')
  })
  it('读取不到摘要图时停止而不是跳过去重',async()=>{
    const {asset}=await sample()
    mocks.get.mockRejectedValue(new Error('storage unavailable'))
    const query=vi.fn(async(sql:string)=>sql.includes('SELECT DISTINCT')?{rows:[asset],rowCount:1}:{rows:[{oss_key:asset.oss_key,content_hash:asset.content_hash}],rowCount:1})
    await expect(loadRepairAbstracts({query} as unknown as pg.PoolClient,'patent',null)).rejects.toThrow('摘要图无法读取')
    await expect(loadRepairAbstracts({query} as unknown as pg.PoolClient,'patent',null)).rejects.toThrow('storage unavailable')
  })
})
