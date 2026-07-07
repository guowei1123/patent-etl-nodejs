import { OpenAIEmbeddings } from '@langchain/openai'

export type EmbeddingClientOptions = {
  model?: string
  dimensions?: number
  batchSize?: number
  timeout?: number
  maxRetries?: number
}

export function getEmbeddingModel(
  model = process.env.OPENAI_EMBEDDING_MODEL,
): string {
  const normalized = model?.trim()
  if (!normalized) {
    throw new Error('缺少 OPENAI_EMBEDDING_MODEL 配置，无法生成向量')
  }
  return normalized
}

export function getEmbeddingDimensions(
  dimensions: string | number | undefined = process.env
    .OPENAI_EMBEDDING_DIMENSIONS,
): number | undefined {
  if (!dimensions) return undefined

  const parsed =
    typeof dimensions === 'number'
      ? dimensions
      : Number.parseInt(String(dimensions), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('OPENAI_EMBEDDING_DIMENSIONS 必须是正整数')
  }
  return parsed
}

export function isEmbeddingConfigured(): boolean {
  return Boolean(
    process.env.OPENAI_API_KEY && process.env.OPENAI_EMBEDDING_MODEL,
  )
}

export function createEmbeddingClient(
  options: EmbeddingClientOptions = {},
): OpenAIEmbeddings {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('缺少 OPENAI_API_KEY 配置，无法生成向量')
  }

  const model = getEmbeddingModel(options.model)
  const dimensions =
    options.dimensions ??
    getEmbeddingDimensions(process.env.OPENAI_EMBEDDING_DIMENSIONS)

  return new OpenAIEmbeddings({
    model,
    dimensions,
    batchSize: options.batchSize ?? 64,
    openAIApiKey: process.env.OPENAI_API_KEY,
    configuration: process.env.OPENAI_BASE_URL
      ? {
          baseURL: process.env.OPENAI_BASE_URL,
        }
      : undefined,
    timeout: options.timeout ?? 120000,
    maxRetries: options.maxRetries ?? 1,
  })
}

export async function getEmbedding(
  text: string,
  options: EmbeddingClientOptions = {},
): Promise<number[]> {
  return createEmbeddingClient(options).embedQuery(text)
}

export async function getEmbeddings(
  texts: string[],
  options: EmbeddingClientOptions = {},
): Promise<number[][]> {
  if (texts.length === 0) return []
  return createEmbeddingClient(options).embedDocuments(texts)
}
