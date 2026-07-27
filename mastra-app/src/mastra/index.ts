import { Mastra } from '@mastra/core'
import { patentAgent } from './agents/patent-agent'

export const mastra = new Mastra({
  agents: { patentAgent },
})
