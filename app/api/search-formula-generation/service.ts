import { StringOutputParser } from '@langchain/core/output_parsers'
import { ChatPromptTemplate } from '@langchain/core/prompts'
import { RunnableSequence } from '@langchain/core/runnables'
import { ChatOpenAI } from '@langchain/openai'

export type SearchFormulaOutputFormat = 'format1' | 'format2'

const FORMULA_GENERATION_TEMPLATE = `你是一位资深的专利检索专家。请根据以下信息按照Incopat标准生成专利检索式。

关键词列表：{keywords}
IPC/CPC分类号：{ipcCodes}

Incopat检索语法说明：
- IPC字段：IPC=(分类号)，多个分类号用OR连接，如 IPC=(A61B OR G06F)
- CPC字段：CPC=(分类号)，多个分类号用OR连接，如 CPC=(A61B OR G06F)
- 标题摘要字段：TIAB=(关键词)，同时检索标题和摘要
- 逻辑运算符：AND、OR、NOT
- 括号：用于分组和明确优先级

要求：
{formatRequirements}

请直接输出检索式，不要包含任何解释或说明。`

const FORMAT1_REQUIREMENTS = `1. 生成包含关键词和IPC/CPC分类号的检索式
2. 使用标准Incopat检索语法
3. 检索式简洁明了，便于复制使用
4. 使用括号明确运算优先级
5. 结构要求：(TIAB=(关键词)) AND (IPC=(分类号) OR CPC=(分类号))
6. 示例：(TIAB=(蓝牙 AND 扭矩扳手)) AND (IPC=(B OR F OR G OR H) OR CPC=(B OR F OR G OR H))`

const FORMAT2_REQUIREMENTS = `1. 生成仅包含关键词的检索式，绝对不要包含IPC或CPC分类号
2. 使用标准Incopat检索语法
3. 检索式简洁明了，便于复制使用
4. 使用括号明确运算优先级
5. 使用TIAB字段同时检索标题和摘要
6. 示例：TIAB=(蓝牙 AND 扭矩扳手)
7. 重要：此格式只包含关键词，不包含任何IPC或CPC分类号`

const formulaPromptTemplate = ChatPromptTemplate.fromTemplate(
  FORMULA_GENERATION_TEMPLATE,
)

function createFormulaGenerationChain() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('缺少 OPENAI_API_KEY 配置，无法生成检索式')
  }

  if (!process.env.OPENAI_CHAT_MODEL) {
    throw new Error('缺少 OPENAI_CHAT_MODEL 配置，无法生成检索式')
  }

  const model = new ChatOpenAI({
    modelName: process.env.OPENAI_CHAT_MODEL,
    temperature: 0.1,
    openAIApiKey: process.env.OPENAI_API_KEY,
    configuration: process.env.OPENAI_BASE_URL
      ? {
          baseURL: process.env.OPENAI_BASE_URL,
        }
      : undefined,
    timeout: 120000,
    maxRetries: 1,
  })

  return RunnableSequence.from([
    formulaPromptTemplate,
    model,
    new StringOutputParser(),
  ])
}

export async function generateSearchFormula(params: {
  keywords: string[]
  ipcCodes: string[]
  outputFormat: SearchFormulaOutputFormat
}): Promise<{ formula: string }> {
  const { keywords, ipcCodes, outputFormat } = params
  const formatRequirements =
    outputFormat === 'format1' ? FORMAT1_REQUIREMENTS : FORMAT2_REQUIREMENTS
  const formula = await createFormulaGenerationChain().invoke({
    keywords: keywords.join('、'),
    ipcCodes: ipcCodes.join('、'),
    formatRequirements,
  })

  return { formula: formula.trim() }
}
