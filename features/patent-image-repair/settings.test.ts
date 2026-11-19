import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'

const state=vi.hoisted(()=>({saved:undefined as string|undefined}))
vi.mock('node:fs',()=>({
  readFileSync:vi.fn(()=>{if(state.saved===undefined) throw Object.assign(new Error('missing'),{code:'ENOENT'});return state.saved}),
  writeFileSync:vi.fn((_file:string,value:string)=>{state.saved=value}),
  mkdirSync:vi.fn(),
  statSync:vi.fn(()=>({isFile:()=>true})),
}))
import { defaultRepairPaths, getRepairPaths, saveRepairPaths, repairEnvironment } from './settings'

describe('附图修复路径设置',()=>{
  beforeEach(()=>{state.saved=undefined})
  it('首次使用默认路径',()=>{
    expect(getRepairPaths()).toEqual(defaultRepairPaths)
  })
  it('保存并传递自定义 Excel 和 PDF 路径给子进程',()=>{
    const saved=saveRepairPaths({candidateFile:'custom/候选.xlsx',pdfDirectory:'custom/PDF'})
    expect(saved).toEqual({candidateFile:path.resolve('custom/候选.xlsx'),pdfDirectory:path.resolve('custom/PDF')})
    expect(getRepairPaths()).toEqual(saved)
    expect(repairEnvironment()).toMatchObject({REPAIR_WORKBOOK:saved.candidateFile,REPAIR_PDF_DIR:saved.pdfDirectory})
  })
  it('拒绝空路径和不支持的名单格式',()=>{
    expect(()=>saveRepairPaths({candidateFile:'',pdfDirectory:'pdf'})).toThrow('请填写')
    expect(()=>saveRepairPaths({candidateFile:'list.jsonl',pdfDirectory:'pdf'})).toThrow('.xlsx')
  })
})
