import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

"use strict";
const patentSearchTool = createTool({
  id: "patent-search",
  description: "\u6839\u636E\u5173\u952E\u8BCD\u67E5\u8BE2 IPC \u4E13\u5229\u5206\u7C7B\u53F7",
  inputSchema: z.object({
    query: z.string().describe("\u641C\u7D22\u5173\u952E\u8BCD\uFF0C\u5982 battery, motor, charger")
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        code: z.string(),
        title: z.string()
      })
    )
  }),
  execute: async ({ query }) => {
    const mockResults = [
      { code: "H01M", title: "\u7535\u6C60\u5236\u9020\u6216\u7535\u6781\u5904\u7406" },
      { code: "H02J", title: "\u7535\u6C60\u96C6\u5408\u6216\u7535\u6C60\u7EC4" },
      { code: "B60L", title: "\u7535\u52A8\u8F66\u8F86\u52A8\u529B\u88C5\u7F6E" },
      { code: "H02K", title: "\u7535\u673A/\u7535\u52A8\u673A" },
      { code: "H02M", title: "\u53D8\u6362\u4EA4\u6D41/\u76F4\u6D41\u7684\u88C5\u7F6E" }
    ];
    const lower = query.toLowerCase();
    const results = mockResults.filter(
      (r) => r.title.toLowerCase().includes(lower) || r.code.toLowerCase().includes(lower)
    );
    return { results: results.length > 0 ? results : mockResults };
  }
});

"use strict";
const patentAgent = new Agent({
  id: "patent-agent",
  name: "\u4E13\u5229\u95EE\u7B54\u52A9\u624B",
  instructions: "\u4F60\u662F\u4E00\u4E2A\u4E13\u4E1A\u7684\u4E13\u5229\u95EE\u7B54\u52A9\u624B\uFF0C\u4E13\u6CE8\u4E8E\u65B0\u80FD\u6E90\u6C7D\u8F66\u9886\u57DF\u7684\u4E13\u5229\u4FE1\u606F\u67E5\u8BE2\u4E0E\u5206\u6790\u3002\u4F60\u7684\u80FD\u529B\u5305\u62EC\uFF1A1. \u6839\u636E\u7528\u6237\u7684\u81EA\u7136\u8BED\u8A00\u63CF\u8FF0\uFF0C\u67E5\u8BE2\u4E13\u5229\u5206\u7C7B\u53F7\uFF08IPC/CPC\uFF09\uFF1B2. \u89E3\u91CA\u4E13\u5229\u672F\u8BED\u548C\u6280\u672F\u6982\u5FF5\uFF1B3. \u8F85\u52A9\u7528\u6237\u7406\u89E3\u4E13\u5229\u68C0\u7D22\u5F0F\u3002\u8BF7\u7528\u4E2D\u6587\u56DE\u7B54\uFF0C\u4FDD\u6301\u4E13\u4E1A\u3001\u51C6\u786E\u3001\u7B80\u6D01\u3002",
  model: "openai/deepseek-chat",
  tools: { patentSearchTool }
});

"use strict";
const mastra = new Mastra({
  agents: {
    patentAgent
  }
});

export { mastra };
