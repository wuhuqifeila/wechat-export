import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { layout } from './paths.mjs'
import { archivePart, inventory, materializePart, planParts, sha256File } from './archive.mjs'
import { uploadPart } from './upload.mjs'
import {
  advanceCursor,
  batchDir,
  cleanup,
  hasPendingForTarget,
  isGroupFinished,
  listGroups,
  loadGroup,
  loadLedger,
  pendingParts,
  saveGroup,
  scheduleRetry,
} from './queue.mjs'

const SCHEMA_VERSION = 2

export function createContext({ home, config, engine, log = () => {}, now = () => Date.now() }) {
  return { home, config, engine, log, now }
}

/** 上传一批待发分卷；返回本次成功/失败的统计。 */
export async function flushPending(ctx, { ignoreBackoff = false } = {}) {
  const { home, config, log } = ctx
  const groups = await listGroups(home)
  const result = { uploaded: 0, failed: 0, remaining: 0 }
  for (const group of groups) {
    if (group.status === 'uploaded') continue
    const parts = pendingParts(group, ignoreBackoff ? Number.MAX_SAFE_INTEGER : ctx.now())
    if (!parts.length) {
      if (!isGroupFinished(group)) result.remaining += 1
      continue
    }
    for (const part of parts) {
      try {
        const receipt = await uploadPart({
          baseUrl: config.server.baseUrl,
          token: config.upload.token,
          batchId: part.batchId,
          file: path.join(batchDir(home, group.groupId), `part-${part.index}.tar.gz`),
          bytes: part.bytes,
          sha256: part.sha256,
        })
        part.status = 'uploaded'
        part.receipt = receipt
        part.uploadedAt = new Date().toISOString()
        part.error = null
        part.nextAttemptAt = null
        result.uploaded += 1
        log(`上传成功 ${group.session?.name || group.session?.id} 第${part.index}/${group.parts.length}包 ${(part.bytes / 1024).toFixed(0)}KB${receipt?.duplicate ? '（服务器已有同批，未重复保存）' : ''}`)
      } catch (error) {
        part.error = String(error.message || error)
        part.lastStatus = error.status || 0
        if (error.retryable === false) {
          part.status = 'rejected'
          log(`上传被拒绝 ${group.session?.name || ''} 第${part.index}包：${part.error}`)
        } else {
          scheduleRetry(part, config.upload.retryDelaysSeconds, ctx.now())
          log(`上传失败将重试 ${group.session?.name || ''} 第${part.index}包：${part.error}`)
        }
        result.failed += 1
      }
      await saveGroup(home, group)
    }
    if (isGroupFinished(group) && group.status !== 'uploaded') {
      group.status = 'uploaded'
      group.uploadedAt = new Date().toISOString()
      await saveGroup(home, group)
      // 补传也要推进游标：否则下一轮会把同一段时间重新导出一遍。
      const ledger = await loadLedger(home)
      const current = ledger.targets[group.session?.id]?.cursor || 0
      if (group.range?.end && group.range.end >= current) {
        await advanceCursor(home, { id: group.session.id, name: group.session.name }, {
          cursor: group.range.end,
          lastMessageAt: group.lastMessageAt,
          initialStart: group.initialStart,
          snapshotHash: group.snapshotHash,
        })
      }
    }
    if (group.status !== 'uploaded') result.remaining += 1
  }
  return result
}

async function recordRun(home, entry) {
  const file = path.join(layout(home).logs, 'runs.jsonl')
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(entry)}\n`)
}

/**
 * 单个聊天的一次增量导出。
 * 游标是已确认扫描到的时间。重复扫描有界窗口，快照变化后再传，
 * 为晚到消息和后下载附件补传留出机会。接收端后续需按消息源身份合并快照。
 */
export async function syncTarget(ctx, target, { lookbackHours }) {
  const { home, config, engine, log } = ctx
  const ledger = await loadLedger(home)
  const state = ledger.targets[target.id]
  const nowSec = Math.floor(ctx.now() / 1000)
  const midnight = new Date(ctx.now())
  midnight.setHours(0, 0, 0, 0)
  const initialStart = state?.initialStart ?? (state?.cursor
    ? Math.max(0, state.cursor - config.reconciliationHours * 3600)
    : config.initialWindow === 'lookback' ? nowSec - Math.max(1, lookbackHours) * 3600 : Math.floor(midnight.getTime() / 1000))
  const start = state?.cursor ? Math.max(initialStart, state.cursor - config.reconciliationHours * 3600) : initialStart
  const end = nowSec
  if (end - start < 1) return { target, skipped: 'empty_window' }
  const groupId = randomUUID()
  const dir = batchDir(home, groupId)
  const outputDir = path.join(dir, 'export')
  log(`开始导出 ${target.name}：${new Date(start * 1000).toLocaleString()} 起`)
  const data = await engine.call('export.range', {
    session: target.id,
    output: outputDir,
    start,
    end,
    maxFileMb: config.export.maxFileMb,
    mediaPolicy: config.export.mediaPolicy,
    images: config.export.images ? '1' : '0',
    files: config.export.files ? '1' : '0',
    voices: config.export.voices ? '1' : '0',
    videos: config.export.videos ? '1' : '0',
    avatars: '0',
  }, 1800000)
  const stats = data?.stats || { messageCount: 0, lastMessageAt: null, mediaFiles: 0, mediaBytes: 0, mediaByKind: Object.create(null) }
  if (!stats.messageCount) {
    await rm(dir, { recursive: true, force: true })
    await advanceCursor(home, target, { cursor: end, lastMessageAt: null, initialStart })
    log(`${target.name}：该时间段没有新消息`)
    return { target, empty: true, range: { start, end } }
  }
  const files = await inventory(outputDir)
  for (const file of files) file.sha256 = await sha256File(file.absolute)
  // JSON 导出时间/统计范围会随每轮改变，只比较消息正文和会话；附件比较实际字节。
  const fingerprint = []
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    // 引擎清单的 taskId 与导出文件哈希包含本次生成时间，不是聊天内容变化。
    if (['export-manifest.json', '.weport-export-ledger.jsonl'].includes(path.posix.basename(file.path))) continue
    let hash = file.sha256
    if (file.path.endsWith('.json') && !/\/(?:media|files|images)\//.test(file.path)) {
      const body = JSON.parse(await readFile(file.absolute, 'utf8'))
      if (Array.isArray(body.messages)) hash = createHash('sha256').update(JSON.stringify({ session: body.session, messages: body.messages })).digest('hex')
    }
    fingerprint.push([file.path, hash])
  }
  const snapshotHash = createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex')
  if (snapshotHash === state?.snapshotHash) {
    await rm(dir, { recursive: true, force: true })
    await advanceCursor(home, target, { cursor: end, lastMessageAt: stats.lastMessageAt, initialStart })
    return { target, unchanged: true, range: { start, end } }
  }
  const parts = planParts(files, config.upload.maxBatchBytes)
  const kept = new Set(parts.flat().map((file) => file.path))
  const skipped = files.filter((file) => !kept.has(file.path)).map((file) => ({
    path: file.path,
    bytes: file.bytes,
    reason: `单文件超过单批上限 ${config.upload.maxBatchBytes} 字节，未上传`,
  }))
  if (skipped.some(file => file.path.endsWith('.json') && !/\/(?:media|files|images)\//.test(file.path))) {
    throw new Error('聊天 JSON 超过单包限制，请增加 upload.maxBatchBytes；本次不推进游标')
  }
  if (!parts.length) {
    await rm(dir, { recursive: true, force: true })
    throw new Error(`${target.name} 的导出内容全部超过单批上限，没有可上传的分卷`)
  }
  const createdAt = new Date().toISOString()
  const group = {
    groupId,
    schemaVersion: SCHEMA_VERSION,
    snapshotHash,
    initialStart,
    payloadMode: 'window-snapshot',
    session: { id: target.id, name: target.name },
    range: { start, end },
    createdAt,
    status: 'pending',
    messageCount: stats.messageCount,
    mediaFiles: stats.mediaFiles,
    mediaBytes: stats.mediaBytes,
    mediaByKind: stats.mediaByKind,
    firstMessageAt: stats.firstMessageAt,
    lastMessageAt: stats.lastMessageAt,
    skipped,
    parts: [],
  }
  for (let index = 0; index < parts.length; index += 1) {
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      payloadMode: 'window-snapshot',
      snapshotHash,
      groupId,
      partIndex: index + 1,
      partCount: parts.length,
      session: group.session,
      range: group.range,
      createdAt,
      stats: { messageCount: stats.messageCount, firstMessageAt: stats.firstMessageAt, lastMessageAt: stats.lastMessageAt, mediaFiles: stats.mediaFiles, mediaBytes: stats.mediaBytes, mediaByKind: stats.mediaByKind },
      files: parts[index].map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
      skipped,
    }
    await materializePart(dir, index + 1, parts[index], manifest)
    const built = await archivePart(dir, index + 1)
    group.parts.push({
      index: index + 1,
      batchId: randomUUID(),
      bytes: built.bytes,
      sha256: built.sha256,
      fileCount: parts[index].length,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: null,
    })
  }
  await saveGroup(home, group)
  log(`${target.name}：导出 ${stats.messageCount} 条消息、${stats.mediaFiles} 个附件（${(stats.mediaBytes / 1024).toFixed(0)}KB），分 ${parts.length} 包`)
  return { target, group, range: { start, end }, stats }
}

/** 一轮完整同步：先补传积压，再逐个聊天增量导出并上传。 */
/**
 * 清理被强杀留下的空批次目录（只有 export/，没有 state.json）。
 * 不及时清会让磁盘上堆一批没人认领的导出文件。
 */
async function cleanupStaleBatches(home, log) {
  const dir = layout(home).batches
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  const cutoff = Date.now() - 15 * 60 * 1000
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const target = path.join(dir, entry.name)
    const info = await stat(target).catch(() => null)
    if (!info || info.mtimeMs > cutoff) continue
    const state = await stat(path.join(target, 'state.json')).catch(() => null)
    if (state) continue
    await rm(target, { recursive: true, force: true })
    log(`清理中断留下的空批次：${entry.name}`)
  }
}

export async function runOnce(ctx) {
  const { home, config, log } = ctx
  const startedAt = new Date().toISOString()
  const summary = { startedAt, targets: [], upload: null, ok: true, errors: [] }
  await cleanupStaleBatches(home, log)
  summary.upload = await flushPending(ctx)
  if (summary.upload.failed || summary.upload.remaining) summary.ok = false
  // 空间超限时停止拉取新数据，保留已有队列供补传。
  await cleanup(home, config.retention, log)
  const groups = await listGroups(home)
  for (const target of config.targets) {
    if (hasPendingForTarget(groups, target.id)) {
      const pending = groups.filter((group) => group.session?.id === target.id && group.status !== 'uploaded')
      log(`${target.name}：还有 ${pending.length} 个批次未上传，先补传再导出新数据`)
      summary.targets.push({ id: target.id, name: target.name, deferred: true, pending: pending.length })
      summary.ok = false
      continue
    }
    try {
      const outcome = await syncTarget(ctx, target, { lookbackHours: config.initialLookbackHours })
      if (outcome.group) {
        await flushPending(ctx)
        const parts = await loadGroup(home, outcome.group.groupId)
        const uploaded = parts && isGroupFinished(parts)
        if (uploaded) {
          parts.status = 'uploaded'
          await saveGroup(home, parts)
          await advanceCursor(home, target, { cursor: outcome.range.end, lastMessageAt: outcome.stats?.lastMessageAt, initialStart: parts.initialStart, snapshotHash: parts.snapshotHash })
          summary.targets.push({ id: target.id, name: target.name, messages: outcome.stats.messageCount, parts: parts.parts.length, uploaded: true })
        } else {
          summary.targets.push({ id: target.id, name: target.name, messages: outcome.stats.messageCount, parts: outcome.group.parts.length, uploaded: false })
          summary.ok = false
        }
      } else {
        summary.targets.push({ id: target.id, name: target.name, empty: Boolean(outcome.empty), unchanged: Boolean(outcome.unchanged) })
      }
    } catch (error) {
      summary.ok = false
      summary.errors.push({ id: target.id, name: target.name, error: String(error.message || error) })
      log(`同步失败 ${target.name}：${error.message}`)
    }
  }
  try {
    await cleanup(home, config.retention, log)
  } catch (error) {
    log(`本地清理失败：${error.message}`)
  }
  summary.finishedAt = new Date().toISOString()
  await recordRun(home, summary)
  return summary
}

export async function cachedExportStats(dir) {
  try {
    const info = await stat(dir)
    return info.isDirectory()
  } catch {
    return false
  }
}

export async function writeText(file, text) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
}
