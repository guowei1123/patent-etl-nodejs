import * as path from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileInfo, FileType, FTPError } from 'basic-ftp'
import { FtpClient, normalizeFtpDirectoryName } from '../ftp-client'

const state = vi.hoisted(() => ({ cwd: '/', closed: false }))
const calls = vi.hoisted(() => ({
  access: vi.fn(),
  cd: vi.fn(),
  pwd: vi.fn(),
  list: vi.fn(),
  close: vi.fn(),
  downloadTo: vi.fn(),
  size: vi.fn(),
  trackProgress: vi.fn(),
}))
vi.mock('basic-ftp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('basic-ftp')>()
  return {
    ...actual,
    Client: vi.fn().mockImplementation(function () {
      return {
        ftp: { verbose: false },
        get closed() {
          return state.closed
        },
        ...calls,
      }
    }),
  }
})

const sourceName = 'CN-PA-TXTS-10-B_中国发明专利授权公告标准化全文文本数据'
const mojibake = (text: string) => Buffer.from(text, 'utf8').toString('latin1')
function directory(name: string) {
  const entry = new FileInfo(name)
  entry.type = FileType.Directory
  return entry
}
function file(name: string) {
  const entry = new FileInfo(name)
  entry.type = FileType.File
  entry.size = 22
  return entry
}
let tree: Map<string, FileInfo[]>
beforeEach(() => {
  delete globalThis.__patentFtpSessions
  for (const call of Object.values(calls)) call.mockReset()
  state.cwd = '/'
  state.closed = false
  tree = new Map([
    ['/', [directory('CN')]],
    ['/CN', []],
  ])
  calls.pwd.mockImplementation(async () => state.cwd)
  calls.access.mockImplementation(async () => {
    state.closed = false
  })
  calls.close.mockImplementation(() => {
    state.closed = true
  })
  calls.cd.mockImplementation(async (target: string) => {
    const resolved = path.posix.resolve(state.cwd, target)
    if (!tree.has(resolved))
      throw new FTPError({ code: 550, message: 'No such directory.' })
    state.cwd = resolved
    return { code: 250, message: 'Directory changed' }
  })
  calls.list.mockImplementation(async () => tree.get(state.cwd) ?? [])
})

describe('FTP directory path compatibility', () => {
  it('only normalizes reversible UTF-8/Latin-1 names', () => {
    expect(normalizeFtpDirectoryName(mojibake(sourceName))).toBe(sourceName)
    expect(normalizeFtpDirectoryName(mojibake(mojibake(sourceName)))).toBe(
      sourceName,
    )
    expect(normalizeFtpDirectoryName(sourceName)).toBe(sourceName)
    expect(normalizeFtpDirectoryName('CN-PA-TXTS-10-B_????')).toBe(
      'CN-PA-TXTS-10-B_????',
    )
    expect(normalizeFtpDirectoryName('café')).toBe('café')
  })

  it('resolves the exact encoded directory and returns the real paths used by downloads', async () => {
    const actual = `/CN/${mojibake(sourceName)}`
    tree.set('/CN', [
      directory('CN-PA-TXTS-10-B_????'),
      directory(mojibake(sourceName)),
    ])
    tree.set(actual, [directory('data')])
    tree.set(`${actual}/data`, [directory('20240913')])
    tree.set(`${actual}/data/20240913`, [file('20240913.zip')])
    const client = new FtpClient()
    const result = await client.listDirectory(`/CN/${sourceName}/data/20240913`)
    expect(result).toMatchObject([
      {
        name: '20240913.zip',
        type: 'file',
        size: 22,
        path: `${actual}/data/20240913/20240913.zip`,
      },
    ])
    expect(state.cwd).toBe('/')
    expect(
      calls.list.mock.calls.every((arguments_) => arguments_.length === 0),
    ).toBe(true)
    await client.downloadFile(result[0].path, '/unused.zip', { remoteSize: 22 })
    expect(calls.downloadTo).toHaveBeenCalledWith('/unused.zip', result[0].path)
  })

  it('preserves valid Chinese paths and restores the original directory for relative requests', async () => {
    state.cwd = '/CN'
    tree.set('/CN', [directory(sourceName)])
    tree.set(`/CN/${sourceName}`, [file('data.zip')])
    const result = await new FtpClient().listDirectory(sourceName)
    expect(result[0].path).toBe(`/CN/${sourceName}/data.zip`)
    expect(state.cwd).toBe('/CN')
    expect(calls.list).toHaveBeenCalledTimes(2)
  })

  it('returns an empty list only after entering a real, empty directory', async () => {
    tree.set('/CN/empty', [])
    expect(await new FtpClient().listDirectory('/CN/empty')).toEqual([])
    expect(state.cwd).toBe('/')
  })

  it('reports a nonexistent directory instead of silently returning an empty list', async () => {
    await expect(new FtpClient().listDirectory('/CN/missing')).rejects.toThrow(
      '不存在、无权访问或名称匹配不唯一',
    )
    expect(state.cwd).toBe('/')
  })

  it('does not guess by product prefix or choose among ambiguous encoded matches', async () => {
    tree.set('/CN', [directory('CN-PA-TXTS-10-B_????')])
    await expect(
      new FtpClient().listDirectory(`/CN/${sourceName}`),
    ).rejects.toThrow('名称匹配不唯一')
    tree.set('/CN', [
      directory(mojibake(sourceName)),
      directory(mojibake(mojibake(sourceName))),
    ])
    await expect(
      new FtpClient().listDirectory(`/CN/${sourceName}`),
    ).rejects.toThrow('名称匹配不唯一')
    expect(state.cwd).toBe('/')
  })

  it('restores the working directory even when listing fails', async () => {
    tree.set('/CN/data', [])
    calls.list.mockRejectedValue(new Error('listing failed'))
    await expect(new FtpClient().listDirectory('/CN/data')).rejects.toThrow(
      'listing failed',
    )
    expect(state.cwd).toBe('/')
  })

  it('does not run compatibility lookup for authentication errors', async () => {
    calls.cd.mockRejectedValueOnce(
      new FTPError({ code: 530, message: 'Permission denied' }),
    )
    await expect(new FtpClient().listDirectory('/CN')).rejects.toThrow(
      'Permission denied',
    )
    expect(calls.list).not.toHaveBeenCalled()
  })
})
