import { describe, expect, it } from 'vitest'
import { runPipeline, serialQueue } from './pipeline'

describe('逐件流水线',()=>{
  it('限制并发并在较快的下载完成后立即更新',async()=>{
    const events:string[]=[]
    let releaseFirst!:()=>void
    const first=new Promise<void>(resolve=>{releaseFirst=resolve})
    async function* source(){yield 1;yield 2;yield 3}
    const update=serialQueue()
    const run=runPipeline(source(),2,()=>false,async item=>{
      events.push(`start${item}`)
      if(item===1) await first
      events.push(`download${item}`)
      await update(async()=>{events.push(`update${item}`)})
      if(item===2) releaseFirst()
    })
    await run
    expect(events.indexOf('update2')).toBeLessThan(events.indexOf('download1'))
    expect(events.indexOf('start3')).toBeGreaterThan(events.indexOf('update2'))
    expect(events.filter(event=>event.startsWith('update'))).toHaveLength(3)
  })
  it('停止时不再启动新项目，等待已启动项目结束',async()=>{
    let stop=false
    const processed:number[]=[]
    async function* source(){yield 1;yield 2;yield 3}
    await runPipeline(source(),1,()=>stop,async item=>{processed.push(item);stop=true})
    expect(processed).toEqual([1])
  })
})
