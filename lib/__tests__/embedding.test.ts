import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getEmbeddingDimensions,
  getEmbeddingModel,
  isEmbeddingConfigured,
} from '../embedding'

describe('embedding configuration', () => {
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

  it('reports whether API key and embedding model are configured', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key')
    vi.stubEnv('OPENAI_EMBEDDING_MODEL', 'test-model')
    expect(isEmbeddingConfigured()).toBe(true)

    vi.stubEnv('OPENAI_EMBEDDING_MODEL', '')
    expect(isEmbeddingConfigured()).toBe(false)
  })
})
