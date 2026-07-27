import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

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

export { patentSearchTool };
