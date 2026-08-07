import { XMLParser } from 'fast-xml-parser'
import * as fs from 'fs'
import type {
  ParsedPatent,
  ParsedApplicant,
  ParsedAgent,
  ParsedCitation,
  ParsedClaim,
  ParsedDescription,
  ParsedPatentImageReference,
  PatentType,
} from '@/types'

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
        'Citation',
        'Examiner',
        'Assignee',
        'ClaimText',
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
      'claimtext',
      'classification-ipcr',
      'ipc',
      'citation',
      'examiner',
      'assignee',
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

// 确保数组
function ensureArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

// 提取结构化申请人
function extractStructuredApplicants(nodes: unknown): ParsedApplicant[] {
  return ensureArray(nodes)
    .map((a: unknown) => {
      // AddressBook 结构（新格式）
      const name = extractText(getNestedValue(a, 'AddressBook', 'Name'))
      if (name) {
        const addr = getNestedValue(a, 'AddressBook', 'Address')
        const result: ParsedApplicant = { name }
        const address = extractText(getNestedValue(addr, 'Text'))
        if (address) result.address = address
        const province = extractText(getNestedValue(addr, 'Province'))
        if (province) result.province = province
        const city = extractText(getNestedValue(addr, 'City'))
        if (city) result.city = city
        const county = extractText(getNestedValue(addr, 'County'))
        if (county) result.county = county
        const postcode = extractText(getNestedValue(addr, 'PostCode'))
        if (postcode) result.postcode = postcode
        const country = extractText(getNestedValue(addr, 'WIPOST3Code'))
        if (country) result.country = country
        return result
      }
      // 旧格式：纯字符串或包含 #text / name 字段的扁平对象
      const fallbackName = extractText(a)
      if (fallbackName) return { name: fallbackName }
      return null
    })
    .filter((x): x is ParsedApplicant => x !== null)
}

// 提取结构化代理人/机构（保留配对）
function extractStructuredAgents(nodes: unknown): ParsedAgent[] {
  return ensureArray(nodes)
    .map((a: unknown) => {
      // AddressBook 结构（新格式）
      const agentName = extractText(getNestedValue(a, 'AddressBook', 'Name'))
      const agencyName = extractText(
        getNestedValue(a, 'Agency', 'AddressBook', 'OrganizationName'),
      )
      if (agentName || agencyName) {
        return {
          agent_name: agentName || '',
          agency_name: agencyName || '',
        }
      }
      // 旧格式：纯字符串或扁平对象
      const fallbackName = extractText(a)
      if (fallbackName) return { agent_name: fallbackName, agency_name: '' }
      return null
    })
    .filter((x): x is ParsedAgent => x !== null)
}

function splitMultiValueText(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
}

function uniqueTexts(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)))
}

const IMAGE_FILE_PATTERN = /\.(jpe?g|png|gif|bmp|webp|tiff?|jp2|j2k|svg)$/i

function extractImageFilesFromNode(node: unknown): string[] {
  return ensureArray(node)
    .map((image) => extractText(getNestedValue(image, '@_file')))
    .filter((fileName): fileName is string =>
      Boolean(fileName && IMAGE_FILE_PATTERN.test(fileName)),
    )
}

function extractImageFileFromFigure(figure: unknown): string | undefined {
  return extractImageFilesFromNode(getNestedValue(figure, 'Image'))[0]
}

function normalizeFigureLabel(value: string | undefined): string | undefined {
  if (!value) return undefined
  const label = value.trim()
  return label || undefined
}

function extractDrawingImageReferences(root: unknown): ParsedPatentImageReference[] {
  const drawings = getNestedValue(root, 'Drawings')
  const figures = ensureArray(getNestedValue(drawings, 'Figure'))
  const refs: ParsedPatentImageReference[] = []

  for (const figure of figures) {
    const fileName = extractImageFileFromFigure(figure)
    if (!fileName || !IMAGE_FILE_PATTERN.test(fileName)) continue
    refs.push({
      file_name: fileName,
      image_role: 'drawing',
      figure_label: normalizeFigureLabel(
        extractText(getNestedValue(figure, '@_figureLabels')) ||
          extractText(getNestedValue(figure, '@_num')),
      ),
    })
  }

  return refs
}

function extractInlineImageReferences(root: unknown): ParsedPatentImageReference[] {
  const desc = getNestedValue(root, 'Description')
  if (!desc || typeof desc !== 'object') return []

  const refs: ParsedPatentImageReference[] = []
  const visit = (node: unknown, sourceSection: string) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, sourceSection)
      return
    }

    const obj = node as Record<string, unknown>
    for (const fileName of extractImageFilesFromNode(obj['Image'])) {
      refs.push({
        file_name: fileName,
        image_role: 'inline',
        source_section: sourceSection,
      })
    }

    for (const value of Object.values(obj)) {
      visit(value, sourceSection)
    }
  }

  for (const [sectionKey, sectionValue] of Object.entries(
    desc as Record<string, unknown>,
  )) {
    if (sectionKey === 'DrawingsDescription') continue
    visit(sectionValue, sectionKey)
  }

  return refs
}

function extractImageReferences(root: unknown): ParsedPatentImageReference[] {
  return uniqueImageReferences([
    ...extractDrawingImageReferences(root),
    ...extractInlineImageReferences(root),
  ])
}

function uniqueImageReferences(
  refs: ParsedPatentImageReference[],
): ParsedPatentImageReference[] {
  const seen = new Set<string>()
  return refs.filter((ref) => {
    const key = `${ref.file_name}\u0000${ref.image_role}\u0000${ref.source_section || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalizeStructuredAgents(
  agents: ParsedAgent[],
  agentText: string | undefined,
  agencyText: string | undefined,
): ParsedAgent[] {
  const agentNames = splitMultiValueText(agentText)
  const agencyNames = splitMultiValueText(agencyText)

  if (agents.length === 0) {
    const length = Math.max(agentNames.length, agencyNames.length)
    return Array.from({ length }, (_, index) => ({
      agent_name: agentNames[index] || '',
      agency_name: agencyNames[index] || '',
    })).filter((item) => item.agent_name || item.agency_name)
  }

  return agents.map((item, index) => ({
    agent_name: item.agent_name || agentNames[index] || '',
    agency_name: item.agency_name || agencyNames[index] || '',
  }))
}

// 提取结构化引用文献
function extractCitations(root: unknown): ParsedCitation[] {
  const citationNodes =
    getNestedValue(root, 'BibliographicData', 'ReferencesCited', 'Citation') ||
    getNestedValue(root, 'bibliographic-data', 'references-cited', 'citation')
  return ensureArray(citationNodes)
    .map((c: unknown) => {
      const appCit =
        getNestedValue(c, 'ApplicationCitation') ||
        getNestedValue(c, 'application-citation')
      const pubRef =
        resolveFirst(appCit, 'PublicationReference', 'DocumentID') ||
        getNestedValue(appCit, 'publication-reference', 'document-id')
      if (!pubRef) return null
      const result: ParsedCitation = {}
      const country = extractText(getNestedValue(pubRef, 'WIPOST3Code'))
      if (country) result.country = country
      const docNumber =
        extractText(getNestedValue(pubRef, 'DocNumber')) ||
        extractText(getNestedValue(pubRef, 'doc-number'))
      if (docNumber) result.doc_number = docNumber
      const kind = extractText(getNestedValue(pubRef, 'Kind'))
      if (kind) result.kind = kind
      const pubDate = formatDate(getNestedValue(pubRef, 'Date'))
      if (pubDate) result.pub_date = pubDate
      return result
    })
    .filter((x): x is ParsedCitation => x !== null)
}

// 判断权利要求是否为独立权利要求
// CNIPA XML 无显式属性标识,通过文本启发式判断:
// 含"如权利要求N所述"或"根据权利要求N所述"即为从属,否则为独立
function isIndependentClaim(text: string): boolean {
  return !/(?:如|根据)权利要求\s*\d+/.test(text)
}

// 提取结构化权利要求
function extractStructuredClaims(root: unknown): ParsedClaim[] {
  const claimNodes = getNestedValue(root, 'Claims', 'Claim')
  return ensureArray(claimNodes)
    .map((c: unknown, idx: number) => {
      const obj = c as Record<string, unknown>
      const claimTexts = ensureArray(obj['ClaimText'])
      const texts = claimTexts
        .map((t: unknown) => extractText(t))
        .filter((t): t is string => !!t)
      if (texts.length === 0) return null
      const num = extractText(obj['@_num']) || String(idx + 1).padStart(4, '0')
      const joined = texts.join('\n')
      return { num, texts, is_independent: isIndependentClaim(joined) }
    })
    .filter((x): x is ParsedClaim => x !== null)
}

function buildInlineImageMarker(fileName: string): string {
  return `[[PATENT_IMAGE:${fileName}]]`
}

function extractParagraphWithImageMarkers(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return extractText(value)
  const obj = value as Record<string, unknown>
  const imageFiles = extractImageFilesFromNode(obj['Image'])
  if (imageFiles.length === 0) return extractText(value)

  const text = extractText(obj['#text'])
  const parts = [
    text,
    ...imageFiles.map((fileName) => buildInlineImageMarker(fileName)),
  ].filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join('\n') : undefined
}
// 提取说明书段落下所有 Paragraphs 文本
function extractParagraphsUnder(section: unknown): string[] {
  const paragraphs: string[] = []
  const collect = (obj: unknown) => {
    if (!obj || typeof obj !== 'object') return
    if (Array.isArray(obj)) {
      for (const item of obj) collect(item)
      return
    }
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === 'Paragraphs' || k === 'Paragraph') {
        if (Array.isArray(v)) {
          for (const item of v) {
            const t = extractParagraphWithImageMarkers(item)
            if (t) paragraphs.push(t)
          }
        } else {
          const t = extractParagraphWithImageMarkers(v)
          if (t) paragraphs.push(t)
        }
      } else if (typeof v === 'object' && v !== null) {
        collect(v)
      }
    }
  }
  collect(section)
  return paragraphs
}

// 从 Disclosure(发明内容)文本中拆分技术问题/技术方案/有益效果
// CNIPA V2.2.1 schema 下这三类信息以 Paragraphs 平铺,靠段落文本语义切分
function splitDisclosureSections(paragraphs: string[]): {
  technical_problem?: string
  technical_solution?: string
  beneficial_effect?: string
} {
  if (paragraphs.length === 0) return {}

  // 跳过段落首句通常是"发明内容"标题行
  const joined = paragraphs.join('\n')

  // 切分锚点(关键词)
  // 技术问题: "为解决上述技术问题" / "所要解决的技术问题" / "所要解决的技术问题是"
  // 技术方案: "采用如下技术方案" / "通过如下技术方案" / "本发明提供" / "技术方案是"
  // 有益效果: "有益效果" / "具有如下技术效果" / "与现有技术相比" / "具有以下优点"
  const problemMarkers = [
    /为解决上述技术问题/,
    /所要解决的技术问题/,
    /要解决的技术问题/,
    /本发明所要解决的技术问题/,
  ]
  const solutionMarkers = [
    /采用如下技术方案/,
    /通过如下技术方案/,
    /通过以下技术方案/,
    /本发明提供.{0,4}技术方案/,
    /技术方案是/,
    /解决上述技术问题所采用的技术方案/,
  ]
  const effectMarkers = [
    /有益效果/,
    /具有如下技术效果/,
    /具有以下有益效果/,
    /与现有技术相比/,
    /具有以下优点/,
    /本发明具有如下.{0,4}效果/,
  ]

  // 找到三类标记在段落中的索引
  let problemIdx = -1
  let solutionIdx = -1
  let effectIdx = -1

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i]
    if (problemIdx < 0 && problemMarkers.some((re) => re.test(p)))
      problemIdx = i
    if (solutionIdx < 0 && solutionMarkers.some((re) => re.test(p)))
      solutionIdx = i
    if (effectIdx < 0 && effectMarkers.some((re) => re.test(p))) effectIdx = i
  }

  const result: {
    technical_problem?: string
    technical_solution?: string
    beneficial_effect?: string
  } = {}

  // 按标记切分: 各段从该标记段落开始到下一标记段落(或末尾)
  // 排序标记索引
  const marks: { idx: number; type: 'problem' | 'solution' | 'effect' }[] = []
  if (problemIdx >= 0) marks.push({ idx: problemIdx, type: 'problem' })
  if (solutionIdx >= 0) marks.push({ idx: solutionIdx, type: 'solution' })
  if (effectIdx >= 0) marks.push({ idx: effectIdx, type: 'effect' })
  marks.sort((a, b) => a.idx - b.idx)

  for (let mi = 0; mi < marks.length; mi++) {
    const start = marks[mi].idx
    const end = mi + 1 < marks.length ? marks[mi + 1].idx : paragraphs.length
    const segment = paragraphs.slice(start, end).join('\n').trim()
    if (!segment) continue
    if (marks[mi].type === 'problem') result.technical_problem = segment
    else if (marks[mi].type === 'solution') result.technical_solution = segment
    else if (marks[mi].type === 'effect') result.beneficial_effect = segment
  }

  // 兜底: 若未识别到 problem 但有 solution,effect 之前的内容视为问题
  if (
    !result.technical_problem &&
    result.technical_solution &&
    problemIdx < 0
  ) {
    const end = solutionIdx >= 0 ? solutionIdx : paragraphs.length
    const seg = paragraphs.slice(0, end).join('\n').trim()
    if (seg) result.technical_problem = seg
  }

  void joined // 保留以便调试
  return result
}

// 从说明书中提取提及文献(非审查引证的参考文献)
// 通常出现在 BackgroundArt 背景技术段落,正则匹配"申请号XXX"、"CNXXXXXXX"、"专利号XXX"等模式
function extractReferencedDocuments(
  backgroundArt?: string,
  disclosure?: string,
): string[] {
  const docs = new Set<string>()
  const patterns = [
    // 申请号 CN201510145456.1 / 201510145456.1
    /(?:申请号|专利号|公开号|公告号)\s*[：:]?\s*(CN\d{6,}[.\d]*)/g,
    /(?:申请号|专利号|公开号|公告号)\s*[：:]?\s*(\d{8,}[.\d]*)/g,
    // CNXXXXXXXX 形式
    /\b(CN\d{8,}[.\d]*)/g,
  ]

  const scan = (text?: string) => {
    if (!text) return
    for (const re of patterns) {
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        if (m[1]) docs.add(m[1].trim())
      }
    }
  }

  scan(backgroundArt)
  scan(disclosure)

  return Array.from(docs)
}

// 提取说明书
function extractDescription(root: unknown): {
  text: string
  structured: ParsedDescription
} {
  const desc = getNestedValue(root, 'Description')
  if (!desc || typeof desc !== 'object') return { text: '', structured: {} }

  const extractSection = (...keys: string[]): string => {
    const section = getNestedValue(desc, ...keys)
    if (!section) return ''
    return extractParagraphsUnder(section).join('\n')
  }

  const technicalField = extractSection('TechnicalField') || undefined
  const backgroundArt = extractSection('BackgroundArt') || undefined
  const drawingsDescription = extractSection('DrawingsDescription') || undefined
  const embodiment =
    extractSection('InventionMode') ||
    extractSection('ModeForInvention') ||
    undefined

  // Disclosure 拆分: 先取整段作为 disclosure,再尝试拆出三段
  const disclosureSection = getNestedValue(desc, 'Disclosure')
  const disclosureParagraphs = disclosureSection
    ? extractParagraphsUnder(disclosureSection)
    : []
  const disclosure = disclosureParagraphs.join('\n') || undefined

  const split = splitDisclosureSections(disclosureParagraphs)
  const technicalProblem = split.technical_problem
  const technicalSolution = split.technical_solution
  const beneficialEffect = split.beneficial_effect

  // 从说明书背景技术+发明内容提取提及文献
  const referencedDocuments = extractReferencedDocuments(
    backgroundArt,
    disclosure,
  )

  const structured: ParsedDescription = {
    technical_field: technicalField,
    background_art: backgroundArt,
    disclosure,
    technical_problem: technicalProblem,
    technical_solution: technicalSolution,
    beneficial_effect: beneficialEffect,
    drawings_description: drawingsDescription,
    embodiment,
    referenced_documents:
      referencedDocuments.length > 0 ? referencedDocuments : undefined,
  }

  // 拼接完整说明书文本
  const text = [
    structured.technical_field,
    structured.background_art,
    structured.disclosure,
    structured.drawings_description,
    structured.embodiment,
  ]
    .filter(Boolean)
    .join('\n\n')

  return { text, structured }
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

    // === 根元素属性 ===
    const kind = extractText(getNestedValue(root, '@_kind')) || undefined
    const pubCountry =
      extractText(getNestedValue(root, '@_country')) || undefined
    const docStatus = extractText(getNestedValue(root, '@_status')) || undefined
    const lang = extractText(getNestedValue(root, '@_lang')) || undefined
    const sourceFile = extractText(getNestedValue(root, '@_file')) || undefined

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

    // 提取摘要附图
    const abstractFigure = extractText(
      getNestedValue(
        root,
        'Abstract',
        'AbstractFigure',
        'Figure',
        'Image',
        '@_file',
      ),
    )
    const imageReferences = extractImageReferences(root)
    const imageFiles = uniqueTexts(imageReferences.map((ref) => ref.file_name))

    // 提取权利要求（文本，兼容旧接口）
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

    // 结构化权利要求
    const claimsStructured = extractStructuredClaims(root)

    // 提取申请人（扁平，兼容旧接口）
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

    // 结构化申请人
    const applicantsStructured = extractStructuredApplicants(applicantArr)

    // 提取发明人（扁平，兼容旧接口）
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
      .filter((n): n is string => !!n)
    const inventor =
      inventorNames.length > 0 ? inventorNames.join('; ') : undefined

    // 结构化发明人
    const inventorsStructured = inventorNames.filter((n): n is string => !!n)

    // 提取申请信息
    const appRefNode =
      getNestedValue(root, 'BibliographicData', 'ApplicationReference') ||
      getNestedValue(root, 'bibliographic-data', 'application-reference')
    const appRef =
      resolveFirst(appRefNode, 'DocumentID') ||
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

    // 申请类型码和国别
    const appType =
      extractText(
        getNestedValue(
          Array.isArray(appRefNode) ? appRefNode[0] : appRefNode,
          '@_applType',
        ),
      ) || undefined
    const appCountry =
      extractText(getNestedValue(appRef, 'WIPOST3Code')) || undefined

    // 提取公开信息
    const pubRefNode =
      getNestedValue(root, 'BibliographicData', 'PublicationReference') ||
      getNestedValue(root, 'bibliographic-data', 'publication-reference')
    const pubRef =
      resolveFirst(pubRefNode, 'DocumentID') ||
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

    // 公开国别（优先取 DocumentID 中的）
    const pubCountryResolved =
      extractText(getNestedValue(pubRef, 'WIPOST3Code')) ||
      pubCountry ||
      undefined

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

    // 提取代理信息（扁平，兼容旧接口）
    const agentNodes =
      getNestedValue(
        root,
        'BibliographicData',
        'Parties',
        'AgentDetails',
        'Agent',
      ) ||
      getNestedValue(root, 'bibliographic-data', 'parties', 'agents', 'agent')
    const agentArrParsed = Array.isArray(agentNodes)
      ? agentNodes
      : agentNodes
        ? [agentNodes]
        : []
    const agency =
      agentArrParsed
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
      agentArrParsed
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

    // 结构化代理人/机构
    const agentsStructured = normalizeStructuredAgents(
      extractStructuredAgents(agentArrParsed),
      agent,
      agency,
    )

    // 提取审查员
    const examinerNodes = getNestedValue(
      root,
      'BibliographicData',
      'ExaminerDetails',
      'Examiner',
    )
    const examiners = ensureArray(examinerNodes)
      .map(
        (e: unknown) =>
          extractText(getNestedValue(e, 'Name')) || extractText(e),
      )
      .filter((n): n is string => !!n)

    // 提取引用文献
    const citations = extractCitations(root)

    // 提取受让人
    const assigneeNodes = getNestedValue(
      root,
      'BibliographicData',
      'AssigneeDetails',
      'Assignee',
    )
    const assignees = extractStructuredApplicants(assigneeNodes)

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

    // 提取说明书
    const { text: descText, structured: descStructured } =
      extractDescription(root)

    // 权利要求统计:总数与独立项数
    const claimCount = claimsStructured.length
    const independentClaimCount = claimsStructured.filter(
      (c) => c.is_independent,
    ).length

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

      // 新增字段
      kind,
      pub_country: pubCountryResolved,
      app_country: appCountry,
      app_type: appType,
      doc_status: docStatus,
      lang,
      source_file: sourceFile,
      description: descText || undefined,
      description_structured: descText ? descStructured : undefined,
      applicants_structured:
        applicantsStructured.length > 0 ? applicantsStructured : undefined,
      inventors_structured:
        inventorsStructured.length > 0 ? inventorsStructured : undefined,
      agents_structured:
        agentsStructured.length > 0 ? agentsStructured : undefined,
      citations: citations.length > 0 ? citations : undefined,
      examiners: examiners.length > 0 ? examiners : undefined,
      assignees: assignees.length > 0 ? assignees : undefined,
      ipc_structured: ipcCodes,
      claims_structured:
        claimsStructured.length > 0 ? claimsStructured : undefined,
      claim_count: claimCount > 0 ? claimCount : undefined,
      independent_claim_count:
        independentClaimCount > 0 ? independentClaimCount : undefined,
      abstract_figure: abstractFigure,
      image_files: imageFiles.length > 0 ? imageFiles : undefined,
      image_references:
        imageReferences.length > 0 ? imageReferences : undefined,
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
