import fs from 'node:fs'
import path from 'node:path'

const dir = 'd:\\研一文件\\新能源汽车智能问答系统项目\\patent\\patent-mastra'

fs.writeFileSync(
  path.join(dir, 'src/mastra/index.ts'),
  `import { Mastra } from '@mastra/core'\nimport { patentAgent } from './agents/patent-agent'\n\nexport const mastra = new Mastra({\n  agents: { patentAgent },\n})\n`,
)

fs.writeFileSync(
  path.join(dir, 'src/mastra/agents/patent-agent.ts'),
  `import { Agent } from '@mastra/core/agent'\n\nexport const patentAgent = new Agent({\n  id: 'patent-agent',\n  name: '专利问答助手',\n  instructions: '你是一个专业的专利问答助手，专注于新能源汽车领域的专利信息查询与分析。请用中文回答，保持专业、准确、简洁。',\n  model: 'openai/deepseek-chat',\n})\n`,
)

fs.writeFileSync(
  path.join(dir, 'src/mastra/tools/patent-search.ts'),
  `import { createTool } from '@mastra/core/tools'\nimport { z } from 'zod'\n\nexport const patentSearchTool = createTool({\n  id: 'patent-search',\n  description: '根据关键词查询 IPC 专利分类号',\n  inputSchema: z.object({\n    query: z.string().describe('搜索关键词，如 battery, motor, charger'),\n  }),\n  outputSchema: z.object({\n    results: z.array(z.object({\n      code: z.string(),\n      title: z.string(),\n    })),\n  }),\n  execute: async ({ query }) => {\n    const mockResults = [\n      { code: 'H01M', title: '电池制造或电极处理' },\n      { code: 'H02J', title: '电池集合或电池组' },\n      { code: 'B60L', title: '电动车辆动力装置' },\n    ]\n    const lower = query.toLowerCase()\n    const results = mockResults.filter(r =>\n      r.title.toLowerCase().includes(lower) || r.code.toLowerCase().includes(lower)\n    )\n    return { results: results.length > 0 ? results : mockResults }\n  },\n})\n`,
)

fs.writeFileSync(
  path.join(dir, 'src/mastra/workflows/patent-workflow.ts'),
  `import { createWorkflow, createStep } from '@mastra/core/workflows'\nimport { z } from 'zod'\n\nconst searchStep = createStep({\n  id: 'search-classification',\n  inputSchema: z.object({ query: z.string() }),\n  outputSchema: z.object({ results: z.array(z.any()) }),\n  execute: async ({ inputData }) => {\n    return { results: [], query: inputData.query }\n  },\n})\n\nexport const patentWorkflow = createWorkflow({\n  id: 'patent-search-workflow',\n  inputSchema: z.object({ query: z.string() }),\n  outputSchema: z.object({ results: z.array(z.any()) }),\n})\n  .then(searchStep)\n  .commit()\n`,
)

console.log('All source files written')
