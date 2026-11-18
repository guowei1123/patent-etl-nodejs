import { describe, expect, it } from 'vitest'
import { validateDrawingCount } from '../pdf/repair-count'

describe('说明书附图数量校验',()=>{
  it.each([[5,3],[3,5]])('旧图 %i 张、新图 %i 张时停止替换',(oldCount,newCount)=>{
    expect(()=>validateDrawingCount(oldCount,newCount)).toThrow(`数据库 ${oldCount} 张，PDF 提取 ${newCount} 张`)
  })
  it('数量一致时允许继续后续校验',()=>{
    expect(()=>validateDrawingCount(3,3)).not.toThrow()
  })
})
