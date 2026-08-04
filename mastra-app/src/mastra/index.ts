import { Mastra } from '@mastra/core'
import { MCPClient } from '@mastra/mcp'
import { Agent } from '@mastra/core/agent'
import { ModelsDevGateway } from '@mastra/core/llm'
import { resolve } from 'node:path'

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
        ...process.env,
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

const { tools: mcpTools, errors: mcpToolErrors } = await withTimeout(
  mcpClient.listToolsWithErrors(),
  15000,
  { tools: {}, errors: {} }
)

console.error('MCP tools loaded:', Object.keys(mcpTools))
if (Object.keys(mcpToolErrors).length > 0) {
  console.error('MCP tool loading errors:', mcpToolErrors)
}
if (Object.keys(mcpTools).length === 0) {
  throw new Error('没有可用的 MCP 工具，请检查 mcp-server.ts 是否正常运行')
}

const mcpServerProxies = mcpClient.toMCPServerProxies()

export const patentAgent = new Agent({
  id: 'patent-agent',
  name: '专利问答助手',
  instructions:
    '你是一个专业的专利问答助手，专注于新能源汽车领域的专利信息查询与分析。\n' +
    '你的核心任务是回答与专利数据相关的问题。可用工具：patentApi_search_patents。\n' +
    '调用规则（必须严格遵守）：\n' +
    '1. 只要用户的问题涉及具体专利数据，包括但不限于：IPC/CPC 分类号、公开号、申请人、专利名称、关键词、专利数量、专利列表、"查询"、"有多少"、"列出"、"是否存在"，你必须调用 patentApi_search_patents 工具查询真实专利数据库，不能凭自身知识编造数据。\n' +
    '2. 当用户给出一个 IPC/CPC 分类号（如 G09G、G09G 3/3208、H01M 10/42）时，直接调用 patentApi_search_patents，把该分类号作为 expression 参数（如 expression="IPC=(G09G)"）进行查询。\n' +
    '3. 只有当用户明确询问某个术语或分类号的含义、要求解释概念、或进行开放式闲聊时，才可以用自身知识回答。\n' +
    '4. 请用中文回答，保持专业、准确、简洁。',
  model: 'deepseek/deepseek-chat',
  tools: { ...mcpTools },
})

export const mastra = new Mastra({
  gateways: {
    deepseek: deepseekGateway,
  },
  agents: { patentAgent },
  mcpServers: mcpServerProxies,
})
