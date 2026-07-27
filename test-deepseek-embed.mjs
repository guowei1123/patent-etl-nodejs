const API_KEY = 'sk-f8da50f240a546cc953424c9a38ad69a'

const testCases = [
  { name: 'v1 + deepseek-v4-embedding', url: 'https://api.deepseek.com/v1/embeddings', model: 'deepseek-v4-embedding' },
  { name: '无v1 + deepseek-v4-embedding', url: 'https://api.deepseek.com/embeddings', model: 'deepseek-v4-embedding' },
]

async function test(c) {
  try {
    const res = await fetch(c.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: c.model,
        input: '测试文本',
      }),
    })
    const text = await res.text()
    return { name: c.name, status: res.status, ok: res.ok, body: text.substring(0, 300) }
  } catch (e) {
    return { name: c.name, error: e.message }
  }
}

async function main() {
  console.log('=== 测试 DeepSeek Embedding 端点 ===\n')
  for (const c of testCases) {
    const result = await test(c)
    console.log(`[${result.status || 'ERR'}] ${result.name}`)
    if (result.body) console.log(`  Body: ${result.body}`)
    if (result.error) console.log(`  错误: ${result.error}`)
    console.log()
  }
}

main()