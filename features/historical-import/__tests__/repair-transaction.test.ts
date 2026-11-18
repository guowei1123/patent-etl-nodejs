import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { monitorRepairConnection, prepareDrawingJpegs } from '../pdf/repair-transaction'

describe('附图修复事务准备',()=>{
  it('保留各图压缩结果及错误，允许后续摘要图复用',async()=>{
    const error=new Error('无法压缩')
    const encode=vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({content:Buffer.from('jpeg'),hash:'hash',quality:80,targetReached:true})
    const results=await prepareDrawingJpegs([Buffer.from('a'),Buffer.from('b')],encode)
    expect(results[0].error).toBe(error)
    expect(results[1].jpeg?.content.toString()).toBe('jpeg')
  })
  it('捕获空闲连接超时并丢弃已损坏连接',()=>{
    const client=Object.assign(new EventEmitter(),{release:vi.fn()})
    const connection=monitorRepairConnection(client as never)
    const failure=Object.assign(new Error('idle-in-transaction timeout'),{code:'25P03'})
    client.emit('error',failure)
    expect(()=>connection.assert()).toThrow('idle-in-transaction timeout')
    connection.release()
    expect(client.release).toHaveBeenCalledWith(failure)
  })
})
