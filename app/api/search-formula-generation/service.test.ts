import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSearchFormula } from './service'

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  chatModel: vi.fn((model: string) => ({ provider: 'openai', model })),
}))

vi.mock('ai', () => ({
  generateText: mocks.generateText,
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => ({
    chat: mocks.chatModel,
  })),
}))

describe('generateSearchFormula', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('OPENAI_API_KEY', 'test-key')
    vi.stubEnv('OPENAI_BASE_URL', 'https://example.test/v1')
    vi.stubEnv('OPENAI_CHAT_MODEL', 'gpt-test')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('generates and trims an Incopat formula with keywords and IPC/CPC codes', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: '  (TIAB=(蓝牙 AND 扭矩扳手)) AND (IPC=(B) OR CPC=(B))  ',
    } as Awaited<ReturnType<typeof generateText>>)

    await expect(
      generateSearchFormula({
        keywords: ['蓝牙', '扭矩扳手'],
        ipcCodes: ['B'],
        outputFormat: 'format1',
      }),
    ).resolves.toEqual({
      formula: '(TIAB=(蓝牙 AND 扭矩扳手)) AND (IPC=(B) OR CPC=(B))',
    })

    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'https://example.test/v1',
    })
    expect(mocks.chatModel).toHaveBeenCalledWith('gpt-test')
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { provider: 'openai', model: 'gpt-test' },
        temperature: 0.1,
        timeout: 120000,
        maxRetries: 1,
      }),
    )
    expect(vi.mocked(generateText).mock.calls[0][0].prompt).toContain(
      '结构要求：(TIAB=(关键词)) AND (IPC=(分类号) OR CPC=(分类号))',
    )
    expect(vi.mocked(generateText).mock.calls[0][0].prompt).toContain(
      '关键词列表：蓝牙、扭矩扳手',
    )
  })

  it('uses the keyword-only instructions for format2', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: 'TIAB=(蓝牙 AND 扭矩扳手)',
    } as Awaited<ReturnType<typeof generateText>>)

    await generateSearchFormula({
      keywords: ['蓝牙'],
      ipcCodes: ['B'],
      outputFormat: 'format2',
    })

    const prompt = vi.mocked(generateText).mock.calls[0][0].prompt
    expect(prompt).toContain('生成仅包含关键词的检索式')
    expect(prompt).toContain('绝对不要包含IPC或CPC分类号')
  })

  it('requires chat model configuration', async () => {
    vi.stubEnv('OPENAI_CHAT_MODEL', '')

    await expect(
      generateSearchFormula({
        keywords: ['蓝牙'],
        ipcCodes: ['B'],
        outputFormat: 'format1',
      }),
    ).rejects.toThrow('缺少 OPENAI_CHAT_MODEL 配置')
  })
})
