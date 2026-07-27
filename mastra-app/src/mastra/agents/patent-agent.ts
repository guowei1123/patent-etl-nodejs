import { Agent } from '@mastra/core/agent'
import { patentSearchTool } from '../tools/patent-search'

export const patentAgent = new Agent({
  id: 'patent-agent',
  name: '专利问答助手',
  instructions:
    '你是一个专业的专利问答助手，专注于新能源汽车领域的专利信息查询与分析。你的能力包括：1. 根据用户的自然语言描述，查询专利分类号（IPC/CPC）；2. 解释专利术语和技术概念；3. 辅助用户理解专利检索式。请用中文回答，保持专业、准确、简洁。',
  model: 'openai/deepseek-chat',
  tools: { patentSearchTool },
})
