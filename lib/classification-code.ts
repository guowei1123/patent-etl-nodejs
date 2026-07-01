export type ClassificationCodeParts = {
  section: string | null
  class_code: string | null
  subclass: string | null
  main_group: string | null
  subgroup: string | null
}

export type NormalizedClassificationCode = ClassificationCodeParts & {
  code: string
  code_norm: string
}

const IPC_WIPO_LONG_RE = /^([A-H]\d{2}[A-Z])(\d{4})(\d{6})$/
const GROUP_RE = /^([A-Z]\d{2}[A-Z])(\d+)\/([A-Z0-9]+)$/
const SUBCLASS_RE = /^[A-Z]\d{2}[A-Z]$/
const CLASS_RE = /^[A-Z]\d{2}$/
const SECTION_RE = /^[A-Z]$/

function stripVersionSuffix(code: string): string {
  return code.replace(/\s*\(\d{4}\.\d{2}\)\s*/g, '')
}

function compactCode(code: string): string {
  return stripVersionSuffix(code).trim().toUpperCase().replace(/\s+/g, '')
}

function normalizeSubgroup(subgroupDigits: string): string {
  const trimmed = subgroupDigits.replace(/0+$/g, '')
  return (trimmed || '00').padEnd(2, '0')
}

export function ipcWipoLongToDisplayCode(sourceCode: string): string {
  const compact = compactCode(sourceCode)
  const match = compact.match(IPC_WIPO_LONG_RE)
  if (!match) {
    throw new Error(`Invalid WIPO IPC long code: ${sourceCode}`)
  }

  const [, subclass, mainGroupDigits, subgroupDigits] = match
  const mainGroup = String(Number.parseInt(mainGroupDigits, 10))
  if (mainGroup === 'NaN' || mainGroup === '0') {
    throw new Error(`Invalid WIPO IPC main group: ${sourceCode}`)
  }

  return `${subclass} ${mainGroup}/${normalizeSubgroup(subgroupDigits)}`
}

export function normalizeClassificationCodeNorm(sourceCode: string): string {
  const compact = compactCode(sourceCode)
  if (!compact) throw new Error('Classification code cannot be empty')

  if (IPC_WIPO_LONG_RE.test(compact)) {
    return ipcWipoLongToDisplayCode(compact).replace(/\s+/g, '')
  }

  return compact
}

export function toClassificationDisplayCode(sourceCode: string): string {
  const codeNorm = normalizeClassificationCodeNorm(sourceCode)
  const groupMatch = codeNorm.match(GROUP_RE)
  if (groupMatch) {
    return `${groupMatch[1]} ${groupMatch[2]}/${groupMatch[3]}`
  }
  return codeNorm
}

export function splitClassificationCode(
  sourceCode: string,
): ClassificationCodeParts {
  const codeNorm = normalizeClassificationCodeNorm(sourceCode)

  const base =
    codeNorm.match(GROUP_RE)?.[1] ??
    (SUBCLASS_RE.test(codeNorm) ? codeNorm : null)

  return {
    section: codeNorm[0] ?? null,
    class_code: CLASS_RE.test(codeNorm) || base ? codeNorm.slice(0, 3) : null,
    subclass: base,
    main_group: codeNorm.match(GROUP_RE)?.[2] ?? null,
    subgroup: codeNorm.match(GROUP_RE)?.[3] ?? null,
  }
}

export function getClassificationDepth(sourceCode: string): number {
  const codeNorm = normalizeClassificationCodeNorm(sourceCode)
  const groupMatch = codeNorm.match(GROUP_RE)

  if (SECTION_RE.test(codeNorm)) return 0
  if (CLASS_RE.test(codeNorm)) return 1
  if (SUBCLASS_RE.test(codeNorm)) return 2
  if (groupMatch) return groupMatch[3] === '00' ? 3 : 4

  return 0
}

export function getClassificationParentCodeNorm(
  sourceCode: string,
): string | null {
  const codeNorm = normalizeClassificationCodeNorm(sourceCode)
  const groupMatch = codeNorm.match(GROUP_RE)

  if (SECTION_RE.test(codeNorm)) return null
  if (CLASS_RE.test(codeNorm)) return codeNorm.slice(0, 1)
  if (SUBCLASS_RE.test(codeNorm)) return codeNorm.slice(0, 3)
  if (groupMatch) {
    const [, subclass, mainGroup, subgroup] = groupMatch
    return subgroup === '00' ? subclass : `${subclass}${mainGroup}/00`
  }

  return null
}

export function getClassificationAncestorCodeNorms(
  sourceCode: string,
): string[] {
  const ancestors: string[] = []
  let parent = getClassificationParentCodeNorm(sourceCode)

  while (parent) {
    ancestors.unshift(parent)
    parent = getClassificationParentCodeNorm(parent)
  }

  return ancestors
}

export function normalizeIpcClassificationCode(
  sourceCode: string,
): NormalizedClassificationCode {
  const code = toClassificationDisplayCode(sourceCode)
  const code_norm = code.replace(/\s+/g, '')
  return {
    code,
    code_norm,
    ...splitClassificationCode(code_norm),
  }
}

export function normalizeCpcClassificationCode(
  sourceCode: string,
): NormalizedClassificationCode {
  const code = toClassificationDisplayCode(sourceCode)
  const code_norm = code.replace(/\s+/g, '')
  return {
    code,
    code_norm,
    ...splitClassificationCode(code_norm),
  }
}
