import os from 'node:os'
import path from 'node:path'

/**
 * 状态目录：配置、游标、待上传批次、日志都放在这里。
 * 默认 %LOCALAPPDATA%\\WeportSync；可用 WEPORT_SYNC_HOME 改到别处（例如移动硬盘）。
 */
export function stateHome(env = process.env) {
  if (env.WEPORT_SYNC_HOME) return path.resolve(env.WEPORT_SYNC_HOME)
  const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(base, 'WeportSync')
}

export function layout(home = stateHome()) {
  return {
    home,
    config: path.join(home, 'config.json'),
    profile: path.join(home, 'profile'),
    batches: path.join(home, 'batches'),
    logs: path.join(home, 'logs'),
    locks: path.join(home, 'locks'),
    ledger: path.join(home, 'ledger.json'),
    sessionsCache: path.join(home, 'sessions-cache.json'),
  }
}
