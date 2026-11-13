import { createHash } from 'node:crypto'
import sharp from 'sharp'

const TARGET_BYTES = 40_000

/** Check global distortion and loss of dark strokes, including small local areas. */
export function preservesDrawingDetail(reference:Buffer, candidate:Buffer, width:number, height:number) {
  if(reference.length!==width*height*3 || candidate.length!==reference.length) return false
  const cols=Math.ceil(width/128),rows=Math.ceil(height/128)
  const dark=new Uint32Array(cols*rows),lost=new Uint32Array(cols*rows)
  let squared=0,ink=0,missing=0,white=0,artifacts=0
  for(let pixel=0;pixel<width*height;pixel++) {
    const i=pixel*3
    for(let c=0;c<3;c++) {const d=reference[i+c]-candidate[i+c];squared+=d*d}
    const before=(reference[i]*77+reference[i+1]*150+reference[i+2]*29)>>8
    const after=(candidate[i]*77+candidate[i+1]*150+candidate[i+2]*29)>>8
    if(before<128) {
      ink++
      const tile=Math.floor(pixel/width/128)*cols+Math.floor((pixel%width)/128)
      dark[tile]++
      if(after>=160) {missing++;lost[tile]++}
    }
    if(before>245) {white++;if(after<224) artifacts++}
  }
  const mse=squared/reference.length
  if(mse>0 && 10*Math.log10(65025/mse)<28) return false
  if(ink && missing/ink>0.01) return false
  if(white && artifacts/white>0.005) return false
  for(let i=0;i<dark.length;i++) if(dark[i]>=12 && lost[i]>Math.max(2,dark[i]*0.08)) return false
  return true
}

/** Search JPEG qualities and retain the smallest candidate passing detail checks. */
export async function encodeRepairJpeg(source: Buffer) {
  const metadata = await sharp(source).metadata()
  if(!metadata.width || !metadata.height) throw new Error('无法读取图片尺寸')
  const reference=await sharp(source).flatten({ background:'#ffffff' }).toColourspace('srgb').removeAlpha().raw().toBuffer()
  let selected: {content:Buffer;quality:number}|undefined
  let neutral=true
  for(let i=0;i<reference.length;i+=3) if(reference[i]!==reference[i+1] || reference[i]!==reference[i+2]) {neutral=false;break}
  const variants:Buffer[]=[]
  if(neutral) {
    const gray=Buffer.allocUnsafe(metadata.width*metadata.height)
    for(let i=0;i<gray.length;i++) gray[i]=reference[i*3]
    for(const cutoff of [256,245,235]) {
      const input=Buffer.from(gray)
      if(cutoff<256) for(let i=0;i<input.length;i++) if(input[i]>=cutoff) input[i]=255
      variants.push(input)
    }
  }
  for(const variant of neutral ? variants : [source]) {
    let low=1,high=100
    while(low<=high) {
      const quality=Math.floor((low+high)/2)
      const encoder = neutral
        ? sharp(variant,{raw:{width:metadata.width,height:metadata.height,channels:1}})
        : sharp(variant).flatten({ background: '#ffffff' })
      const content = await encoder.jpeg({ quality, chromaSubsampling:'4:4:4', mozjpeg:true }).toBuffer()
      const pixels=await sharp(content).toColourspace('srgb').removeAlpha().raw().toBuffer()
      if (preservesDrawingDetail(reference,pixels,metadata.width,metadata.height)) {
        if (!selected || content.length < selected.content.length || (content.length===selected.content.length && quality<selected.quality)) selected={content,quality}
        high=quality-1
      } else low=quality+1
    }
  }
  if(!selected) throw new Error('JPEG 压缩后的细节校验未通过，请人工检查图片')
  const {content,quality}=selected!
  return { content, quality, targetReached:content.length<=TARGET_BYTES, hash: createHash('sha256').update(content).digest('hex') }
}
