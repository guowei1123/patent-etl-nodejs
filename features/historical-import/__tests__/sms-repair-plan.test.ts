import { describe, expect, it } from 'vitest'
import { planSmsReplacement } from '../pdf/sms-repair-plan'

const original=(n:number,key=`patents/batch/123/SMS_${n}.JPG`)=>({id:`id${n}`,file_name:`SMS_${n}.JPG`,oss_key:key,asset_id:`asset${n}`,is_abstract:false,image_role:'inline'})
const candidate=(n:number)=>({file_name:`SMS_${n}.JPG`,sha256:'a'.repeat(64),status:'extracted'})

describe('正文 SMS 替换预检',()=>{
  it('按数字顺序匹配并合并共享旧对象',()=>{
    const plan=planSmsReplacement([original(2,'shared'),original(1,'shared')],[candidate(1),candidate(2)])
    expect(plan.images.map(x=>x.original.id)).toEqual(['id1','id2'])
    expect(plan.oldKeys).toEqual(['shared'])
  })
  it('候选缺失时不能删除旧图',()=>{
    expect(()=>planSmsReplacement([original(1),original(2)],[candidate(1)])).toThrow('候选数量不足')
  })
  it('摘要图或待复核图片不能进入替换计划',()=>{
    expect(()=>planSmsReplacement([{...original(1),is_abstract:true}],[candidate(1)])).toThrow()
    expect(()=>planSmsReplacement([original(1)],[{...candidate(1),status:'needs_review'}])).toThrow()
  })
})
