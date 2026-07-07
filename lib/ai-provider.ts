import { createOpenAI } from '@ai-sdk/openai'

function normalizeRequiredEnv(value: string | undefined, message: string): string {
  const normalized = value?.trim()
  if (!normalized) throw new Error(message)
  return normalized
}

export function createOpenAICompatibleProvider() {
  const apiKey = normalizeRequiredEnv(
    process.env.OPENAI_API_KEY,
    '缺少 OPENAI_API_KEY 配置，无法调用 OpenAI 兼容服务',
  )
  const baseURL = process.env.OPENAI_BASE_URL?.trim()

  return createOpenAI({
    apiKey,
    baseURL: baseURL || undefined,
  })
}

export function getChatModel(model = process.env.OPENAI_CHAT_MODEL) {
  const modelName = normalizeRequiredEnv(
    model,
    '缺少 OPENAI_CHAT_MODEL 配置，无法生成检索式',
  )

  return createOpenAICompatibleProvider().chat(modelName)
}

export function getEmbeddingModelProvider(model: string) {
  return createOpenAICompatibleProvider().embedding(model)
}
