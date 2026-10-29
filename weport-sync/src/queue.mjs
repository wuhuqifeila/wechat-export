import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { layout } from './paths.mjs'

export async function ensureDirs(home) {
  const files = layout(home)
  for (const dir of [files.home, files.profile, files.batches, files.logs, files.locks]) {
    await mkdir(dir, { recursive: true })
  }
  return files
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    if (error instanceof SyntaxError) return fallback
    throw error
  }
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2))
  await rename(temp, file)
}

// ---------------------------------------------------------------- 游标台账

export async function loadLedger(home) {
  const files = layout(home)
  const ledger = await readJson(files.ledger, null)
  return ledger && ledger.targets ? ledger : { version: 1, updatedAt: null, targets: {} }
}

export async function saveLedger(home, ledger) {
  const files = layout(home)
  ledger.updatedAt = new Date().toISOString()
  await writeJson(files.ledger, ledger)
}

export async function advanceCursor(home, target, { cursor, lastMessageAt }) {
  const ledger = await loadLedger(home)
  const previous = ledger.targets[target.id] || {}
  ledger.targets[target.id] = {
    name: target.name,
    cursor: Math.floor(cursor),
    lastMessageAt: lastMessageAt ? Math.floor(lastMessageAt) : previous.lastMessageAt || null,
    lastSuccessAt: new Date().toISOString(),
  }
  await saveLedger(home, ledger)
  return ledger
}

// ---------------------------------------------------------------- 批次

export function batchDir(home, groupId) {
  return path.join(layout(home).batches, groupId)
}

export async function listGroups(home) {
  const files = layout(home)
  let entries = []
  try {
    entries = await readdir(files.batches, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const groups = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const state = await readJson(path.join(files.batches, entry.name, 'state.json'), null)
    if (state) groups.push(state)
  }
  groups.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  return groups
}

export async function loadGroup(home, groupId) {
  return await readJson(path.join(batchDir(home, groupId), 'state.json'), null)
}

export async function saveGroup(home, group) {
  group.updatedAt = new Date().toISOString()
  await writeJson(path.join(batchDir(home, group.groupId), 'state.json'), group)
  return group
}

export function pendingParts(group, now = Date.now()) {
  if (group.status === 'uploaded') return []
  return (group.parts || []).filter((part) => part.status !== 'uploaded' && (!part.nextAttemptAt || part.nextAttemptAt <= now))
}

export function isGroupFinished(group) {
  return (group.parts || []).every((part) => part.status === 'uploaded')
}

export function scheduleRetry(part, delays, now = Date.now()) {
  part.attempts = (part.attempts || 0) + 1
  const delay = delays[Math.min(part.attempts - 1, delays.length - 1)] || 60
  part.nextAttemptAt = now + delay * 1000
  return part
}

export function hasPendingForTarget(groups, targetId) {
  return groups.some((group) => group.session?.id === targetId && group.status !== 'uploaded')
}

// ---------------------------------------------------------------- 清理

async function sizeOf(directory) {
  let total = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) total += await sizeOf(absolute)
    else if (entry.isFile()) {
      try {
        total += (await stat(absolute)).size
      } catch {
        /* 已被删除 */
      }
    }
  }
  return total
}

/**
 * 本地保留策略：已上传的按天数清，失败的最多留更久；总量超限时从最旧的已上传批次开始删。
 * 只删自己目录下的批次，绝不碰别处的文件。
 */
export async function cleanup(home, retention, log = () => {}) {
  const groups = await listGroups(home)
  const now = Date.now()
  const day = 24 * 3600 * 1000
  const keepUploaded = (retention.keepUploadedDays || 7) * day
  const keepFailed = (retention.keepFailedDays || 14) * day
  const removed = []
  for (const group of groups) {
    const created = Date.parse(group.createdAt) || now
    const age = now - created
    const uploaded = group.status === 'uploaded'
    if (uploaded && age > keepUploaded) {
      await rm(batchDir(home, group.groupId), { recursive: true, force: true })
      removed.push(group.groupId)
    } else if (!uploaded && age > keepFailed) {
      await rm(batchDir(home, group.groupId), { recursive: true, force: true })
      removed.push(group.groupId)
    }
  }
  const remaining = (await listGroups(home)).filter((group) => group.status === 'uploaded')
  let total = 0
  const sizes = new Map()
  for (const group of remaining) {
    const bytes = await sizeOf(batchDir(home, group.groupId))
    sizes.set(group.groupId, bytes)
    total += bytes
  }
  const cap = retention.maxLocalBytes || 2 * 1024 * 1024 * 1024
  for (const group of remaining) {
    if (total <= cap) break
    await rm(batchDir(home, group.groupId), { recursive: true, force: true })
    total -= sizes.get(group.groupId) || 0
    removed.push(group.groupId)
  }
  if (removed.length) log(`本地清理：删除 ${removed.length} 个旧批次`)
  return removed
}

export async function removeGroup(home, groupId) {
  await rm(batchDir(home, groupId), { recursive: true, force: true })
}
