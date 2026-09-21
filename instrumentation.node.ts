async function initializeAutoSync(): Promise<void> {
  try {
    const { initializeDatabase, isDbConfigured } = await import('@/lib/db')
    if (!isDbConfigured()) return
    await initializeDatabase()
    const { startInlineScheduler } = await import('@/lib/etl/inline-scheduler')
    startInlineScheduler()
  } catch (error) {
    console.error('自动同步调度器初始化失败:', error)
  }
}

export function registerNode(): void {
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  // Next.js 会等待 register 完成后才处理请求。数据库初始化可能被锁等待，
  // 因此让自动调度器在后台完成初始化，避免阻塞整个 Web 服务。
  void initializeAutoSync()
}
