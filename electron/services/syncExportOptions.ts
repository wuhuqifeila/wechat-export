import { isAbsolute } from 'node:path'
import type { ExportOptions } from './export'

export function todaySyncExport(session: unknown, output: unknown, now = new Date()) {
  const sessionId = String(session || '').trim()
  const outputDir = String(output || '').trim()
  if (!sessionId) throw new Error('必须明确选择一个聊天，不能导出全部会话')
  if (!isAbsolute(outputDir)) throw new Error('输出目录必须是绝对路径')
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const options: ExportOptions = {
    format: 'json', dateRange: { start: Math.floor(midnight.getTime() / 1000), end: Math.floor(now.getTime() / 1000) },
    exportMedia: true, exportImages: true, exportFiles: true,
    exportVoices: false, exportVideos: false, exportEmojis: false, exportAvatars: false,
    maxFileSizeMb: 5, sessionLayout: 'per-session', exportWriteLayout: 'C',
    exportPathStyle: 'posix', exportConflictStrategy: 'rename',
    displayNamePreference: 'remark', verifyAfterExport: false,
  }
  return { sessionId, outputDir, options }
}
