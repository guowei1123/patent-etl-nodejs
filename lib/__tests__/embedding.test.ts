import { createOpenAI } from '@ai-sdk/openai'
import { embed, embedMany } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getEmbedding,
  getEmbeddingBatchSize,
  getEmbeddingConcurrency,
  getEmbeddingDimensions,
  getEmbeddingModel,
  getEmbeddings,
  isEmbeddingConfigured,
} from '../embedding'

const mocks = vi.hoisted(() => ({
  embed: vi.fn(),
  embedMany: vi.fn(),
  embeddingModel: vi.fn((model: string) => ({ provider: 'openai', model })),
}))

vi.mock('ai', () => ({
  embed: mocks.embed,
  embedMany: mocks.embedMany,
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => ({
    embedding: mocks.embeddingModel,
  })),
}))

describe('embedding configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('requires an embedding model', () => {
    vi.stubEnv('OPENAI_EMBEDDING_MODEL', '')

    expect(() => getEmbeddingModel()).toThrow(
      '缺少 OPENAI_EMBEDDING_MODEL 配置',
    )
    expect(getEmbeddingModel('custom-embedding')).toBe('custom-embedding')
  })

  it('parses optional embedding dimensions', () => {
    expect(getEmbeddingDimensions(undefined)).toBeUndefined()
    expect(getEmbeddingDimensions('1024')).toBe(1024)
    expect(getEmbeddingDimensions(1536)).toBe(1536)
    expect(() => getEmbeddingDimensions('0')).toThrow(
      'OPENAI_EMBEDDING_DIMENSIONS 必须是正整数',
    )
  })

  it('uses a conservative default embedding batch size', () => {
    expect(getEmbeddingBatchSize(undefined)).toBe(10)
    expect(getEmbeddingBatchSize('8')).toBe(8)
    expect(getEmbeddingBatchSize(2)).toBe(2)
    expect(() => getEmbeddingBatchSize('0')).toThrow(
      'OPENAI_EMBEDDING_BATCH_SIZE 必须是正整数',
    )
  })

  it('uses a conservative default embedding concurrency', () => {
    expect(getEmbeddingConcurrency(undefined)).toBe(3)
    expect(getEmbeddingConcurrency('4')).toBe(4)
    expect(getEmbeddingConcurrency(2)).toBe(2)
    expect(() => getEmbeddingConcurrency('0')).toThrow(
      'OPENAI_EMBEDDING_CONCURRENCY 必须是正整数',
    )
  })

  it('reports whether API key and embedding model are configured', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key')
    vi.stubEnv('OPENAI_EMBEDDING_MODEL', 'test-model')
    expect(isEmbeddingConfigured()).toBe(true)

    vi.stubEnv('OPENAI_EMBEDDING_MODEL', '')
    expect(isEmbeddingConfigured()).toBe(false)
  })

  it('embeds a single query through the AI SDK OpenAI provider', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key')
    vi.stubEnv('OPENAI_BASE_URL', 'https://example.test/v1')
    vi.mocked(embed).mockResolvedValue({
      embedding: [0.1, 0.2, 0.3],
    } as Awaited<ReturnType<typeof embed>>)

    await expect(
      getEmbedding('锂电池隔膜', {
        model: 'text-embedding-3-small',
        dimensions: 1024,
        timeout: 0,
        maxRetries: 0,
      }),
    ).resolves.toEqual([0.1, 0.2, 0.3])

    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'https://example.test/v1',
    })
    expect(mocks.embeddingModel).toHaveBeenCalledWith('text-embedding-3-small')
    expect(embed).toHaveBeenCalledWith({
      model: { provider: 'openai', model: 'text-embedding-3-small' },
      value: '锂电池隔膜',
      providerOptions: {
        openai: {
          dimensions: 1024,
        },
      },
      maxRetries: 0,
      abortSignal: undefined,
    })
  })

  it('embeds document batches without calling the provider for empty input', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key')
    vi.mocked(embedMany)
      .mockResolvedValueOnce({
        embeddings: [[1], [2]],
      } as Awaited<ReturnType<typeof embedMany>>)
      .mockResolvedValueOnce({
        embeddings: [[3]],
      } as Awaited<ReturnType<typeof embedMany>>)

    await expect(
      getEmbeddings(['a', 'b', 'c'], {
        model: 'text-embedding-3-small',
        batchSize: 2,
        concurrency: 1,
        timeout: 0,
      }),
    ).resolves.toEqual([[1], [2], [3]])

    expect(embedMany).toHaveBeenNthCalledWith(1, {
      model: { provider: 'openai', model: 'text-embedding-3-small' },
      values: ['a', 'b'],
      providerOptions: undefined,
      maxRetries: 1,
      abortSignal: undefined,
    })
    expect(embedMany).toHaveBeenNthCalledWith(2, {
      model: { provider: 'openai', model: 'text-embedding-3-small' },
      values: ['c'],
      providerOptions: undefined,
      maxRetries: 1,
      abortSignal: undefined,
    })

    vi.clearAllMocks()
    await expect(getEmbeddings([])).resolves.toEqual([])
    expect(embedMany).not.toHaveBeenCalled()
  })

  it('embeds batches concurrently while preserving result order', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key')
    const resolvers: Array<
      (value: Awaited<ReturnType<typeof embedMany>>) => void
    > = []
    vi.mocked(embedMany).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        }),
    )

    const promise = getEmbeddings(['a', 'b', 'c', 'd'], {
      model: 'text-embedding-3-small',
      batchSize: 2,
      concurrency: 2,
      timeout: 0,
    })

    await vi.waitFor(() => expect(embedMany).toHaveBeenCalledTimes(2))
    resolvers[1]({
      embeddings: [[3], [4]],
    } as Awaited<ReturnType<typeof embedMany>>)
    resolvers[0]({
      embeddings: [[1], [2]],
    } as Awaited<ReturnType<typeof embedMany>>)

    await expect(promise).resolves.toEqual([[1], [2], [3], [4]])
  })

  it('requires an API key before embedding', async () => {
    vi.stubEnv('OPENAI_API_KEY', '')

    await expect(getEmbedding('query')).rejects.toThrow(
      '缺少 OPENAI_API_KEY 配置',
    )
  })
})
