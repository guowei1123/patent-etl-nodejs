import { XMLParser } from 'fast-xml-parser'
import * as fs from 'fs'
import type { ParsedPatent, PatentType } from '@/types'

// 配置 XML 解析器
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: true,
  trimValues: true,
  parseTagValue: true,
  isArray: (name) => {
    // 这些标签可能出现多次，需要作为数组处理
    return ['ipc', 'applicant', 'inventor', 'agent', 'priority'].includes(
      name.toLowerCase(),
    )
  },
})

// 安全获取嵌套属性
function getNestedValue(obj: unknown, ...keys: string[]): unknown {
  let current = obj
  for (const key of keys) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== 'object'
    ) {
      return undefined
    }
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

// 提取文本内容
function extractText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return value.trim() || undefined
  if (typeof value === 'number') return String(value)
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if ('#text' in obj) return extractText(obj['#text'])
    // 递归提取所有文本
    const texts: string[] = []
    for (const v of Object.values(obj)) {
      const text = extractText(v)
      if (text) texts.push(text)
    }
    return texts.length > 0 ? texts.join(' ') : undefined
  }
  return undefined
}

// 提取数组文本
function extractArrayText(value: unknown): string | undefined {
  if (!value) return undefined
  const arr = Array.isArray(value) ? value : [value]
  const texts = arr.map((v) => extractText(v)).filter(Boolean)
  return texts.length > 0 ? texts.join('; ') : undefined
}

// 提取 IPC 分类号
function extractIpcCodes(value: unknown): string[] | undefined {
  if (!value) return undefined
  const arr = Array.isArray(value) ? value : [value]
  const codes: string[] = []

  for (const item of arr) {
    if (typeof item === 'string') {
      codes.push(item.trim())
    } else if (typeof item === 'object' && item !== null) {
      const obj = item as Record<string, unknown>
      // 常见的 IPC 格式
      const code =
        obj['@_code'] ||
        obj['@_ipc-code'] ||
        obj['#text'] ||
        obj['main-classification'] ||
        obj['classification']
      if (code) codes.push(String(code).trim())
    }
  }

  return codes.length > 0 ? codes : undefined
}

// 格式化日期
function formatDate(value: unknown): string | undefined {
  if (!value) return undefined

  const str = String(value).replace(/[^0-9]/g, '')

  // YYYYMMDD 格式
  if (str.length === 8) {
    return `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`
  }

  // YYYY-MM-DD 格式已经正确
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    return String(value)
  }

  return undefined
}

// 解析单个专利 XML
export function parsePatentXml(
  xmlContent: string,
  patentType: PatentType,
  includeRawXml: boolean = false,
): ParsedPatent | null {
  try {
    const doc = parser.parse(xmlContent)

    // 尝试多种可能的根元素路径
    const root =
      doc['cn-patent-document'] ||
      doc['patent-document'] ||
      doc['cn-utility-model'] ||
      doc['utility-model-document'] ||
      doc

    // 提取专利号
    const patentNumber =
      getNestedValue(root, '@_doc-number') ||
      getNestedValue(
        root,
        'bibliographic-data',
        'publication-reference',
        'document-id',
        'doc-number',
      ) ||
      getNestedValue(
        root,
        'bibliographic-data',
        'application-reference',
        'document-id',
        'doc-number',
      ) ||
      getNestedValue(root, 'publication-number') ||
      getNestedValue(root, 'application-number')

    if (!patentNumber) {
      return null
    }

    // 提取标题
    const title =
      extractText(
        getNestedValue(root, 'bibliographic-data', 'invention-title'),
      ) ||
      extractText(getNestedValue(root, 'invention-title')) ||
      extractText(getNestedValue(root, 'title')) ||
      '未知标题'

    // 提取摘要
    const abstractContent =
      extractText(getNestedValue(root, 'abstract')) ||
      extractText(getNestedValue(root, 'bibliographic-data', 'abstract'))

    // 提取权利要求
    const claims =
      extractText(getNestedValue(root, 'claims')) ||
      extractText(getNestedValue(root, 'claim'))

    // 提取申请人
    const applicantData =
      getNestedValue(
        root,
        'bibliographic-data',
        'parties',
        'applicants',
        'applicant',
      ) ||
      getNestedValue(root, 'bibliographic-data', 'applicant') ||
      getNestedValue(root, 'applicant')
    const applicant = extractArrayText(applicantData)

    // 提取发明人
    const inventorData =
      getNestedValue(
        root,
        'bibliographic-data',
        'parties',
        'inventors',
        'inventor',
      ) ||
      getNestedValue(root, 'bibliographic-data', 'inventor') ||
      getNestedValue(root, 'inventor')
    const inventor = extractArrayText(inventorData)

    // 提取申请信息
    const appRef = getNestedValue(
      root,
      'bibliographic-data',
      'application-reference',
      'document-id',
    )
    const applicationNumber =
      extractText(getNestedValue(appRef, 'doc-number')) ||
      extractText(getNestedValue(root, 'application-number'))
    const applicationDate =
      formatDate(getNestedValue(appRef, 'date')) ||
      formatDate(getNestedValue(root, 'application-date'))

    // 提取公开信息
    const pubRef = getNestedValue(
      root,
      'bibliographic-data',
      'publication-reference',
      'document-id',
    )
    const publicationNumber =
      extractText(getNestedValue(pubRef, 'doc-number')) ||
      extractText(getNestedValue(root, 'publication-number'))
    const publicationDate =
      formatDate(getNestedValue(pubRef, 'date')) ||
      formatDate(getNestedValue(root, 'publication-date'))

    // 提取授权信息
    const grantRef = getNestedValue(
      root,
      'bibliographic-data',
      'grant-reference',
      'document-id',
    )
    const grantNumber =
      extractText(getNestedValue(grantRef, 'doc-number')) ||
      extractText(getNestedValue(root, 'grant-number')) ||
      String(patentNumber)
    const grantDate =
      formatDate(getNestedValue(grantRef, 'date')) ||
      formatDate(getNestedValue(root, 'grant-date')) ||
      formatDate(getNestedValue(root, '@_date-publ'))

    // 提取 IPC 分类
    const ipcData =
      getNestedValue(
        root,
        'bibliographic-data',
        'classification-ipc',
        'main-classification',
      ) ||
      getNestedValue(
        root,
        'bibliographic-data',
        'classifications-ipcr',
        'classification-ipcr',
      ) ||
      getNestedValue(root, 'ipc-codes') ||
      getNestedValue(root, 'ipc')
    const ipcCodes = extractIpcCodes(ipcData)

    // 提取代理信息
    const agentData = getNestedValue(
      root,
      'bibliographic-data',
      'parties',
      'agents',
      'agent',
    )
    const agencyData = getNestedValue(
      root,
      'bibliographic-data',
      'agents',
      'agent',
      'agency',
    )
    const agency =
      extractText(agencyData) || extractText(getNestedValue(root, 'agency'))
    const agent =
      extractArrayText(agentData) || extractText(getNestedValue(root, 'agent'))

    // 提取优先权信息
    const priorityData = getNestedValue(
      root,
      'bibliographic-data',
      'priority-claims',
      'priority-claim',
    )
    let priorityInfo: Record<string, unknown> | undefined
    if (priorityData) {
      priorityInfo = Array.isArray(priorityData)
        ? { claims: priorityData }
        : { claims: [priorityData] }
    }

    return {
      patent_number: String(patentNumber).trim(),
      patent_type: patentType,
      title: String(title).trim(),
      abstract: abstractContent,
      claims,
      applicant,
      inventor,
      application_number: applicationNumber,
      application_date: applicationDate,
      publication_number: publicationNumber,
      publication_date: publicationDate,
      grant_number: grantNumber,
      grant_date: grantDate,
      ipc_codes: ipcCodes,
      agency,
      agent,
      priority_info: priorityInfo,
      raw_xml: includeRawXml ? xmlContent : undefined,
    }
  } catch (error) {
    console.error('XML解析错误:', error)
    return null
  }
}

// 从文件解析专利
export async function parsePatentFile(
  filePath: string,
  patentType: PatentType,
  includeRawXml: boolean = false,
): Promise<ParsedPatent | null> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    return parsePatentXml(content, patentType, includeRawXml)
  } catch (error) {
    console.error(`读取文件失败 ${filePath}:`, error)
    return null
  }
}

// 批量解析专利文件
export async function parsePatentFiles(
  filePaths: string[],
  patentType: PatentType,
  includeRawXml: boolean = false,
  onProgress?: (current: number, total: number, fileName: string) => void,
): Promise<ParsedPatent[]> {
  const patents: ParsedPatent[] = []

  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i]

    if (onProgress) {
      onProgress(i + 1, filePaths.length, filePath.split('/').pop() || filePath)
    }

    const patent = await parsePatentFile(filePath, patentType, includeRawXml)
    if (patent) {
      patents.push(patent)
    }
  }

  return patents
}

// 检测 XML 中的专利类型
export function detectPatentType(xmlContent: string): PatentType | null {
  const lowerContent = xmlContent.toLowerCase()

  if (
    lowerContent.includes('utility-model') ||
    lowerContent.includes('实用新型')
  ) {
    return 'utility_model'
  }

  if (lowerContent.includes('invention') || lowerContent.includes('发明')) {
    return 'invention'
  }

  return null
}
