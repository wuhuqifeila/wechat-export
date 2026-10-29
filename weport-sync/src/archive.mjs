import { createReadStream } from 'node:fs'
import { copyFile, link, lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { writeTarGz } from './tar.mjs'

export async function sha256File(file) {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/** 递归列出目录内容；符号链接直接拒绝，避免把目录外的文件带进上传包。 */
export async function inventory(directory, prefix = 'export') {
  const files = []
  for (const name of await readdir(directory)) {
    const absolute = path.join(directory, name)
    const relative = `${prefix}/${name}`
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) throw new Error(`导出目录里出现符号链接，已拒绝打包：${relative}`)
    if (info.isDirectory()) files.push(...(await inventory(absolute, relative)))
    else if (info.isFile()) files.push({ path: relative, absolute, bytes: info.size })
  }
  return files
}

/**
 * 按接收端单批上限切包。文本（manifest + json）恒定在第 1 包里，媒体按体积贪心分配，
 * 保证任何单一附件都不会被截断——大于上限的附件会被跳过并记入 manifest.skipped。
 */
export function planParts(files, maxBytes, overheadPerFile = 2048) {
  const budget = Math.max(64 * 1024, maxBytes - 8192)
  const parts = []
  let current = []
  let currentBytes = 0
  for (const file of files) {
    const cost = file.bytes + overheadPerFile
    if (cost > budget) {
      continue // 单文件超过单批上限：交给调用方登记跳过
    }
    if (current.length > 0 && currentBytes + cost > budget) {
      parts.push(current)
      current = []
      currentBytes = 0
    }
    current.push(file)
    currentBytes += cost
  }
  if (current.length > 0) parts.push(current)
  return parts
}

export async function materializePart(batchDir, index, files, manifest) {
  const partDir = path.join(batchDir, 'parts', String(index))
  await rm(partDir, { recursive: true, force: true })
  await mkdir(path.join(partDir, 'export'), { recursive: true })
  for (const file of files) {
    const target = path.join(partDir, file.path)
    await mkdir(path.dirname(target), { recursive: true })
    try {
      await link(file.absolute, target)
    } catch {
      await copyFile(file.absolute, target)
    }
  }
  await writeFile(path.join(partDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return partDir
}

/** 打包一个分卷；返回体积与校验值，供上传时比对回执。 */
export async function archivePart(batchDir, index) {
  const partDir = path.join(batchDir, 'parts', String(index))
  const files = (await inventory(partDir, '.')).map((file) => ({ ...file, path: file.path.replace(/^\.\//, '') }))
  const archive = path.join(batchDir, `part-${index}.tar.gz`)
  const { bytes, sha256 } = await writeTarGz(files, archive)
  if (!bytes) throw new Error(`打包结果为空：part-${index}`)
  return { index, file: archive, bytes, sha256 }
}

export async function treeSize(directory) {
  let total = 0
  for (const name of await readdir(directory)) {
    const absolute = path.join(directory, name)
    const info = await lstat(absolute)
    if (info.isDirectory()) total += await treeSize(absolute)
    else if (info.isFile()) total += info.size
  }
  return total
}

export async function hasTar() {
  return true
}
