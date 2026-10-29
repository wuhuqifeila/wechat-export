import { access, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { loadConfig, saveConfig, validateForSync, serverUrl } from './config.mjs'
import { engineFromConfig } from './engine.mjs'
import { ensureDirs, listGroups, loadLedger, saveLedger } from './queue.mjs'
import { loadSessions, matchSessions } from './sessions.mjs'
import { createContext, flushPending, runOnce } from './sync.mjs'
import { createLogger, acquireLock } from './runtime.mjs'
import { checkHealth } from './upload.mjs'
import { hasTar } from './archive.mjs'
import { stateHome } from './paths.mjs'

export function parseArgs(argv) {
  const options = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      options._.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      options[key] = true
    } else {
      options[key] = next
      index += 1
    }
  }
  return options
}

function seconds(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

export async function resolveEngineDefaults(home) {
  const candidates = []
  if (process.env.WEPORT_APP_DIR) candidates.push({ mode: 'dev', appDir: process.env.WEPORT_APP_DIR })
  candidates.push({ mode: 'dev', appDir: process.cwd() })
  const local = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'weport', 'Weport.exe')
  if (await exists(local)) candidates.push({ mode: 'packaged', exe: local })
  for (const candidate of candidates) {
    if (candidate.mode === 'dev') {
      const pkg = path.join(candidate.appDir, 'package.json')
      if (await exists(pkg)) {
        const parsed = JSON.parse(await readFile(pkg, 'utf8'))
        if (parsed.name === 'weport') return candidate
      }
    } else if (await exists(candidate.exe)) {
      return candidate
    }
  }
  return null
}

async function withEngine(config, home, fn) {
  const engine = engineFromConfig(config, path.join(home, 'profile'))
  try {
    await engine.start()
    return await fn(engine)
  } finally {
    await engine.close()
  }
}

function printTable(rows, columns) {
  const widths = columns.map((column) => Math.max(column.title.length, ...rows.map((row) => String(row[column.key] ?? '').length)))
  console.log(columns.map((column, index) => column.title.padEnd(widths[index])).join('  '))
  for (const row of rows) console.log(columns.map((column, index) => String(row[column.key] ?? '').padEnd(widths[index])).join('  '))
}

async function prompt(rl, question, fallback = '') {
  const answer = (await rl.question(`${question}${fallback ? `（默认 ${fallback}）` : ''}：`)).trim()
  return answer || fallback
}

export async function setup(options, home) {
  const files = await ensureDirs(home)
  const config = await loadConfig(home)
  const rl = createInterface({ input, output })
  try {
    console.log('=== Weport 同步配置 ===')
    if (!config.engine.appDir && !config.engine.exe) {
      const detected = await resolveEngineDefaults(home)
      if (detected) {
        config.engine = { ...config.engine, ...detected }
        console.log(`已识别 Weport 程序位置：${detected.appDir || detected.exe}`)
      }
    }
    if (options['app-dir']) config.engine = { mode: 'dev', appDir: path.resolve(String(options['app-dir'])), exe: '' }
    if (options.exe) config.engine = { mode: 'packaged', appDir: '', exe: path.resolve(String(options.exe)) }
    if (!config.engine.appDir && !config.engine.exe) {
      const appDir = await prompt(rl, 'Weport 源码目录（包含 package.json 的那个目录）')
      if (appDir) config.engine = { mode: 'dev', appDir: path.resolve(appDir), exe: '' }
    }

    config.server.baseUrl = String(options.server || (await prompt(rl, '接收服务器地址', config.server.baseUrl || 'https://test-api.sumgg.top/wechat-sync'))).replace(/\/+$/, '')
    config.upload.token = String(options.token || (await prompt(rl, '上传令牌', config.upload.token ? '（已设置，直接回车保留）' : '')) || config.upload.token)
    if (config.upload.token === '（已设置，直接回车保留）') config.upload.token = (await loadConfig(home)).upload.token
    config.schedule.intervalSeconds = seconds(options.interval, config.schedule.intervalSeconds)
    config.initialLookbackHours = seconds(options.lookback, config.initialLookbackHours)
    await saveConfig(config, home)

    const engine = engineFromConfig(config, files.profile)
    const wantsAccount = options.db || options.key || !(await profileReady(engine))
    if (wantsAccount) {
      console.log('\n下一步写入微信账号信息。密钥只写进本机 Weport 配置，不写进同步配置、不上传。')
      const dbPath = String(options.db || (await prompt(rl, '微信数据目录（xwechat_files 的路径）')))
      const decryptKey = String(options.key || (await prompt(rl, '数据库密钥')))
      const wxid = String(options.wxid || (await prompt(rl, '当前登录的 wxid（可留空，Weport 会自己识别）')))
      try {
        await engine.start()
        if (dbPath) await engine.call('config.set', { key: 'dbPath', value: dbPath })
        if (decryptKey) await engine.call('config.set', { key: 'decryptKey', value: decryptKey })
        if (wxid) await engine.call('config.set', { key: 'myWxid', value: wxid })
        await engine.call('config.set', { key: 'onboardingDone', value: 'true' })
        await engine.call('config.set', { key: 'launchAtStartup', value: 'false' })
        await engine.call('config.set', { key: 'notificationEnabled', value: 'false' })
        const ping = await engine.call('cli.ping')
        console.log(`\n账号配置已写入：dbPath=${ping.dbPath ? '已设置' : '空'}，密钥=${ping.hasKey ? '已设置' : '缺失'}`)
        if (!ping.hasKey) console.log('注意：引擎没有读到密钥，导出会失败，请重新执行 setup 或检查密钥内容。')
      } finally {
        await engine.close()
      }
    } else {
      console.log('\n检测到引擎已有账号配置，跳过账号写入。')
    }

    const health = await checkHealth(config.server.baseUrl)
    console.log(`接收服务健康检查：${health.ok ? '正常' : `失败（${health.message}）`}`)
    console.log('\n下一步：node weport-sync/bin/weport-sync.mjs chats  然后 add 选定聊天，最后 ui 或 once。')
    return config
  } finally {
    rl.close()
  }
}

async function profileReady(engine) {
  try {
    await engine.start()
    const ping = await engine.call('cli.ping')
    return Boolean(ping.dbPath && ping.hasKey)
  } catch {
    return false
  } finally {
    await engine.close()
  }
}

export async function doctor(home) {
  const config = await loadConfig(home)
  const files = await ensureDirs(home)
  const report = { node: process.version, platform: `${os.platform()} ${os.arch()}`, home, problems: [] }
  console.log(`Node ${process.version} / ${report.platform}`)
  console.log(`状态目录：${home}`)
  if (!(await hasTar())) {
    report.problems.push('系统没有 tar 命令，无法打包上传')
    console.log('[x] tar 不可用')
  } else {
    console.log('[ok] tar 可用')
  }
  const problems = validateForSync(config)
  for (const problem of problems) console.log(`[x] ${problem}`)
  report.problems.push(...problems)
  if (!problems.length) {
    try {
      const ping = await withEngine(config, home, async (engine) => await engine.call('cli.ping'))
      console.log(`[ok] 引擎可启动，dbPath=${ping.dbPath ? '已设置' : '空'}，密钥=${ping.hasKey ? '已设置' : '缺失'}`)
      if (!ping.dbPath || !ping.hasKey) report.problems.push('引擎缺少数据目录或密钥')
    } catch (error) {
      report.problems.push(`引擎启动失败：${error.message}`)
      console.log(`[x] 引擎启动失败：${error.message}`)
    }
    const health = await checkHealth(config.server.baseUrl)
    console.log(`[${health.ok ? 'ok' : 'x'}] 接收服务：${health.ok ? '正常' : health.message}`)
    if (!health.ok) report.problems.push(`接收服务不可用：${health.message}`)
  }
  console.log(`\n结论：${report.problems.length ? `${report.problems.length} 项需要处理` : '配置可用'}`)
  return report
}

export async function listChats(options, home) {
  const config = await loadConfig(home)
  const sessions = await withEngine(config, home, async (engine) => (await loadSessions(engine, home, { force: Boolean(options.refresh) })).sessions)
  const query = String(options._[1] || '').toLowerCase()
  const filtered = query ? sessions.filter((session) => `${session.name} ${session.id}`.toLowerCase().includes(query)) : sessions
  if (options.json) {
    console.log(JSON.stringify(filtered, null, 2))
    return filtered
  }
  printTable(filtered.slice(0, Number(options.limit || 80)), [
    { key: 'name', title: '聊天名称' },
    { key: 'type', title: '类型' },
    { key: 'messageCount', title: '消息数' },
    { key: 'id', title: '会话ID' },
  ])
  console.log(`\n共 ${filtered.length} 个会话${filtered.length > Number(options.limit || 80) ? '（只显示前若干条，用 --limit 调大）' : ''}`)
  return filtered
}

export async function addTargets(options, home) {
  const config = await loadConfig(home)
  const names = options._.slice(1).filter(Boolean)
  if (!names.length) throw new Error('用法：add <聊天名称或会话ID> [更多…]')
  const sessions = await withEngine(config, home, async (engine) => (await loadSessions(engine, home, { force: Boolean(options.refresh) })).sessions)
  const added = []
  const problems = []
  for (const name of names) {
    const { exact, candidates } = matchSessions(sessions, name)
    if (exact.length === 1) {
      const session = exact[0]
      if (!config.targets.some((target) => target.id === session.id)) {
        config.targets.push({ id: session.id, name: session.name, addedAt: new Date().toISOString() })
        added.push(session)
      }
    } else if (exact.length > 1) {
      problems.push(`“${name}”匹配到 ${exact.length} 个同名聊天，请改用会话ID：${exact.map((item) => item.id).join('、')}`)
    } else if (candidates.length) {
      problems.push(`“${name}”没有精确匹配，候选：${candidates.slice(0, 8).map((item) => `${item.name}（${item.id}）`).join('；')}`)
    } else {
      problems.push(`“${name}”没有匹配到任何聊天`)
    }
  }
  if (added.length) await saveConfig(config, home)
  for (const session of added) console.log(`已加入：${session.name}（${session.id}）`)
  for (const problem of problems) console.log(`未加入：${problem}`)
  return { added, problems }
}

export async function removeTargets(options, home) {
  const config = await loadConfig(home)
  const keys = options._.slice(1).filter(Boolean)
  if (!keys.length) throw new Error('用法：remove <聊天名称或会话ID>')
  const removed = []
  config.targets = config.targets.filter((target) => {
    const hit = keys.includes(target.id) || keys.includes(target.name)
    if (hit) removed.push(target)
    return !hit
  })
  await saveConfig(config, home)
  for (const target of removed) console.log(`已移除：${target.name}（${target.id}）`)
  if (!removed.length) console.log('没有匹配到已选聊天')
  return removed
}

export async function showStatus(home) {
  const config = await loadConfig(home)
  const ledger = await loadLedger(home)
  const groups = await listGroups(home)
  const pending = groups.filter((group) => group.status !== 'uploaded')
  const uploadedToday = groups.filter((group) => group.status === 'uploaded' && String(group.uploadedAt || '').slice(0, 10) === new Date().toISOString().slice(0, 10))
  const summary = {
    server: config.server.baseUrl,
    intervalSeconds: config.schedule.intervalSeconds,
    targets: config.targets.map((target) => ({
      ...target,
      cursor: ledger.targets[target.id]?.cursor ? new Date(ledger.targets[target.id].cursor * 1000).toISOString() : null,
      lastSuccessAt: ledger.targets[target.id]?.lastSuccessAt || null,
    })),
    pendingGroups: pending.map((group) => ({
      groupId: group.groupId,
      session: group.session?.name,
      range: group.range,
      status: group.status,
      parts: (group.parts || []).map((part) => ({ index: part.index, status: part.status, attempts: part.attempts, error: part.error || null })),
    })),
    uploadedToday: uploadedToday.length,
  }
  console.log(JSON.stringify(summary, null, 2))
  return summary
}

export async function runSyncOnce(home) {
  const config = await loadConfig(home)
  const problems = validateForSync(config)
  if (problems.length) throw new Error(`配置不完整：${problems.join('；')}`)
  const log = createLogger(home)
  const lock = acquireLock(home)
  if (!lock.ok) throw new Error(`已有一个同步进程在运行（pid ${lock.holder?.pid}），本次跳过`)
  try {
    await ensureDirs(home)
    const summary = await withEngine(config, home, async (engine) => runOnce(createContext({ home, config, engine, log })))
    console.log(JSON.stringify(summary, null, 2))
    return summary
  } finally {
    lock.release()
  }
}

export async function runWatch(home) {
  const config = await loadConfig(home)
  const problems = validateForSync(config)
  if (problems.length) throw new Error(`配置不完整：${problems.join('；')}`)
  const log = createLogger(home)
  const lock = acquireLock(home)
  if (!lock.ok) throw new Error(`已有一个同步进程在运行（pid ${lock.holder?.pid}）`)
  const engine = engineFromConfig(config, path.join(home, 'profile'))
  let stopping = false
  const stop = () => {
    stopping = true
    log('收到退出信号，等当前这轮结束后退出')
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    await ensureDirs(home)
    await engine.start()
    log(`常驻同步已启动，间隔 ${config.schedule.intervalSeconds} 秒`)
    while (!stopping) {
      try {
        const fresh = await loadConfig(home)
        const summary = await runOnce(createContext({ home, config: fresh, engine, log }))
        log(`本轮完成：${summary.targets.map((item) => `${item.name}${item.empty ? '无新消息' : item.uploaded ? '已上传' : '待上传'}`).join('；') || '无目标'}`)
      } catch (error) {
        log(`本轮出错，下轮重试：${error.message}`)
      }
      if (stopping) break
      const jitter = Math.floor(Math.random() * (config.schedule.jitterSeconds || 0))
      const waitMs = (config.schedule.intervalSeconds + jitter) * 1000
      log(`下一次同步在 ${Math.round(waitMs / 1000)} 秒后`)
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, waitMs)
        const check = setInterval(() => {
          if (stopping) {
            clearTimeout(timer)
            clearInterval(check)
            resolve()
          }
        }, 1000)
        timer.unref?.()
      })
    }
  } finally {
    await engine.close()
    lock.release()
    log('常驻同步已退出')
  }
}

export async function flushOnly(home) {
  const config = await loadConfig(home)
  const log = createLogger(home)
  await ensureDirs(home)
  const result = await withEngine(config, home, async (engine) => flushPending(createContext({ home, config, engine, log }), { ignoreBackoff: true }))
  console.log(JSON.stringify(result, null, 2))
  return result
}

export async function resetCursor(keys, home) {
  const config = await loadConfig(home)
  const ledger = await loadLedger(home)
  const removed = []
  for (const key of keys) {
    for (const target of config.targets) {
      if (target.id === key || target.name === key) {
        delete ledger.targets[target.id]
        removed.push(target.name)
      }
    }
  }
  await saveLedger(home, ledger)
  console.log(removed.length ? `已重置游标：${removed.join('、')}（下次会按回看时长重导）` : '没有匹配到已选聊天')
  return removed
}

export { stateHome, serverUrl }
