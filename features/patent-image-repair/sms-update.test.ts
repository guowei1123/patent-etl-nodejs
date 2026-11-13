import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import path from 'node:path'

const s=vi.hoisted(()=>({files:new Map<string,Buffer>(),objects:new Map<string,Buffer>(),calls:[] as string[],failPut:false,external:0,foreignTarget:false,originalNames:['SMS_1.JPG','SMS_2.JPG'],description:{body:'前 [[PATENT_IMAGE:SMS_1.JPG]] 中 [[PATENT_IMAGE:SMS_2.JPG]] 后'},originals:[] as Array<Record<string,unknown>>}))
vi.mock('node:fs/promises',()=>({
  readdir:vi.fn(async()=>['CN1234567B-test']),stat:vi.fn(async(p:string)=>{if(p.endsWith('completed')&&!s.files.has(path.resolve(p))) throw Object.assign(new Error('missing'),{code:'ENOENT'});return {mtimeMs:1}}),mkdir:vi.fn(async()=>{}),realpath:vi.fn(async(p:string)=>path.resolve(p)),
  readFile:vi.fn(async(p:string,encoding?:string)=>{const x=s.files.get(path.resolve(p));if(!x) throw Object.assign(new Error('missing'),{code:'ENOENT'});return encoding?x.toString('utf8'):x}),
  open:vi.fn(async(p:string,mode:string)=>{const file=path.resolve(p);if(mode==='wx' && s.files.has(file)) throw Object.assign(new Error('exists'),{code:'EEXIST'});s.files.set(file,Buffer.alloc(0));return {writeFile:async(v:string)=>{s.files.set(file,Buffer.from(v))},sync:async()=>{},close:async()=>{}}}),
  unlink:vi.fn(async(p:string)=>{s.files.delete(path.resolve(p))}),appendFile:vi.fn(async(p:string,v:string)=>{const file=path.resolve(p);s.files.set(file,Buffer.concat([s.files.get(file)||Buffer.alloc(0),Buffer.from(v)]))}),
}))
vi.mock('sharp',()=>({default:()=>({metadata:async()=>({format:'jpeg',width:5,height:5})})}))
vi.mock('@/lib/oss-client',()=>({
  patentImageExists:vi.fn(async(k:string)=>s.objects.has(k.toLowerCase())),
  getPatentImage:vi.fn(async(k:string)=>({content:s.objects.get(k.toLowerCase())!})),
  removePatentImage:vi.fn(async(k:string)=>{s.calls.push('delete:'+k);s.objects.delete(k.toLowerCase())}),
  putPatentImage:vi.fn(async(k:string,v:Buffer)=>{s.calls.push('put:'+k);if(s.failPut && k.endsWith('SMS_2.JPG')){s.failPut=false;throw new Error('模拟写入失败')}s.objects.set(k.toLowerCase(),v)}),
}))
vi.mock('@/lib/pg-db',()=>({
  getSmsReviewSource:vi.fn(async()=>({batch:'batch',description:s.description,originalNames:s.originalNames})),
  getSmsOriginals:vi.fn(async()=>({patentId:'patent',batch:'batch',images:s.originals})),
  getSmsExternalReferences:vi.fn(async()=>s.external),
  acquireSmsUpdateClient:vi.fn(async()=>({release:vi.fn(),query:async(sql:string)=>{
    if(sql.startsWith('SELECT description')) return {rowCount:1,rows:[{description:s.description}]}
    if(sql.startsWith('UPDATE cnipa.patent SET description')) {s.calls.push('update-description');return {rowCount:1,rows:[]}}
    if(sql.startsWith('SELECT id,file_name')) return {rows:s.originals}
    if(sql.startsWith('SELECT id FROM cnipa.patent_image')) return {rowCount:s.foreignTarget?1:0,rows:[]}
    if(sql.startsWith('SELECT id FROM cnipa.patent WHERE')) return {rowCount:0,rows:[]}
    if(sql.startsWith('INSERT INTO cnipa.image_asset')) return {rowCount:1,rows:[{id:'new-asset'}]}
    if(sql==='COMMIT' || sql==='ROLLBACK') s.calls.push(sql)
    return {rowCount:0,rows:[]}
  }})),
}))
vi.mock('@/features/historical-import/pdf/historical-pdf',()=>({readVerifiedImage:vi.fn(),validateManifest:vi.fn()}))

import { smsUpdatePlan, runSmsUpdate, saveSmsReviews, startTask, smsPositionPlan, applySmsPositions, runCombinedSms, smsBatchUpdatePlan, startSmsBatchUpdate } from './service'

const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const prefix='patents/batch/1234567/'
const dir=path.resolve('data/patent-image-repair/sms-preview/CN1234567B-test')
function prepare() {
  s.files.clear();s.objects.clear();s.calls=[];s.failPut=false;s.external=0;s.foreignTarget=false;s.originalNames=['SMS_1.JPG','SMS_2.JPG']
  const images=[Buffer.from('new1'),Buffer.from('new2')]
  const manifest={publication_number:'CN1234567B',images:images.map((b,i)=>({file_name:`SMS_${i+1}.JPG`,sha256:digest(b),status:'extracted'}))}
  const raw=Buffer.from(JSON.stringify(manifest)),mh=digest(raw),dh=digest(Buffer.from(JSON.stringify(s.description)))
  s.files.set(path.join(dir,'manifest.json'),raw)
  for(const [i,b] of images.entries()) s.files.set(path.join(dir,`SMS_${i+1}.JPG`),b)
  s.files.set(path.join(dir,'review.jsonl'),Buffer.from(images.map((b,i)=>JSON.stringify({name:`SMS_${i+1}.JPG`,candidateIndex:i,candidateHash:digest(b),manifestHash:mh,descriptionHash:dh})).join('\n')+'\n'))
  s.originals=[1,2].map(i=>({id:`id${i}`,file_name:`SMS_${i}.JPG`,oss_key:prefix+'SMS_1.JPG',asset_key:prefix+'SMS_1.JPG',asset_id:'old-asset',is_abstract:false,image_role:'inline'}))
  s.objects.set((prefix+'SMS_1.JPG').toLowerCase(),Buffer.from('old'))
}
const task=()=>({mode:'sms-apply' as const,status:'running' as const,number:'CN1234567B',limit:1,completed:0,failed:0,message:'',logs:[] as string[],startedAt:''})

describe('SMS 更新顺序和恢复',()=>{
  beforeEach(prepare)
  it('未逐项确认或旧图被其他记录引用时拒绝预检',async()=>{
    s.files.delete(path.join(dir,'review.jsonl'))
    await expect(smsUpdatePlan('CN1234567B')).rejects.toThrow('尚未确认')
    prepare();s.external=1
    await expect(smsUpdatePlan('CN1234567B')).rejects.toThrow('其他引用')
    expect(s.calls).toEqual([])
  })
  it('批量模式可对数量及编号一一对应的未确认图片按序更新',async()=>{
    s.files.delete(path.join(dir,'review.jsonl'))
    const plan=await smsUpdatePlan('CN1234567B',true)
    expect(plan.automatic).toBe(2)
    await runSmsUpdate(plan.number,plan.fingerprint,task(),true)
    expect(s.calls.at(-1)).toBe('COMMIT')
  })
  it('数量不一致时不进行自动对应或删除图片',async()=>{
    s.files.delete(path.join(dir,'review.jsonl'))
    const manifestFile=path.join(dir,'manifest.json')
    const manifest=JSON.parse(s.files.get(manifestFile)!.toString())
    manifest.images.push({...manifest.images[0],file_name:'SMS_3.JPG'})
    s.files.set(manifestFile,Buffer.from(JSON.stringify(manifest)))
    await expect(smsUpdatePlan('CN1234567B',true)).rejects.toThrow('不满足自动对应条件')
    expect(s.calls).toEqual([])
  })
  it('已有确认与自动顺序冲突时不覆盖确认关系',async()=>{
    const file=path.join(dir,'review.jsonl')
    const events=s.files.get(file)!.toString().trim().split('\n').map(line=>JSON.parse(line))
    events[0].candidateIndex=1;events[0].candidateHash=events[1].candidateHash
    s.files.set(file,Buffer.from(JSON.stringify(events[0])+'\n'))
    await expect(smsUpdatePlan('CN1234567B',true)).rejects.toThrow('已有确认关系与自动编号冲突')
    expect(s.calls).toEqual([])
  })
  it('确认后的清单发生变化时不会删除图片',async()=>{
    const plan=await smsUpdatePlan('CN1234567B')
    await expect(runSmsUpdate(plan.number,'f'.repeat(64),task())).rejects.toThrow('变化')
    expect(s.calls).toEqual([])
  })
  it('目标位置出现其他记录引用时不删除旧图',async()=>{
    const plan=await smsUpdatePlan('CN1234567B')
    s.foreignTarget=true
    await expect(runSmsUpdate(plan.number,plan.fingerprint,task())).rejects.toThrow('其他记录引用')
    expect(s.calls.some(x=>x.startsWith('delete:'))).toBe(false)
  })
  it('共享旧对象仅删除一次，再写入所有新图并提交',async()=>{
    const plan=await smsUpdatePlan('CN1234567B')
    await runSmsUpdate(plan.number,plan.fingerprint,task())
    expect(s.calls.filter(x=>x.startsWith('delete:'))).toHaveLength(1)
    expect(s.calls.findIndex(x=>x.startsWith('delete:'))).toBeLessThan(s.calls.findIndex(x=>x.startsWith('put:')))
    expect(s.calls.at(-1)).toBe('COMMIT')
    expect(s.objects.get((prefix+'SMS_2.JPG').toLowerCase())).toEqual(Buffer.from('new2'))
  })
  it('写入中断后可按同一清单重试，不删除已写入的新图',async()=>{
    const plan=await smsUpdatePlan('CN1234567B')
    s.failPut=true
    await expect(runSmsUpdate(plan.number,plan.fingerprint,task())).rejects.toThrow('模拟写入失败')
    expect(s.calls.at(-1)).toBe('ROLLBACK')
    const deletes=s.calls.filter(x=>x.startsWith('delete:')).length
    await runSmsUpdate(plan.number,plan.fingerprint,task())
    expect(s.calls.filter(x=>x.startsWith('delete:'))).toHaveLength(deletes)
    expect(s.calls.at(-1)).toBe('COMMIT')
  })
})

describe('SMS 一键确认',()=>{
  beforeEach(prepare)
  function input(entries:{name:string;candidateIndex:number}[]) {
    return {number:'CN1234567B',entries,manifestHash:digest(s.files.get(path.join(dir,'manifest.json'))!),descriptionHash:digest(Buffer.from(JSON.stringify(s.description)))}
  }
  it('保留已确认项并一次保存全部待确认项',async()=>{
    const file=path.join(dir,'review.jsonl')
    const first=s.files.get(file)!.toString().split('\n')[0]
    s.files.set(file,Buffer.from(first+'\n'))
    await expect(saveSmsReviews(input([{name:'SMS_2.JPG',candidateIndex:1}]))).resolves.toEqual({confirmed:1})
    const events=s.files.get(file)!.toString().trim().split('\n').map(line=>JSON.parse(line))
    expect(events.map(event=>event.candidateIndex)).toEqual([0,1])
    expect(s.calls).toEqual([])
  })
  it('重复候选时不写入任何确认记录',async()=>{
    const file=path.join(dir,'review.jsonl');s.files.delete(file)
    await expect(saveSmsReviews(input([{name:'SMS_1.JPG',candidateIndex:0},{name:'SMS_2.JPG',candidateIndex:0}]))).rejects.toThrow('已被使用')
    expect(s.files.has(file)).toBe(false)
  })
  it('不接受不完整的待确认清单',async()=>{
    const file=path.join(dir,'review.jsonl');s.files.delete(file)
    await expect(saveSmsReviews(input([{name:'SMS_1.JPG',candidateIndex:0}]))).rejects.toThrow('核对状态已变化')
    expect(s.files.has(file)).toBe(false)
  })
  it('候选文件变化时不保存任何确认',async()=>{
    const file=path.join(dir,'review.jsonl');s.files.delete(file)
    s.files.set(path.join(dir,'SMS_2.JPG'),Buffer.from('changed'))
    await expect(saveSmsReviews(input([{name:'SMS_1.JPG',candidateIndex:0},{name:'SMS_2.JPG',candidateIndex:1}]))).rejects.toThrow('校验失败')
    expect(s.files.has(file)).toBe(false)
  })
  it('数据库没有 SMS 原图时不启动提取',async()=>{
    s.originalNames=[]
    await expect(startTask({mode:'sms',number:'CN1234567B',limit:1,delay:3,proxy:'',retry:false})).rejects.toThrow('没有该专利的 SMS 正文图片')
    expect(s.calls).toEqual([])
  })
})

describe('正文标记位置更新',()=>{
  beforeEach(prepare)
  it('预检后正文发生变化时不更新数据库',async()=>{
    const plan=await smsPositionPlan('CN1234567B')
    s.description={body:'正文已发生变化'}
    await expect(applySmsPositions(plan.number,plan.fingerprint)).rejects.toThrow('变化')
    expect(s.calls).not.toContain('update-description')
    s.description={body:'前 [[PATENT_IMAGE:SMS_1.JPG]] 中 [[PATENT_IMAGE:SMS_2.JPG]] 后'}
  })
})

describe('SMS 批量更新',()=>{
  beforeEach(prepare)
  it('列出可自动对应的专利，并在更新后跳过已完成记录',async()=>{
    s.files.delete(path.join(dir,'review.jsonl'))
    const plan=await smsBatchUpdatePlan(5)
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0].automatic).toBe(2)
    const batch=startSmsBatchUpdate(plan.items)
    await vi.waitFor(()=>expect(batch.status).toBe('completed'))
    expect(batch.completed).toBe(1)
    const next=await smsBatchUpdatePlan(5)
    expect(next.items).toHaveLength(0)
    expect(next.skipped[0].reason).toContain('已更新')
  })
})

describe('合并图片提取',()=>{
  it('只对有 SMS 记录的专利提取正文图片',async()=>{
    const logs:string[]=[],failed:string[]=[],extract=vi.fn(async()=> '已提取 2 个正文图片候选')
    await runCombinedSms(['CN1234567B','CN1234568B'],{stopped:()=>false,hasSms:async number=>number==='CN1234567B',extract,log:m=>logs.push(m),failed:n=>failed.push(n)})
    expect(extract).toHaveBeenCalledOnce()
    expect(extract).toHaveBeenCalledWith('CN1234567B')
    expect(logs[1]).toContain('已跳过正文提取')
    expect(failed).toEqual([])
  })
  it('正文提取失败后记录失败并继续处理下一项',async()=>{
    const logs:string[]=[],failed:string[]=[]
    await runCombinedSms(['CN1234567B','CN1234568B'],{stopped:()=>false,hasSms:async()=>true,extract:async number=>{if(number==='CN1234567B')throw new Error('PDF 无效');return '提取成功'},log:m=>logs.push(m),failed:n=>failed.push(n)})
    expect(failed).toEqual(['CN1234567B'])
    expect(logs[1]).toContain('提取成功')
  })
  it('停止后不会启动下一个正文提取',async()=>{
    let stopped=false
    const extract=vi.fn(async()=>{stopped=true;return '完成'})
    await runCombinedSms(['CN1234567B','CN1234568B'],{stopped:()=>stopped,hasSms:async()=>true,extract,log:()=>{},failed:()=>{}})
    expect(extract).toHaveBeenCalledOnce()
  })
  it('提取成功后自动执行后续更新步骤',async()=>{
    const updated:string[]=[]
    await runCombinedSms(['CN1234567B'],{stopped:()=>false,hasSms:async()=>true,extract:async()=> '提取成功',afterExtract:async number=>{updated.push(number)},log:()=>{},failed:()=>{}})
    expect(updated).toEqual(['CN1234567B'])
  })
})
