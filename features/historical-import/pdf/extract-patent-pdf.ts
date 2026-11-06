import path from 'node:path'
import { spawnSync } from 'node:child_process'

const python =
  process.env.PDF_PYTHON ||
  path.resolve(
    '.venv-pdf',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  )
const result = spawnSync(
  python,
  [
    path.resolve('features/historical-import/pdf/extract-patent-pdf.py'),
    ...process.argv.slice(2),
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, PYTHONUTF8: '1' },
  },
)
if (result.error)
  console.error(
    '无法启动 PDF 解析环境，请按 features/historical-import/README.md 安装依赖。',
  )
process.exit(result.status ?? 1)
