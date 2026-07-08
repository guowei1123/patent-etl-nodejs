import { describe, expect, it, vi } from 'vitest'
import {
  assertClassificationEmbeddingDimensions,
  searchSimilarClassificationsByEmbedding,
  upsertClassificationEmbeddings,
  type EmbeddedClassificationRow,
} from '../classification-vector-search'
import type { ClassificationRow } from '@/types'

function classificationRow(
  overrides: Partial<ClassificationRow> = {},
): ClassificationRow {
  return {
    code_norm: 'H01M4/13',
    code: 'H01M 4/13',
    source_code: 'H01M0004130000',
    version: '2026.01',
    section: 'H',
    class_code: 'H01',
    subclass: 'H01M',
    main_group: '4',
    subgroup: '13',
    level: null,
    title_en: 'Electrodes',
    title_zh: '电极',
    title_zh_source: 'cnipa',
    source_file: 'EN_ipc_section_H_title_list_20260101.txt',
    ...overrides,
  }
}

function createClient(rows: unknown[] = []) {
  const query = vi.fn(async (...args: [string, unknown[]?]) => {
    void args
    return {
      rows,
      rowCount: rows.length,
    }
  })

  return {
    query,
  }
}

describe('classification vector search', () => {
  it('builds a pgvector cosine search over the current IPC classification tables', async () => {
    const client = createClient([
      {
        ...classificationRow(),
        similarity: 0.876,
        embedding_model: 'test-embedding',
        embedding_locale: 'mixed',
        embedding_dimensions: 3,
        content_hash: 'hash-1',
      },
    ])

    const result = await searchSimilarClassificationsByEmbedding(
      client as never,
      [0.1, 0.2, 0.3],
      {
        type: 'ipc',
        locale: 'mixed',
        model: 'test-embedding',
        limit: 5,
        section: 'h',
        version: '2026.01',
      },
    )

    const [sql, params] = client.query.mock.calls[0]
    expect(sql).toContain('ce.embedding <=> $1::vector')
    expect(sql).toContain('FROM cnipa.classification_embedding ce')
    expect(sql).toContain('JOIN cnipa.ipc_classification c')
    expect(sql).toContain('ce.version = $5')
    expect(sql).toContain('ce.embedding_dimensions = $6')
    expect(sql).toContain('c.section = $7')
    expect(sql).toContain('LIMIT $8')
    expect(params).toEqual([
      '[0.1,0.2,0.3]',
      'ipc',
      'mixed',
      'test-embedding',
      '2026.01',
      3,
      'H',
      5,
    ])
    expect(result[0]).toMatchObject({
      code_norm: 'H01M4/13',
      similarity: 0.876,
      similarity_percent: '87.6%',
    })
  })

  it('filters semantic search by the generated query embedding dimensions', async () => {
    const client = createClient()

    await searchSimilarClassificationsByEmbedding(
      client as never,
      [0.1, 0.2, 0.3, 0.4],
      {
        type: 'ipc',
        locale: 'mixed',
        model: 'test-embedding',
      },
    )

    const [sql, params] = client.query.mock.calls[0]
    expect(sql).toContain('ce.embedding_dimensions = $5')
    expect(sql).toContain('LIMIT $6')
    expect(params).toEqual([
      '[0.1,0.2,0.3,0.4]',
      'ipc',
      'mixed',
      'test-embedding',
      4,
      10,
    ])
  })

  it('upserts classification embeddings with model, locale, and content hash metadata', async () => {
    const client = createClient()
    const embeddedRows: EmbeddedClassificationRow[] = [
      {
        row: classificationRow(),
        content: '分类号：H01M 4/13',
        content_hash: 'hash-1',
        embedding: [0.1, 0.2, 0.3],
      },
    ]

    await upsertClassificationEmbeddings(client as never, embeddedRows, {
      type: 'ipc',
      locale: 'mixed',
      model: 'test-embedding',
      dimensions: 3,
    })

    expect(client.query).toHaveBeenNthCalledWith(
      1,
      'CREATE EXTENSION IF NOT EXISTS vector',
    )
    expect(client.query.mock.calls[1][0]).toContain(
      'CREATE TABLE IF NOT EXISTS cnipa.classification_embedding',
    )
    expect(client.query.mock.calls[2][0]).toContain("a.attname = 'embedding'")
    expect(client.query.mock.calls[3][0]).toContain(
      'USING hnsw (embedding vector_cosine_ops)',
    )
    expect(client.query.mock.calls[4][0]).toContain(
      'ON CONFLICT (type, code_norm, version, locale, embedding_model)',
    )
    expect(client.query.mock.calls[4][1]).toEqual([
      'ipc',
      'H01M4/13',
      '2026.01',
      'mixed',
      'test-embedding',
      3,
      'hash-1',
      '分类号：H01M 4/13',
      '[0.1,0.2,0.3]',
    ])
  })

  it('rejects writes when existing pgvector dimensions differ', async () => {
    const client = createClient([{ embedding_type: 'vector(1536)' }])
    const embeddedRows: EmbeddedClassificationRow[] = [
      {
        row: classificationRow(),
        content: '分类号：H01M 4/13',
        content_hash: 'hash-1',
        embedding: [0.1, 0.2, 0.3],
      },
    ]

    await expect(
      upsertClassificationEmbeddings(client as never, embeddedRows, {
        type: 'ipc',
        locale: 'mixed',
        model: 'test-embedding',
        dimensions: 3,
      }),
    ).rejects.toThrow(
      'classification_embedding.embedding 已是 1536 维，不能写入 3 维向量',
    )
  })

  it('preflights existing classification embedding table dimensions', async () => {
    const client = createClient([{ embedding_type: 'vector(1536)' }])

    await expect(
      assertClassificationEmbeddingDimensions(client as never, 1024),
    ).rejects.toThrow(
      'classification_embedding.embedding 已是 1536 维，不能写入 1024 维向量',
    )
    expect(client.query.mock.calls[0][0]).toContain('to_regclass($1)')
  })
})
