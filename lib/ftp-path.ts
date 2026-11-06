// 仅还原可逆的 UTF-8/Latin-1 乱码；浏览器和服务端使用相同规则。
export function normalizeFtpDirectoryName(name: string): string {
  let normalized = name
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const characters = Array.from(normalized)
    if (characters.some((character) => character.charCodeAt(0) > 0xff)) break
    try {
      const decoded = decoder.decode(
        Uint8Array.from(characters, (character) => character.charCodeAt(0)),
      )
      if (decoded === normalized) break
      normalized = decoded
    } catch {
      break
    }
  }
  return normalized
}

// 只用于展示，不替换 FTP 请求、批次存储和断点续传所使用的真实路径。
export function formatFtpPath(remotePath: string): string {
  return remotePath.split('/').map(normalizeFtpDirectoryName).join('/')
}
