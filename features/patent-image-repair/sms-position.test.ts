import { describe, expect, it } from 'vitest'
import { planSmsPositions } from './sms-position'

describe('正文图片位置定位',()=>{
  const context={before:'这里是样本的第',after:'张图像的宽度'}
  it('使用唯一的双侧文字移动标记并保留其他正文',()=>{
    const text='这里是样本的第张图像的宽度。\n[[PATENT_IMAGE:SMS_1.JPG]]'
    const plan=planSmsPositions({embodiment:text},[{name:'SMS_1.JPG',page:3,context}])
    expect(plan.description).toEqual({embodiment:'这里是样本的第[[PATENT_IMAGE:SMS_1.JPG]]张图像的宽度。\n'})
    expect(plan.proposed).toHaveLength(1)
  })
  it('重复文字不猜测位置',()=>{
    const text='这里是样本的第张图像的宽度。这里是样本的第张图像的宽度。\n[[PATENT_IMAGE:SMS_1.JPG]]'
    const plan=planSmsPositions({embodiment:text},[{name:'SMS_1.JPG',page:3,context}])
    expect(plan.description).toEqual({embodiment:text})
    expect(plan.unresolved).toHaveLength(1)
  })
  it('多个候选同一位置时全部保留原状',()=>{
    const text='这里是样本的第张图像的宽度。\n[[PATENT_IMAGE:SMS_1.JPG]][[PATENT_IMAGE:SMS_2.JPG]]'
    const plan=planSmsPositions({embodiment:text},[{name:'SMS_1.JPG',page:3,context},{name:'SMS_2.JPG',page:3,context}])
    expect(plan.description).toEqual({embodiment:text})
    expect(plan.unresolved).toHaveLength(2)
  })
  it('未确认或缺少上下文时不移动',()=>{
    const text='这里是样本的第张图像的宽度。\n[[PATENT_IMAGE:SMS_1.JPG]]'
    expect(planSmsPositions({embodiment:text},[{name:'SMS_1.JPG',page:0}]).description).toEqual({embodiment:text})
  })
})
