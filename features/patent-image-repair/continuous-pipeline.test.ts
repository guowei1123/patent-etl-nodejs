import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Readable, Writable } from 'node:stream'
import path from 'node:path'

const state=vi.hoisted(()=>({events:[] as string[],files:new Map<string,string>(),snapshot:'',failFinalize:false,unavailable:false,items:['CN1234567B','CN1234568B'].map(publication_number=>({publication_number,batch:'batch',image_names:['FT_1.JPG'],repair_status:''}))}))
vi.mock('node:fs',()=>({
  createReadStream:()=>Readable.from([state.snapshot]),
  createWriteStream:()=>{state.snapshot='';return new Writable({write(chunk,_encoding,callback){state.snapshot+=String(chunk);callback()}})},
}))
vi.mock('node:fs/promises',()=>({
  mkdir:vi.fn(async()=>{}),
  readFile:vi.fn(async(p:string)=>{const value=state.files.get(p);if(value===undefined) throw Object.assign(new Error('missing'),{code:'ENOENT'});return value}),
  appendFile:vi.fn(async(p:string,value:string)=>{state.files.set(p,(state.files.get(p)||'')+value)}),
  stat:vi.fn(async()=>({mtimeMs:1})),realpath:vi.fn(),readdir:vi.fn(),open:vi.fn(),unlink:vi.fn(),rename:vi.fn(),
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
      state.events.push(`download:${n}`)
      setTimeout(()=>{child.stdout.end(JSON.stringify({...item,status:'ready',repair_revision:3,pdf:`${n}.pdf`,manifest:`${n}.json`})+'\n');child.stderr.end();child.emit('close',0)},n==='CN1234567B'?40:5)
    } else if(args.some(arg=>arg.endsWith('repair-batch-finalize.ts'))) {
      state.events.push('excel')
      const output=state.failFinalize?{status:'failed',error:'Excel 已打开'}:{status:'finalized',marked:2,deleted:2,retained:[]}
      child.stdout.end(JSON.stringify(output)+'\n');child.stderr.end();child.emit('close',state.failFinalize?1:0)
    } else {
      const n=args[args.indexOf('--publication')+1]
      state.events.push(`update:${n}`)
      child.stdout.end(JSON.stringify({status:'applied',number:n})+'\n');child.stderr.end();child.emit('close',0)
    }
  })
  return child
})}))
vi.mock('@/lib/pg-db',()=>({getSmsReviewSource:vi.fn(async()=>({originalNames:[]})),getPatentDrawingKeys:vi.fn(async()=>['original'])}))
vi.mock('@/lib/oss-client',()=>({patentImageExists:vi.fn(async()=>{if(state.unavailable) throw new Error('Retryable HTTP status: 503');return true})}))
vi.mock('@/features/historical-import/pdf/historical-pdf',()=>({readVerifiedImage:vi.fn(),validateManifest:vi.fn()}))
import { drawingFailureDetail, startContinuousPipeline } from './service'

describe('持续下载流水线',()=>{
  it('遇到 503 时停止并允许恢复后自动重试',async()=>{
    state.files.clear();state.events=[];state.unavailable=true
    const first=startContinuousPipeline({concurrency:2,delay:0,proxy:'',retry:false})
    await vi.waitFor(()=>expect(first.status).toBe('failed'))
    expect(first.failed).toBe(1)
    expect(first.message).toContain('503')
    state.unavailable=false
    const resumed=startContinuousPipeline({concurrency:2,delay:0,proxy:'',retry:false})
    await vi.waitFor(()=>expect(resumed.status).toBe('completed'))
    expect(resumed.completed).toBe(2)
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
