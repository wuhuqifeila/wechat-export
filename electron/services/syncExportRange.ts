/**
 * Headless export for the sync client.
 *
 * The GUI export sheet can only be driven by a human; the sync client needs a
 * repeatable "one chat, one time window" call, plus a flat summary of what it got
 * (message count, newest timestamp, media volume) so it can advance its cursor and
 * size the upload without re-reading the export afterwards.
 */
import { isAbsolute } from 'node:path'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ExportOptions } from './export'

export interface RangeSyncRequest {
  session?: unknown
  output?: unknown
  start?: unknown
  end?: unknown
  maxFileMb?: unknown
  mediaPolicy?: unknown
  images?: unknown
  files?: unknown
  voices?: unknown
  videos?: unknown
  avatars?: unknown
}

export interface RangeSyncPlan {
  sessionId: string
  outputDir: string
  options: ExportOptions
}

export interface RangeSyncStats {
  messageCount: number
  firstMessageAt: number | null
  lastMessageAt: number | null
  mediaFiles: number
  mediaBytes: number
  mediaByKind: Record<string, { files: number; bytes: number }>
}

function truthyFlag(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback
  const text = String(value).trim().toLowerCase()
  if (['0', 'false', 'no', 'off'].includes(text)) return false
  return true
}

function asSeconds(value: unknown): number | null {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Builds the export plan. Throws on anything the caller must fix instead of guessing,
 * because a wrong window here silently loses chat history.
 */
export function rangeSyncExport(args: RangeSyncRequest, now = new Date()): RangeSyncPlan {
  const sessionId = String(args.session || '').trim()
  const outputDir = String(args.output || '').trim()
  if (!sessionId) throw new Error('必须明确选择一个聊天，不能导出全部会话')
  if (!isAbsolute(outputDir)) throw new Error('输出目录必须是绝对路径')

  const midnight = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
  const start = asSeconds(args.start) ?? midnight
  const end = asSeconds(args.end) ?? Math.floor(now.getTime() / 1000)
  if (start >= end) throw new Error('时间范围无效：start 必须早于 end')

  const rawMax = Number(args.maxFileMb)
  const maxFileSizeMb = Number.isFinite(rawMax) ? Math.max(1, Math.min(50, Math.floor(rawMax))) : 5
  const mediaPolicy = String(args.mediaPolicy || 'best-available')

  const options: ExportOptions = {
    format: 'json',
    dateRange: { start, end },
    exportMedia: true,
    exportImages: truthyFlag(args.images, true),
    exportFiles: truthyFlag(args.files, true),
    exportVoices: truthyFlag(args.voices, false),
    exportVideos: truthyFlag(args.videos, false),
    exportEmojis: false,
    exportAvatars: truthyFlag(args.avatars, false),
    maxFileSizeMb,
    mediaPolicy: mediaPolicy === 'original-only' ? 'original-only' : 'best-available',
    sessionLayout: 'per-session',
    exportWriteLayout: 'C',
    exportPathStyle: 'posix',
    exportConflictStrategy: 'rename',
    displayNamePreference: 'remark',
    verifyAfterExport: false,
    skipSourceMediaFingerprint: true,
  }
  return { sessionId, outputDir, options }
}

function walk(root: string, relative = ''): Array<{ path: string; relative: string; bytes: number }> {
  const files: Array<{ path: string; relative: string; bytes: number }> = []
  for (const name of readdirSync(root)) {
    const absolute = join(root, name)
    const rel = relative ? `${relative}/${name}` : name
    const stat = statSync(absolute)
    if (stat.isDirectory()) files.push(...walk(absolute, rel))
    else if (stat.isFile()) files.push({ path: absolute, relative: rel, bytes: stat.size })
  }
  return files
}

/**
 * Reads what the exporter wrote. Only the JSON formatter output is inspected; media
 * is counted on disk, so a missing or undecryptable image shows up as absent rather
 * than as a file that silently failed.
 */
export function collectExportStats(outputDir: string): RangeSyncStats {
  const stats: RangeSyncStats = {
    messageCount: 0,
    firstMessageAt: null,
    lastMessageAt: null,
    mediaFiles: 0,
    mediaBytes: 0,
    mediaByKind: {},
  }
  const files = walk(outputDir)
  for (const file of files) {
    if (!file.relative.toLowerCase().endsWith('.json')) continue
    let parsed: any
    try {
      parsed = JSON.parse(readFileSync(file.path, 'utf8'))
    } catch {
      continue
    }
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : null
    if (!messages) continue
    for (const message of messages) {
      const at = Number(message?.createTime)
      if (!Number.isFinite(at) || at <= 0) continue
      stats.messageCount += 1
      if (stats.firstMessageAt === null || at < stats.firstMessageAt) stats.firstMessageAt = at
      if (stats.lastMessageAt === null || at > stats.lastMessageAt) stats.lastMessageAt = at
    }
  }
  for (const file of files) {
    if (file.relative.toLowerCase().endsWith('.json')) continue
    // 只统计 <会话>/media/<images|files|voices|videos>/ 下的真实附件；
    // 导出账本、清单这类元数据不算媒体，否则每批都会虚报一个"附件"。
    const segments = file.relative.split('/')
    const mediaIndex = segments.indexOf('media')
    if (mediaIndex < 0) continue
    const kind = segments[mediaIndex + 1] || 'other'
    const bucket = stats.mediaByKind[kind] || { files: 0, bytes: 0 }
    bucket.files += 1
    bucket.bytes += file.bytes
    stats.mediaByKind[kind] = bucket
    stats.mediaFiles += 1
    stats.mediaBytes += file.bytes
  }
  return stats
}
