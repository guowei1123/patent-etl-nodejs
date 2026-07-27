import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

export const patentSearchTool = createTool({
  id: 'patent-search',
  description: '根据关键词查询 IPC 专利分类号',
  inputSchema: z.object({
    query: z.string().describe('搜索关键词，如 battery, motor, charger'),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        code: z.string(),
        title: z.string(),
      }),
    ),
  }),
  execute: async ({ query }) => {
    const mockResults = [
      { code: 'H01M', title: '电池制造或电极处理' },
      { code: 'H02J', title: '电池集合或电池组' },
      { code: 'B60L', title: '电动车辆动力装置' },
      { code: 'H02K', title: '电机/电动机' },
      { code: 'H02M', title: '变换交流/直流的装置' },
    ]
    const lower = query.toLowerCase()
    const results = mockResults.filter(
      (r) =>
        r.title.toLowerCase().includes(lower) ||
        r.code.toLowerCase().includes(lower),
    )
    return { results: results.length > 0 ? results : mockResults }
  },
})
