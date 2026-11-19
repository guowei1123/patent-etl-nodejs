import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, realpath, readdir, stat, appendFile, open, unlink, rename, mkdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { createInterface } from 'node:readline'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline as streamPipeline } from 'node:stream/promises'
import { readVerifiedImage, validateManifest, type PdfManifest } from '@/features/historical-import/pdf/historical-pdf'
import { getSmsReviewSource, getSmsOriginals, acquireSmsUpdateClient, getPatentDrawingKeys } from '@/lib/pg-db'
import { extractSmsContexts } from './sms-context'
import { planSmsPositions } from './sms-position'
import { boundedQueue, runPipeline, serialQueue } from './pipeline'
import { cleanupCompletedArtifacts } from './cleanup'
import { getRepairPaths, defaultRepairPaths, repairEnvironment } from './settings'
import { planSmsReplacement } from '../historical-import/pdf/sms-repair-plan'
import { getPatentImage, patentImageExists, putPatentImage, removePatentImage } from '@/lib/oss-client'
import sharp from 'sharp'

type Mode = 'preview' | 'download' | 'apply' | 'apply-batch' | 'sms' | 'sms-apply' | 'sms-apply-batch'
type Task = { mode: Mode; status: 'running' | 'completed' | 'failed' | 'stopped'; number?: string; limit: number; completed: number; failed: number; message: string; logs: string[]; startedAt: string; stopping?: boolean; warning?: string; excelPending?:number; timings?:{downloadMs:number;smsMs:number;drawingMs:number;excelMs:number} }
type Store = { task: Task | null; child: ChildProcess | null }
const scope = globalThis as typeof globalThis & { __patentRepairTask?: Store }
const store = scope.__patentRepairTask ||= { task: null, child: null }
const root = path.resolve('data/patent-image-repair')
const reportPath = path.join(root, 'report.jsonl')
const numberPattern = /^CN\d{7,12}[ABCUSY]\d?$/
type Report = { status: string; repair_revision?: number; publication_number: string; manifest?: string; pdf_hash?:string; drawing_pages?: number; error?: string; error_code?:string }

async function reports(): Promise<Report[]> {
  try { return (await readFile(reportPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Report) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}

async function insideRoot(file: string) {
  const [base, actual] = await Promise.all([realpath(root), realpath(file)])
  const relative = path.relative(base, actual)
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('图片路径无效')
  return actual
}

export async function preview(number: string, imageIndex?: number) {
  if (!numberPattern.test(number)) throw new Error('请输入完整公开号，例如 CN222254999U')
  const record = (await reports()).reverse().find(r => r.publication_number === number && r.status === 'ready' && r.repair_revision === 4 && r.manifest)
  if (!record?.manifest) return null
  const manifestFile = await insideRoot(record.manifest)
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as PdfManifest
  validateManifest(manifest, 'repair')
  if (manifest.patent_number !== number || manifest.version !== 'pdf-figures-v2' || manifest.images.some(i => i.image_role !== 'drawing')) throw new Error('图片清单与公开号不一致')
  if (imageIndex !== undefined) {
    if (!Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex >= manifest.images.length) throw new Error('图片编号无效')
    const image = manifest.images[imageIndex]
    const verified = await insideRoot(path.join(path.dirname(manifestFile), image.file_name))
    return { content: await readVerifiedImage(path.dirname(verified), image) }
  }
  return { number, images: manifest.images.map((image, index) => ({ index, label: image.figure_label, page: image.page, width: image.width, height: image.height })) }
}

type SmsImage = {file_name:string;page:number;width?:number;height?:number;sha256?:string;status?:string;error?:string;text_context?:{before:string;after:string}|null}
async function loadSmsManifest(number:string) {
  if(!numberPattern.test(number)) throw new Error('请输入完整公开号')
  const base=path.join(root,'sms-preview')
  let names:string[]
  try { names=await readdir(base) } catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT') return null; throw error }
  const entries=await Promise.all(names.filter(name=>name===number || name.startsWith(number+'-')).map(async name=>({name,modified:(await stat(path.join(base,name))).mtimeMs})))
  const matching=entries.sort((a,b)=>b.modified-a.modified).map(entry=>entry.name)
  let manifest:{publication_number:string;pdf_sha256:string;mapping_verified:boolean;images:SmsImage[]}|undefined
  let directory=''
  let manifestHash=''
  for(const name of matching) {
    try {
      const file=await insideRoot(path.join(base,name,'manifest.json'))
      const raw=await readFile(file)
      const value=JSON.parse(raw.toString('utf8'))
      if(value.publication_number===number && Array.isArray(value.images)) {manifest=value;directory=path.dirname(file);manifestHash=createHash('sha256').update(raw).digest('hex');break}
    } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error }
  }
  return manifest ? {manifest,directory,manifestHash} : null
}

type ReviewEvent = {name:string;candidateIndex:number|null;candidateHash:string|null;manifestHash:string;descriptionHash:string;time:string}
async function acquireReviewLock(lockPath:string) {
  for(let attempt=0;attempt<2;attempt++) {
    try {
      const lock=await open(lockPath,'wx')
      try {await lock.writeFile(JSON.stringify({pid:process.pid,host:os.hostname()}));await lock.sync()} catch(error) {await lock.close();throw error}
      return lock
    } catch(error) {
      if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error
      let stale=false
      try {
        const info=JSON.parse(await readFile(lockPath,'utf8')) as {pid:number;host:string}
        if(info.host===os.hostname() && Number.isInteger(info.pid) && info.pid>0) {
          try {process.kill(info.pid,0)} catch(check) {if((check as NodeJS.ErrnoException).code==='ESRCH') stale=true}
        }
      } catch { /* Unknown lock is never removed automatically. */ }
      if(!stale) throw new Error('核对或更新正在进行，请稍后重试；若服务异常退出，请检查核对锁')
      const stalePath=`${lockPath}.stale-${randomUUID()}`
      try {await rename(lockPath,stalePath);await unlink(stalePath)} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error}
    }
  }
  throw new Error('无法取得核对锁，请稍后重试')
}
async function reviewEvents(directory:string,manifestHash:string,descriptionHash:string) {
  let raw:string
  try {raw=await readFile(path.join(directory,'review.jsonl'),'utf8')} catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT') return new Map<string,ReviewEvent>();throw error}
  const result=new Map<string,ReviewEvent>()
  for(const line of raw.split('\n').filter(Boolean)) {
    const event=JSON.parse(line) as ReviewEvent
    if(event.manifestHash===manifestHash && event.descriptionHash===descriptionHash) result.set(event.name,event)
  }
  return result
}

export async function smsPreview(number:string, imageIndex?:number) {
  const loaded=await loadSmsManifest(number)
  if(!loaded) return null
  const {manifest,directory,manifestHash}=loaded
  if(imageIndex!==undefined) {
    if(!Number.isInteger(imageIndex)||imageIndex<0||imageIndex>=manifest.images.length) throw new Error('图片编号无效')
    const item=manifest.images[imageIndex]
    if(item.file_name!==`SMS_${imageIndex+1}.JPG` || !/^[a-f0-9]{64}$/.test(item.sha256||'')) throw new Error('该候选图片需要人工检查')
    const file=await insideRoot(path.join(directory,item.file_name))
    const content=await readFile(file)
    if(createHash('sha256').update(content).digest('hex')!==item.sha256) throw new Error('候选图片校验失败')
    return {content}
  }
  const source=await getSmsReviewSource(number)
  const {references,descriptionHash}=extractSmsContexts(source.description)
  const byName=new Map(references.map(item=>[item.name,item]))
  for(const name of source.originalNames) if(!byName.has(name)) {const item={name,contexts:[]};references.push(item);byName.set(name,item)}
  const originalSet=new Set(source.originalNames)
  const events=await reviewEvents(directory,manifestHash,descriptionHash)
  const images=manifest.images.map((item,index)=>({index,name:item.file_name,page:item.page,width:item.width,height:item.height,available:/^[a-f0-9]{64}$/.test(item.sha256||''),error:item.error}))
  return {number,batch:source.batch,mappingVerified:false,manifestHash,descriptionHash,images,references:references.map(item=>{const event=events.get(item.name);const index=event?.candidateIndex;return {...item,hasOriginal:originalSet.has(item.name),confirmedIndex:index!==null && index!==undefined && manifest.images[index]?.sha256===event?.candidateHash ? index : null}})}
}

export async function saveSmsReview(input:{number:string;name:string;candidateIndex:number|null;manifestHash:string;descriptionHash:string}) {
  if(!/^SMS_[1-9]\d*\.JPG$/.test(input.name)) throw new Error('SMS 名称无效')
  const loaded=await loadSmsManifest(input.number)
  if(!loaded || loaded.manifestHash!==input.manifestHash) throw new Error('候选结果已变化，请刷新后重新核对')
  const {manifest,directory,manifestHash}=loaded
  const source=await getSmsReviewSource(input.number)
  const {references,descriptionHash}=extractSmsContexts(source.description)
  if(descriptionHash!==input.descriptionHash) throw new Error('正文内容已变化，请刷新后重新核对')
  if(!source.originalNames.includes(input.name) || !references.some(item=>item.name===input.name)) throw new Error('正文引用或原图记录不存在，无法确认')
  let hash:string|null=null
  if(input.candidateIndex!==null) {
    const index=input.candidateIndex
    if(!Number.isInteger(index)||index<0||index>=manifest.images.length) throw new Error('候选编号无效')
    const item=manifest.images[index]
    if(item.file_name!==`SMS_${index+1}.JPG` || !/^[a-f0-9]{64}$/.test(item.sha256||'')) throw new Error('候选图片无效')
    const content=await readFile(await insideRoot(path.join(directory,item.file_name)))
    hash=createHash('sha256').update(content).digest('hex')
    if(hash!==item.sha256) throw new Error('候选图片校验失败')
  }
  const lockPath=path.join(directory,'review.lock')
  const lock=await acquireReviewLock(lockPath)
  try {
    const events=await reviewEvents(directory,manifestHash,descriptionHash)
    if(input.candidateIndex!==null && [...events.values()].some(event=>event.name!==input.name && event.candidateIndex===input.candidateIndex)) throw new Error('该候选已分配给其他 SMS，请先取消原确认')
    const event:ReviewEvent={name:input.name,candidateIndex:input.candidateIndex,candidateHash:hash,manifestHash,descriptionHash,time:new Date().toISOString()}
    await appendFile(path.join(directory,'review.jsonl'),JSON.stringify(event)+'\n','utf8')
  } finally {await lock.close();await unlink(lockPath)}
}

export async function saveSmsReviews(input:{number:string;entries:{name:string;candidateIndex:number}[];manifestHash:string;descriptionHash:string}) {
  const initial=await loadSmsManifest(input.number)
  if(!initial || initial.manifestHash!==input.manifestHash) throw new Error('候选结果已变化，请刷新后重新核对')
  const lockPath=path.join(initial.directory,'review.lock')
  const lock=await acquireReviewLock(lockPath)
  try {
    const loaded=await loadSmsManifest(input.number)
    if(!loaded || loaded.directory!==initial.directory || loaded.manifestHash!==input.manifestHash) throw new Error('候选结果已变化，请刷新后重新核对')
    const {manifest,directory,manifestHash}=loaded
    const source=await getSmsReviewSource(input.number)
    const {references,descriptionHash}=extractSmsContexts(source.description)
    if(descriptionHash!==input.descriptionHash) throw new Error('正文内容已变化，请刷新后重新核对')
    const originalSet=new Set(source.originalNames)
    const referenceSet=new Set(references.map(item=>item.name))
    const names=new Set([...referenceSet,...originalSet])
    const events=await reviewEvents(directory,manifestHash,descriptionHash)
    const confirmed=new Map<string,number>()
    for(const name of names) {
      const event=events.get(name)
      const index=event?.candidateIndex
      if(index!==null && index!==undefined && manifest.images[index]?.sha256===event?.candidateHash) confirmed.set(name,index)
    }
    const outstanding=[...names].filter(name=>!confirmed.has(name))
    const supplied=new Set(input.entries.map(entry=>entry.name))
    if(!input.entries.length || supplied.size!==input.entries.length || outstanding.length!==input.entries.length || outstanding.some(name=>!supplied.has(name))) throw new Error('核对状态已变化，请刷新后重试')
    const used=new Set(confirmed.values())
    const additions:ReviewEvent[]=[]
    for(const {name,candidateIndex} of input.entries) {
      if(!/^SMS_[1-9]\d*\.JPG$/.test(name) || !originalSet.has(name) || !referenceSet.has(name)) throw new Error(`${name} 缺少正文引用或原图记录，无法一键确认`)
      if(!Number.isInteger(candidateIndex) || candidateIndex<0 || candidateIndex>=manifest.images.length) throw new Error(`${name} 的候选编号无效`)
      if(used.has(candidateIndex)) throw new Error(`${name} 的候选编号已被使用，请调整后重试`)
      used.add(candidateIndex)
      const item=manifest.images[candidateIndex]
      if(item.file_name!==`SMS_${candidateIndex+1}.JPG` || !/^[a-f0-9]{64}$/.test(item.sha256||'')) throw new Error(`${name} 的候选图片无效`)
      const content=await readFile(await insideRoot(path.join(directory,item.file_name)))
      const hash=createHash('sha256').update(content).digest('hex')
      if(hash!==item.sha256) throw new Error(`${name} 的候选图片校验失败`)
      additions.push({name,candidateIndex,candidateHash:hash,manifestHash,descriptionHash,time:new Date().toISOString()})
    }
    await appendFile(path.join(directory,'review.jsonl'),additions.map(event=>JSON.stringify(event)).join('\n')+'\n','utf8')
    return {confirmed:additions.length}
  } finally {await lock.close();await unlink(lockPath)}
}

async function smsPositionWork(number:string) {
  const loaded=await loadSmsManifest(number)
  if(!loaded) throw new Error('没有正文候选，请先重新提取正文图片')
  const source=await getSmsReviewSource(number)
  const original=await getSmsOriginals(number)
  const {references,descriptionHash}=extractSmsContexts(source.description)
  const events=await reviewEvents(loaded.directory,loaded.manifestHash,descriptionHash)
  const candidates=references.map(ref=>{
    const event=events.get(ref.name)
    const item=event?.candidateIndex===null || event?.candidateIndex===undefined ? undefined : loaded.manifest.images[event.candidateIndex]
    return {name:ref.name,page:item?.page||0,context:item && item.sha256===event?.candidateHash ? item.text_context : null}
  })
  const plan=planSmsPositions(source.description,candidates)
  const fingerprint=createHash('sha256').update(JSON.stringify({number,manifestHash:loaded.manifestHash,descriptionHash,proposed:plan.proposed,description:plan.description})).digest('hex')
  return {...plan,number,fingerprint,descriptionHash,patentId:original.patentId,directory:loaded.directory}
}

export async function smsPositionPlan(number:string) {
  const {proposed,unresolved,fingerprint}=await smsPositionWork(number)
  return {number,proposed,unresolved,fingerprint}
}

export async function applySmsPositions(number:string,fingerprint:string) {
  if(!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('预检结果无效')
  const initial=await smsPositionWork(number)
  const lockPath=path.join(initial.directory,'review.lock')
  const lock=await acquireReviewLock(lockPath)
  try {
    const work=await smsPositionWork(number)
    if(work.directory!==initial.directory || work.fingerprint!==fingerprint) throw new Error('正文或核对结果已变化，请重新预检')
    if(!work.proposed.length) throw new Error('没有可安全定位的图片')
    const client=await acquireSmsUpdateClient()
    let commitStarted=false
    try {
      await client.query('BEGIN')
      const row=await client.query<{description:unknown}>('SELECT description FROM cnipa.patent WHERE id=$1 FOR UPDATE',[work.patentId])
      if(row.rowCount!==1 || extractSmsContexts(row.rows[0].description).descriptionHash!==work.descriptionHash) throw new Error('正文已变化，请重新预检')
      await client.query('UPDATE cnipa.patent SET description=$2::jsonb WHERE id=$1',[work.patentId,JSON.stringify(work.description)])
      commitStarted=true
      await client.query('COMMIT')
      return {updated:work.proposed.length,unresolved:work.unresolved.length}
    } catch(error) {await client.query('ROLLBACK').catch(()=>{});if(commitStarted) throw new Error('数据库提交结果不确定，请先检查正文，再决定是否重试');throw error}
    finally {client.release()}
  } finally {await lock.close();await unlink(lockPath)}
}

async function smsUpdateWork(number:string,allowAutomatic=false) {
  const loaded=await loadSmsManifest(number)
  if(!loaded) throw new Error('没有正文图片候选，请先提取')
  const source=await getSmsReviewSource(number)
  const original=await getSmsOriginals(number)
  const {references,descriptionHash}=extractSmsContexts(source.description)
  const events=await reviewEvents(loaded.directory,loaded.manifestHash,descriptionHash)
  const mapping=new Map<string,number>()
  const names=original.images.map(image=>image.file_name.toUpperCase())
  const uniqueNames=new Set(names)
  const canAuto=allowAutomatic && names.length>0 && uniqueNames.size===names.length && loaded.manifest.images.length===names.length && loaded.manifest.images.every((item,index)=>item.file_name===`SMS_${index+1}.JPG` && item.status!=='needs_review' && /^[a-f0-9]{64}$/.test(item.sha256||''))
  const orderedNames=[...uniqueNames].sort((a,b)=>Number(a.match(/\d+/)?.[0])-Number(b.match(/\d+/)?.[0]))
  const automaticIndex=new Map(orderedNames.map((name,index)=>[name,index]))
  let automatic=0
  for(const image of original.images) {
    const name=image.file_name.toUpperCase()
    const event=events.get(name)
    const confirmed=event && event.candidateIndex!==null && loaded.manifest.images[event.candidateIndex]?.sha256===event.candidateHash ? event.candidateIndex : null
    if(!canAuto && !references.some(ref=>ref.name===name)) throw new Error(`${name} 没有正文引用，无法更新`)
    if(confirmed===null && !canAuto) throw new Error(`${name} 尚未确认，且原图与候选数量不一致或候选无效`)
    const index=confirmed ?? automaticIndex.get(name)!
    if(canAuto && confirmed!==null && confirmed!==automaticIndex.get(name) && names.some(other=>{const e=events.get(other);return !e || e.candidateIndex===null || loaded.manifest.images[e.candidateIndex]?.sha256!==e.candidateHash})) throw new Error('已有确认关系与自动编号冲突，请核对后再更新')
    if(confirmed===null) automatic++
    if(image.asset_key!==image.oss_key) throw new Error(`${name} 的存储关联不一致`)
    mapping.set(name,index)
  }
  const plan=planSmsReplacement(original.images,loaded.manifest.images,mapping)
  const match=/^CN(\d{7,12})/.exec(number)!
  if(!/^[A-Za-z0-9_-]+$/.test(original.batch)) throw new Error('批次路径无效')
  const prefix=`patents/${original.batch}/${match[1]}/`
  if(plan.oldKeys.some(key=>!key.startsWith(prefix) || !/^SMS_[1-9]\d*\.JPG$/i.test(key.slice(prefix.length)))) throw new Error('旧图存储路径不属于当前专利')
  const contents:Buffer[]=[]
  for(const item of plan.images) {
    const bytes=await readFile(await insideRoot(path.join(loaded.directory,item.candidate.file_name)))
    if(createHash('sha256').update(bytes).digest('hex')!==item.candidate.sha256) throw new Error(`候选图校验失败：${item.candidate.file_name}`)
    const meta=await sharp(bytes).metadata()
    if(meta.format!=='jpeg' || !meta.width || !meta.height) throw new Error(`候选图不是有效 JPEG：${item.candidate.file_name}`)
    contents.push(bytes)
  }
  const fingerprint=createHash('sha256').update(JSON.stringify({number,batch:original.batch,manifestHash:loaded.manifestHash,descriptionHash,items:plan.images.map(i=>[i.name,i.original.id,i.original.asset_id,i.original.oss_key,i.index,i.candidate.sha256])})).digest('hex')
  return {number,batch:original.batch,count:plan.images.length,oldKeys:plan.oldKeys,fingerprint,manifestHash:loaded.manifestHash,descriptionHash,plan,contents,directory:loaded.directory,patentId:original.patentId,prefix,automatic}
}

export async function smsUpdatePlan(number:string,allowAutomatic=false) {
  if(!numberPattern.test(number)) throw new Error('请输入完整公开号')
  const journalDir=path.join(root,'sms-updates',number)
  try {await stat(path.join(journalDir,'completed'));throw new Error('该专利的正文图片已更新，无需重复更新')}
  catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error}
  const {batch,count,oldKeys,fingerprint,automatic}=await smsUpdateWork(number,allowAutomatic)
  try {
    const journal=JSON.parse(await readFile(path.join(journalDir,'journal.json'),'utf8')) as {fingerprint:string}
    if(journal.fingerprint!==fingerprint) throw new Error('存在未完成的正文更新，候选或数据库已变化，请先核查原任务')
  } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error}
  return {number,batch,count,oldKeys,fingerprint,automatic}
}

type SmsBatchItem = {number:string;batch:string;count:number;oldKeys:string[];fingerprint:string;automatic:number}
export async function smsBatchUpdatePlan(limit:number) {
  if(!Number.isInteger(limit)||limit<1||limit>10000) throw new Error('批量数量需为 1 至 10000')
  let dirs:string[]
  try {dirs=await readdir(path.join(root,'sms-preview'))} catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT') return {items:[],skipped:[]};throw error}
  const numbers=[...new Set(dirs.map(name=>/^(CN\d{7,12}[ABCUSY]\d?)(?:-|$)/.exec(name)?.[1]).filter((name):name is string=>!!name))].sort()
  const items:SmsBatchItem[]=[],skipped:{number:string;reason:string}[]=[]
  for(const number of numbers) {
    if(items.length>=limit) break
    try {items.push(await smsUpdatePlan(number,true))}
    catch(error) {skipped.push({number,reason:error instanceof Error?error.message:String(error)})}
  }
  return {items,skipped}
}

export async function runSmsUpdate(number:string,approvedFingerprint:string,task:Task,allowAutomatic=false,checkedOldKeys?:ReadonlySet<string>) {
  const initial=await loadSmsManifest(number)
  if(!initial) throw new Error('没有正文图片候选')
  const lockPath=path.join(initial.directory,'review.lock')
  const lock=await acquireReviewLock(lockPath)
  try {
    const approved=await smsUpdatePlan(number,allowAutomatic)
    if(approved.fingerprint!==approvedFingerprint) throw new Error('核对结果或旧图已变化，请重新预检')
    const work=await smsUpdateWork(number,allowAutomatic)
    if(work.directory!==initial.directory || work.fingerprint!==approvedFingerprint) throw new Error('核对结果或旧图已变化，请重新预检')
    const client=await acquireSmsUpdateClient()
    let commitStarted=false
    try {
      await client.query('BEGIN')
      const patent=await client.query<{description:unknown}>('SELECT description FROM cnipa.patent WHERE id=$1 FOR UPDATE',[work.patentId])
      if(patent.rowCount!==1 || extractSmsContexts(patent.rows[0].description).descriptionHash!==work.descriptionHash) throw new Error('正文已变化，请重新核对')
      const old=await client.query<{id:string;file_name:string;oss_key:string;asset_id:string;is_abstract:boolean}>(`SELECT id,file_name,oss_key,asset_id,is_abstract FROM cnipa.patent_image WHERE patent_id=$1 AND file_name ~* '^SMS_[1-9][0-9]*\\.JPG$' FOR UPDATE`,[work.patentId])
      const snapshot=new Map(work.plan.images.map(x=>[x.original.id,x.original]))
      if(old.rows.length!==snapshot.size || old.rows.some(row=>{const before=snapshot.get(row.id);return !before || row.file_name!==before.file_name || row.oss_key!==before.oss_key || row.asset_id!==before.asset_id || row.is_abstract})) throw new Error('旧图关联已变化，请重新预检')
      await client.query('SELECT id FROM cnipa.image_asset WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[[...new Set(old.rows.map(row=>row.asset_id))]])
      const targetKeys=work.plan.images.map(item=>work.prefix+item.name)
      const journalDir=path.join(root,'sms-updates',number)
      await mkdir(journalDir,{recursive:true})
      const journalPath=path.join(journalDir,'journal.json')
      let journal:{fingerprint:string;oldHashes?:Record<string,string>}|undefined
      try {journal=JSON.parse(await readFile(journalPath,'utf8'))} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error}
      if(journal && journal.fingerprint!==approvedFingerprint) throw new Error('存在其他未完成的 SMS 更新记录，请先核查')
      for(const key of work.oldKeys) {
        if(checkedOldKeys) {
          if(!checkedOldKeys.has(key)) throw new Error('正文旧图路径已变化，请重新启动任务进行存在性检查')
        } else if(!(await patentImageExists(key))) {
          throw Object.assign(new Error(`正文旧图在对象存储中不存在，已跳过：${key}`),{code:'SMS_STORAGE_MISSING'})
        }
      }
      if(!journal) {
        const file=await open(journalPath,'wx')
        try {await file.writeFile(JSON.stringify({fingerprint:approvedFingerprint,number,mode:'direct-overwrite',createdAt:new Date().toISOString()}));await file.sync()} finally {await file.close()}
      }
      for(const [index,item] of work.plan.images.entries()) {
        task.message=`正在写入新图 ${index+1} / ${work.count}`
        const key=targetKeys[index],bytes=work.contents[index],hash=item.candidate.sha256!
        await putPatentImage(key,bytes,'image/jpeg')
        if(createHash('sha256').update((await getPatentImage(key)).content).digest('hex')!==hash) throw new Error(`新图校验失败：${item.name}`)
        const meta=await sharp(bytes).metadata()
        const asset=await client.query<{id:string}>(`INSERT INTO cnipa.image_asset(oss_key,content_hash,content_type,size,width,height) VALUES($1,$2,'image/jpeg',$3,$4,$5) ON CONFLICT(oss_key) DO UPDATE SET content_hash=EXCLUDED.content_hash,content_type=EXCLUDED.content_type,size=EXCLUDED.size,width=EXCLUDED.width,height=EXCLUDED.height RETURNING id`,[key,hash,bytes.length,meta.width,meta.height])
        await client.query(`UPDATE cnipa.patent_image SET asset_id=$2,oss_key=$3,content_type='image/jpeg',size=$4,width=$5,height=$6 WHERE id=$1`,[item.original.id,asset.rows[0].id,key,bytes.length,meta.width,meta.height])
      }
      const targetSet=new Set(targetKeys.map(key=>key.toLowerCase()))
      for(const key of work.oldKeys) if(!targetSet.has(key.toLowerCase())) await removePatentImage(key)
      commitStarted=true
      await client.query('COMMIT')
      task.completed=1
      task.logs.push(`${number}：已更新 ${work.count} 条 SMS 关联${work.automatic ? `，其中 ${work.automatic} 条按编号自动对应` : ''}`)
      try {const marker=await open(path.join(journalDir,'completed'),'wx');try {await marker.writeFile(new Date().toISOString());await marker.sync()} finally {await marker.close()}}
      catch {task.logs.push('更新已提交，但完成标记写入失败，请先核对数据库，勿重复执行')}
    } catch(error) {
      await client.query('ROLLBACK').catch(()=>{})
      if(commitStarted) throw new Error('数据库提交结果不确定，请先检查当前图片和关联，勿重复执行')
      throw error
    } finally {client.release()}
  } finally {await lock.close();await unlink(lockPath)}
}

export function startSmsUpdate(number:string,fingerprint:string) {
  if(store.task?.status==='running') throw new Error('已有任务正在运行，请等待完成')
  if(!numberPattern.test(number) || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('更新参数无效')
  const task:Task={mode:'sms-apply',status:'running',number,limit:1,completed:0,failed:0,message:'正在核对更新清单…',logs:[],startedAt:new Date().toISOString()}
  store.task=task;store.child=null
  void runSmsUpdate(number,fingerprint,task).then(()=>{task.status='completed';task.message='正文图片已更新'})
    .catch(error=>{task.failed=1;task.status='failed';task.message='正文图片更新未完成，请查看运行记录';task.logs.push(`${error instanceof Error?error.message:String(error)}；若已删除旧图，可在未改变核对结果时重新预检并重试`)})
  return task
}

export function startSmsBatchUpdate(items:Pick<SmsBatchItem,'number'|'fingerprint'>[]) {
  if(store.task?.status==='running') throw new Error('已有任务正在运行，请等待完成')
  if(!items.length || items.length>10000 || new Set(items.map(item=>item.number)).size!==items.length || items.some(item=>!numberPattern.test(item.number)||!/^[a-f0-9]{64}$/.test(item.fingerprint))) throw new Error('批量更新清单无效，请重新预检')
  const task:Task={mode:'sms-apply-batch',status:'running',limit:items.length,completed:0,failed:0,message:'正在预检正文图片…',logs:[],startedAt:new Date().toISOString()}
  store.task=task;store.child=null
  void (async()=>{
    for(const item of items) {
      task.number=item.number
      task.message=`正在更新 ${item.number}（${task.completed+task.failed+1} / ${items.length}）`
      try {
        const current=await smsUpdatePlan(item.number,true)
        if(current.fingerprint!==item.fingerprint) throw new Error('正文或图片清单已变化，请重新预检')
      } catch(error) {
        task.failed++;task.logs.push(`${item.number}：已跳过，${error instanceof Error?error.message:String(error)}`)
        continue
      }
      const single:Task={mode:'sms-apply',status:'running',number:item.number,limit:1,completed:0,failed:0,message:'',logs:[],startedAt:task.startedAt}
      try {
        await runSmsUpdate(item.number,item.fingerprint,single,true)
        task.completed++
        task.logs.push(...single.logs)
        if(single.logs.some(line=>line.includes('完成标记写入失败'))) {task.status='failed';task.message='完成标记写入失败，请核对后再继续';return}
      } catch(error) {
        task.failed++;task.logs.push(`${item.number}：更新中断，${error instanceof Error?error.message:String(error)}；请核查该专利后再重试`)
        task.status='failed';task.message='正文图片更新中断，请查看运行记录';return
      }
    }
    task.status=task.failed?'failed':'completed'
    task.message=`任务结束：成功 ${task.completed}，跳过 ${task.failed}`
  })().catch(error=>{task.status='failed';task.message='批量更新异常，请查看运行记录';task.logs.push(error instanceof Error?error.message:String(error))})
  return task
}

export function getTask() { return store.task }
export function stopTask() {
  if (!store.task || store.task.status !== 'running') throw new Error('没有正在运行的任务')
  if (store.task.mode === 'apply' || store.task.mode === 'apply-batch' || store.task.mode === 'sms-apply' || store.task.mode === 'sms-apply-batch') throw new Error('图片更新及文件整理期间不能中断，请等待任务完成')
  store.task.stopping = true
  store.task.message = store.task.mode==='download' && store.task.limit===0 ? '正在完成处理中专利后停止…' : '正在停止…'
  store.child?.kill()
}

export async function runCombinedSms(numbers:string[], hooks:{stopped:()=>boolean;hasSms:(number:string)=>Promise<boolean>;extract:(number:string)=>Promise<string>;afterExtract?:(number:string)=>Promise<void>;log:(message:string)=>void;failed:(number:string)=>void}) {
  for(const number of numbers) {
    if(hooks.stopped()) break
    try {
      const hasSms=await hooks.hasSms(number)
      if(hooks.stopped()) break
      if(!hasSms) {hooks.log(`${number}：数据库没有 SMS 正文图片，已跳过正文提取`);continue}
      const message=await hooks.extract(number)
      if(hooks.stopped()) break
      hooks.log(`${number}：${message}`)
      if(hooks.afterExtract) await hooks.afterExtract(number)
    } catch(error) {
      if(hooks.stopped()) break
      hooks.failed(number)
      hooks.log(`${number}：正文图片提取失败，${error instanceof Error?error.message:String(error)}`)
    }
  }
}

type PipelineItem = {publication_number:string;batch:string;image_names:string[];repair_status?:string}
const isSmsOnlyCandidate=(item:PipelineItem)=>item.image_names.length>0 && item.image_names.every(name=>/^SMS_[1-9]\d*\.JPG$/i.test(name.trim()))
type PipelineRecord = {publication_number:string;batch:string;status:string;error?:string;error_code?:string;pdf?:string;pdf_hash?:string;manifest?:string;repair_revision?:number}
type ExcelAction={id:string;kind:'mark'|'pdf-note'|'storage-note';number:string;batch:string;note?:string|null}

async function runPipelineChild(command:string,args:string[],proxy:string,input?:string) {
  return new Promise<{code:number|null;signal:NodeJS.Signals|null;records:Record<string,unknown>[];stderr:string} >((resolve,reject)=>{
    const child=spawn(command,args,{cwd:process.cwd(),windowsHide:true,env:{...repairEnvironment(),PYTHONUTF8:'1',...(proxy?{HTTP_PROXY:proxy,HTTPS_PROXY:proxy}:{})},stdio:['pipe','pipe','pipe']})
    const records:Record<string,unknown>[]=[]
    let stderr=''
    const read=(line:string)=>{try {records.push(JSON.parse(line))} catch {/* Diagnostic output is not a structured result. */}}
    createInterface({input:child.stdout!}).on('line',read)
    createInterface({input:child.stderr!}).on('line',line=>{stderr=(stderr+line+'\n').slice(-12000);read(line)})
    child.once('error',reject)
    child.once('close',(code,signal)=>resolve({code,signal,records,stderr:stderr.trim()}))
    child.stdin!.end(input)
  })
}

export function drawingFailureDetail(result:{code:number|null;signal:NodeJS.Signals|null;records:Record<string,unknown>[];stderr:string}) {
  const structured=result.records.find(record=>typeof record.error==='string' && record.error.trim())?.error
  let detail=typeof structured==='string' ? structured : result.stderr || '子进程没有输出错误信息'
  for(const key of ['DATABASE_URL','CNIPA_PG_PASSWORD','MINIO_ACCESS_KEY','MINIO_SECRET_KEY','CNIPA_OSS_ACCESS_KEY_ID','CNIPA_OSS_ACCESS_KEY_SECRET']) {
    const secret=process.env[key]
    if(secret && secret.length>=4) detail=detail.replaceAll(secret,'[已隐藏]')
  }
  const exit=result.signal ? `终止信号 ${result.signal}` : `退出码 ${result.code ?? '未知'}`
  return `说明书附图更新失败（${exit}）：${detail}`
}

async function snapshotWorkbook(python:string,target:string) {
  const child=spawn(python,[path.resolve('features/historical-import/pdf/repair-finalize.py'),'--list-candidates'],{cwd:process.cwd(),windowsHide:true,env:{...repairEnvironment(),PYTHONUTF8:'1'},stdio:['ignore','pipe','pipe']})
  let errorOutput=''
  child.stderr!.on('data',chunk=>{errorOutput+=String(chunk)})
  const closed=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
  try {
    await Promise.all([streamPipeline(child.stdout!,createWriteStream(target)),closed.then(code=>{
      if(code!==0) {try {throw new Error(JSON.parse(errorOutput).error||'无法读取候选 Excel')} catch(error) {if(error instanceof SyntaxError) throw new Error('无法读取候选 Excel，请检查文件');throw error}}
    })])
  } catch(error) {child.kill();throw error}
}

async function* readPipelineSnapshot(file:string) {
  const stream=createReadStream(file,{encoding:'utf8'})
  const lines=createInterface({input:stream,crlfDelay:Infinity})
  try {for await(const line of lines) if(line.trim()) yield JSON.parse(line) as PipelineItem}
  finally {lines.close();stream.destroy()}
}

export function startContinuousPipeline(input:{delay:number;proxy:string;retry:boolean;concurrency:number}) {
  if(store.task?.status==='running') throw new Error('已有任务正在运行，请等待完成')
  if(!Number.isSafeInteger(input.concurrency)||input.concurrency<1) throw new Error('并行数量需为正整数')
  const settings=getRepairPaths()
  const task:Task={mode:'download',status:'running',limit:0,completed:0,failed:0,message:'正在读取候选名单…',logs:[],startedAt:new Date().toISOString(),excelPending:0,timings:{downloadMs:0,smsMs:0,drawingMs:0,excelMs:0}}
  store.task=task;store.child=null
  const log=(line:string)=>{task.logs.push(line);if(task.logs.length>100) task.logs.shift()}
  const suffix=settings.candidateFile===defaultRepairPaths.candidateFile?'':`-${createHash('sha256').update(settings.candidateFile).digest('hex').slice(0,16)}`
  const pipelineHistory=path.join(root,`pipeline-report${suffix}.jsonl`)
  const excelOutbox=path.join(root,`excel-sync${suffix}.jsonl`)
  const serial=serialQueue(),throttle=serialQueue(),updates=boundedQueue(input.concurrency)
  const python=process.env.PDF_PYTHON || path.resolve('.venv-pdf',process.platform==='win32'?'Scripts/python.exe':'bin/python')
  let lastStart=0,rateLimited=false,serviceUnavailable=false,storageFailures=0
  void (async()=>{
    await mkdir(root,{recursive:true})
    const pending=new Map<string,ExcelAction>()
    try {for(const line of (await readFile(excelOutbox,'utf8')).split('\n').filter(Boolean)) {
      const event=JSON.parse(line) as {action?:ExcelAction;done?:string[]}
      if(event.action) pending.set(event.action.id,event.action)
      for(const id of event.done||[]) pending.delete(id)
    }} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error}
    task.excelPending=pending.size
    let syncBlocked=false
    const enqueue=async(action:Omit<ExcelAction,'id'>)=>{
      const item={...action,id:randomUUID()}
      await appendFile(excelOutbox,JSON.stringify({action:item})+'\n','utf8')
      pending.set(item.id,item);task.excelPending=pending.size
    }
    const flushExcel=async(force=false)=>{
      if(!pending.size || (!force && (pending.size<100 || syncBlocked))) return
      const items=[...pending.values()]
      const started=Date.now()
      task.message=`正在同步 ${items.length} 项 Excel 状态…`
      try {
        const result=await runPipelineChild(process.execPath,['--env-file-if-exists=.env','--experimental-strip-types',path.resolve('features/historical-import/pdf/repair-batch-finalize.ts')],'',JSON.stringify(items))
        if(result.code!==0 || !result.records.some(record=>record.status==='finalized')) throw new Error(String(result.records.find(record=>record.error)?.error||'Excel 同步失败，PDF 已保留'))
        await appendFile(excelOutbox,JSON.stringify({done:items.map(item=>item.id)})+'\n','utf8')
        for(const item of items) pending.delete(item.id)
        task.excelPending=pending.size;syncBlocked=false;task.warning=undefined
        log(`Excel 已同步 ${items.length} 项，已核对的 PDF 已清理`)
      } catch(error) {
        syncBlocked=true;task.warning=error instanceof Error?error.message:String(error)
        log(`Excel 同步失败，待重试 ${pending.size} 项：${task.warning}`)
      } finally {task.timings!.excelMs+=Date.now()-started}
    }
    await flushExcel(true)
    const past=new Map<string,PipelineRecord>()
    try {for(const line of (await readFile(pipelineHistory,'utf8')).split('\n').filter(Boolean)) {const r=JSON.parse(line) as PipelineRecord;past.set(`${r.batch}\0${r.publication_number}`,r)}}
    catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error}
    const history=new Map<string,Report & {batch?:string;pdf?:string}>()
    for(const r of await reports()) history.set(`${(r as Report & {batch?:string}).batch}\0${r.publication_number}`,r)
    const snapshot=path.join(root,'workbook-candidates.jsonl')
    await snapshotWorkbook(python,snapshot)
    const firstBatch=new Map<string,string>(),ambiguous=new Set<string>()
    for await(const item of readPipelineSnapshot(snapshot)) {
      if(task.stopping) break
      if(typeof item.publication_number!=='string'||typeof item.batch!=='string') continue
      const batch=firstBatch.get(item.publication_number)
      if(batch!==undefined && batch!==item.batch) ambiguous.add(item.publication_number)
      else firstBatch.set(item.publication_number,item.batch)
    }
    firstBatch.clear()
    async function* source() {
      const seen=new Set<string>()
      for(const grant of [true,false]) {
        for await(const item of readPipelineSnapshot(snapshot)) {
          if(task.stopping || rateLimited || serviceUnavailable) break
          if(!numberPattern.test(item.publication_number)||typeof item.batch!=='string'||!Array.isArray(item.image_names)||/B\d?$/.test(item.publication_number)!==grant || seen.has(item.publication_number)) continue
          const previous=past.get(`${item.batch}\0${item.publication_number}`),status=previous?.status
          const smsOnly=isSmsOnlyCandidate(item)
          const legacySmsFailure=smsOnly && status==='failed' && !!previous?.error?.includes('附图不全属于重名候选')
          if(status==='completed' || (!smsOnly && item.repair_status==='说明书附图已更新') || (status==='failed' && !input.retry && !legacySmsFailure) || (!status && !input.retry && history.get(`${item.batch}\0${item.publication_number}`)?.status==='failed')) {
            if(!ambiguous.has(item.publication_number)) seen.add(item.publication_number)
            continue
          }
          seen.add(item.publication_number)
          if(ambiguous.has(item.publication_number)) {task.failed++;log(`${item.publication_number}：跨批次存在相同公开号，请核对后处理`);continue}
          yield item
        }
      }
    }
    await runPipeline(source(),input.concurrency,()=>!!task.stopping||rateLimited||serviceUnavailable,async item=>{
      const number=item.publication_number,key=`${item.batch}\0${number}`
      const smsOnly=isSmsOnlyCandidate(item)
      if(smsOnly) {
        try {
          await stat(path.join(root,'sms-updates',number,'completed'))
          await serial(async()=>{await appendFile(pipelineHistory,JSON.stringify({...item,status:'completed'})+'\n','utf8');task.completed++;log(`${number}：正文图片已有完成记录，已跳过说明书附图`)})
          return
        } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error}
      }
      // Check every object to be replaced before any PDF download or extraction.
      // Keep the checked paths for the update phase so it never repeats HEAD.
      const checkedOldKeys=new Set<string>()
      try {
        task.message=`正在检查旧图片是否存在 ${number}…`
        const [smsOriginals,drawingKeys]=await Promise.all([
          getSmsOriginals(number),
          smsOnly?Promise.resolve([] as string[]):getPatentDrawingKeys(number,item.batch),
        ])
        if(smsOriginals.batch!==item.batch) throw new Error('正文图片所属批次与候选名单不一致，请核对')
        const smsKeys=smsOriginals.images.filter(image=>!image.is_abstract).flatMap(image=>[image.oss_key,image.asset_key].filter((key):key is string=>!!key))
        const keys=[...new Set([...drawingKeys,...smsKeys])]
        const missingKeys:string[]=[]
        for(let i=0;i<keys.length;i+=8) {
          if(task.stopping||serviceUnavailable) return
          const group=keys.slice(i,i+8)
          const exists=await Promise.all(group.map(key=>patentImageExists(key)))
          group.forEach((key,index)=>{if(exists[index]) checkedOldKeys.add(key);else missingKeys.push(key)})
        }
        if(missingKeys.length) {
          await serial(async()=>{
            await enqueue({kind:'storage-note',number,batch:item.batch})
            await appendFile(pipelineHistory,JSON.stringify({...item,status:'storage_missing',missing_keys:missingKeys})+'\n','utf8')
            task.failed++;log(`${number}：${missingKeys.length} 张旧图片在对象存储中不存在，已跳过下载、提取和替换，待同步 Excel 备注`)
            await flushExcel()
          })
          return
        }
      } catch(error) {
        const message=error instanceof Error?error.message:String(error)
        const unavailable=/\b503\b|对象存储检查超时/.test(message)
        await serial(async()=>{
          storageFailures=unavailable?storageFailures+1:0
          if(storageFailures>=3) serviceUnavailable=true
          task.failed++;log(`${number}：旧图片存在性检查失败，未下载或提取，${message}`)
          await appendFile(pipelineHistory,JSON.stringify({...item,status:unavailable?'transient_failure':'failed',error:message})+'\n','utf8')
        })
        return
      }
      if(task.stopping||serviceUnavailable) return
      let ready=history.get(key)
      if(!['ready',...(smsOnly?['pdf_ready']:[])].includes(ready?.status||'') || ready?.repair_revision!==4) ready=undefined
      if(smsOnly && ready?.pdf) {try {await stat(ready.pdf)} catch {ready=undefined}}
      if(!smsOnly) {
      if(ready?.pdf && path.resolve(ready.pdf)!==path.join(settings.pdfDirectory,`${number}.pdf`)) ready=undefined
      if(ready?.pdf && ready.manifest) {try {await stat(ready.pdf);await stat(ready.manifest)} catch {ready=undefined}}
      }
      if(!ready?.pdf || (!smsOnly && !ready.manifest)) {
        await throttle(async()=>{
          while(lastStart && !task.stopping && !rateLimited && !serviceUnavailable) {
            const wait=(input.delay-(Date.now()-lastStart)/1000)*1000
            if(wait<=0) break
            await new Promise(resolve=>setTimeout(resolve,Math.min(wait,1000)))
          }
          lastStart=Date.now()
        })
        if(task.stopping||rateLimited||serviceUnavailable) return
        task.message=`正在下载并提取 ${number}…`
        let record:PipelineRecord|undefined
        const downloadStarted=Date.now()
        try {
          const run=await runPipelineChild(python,[path.resolve('features/historical-import/pdf/repair-download.py'),'--single-stdin','--limit','1','--delay',String(input.delay),'--ocr',...(smsOnly?['--pdf-only']:[])],input.proxy,JSON.stringify(item))
          record=run.records.find(r=>r.publication_number===number && (r.status==='ready'||r.status==='pdf_ready'||r.status==='failed')) as PipelineRecord|undefined
          const measured=record as (PipelineRecord & {timings?:{page_ms?:number;probe_ms?:number;transfer_ms?:number;verify_ms?:number;extract_ms?:number;cached_pdf?:boolean;extract_detail?:{headers_ms?:number;regions_ms?:number;render_ms?:number;clean_ms?:number;save_ms?:number}}})|undefined
          if(measured?.timings) {
            const t=measured.timings
            log(`${number}：下载提取耗时（秒）页面 ${((t.page_ms||0)/1000).toFixed(1)}、链接检查 ${((t.probe_ms||0)/1000).toFixed(1)}、PDF 传输 ${((t.transfer_ms||0)/1000).toFixed(1)}、校验 ${((t.verify_ms||0)/1000).toFixed(1)}、提取 ${((t.extract_ms||0)/1000).toFixed(1)}${t.cached_pdf?'（使用已有 PDF）':''}`)
            if(t.extract_detail && Object.keys(t.extract_detail).length) {
              const d=t.extract_detail
              log(`${number}：附图提取明细（秒）页眉 ${((d.headers_ms||0)/1000).toFixed(1)}、区域划分 ${((d.regions_ms||0)/1000).toFixed(1)}、渲染 ${((d.render_ms||0)/1000).toFixed(1)}、图号清理 ${((d.clean_ms||0)/1000).toFixed(1)}、保存 ${((d.save_ms||0)/1000).toFixed(1)}`)
            }
          }
          if(!record) record={publication_number:number,batch:item.batch,status:'failed',error:String(run.records.find(r=>r.error)?.error||'下载程序未返回结果')}
        } catch(error) {record={publication_number:number,batch:item.batch,status:'failed',error:error instanceof Error?error.message:String(error)}}
        finally {task.timings!.downloadMs+=Date.now()-downloadStarted}
        await serial(async()=>{await appendFile(reportPath,JSON.stringify(record)+'\n','utf8')})
        if(record.status!==(smsOnly?'pdf_ready':'ready')) {
          if((record.error||'').includes('429') || (record.error||'').includes('过于频繁')) rateLimited=true
          await serial(async()=>{
            task.failed++;log(`${number}：下载或提取失败，${record.error||'请查看运行记录'}`)
            await appendFile(pipelineHistory,JSON.stringify({...item,status:'failed',error:record.error})+'\n','utf8')
            if(record.error_code==='no_pdf_link') await enqueue({kind:'pdf-note',number,batch:item.batch,note:'Google Patents 未提供 PDF 链接'})
            await flushExcel()
          })
          return
        }
        const old=history.get(key)
        if(old?.error_code==='no_pdf_link' || old?.error==='Google Patents 页面未提供 PDF 下载链接，无法从该来源提取附图' || old?.error===`Could not find a verified PDF download link for patent ${number}`) await serial(()=>enqueue({kind:'pdf-note',number,batch:item.batch,note:null}))
        ready=record as Report & {batch?:string;pdf?:string}
      }
      await updates(async()=>{
        if(task.stopping||serviceUnavailable) return
        try {
          task.message=`正在处理 ${number}…`
          log(smsOnly?`${number}：PDF 已就绪，开始处理正文图片`:`${number}：PDF 和说明书附图已就绪，开始处理`)
          let partialReason=''
          let smsDirectory:string|undefined
          const smsStarted=Date.now()
          try {
          const source=await getSmsReviewSource(number)
          if(source.originalNames.length) {
            if(!await loadSmsManifest(number)) {
              const sms=await runPipelineChild(python,[path.resolve('features/historical-import/pdf/sms-preview.py'),'--pdf',path.join(getRepairPaths().pdfDirectory,`${number}.pdf`),'--publication',number,'--skip-context','--output',path.join(root,'sms-preview',`${number}-${Date.now()}-${randomUUID()}`)],input.proxy)
              if(sms.code!==0 || !sms.records.some(r=>r.status==='sms_ready')) throw new Error(String(sms.records.find(r=>r.error)?.error||'正文图片提取失败'))
              log(`${number}：正文图片已提取`)
            }
            smsDirectory=(await loadSmsManifest(number))?.directory
            let plan:Awaited<ReturnType<typeof smsUpdatePlan>>|undefined
            try {plan=await smsUpdatePlan(number,true)} catch(error) {
              const reason=error instanceof Error?error.message:String(error)
              log(`${number}：正文图片跳过，${reason}`)
              if(!reason.includes('已更新，无需重复更新')) partialReason=reason
            }
            if(plan) {
              const single:Task={mode:'sms-apply',status:'running',number,limit:1,completed:0,failed:0,message:'',logs:[],startedAt:task.startedAt}
              try {
                await runSmsUpdate(number,plan.fingerprint,single,true,checkedOldKeys)
                log(single.logs.join('；'))
                if(single.logs.some(line=>line.includes('完成标记写入失败'))) throw new Error('正文更新完成标记写入失败，请核对')
              } catch(error) {
                partialReason=error instanceof Error?error.message:String(error)
                if((error as NodeJS.ErrnoException).code==='SMS_STORAGE_MISSING' || /\b503\b|对象存储检查超时|提交结果不确定/.test(partialReason)) throw error
                log(`${number}：正文图片待处理，${partialReason}；继续处理说明书附图`)
              }
            }
          } else if(smsOnly) throw new Error('候选名单包含正文图片，但数据库没有 SMS 图片记录，请核对')
          else log(`${number}：数据库没有 SMS 正文图片，已跳过`)
          } finally {task.timings!.smsMs+=Date.now()-smsStarted}
          if(smsOnly) {
            if(partialReason) throw new Error(`正文图片待处理：${partialReason}`)
            await serial(async()=>{await appendFile(pipelineHistory,JSON.stringify({...item,status:'completed'})+'\n','utf8');storageFailures=0;task.completed++;log(`${number}：正文图片处理完成；未更新说明书附图`)})
            const errors=await cleanupCompletedArtifacts(root,number,{smsDirectory,pdfHash:ready?.pdf_hash,pdfDirectory:settings.pdfDirectory})
            if(errors.length) log(`${number}：处理文件清理未完成：${errors.join('；')}`)
            return
          }
          log(`${number}：正在更新说明书附图`)
          const drawingStarted=Date.now()
          const drawing=await runPipelineChild(process.execPath,['--env-file-if-exists=.env','--experimental-strip-types',path.resolve('features/historical-import/pdf/repair-apply.ts'),'--limit','1','--apply','--defer-finalize','--checked-old-keys-stdin','--publication',number],'',JSON.stringify([...checkedOldKeys]))
          task.timings!.drawingMs+=Date.now()-drawingStarted
          if(drawing.records.some(record=>record.error_code==='storage_missing')) {
            await serial(async()=>{
              await enqueue({kind:'storage-note',number,batch:item.batch})
              await appendFile(pipelineHistory,JSON.stringify({...item,status:'storage_missing'})+'\n','utf8')
              task.failed++;log(`${number}：旧附图在对象存储中不存在，已跳过，待同步 Excel 备注`)
              await flushExcel()
            })
            return
          }
          if(drawing.code!==0) throw new Error(drawingFailureDetail(drawing))
          if(!drawing.records.some(r=>r.status==='applied'||r.status==='skipped_applied')) throw new Error('没有找到可更新的说明书附图记录')
          if(partialReason) throw new Error(`说明书附图已更新，正文图片待处理：${partialReason}`)
          await serial(async()=>{
            await enqueue({kind:'mark',number,batch:item.batch})
            await flushExcel()
            await appendFile(pipelineHistory,JSON.stringify({...item,status:'completed'})+'\n','utf8')
            storageFailures=0;task.completed++;log(`${number}：处理完成`)
          })
          const errors=await cleanupCompletedArtifacts(root,number,{manifest:ready?.manifest,smsDirectory})
          if(errors.length) log(`${number}：处理文件清理未完成：${errors.join('；')}`)
        } catch(error) {
          const message=error instanceof Error?error.message:String(error)
          if((error as NodeJS.ErrnoException).code==='SMS_STORAGE_MISSING') {
            await serial(async()=>{
              await enqueue({kind:'storage-note',number,batch:item.batch})
              await appendFile(pipelineHistory,JSON.stringify({...item,status:'storage_missing',error:message})+'\n','utf8')
              task.failed++;log(`${number}：${message}；待同步 Excel 存储备注`)
              await flushExcel()
            })
            return
          }
          const unavailable=/\b503\b|对象存储检查超时/.test(message)
          await serial(async()=>{
            storageFailures=unavailable?storageFailures+1:0
            if(storageFailures>=3) serviceUnavailable=true
            task.failed++;log(`${number}：处理失败，${message}`)
            await appendFile(pipelineHistory,JSON.stringify({...item,status:unavailable?'transient_failure':'failed',error:message})+'\n','utf8')
            await flushExcel()
          })
        }
      })
    })
    await serial(()=>flushExcel(true))
    task.status=task.stopping?'stopped':task.failed||rateLimited||serviceUnavailable||pending.size?'failed':'completed'
    task.message=task.stopping?'已停止，正在处理的专利已结束':serviceUnavailable?'对象存储连续异常，任务已暂停；请检查服务后重新启动':rateLimited?'下载请求过于频繁，任务已停止':pending.size?`图片处理结束，${pending.size} 项 Excel 状态待同步`:`任务结束：成功 ${task.completed}，失败 ${task.failed}`
  })().catch(error=>{task.status='failed';task.message='持续处理异常，请查看运行记录';log(error instanceof Error?error.message:String(error))})
  return task
}

export async function startTask(input: { mode: Mode; number?: string; limit: number; delay: number; proxy: string; retry: boolean; concurrency?:number }) {
  if (store.task?.status === 'running') throw new Error('已有任务正在运行，请等待完成或先停止')
  if (!['preview','download','apply','apply-batch','sms'].includes(input.mode)) throw new Error('任务类型无效')
  if ((input.mode === 'preview' || input.mode === 'apply' || input.mode === 'sms') && (!input.number || !numberPattern.test(input.number))) throw new Error('请输入完整公开号，例如 CN222254999U')
  if (!Number.isInteger(input.limit) || (input.mode!=='download' && (input.limit < 1 || input.limit > 10000)) || (input.mode==='download' && input.limit<0) || !Number.isFinite(input.delay) || input.delay < 0) throw new Error('手动批量数量需为 1 至 10000，间隔需为非负数')
  if (input.proxy && !/^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/.test(input.proxy)) throw new Error('代理请输入本机 HTTP 地址，例如 http://127.0.0.1:7897')
  if(input.mode==='download') return startContinuousPipeline({delay:input.delay,proxy:input.proxy,retry:input.retry,concurrency:input.concurrency??2})
  if(input.mode==='sms') {
    const source=await getSmsReviewSource(input.number!)
    if(!source.originalNames.length) throw new Error('数据库中没有该专利的 SMS 正文图片，无需提取')
    if(getTask()?.status==='running') throw new Error('已有任务正在运行，请等待完成或先停止')
  }
  const isDownload = input.mode === 'preview'
  const isPython = isDownload || input.mode === 'sms'
  const command = isPython ? (process.env.PDF_PYTHON || path.resolve('.venv-pdf', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')) : process.execPath
  const args = input.mode === 'sms'
    ? [path.resolve('features/historical-import/pdf/sms-preview.py'), '--pdf', path.join(getRepairPaths().pdfDirectory,`${input.number}.pdf`), '--publication', input.number!, '--download-if-missing', '--output', path.join(root,'sms-preview',`${input.number}-${Date.now()}-${randomUUID()}`)]
    : isDownload
    ? [path.resolve('features/historical-import/pdf/repair-download.py'), '--limit', String(input.mode === 'preview' ? 1 : input.limit), '--delay', String(input.delay), '--ocr', ...(input.mode === 'preview' ? ['--publication', input.number!] : []), ...(input.retry ? ['--retry-failed'] : [])]
    : ['--env-file-if-exists=.env', '--experimental-strip-types', path.resolve('features/historical-import/pdf/repair-apply.ts'), '--limit', String(input.mode === 'apply' ? 1 : input.limit), '--apply', ...(input.mode === 'apply' ? ['--publication', input.number!] : [])]
  const task: Task = { mode: input.mode, status:'running', number: input.number, limit: input.mode === 'preview' || input.mode === 'apply' || input.mode === 'sms' ? 1 : input.limit, completed:0, failed:0, message:'正在启动…', logs:[], startedAt:new Date().toISOString() }
  store.task = task
  const child = spawn(command, args, { cwd: process.cwd(), windowsHide:true, env: { ...repairEnvironment(), PYTHONUTF8:'1', ...(isPython && input.proxy ? {HTTP_PROXY:input.proxy, HTTPS_PROXY:input.proxy} : {}) }, stdio:['ignore','pipe','pipe'] })
  store.child = child
  let finished = false
  const readyNumbers = new Set<string>()
  const done = (status: Task['status'], message: string) => { if (finished) return; finished = true; task.status=status; task.message=message; store.child=null }
  const processLine = (line: string) => {
    try {
      const r = JSON.parse(line) as { status?:string; publication_number?:string; number?:string; error?:string; removed?:number; retained?:number; count?:number; oversized?:number; reused?:number; candidates?:number; needs_review?:number }
      if (r.status === 'failed') { task.failed++; task.logs.push(`${r.publication_number || r.number || '专利'}：处理失败${r.error ? `，${r.error}` : ''}`) }
      else if (r.status === 'ready' || r.status === 'applied') { task.completed++; if(r.status==='ready' && r.publication_number) readyNumbers.add(r.publication_number); task.logs.push(`${r.publication_number || r.number || '专利'}：${r.status === 'ready' ? '已提取说明书附图' : '已更新'}${r.reused ? `，${r.reused} 张复用摘要图` : ''}${r.oversized ? `，${r.oversized} 张超过 40 KB` : ''}`) }
      else if (r.status === 'already_applied') task.logs.push(`${r.number}：已更新`)
      else if (r.status === 'sms_ready') { task.completed++; task.logs.push(`${r.publication_number}：已提取 ${r.candidates ?? 0} 个正文图片候选${r.needs_review ? `，${r.needs_review} 个需人工检查` : ''}`) }
      else if (r.status === 'skipped_applied') task.logs.push(`已跳过 ${r.count ?? 0} 项已更新专利`)
      else if (r.status === 'notes_updated') task.logs.push(`已更新 ${r.count ?? 0} 项 PDF 下载备注`)
      else if (r.status === 'notes_failed') { task.warning = r.error || 'Excel 下载备注未写入'; task.logs.push(task.warning) }
      else if (r.status === 'finalized') task.logs.push('已更新 Excel 状态并清理已处理 PDF')
      else if (r.status === 'old_images_cleaned') task.logs.push(`${r.number}：已清理 ${r.removed ?? 0} 张旧附图${r.retained ? `，${r.retained} 张仍被引用，已保留` : ''}`)
      else if (r.status === 'finalize_failed') { task.warning = r.error || 'Excel 标记或 PDF 清理失败'; task.logs.push(task.warning) }
      task.message = task.warning || `已完成 ${task.completed}，失败 ${task.failed}`
    } catch { if (line.includes('429')) task.message='请求过于频繁，任务已停止'; else if (line.includes('没有需要处理') || line.includes('没有符合条件')) task.message=line }
    if (task.logs.length > 50) task.logs.shift()
  }
  createInterface({ input: child.stdout! }).on('line', processLine)
  createInterface({ input: child.stderr! }).on('line', line => { if (line.startsWith('{')) processLine(line) })
  child.once('error', () => done('failed', '无法启动任务，请检查 Python 环境和依赖'))
  child.once('close', async code => {
    if(finished) return
    store.child=null
    if (task.stopping) done('stopped','任务已停止，已完成结果仍保留')
    else if (code !== 0 && !(isDownload && readyNumbers.size)) done('failed', task.warning ? isDownload ? task.warning : `附图更新后未完成清理：${task.warning}` : task.message.includes('429') || task.message.includes('频繁') ? task.message : `任务结束，失败 ${task.failed} 项，请查看运行记录`)
    else {
      if (task.mode === 'preview' && !task.completed && task.number) {
        try {
          if (await preview(task.number)) { task.completed=1;readyNumbers.add(task.number);task.logs.push(`${task.number}：已读取现有说明书附图`) }
          else {done('failed','名单中没有可预览结果，请核对公开号或重新下载');return}
        } catch {done('failed','预览结果无效，请重新提取');return}
      }
      if(isDownload && readyNumbers.size) {
        task.message='正在提取正文图片…'
        let updateInterrupted=false
        await runCombinedSms([...readyNumbers],{
          stopped:()=>!!task.stopping || updateInterrupted,
          hasSms:async number=>(await getSmsReviewSource(number)).originalNames.length>0,
          failed:()=>{task.completed=Math.max(0,task.completed-1);task.failed++},
          log:message=>{task.logs.push(message);if(task.logs.length>50) task.logs.shift()},
          afterExtract:async number=>{
            if(task.mode!=='download' || task.stopping) return
            let plan:Awaited<ReturnType<typeof smsUpdatePlan>>
            try {plan=await smsUpdatePlan(number,true)}
            catch(error) {task.logs.push(`${number}：跳过正文自动更新，${error instanceof Error?error.message:String(error)}`);return}
            const single:Task={mode:'sms-apply',status:'running',number,limit:1,completed:0,failed:0,message:'',logs:[],startedAt:task.startedAt}
            try {
              task.message=`正在自动更新 ${number} 的正文图片…`
              await runSmsUpdate(number,plan.fingerprint,single,true)
              task.logs.push(...single.logs)
              if(single.logs.some(line=>line.includes('完成标记写入失败'))) {updateInterrupted=true;task.failed++;task.completed=Math.max(0,task.completed-1)}
            } catch(error) {
              updateInterrupted=true;task.failed++;task.completed=Math.max(0,task.completed-1)
              task.logs.push(`${number}：正文自动更新中断，${error instanceof Error?error.message:String(error)}；请检查后重试`)
            }
          },
          extract:number=>new Promise((resolve,reject)=>{
            if(task.mode==='download') {
              // Continuous runs do not replace an existing review snapshot.
              void loadSmsManifest(number).then(existing=>{
                if(existing) {resolve('已有正文候选，已保留核对结果');return}
                launch()
              }).catch(reject)
            } else launch()
            function launch() {
              if(task.stopping) {resolve('已停止');return}
              const smsArgs=[path.resolve('features/historical-import/pdf/sms-preview.py'),'--pdf',path.join(getRepairPaths().pdfDirectory,`${number}.pdf`),'--publication',number,'--download-if-missing','--output',path.join(root,'sms-preview',`${number}-${Date.now()}-${randomUUID()}`)]
              const sms=spawn(command,smsArgs,{cwd:process.cwd(),windowsHide:true,env:{...repairEnvironment(),PYTHONUTF8:'1',...(input.proxy?{HTTP_PROXY:input.proxy,HTTPS_PROXY:input.proxy}:{})},stdio:['ignore','pipe','pipe']})
              store.child=sms
              let result='',detail='',settled=false
              createInterface({input:sms.stdout!}).on('line',line=>{try {const parsed=JSON.parse(line);if(parsed.status==='sms_ready') result=`已提取 ${parsed.candidates ?? 0} 个正文图片候选${parsed.needs_review ? `，${parsed.needs_review} 个需人工检查` : ''}`} catch {/* Ignore non-JSON output. */}})
              createInterface({input:sms.stderr!}).on('line',line=>{try {const parsed=JSON.parse(line);if(parsed.error) detail=String(parsed.error)} catch {/* Ignore diagnostic text. */}})
              sms.once('error',error=>{if(!settled){settled=true;reject(error)}})
              sms.once('close',exitCode=>{if(settled)return;settled=true;store.child=null;if(exitCode!==0) reject(new Error(detail||'请检查 PDF 和提取环境'));else if(!result) reject(new Error('未生成正文图片提取结果'));else resolve(result)})
            }
          }),
        })
      }
      if(task.stopping) done('stopped','任务已停止，已完成结果仍保留')
      else if(task.failed || code!==0) done('failed',`任务结束：成功 ${task.completed}，失败 ${task.failed}，请查看运行记录`)
      else done('completed', task.completed ? `任务完成：成功 ${task.completed}，失败 0` : task.message.includes('没有') ? task.message : '任务已结束')
    }
  })
  return task
}
