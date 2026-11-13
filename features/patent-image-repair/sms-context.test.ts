import { describe, expect, it } from 'vitest'
import { extractSmsContexts } from './sms-context'

describe('正文 SMS 核对上下文',()=>{
  it('收集每次出现的引用并保留章节',()=>{
    const result=extractSmsContexts({disclosure:'前文 [[PATENT_IMAGE:SMS_1.JPG]] 中间 [[PATENT_IMAGE:SMS_2.JPG]] 后文',embodiment:'再次 [[PATENT_IMAGE:sms_1.jpg]] 结束'})
    expect(result.references.map(item=>item.name)).toEqual(['SMS_1.JPG','SMS_2.JPG'])
    expect(result.references[0].contexts).toHaveLength(2)
    expect(result.references[0].contexts[0].before).toContain('前文')
    expect(result.references[0].contexts[1].section).toBe('embodiment')
  })
  it('正文改变时生成不同校验值',()=>{
    expect(extractSmsContexts({x:'a'}).descriptionHash).not.toBe(extractSmsContexts({x:'b'}).descriptionHash)
  })
})
