import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'

export type RepairPaths = { candidateFile:string; pdfDirectory:string }
const directory=path.resolve('data/patent-image-repair')
const settingsFile=path.join(directory,'settings.json')
export const defaultRepairPaths:RepairPaths={
  candidateFile:path.resolve('outputs/repeated-image-audit/重名图片专利公开号.xlsx'),
  pdfDirectory:path.join(directory,'pdf'),
}

export function getRepairPaths():RepairPaths {
  try {
    const saved=JSON.parse(readFileSync(settingsFile,'utf8')) as RepairPaths
    if(!path.isAbsolute(saved.candidateFile)||!path.isAbsolute(saved.pdfDirectory)) throw new Error('附图修复路径配置无效')
    return saved
  } catch(error) {
    if((error as NodeJS.ErrnoException).code==='ENOENT') return {...defaultRepairPaths}
    throw error
  }
}

export function saveRepairPaths(input:RepairPaths):RepairPaths {
  const candidateFile=path.resolve(input.candidateFile.trim())
  const pdfDirectory=path.resolve(input.pdfDirectory.trim())
  if(!input.candidateFile.trim()||!input.pdfDirectory.trim()) throw new Error('请填写候选 Excel 路径和 PDF 目录')
  if(path.extname(candidateFile).toLowerCase()!=='.xlsx') throw new Error('候选名单请选择 .xlsx 文件')
  if(!statSync(candidateFile).isFile()) throw new Error('候选 Excel 路径不是文件')
  mkdirSync(pdfDirectory,{recursive:true})
  mkdirSync(directory,{recursive:true})
  const settings={candidateFile,pdfDirectory}
  writeFileSync(settingsFile,JSON.stringify(settings,null,2),'utf8')
  return settings
}

export function repairEnvironment() {
  const settings=getRepairPaths()
  return {...process.env,REPAIR_WORKBOOK:settings.candidateFile,REPAIR_PDF_DIR:settings.pdfDirectory}
}
