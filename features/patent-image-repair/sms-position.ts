type Context = {before:string;after:string}
export type PositionCandidate = {name:string;page:number;context?:Context|null}
type Proposal = {name:string;page:number;before:string;after:string}
const markerPattern=/\[\[PATENT_IMAGE:(SMS_[1-9]\d*\.JPG)\]\]/gi

/** Match both PDF text anchors uniquely within the same original text field. */
export function planSmsPositions(description:unknown,candidates:PositionCandidate[]) {
  const result=structuredClone(description)
  const leaves:{path:(string|number)[];value:string}[]=[]
  function visit(value:unknown,path:(string|number)[]) {
    if(typeof value==='string') leaves.push({path,value})
    else if(Array.isArray(value)) value.forEach((item,index)=>visit(item,[...path,index]))
    else if(value && typeof value==='object') for(const [key,item] of Object.entries(value)) visit(item,[...path,key])
  }
  visit(result,[])
  const proposed:Proposal[]=[]
  const unresolved:{name:string;reason:string}[]=[]
  const edits=new Map<number,{start:number;end:number;text:string}[]>()
  const occupied=new Set<string>()
  for(const candidate of candidates) {
    const occurrences=leaves.flatMap((leaf,index)=>[...leaf.value.matchAll(markerPattern)].filter(m=>m[1].toUpperCase()===candidate.name).map(m=>({leaf:index,index:m.index!,length:m[0].length,marker:m[0]})))
    if(occurrences.length!==1 || !candidate.context) {unresolved.push({name:candidate.name,reason:'标记数量不是一处，或 PDF 缺少两侧文字'});continue}
    const normalize=(text:string)=>text.replace(/\s/g,'')
    const before=normalize(candidate.context.before).slice(-12),after=normalize(candidate.context.after).slice(0,12)
    if(before.length<4 || after.length<4) {unresolved.push({name:candidate.name,reason:'PDF 两侧文字不足'});continue}
    if(candidates.filter(other=>other.context && normalize(other.context.before).slice(-12)===before && normalize(other.context.after).slice(0,12)===after).length>1) {unresolved.push({name:candidate.name,reason:'多个图片具有相同文字位置'});continue}
    const matches:{leaf:number;position:number}[]=[]
    leaves.forEach((leaf,index)=>{
      const pattern=new RegExp(markerPattern.source,'gi')
      const ranges=[...leaf.value.matchAll(pattern)].map(m=>[m.index!,m.index!+m[0].length])
      let normalized=''
      const positions:number[]=[]
      for(let i=0;i<leaf.value.length;i++) {
        if(ranges.some(([start,end])=>i>=start && i<end) || /\s/.test(leaf.value[i])) continue
        normalized+=leaf.value[i];positions.push(i)
      }
      const needle=before+after
      let offset=normalized.indexOf(needle)
      while(offset!==-1) {matches.push({leaf:index,position:positions[offset+before.length]});offset=normalized.indexOf(needle,offset+1)}
    })
    const occurrence=occurrences[0]
    if(matches.length!==1 || matches[0].leaf!==occurrence.leaf) {unresolved.push({name:candidate.name,reason:'正文位置不唯一或不在原章节'});continue}
    const target=matches[0],key=`${target.leaf}:${target.position}`
    if(occurrence.index+occurrence.length<=target.position && !leaves[target.leaf].value.slice(occurrence.index+occurrence.length,target.position).trim()) {unresolved.push({name:candidate.name,reason:'标记已在对应位置'});continue}
    if(occupied.has(key)) {unresolved.push({name:candidate.name,reason:'多个图片指向同一位置'});continue}
    occupied.add(key)
    const list=edits.get(target.leaf)||[]
    list.push({start:occurrence.index,end:occurrence.index+occurrence.length,text:''},{start:target.position,end:target.position,text:occurrence.marker})
    edits.set(target.leaf,list)
    proposed.push({name:candidate.name,page:candidate.page,before,after})
  }
  for(const [index,changes] of edits) {
    const leaf=leaves[index]
    let value=leaf.value
    for(const edit of changes.sort((a,b)=>b.start-a.start || b.end-a.end)) value=value.slice(0,edit.start)+edit.text+value.slice(edit.end)
    let parent=result as Record<string|number,unknown>
    for(const key of leaf.path.slice(0,-1)) parent=parent[key] as Record<string|number,unknown>
    if(leaf.path.length) parent[leaf.path.at(-1)!]=value
  }
  return {description:result,proposed,unresolved}
}
