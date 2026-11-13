import { createHash } from 'node:crypto'

export type SmsContext = {name:string;contexts:{section:string;before:string;after:string}[]}

/** Preserve source-section order and collect each occurrence of an SMS marker. */
export function extractSmsContexts(description:unknown) {
  const values:SmsContext[]=[]
  const byName=new Map<string,SmsContext>()
  const visit=(value:unknown,section:string) => {
    if(typeof value==='string') {
      const pattern=/\[\[PATENT_IMAGE:(SMS_[1-9]\d*\.JPG)\]\]/gi
      const matches=[...value.matchAll(pattern)]
      for(const match of matches) {
        const name=match[1].toUpperCase()
        let item=byName.get(name)
        if(!item) {item={name,contexts:[]};byName.set(name,item);values.push(item)}
        const position=match.index!
        const clean=(text:string)=>text.replace(/\[\[PATENT_IMAGE:SMS_[1-9]\d*\.JPG\]\]/gi,'[相邻图片]').replace(/<[^>]*>/g,'').trim()
        item.contexts.push({section,before:clean(value.slice(Math.max(0,position-180),position)),after:clean(value.slice(position+match[0].length,position+match[0].length+180))})
      }
    } else if(Array.isArray(value)) value.forEach(item=>visit(item,section))
    else if(value && typeof value==='object') for(const [key,item] of Object.entries(value)) visit(item,section ? `${section} / ${key}` : key)
  }
  visit(description,'')
  return {references:values,descriptionHash:createHash('sha256').update(JSON.stringify(description) || '').digest('hex')}
}
