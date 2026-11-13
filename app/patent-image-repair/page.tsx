'use client'

import { useState } from 'react'
import Image from 'next/image'
import useSWR from 'swr'
import { toast } from 'sonner'
import { Download, Images, Play, Square } from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Header } from '@/components/layout/header'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Skeleton } from '@/components/ui/skeleton'

type Mode = 'preview' | 'download' | 'apply' | 'apply-batch' | 'sms' | 'sms-apply' | 'sms-apply-batch'
type Task = { mode:Mode; status:'running'|'completed'|'failed'|'stopped'; number?:string; limit:number; completed:number; failed:number; message:string; logs:string[];excelPending?:number;timings?:{downloadMs:number;smsMs:number;drawingMs:number;excelMs:number} }
type Preview = { number:string; images:Array<{index:number;label:string;page:number;width:number;height:number}> }
type SmsPreview = {number:string;batch:string;manifestHash:string;descriptionHash:string;images:Array<{index:number;name:string;page:number;width?:number;height?:number;available:boolean;error?:string}>;references:Array<{name:string;hasOriginal:boolean;confirmedIndex:number|null;contexts:Array<{section:string;before:string;after:string}>}>}
type SmsUpdatePlan = {number:string;batch:string;count:number;oldKeys:string[];fingerprint:string}
type SmsPositionPlan = {number:string;fingerprint:string;proposed:Array<{name:string;page:number;before:string;after:string}>;unresolved:Array<{name:string;reason:string}>}
type SmsBatchPlan = {items:Array<{number:string;count:number;oldKeys:string[];fingerprint:string;automatic:number}>;skipped:Array<{number:string;reason:string}>}
const fetcher = async (url:string) => { const r=await fetch(url); const b=await r.json(); if(!r.ok) throw new Error(b.error || '读取失败，请重试'); return b.data }

export default function PatentImageRepairPage() {
  const [mode,setMode]=useState<'preview'|'download'>('preview')
  const [number,setNumber]=useState('CN222254999U')
  const [proxy,setProxy]=useState('http://127.0.0.1:7897')
  const [limit,setLimit]=useState('10')
  const [concurrency,setConcurrency]=useState('2')
  const [delay,setDelay]=useState('3')
  const [busy,setBusy]=useState(false)
  const [dialog,setDialog]=useState<'apply'|'apply-batch'|null>(null)
  const [selected,setSelected]=useState<string|null>(null)
  const [smsSelected,setSmsSelected]=useState<string|null>(null)
  const [smsPage,setSmsPage]=useState(0)
  const [reviewDrafts,setReviewDrafts]=useState<Record<string,string>>({})
  const [reviewBusy,setReviewBusy]=useState<string|null>(null)
  const [smsPlan,setSmsPlan]=useState<SmsUpdatePlan|null>(null)
  const [positionPlan,setPositionPlan]=useState<SmsPositionPlan|null>(null)
  const [smsBatchPlan,setSmsBatchPlan]=useState<SmsBatchPlan|null>(null)
  const {data:task,error,isLoading,mutate}=useSWR<Task|null>('/api/patent-image-repair',fetcher,{refreshInterval:2000})
  const displayNumber=selected || (task?.mode==='preview' && task.status==='completed' ? task.number : undefined)
  const previewUrl=displayNumber && !(task?.mode==='preview' && task.status==='running') ? `/api/patent-image-repair?number=${encodeURIComponent(displayNumber)}` : null
  const {data:preview,error:previewError,mutate:refreshPreview}=useSWR<Preview|null>(previewUrl,fetcher)
  const smsDisplay=smsSelected || displayNumber
  const smsUrl=smsDisplay && !(task?.mode==='preview' && task.status==='running') ? `/api/patent-image-repair?type=sms&number=${encodeURIComponent(smsDisplay)}` : null
  const {data:smsPreview,error:smsError,mutate:refreshSms}=useSWR<SmsPreview|null>(smsUrl,fetcher,{refreshInterval:3000})
  const running=task?.status==='running'
  async function action(next:Mode|'stop') {
    setBusy(true)
    try {
      const pub=number.trim().toUpperCase()
      const body=next==='stop' ? {action:'stop'} : {mode:next,number:next==='apply' ? displayNumber : next==='preview' || next==='sms' ? pub : undefined,limit:next==='download'?0:Number(limit),delay:Number(delay),proxy:proxy.trim(),retry:false,concurrency:Number(concurrency)}
      const response=await fetch('/api/patent-image-repair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
      const result=await response.json()
      if(!response.ok) throw new Error(result.error || '启动失败，请重试')
      if(next==='preview') {setSelected(pub);setSmsSelected(null);setSmsPage(0);setReviewDrafts({})}
      if(next==='sms') {setSmsSelected(pub);setSmsPage(0);setReviewDrafts({})}
      setDialog(null)
      await mutate()
      if(next==='stop') toast.info('正在停止任务')
      else toast.success('任务已启动')
    } catch(e) { toast.error(e instanceof Error ? e.message : '操作失败，请重试') }
    finally { setBusy(false) }
  }
  async function saveReview(name:string,candidateIndex:number|null) {
    if(!smsPreview) return
    setReviewBusy(name)
    try {
      const response=await fetch('/api/patent-image-repair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'sms_review',number:smsPreview.number,name,candidateIndex,manifestHash:smsPreview.manifestHash,descriptionHash:smsPreview.descriptionHash})})
      const result=await response.json()
      if(!response.ok) throw new Error(result.error || '保存失败，请重试')
      await refreshSms()
      toast.success(candidateIndex===null?'已取消确认':'已保存核对结果')
    } catch(error) {toast.error(error instanceof Error ? error.message : '保存失败，请重试')}
    finally {setReviewBusy(null)}
  }
  async function confirmAllSms() {
    if(!smsPreview) return
    const pending=smsPreview.references.filter(ref=>ref.confirmedIndex===null)
    const entries=pending.map(ref=>({name:ref.name,candidateIndex:Number(reviewDrafts[ref.name] ?? ref.name.match(/\d+/)?.[0])-1}))
    const invalid=pending.find((ref,index)=>!ref.hasOriginal || !ref.contexts.length || !Number.isInteger(entries[index].candidateIndex) || !smsPreview.images[entries[index].candidateIndex]?.available)
    if(invalid) {toast.error(`${invalid.name} 缺少正文引用、原图或有效候选，请先检查`);return}
    setReviewBusy('__all__')
    try {
      const response=await fetch('/api/patent-image-repair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'sms_review_batch',number:smsPreview.number,entries,manifestHash:smsPreview.manifestHash,descriptionHash:smsPreview.descriptionHash})})
      const result=await response.json()
      if(!response.ok) throw new Error(result.error || '保存失败，请重试')
      await refreshSms()
      toast.success(`已确认 ${result.data.confirmed} 项对应关系`)
    } catch(error) {toast.error(error instanceof Error ? error.message : '保存失败，请重试')}
    finally {setReviewBusy(null)}
  }
  async function prepareSmsUpdate() {
    if(!smsPreview) return
    setBusy(true)
    try {const plan=await fetcher(`/api/patent-image-repair?type=sms-plan&number=${encodeURIComponent(smsPreview.number)}`);setSmsPlan(plan)}
    catch(error) {toast.error(error instanceof Error ? error.message : '预检失败，请重试')}
    finally {setBusy(false)}
  }
  async function preparePositions() {
    if(!smsPreview) return
    setBusy(true)
    try {setPositionPlan(await fetcher(`/api/patent-image-repair?type=sms-position-plan&number=${encodeURIComponent(smsPreview.number)}`))}
    catch(error) {toast.error(error instanceof Error ? error.message : '定位预检失败')}
    finally {setBusy(false)}
  }
  async function prepareSmsBatch() {
    setBusy(true)
    try {setSmsBatchPlan(await fetcher(`/api/patent-image-repair?type=sms-batch-plan&limit=${encodeURIComponent(limit)}`))}
    catch(error) {toast.error(error instanceof Error ? error.message : '批量预检失败')}
    finally {setBusy(false)}
  }
  async function applySmsBatch() {
    if(!smsBatchPlan?.items.length) return
    setBusy(true)
    try {
      const items=smsBatchPlan.items.map(({number,fingerprint})=>({number,fingerprint}))
      const response=await fetch('/api/patent-image-repair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'sms_batch_apply',items})})
      const result=await response.json()
      if(!response.ok) throw new Error(result.error || '启动失败')
      setSmsBatchPlan(null);await mutate();toast.success('正文图片批量更新已启动')
    } catch(error) {toast.error(error instanceof Error ? error.message : '启动失败')}
    finally {setBusy(false)}
  }
  async function applyPositions() {
    if(!positionPlan) return
    setBusy(true)
    try {
      const response=await fetch('/api/patent-image-repair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'sms_position_apply',number:positionPlan.number,fingerprint:positionPlan.fingerprint})})
      const result=await response.json()
      if(!response.ok) throw new Error(result.error || '更新失败')
      setPositionPlan(null);await refreshSms();toast.success(`已调整 ${result.data.updated} 处位置，${result.data.unresolved} 处待核对`)
    } catch(error) {toast.error(error instanceof Error ? error.message : '更新失败')}
    finally {setBusy(false)}
  }
  async function applySmsUpdate() {
    if(!smsPlan) return
    setBusy(true)
    try {
      const response=await fetch('/api/patent-image-repair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'sms_apply',number:smsPlan.number,fingerprint:smsPlan.fingerprint})})
      const result=await response.json()
      if(!response.ok) throw new Error(result.error || '启动失败')
      setSmsPlan(null);await mutate();toast.success('正文图片更新已启动')
    } catch(error) {toast.error(error instanceof Error ? error.message : '启动失败，请重试')}
    finally {setBusy(false)}
  }
  return <AppShell><Header title="专利附图修复" description="下载专利 PDF，提取并核对说明书附图" onRefresh={()=>{void mutate();void refreshPreview()}} isRefreshing={isLoading}/>
    <main className="flex flex-col gap-6 p-6">
      <Alert><Images/><AlertTitle>图片更新说明</AlertTitle><AlertDescription>持续下载会逐件更新说明书附图，并对符合条件的 SMS 正文图片按编号自动对应并更新；旧正文图片先删除，不备份。数量或编号不匹配时跳过正文更新。</AlertDescription></Alert>
      <div><Button variant="outline" asChild><a href="#sms-preview">前往正文 SMS 图片</a></Button></div>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <div><h2 className="text-base font-semibold">下载与提取</h2><p className="text-muted-foreground mt-1 text-sm">持续任务使用启动时读取的候选 Excel 名单。</p></div>
          <FieldGroup className="gap-5">
            <Field><FieldLabel>下载方式</FieldLabel><RadioGroup value={mode} onValueChange={v=>setMode(v as 'preview'|'download')} className="gap-3" disabled={!!running}><div className="flex items-start gap-2"><RadioGroupItem id="repair-one" value="preview"/><label htmlFor="repair-one" className="text-sm leading-none">下载一件并预览</label></div><div className="flex items-start gap-2"><RadioGroupItem id="repair-many" value="download"/><label htmlFor="repair-many" className="text-sm leading-none">持续下载，不展示图片</label></div></RadioGroup><FieldDescription>持续下载按候选名单处理，图片保留在本地。</FieldDescription></Field>
            {mode==='preview' && <Field><FieldLabel htmlFor="repair-number">专利公开号</FieldLabel><Input id="repair-number" value={number} onChange={e=>setNumber(e.target.value)} placeholder="CN222254999U" disabled={!!running}/><FieldDescription>包含 CN 和文献种类码，且必须在候选名单中。</FieldDescription></Field>}
            {mode==='download' && <Field><FieldLabel htmlFor="repair-concurrency">同时下载数量</FieldLabel><Input id="repair-concurrency" type="number" min={1} max={4} value={concurrency} onChange={e=>setConcurrency(e.target.value)} disabled={!!running}/><FieldDescription>默认 2，最多 4；下载可并行，图片与 Excel 更新逐件进行。</FieldDescription></Field>}
            <Field><FieldLabel htmlFor="repair-proxy">本机代理地址</FieldLabel><Input id="repair-proxy" value={proxy} onChange={e=>setProxy(e.target.value)} disabled={!!running}/><FieldDescription>可留空；填写时仅支持本机 HTTP 代理。</FieldDescription></Field>
            <Field><FieldLabel htmlFor="repair-delay">请求间隔（秒）</FieldLabel><Input id="repair-delay" type="number" min={3} max={3600} value={delay} onChange={e=>setDelay(e.target.value)} disabled={!!running}/></Field>
            {mode==='download' && <FieldDescription>此前已完成和失败的专利都会跳过。</FieldDescription>}
          </FieldGroup>
          <Button disabled={busy||!!running} onClick={()=>void action(mode)}><Download data-icon="inline-start"/>{mode==='preview'?'下载并提取图片':'开始持续下载、提取并更新'}</Button>
          {mode==='download' && <p className="text-muted-foreground text-sm">每件专利提取完成后自动更新，继续处理下一件；无需再点击其他更新按钮。</p>}
          <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">手动处理已有结果（可选）</summary><div className="mt-3 flex flex-col gap-3"><Field><FieldLabel htmlFor="repair-limit">手动批量更新最多处理数量</FieldLabel><Input id="repair-limit" type="number" min={1} max={10000} value={limit} onChange={e=>setLimit(e.target.value)} disabled={!!running}/><FieldDescription>仅用于下方手动操作；持续任务没有数量上限。</FieldDescription></Field><Button variant="outline" disabled={busy||!!running} onClick={()=>setDialog('apply-batch')}><Play data-icon="inline-start"/>批量更新已提取附图</Button><Button variant="outline" disabled={busy||!!running||!!reviewBusy} onClick={()=>void prepareSmsBatch()}><Play data-icon="inline-start"/>预检并批量更新正文图片</Button></div></details>
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-semibold">任务状态</h2><p className="text-muted-foreground mt-1 text-sm">关闭页面不会停止任务；服务重启后任务会中断。更新期间请勿重启服务。</p></div>{running && (task?.mode==='preview'||task?.mode==='download'||task?.mode==='sms') && <Button variant="outline" size="sm" disabled={busy} onClick={()=>void action('stop')}><Square data-icon="inline-start"/>停止任务</Button>}</div>
          {isLoading ? <Skeleton className="h-32 w-full"/> : error ? <Alert variant="destructive"><AlertTitle>无法读取任务</AlertTitle><AlertDescription>请检查服务状态后刷新页面。</AlertDescription></Alert> : task ? <div className="flex flex-col gap-3 rounded-lg border p-4" aria-live="polite"><div className="flex flex-wrap items-center gap-2"><Badge variant={task.status==='failed'?'destructive':'secondary'}>{({running:'运行中',completed:'已完成',failed:'失败',stopped:'已停止'})[task.status]}</Badge><span className="text-sm">{task.message}</span></div>{task.limit>0 && <Progress value={Math.min(100,Math.round((task.completed+task.failed)/task.limit*100))}/>}<p className="text-muted-foreground text-sm tabular-nums">已处理 {task.completed+task.failed}{task.limit>0 && ` / 最多 ${task.limit}`} 项 · 成功 {task.completed} · 失败 {task.failed}</p>{task.logs.length>0 && <div className="bg-muted/40 max-h-56 overflow-auto rounded-md p-3 text-xs"><ul className="flex flex-col gap-1">{task.logs.map((line,i)=><li key={i} className="break-words">{line}</li>)}</ul></div>}</div> : <Empty className="border"><EmptyHeader><EmptyTitle>暂无任务</EmptyTitle><EmptyDescription>选择下载方式后开始处理。</EmptyDescription></EmptyHeader></Empty>}
          {task?.timings && <p className="text-muted-foreground text-sm tabular-nums">累计耗时：下载及附图提取 {(task.timings.downloadMs/1000).toFixed(1)} 秒 · 正文图片 {(task.timings.smsMs/1000).toFixed(1)} 秒 · 附图更新 {(task.timings.drawingMs/1000).toFixed(1)} 秒 · Excel 同步 {(task.timings.excelMs/1000).toFixed(1)} 秒。并行下载的耗时为各任务累计值。{task.excelPending ? ` 待同步 Excel ${task.excelPending} 项。` : ''}</p>}
          {mode==='preview' && <section className="flex flex-col gap-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-semibold">附图预览</h2><p className="text-muted-foreground mt-1 text-sm">预览仅显示说明书附图，更新前请核对图形及图号。</p></div>{preview && <Button variant="outline" disabled={busy||!!running} onClick={()=>setDialog('apply')}>更新此专利</Button>}</div>{previewError ? <Alert variant="destructive"><AlertTitle>无法读取预览</AlertTitle><AlertDescription>请重新下载并提取该专利。</AlertDescription></Alert> : preview?.images.length ? <><p className="text-sm"><span translate="no">{preview.number}</span> · {preview.images.length} 张</p><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{preview.images.map(image=><figure key={image.index} className="overflow-hidden rounded-lg border"><Image src={`/api/patent-image-repair?number=${encodeURIComponent(preview.number)}&image=${image.index}`} alt={`${preview.number} ${image.label}`} width={image.width} height={image.height} unoptimized className="h-auto w-full"/><figcaption className="border-t p-3 text-sm">{image.label} · PDF 第 {image.page} 页</figcaption></figure>)}</div></> : <Empty className="border"><EmptyHeader><EmptyTitle>暂无预览</EmptyTitle><EmptyDescription>输入公开号，选择“下载并提取图片”。</EmptyDescription></EmptyHeader></Empty>}</section>}
        </div>
      </section>
      <section id="sms-preview" className="flex scroll-mt-20 flex-col gap-4 border-t pt-6">
        <div><h2 className="text-base font-semibold">正文 SMS 图片核对</h2><p className="text-muted-foreground mt-1 text-sm">使用上方下载并提取按钮，同时提取说明书附图和正文图片。</p></div>
        <Alert><AlertTitle>逐项核对正文引用</AlertTitle><AlertDescription>候选编号按 PDF 内容顺序生成，只作为建议。请根据正文上下文核对并保存；全部确认后可预检并更新。扫描页、矢量公式可能无法提取。</AlertDescription></Alert>
        <div className="flex flex-wrap items-end gap-3"><Field className="max-w-sm"><FieldLabel htmlFor="sms-number">专利公开号</FieldLabel><Input id="sms-number" value={number} onChange={e=>setNumber(e.target.value)} disabled={!!running}/><FieldDescription>与上方输入的公开号同步。</FieldDescription></Field><Button variant="outline" disabled={busy||!!reviewBusy} onClick={()=>{setSmsSelected(number.trim().toUpperCase());setSmsPage(0);setReviewDrafts({});void refreshSms()}}>查看已有结果</Button><Button variant="outline" disabled={busy||!!running||!!reviewBusy||!smsPreview||!smsPreview.references.some(ref=>ref.confirmedIndex===null)} onClick={()=>void confirmAllSms()}>{reviewBusy==='__all__'?'确认中…':'一键确认未确认项'}</Button><Button variant="outline" disabled={busy||!!running||!!reviewBusy||!smsPreview} onClick={()=>void prepareSmsUpdate()}>预检并更新正文图片</Button></div>
        <div><Button variant="outline" disabled={busy||!!running||!!reviewBusy||!smsPreview} onClick={()=>void preparePositions()}>预览正文图片位置</Button></div>
        <p className="text-muted-foreground text-sm">数据库中没有 SMS 正文图片时，不会提取。{smsPreview && '一键确认使用各页当前填写的候选编号，未修改时按同序编号确认；请先核对正文含义。正文位置调整建议在图片更新完成后进行。'}</p>
        {smsError ? <Alert variant="destructive"><AlertTitle>无法读取正文候选</AlertTitle><AlertDescription>{smsError instanceof Error ? smsError.message : '请检查公开号或重新提取。'}</AlertDescription></Alert> : smsDisplay && !smsPreview ? <p className="text-muted-foreground text-sm">暂无候选，请提取正文图片或检查本地 PDF。</p> : smsPreview && <><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm"><span translate="no">{smsPreview.number}</span> · {smsPreview.references.length} 个正文引用 · {smsPreview.images.length} 个候选 · 已确认 {smsPreview.references.filter(r=>r.confirmedIndex!==null).length} · 第 {smsPage+1} / {Math.max(1,Math.ceil(smsPreview.references.length/24))} 页</p><div className="flex gap-2"><Button variant="outline" size="sm" disabled={smsPage===0} onClick={()=>setSmsPage(p=>p-1)}>上一页</Button><Button variant="outline" size="sm" disabled={(smsPage+1)*24>=smsPreview.references.length} onClick={()=>setSmsPage(p=>p+1)}>下一页</Button></div></div><div className="grid gap-4 lg:grid-cols-2">{smsPreview.references.slice(smsPage*24,(smsPage+1)*24).map(ref=>{const defaultNumber=ref.confirmedIndex===null ? Number(ref.name.match(/\d+/)?.[0]) : ref.confirmedIndex+1;const draft=reviewDrafts[ref.name] ?? String(defaultNumber);const candidate=smsPreview.images[Number(draft)-1];return <article key={ref.name} className="flex min-w-0 flex-col gap-3 rounded-lg border p-4"><div className="flex items-center gap-2"><strong className="text-sm">{ref.name}</strong><Badge variant="secondary">{ref.confirmedIndex===null?'待核对':`已确认候选 ${ref.confirmedIndex+1}`}</Badge></div>{ref.contexts.length ? ref.contexts.slice(0,2).map((context,index)=><p key={index} className="text-muted-foreground break-words text-sm">{context.section}：{context.before}<strong className="text-foreground"> [{ref.name}] </strong>{context.after}</p>) : <p className="text-muted-foreground text-sm">正文中未找到对应引用，请人工检查。</p>}<Field><FieldLabel htmlFor={`candidate-${ref.name}`}>对应 PDF 候选编号</FieldLabel><Input id={`candidate-${ref.name}`} type="number" min={1} max={smsPreview.images.length} value={draft} onChange={e=>setReviewDrafts(old=>({...old,[ref.name]:e.target.value}))}/><FieldDescription>建议编号仅按顺序生成，需要核对正文含义。</FieldDescription></Field>{candidate?.available && candidate.width && candidate.height ? <figure className="rounded-lg border p-3"><Image src={`/api/patent-image-repair?type=sms&number=${encodeURIComponent(smsPreview.number)}&image=${candidate.index}`} alt={`${candidate.name} PDF 候选`} width={candidate.width} height={candidate.height} unoptimized className="h-auto max-w-full"/><figcaption className="text-muted-foreground mt-2 text-sm">{candidate.name} · PDF 第 {candidate.page} 页</figcaption></figure> : <p className="text-muted-foreground text-sm">该候选不存在或需要人工检查。</p>}<div className="flex flex-wrap gap-2"><Button size="sm" disabled={!!reviewBusy || !ref.hasOriginal || !ref.contexts.length || !candidate?.available} onClick={()=>void saveReview(ref.name,candidate!.index)}>确认对应关系</Button>{ref.confirmedIndex!==null && <Button size="sm" variant="outline" disabled={!!reviewBusy} onClick={()=>void saveReview(ref.name,null)}>取消确认</Button>}</div></article>})}</div></>}
      </section>
    </main>
    <Dialog open={smsBatchPlan!==null} onOpenChange={open=>{if(!open)setSmsBatchPlan(null)}}><DialogContent><DialogHeader><DialogTitle>批量更新正文图片</DialogTitle><DialogDescription>可更新 {smsBatchPlan?.items.length || 0} 件，跳过 {smsBatchPlan?.skipped.length || 0} 件。未确认的图片在数量和编号一一对应时按顺序自动匹配，无法保证语义一定一致。旧正文图片先删除，不备份。</DialogDescription></DialogHeader><div className="max-h-80 overflow-auto rounded-lg border p-3 text-sm"><ul className="flex flex-col gap-3">{smsBatchPlan?.items.map(item=><li key={item.number} className="break-all"><strong>{item.number}</strong> · {item.count} 张 · 自动对应 {item.automatic} 张<ul className="text-muted-foreground"><li>{item.oldKeys.join('、')}</li></ul></li>)}{smsBatchPlan?.skipped.map(item=><li key={item.number} className="text-muted-foreground break-words">{item.number}：跳过，{item.reason}</li>)}</ul></div><DialogFooter><Button variant="outline" onClick={()=>setSmsBatchPlan(null)}>关闭</Button><Button disabled={busy||!smsBatchPlan?.items.length} onClick={()=>void applySmsBatch()}>删除旧图并批量更新</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={dialog!==null} onOpenChange={open=>{if(!open)setDialog(null)}}><DialogContent><DialogHeader><DialogTitle>{dialog==='apply'?'更新此专利附图':'批量更新已提取附图'}</DialogTitle><DialogDescription>{dialog==='apply' ? `将使用 ${displayNumber || ''} 的提取结果更新说明书附图。` : `将最多更新 ${limit} 项已提取且通过校验的专利。`}原关联会备份，正文内嵌图片和摘要图不会替换。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={()=>setDialog(null)}>取消</Button><Button disabled={busy} onClick={()=>void action(dialog!)}>更新附图</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={positionPlan!==null} onOpenChange={open=>{if(!open)setPositionPlan(null)}}><DialogContent><DialogHeader><DialogTitle>预览正文图片位置</DialogTitle><DialogDescription>可定位 {positionPlan?.proposed.length || 0} 处，待核对 {positionPlan?.unresolved.length || 0} 处。更新正文会使当前图片核对记录失效，建议先完成图片更新；旧候选需重新提取以获取 PDF 上下文。</DialogDescription></DialogHeader><div className="max-h-80 overflow-auto rounded-lg border p-3 text-sm"><ul className="flex flex-col gap-3">{positionPlan?.proposed.map(item=><li key={item.name} className="break-words">{item.name} · PDF 第 {item.page} 页：{item.before}<strong> [{item.name}] </strong>{item.after}</li>)}{positionPlan?.unresolved.map(item=><li key={item.name} className="text-muted-foreground break-words">{item.name}：{item.reason}</li>)}</ul></div><DialogFooter><Button variant="outline" onClick={()=>setPositionPlan(null)}>关闭</Button><Button disabled={busy||!positionPlan?.proposed.length} onClick={()=>void applyPositions()}>更新可定位的位置</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={smsPlan!==null} onOpenChange={open=>{if(!open)setSmsPlan(null)}}><DialogContent><DialogHeader><DialogTitle>确认更新正文图片</DialogTitle><DialogDescription>将先删除以下 {smsPlan?.oldKeys.length || 0} 个旧对象，再写入 {smsPlan?.count || 0} 张已核对的新图并更新数据库。按照你的要求不备份旧图；中断时旧图无法恢复，需重新预检并重试。</DialogDescription></DialogHeader><div className="max-h-64 overflow-auto rounded-lg border p-3 text-xs"><ul className="flex flex-col gap-1">{smsPlan?.oldKeys.map(key=><li key={key} className="break-all">{key}</li>)}</ul></div><DialogFooter><Button variant="outline" onClick={()=>setSmsPlan(null)}>取消</Button><Button disabled={busy} onClick={()=>void applySmsUpdate()}>删除旧图并更新</Button></DialogFooter></DialogContent></Dialog>
  </AppShell>
}
