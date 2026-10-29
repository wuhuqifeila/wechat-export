import { mkdir, readFile, writeFile, chmod, rename } from 'node:fs/promises'
import path from 'node:path'
import { layout } from './paths.mjs'

export const CONFIG_VERSION = 1

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    server: { baseUrl: '', token: '' },
    engine: { mode: 'dev', appDir: '', exe: '' },
    targets: [],
    schedule: { intervalSeconds: 300, jitterSeconds: 10, runOnStart: true },
    export: {
      maxFileMb: 5,
      images: true,
      files: true,
      voices: false,
      videos: false,
      mediaPolicy: 'best-available',
    },
    upload: {
      maxBatchBytes: 10 * 1024 * 1024,
      token: '',
      retryDelaysSeconds: [30, 120, 300, 900, 1800],
    },
    retention: {
      keepUploadedDays: 7,
      keepFailedDays: 14,
      maxLocalBytes: 2 * 1024 * 1024 * 1024,
    },
    // 第一次同步只回看这么久，避免一上手就把几年历史全导出来。
    initialLookbackHours: 24,
  }
}

function merge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    out[key] = value && typeof value === 'object' && !Array.isArray(value) ? merge(base?.[key] || {}, value) : value
  }
  return out
}

export async function loadConfig(home) {
  const files = layout(home)
  try {
    const raw = await readFile(files.config, 'utf8')
    const parsed = JSON.parse(raw)
    return normalize(merge(defaultConfig(), parsed))
  } catch (error) {
    if (error.code === 'ENOENT') return normalize(defaultConfig())
    throw new Error(`配置文件读取失败：${files.config}（${error.message}）`)
  }
}

export async function saveConfig(config, home) {
  const files = layout(home)
  await mkdir(files.home, { recursive: true })
  const normalized = normalize(config)
  const temp = `${files.config}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(normalized, null, 2), { mode: 0o600 })
  await rename(temp, files.config)
  await chmod(files.config, 0o600).catch(() => {})
  return normalized
}

export function normalize(config) {
  const out = merge(defaultConfig(), config)
  out.targets = (Array.isArray(out.targets) ? out.targets : [])
    .filter((target) => target && typeof target.id === 'string' && target.id)
    .map((target) => ({ id: target.id, name: String(target.name || target.id), addedAt: target.addedAt || null }))
  out.schedule.intervalSeconds = clamp(Math.floor(Number(out.schedule.intervalSeconds) || 300), 60, 86400)
  out.schedule.jitterSeconds = clamp(Math.floor(Number(out.schedule.jitterSeconds) || 0), 0, 300)
  out.export.maxFileMb = clamp(Math.floor(Number(out.export.maxFileMb) || 5), 1, 50)
  out.upload.maxBatchBytes = clamp(Math.floor(Number(out.upload.maxBatchBytes) || 10 * 1024 * 1024), 256 * 1024, 200 * 1024 * 1024)
  out.initialLookbackHours = clamp(Math.floor(Number(out.initialLookbackHours) || 24), 1, 24 * 365)
  out.server.baseUrl = String(out.server.baseUrl || '').replace(/\/+$/, '')
  // 早期版本把上传令牌放在 server.token 下，统一到 upload.token，避免两处凭证。
  if (!out.upload.token && out.server.token) out.upload.token = String(out.server.token)
  delete out.server.token
  return out
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

/** 检查配置是否足以跑一次同步；返回人话的问题列表。 */
export function validateForSync(config) {
  const problems = []
  if (!config.server.baseUrl) problems.push('未设置接收服务器地址（service.baseUrl）')
  else if (!/^https?:\/\//i.test(config.server.baseUrl)) problems.push('接收服务器地址必须以 http:// 或 https:// 开头')
  if (!config.upload.token) problems.push('未设置上传令牌（upload.token）')
  if (!config.targets.length) problems.push('没有选择要同步的聊天')
  if (config.engine.mode === 'dev' && !config.engine.appDir) problems.push('未设置 Weport 程序目录（engine.appDir）')
  if (config.engine.mode === 'packaged' && !config.engine.exe) problems.push('未设置 Weport 可执行文件路径（engine.exe）')
  return problems
}

export function serverUrl(config, suffix = '') {
  const base = String(config.server.baseUrl || '').replace(/\/+$/, '')
  return `${base}${suffix}`
}
