import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'

/**
 * 纯 JS 的 tar.gz 写入器。
 *
 * 不调用系统 tar：Windows 自带的 bsdtar 会把 `C:\...` 当成远程主机名
 * （"Cannot connect to C: resolve failed"），而且客户机上有没有 tar 不该影响同步。
 * 中文聊天名普遍超过 100 字节，所以每个文件都用 PAX 扩展头写 path，兼容 GNU tar、
 * bsdtar 和 Python tarfile。
 */
function octal(value, length) {
  const text = value.toString(8)
  return `${'0'.repeat(Math.max(0, length - 1 - text.length))}${text}\0`
}

function paxRecord(key, value) {
  const payload = ` ${key}=${value}\n`
  let length = Buffer.byteLength(payload) + 1
  while (Buffer.byteLength(String(length)) + Buffer.byteLength(payload) !== length) {
    length = Buffer.byteLength(String(length)) + Buffer.byteLength(payload)
  }
  return `${length}${payload}`
}

function header({ name, size, mtime, type = '0' }) {
  const block = Buffer.alloc(512, 0)
  block.write(name.slice(0, 100), 0, 100, 'utf8')
  block.write(octal(0o644, 8), 100, 8, 'ascii')
  block.write(octal(0, 8), 108, 8, 'ascii')
  block.write(octal(0, 8), 116, 8, 'ascii')
  block.write(octal(size, 12), 124, 12, 'ascii')
  block.write(octal(mtime, 12), 136, 12, 'ascii')
  block.write('        ', 148, 8, 'ascii')
  block.write(type, 156, 1, 'ascii')
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  block.write('root', 265, 32, 'ascii')
  block.write('root', 297, 32, 'ascii')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return block
}

function pad512(size) {
  const remainder = size % 512
  return remainder === 0 ? 0 : 512 - remainder
}

async function* entries(files) {
  for (const file of files) {
    const info = await stat(file.absolute)
    const name = file.path.replace(/\\/g, '/')
    const pax = Buffer.from(paxRecord('path', name), 'utf8')
    yield header({ name: `PaxHeader/${Buffer.from(name).subarray(0, 80).toString('utf8')}`, size: pax.length, mtime: Math.floor(info.mtimeMs / 1000), type: 'x' })
    yield pax
    yield Buffer.alloc(pad512(pax.length), 0)
    yield header({ name: name.slice(0, 100), size: info.size, mtime: Math.floor(info.mtimeMs / 1000) })
    yield* createReadStream(file.absolute)
    const padding = pad512(info.size)
    if (padding) yield Buffer.alloc(padding, 0)
  }
  yield Buffer.alloc(1024, 0)
}

/** 生成 tar.gz，返回字节数与 sha256（边写边算，不把整包读进内存）。 */
export async function writeTarGz(files, outputFile) {
  const hash = createHash('sha256')
  let bytes = 0
  const gzip = createGzip({ level: 6 })
  const out = createWriteStream(outputFile)
  gzip.on('data', (chunk) => {
    hash.update(chunk)
    bytes += chunk.length
  })
  await pipeline(entries(files), gzip, out)
  return { bytes, sha256: hash.digest('hex') }
}
