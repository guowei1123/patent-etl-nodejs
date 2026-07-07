import { embed, embedMany } from 'ai'
import { getEmbeddingModelProvider } from './ai-provider.ts'

type EmbeddingProviderOptions = NonNullable<
  Parameters<typeof embed>[0]['providerOptions']
>

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

function getEmbeddingRequestOptions(options: EmbeddingClientOptions) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('缺少 OPENAI_API_KEY 配置，无法生成向量')
  }

  const model = getEmbeddingModel(options.model)
  const dimensions =
    options.dimensions ??
    getEmbeddingDimensions(process.env.OPENAI_EMBEDDING_DIMENSIONS)

  return {
    model: getEmbeddingModelProvider(model),
    maxRetries: options.maxRetries ?? 1,
    providerOptions: dimensions
      ? ({
          openai: {
            dimensions,
          },
        } satisfies EmbeddingProviderOptions)
      : undefined,
    timeout: options.timeout ?? 120000,
  }
}

async function withTimeout<T>(
  timeout: number | undefined,
  run: (abortSignal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  if (!timeout) return run(undefined)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timeoutId)
  }
}

function getBatchSize(options: EmbeddingClientOptions): number {
  const batchSize = options.batchSize ?? 64
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw new Error('batchSize 必须是正整数')
  }
  return Math.trunc(batchSize)
}

export async function getEmbedding(
  text: string,
  options: EmbeddingClientOptions = {},
): Promise<number[]> {
  const requestOptions = getEmbeddingRequestOptions(options)
  const result = await withTimeout(requestOptions.timeout, (abortSignal) =>
    embed({
      model: requestOptions.model,
      value: text,
      providerOptions: requestOptions.providerOptions,
      maxRetries: requestOptions.maxRetries,
      abortSignal,
    }),
  )

  return result.embedding
}

export async function getEmbeddings(
  texts: string[],
  options: EmbeddingClientOptions = {},
): Promise<number[][]> {
  if (texts.length === 0) return []

  const requestOptions = getEmbeddingRequestOptions(options)
  const batchSize = getBatchSize(options)
  const embeddings: number[][] = []

  for (let index = 0; index < texts.length; index += batchSize) {
    const values = texts.slice(index, index + batchSize)
    const result = await withTimeout(requestOptions.timeout, (abortSignal) =>
      embedMany({
        model: requestOptions.model,
        values,
        providerOptions: requestOptions.providerOptions,
        maxRetries: requestOptions.maxRetries,
        abortSignal,
      }),
    )
    embeddings.push(...result.embeddings)
  }

  return embeddings
}
