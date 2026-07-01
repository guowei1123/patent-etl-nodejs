import { normalizeClassificationCodeNorm } from './classification-code'

type TokenType = 'word' | 'phrase' | 'operator' | 'lparen' | 'rparen' | 'field'

type Token = {
  type: TokenType
  value: string
}

type ExpressionNode =
  | { type: 'term'; field?: string; value: string }
  | { type: 'not'; node: ExpressionNode }
  | { type: 'and' | 'or'; left: ExpressionNode; right: ExpressionNode }

type SqlBuildResult = {
  sql: string
  params: string[]
  nextParamIndex: number
}

type SqlBuilder = (paramIndex: number) => SqlBuildResult

const OPERATOR_ALIASES: Record<string, 'AND' | 'OR' | 'NOT'> = {
  AND: 'AND',
  OR: 'OR',
  NOT: 'NOT',
  '&&': 'AND',
  '||': 'OR',
  '!': 'NOT',
  与: 'AND',
  且: 'AND',
  或: 'OR',
  非: 'NOT',
}

const FIELD_ALIASES: Record<string, string> = {
  AB: 'abstract',
  ABSTRACT: 'abstract',
  AG: 'agent',
  AGENCY: 'agent',
  AGENT: 'agent',
  AN: 'app_number',
  APP: 'app_number',
  APPNO: 'app_number',
  APP_NUMBER: 'app_number',
  APPLICANT: 'applicant',
  ASSIGNEE: 'assignee',
  CL: 'claims',
  CLAIM: 'claims',
  CLAIMS: 'claims',
  CPC: 'ipc',
  DESC: 'description',
  DESCRIPTION: 'description',
  DOC: 'doc_number',
  DOC_NUMBER: 'doc_number',
  IN: 'inventor',
  INVENTOR: 'inventor',
  IPC: 'ipc',
  KIND: 'kind',
  PA: 'applicant',
  PN: 'doc_number',
  PD: 'pub_date',
  PUBLICATION: 'doc_number',
  PUBLICATION_DATE: 'pub_date',
  PUBDATE: 'pub_date',
  PUB_DATE: 'pub_date',
  TITLE: 'title',
  TI: 'title',
  TIAB: 'title_abstract',
  TYPE: 'kind',
  公开号: 'doc_number',
  公开日: 'pub_date',
  公开日期: 'pub_date',
  公布号: 'doc_number',
  分类号: 'ipc',
  发明人: 'inventor',
  名称: 'title',
  权利要求: 'claims',
  权利人: 'assignee',
  申请人: 'applicant',
  申请号: 'app_number',
  摘要: 'abstract',
  标题: 'title',
  类型: 'kind',
  说明书: 'description',
  代理: 'agent',
  受让人: 'assignee',
}

export class PatentSearchExpressionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PatentSearchExpressionError'
  }
}

function normalizeField(field: string): string {
  return FIELD_ALIASES[field.toUpperCase()] || FIELD_ALIASES[field] || field
}

function canStartSpacedClassificationCode(value: string): boolean {
  return /^[A-Z]\d{2}[A-Z]$/i.test(value.trim())
}

function canContinueSpacedClassificationCode(value: string): boolean {
  return /^\d+\/[A-Z0-9]+$/i.test(value.trim())
}

function isOperator(value: string): boolean {
  return value.toUpperCase() in OPERATOR_ALIASES || value in OPERATOR_ALIASES
}

function normalizeOperator(value: string): 'AND' | 'OR' | 'NOT' {
  return OPERATOR_ALIASES[value.toUpperCase()] || OPERATOR_ALIASES[value]
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < expression.length) {
    const char = expression[i]

    if (/\s/.test(char)) {
      i++
      continue
    }

    if (char === '(') {
      tokens.push({ type: 'lparen', value: char })
      i++
      continue
    }

    if (char === ')') {
      tokens.push({ type: 'rparen', value: char })
      i++
      continue
    }

    if (char === '"' || char === "'") {
      const quote = char
      let value = ''
      i++

      while (i < expression.length && expression[i] !== quote) {
        if (expression[i] === '\\' && i + 1 < expression.length) {
          value += expression[i + 1]
          i += 2
        } else {
          value += expression[i]
          i++
        }
      }

      if (i >= expression.length) {
        throw new PatentSearchExpressionError('检索式中的引号未闭合')
      }

      tokens.push({ type: 'phrase', value })
      i++
      continue
    }

    if (char === ':' || char === '=') {
      tokens.push({ type: 'field', value: char })
      i++
      continue
    }

    let value = ''
    while (
      i < expression.length &&
      !/\s/.test(expression[i]) &&
      !['(', ')', ':', '='].includes(expression[i])
    ) {
      value += expression[i]
      i++
    }

    if (!value) {
      throw new PatentSearchExpressionError(`不支持的检索式字符: ${char}`)
    }

    tokens.push({
      type: isOperator(value) ? 'operator' : 'word',
      value,
    })
  }

  return tokens
}

class Parser {
  private index = 0

  constructor(private readonly tokens: Token[]) {}

  parse(): ExpressionNode | null {
    if (this.tokens.length === 0) return null
    const node = this.parseOr()

    if (this.peek()) {
      throw new PatentSearchExpressionError(
        `无法解析的检索式片段: ${this.peek()?.value}`,
      )
    }

    return node
  }

  private parseOr(): ExpressionNode {
    let node = this.parseAnd()

    while (this.matchOperator('OR')) {
      node = { type: 'or', left: node, right: this.parseAnd() }
    }

    return node
  }

  private parseAnd(): ExpressionNode {
    let node = this.parseNot()

    while (!this.isAtEnd()) {
      if (this.matchOperator('AND')) {
        node = { type: 'and', left: node, right: this.parseNot() }
        continue
      }

      const next = this.peek()
      if (!next || next.type === 'rparen' || this.isOperatorToken(next, 'OR')) {
        break
      }

      node = { type: 'and', left: node, right: this.parseNot() }
    }

    return node
  }

  private parseNot(): ExpressionNode {
    if (this.matchOperator('NOT')) {
      return { type: 'not', node: this.parseNot() }
    }

    return this.parsePrimary()
  }

  private parsePrimary(defaultField?: string): ExpressionNode {
    const token = this.consume()

    if (!token) {
      throw new PatentSearchExpressionError('检索式不完整')
    }

    if (token.type === 'lparen') {
      const node = this.parseOr()
      this.expect('rparen', '检索式中的括号未闭合')
      return node
    }

    if (token.type === 'word') {
      const fieldOperator = this.peek()
      if (fieldOperator?.type === 'field') {
        this.consume()
        const field = normalizeField(token.value)
        const next = this.peek()

        if (next?.type === 'lparen') {
          this.consume()
          const node = this.parseFieldGroup(field)
          this.expect('rparen', '字段检索式中的括号未闭合')
          return node
        }

        return this.parseFieldTerm(field)
      }

      if (
        defaultField === 'ipc' &&
        canStartSpacedClassificationCode(token.value)
      ) {
        const next = this.peek()
        if (
          next?.type === 'word' &&
          canContinueSpacedClassificationCode(next.value)
        ) {
          this.consume()
          return {
            type: 'term',
            field: defaultField,
            value: `${token.value} ${next.value}`,
          }
        }
      }

      return { type: 'term', field: defaultField, value: token.value }
    }

    if (token.type === 'phrase') {
      return { type: 'term', field: defaultField, value: token.value }
    }

    throw new PatentSearchExpressionError(`检索式位置不合法: ${token.value}`)
  }

  private parseFieldGroup(field: string): ExpressionNode {
    let node = this.parseFieldAnd(field)

    while (this.matchOperator('OR')) {
      node = { type: 'or', left: node, right: this.parseFieldAnd(field) }
    }

    return node
  }

  private parseFieldAnd(field: string): ExpressionNode {
    let node = this.parseFieldNot(field)

    while (!this.isAtEnd()) {
      if (this.matchOperator('AND')) {
        node = { type: 'and', left: node, right: this.parseFieldNot(field) }
        continue
      }

      const next = this.peek()
      if (!next || next.type === 'rparen' || this.isOperatorToken(next, 'OR')) {
        break
      }

      node = { type: 'and', left: node, right: this.parseFieldNot(field) }
    }

    return node
  }

  private parseFieldNot(field: string): ExpressionNode {
    if (this.matchOperator('NOT')) {
      return { type: 'not', node: this.parseFieldNot(field) }
    }

    return this.parsePrimary(field)
  }

  private parseFieldTerm(field: string): ExpressionNode {
    const token = this.consume()

    if (!token || (token.type !== 'word' && token.type !== 'phrase')) {
      throw new PatentSearchExpressionError('字段检索式缺少查询值')
    }

    if (field === 'ipc' && canStartSpacedClassificationCode(token.value)) {
      const next = this.peek()
      if (
        next?.type === 'word' &&
        canContinueSpacedClassificationCode(next.value)
      ) {
        this.consume()
        return {
          type: 'term',
          field,
          value: `${token.value} ${next.value}`,
        }
      }
    }

    return { type: 'term', field, value: token.value }
  }

  private matchOperator(operator: 'AND' | 'OR' | 'NOT'): boolean {
    const token = this.peek()
    if (!token || !this.isOperatorToken(token, operator)) return false
    this.consume()
    return true
  }

  private isOperatorToken(
    token: Token,
    operator: 'AND' | 'OR' | 'NOT',
  ): boolean {
    return (
      token.type === 'operator' && normalizeOperator(token.value) === operator
    )
  }

  private expect(type: TokenType, message: string): void {
    const token = this.consume()
    if (!token || token.type !== type) {
      throw new PatentSearchExpressionError(message)
    }
  }

  private consume(): Token | undefined {
    return this.tokens[this.index++]
  }

  private peek(): Token | undefined {
    return this.tokens[this.index]
  }

  private isAtEnd(): boolean {
    return this.index >= this.tokens.length
  }
}

function escapeLike(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_')
}

function makeLikePattern(value: string): string {
  const escaped = escapeLike(value)
    .replaceAll('*', '%')
    .replaceAll('？', '_')
    .replaceAll('?', '_')

  return `%${escaped}%`
}

function makePrefixLikePattern(value: string): string {
  const escaped = escapeLike(value)
    .replaceAll('*', '%')
    .replaceAll('？', '_')
    .replaceAll('?', '_')

  return `${escaped}%`
}

function classificationCodeFieldCondition(value: string): SqlBuilder {
  const normalizedValue = normalizeClassificationCodeNorm(value)
  return (paramIndex) => ({
    sql: `EXISTS (SELECT 1 FROM cnipa.patent_ipc pic_expr WHERE pic_expr.patent_id = p.id AND upper(replace(pic_expr.ipc_code, ' ', '')) ILIKE $${paramIndex} ESCAPE '\\')`,
    params: [makePrefixLikePattern(normalizedValue)],
    nextParamIndex: paramIndex + 1,
  })
}

function textFieldCondition(sqlExpression: string, value: string): SqlBuilder {
  return (paramIndex) => ({
    sql: `${sqlExpression} ILIKE $${paramIndex} ESCAPE '\\'`,
    params: [makeLikePattern(value)],
    nextParamIndex: paramIndex + 1,
  })
}

function dateFieldCondition(sqlExpression: string, value: string): SqlBuilder {
  const normalized = value.trim()
  const dateMatch = normalized.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/)

  if (!dateMatch) {
    throw new PatentSearchExpressionError(
      '公开日字段仅支持 YYYY、YYYY-MM 或 YYYY-MM-DD',
    )
  }

  const year = Number(dateMatch[1])
  const month = dateMatch[2] ? Number(dateMatch[2]) : undefined
  const day = dateMatch[3] ? Number(dateMatch[3]) : undefined
  const isValidDay = (dateYear: number, dateMonth: number, dateDay: number) => {
    const date = new Date(Date.UTC(dateYear, dateMonth - 1, dateDay))

    return (
      date.getUTCFullYear() === dateYear &&
      date.getUTCMonth() === dateMonth - 1 &&
      date.getUTCDate() === dateDay
    )
  }

  if (
    year < 1 ||
    (month !== undefined && (month < 1 || month > 12)) ||
    (day !== undefined &&
      (day < 1 || day > 31 || !isValidDay(year, month ?? 1, day)))
  ) {
    throw new PatentSearchExpressionError('公开日字段日期格式不合法')
  }

  const pad = (num: number) => String(num).padStart(2, '0')

  if (month === undefined) {
    return (paramIndex) => ({
      sql: `(${sqlExpression} >= $${paramIndex} AND ${sqlExpression} < $${paramIndex + 1})`,
      params: [`${year}-01-01`, `${year + 1}-01-01`],
      nextParamIndex: paramIndex + 2,
    })
  }

  if (day === undefined) {
    const nextYear = month === 12 ? year + 1 : year
    const nextMonth = month === 12 ? 1 : month + 1

    return (paramIndex) => ({
      sql: `(${sqlExpression} >= $${paramIndex} AND ${sqlExpression} < $${paramIndex + 1})`,
      params: [`${year}-${pad(month)}-01`, `${nextYear}-${pad(nextMonth)}-01`],
      nextParamIndex: paramIndex + 2,
    })
  }

  return (paramIndex) => ({
    sql: `${sqlExpression} = $${paramIndex}`,
    params: [`${year}-${pad(month)}-${pad(day)}`],
    nextParamIndex: paramIndex + 1,
  })
}

function existsCondition(
  table: string,
  alias: string,
  condition: (paramIndex: number) => string,
  value: string,
): SqlBuilder {
  return (paramIndex) => ({
    sql: `EXISTS (SELECT 1 FROM ${table} ${alias} WHERE ${alias}.patent_id = p.id AND ${condition(paramIndex)})`,
    params: [makeLikePattern(value)],
    nextParamIndex: paramIndex + 1,
  })
}

function termToSqlBuilder(
  node: Extract<ExpressionNode, { type: 'term' }>,
): SqlBuilder {
  const value = node.value.trim()
  if (!value) {
    throw new PatentSearchExpressionError('检索式不能包含空查询值')
  }

  switch (node.field) {
    case 'title':
      return textFieldCondition('p.title', value)
    case 'abstract':
      return textFieldCondition('p.abstract', value)
    case 'title_abstract':
      return (paramIndex) => ({
        sql: `(p.title ILIKE $${paramIndex} ESCAPE '\\' OR p.abstract ILIKE $${paramIndex} ESCAPE '\\')`,
        params: [makeLikePattern(value)],
        nextParamIndex: paramIndex + 1,
      })
    case 'claims':
      return textFieldCondition('p.claims::text', value)
    case 'description':
      return textFieldCondition('p.description::text', value)
    case 'doc_number':
      return textFieldCondition('p.doc_number', value)
    case 'app_number':
      return textFieldCondition('p.app_number', value)
    case 'kind':
      return textFieldCondition('p.kind', value)
    case 'pub_date':
      return dateFieldCondition('p.pub_date', value)
    case 'applicant':
      return existsCondition(
        'cnipa.patent_applicant',
        'pa_expr',
        (paramIndex) => `pa_expr.name ILIKE $${paramIndex} ESCAPE '\\'`,
        value,
      )
    case 'inventor':
      return existsCondition(
        'cnipa.patent_inventor',
        'pi_expr',
        (paramIndex) => `pi_expr.name ILIKE $${paramIndex} ESCAPE '\\'`,
        value,
      )
    case 'ipc':
      return classificationCodeFieldCondition(value)
    case 'agent':
      return existsCondition(
        'cnipa.patent_agent',
        'pag_expr',
        (paramIndex) =>
          `(pag_expr.agency ILIKE $${paramIndex} ESCAPE '\\' OR pag_expr.agent ILIKE $${paramIndex} ESCAPE '\\')`,
        value,
      )
    case 'assignee':
      return existsCondition(
        'cnipa.patent_assignee',
        'pas_expr',
        (paramIndex) => `pas_expr.name ILIKE $${paramIndex} ESCAPE '\\'`,
        value,
      )
    default:
      if (node.field) {
        throw new PatentSearchExpressionError(`不支持的检索字段: ${node.field}`)
      }

      return (paramIndex) => ({
        sql: `(p.title ILIKE $${paramIndex} ESCAPE '\\'
          OR p.doc_number ILIKE $${paramIndex} ESCAPE '\\'
          OR p.abstract ILIKE $${paramIndex} ESCAPE '\\'
          OR p.claims::text ILIKE $${paramIndex} ESCAPE '\\'
          OR p.description::text ILIKE $${paramIndex} ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM cnipa.patent_applicant pa_expr WHERE pa_expr.patent_id = p.id AND pa_expr.name ILIKE $${paramIndex} ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM cnipa.patent_inventor pi_expr WHERE pi_expr.patent_id = p.id AND pi_expr.name ILIKE $${paramIndex} ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM cnipa.patent_ipc pic_expr WHERE pic_expr.patent_id = p.id AND pic_expr.ipc_code ILIKE $${paramIndex} ESCAPE '\\'))`,
        params: [makeLikePattern(value)],
        nextParamIndex: paramIndex + 1,
      })
  }
}

function compileNode(node: ExpressionNode, paramIndex: number): SqlBuildResult {
  if (node.type === 'term') {
    return termToSqlBuilder(node)(paramIndex)
  }

  if (node.type === 'not') {
    const result = compileNode(node.node, paramIndex)
    return {
      sql: `NOT (${result.sql})`,
      params: result.params,
      nextParamIndex: result.nextParamIndex,
    }
  }

  const left = compileNode(node.left, paramIndex)
  const right = compileNode(node.right, left.nextParamIndex)
  return {
    sql: `(${left.sql}) ${node.type.toUpperCase()} (${right.sql})`,
    params: [...left.params, ...right.params],
    nextParamIndex: right.nextParamIndex,
  }
}

export function buildPatentSearchExpressionCondition(
  expression: string | undefined,
  startParamIndex: number,
): SqlBuildResult | null {
  const normalized = expression?.trim()
  if (!normalized) return null

  const node = new Parser(tokenize(normalized)).parse()
  if (!node) return null

  return compileNode(node, startParamIndex)
}
