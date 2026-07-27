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
  
  console.log('=== 测试分类字典列表 ===')
  const listRes = await fetch(`${baseUrl}/api/classifications?type=ipc&page=1&limit=5`, { headers })
  const listData = await listRes.json()
  console.log('状态:', listRes.status, 'success:', listData.success)
  if (listData.success) {
    console.log('total:', listData.data.total, 'items:', listData.data.items.length)
  } else {
    console.log('error:', listData.error)
  }
  
  console.log('\n=== 测试分类字典树视图 ===')
  const treeRes = await fetch(`${baseUrl}/api/classifications?view=tree&type=ipc&limit=50`, { headers })
  const treeData = await treeRes.json()
  console.log('状态:', treeRes.status, 'success:', treeData.success)
  if (treeData.success) {
    console.log('total:', treeData.data.total, 'items:', treeData.data.items.length)
  } else {
    console.log('error:', treeData.error)
  }
  
  console.log('\n=== 测试分类字典搜索 ===')
  const searchRes = await fetch(`${baseUrl}/api/classifications?type=ipc&q=H01M&limit=5`, { headers })
  const searchData = await searchRes.json()
  console.log('状态:', searchRes.status, 'success:', searchData.success)
  if (searchData.success) {
    console.log('total:', searchData.data.total, 'items:', searchData.data.items.length)
  } else {
    console.log('error:', searchData.error)
  }
}

test().catch(console.error)