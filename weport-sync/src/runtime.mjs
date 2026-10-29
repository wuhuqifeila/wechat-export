import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { layout } from './paths.mjs'

const MAX_LOG_BYTES = 5 * 1024 * 1024

export function createLogger(home, { echo = true } = {}) {
  const dir = layout(home).logs
  const file = path.join(dir, 'sync.log')
  return async function log(message) {
    const line = `[${new Date().toISOString()}] ${message}`
    if (echo) console.log(line)
    try {
      await mkdir(dir, { recursive: true })
      const info = await stat(file).catch(() => null)
      if (info && info.size > MAX_LOG_BYTES) await rename(file, `${file}.1`).catch(() => {})
      await appendFile(file, `${line}\n`)
    } catch {
      /* 日志失败不影响同步 */
    }
  }
}

/**
 * 单实例锁：计划任务和常驻进程不能同时跑同一个账号的同步，
 * 否则同一个时间窗会被导出两次。锁里写 pid，进程不在了就接管。
 */
export function acquireLock(home, name = 'sync') {
  const dir = layout(home).locks
  const file = path.join(dir, `${name}.lock`)
  mkdirSync(dir, { recursive: true })
  if (existsSync(file)) {
    try {
      const previous = JSON.parse(readFileSync(file, 'utf8'))
      if (previous?.pid && previous.pid !== process.pid && isAlive(previous.pid)) {
        return { ok: false, holder: previous }
      }
    } catch {
      /* 坏锁直接接管 */
    }
  }
  writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
  return {
    ok: true,
    release() {
      try {
        const current = JSON.parse(readFileSync(file, 'utf8'))
        if (current?.pid === process.pid) unlinkSync(file)
      } catch {
        /* 已释放 */
      }
    },
  }
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
