import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  groupArchiveFiles,
  mergeSplitZip,
  withPreparedArchiveFiles,
  patchMergedZipEOCD,
} from '../file-processor'
import type { SplitArchiveGroup } from '../file-processor'

let tmpDir: string

function touch(dir: string, name: string, size = 0) {
  const p = path.join(dir, name)
  fs.writeFileSync(p, Buffer.alloc(size))
  return p
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('groupArchiveFiles', () => {
  it('returns empty for non-existent directory', () => {
    expect(groupArchiveFiles('/no/such/dir')).toEqual([])
  })

  it('groups a split-volume ZIP set', () => {
    touch(tmpDir, '20231003.zip')
    touch(tmpDir, '20231003.z01')
    touch(tmpDir, '20231003.z02')
    touch(tmpDir, '20231003.z03')

    const groups = groupArchiveFiles(tmpDir)
    expect(groups).toHaveLength(1)

    const g = groups[0]
    expect(g.baseName).toBe('20231003')
    expect(g.isSplit).toBe(true)
    expect(g.splitParts).toHaveLength(3)
    // Split parts must be ordered z01, z02, z03
    expect(g.splitParts.map((p) => path.extname(p))).toEqual([
      '.z01',
      '.z02',
      '.z03',
    ])
  })

  it('ignores unexpected split extensions beyond two digits', () => {
    touch(tmpDir, '20231003.zip')
    touch(tmpDir, '20231003.z01')
    touch(tmpDir, '20231003.z123')

    const groups = groupArchiveFiles(tmpDir)
    expect(groups).toHaveLength(1)
    expect(groups[0].splitParts.map((p) => path.extname(p))).toEqual(['.z01'])
  })

  it('treats a lone .zip without split parts as non-split', () => {
    touch(tmpDir, 'standalone.zip')

    const groups = groupArchiveFiles(tmpDir)
    expect(groups).toHaveLength(1)
    expect(groups[0].isSplit).toBe(false)
    expect(groups[0].splitParts).toHaveLength(0)
  })

  it('handles standalone .gz files', () => {
    touch(tmpDir, 'data.xml.gz')

    const groups = groupArchiveFiles(tmpDir)
    expect(groups).toHaveLength(1)
    expect(groups[0].isSplit).toBe(false)
    expect(groups[0].mainZip).toMatch(/\.gz$/)
  })

  it('ignores stale .merged.zip from previous runs', () => {
    touch(tmpDir, '20231003.zip')
    touch(tmpDir, '20231003.z01')
    touch(tmpDir, '20231003.merged.zip')

    const groups = groupArchiveFiles(tmpDir)
    // Only the split group; the merged file must not appear as standalone
    expect(groups).toHaveLength(1)
    expect(groups[0].isSplit).toBe(true)
  })

  it('separates multiple independent archives', () => {
    touch(tmpDir, 'a.zip')
    touch(tmpDir, 'b.zip')
    touch(tmpDir, 'b.z01')
    touch(tmpDir, 'c.xml.gz')

    const groups = groupArchiveFiles(tmpDir)
    expect(groups).toHaveLength(3)

    const byName = Object.fromEntries(groups.map((g) => [g.baseName, g]))
    expect(byName['a'].isSplit).toBe(false)
    expect(byName['b'].isSplit).toBe(true)
    expect(byName['c.xml'].isSplit).toBe(false)
  })
})

describe('mergeSplitZip', () => {
  it('concatenates parts in correct order', async () => {
    // Write distinct content per part so order is verifiable
    fs.writeFileSync(path.join(tmpDir, 'data.z01'), Buffer.from('AAAA'))
    fs.writeFileSync(path.join(tmpDir, 'data.z02'), Buffer.from('BBBB'))
    fs.writeFileSync(path.join(tmpDir, 'data.zip'), Buffer.from('CCCC'))

    const group: SplitArchiveGroup = {
      baseName: 'data',
      isSplit: true,
      mainZip: path.join(tmpDir, 'data.zip'),
      splitParts: [
        path.join(tmpDir, 'data.z01'),
        path.join(tmpDir, 'data.z02'),
      ],
      allFiles: [],
    }

    const outPath = path.join(tmpDir, 'data.merged.zip')
    await mergeSplitZip(group, outPath)

    const content = fs.readFileSync(outPath).toString()
    expect(content).toBe('AAAABBBBCCCC')
  })

  it('tolerates direct helper invocation with only a .zip file', async () => {
    fs.writeFileSync(path.join(tmpDir, 'data.zip'), Buffer.from('HELLO'))

    const group: SplitArchiveGroup = {
      baseName: 'data',
      isSplit: true,
      mainZip: path.join(tmpDir, 'data.zip'),
      splitParts: [],
      allFiles: [],
    }

    const outPath = path.join(tmpDir, 'data.merged.zip')
    await mergeSplitZip(group, outPath)

    expect(fs.readFileSync(outPath).toString()).toBe('HELLO')
  })
})

describe('withPreparedArchiveFiles', () => {
  // Minimal EOCD so patchMergedZipEOCD can find it
  function makeEocd(diskNumber = 5): Buffer {
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(diskNumber, 4)
    eocd.writeUInt16LE(diskNumber, 6)
    eocd.writeUInt16LE(0, 10)
    eocd.writeUInt32LE(0, 16)
    eocd.writeUInt16LE(0, 20)
    return eocd
  }

  it('removes stale merged archives before planning extraction', async () => {
    fs.writeFileSync(path.join(tmpDir, '20231003.z01'), Buffer.from('PART1'))
    fs.writeFileSync(path.join(tmpDir, '20231003.zip'), makeEocd(5))
    const mergedPath = path.join(tmpDir, '20231003.merged.zip')
    fs.writeFileSync(mergedPath, Buffer.from('STALE'))

    const seenFiles = await withPreparedArchiveFiles(
      tmpDir,
      async (filePaths) => {
        expect(filePaths).toHaveLength(1)
        expect(path.basename(filePaths[0])).toBe('20231003.merged.zip')
        return filePaths
      },
      {
        beforeMerge: (_group, outputPath) => {
          expect(outputPath).toBe(mergedPath)
          expect(fs.existsSync(outputPath)).toBe(false)
        },
        mergeArchive: async (group, outputPath) => {
          expect(outputPath).toBe(mergedPath)
          expect(fs.existsSync(outputPath)).toBe(false)
          return mergeSplitZip(group, outputPath)
        },
      },
    )

    expect(seenFiles).toHaveLength(1)
    expect(fs.existsSync(mergedPath)).toBe(false)
  })

  it('cleans merged temp files even when extraction handler fails', async () => {
    fs.writeFileSync(path.join(tmpDir, 'data.z01'), Buffer.from('AAAA'))
    fs.writeFileSync(path.join(tmpDir, 'data.zip'), makeEocd(5))

    const mergedPath = path.join(tmpDir, 'data.merged.zip')

    await expect(
      withPreparedArchiveFiles(tmpDir, async (filePaths) => {
        expect(filePaths).toEqual([mergedPath])
        expect(fs.existsSync(mergedPath)).toBe(true)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(fs.existsSync(mergedPath)).toBe(false)
  })
})

describe('patchMergedZipEOCD', () => {
  // Build a minimal file with a standard EOCD at the end
  function buildFakeZip(diskNumber: number): string {
    const filePath = path.join(tmpDir, 'fake.zip')
    // Minimal content + EOCD
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0) // signature
    eocd.writeUInt16LE(diskNumber, 4) // number of this disk
    eocd.writeUInt16LE(diskNumber, 6) // disk where CD starts
    eocd.writeUInt16LE(0, 10) // total entries
    eocd.writeUInt32LE(0, 16) // CD offset
    eocd.writeUInt16LE(0, 20) // comment length
    fs.writeFileSync(filePath, eocd)
    return filePath
  }

  function buildFakeZip64(diskNumber: number): string {
    const filePath = path.join(tmpDir, 'fake64.zip')
    // Zip64 EOCD (56 bytes) + Zip64 Locator (20 bytes) + Standard EOCD (22 bytes)
    const zip64Eocd = Buffer.alloc(56)
    zip64Eocd.writeUInt32LE(0x06064b50, 0) // signature
    // size of record at offset 4 (8 bytes)
    zip64Eocd.writeBigUInt64LE(BigInt(56 - 12), 4)
    zip64Eocd.writeUInt32LE(diskNumber, 16) // this disk
    zip64Eocd.writeUInt32LE(diskNumber, 20) // disk with CD start
    zip64Eocd.writeBigUInt64LE(BigInt(0), 32) // total entries
    zip64Eocd.writeBigUInt64LE(BigInt(0), 40) // CD size
    zip64Eocd.writeBigUInt64LE(BigInt(0), 48) // CD offset

    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064b50, 0) // signature
    locator.writeUInt32LE(0, 4) // disk with zip64 eocd
    locator.writeBigUInt64LE(BigInt(0), 8) // offset of zip64 eocd
    locator.writeUInt32LE(1, 16) // total disks

    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(diskNumber, 4)
    eocd.writeUInt16LE(diskNumber, 6)
    eocd.writeUInt16LE(0, 10)
    eocd.writeUInt32LE(0, 16)
    eocd.writeUInt16LE(0, 20)

    fs.writeFileSync(filePath, Buffer.concat([zip64Eocd, locator, eocd]))
    return filePath
  }

  function buildSplitZipWithZip64Extra(): string {
    const filePath = path.join(tmpDir, 'split-zip64-extra.zip')

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt16LE(0, 10)
    localHeader.writeUInt16LE(0, 12)
    localHeader.writeUInt32LE(0, 14)
    localHeader.writeUInt32LE(0, 18)
    localHeader.writeUInt32LE(0, 22)
    localHeader.writeUInt16LE(0, 26)
    localHeader.writeUInt16LE(0, 28)

    const zip64Extra = Buffer.alloc(4 + 16)
    zip64Extra.writeUInt16LE(0x0001, 0)
    zip64Extra.writeUInt16LE(16, 2)
    zip64Extra.writeBigUInt64LE(BigInt(1234), 4)
    zip64Extra.writeBigUInt64LE(BigInt(5678), 12)

    const cdEntry = Buffer.alloc(46 + zip64Extra.length)
    cdEntry.writeUInt32LE(0x02014b50, 0)
    cdEntry.writeUInt16LE(45, 4)
    cdEntry.writeUInt16LE(20, 6)
    cdEntry.writeUInt16LE(0, 8)
    cdEntry.writeUInt16LE(0, 10)
    cdEntry.writeUInt16LE(0, 12)
    cdEntry.writeUInt16LE(0, 14)
    cdEntry.writeUInt32LE(0, 16)
    cdEntry.writeUInt32LE(0xffffffff, 20)
    cdEntry.writeUInt32LE(0xffffffff, 24)
    cdEntry.writeUInt16LE(0, 28)
    cdEntry.writeUInt16LE(zip64Extra.length, 30)
    cdEntry.writeUInt16LE(0, 32)
    cdEntry.writeUInt16LE(1, 34)
    cdEntry.writeUInt16LE(0, 36)
    cdEntry.writeUInt32LE(0, 38)
    cdEntry.writeUInt32LE(0, 42)
    zip64Extra.copy(cdEntry, 46)

    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(1, 4)
    eocd.writeUInt16LE(1, 6)
    eocd.writeUInt16LE(1, 8)
    eocd.writeUInt16LE(1, 10)
    eocd.writeUInt32LE(cdEntry.length, 12)
    eocd.writeUInt32LE(localHeader.length, 16)
    eocd.writeUInt16LE(0, 20)

    fs.writeFileSync(filePath, Buffer.concat([localHeader, cdEntry, eocd]))
    return filePath
  }

  it('zeros disk number in standard EOCD', async () => {
    const filePath = buildFakeZip(5)
    await patchMergedZipEOCD(filePath)

    const buf = fs.readFileSync(filePath)
    expect(buf.readUInt16LE(4)).toBe(0)
    expect(buf.readUInt16LE(6)).toBe(0)
  })

  it('adjusts central directory offset with zipDiskOffset', async () => {
    const filePath = buildFakeZip(5)
    // Original CD offset at offset 16 is 0, add 1000
    await patchMergedZipEOCD(filePath, 1000)

    const buf = fs.readFileSync(filePath)
    expect(buf.readUInt16LE(4)).toBe(0) // disk number zeroed
    expect(buf.readUInt16LE(6)).toBe(0) // disk number zeroed
    expect(buf.readUInt32LE(16)).toBe(1000) // CD offset adjusted
  })

  it('zeros disk number in Zip64 EOCD', async () => {
    const filePath = buildFakeZip64(5)
    await patchMergedZipEOCD(filePath)

    const buf = fs.readFileSync(filePath)
    // Zip64 EOCD is at offset 0
    expect(buf.readUInt32LE(16)).toBe(0) // this disk
    expect(buf.readUInt32LE(20)).toBe(0) // disk with CD start
    // Standard EOCD is at offset 76 (56 + 20)
    expect(buf.readUInt16LE(76 + 4)).toBe(0)
    expect(buf.readUInt16LE(76 + 6)).toBe(0)
  })

  it('throws when EOCD signature is missing', async () => {
    const filePath = path.join(tmpDir, 'garbage.bin')
    fs.writeFileSync(filePath, Buffer.alloc(100, 0xaa))
    await expect(patchMergedZipEOCD(filePath)).rejects.toThrow(
      'EOCD signature not found',
    )
  })

  it('rebuilds existing Zip64 extra fields without clobbering size values', async () => {
    const filePath = buildSplitZipWithZip64Extra()
    const zipDiskOffset = 0x1_0000_0000

    await patchMergedZipEOCD(filePath, 0, [zipDiskOffset])

    const buf = fs.readFileSync(filePath)
    const cdOffset = 30
    const cdSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02])
    let cdEntryCount = 0
    for (let i = 0; i <= buf.length - cdSignature.length; i++) {
      if (buf.subarray(i, i + cdSignature.length).equals(cdSignature))
        cdEntryCount++
    }
    expect(cdEntryCount).toBe(1)
    const extraLen = buf.readUInt16LE(cdOffset + 30)
    expect(extraLen).toBe(28)
    expect(buf.readUInt16LE(cdOffset + 34)).toBe(0)
    expect(buf.readUInt32LE(cdOffset + 42)).toBe(0xffffffff)

    const extraOffset = cdOffset + 46
    expect(buf.readUInt16LE(extraOffset)).toBe(0x0001)
    expect(buf.readUInt16LE(extraOffset + 2)).toBe(24)
    expect(buf.readBigUInt64LE(extraOffset + 4)).toBe(BigInt(1234))
    expect(buf.readBigUInt64LE(extraOffset + 12)).toBe(BigInt(5678))
    expect(buf.readBigUInt64LE(extraOffset + 20)).toBe(BigInt(zipDiskOffset))
  })
})
