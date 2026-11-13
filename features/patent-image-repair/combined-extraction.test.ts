import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const state=vi.hoisted(()=>({children:[] as Array<{stdout:PassThrough;stderr:PassThrough;emit:(name:string,...args:unknown[])=>boolean}>}))
vi.mock('node:child_process',()=>({spawn:vi.fn(()=>{
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()})
  state.children.push(child)
  return child
})}))
vi.mock('@/lib/pg-db',()=>({getSmsReviewSource:vi.fn(async()=>({originalNames:['SMS_1.JPG']}))}))
vi.mock('@/lib/oss-client',()=>({}))
vi.mock('@/features/historical-import/pdf/historical-pdf',()=>({readVerifiedImage:vi.fn(),validateManifest:vi.fn()}))
import { getTask, startTask } from './service'

describe('单件合并提取任务',()=>{
  it('说明书附图完成后自动启动正文提取，且保持任务运行状态',async()=>{
    const task=await startTask({mode:'preview',number:'CN1234567B',limit:1,delay:3,proxy:'',retry:false})
    const drawing=state.children[0]
    drawing.stdout.write(JSON.stringify({status:'ready',publication_number:'CN1234567B'})+'\n')
    drawing.stdout.end();drawing.stderr.end()
    drawing.emit('close',0)
    await vi.waitFor(()=>expect(state.children).toHaveLength(2))
    expect(getTask()?.status).toBe('running')
    const sms=state.children[1]
    sms.stdout.write(JSON.stringify({status:'sms_ready',publication_number:'CN1234567B',candidates:2})+'\n')
    sms.stdout.end();sms.stderr.end()
    sms.emit('close',0)
    await vi.waitFor(()=>expect(task.status).toBe('completed'))
    expect(task.completed).toBe(1)
    expect(task.logs.join('\n')).toContain('已提取 2 个正文图片候选')
  })
})
