import * as fs from 'fs'
import { constants as bufferConstants } from 'buffer'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { ParsedPatent } from '@/types'

export function getPatentImportKey(patent: ParsedPatent): string {
  const kind =
    patent.kind ||
    (patent.patent_type === 'invention'
      ? 'B'
      : patent.patent_type === 'invention_application'
        ? 'A'
        : 'U')
  return `${patent.patent_number}\u0000${kind}`
}

type PatentRecord = { patent: ParsedPatent; index: number }

// 只拼接单条记录。字符串中的逗号、括号和转义字符不作为记录边界。
export async function* parseParsedPatentChunks(
  chunks: AsyncIterable<string>,
  cancelled: () => boolean = () => false,
): AsyncGenerator<PatentRecord> {
  let state: 'start' | 'item' | 'next' | 'record' | 'comma' | 'done' = 'start'
  let depth = 0
  let inString = false
  let escaped = false
  let parts: string[] = []
  let characters = 0
  let index = 0

  const invalid = () =>
    new Error(
      `parsed.json 格式不完整或错误（第 ${index + 1} 条记录附近），请重新执行处理步骤`,
    )
  const append = (part: string) => {
    characters += part.length
    if (characters >= bufferConstants.MAX_STRING_LENGTH) {
      throw new Error(
        `parsed.json 第 ${index + 1} 条专利本身超过字符串长度上限，请检查该条源数据`,
      )
    }
    parts.push(part)
  }

  for await (const chunk of chunks) {
    if (cancelled()) throw new Error('任务已取消')
    let segmentStart = state === 'record' ? 0 : -1
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const character = chunk[offset]
      if (state === 'record') {
        if (inString) {
          if (escaped) escaped = false
          else if (character === '\\') escaped = true
          else if (character === '"') inString = false
        } else if (character === '"') {
          inString = true
        } else if (character === '{' || character === '[') {
          depth += 1
        } else if (character === '}' || character === ']') {
          depth -= 1
          if (depth === 0) {
            append(chunk.slice(segmentStart, offset + 1))
            let patent: ParsedPatent
            try {
              patent = JSON.parse(parts.join('')) as ParsedPatent
            } catch {
              throw invalid()
            }
            if (
              !patent ||
              Array.isArray(patent) ||
              typeof patent.patent_number !== 'string' ||
              !patent.patent_number
            ) {
              throw invalid()
            }
            parts = []
            characters = 0
            segmentStart = -1
            state = 'comma'
            if (cancelled()) throw new Error('任务已取消')
            yield { patent, index: index++ }
          }
        }
        continue
      }
      if (' \t\r\n'.includes(character)) continue
      if (state === 'start' && character === '\uFEFF') continue
      if (state === 'start' && character === '[') {
        state = 'item'
      } else if ((state === 'item' || state === 'next') && character === '{') {
        segmentStart = offset
        depth = 1
        inString = false
        escaped = false
        state = 'record'
      } else if ((state === 'item' || state === 'comma') && character === ']') {
        state = 'done'
      } else if (state === 'comma' && character === ',') {
        state = 'next'
      } else {
        throw invalid()
      }
    }
    if (segmentStart >= 0) append(chunk.slice(segmentStart))
  }
  if (cancelled()) throw new Error('任务已取消')
  if (state !== 'done') throw invalid()
}

export async function* readParsedPatentFile(
  filePath: string,
  cancelled?: () => boolean,
): AsyncGenerator<PatentRecord> {
  const input = fs.createReadStream(filePath, {
    encoding: 'utf8',
    highWaterMark: 64 * 1024,
  })
  try {
    yield* parseParsedPatentChunks(input, cancelled)
  } finally {
    input.destroy()
  }
}

export async function indexParsedPatentFile(
  filePath: string,
  cancelled?: () => boolean,
): Promise<{ latestIndexes: Map<string, number>; recordCount: number }> {
  const latestIndexes = new Map<string, number>()
  let recordCount = 0
  for await (const { patent, index } of readParsedPatentFile(
    filePath,
    cancelled,
  )) {
    latestIndexes.set(getPatentImportKey(patent), index)
    recordCount += 1
  }
  return { latestIndexes, recordCount }
}

export async function* readPatentImportGroups(
  filePath: string,
  latestIndexes: Map<string, number>,
  importedKeys: Set<string>,
  concurrency: number,
  cancelled?: () => boolean,
): AsyncGenerator<ParsedPatent[][]> {
  let group: ParsedPatent[][] = []
  let chunk: ParsedPatent[] = []
  for await (const { patent, index } of readParsedPatentFile(
    filePath,
    cancelled,
  )) {
    const key = getPatentImportKey(patent)
    if (latestIndexes.get(key) !== index || importedKeys.has(key)) continue
    chunk.push(patent)
    if (chunk.length === 100) {
      group.push(chunk)
      chunk = []
      if (group.length === concurrency) {
        yield group
        group = []
      }
    }
  }
  if (chunk.length) group.push(chunk)
  if (group.length) yield group
}

export async function writeParsedPatentFile(
  filePath: string,
  patents: Iterable<ParsedPatent>,
  cancelled: () => boolean = () => false,
): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  function* jsonChunks() {
    yield '['
    let first = true
    for (const patent of patents) {
      if (cancelled()) throw new Error('任务已取消')
      yield `${first ? '' : ','}${JSON.stringify(patent)}`
      first = false
    }
    if (cancelled()) throw new Error('任务已取消')
    yield ']'
  }
  try {
    await pipeline(
      Readable.from(jsonChunks()),
      fs.createWriteStream(temporaryPath),
    )
    await fs.promises.rename(temporaryPath, filePath)
  } catch (error) {
    await fs.promises.unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}
