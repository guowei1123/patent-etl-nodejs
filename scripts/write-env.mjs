import fs from 'node:fs'
const dir = 'd:\\研一文件\\新能源汽车智能问答系统项目\\patent\\patent-mastra'
fs.writeFileSync(path.join(dir, '.env'), 'OPENAI_API_KEY=sk-f8da50f240a546cc953424c9a38ad69a\nOPENAI_BASE_URL=https://api.deepseek.com/v1\n')
console.log('.env written')
