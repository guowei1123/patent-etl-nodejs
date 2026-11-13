import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const service=vi.hoisted(()=>({getTask:vi.fn(),preview:vi.fn(),smsPreview:vi.fn(),saveSmsReview:vi.fn(),saveSmsReviews:vi.fn(),smsUpdatePlan:vi.fn(),startSmsUpdate:vi.fn(),smsBatchUpdatePlan:vi.fn(),startSmsBatchUpdate:vi.fn(),startTask:vi.fn(),stopTask:vi.fn()}))
vi.mock('@/features/patent-image-repair/service',()=>service)
import { GET, POST } from './route'

describe('附图修复接口',()=>{
  beforeEach(()=>vi.clearAllMocks())
  it('只允许当前站点发起任务',async()=>{
    const r=await POST(new NextRequest('http://localhost:3000/api/patent-image-repair',{method:'POST',headers:{origin:'http://other.example','content-type':'application/json'},body:'{}'}))
    expect(r.status).toBe(403)
    expect(service.startTask).not.toHaveBeenCalled()
  })
  it('拒绝超出范围的批次数量',async()=>{
    const r=await POST(new NextRequest('http://localhost:3000/api/patent-image-repair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'download',limit:10001,delay:3,proxy:'',retry:false})}))
    expect(r.status).toBe(400)
    expect(service.startTask).not.toHaveBeenCalled()
  })
  it('图片索引不能是非数字',async()=>{
    const r=await GET(new NextRequest('http://localhost:3000/api/patent-image-repair?number=CN222254999U&image=../1'))
    expect(r.status).toBe(400)
    expect(service.preview).not.toHaveBeenCalled()
  })
  it('将图片结果以 PNG 返回',async()=>{
    service.preview.mockResolvedValue({content:Buffer.from('image')})
    const r=await GET(new NextRequest('http://localhost:3000/api/patent-image-repair?number=CN222254999U&image=3'))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/png')
    expect(service.preview).toHaveBeenCalledWith('CN222254999U',3)
  })
  it('正文 SMS 图片使用 JPEG 内容类型',async()=>{
    service.smsPreview.mockResolvedValue({content:Buffer.from('image')})
    const r=await GET(new NextRequest('http://localhost:3000/api/patent-image-repair?type=sms&number=CN118504808B&image=0'))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/jpeg')
    expect(service.smsPreview).toHaveBeenCalledWith('CN118504808B',0)
  })
  it('允许启动正文 SMS 提取任务',async()=>{
    service.startTask.mockReturnValue({status:'running'})
    const body={mode:'sms',number:'CN118504808B',limit:1,delay:3,proxy:'',retry:false}
    const r=await POST(new NextRequest('http://localhost:3000/api/patent-image-repair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}))
    expect(r.status).toBe(200)
    expect(service.startTask).toHaveBeenCalledWith(body)
  })
  it('保存单条 SMS 核对结果',async()=>{
    const body={action:'sms_review',number:'CN118504808B',name:'SMS_1.JPG',candidateIndex:0,manifestHash:'a'.repeat(64),descriptionHash:'b'.repeat(64)}
    const r=await POST(new NextRequest('http://localhost:3000/api/patent-image-repair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}))
    expect(r.status).toBe(200)
    expect(service.saveSmsReview).toHaveBeenCalledWith(body)
  })
  it('批量保存 SMS 核对结果',async()=>{
    const body={action:'sms_review_batch',number:'CN118504808B',entries:[{name:'SMS_1.JPG',candidateIndex:0}],manifestHash:'a'.repeat(64),descriptionHash:'b'.repeat(64)}
    service.saveSmsReviews.mockResolvedValue({confirmed:1})
    const r=await POST(new NextRequest('http://localhost:3000/api/patent-image-repair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}))
    expect(r.status).toBe(200)
    expect(service.saveSmsReviews).toHaveBeenCalledWith(body)
    expect((await r.json()).data.confirmed).toBe(1)
  })
  it('返回 SMS 旧对象预检清单',async()=>{
    service.smsUpdatePlan.mockResolvedValue({oldKeys:['patents/batch/123/SMS_1.JPG'],count:1,fingerprint:'a'.repeat(64)})
    const r=await GET(new NextRequest('http://localhost:3000/api/patent-image-repair?type=sms-plan&number=CN1234567B'))
    expect(r.status).toBe(200)
    expect(service.smsUpdatePlan).toHaveBeenCalledWith('CN1234567B')
  })
  it('更新请求必须提供预检指纹',async()=>{
    const r=await POST(new NextRequest('http://localhost:3000/api/patent-image-repair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'sms_apply',number:'CN1234567B',fingerprint:'invalid'})}))
    expect(r.status).toBe(400)
    expect(service.startSmsUpdate).not.toHaveBeenCalled()
  })
  it('通过预检指纹启动 SMS 更新任务',async()=>{
    service.startSmsUpdate.mockReturnValue({status:'running'})
    const body={action:'sms_apply',number:'CN1234567B',fingerprint:'a'.repeat(64)}
    const r=await POST(new NextRequest('http://localhost:3000/api/patent-image-repair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}))
    expect(r.status).toBe(200)
    expect(service.startSmsUpdate).toHaveBeenCalledWith(body.number,body.fingerprint)
  })
  it('预检并启动 SMS 批量更新',async()=>{
    service.smsBatchUpdatePlan.mockResolvedValue({items:[],skipped:[]})
    const preflight=await GET(new NextRequest('http://localhost:3000/api/patent-image-repair?type=sms-batch-plan&limit=5'))
    expect(preflight.status).toBe(200)
    expect(service.smsBatchUpdatePlan).toHaveBeenCalledWith(5)
    service.startSmsBatchUpdate.mockReturnValue({status:'running'})
    const body={action:'sms_batch_apply',items:[{number:'CN1234567B',fingerprint:'a'.repeat(64)}]}
    const response=await POST(new NextRequest('http://localhost:3000/api/patent-image-repair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}))
    expect(response.status).toBe(200)
    expect(service.startSmsBatchUpdate).toHaveBeenCalledWith(body.items)
  })
})
