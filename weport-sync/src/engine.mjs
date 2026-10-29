import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * 用 Node IPC 驱动 Weport 引擎（`--cli`），不模拟鼠标、不拼接 stdin 协议。
 * 引擎只吐结构化结果，日志一律不转发：原生报错里常带账号路径和聊天内容。
 */
export class Engine {
  constructor({ mode, appDir, exe, profile, env = process.env }) {
    this.mode = mode === 'packaged' ? 'packaged' : 'dev'
    this.appDir = appDir || ''
    this.exe = exe || ''
    this.profile = profile
    this.env = env
    this.pending = new Map()
    this.child = null
  }

  resolve() {
    const explicit = this.env.WEPORT_SYNC_ENGINE_EXE || this.exe
    if (explicit) {
      if (!existsSync(explicit)) throw new Error(`找不到 Weport 可执行文件：${explicit}`)
      return { command: explicit, args: [] }
    }
    if (this.mode === 'packaged') throw new Error('packaged 模式需要指定 Weport 可执行文件路径')
    if (!this.appDir) throw new Error('未设置 Weport 程序目录（engine.appDir）')
    const electron = path.join(this.appDir, 'node_modules', 'electron', 'dist', 'electron.exe')
    if (!existsSync(electron)) {
      throw new Error(`找不到引擎可执行文件：${electron}。请先在该目录执行 npm install，或改用 packaged 模式并指向已安装的 Weport.exe`)
    }
    if (!existsSync(path.join(this.appDir, 'dist-electron', 'main.js'))) {
      throw new Error(`程序目录里没有构建产物 dist-electron/main.js：${this.appDir}。请先执行 npm run build:dir 或 npm run dev 完成一次构建`)
    }
    return { command: electron, args: [this.appDir] }
  }

  async start(timeoutMs = 120000) {
    if (this.child) return this.ready
    const token = randomBytes(24).toString('hex')
    const env = { ...this.env, WEPORT_CLI_TOKEN: token, WEPORT_PROBE_OFFSCREEN: '1' }
    delete env.ELECTRON_RUN_AS_NODE
    const resolved = this.resolve()
    const args = [
      ...resolved.args,
      '--cli',
      '--disable-gpu',
      `--user-data-dir=${this.profile}`,
      '--weport-token', token,
    ]
    this.child = spawn(resolved.command, args, {
      cwd: this.appDir || path.dirname(resolved.command),
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.child.stdout.resume()
    this.child.stderr.resume()
    this.child.on('message', (message) => {
      const key = message?.kind === 'ready' || message?.kind === 'error' ? message.kind : message?.id
      const entry = this.pending.get(key)
      if (!entry) return
      clearTimeout(entry.timer)
      this.pending.delete(key)
      if (message.kind === 'error') entry.reject(new Error(String(message.error || '引擎返回错误')))
      else entry.resolve(message)
    })
    this.child.on('error', (error) => this.rejectAll(error))
    this.child.on('exit', (code) => {
      this.child = null
      this.rejectAll(new Error(`Weport 引擎已退出（code=${code}）`))
    })
    // 父进程被强杀时（例如计划任务被终止），至少让子进程跟着退出，
    // 否则残留的引擎会一直占着微信数据库句柄。
    this.killOnExit = () => {
      try { this.child?.kill() } catch { /* noop */ }
    }
    process.once('exit', this.killOnExit)
    this.ready = this.wait('ready', timeoutMs)
    this.child.send({ kind: 'hello', token })
    return this.ready
  }

  rejectAll(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  wait(id, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`引擎响应超时：${id}`))
      }, ms)
      this.pending.set(id, { resolve, reject, timer })
    })
  }

  async call(command, args = {}, timeout = 180000) {
    await this.start()
    const id = randomUUID()
    const result = this.wait(id, timeout)
    this.child.send({ kind: 'call', id, command, args })
    const payload = await result
    if (!payload.success) throw new Error(payload.error || `命令失败：${command}`)
    return payload.data
  }

  async close() {
    if (this.killOnExit) {
      process.removeListener('exit', this.killOnExit)
      this.killOnExit = null
    }
    if (!this.child) return
    const child = this.child
    this.child = null
    try {
      child.send({ kind: 'bye' })
    } catch {
      /* 通道已断 */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* noop */ }
        resolve()
      }, 5000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

export function engineFromConfig(config, profile, env) {
  return new Engine({
    mode: config.engine.mode,
    appDir: config.engine.appDir,
    exe: config.engine.exe,
    profile,
    env,
  })
}
