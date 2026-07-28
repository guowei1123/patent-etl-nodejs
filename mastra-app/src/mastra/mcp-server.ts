import { MCPServer } from '@mastra/mcp'
import { patentApiTools } from './tools/patent-api-tools.js'

console.error('Starting MCP server...')
console.error('Tools:', Object.keys(patentApiTools))

const server = new MCPServer({
  id: 'patent-mcp-server',
  name: '专利查询 MCP 服务',
  version: '1.0.0',
  description: '提供专利搜索接口的 MCP 服务',
  tools: patentApiTools,
})

console.error('Server created, starting stdio...')
await server.startStdio()
