import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedPatent } from '@/types'

type QueryResult = {
  rows?: unknown[]
  rowCount?: number
}

type MockClient = {
  query: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
}

const pgMock = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
}))

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(function Pool() {
    return {
    connect: pgMock.connect,
    query: pgMock.query,
    }
  }),
}))

function patent(patentNumber: string): ParsedPatent {
  return {
    patent_number: patentNumber,
    patent_type: 'invention',
    title: `Patent ${patentNumber}`,
    source_file: `${patentNumber}.xml`,
  }
}

function createClient(
  handler: (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>,
): MockClient {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      return handler(sql, params)
    }),
    release: vi.fn(),
  }
}

describe('insertPatents import result', () => {
  beforeEach(() => {
    vi.resetModules()
    pgMock.connect.mockReset()
    pgMock.query.mockReset()
  })

  it('returns a single-patent failure instead of silently counting zero', async () => {
    const client = createClient((sql) => {
      if (sql.includes('INSERT INTO cnipa.patent')) {
        throw new Error('value too long for type character varying(1)')
      }
      return { rows: [], rowCount: 0 }
    })
    pgMock.connect.mockResolvedValue(client)

    const { insertPatents } = await import('../db')
    const result = await insertPatents('batch-1', [patent('100001')])

    expect(result).toEqual({
      insertedCount: 0,
      failures: [
        {
          patent_number: '100001',
          kind: 'B',
          title: 'Patent 100001',
          source_file: '100001.xml',
          error: 'value too long for type character varying(1)',
        },
      ],
    })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('keeps successful recursive inserts and preserves failed patent details', async () => {
    pgMock.connect.mockImplementation(async () =>
      createClient((sql, params = []) => {
        if (!sql.includes('INSERT INTO cnipa.patent')) {
          return { rows: [], rowCount: 0 }
        }

        const patentCount = params.length / 20
        if (patentCount > 1) {
          throw new Error('bulk insert failed')
        }

        const docNumber = String(params[0])
        const kind = String(params[1])
        if (docNumber === 'bad') {
          throw new Error('invalid input syntax for type date')
        }

        return {
          rows: [
            {
              id: `id-${docNumber}`,
              doc_number: docNumber,
              kind,
              is_new: true,
            },
          ],
          rowCount: 1,
        }
      }),
    )

    const { insertPatents } = await import('../db')
    const result = await insertPatents('batch-1', [
      patent('ok-1'),
      patent('bad'),
      patent('ok-2'),
    ])

    expect(result.insertedCount).toBe(2)
    expect(result.failures).toEqual([
      {
        patent_number: 'bad',
        kind: 'B',
        title: 'Patent bad',
        source_file: 'bad.xml',
        error: 'invalid input syntax for type date',
      },
    ])
  })
})

describe('initializeDatabase schema compatibility', () => {
  beforeEach(() => {
    vi.resetModules()
    pgMock.connect.mockReset()
    pgMock.query.mockReset()
  })

  it('migrates the main patent kind column for multi-character CNIPA kind codes', async () => {
    const client = createClient((sql, params = []) => {
      if (!sql.includes('information_schema.columns')) {
        return { rows: [], rowCount: 0 }
      }

      const table = params[1]
      const columns = params[2] as string[]
      return {
        rows: columns.map((column_name) => ({
          column_name,
          data_type:
            table === 'patent' && column_name === 'kind'
              ? 'character'
              : 'text',
        })),
        rowCount: columns.length,
      }
    })
    pgMock.connect.mockResolvedValue(client)

    const { initializeDatabase } = await import('../db')
    await initializeDatabase()

    expect(client.query).toHaveBeenCalledWith(
      'ALTER TABLE cnipa.patent ALTER COLUMN kind TYPE TEXT USING kind::TEXT',
    )
  })
})
