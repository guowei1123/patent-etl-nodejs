import { Mastra } from '@mastra/core'
import { MCPClient } from '@mastra/mcp'
import { Agent } from '@mastra/core/agent'
import { ModelsDevGateway } from '@mastra/core/llm'
import { resolve } from 'node:path'
import { patentSearchTool } from './tools/patent-search.js'

const deepseekProviderConfig = {
  url: 'https://api.deepseek.com/v1',
  apiKeyEnvVar: 'DEEPSEEK_API_KEY',
  apiKeyHeader: 'Authorization',
  name: 'DeepSeek',
  models: ['deepseek-chat', 'deepseek-reasoner'],
  gateway: 'models.dev',
  modelOverrides: {
    'deepseek-chat': {
      shape: 'completions' as const,
    },
    'deepseek-reasoner': {
      shape: 'completions' as const,
    },
  },
}

export const deepseekGateway = new ModelsDevGateway({
  deepseek: deepseekProviderConfig,
})

const mcpServerPath = process.env.MCP_SERVER_PATH || resolve(process.cwd(), 'src', 'mastra', 'mcp-server.ts')

export const mcpClient = new MCPClient({
  servers: {
    patentApi: {
      command: 'npx',
      args: ['tsx', mcpServerPath],
      env: {
        PATENT_API_URL: process.env.PATENT_API_URL || 'http://localhost:3000',
      },
    },
  },
})

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  const timeout = new Promise<never>((_, reject) => 
    setTimeout(() => reject(new Error('timeout')), timeoutMs)
  )
  try {
    return await Promise.race([promise, timeout])
  } catch {
    return fallback
  }
}

const mcpTools = await withTimeout(
  mcpClient.listTools(),
  5000,
  {}
)

const mcpServerProxies = await withTimeout(
  mcpClient.toMCPServerProxies(),
  5000,
  {}
)

export const patentAgent = new Agent({
  id: 'patent-agent',
  name: '专利问答助手',
  instructions:
    '你是一个专业的专利问答助手，专注于新能源汽车领域的专利信息查询与分析。你的能力包括：1. 根据用户的自然语言描述，查询专利分类号（IPC/CPC）；2. 解释专利术语和技术概念；3. 辅助用户理解专利检索式。请用中文回答，保持专业、准确、简洁。',
  model: 'deepseek/deepseek-chat',
  tools: { patentSearchTool, ...mcpTools },
})

export const mastra = new Mastra({
  gateways: {
    deepseek: deepseekGateway,
  },
  agents: { patentAgent },
  mcpServers: mcpServerProxies,
})
