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
      if (sql.includes('INSERT INTO cnipa.patent (')) {
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

  it('stores patent images and refreshes abstract figure on upsert', async () => {
    const client = createClient((sql, params = []) => {
      if (sql.includes('INSERT INTO cnipa.patent (')) {
        expect(sql).toContain('abstract_fig_key = EXCLUDED.abstract_fig_key')
        expect(params[13]).toBe('100001.jpg')
        return {
          rows: [
            {
              id: 'patent-id-1',
              doc_number: '100001',
              kind: 'B',
              is_new: false,
            },
          ],
          rowCount: 1,
        }
      }

      return { rows: [], rowCount: 0 }
    })
    pgMock.connect.mockResolvedValue(client)

    const imagePatent = patent('100001')
    imagePatent.abstract_figure = '100001.jpg'
    imagePatent.images = [
      {
        file_name: '100001.jpg',
        oss_key: 'patents/batch-1/100001/100001.jpg',
        content_type: 'image/jpeg',
        size: 4,
        is_abstract: true,
      },
    ]

    const { insertPatents } = await import('../db')
    const result = await insertPatents('batch-1', [imagePatent])

    expect(result.insertedCount).toBe(1)
    expect(client.query).toHaveBeenCalledWith(
      'DELETE FROM cnipa.patent_image WHERE patent_id = ANY($1::uuid[])',
      [['patent-id-1']],
    )
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO cnipa.patent_image'),
      [
        'patent-id-1',
        '100001.jpg',
        'patents/batch-1/100001/100001.jpg',
        'image/jpeg',
        4,
        null,
        null,
        true,
      ],
    )
  })
})

describe('deleteBatch', () => {
  beforeEach(() => {
    vi.resetModules()
    pgMock.connect.mockReset()
    pgMock.query.mockReset()
  })

  it('deletes imported patents and the batch record in one transaction', async () => {
    const client = createClient((sql) => {
      if (sql.includes('DELETE FROM cnipa.patent')) {
        return { rows: [{ count: '3' }], rowCount: 1 }
      }

      return { rows: [], rowCount: 0 }
    })
    pgMock.connect.mockResolvedValue(client)

    const { deleteBatch } = await import('../db')
    const result = await deleteBatch('batch-1')

    expect(result.deletedPatents).toBe(3)
    expect(client.query).toHaveBeenCalledWith('BEGIN')
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM cnipa.patent'),
      ['batch-1'],
    )
    expect(client.query).toHaveBeenCalledWith(
      'DELETE FROM sync_batches WHERE batch_code = $1',
      ['batch-1'],
    )
    expect(client.query).toHaveBeenCalledWith('COMMIT')
    expect(client.release).toHaveBeenCalled()
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

  it('recreates dependent views around patent kind column migration', async () => {
    const client = createClient((sql, params = []) => {
      if (sql.includes('information_schema.columns')) {
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
      }

      if (sql.includes('pg_get_viewdef')) {
        return {
          rows: [
            {
              schema_name: 'cnipa',
              view_name: 'v_patent_stats_by_type',
              definition:
                'SELECT kind, count(*) AS total FROM cnipa.patent GROUP BY kind;',
            },
          ],
          rowCount: 1,
        }
      }

      return { rows: [], rowCount: 0 }
    })
    pgMock.connect.mockResolvedValue(client)

    const { initializeDatabase } = await import('../db')
    await initializeDatabase()

    const queries = client.query.mock.calls.map(([sql]) => sql)
    const dropIndex = queries.indexOf(
      'DROP VIEW "cnipa"."v_patent_stats_by_type"',
    )
    const alterIndex = queries.indexOf(
      'ALTER TABLE cnipa.patent ALTER COLUMN kind TYPE TEXT USING kind::TEXT',
    )
    const createIndex = queries.indexOf(
      'CREATE VIEW "cnipa"."v_patent_stats_by_type" AS SELECT kind, count(*) AS total FROM cnipa.patent GROUP BY kind;',
    )

    expect(dropIndex).toBeGreaterThanOrEqual(0)
    expect(alterIndex).toBeGreaterThan(dropIndex)
    expect(createIndex).toBeGreaterThan(alterIndex)
  })

  it('relaxes the legacy patent kind check constraint for multi-character kind codes', async () => {
    const client = createClient((sql) => {
      if (sql.includes('information_schema.columns')) {
        return { rows: [{ column_name: 'kind', data_type: 'text' }], rowCount: 1 }
      }

      if (sql.includes('pg_get_constraintdef')) {
        return {
          rows: [
            {
              definition:
                "CHECK (kind = ANY (ARRAY['B'::bpchar::text, 'U'::bpchar::text]))",
            },
          ],
          rowCount: 1,
        }
      }

      return { rows: [], rowCount: 0 }
    })
    pgMock.connect.mockResolvedValue(client)

    const { initializeDatabase } = await import('../db')
    await initializeDatabase()

    expect(client.query).toHaveBeenCalledWith(
      'ALTER TABLE cnipa.patent DROP CONSTRAINT chk_patent_kind',
    )
    expect(client.query).toHaveBeenCalledWith(
      `ALTER TABLE cnipa.patent
       ADD CONSTRAINT chk_patent_kind
       CHECK (kind ~ '^[A-Za-z0-9]{1,4}$')`,
    )
  })
})
