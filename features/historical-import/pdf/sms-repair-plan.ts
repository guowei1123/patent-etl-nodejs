/** Validate a proposed SMS replacement before any storage or database changes. */
export type SmsOriginal = {id:string;file_name:string;oss_key:string;asset_id:string;is_abstract:boolean;image_role:string}
export type SmsCandidate = {file_name:string;sha256?:string;status?:string}

export function planSmsReplacement(originals:SmsOriginal[], candidates:SmsCandidate[], mapping?:Map<string,number>) {
  if (!originals.length || !candidates.length) throw new Error('没有可核对的 SMS 图片')
  const rows=new Map<string,SmsOriginal>()
  for (const row of originals) {
    const name=row.file_name.toUpperCase()
    if (!/^SMS_[1-9]\d*\.JPG$/.test(name) || row.is_abstract || !row.id || !row.asset_id || !row.oss_key) throw new Error('旧图范围或关联无效，不能更新')
    if(rows.has(name)) throw new Error(`旧图存在重复关联：${name}`)
    rows.set(name,row)
  }
  if(candidates.length<rows.size) throw new Error(`候选数量不足，仍有 ${rows.size-candidates.length} 张旧图未匹配`)
  if(candidates.length>rows.size) throw new Error('候选数量与旧图数量不一致')
  const used=new Set<number>()
  const names=[...rows.keys()].sort((a,b)=>Number(a.match(/\d+/)![0])-Number(b.match(/\d+/)![0]))
  const result=names.map(name=>{
    const index=mapping ? mapping.get(name) : Number(name.match(/\d+/)![0])-1
    if(index===undefined || !Number.isInteger(index) || index<0 || index>=candidates.length) throw new Error(`缺少已确认的候选：${name}`)
    if(used.has(index)) throw new Error(`候选图片被重复使用：${index+1}`)
    used.add(index)
    const candidate=candidates[index]
    if(candidate.file_name!==`SMS_${index+1}.JPG` || !/^[a-f0-9]{64}$/.test(candidate.sha256||'') || candidate.status==='needs_review') throw new Error(`候选图片无效：${index+1}`)
    return {name,original:rows.get(name)!,candidate,index}
  })
  if(result.length!==candidates.length) throw new Error('候选数量与旧图数量不一致')
  return {images:result,oldKeys:[...new Set(result.map(item=>item.original.oss_key))].sort()}
}
