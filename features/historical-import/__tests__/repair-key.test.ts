import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { legacyRepairImageKey, repairImageKey } from '../pdf/repair-key'
import { encodeRepairJpeg, preservesDrawingDetail } from '../pdf/repair-jpeg'

describe('修复图片存储路径', () => {
  it('使用原批次、专利号和简短的附图文件名', () => {
    const hash='a'.repeat(64)
    expect(repairImageKey('CN-PA-TXTS-10-B-20231212','CN116661005B',hash,1)).toBe('patents/CN-PA-TXTS-10-B-20231212/116661005/FT_1.jpg')
    expect(repairImageKey('CN-PA-TXTS-10-B-20231212','CN116661005B',hash,2)).toBe('patents/CN-PA-TXTS-10-B-20231212/116661005/FT_2.jpg')
    expect(repairImageKey('batch2','CN116661005B',hash,1)).not.toBe(repairImageKey('batch1','CN116661005B',hash,1))
  })
  it('仍可识别此前带哈希的图片路径', () => {
    const hash='a'.repeat(64)
    expect(legacyRepairImageKey('batch','CN116661005B',hash,1)).toBe(`patents/batch/116661005/FT_1-B-${hash}.png`)
  })
  it('拒绝无效的图片哈希', () => {
    expect(()=>repairImageKey('batch','CN116661005B','bad',1)).toThrow()
  })
  it('将预览 PNG 转换为真正的 JPEG，并对转换后的内容计算哈希', async () => {
    const png = await sharp({create:{width:20,height:10,channels:4,background:{r:255,g:255,b:255,alpha:0}}}).png().toBuffer()
    const jpeg = await encodeRepairJpeg(png)
    const meta = await sharp(jpeg.content).metadata()
    expect(meta.format).toBe('jpeg')
    expect([meta.width,meta.height]).toEqual([20,10])
    expect(jpeg.hash).toBe(createHash('sha256').update(jpeg.content).digest('hex'))
  })
  it('保持像素尺寸并根据细节检查选择压缩质量', async () => {
    const raw=Buffer.alloc(600*600)
    let seed=123
    for(let i=0;i<raw.length;i++) { seed=(seed*1664525+1013904223)>>>0; raw[i]=seed>>>24 }
    const png=await sharp(raw,{raw:{width:600,height:600,channels:1}}).png().toBuffer()
    const optimized=await encodeRepairJpeg(png)
    const meta=await sharp(optimized.content).metadata()
    expect([meta.width,meta.height]).toEqual([600,600])
    expect(optimized.quality).toBeGreaterThanOrEqual(1)
    expect(optimized.targetReached).toBe(optimized.content.length<=40_000)
  })
  it('简单图片可以使用低质量，缺失线条会被细节检查拒绝', async () => {
    const png=await sharp({create:{width:32,height:32,channels:3,background:'#ffffff'}}).png().toBuffer()
    const optimized=await encodeRepairJpeg(png)
    expect(optimized.quality).toBe(1)
    const before=Buffer.alloc(32*32*3,255),after=Buffer.from(before)
    before.fill(0,0,12*3)
    expect(preservesDrawingDetail(before,after,32,32)).toBe(false)
  })
})
