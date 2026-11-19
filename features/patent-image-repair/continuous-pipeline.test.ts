import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Readable, Writable } from 'node:stream'
import path from 'node:path'

const state=vi.hoisted(()=>({events:[] as string[],files:new Map<string,string>(),snapshot:'',failFinalize:false,unavailable:false,missing:false,updateDelay:0,smsPresent:false,items:['CN1234567B','CN1234568B'].map(publication_number=>({publication_number,batch:'batch',image_names:['FT_1.JPG'],repair_status:''}))}))
vi.mock('node:fs',()=>({
  readFileSync:()=>{throw Object.assign(new Error('missing'),{code:'ENOENT'})},
  createReadStream:()=>Readable.from([state.snapshot]),
  createWriteStream:()=>{state.snapshot='';return new Writable({write(chunk,_encoding,callback){state.snapshot+=String(chunk);callback()}})},
}))
vi.mock('node:fs/promises',()=>({
  mkdir:vi.fn(async()=>{}),
  readFile:vi.fn(async(p:string)=>{const value=state.files.get(p);if(value===undefined) throw Object.assign(new Error('missing'),{code:'ENOENT'});return value}),
  appendFile:vi.fn(async(p:string,value:string)=>{state.files.set(p,(state.files.get(p)||'')+value)}),
  stat:vi.fn(async(p:string)=>{if(String(p).includes('sms-updates') && !state.files.has(p)) throw Object.assign(new Error('missing'),{code:'ENOENT'});return {mtimeMs:1}}),realpath:vi.fn(),readdir:vi.fn(async()=>[]),open:vi.fn(),unlink:vi.fn(),rename:vi.fn(),
}))
vi.mock('node:child_process',()=>({spawn:vi.fn((_command:string,args:string[])=>{
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),kill:vi.fn()})
  let data=''
  child.stdin.on('data',chunk=>{data+=String(chunk)})
  if(args.includes('--list-candidates')) {
    setTimeout(()=>{child.stdout.end(state.items.map(item=>JSON.stringify(item)).join('\n')+'\n');child.stderr.end();child.emit('close',0)},0)
    return child
  }
  child.stdin.on('finish',()=>{
    if(args.includes('--single-stdin')) {
      const item=JSON.parse(data);const n=item.publication_number
      state.events.push(`download:${n}${args.includes('--pdf-only')?':pdf-only':''}`)
      setTimeout(()=>{child.stdout.end(JSON.stringify({...item,status:args.includes('--pdf-only')?'pdf_ready':'ready',repair_revision:4,pdf:`${n}.pdf`,manifest:args.includes('--pdf-only')?undefined:`${n}.json`})+'\n');child.stderr.end();child.emit('close',0)},n==='CN1234567B'?40:5)
    } else if(args.some(arg=>arg.endsWith('sms-preview.py'))) {
      const n=args[args.indexOf('--publication')+1]
      state.events.push(`sms:${n}`)
      state.files.set(path.resolve(`data/patent-image-repair/sms-updates/${n}/completed`),'done')
      child.stdout.end(JSON.stringify({status:'sms_ready',publication_number:n})+'\n');child.stderr.end();child.emit('close',0)
    } else if(args.some(arg=>arg.endsWith('repair-batch-finalize.ts'))) {
      state.events.push('excel')
      const output=state.failFinalize?{status:'failed',error:'Excel 已打开'}:{status:'finalized',marked:2,deleted:2,retained:[]}
      child.stdout.end(JSON.stringify(output)+'\n');child.stderr.end();child.emit('close',state.failFinalize?1:0)
    } else {
      const n=args[args.indexOf('--publication')+1]
      if(args.some(arg=>arg.endsWith('repair-apply.ts'))) {
        expect(args).toContain('--checked-old-keys-stdin')
        expect(JSON.parse(data)).toContain('original')
      }
      state.events.push(`update:${n}`)
      const finish=()=>{state.events.push(`update-end:${n}`);child.stdout.end(JSON.stringify({status:'applied',number:n})+'\n');child.stderr.end();child.emit('close',0)}
      if(state.updateDelay) setTimeout(finish,state.updateDelay);else finish()
    }
  })
  return child
})}))
vi.mock('@/lib/pg-db',()=>({
  getSmsReviewSource:vi.fn(async()=>({originalNames:state.smsPresent?['SMS_1.JPG']:[]})),
  getSmsOriginals:vi.fn(async()=>({batch:'batch',images:state.smsPresent?[{oss_key:'sms-original',asset_key:'sms-original',is_abstract:false}]:[]})),
  getPatentDrawingKeys:vi.fn(async()=>['original']),
}))
vi.mock('@/lib/oss-client',()=>({patentImageExists:vi.fn(async()=>{if(state.unavailable) throw new Error('Retryable HTTP status: 503');return !state.missing})}))
vi.mock('@/features/historical-import/pdf/historical-pdf',()=>({readVerifiedImage:vi.fn(),validateManifest:vi.fn()}))
vi.mock('./cleanup',()=>({cleanupCompletedArtifacts:vi.fn(async()=>[])}))
import { cleanupCompletedArtifacts } from './cleanup'
import { patentImageExists } from '@/lib/oss-client'
import { drawingFailureDetail, startContinuousPipeline, stopTask } from './service'

describe('持续下载流水线',()=>{
  it('旧附图不存在时不下载、不提取、不替换并同步 Excel 存储备注，恢复后可重试',async()=>{
    state.files.clear();state.events=[];state.missing=true
    const original=state.items
    state.items=[original[0]]
    try {
      const task=startContinuousPipeline({concurrency:1,delay:0,proxy:'',retry:false})
      await vi.waitFor(()=>expect(task.status).toBe('failed'))
      expect(task.failed).toBe(1)
      expect(state.events.some(event=>event.startsWith('download:')||event.startsWith('sms:'))).toBe(false)
      expect(state.events.some(event=>event.startsWith('update:'))).toBe(false)
      expect(state.events).toContain('excel')
      const outbox=state.files.get(path.resolve('data/patent-image-repair/excel-sync.jsonl'))!
      expect(outbox).toContain('storage-note')
      const history=state.files.get(path.resolve('data/patent-image-repair/pipeline-report.jsonl'))!
      expect(history).toContain('storage_missing')
      state.missing=false;state.events=[]
      const resumed=startContinuousPipeline({concurrency:1,delay:0,proxy:'',retry:false})
      await vi.waitFor(()=>expect(resumed.status).toBe('completed'))
      expect(resumed.completed).toBe(1)
      expect(state.events).toContain('download:CN1234567B')
    } finally {state.items=original;state.missing=false;state.files.clear();state.events=[]}
  })
  it('SMS 旧对象不存在时也在下载、正文提取和附图更新前跳过',async()=>{
    state.files.clear();state.events=[];state.smsPresent=true
    const original=state.items
    state.items=[original[0]]
    vi.mocked(patentImageExists).mockImplementation(async key=>key!=='sms-original')
    try {
      const task=startContinuousPipeline({concurrency:1,delay:0,proxy:'',retry:false})
      await vi.waitFor(()=>expect(task.status).toBe('failed'))
      expect(state.events).toEqual(['excel'])
      expect(task.logs.join('\n')).toContain('已跳过下载、提取和替换')
      expect(state.files.get(path.resolve('data/patent-image-repair/excel-sync.jsonl'))).toContain('storage-note')
    } finally {
      state.items=original;state.smsPresent=false;state.files.clear();state.events=[]
      vi.mocked(patentImageExists).mockImplementation(async()=>{if(state.unavailable) throw new Error('Retryable HTTP status: 503');return !state.missing})
    }
  })
  it('仅正文候选缺图时也不下载 PDF',async()=>{
    state.files.clear();state.events=[];state.smsPresent=true;state.missing=true
    const original=state.items
    state.items=[{...original[0],image_names:['SMS_1.JPG']}]
    try {
      const task=startContinuousPipeline({concurrency:1,delay:0,proxy:'',retry:false})
      await vi.waitFor(()=>expect(task.status).toBe('failed'))
      expect(state.events).toEqual(['excel'])
    } finally {state.items=original;state.smsPresent=false;state.missing=false;state.files.clear();state.events=[]}
  })
  it('附图存在时只执行一轮存在性检查并把结果传给更新程序',async()=>{
    state.files.clear();state.events=[];vi.mocked(patentImageExists).mockClear()
    const original=state.items
    state.items=[original[0]]
    vi.mocked(patentImageExists).mockImplementation(async()=>{
      expect(state.events.some(event=>event.startsWith('download:'))).toBe(false)
      return true
    })
    try {
      const task=startContinuousPipeline({concurrency:1,delay:0,proxy:'',retry:false})
      await vi.waitFor(()=>expect(task.status).toBe('completed'))
      expect(patentImageExists).toHaveBeenCalledTimes(1)
      expect(state.events).toContain('update:CN1234567B')
    } finally {
      state.items=original;state.files.clear();state.events=[]
      vi.mocked(patentImageExists).mockImplementation(async()=>{if(state.unavailable) throw new Error('Retryable HTTP status: 503');return !state.missing})
    }
  })
  it('仅正文候选执行正文提取，不运行说明书附图更新或标记',async()=>{
    state.files.clear();state.events=[];state.smsPresent=true;vi.mocked(cleanupCompletedArtifacts).mockClear()
    const original=state.items
    state.items=[{publication_number:'CN1234567B',batch:'batch',image_names:['SMS_1.JPG'],repair_status:''}]
    try {
      const task=startContinuousPipeline({concurrency:1,delay:0,proxy:'',retry:false})
      await vi.waitFor(()=>expect(task.status).toBe('completed'))
      expect(state.events).toEqual(['download:CN1234567B:pdf-only','sms:CN1234567B'])
      expect(task.completed).toBe(1)
      expect(task.excelPending).toBe(0)
      expect(cleanupCompletedArtifacts).toHaveBeenCalledTimes(1)
    } finally {state.items=original;state.smsPresent=false;state.files.clear();state.events=[]}
  })
  it('正文候选且已有完成标记时不再下载或更新附图',async()=>{
    state.files.clear();state.events=[]
    const original=state.items
    state.items=[{publication_number:'CN114692412B',batch:'batch',image_names:['sms_1.jpg','sms_2.jpg'],repair_status:''}]
    state.files.set(path.resolve('data/patent-image-repair/sms-updates/CN114692412B/completed'),'done')
    state.files.set(path.resolve('data/patent-image-repair/pipeline-report.jsonl'),JSON.stringify({publication_number:'CN114692412B',batch:'batch',status:'failed',error:'附图不全属于重名候选'})+'\n')
    try {
      const task=startContinuousPipeline({concurrency:1,delay:0,proxy:'',retry:false})
      await vi.waitFor(()=>expect(task.status).toBe('completed'))
      expect(task.completed).toBe(1)
      expect(state.events).toEqual([])
      expect(task.logs.join('\n')).toContain('正文图片已有完成记录')
    } finally {state.items=original;state.files.clear();state.events=[]}
  })
  it('正文候选但缺少正文数据库记录时只获取 PDF 并记录失败',async()=>{
    state.files.clear();state.events=[];vi.mocked(cleanupCompletedArtifacts).mockClear()
    const original=state.items
    state.items=[{publication_number:'CN1234567B',batch:'batch',image_names:['SMS_1.JPG'],repair_status:''}]
    try {
      const task=startContinuousPipeline({concurrency:1,delay:0,proxy:'',retry:false})
      await vi.waitFor(()=>expect(task.status).toBe('failed'))
      expect(state.events).toContain('download:CN1234567B:pdf-only')
      expect(state.events.some(event=>event.startsWith('update:'))).toBe(false)
      expect(task.logs.join('\n')).toContain('数据库没有 SMS 图片记录')
      expect(cleanupCompletedArtifacts).not.toHaveBeenCalled()
    } finally {state.items=original;state.files.clear();state.events=[]}
  })
  it('允许超过四件专利同时进入图片更新',async()=>{
    state.files.clear();state.events=[];state.updateDelay=150
    const original=state.items
    state.items=Array.from({length:5},(_,index)=>({publication_number:`CN${1234600+index}B`,batch:'batch',image_names:['FT_1.JPG'],repair_status:''}))
    try {
      const task=startContinuousPipeline({concurrency:5,delay:0,proxy:'',retry:false})
      await vi.waitFor(()=>expect(task.status).toBe('completed'))
      const starts=state.events.map((event,index)=>event.startsWith('update:')?index:-1).filter(index=>index>=0)
      const ends=state.events.map((event,index)=>event.startsWith('update-end:')?index:-1).filter(index=>index>=0)
      expect(starts).toHaveLength(5)
      expect(starts[4]).toBeLessThan(ends[0])
      expect(task.completed).toBe(5)
    } finally {state.items=original;state.updateDelay=0;state.files.clear();state.events=[]}
  })
  it('停止时等待两项已开始的更新结束，并不再启动新专利',async()=>{
    state.files.clear();state.events=[];state.updateDelay=200
    const original=state.items
    state.items=[...original,{publication_number:'CN1234569B',batch:'batch',image_names:['FT_1.JPG'],repair_status:''}]
    try {
      const task=startContinuousPipeline({concurrency:2,delay:0,proxy:'',retry:false})
      await vi.waitFor(()=>expect(state.events.filter(event=>event.startsWith('update:'))).toHaveLength(2))
      stopTask()
      await vi.waitFor(()=>expect(task.status).toBe('stopped'))
      expect(task.completed).toBe(2)
      expect(state.events).not.toContain('download:CN1234569B')
      expect(task.excelPending).toBe(0)
    } finally {state.items=original;state.updateDelay=0;state.files.clear();state.events=[]}
  })
  it('两个不同专利可以同时更新并正确持久化完成记录',async()=>{
    state.files.clear();state.events=[];state.updateDelay=100
    try {
      const task=startContinuousPipeline({concurrency:2,delay:0,proxy:'',retry:false})
      await vi.waitFor(()=>expect(task.status).toBe('completed'))
      const starts=state.events.map((event,index)=>event.startsWith('update:')?index:-1).filter(index=>index>=0)
      const ends=state.events.map((event,index)=>event.startsWith('update-end:')?index:-1).filter(index=>index>=0)
      expect(starts).toHaveLength(2)
      expect(starts[1]).toBeLessThan(ends[0])
      expect(task.completed).toBe(2)
      expect(task.excelPending).toBe(0)
      const history=state.files.get(path.resolve('data/patent-image-repair/pipeline-report.jsonl'))!
      expect(history.trim().split('\n').map(line=>JSON.parse(line).status)).toEqual(['completed','completed'])
    } finally {state.updateDelay=0;state.files.clear();state.events=[]}
  })
  it('连续三次遇到 503 时停止并允许恢复后自动重试',async()=>{
    state.files.clear();state.events=[];state.unavailable=true
    const original=state.items
    state.items=[...original,{publication_number:'CN1234569B',batch:'batch',image_names:['FT_1.JPG'],repair_status:''}]
    const first=startContinuousPipeline({concurrency:2,delay:0,proxy:'',retry:false})
    await vi.waitFor(()=>expect(first.status).toBe('failed'))
    expect(first.failed).toBe(3)
    expect(first.message).toContain('对象存储连续异常')
    expect(state.events.some(event=>event.startsWith('download:'))).toBe(false)
    expect(state.files.get(path.resolve('data/patent-image-repair/excel-sync.jsonl'))||'').not.toContain('storage-note')
    state.unavailable=false
    const resumed=startContinuousPipeline({concurrency:2,delay:0,proxy:'',retry:false})
    await vi.waitFor(()=>expect(resumed.status).toBe('completed'))
    expect(resumed.completed).toBe(3)
    state.items=original
    state.files.clear();state.events=[]
  })
  it('保留结构化异常、普通 stderr 和异常退出信号',()=>{
    expect(drawingFailureDetail({code:1,signal:null,records:[{error:'磁盘读取超时'}],stderr:'warning'})).toContain('磁盘读取超时')
    expect(drawingFailureDetail({code:1,signal:null,records:[],stderr:'Error: ENOSPC'})).toContain('Error: ENOSPC')
    expect(drawingFailureDetail({code:null,signal:'SIGTERM',records:[],stderr:''})).toContain('SIGTERM')
  })
  it('不限数量并使先下载完成的专利立即进入更新',async()=>{
    const task=startContinuousPipeline({concurrency:2,delay:0,proxy:'',retry:false})
    await vi.waitFor(()=>expect(task.status).toBe('completed'))
    expect(task.completed).toBe(2)
    expect(task.limit).toBe(0)
    expect(state.events.indexOf('update:CN1234568B')).toBeLessThan(state.events.indexOf('update:CN1234567B'))
    expect(state.events.filter(event=>event==='excel')).toHaveLength(1)
    expect(task.excelPending).toBe(0)
    expect(task.timings).toBeDefined()
  })
  it('Excel 写入失败保留待同步记录，重启后只同步状态并跳过已完成专利',async()=>{
    state.files.clear();state.events=[];state.failFinalize=true
    const first=startContinuousPipeline({concurrency:2,delay:0,proxy:'',retry:false})
    await vi.waitFor(()=>expect(first.status).toBe('failed'))
    expect(first.excelPending).toBe(2)
    state.events=[];state.failFinalize=false
    const resumed=startContinuousPipeline({concurrency:2,delay:0,proxy:'',retry:false})
    await vi.waitFor(()=>expect(resumed.status).toBe('completed'))
    expect(resumed.excelPending).toBe(0)
    expect(resumed.completed).toBe(0)
    expect(state.events).toEqual(['excel'])
  })
  it('跳过 Excel 已完成项及之前失败项',async()=>{
    state.files.clear();state.events=[]
    state.items[0].repair_status='说明书附图已更新'
    state.files.set(path.resolve('data/patent-image-repair/pipeline-report.jsonl'),JSON.stringify({publication_number:'CN1234568B',batch:'batch',status:'failed'})+'\n')
    const task=startContinuousPipeline({concurrency:2,delay:0,proxy:'',retry:false})
    await vi.waitFor(()=>expect(task.status).toBe('completed'))
    expect(state.events).toEqual([])
    state.items[0].repair_status=''
  })
  it('不足 100 项时在任务结束时批量同步',async()=>{
    state.files.clear();state.events=[]
    const original=state.items
    state.items=Array.from({length:12},(_,index)=>({publication_number:`CN${String(1234600+index)}B`,batch:'batch',image_names:['FT_1.JPG'],repair_status:''}))
    const task=startContinuousPipeline({concurrency:2,delay:0,proxy:'',retry:false})
    await vi.waitFor(()=>expect(task.status).toBe('completed'))
    expect(task.completed).toBe(12)
    expect(state.events.filter(event=>event==='excel')).toHaveLength(1)
    expect(state.events.indexOf('excel')).toBeGreaterThan(state.events.lastIndexOf('update:CN1234611B'))
    state.items=original
  })
})
