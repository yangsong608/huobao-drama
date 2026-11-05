/**
 * 分轨 ZIP（设计 9.3）：无第三方依赖的 deflate/store 写入器。
 */
import fs from 'node:fs/promises'
import zlib from 'node:zlib'

export interface ZipEntry {
  name: string
  data: Buffer
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

const ZIP_LIMIT = 0xffffffff
const UTF8_FLAG = 0x0800
const METHOD_STORE = 0
const METHOD_DEFLATE = 8

export function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getFullYear())
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  }
}

interface PreparedEntry {
  name: Buffer
  extra: Buffer
  data: Buffer
  method: number
  crc: number
  offset: number
}

function unicodePathExtra(name: Buffer): Buffer {
  const extra = Buffer.alloc(9 + name.length)
  extra.writeUInt16LE(0x7075, 0)
  extra.writeUInt16LE(5 + name.length, 2)
  extra.writeUInt8(1, 4)
  extra.writeUInt32LE(crc32(name), 5)
  name.copy(extra, 9)
  return extra
}

export function createZip(entries: ZipEntry[], at: Date = new Date()): Buffer {
  const { time, date } = dosDateTime(at)
  const parts: Buffer[] = []
  const prepared: PreparedEntry[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const extra = unicodePathExtra(name)
    if (entry.data.length > ZIP_LIMIT) {
      throw new Error(`ZIP 单文件超过 4GB：${entry.name}`)
    }
    const deflated = zlib.deflateRawSync(entry.data)
    const useDeflate = deflated.length < entry.data.length
    const payload = useDeflate ? deflated : entry.data
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE
    const checksum = crc32(entry.data)

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(UTF8_FLAG, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(time, 10)
    header.writeUInt16LE(date, 12)
    header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(payload.length, 18)
    header.writeUInt32LE(entry.data.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(extra.length, 28)

    prepared.push({ name, extra, data: payload, method, crc: checksum, offset })
    parts.push(header, name, extra, payload)
    offset += header.length + name.length + extra.length + payload.length
  }

  const centralParts: Buffer[] = []
  let centralSize = 0
  for (const entry of prepared) {
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(UTF8_FLAG, 8)
    header.writeUInt16LE(entry.method, 10)
    header.writeUInt16LE(time, 12)
    header.writeUInt16LE(date, 14)
    header.writeUInt32LE(entry.crc, 16)
    header.writeUInt32LE(entry.data.length, 20)
    header.writeUInt32LE(entry.data.length, 24)
    header.writeUInt16LE(entry.name.length, 28)
    header.writeUInt16LE(entry.extra.length, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt16LE(0, 34)
    header.writeUInt16LE(0, 36)
    header.writeUInt32LE(0, 38)
    header.writeUInt32LE(entry.offset, 42)
    centralParts.push(header, entry.name, entry.extra)
    centralSize += header.length + entry.name.length + entry.extra.length
  }

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(prepared.length, 8)
  end.writeUInt16LE(prepared.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...parts, ...centralParts, end])
}

export async function writeZip(file: string, entries: ZipEntry[]): Promise<number> {
  const buffer = createZip(entries)
  await fs.writeFile(file, buffer)
  return buffer.length
}
