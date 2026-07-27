import {
  createWorkflow,
  createStep,
} from '@mastra/core/workflows'
import { z } from 'zod'

const searchStep = createStep({
  id: 'search-classification',
  inputSchema: z.object({ query: z.string() }),
  outputSchema: z.object({ results: z.array(z.any()) }),
  execute: async ({ inputData }) => {
    const mockResults = [
      { code: 'H01M', title: '电池制造或电极处理' },
      { code: 'H02J', title: '电池集合或电池组' },
      { code: 'B60L', title: '电动车辆动力装置' },
    ]
    return { results: mockResults, query: inputData.query }
  },
})

export const patentWorkflow = createWorkflow({
  id: 'patent-search-workflow',
  inputSchema: z.object({ query: z.string() }),
  outputSchema: z.object({ results: z.array(z.any()) }),
})
  .then(searchStep)
  .commit()
