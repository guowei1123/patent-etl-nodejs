async function test() {
  const baseUrl = 'http://localhost:3000'
  
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'turinhub' })
  })
  
  const setCookie = loginRes.headers.get('set-cookie')
  const cookie = setCookie ? setCookie.split(';')[0] : ''
  
  const headers = { 'Cookie': cookie }
  
  console.log('=== 测试语义搜索 ===\n')
  
  const res = await fetch(`${baseUrl}/api/classifications?type=ipc&mode=semantic&q=锂电池&limit=5`, { headers })
  const data = await res.json()
  
  console.log('状态:', res.status)
  console.log('success:', data.success)
  if (data.success) {
    console.log('total:', data.data.total)
    console.log('items:', data.data.items.length)
    if (data.data.items.length > 0) {
      console.log('第一个:', JSON.stringify(data.data.items[0], null, 2))
    }
  } else {
    console.log('error:', data.error)
    if (data.details) console.log('details:', data.details)
  }
}

test().catch(console.error)