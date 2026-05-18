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
  removeNSPrefix: true,
  isArray: (name) => {
    // Support both newer PascalCase nodes and legacy lowercase/kebab-case nodes.
    // Exact matching avoids turning container elements like ApplicantDetails into arrays.
    if (
      [
        'Applicant',
        'Inventor',
        'Agent',
        'ClassificationIPCR',
        'Claim',
        'PublicationReference',
        'ApplicationReference',
        'PriorityClaim',
      ].includes(name)
    )
      return true
    const lower = name.toLowerCase()
    return [
      'applicant',
      'inventor',
      'agent',
      'priority',
      'claim',
      'classification-ipcr',
      'ipc',
    ].includes(lower)
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

// 穿透中间数组取首个元素的路径解析（用于 PublicationReference 等数组中取第一个）
function resolveFirst(obj: unknown, ...keys: string[]): unknown {
  let current = obj
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return undefined
    if (Array.isArray(current)) current = current[0]
    if (current == null || typeof current !== 'object') return undefined
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
      doc['PatentDocumentAndRelated'] ||
      doc['cn-patent-document'] ||
      doc['patent-document'] ||
      doc['cn-utility-model'] ||
      doc['utility-model-document'] ||
      doc

    // 提取专利号
    const patentNumber =
      getNestedValue(root, '@_docNumber') ||
      resolveFirst(
        root,
        'BibliographicData',
        'PublicationReference',
        'DocumentID',
        'DocNumber',
      ) ||
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
        getNestedValue(root, 'BibliographicData', 'InventionTitle'),
      ) ||
      extractText(
        getNestedValue(root, 'bibliographic-data', 'invention-title'),
      ) ||
      extractText(getNestedValue(root, 'invention-title')) ||
      extractText(getNestedValue(root, 'title')) ||
      '未知标题'

    // 提取摘要
    const abstractContent =
      extractText(getNestedValue(root, 'Abstract', 'Paragraphs')) ||
      extractText(getNestedValue(root, 'abstract')) ||
      extractText(getNestedValue(root, 'bibliographic-data', 'abstract'))

    // 提取权利要求
    const claimEntries = getNestedValue(root, 'Claims', 'Claim')
    const claimArr = Array.isArray(claimEntries)
      ? claimEntries
      : claimEntries
        ? [claimEntries]
        : []
    const claims =
      claimArr
        .map((c: unknown) =>
          extractText((c as Record<string, unknown>)?.['ClaimText']),
        )
        .filter(Boolean)
        .join('\n') ||
      extractText(getNestedValue(root, 'claims')) ||
      extractText(getNestedValue(root, 'claim'))

    // 提取申请人
    const applicantNodes =
      getNestedValue(
        root,
        'BibliographicData',
        'Parties',
        'ApplicantDetails',
        'Applicant',
      ) ||
      getNestedValue(
        root,
        'bibliographic-data',
        'parties',
        'applicants',
        'applicant',
      ) ||
      getNestedValue(root, 'bibliographic-data', 'applicant') ||
      getNestedValue(root, 'applicant')
    const applicantArr = Array.isArray(applicantNodes)
      ? applicantNodes
      : applicantNodes
        ? [applicantNodes]
        : []
    const applicantNames = applicantArr
      .map(
        (a: unknown) =>
          extractText(getNestedValue(a, 'AddressBook', 'Name')) ||
          extractText(a),
      )
      .filter(Boolean)
    const applicant =
      applicantNames.length > 0 ? applicantNames.join('; ') : undefined

    // 提取发明人
    const inventorNodes =
      getNestedValue(
        root,
        'BibliographicData',
        'Parties',
        'InventorDetails',
        'Inventor',
      ) ||
      getNestedValue(
        root,
        'bibliographic-data',
        'parties',
        'inventors',
        'inventor',
      ) ||
      getNestedValue(root, 'bibliographic-data', 'inventor') ||
      getNestedValue(root, 'inventor')
    const inventorArr = Array.isArray(inventorNodes)
      ? inventorNodes
      : inventorNodes
        ? [inventorNodes]
        : []
    const inventorNames = inventorArr
      .map(
        (i: unknown) =>
          extractText(getNestedValue(i, 'AddressBook', 'Name')) ||
          extractText(i),
      )
      .filter(Boolean)
    const inventor =
      inventorNames.length > 0 ? inventorNames.join('; ') : undefined

    // 提取申请信息
    const appRef =
      resolveFirst(
        root,
        'BibliographicData',
        'ApplicationReference',
        'DocumentID',
      ) ||
      getNestedValue(
        root,
        'bibliographic-data',
        'application-reference',
        'document-id',
      )
    const applicationNumber =
      extractText(getNestedValue(appRef, 'DocNumber')) ||
      extractText(getNestedValue(appRef, 'doc-number')) ||
      extractText(getNestedValue(root, 'application-number'))
    const applicationDate =
      formatDate(getNestedValue(appRef, 'Date')) ||
      formatDate(getNestedValue(appRef, 'date')) ||
      formatDate(getNestedValue(root, 'application-date'))

    // 提取公开信息
    const pubRef =
      resolveFirst(
        root,
        'BibliographicData',
        'PublicationReference',
        'DocumentID',
      ) ||
      getNestedValue(
        root,
        'bibliographic-data',
        'publication-reference',
        'document-id',
      )
    const publicationNumber =
      extractText(getNestedValue(pubRef, 'DocNumber')) ||
      extractText(getNestedValue(pubRef, 'doc-number')) ||
      extractText(getNestedValue(root, 'publication-number'))
    const publicationDate =
      formatDate(getNestedValue(pubRef, 'Date')) ||
      formatDate(getNestedValue(pubRef, 'date')) ||
      formatDate(getNestedValue(root, 'publication-date'))

    // 提取授权信息
    const grantRef =
      resolveFirst(root, 'BibliographicData', 'GrantReference', 'DocumentID') ||
      getNestedValue(
        root,
        'bibliographic-data',
        'grant-reference',
        'document-id',
      )
    const grantNumber =
      extractText(getNestedValue(grantRef, 'DocNumber')) ||
      extractText(getNestedValue(grantRef, 'doc-number')) ||
      extractText(getNestedValue(root, 'grant-number')) ||
      String(patentNumber)
    const grantDate =
      formatDate(getNestedValue(grantRef, 'Date')) ||
      formatDate(getNestedValue(grantRef, 'date')) ||
      formatDate(getNestedValue(root, 'grant-date')) ||
      formatDate(getNestedValue(root, '@_date-publ')) ||
      formatDate(getNestedValue(root, '@_datePublication'))

    // 提取 IPC 分类
    const ipcNodes =
      getNestedValue(
        root,
        'BibliographicData',
        'ClassificationIPCRDetails',
        'ClassificationIPCR',
      ) ||
      getNestedValue(
        root,
        'bibliographic-data',
        'classifications-ipcr',
        'classification-ipcr',
      ) ||
      getNestedValue(root, 'ipc-codes') ||
      getNestedValue(root, 'ipc')
    const ipcArr = Array.isArray(ipcNodes)
      ? ipcNodes
      : ipcNodes
        ? [ipcNodes]
        : []
    const ipcTexts = ipcArr
      .map((item: unknown) => {
        if (typeof item === 'string') return item.trim()
        if (typeof item === 'object' && item !== null) {
          const obj = item as Record<string, unknown>
          const text =
            obj['Text'] ||
            obj['#text'] ||
            obj['@_code'] ||
            obj['main-classification'] ||
            obj['classification']
          return text ? String(text).trim() : undefined
        }
        return undefined
      })
      .filter(Boolean) as string[]
    const ipcCodes =
      ipcTexts.length > 0
        ? ipcTexts
        : extractIpcCodes(
            getNestedValue(
              root,
              'bibliographic-data',
              'classification-ipc',
              'main-classification',
            ),
          )

    // 提取代理信息
    const agentNodes =
      getNestedValue(
        root,
        'BibliographicData',
        'Parties',
        'AgentDetails',
        'Agent',
      ) ||
      getNestedValue(root, 'bibliographic-data', 'parties', 'agents', 'agent')
    const agentArr = Array.isArray(agentNodes)
      ? agentNodes
      : agentNodes
        ? [agentNodes]
        : []
    const agency =
      agentArr
        .map((a: unknown) =>
          extractText(
            getNestedValue(a, 'Agency', 'AddressBook', 'OrganizationName'),
          ),
        )
        .filter(Boolean)
        .join('; ') ||
      extractText(
        getNestedValue(root, 'bibliographic-data', 'agents', 'agent', 'agency'),
      ) ||
      extractText(getNestedValue(root, 'agency'))
    const agent =
      agentArr
        .map((a: unknown) =>
          extractText(getNestedValue(a, 'AddressBook', 'Name')),
        )
        .filter(Boolean)
        .join('; ') ||
      extractText(
        getNestedValue(
          root,
          'bibliographic-data',
          'parties',
          'agents',
          'agent',
        ),
      ) ||
      extractText(getNestedValue(root, 'agent'))

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
  try {
    const doc = parser.parse(xmlContent)
    const root =
      doc['PatentDocumentAndRelated'] ||
      doc['cn-patent-document'] ||
      doc['patent-document'] ||
      doc['cn-utility-model'] ||
      doc['utility-model-document'] ||
      doc
    const kind = getNestedValue(root, '@_kind')
    if (kind === 'U' || kind === 'u') return 'utility_model'
    if (kind === 'B' || kind === 'b') return 'invention'
  } catch {
    // fall through to text-based detection
  }

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
