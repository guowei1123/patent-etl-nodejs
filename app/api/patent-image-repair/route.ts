import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getTask, preview, smsPreview, saveSmsReview, saveSmsReviews, smsUpdatePlan, startSmsUpdate, startTask, stopTask, smsPositionPlan, applySmsPositions, smsBatchUpdatePlan, startSmsBatchUpdate } from '@/features/patent-image-repair/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const schema = z.object({ mode:z.enum(['preview','download','apply','apply-batch','sms']), number:z.string().max(24).optional(), limit:z.number().int().min(0).max(10000), delay:z.number().min(3).max(3600), proxy:z.string().max(80), retry:z.boolean(),concurrency:z.number().int().min(1).max(4).optional() }).refine(value=>value.mode==='download'||value.limit>=1)
const reviewSchema=z.object({action:z.literal('sms_review'),number:z.string().max(24),name:z.string().max(40),candidateIndex:z.number().int().nonnegative().nullable(),manifestHash:z.string().regex(/^[a-f0-9]{64}$/),descriptionHash:z.string().regex(/^[a-f0-9]{64}$/)})
const batchReviewSchema=z.object({action:z.literal('sms_review_batch'),number:z.string().max(24),entries:z.array(z.object({name:z.string().max(40),candidateIndex:z.number().int().nonnegative()})).min(1).max(10000),manifestHash:z.string().regex(/^[a-f0-9]{64}$/),descriptionHash:z.string().regex(/^[a-f0-9]{64}$/)})
const smsApplySchema=z.object({action:z.literal('sms_apply'),number:z.string().max(24),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)})
const positionApplySchema=z.object({action:z.literal('sms_position_apply'),number:z.string().max(24),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)})
const smsBatchApplySchema=z.object({action:z.literal('sms_batch_apply'),items:z.array(z.object({number:z.string().max(24),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)})).min(1).max(10000)})

export async function GET(request: NextRequest) {
  try {
    if(request.nextUrl.searchParams.get('type')==='sms-batch-plan') {
      const limit=request.nextUrl.searchParams.get('limit')
      if(!limit || !/^\d+$/.test(limit)) throw new Error('批量数量需为 1 至 10000')
      return NextResponse.json({data:await smsBatchUpdatePlan(Number(limit))})
    }
    const number = request.nextUrl.searchParams.get('number')
    if (number) {
      if(request.nextUrl.searchParams.get('type')==='sms-position-plan') return NextResponse.json({data:await smsPositionPlan(number)})
      if(request.nextUrl.searchParams.get('type')==='sms-plan') return NextResponse.json({data:await smsUpdatePlan(number)})
      const index = request.nextUrl.searchParams.get('image')
      if (index !== null && !/^\d+$/.test(index)) throw new Error('图片编号无效')
      const sms=request.nextUrl.searchParams.get('type')==='sms'
      const result = sms ? await smsPreview(number, index === null ? undefined : Number(index)) : await preview(number, index === null ? undefined : Number(index))
      if (result && 'content' in result && result.content) return new NextResponse(new Uint8Array(result.content), { headers:{'Content-Type':sms?'image/jpeg':'image/png','Cache-Control':'private, no-store'} })
      return NextResponse.json({data:result})
    }
    return NextResponse.json({data:getTask()})
  } catch (error) { return NextResponse.json({error:error instanceof Error ? error.message : '读取结果失败'}, {status:400}) }
}

export async function POST(request: NextRequest) {
  const origin=request.headers.get('origin')
  if (origin && origin !== request.nextUrl.origin) return NextResponse.json({error:'请从当前工作台发起操作'}, {status:403})
  try {
    const body=await request.json()
    if (body?.action === 'stop') { stopTask(); return NextResponse.json({data:getTask()}) }
    if (body?.action === 'sms_review') { await saveSmsReview(reviewSchema.parse(body)); return NextResponse.json({data:{saved:true}}) }
    if (body?.action === 'sms_review_batch') return NextResponse.json({data:await saveSmsReviews(batchReviewSchema.parse(body))})
    if (body?.action === 'sms_position_apply') {const input=positionApplySchema.parse(body);return NextResponse.json({data:await applySmsPositions(input.number,input.fingerprint)})}
    if (body?.action === 'sms_apply') {const input=smsApplySchema.parse(body);return NextResponse.json({data:startSmsUpdate(input.number,input.fingerprint)})}
    if (body?.action === 'sms_batch_apply') {const input=smsBatchApplySchema.parse(body);return NextResponse.json({data:startSmsBatchUpdate(input.items)})}
    const input=schema.parse(body)
    return NextResponse.json({data:await startTask(input)})
  } catch (error) { return NextResponse.json({error:error instanceof z.ZodError ? '任务参数无效，请检查后重试' : error instanceof Error ? error.message : '启动任务失败'}, {status:400}) }
}
