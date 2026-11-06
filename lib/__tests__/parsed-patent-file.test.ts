import fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ParsedPatent } from '@/types'
import {
  getPatentImportKey,
  indexParsedPatentFile,
  parseParsedPatentChunks,
  readParsedPatentFile,
  readPatentImportGroups,
  writeParsedPatentFile,
} from '../etl/parsed-patent-file'

const directories: string[] = []
function filePath() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'parsed-patent-file-'),
  )
  directories.push(directory)
  return path.join(directory, 'parsed.json')
}
function patent(number: string): ParsedPatent {
  return { patent_number: number, patent_type: 'invention', title: number }
}
async function* parts(text: string, size: number) {
  for (let index = 0; index < text.length; index += size) {
    yield text.slice(index, index + size)
  }
}
async function collect<T>(records: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = []
  for await (const record of records) output.push(record)
  return output
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('streamed parsed.json', () => {
  it('handles every chunk boundary, nested values and escaped string delimiters', async () => {
    const patents = [
      {
        ...patent('1'),
        title: '中文 }, ] , " \\ 换行\n',
        priority_info: { values: [{ text: '{[()]}' }] },
      },
      { ...patent('2'), claims_structured: [] },
    ]
    const text = '\uFEFF\n' + JSON.stringify(patents, null, 2)
    for (const size of [1, 2, 7, 64, text.length]) {
      const records = await collect(parseParsedPatentChunks(parts(text, size)))
      expect(records.map((record) => record.patent)).toEqual(patents)
      expect(records.map((record) => record.index)).toEqual([0, 1])
    }
  })

  it('rejects truncated arrays, missing commas, trailing commas and trailing content', async () => {
    const record = JSON.stringify(patent('1'))
    for (const text of [
      '',
      record,
      `[${record}`,
      `[${record},]`,
      `[${record}${record}]`,
      `[${record}]extra`,
      '[{}]',
      '[null]',
      '[{"patent_number":"1","title":}]',
    ]) {
      await expect(
        collect(parseParsedPatentChunks(parts(text, 2))),
      ).rejects.toThrow('parsed.json')
    }
    expect(await collect(parseParsedPatentChunks(parts(' [] \n', 1)))).toEqual(
      [],
    )
  })

  it('streams UTF-8 records longer than the read buffer without synchronous full-file reads', async () => {
    const target = filePath()
    const source = [
      { ...patent('1'), abstract: '中文\\"}]'.repeat(20000) },
      { ...patent('2'), description: '长说明书'.repeat(20000) },
    ]
    fs.writeFileSync(target, JSON.stringify(source))
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('禁止整文件读取')
    })
    const result = await collect(readParsedPatentFile(target))
    expect(result.map((record) => record.patent)).toEqual(source)
  })

  it('indexes duplicate keys with last-record-wins semantics and bounds import groups', async () => {
    const target = filePath()
    const source = Array.from({ length: 305 }, (_, index) =>
      patent(String(index)),
    )
    source.push({ ...patent('0'), title: '最后一条覆盖旧数据' })
    source.push({ ...patent('1'), kind: 'U' })
    fs.writeFileSync(target, JSON.stringify(source))
    const { latestIndexes, recordCount } = await indexParsedPatentFile(target)
    expect(recordCount).toBe(307)
    expect(latestIndexes.size).toBe(306)
    expect(latestIndexes.get(getPatentImportKey(patent('0')))).toBe(305)
    const imported = new Set([getPatentImportKey(patent('2'))])
    const groups = await collect(
      readPatentImportGroups(target, latestIndexes, imported, 2),
    )
    expect(groups.map((group) => group.map((chunk) => chunk.length))).toEqual([
      [100, 100],
      [100, 5],
    ])
    const remaining = groups.flat(2)
    expect(remaining.filter((record) => record.patent_number === '0')).toEqual([
      { ...patent('0'), title: '最后一条覆盖旧数据' },
    ])
    expect(remaining.some((record) => record.patent_number === '2')).toBe(false)
    expect(
      remaining.filter((record) => record.patent_number === '1'),
    ).toHaveLength(2)
  })

  it('writes individual records atomically and preserves the old file on a write failure', async () => {
    const target = filePath()
    fs.writeFileSync(target, 'original')
    const source = [
      patent('1'),
      { ...patent('2'), abstract: '说明书'.repeat(50000) },
    ]
    const stringify = vi.spyOn(JSON, 'stringify')
    await writeParsedPatentFile(target, source)
    expect(stringify.mock.calls.every(([value]) => !Array.isArray(value))).toBe(
      true,
    )
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(source)
    const previous = fs.readFileSync(target, 'utf8')
    function* broken() {
      yield patent('3')
      throw new Error('写入中断')
    }
    await expect(writeParsedPatentFile(target, broken())).rejects.toThrow(
      '写入中断',
    )
    expect(fs.readFileSync(target, 'utf8')).toBe(previous)
    expect(fs.readdirSync(path.dirname(target))).toEqual(['parsed.json'])
  })

  it('supports cancellation during indexing and stops reading after early iterator closure', async () => {
    const target = filePath()
    fs.writeFileSync(target, JSON.stringify([patent('1'), patent('2')]))
    await expect(indexParsedPatentFile(target, () => true)).rejects.toThrow(
      '任务已取消',
    )
    const reader = readParsedPatentFile(target)
    expect((await reader.next()).value?.patent).toEqual(patent('1'))
    await reader.return(undefined)
    expect((await reader.next()).done).toBe(true)
  })
})
