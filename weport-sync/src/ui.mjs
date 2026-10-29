import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, normalize, saveConfig, validateForSync } from './config.mjs'
import { engineFromConfig } from './engine.mjs'
import { ensureDirs, listGroups, loadLedger } from './queue.mjs'
import { loadSessions } from './sessions.mjs'
import { createContext, flushPending, runOnce } from './sync.mjs'
import { acquireLock, createLogger } from './runtime.mjs'
import { checkHealth } from './upload.mjs'
import { layout } from './paths.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

function json(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(payload)
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) {
    chunks.push(chunk)
    if (chunks.reduce((total, item) => total + item.length, 0) > 2 * 1024 * 1024) throw new Error('请求体过大')
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function publicConfig(config) {
  return {
    serverUrl: config.server.baseUrl,
    hasToken: Boolean(config.upload.token),
    intervalSeconds: config.schedule.intervalSeconds,
    initialLookbackHours: config.initialLookbackHours,
    targets: config.targets,
    export: config.export,
    engine: { mode: config.engine.mode, appDir: config.engine.appDir, exe: config.engine.exe },
    upload: { maxBatchBytes: config.upload.maxBatchBytes },
  }
}

/**
 * 本地控制台。只监听 127.0.0.1，不做账号体系：能从本机打开这个端口的人，
 * 本来就能读到这台机器的微信数据。
 */
export async function startUi({ home, port = 8799 }) {
  await ensureDirs(home)
  const log = createLogger(home)
  let engine = null
  let busy = null
  let lastSync = null

  async function getEngine(config) {
    if (engine) return engine
    engine = engineFromConfig(config, path.join(home, 'profile'))
    await engine.start()
    return engine
  }

  function serialize(task) {
    const previous = busy || Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    busy = next.catch(() => {})
    return next
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`)
    try {
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = await readFile(path.join(here, '..', 'public', 'index.html'))
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(html)
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/status') {
        const config = await loadConfig(home)
        const ledger = await loadLedger(home)
        const groups = await listGroups(home)
        const health = config.server.baseUrl ? await checkHealth(config.server.baseUrl, 8000) : { ok: false, message: '未配置服务器' }
        json(response, 200, {
          config: publicConfig(config),
          problems: validateForSync(config),
          server: health,
          targets: config.targets.map((target) => ({
            ...target,
            cursor: ledger.targets[target.id]?.cursor || null,
            lastSuccessAt: ledger.targets[target.id]?.lastSuccessAt || null,
          })),
          pending: groups.filter((group) => group.status !== 'uploaded').map((group) => ({
            groupId: group.groupId,
            session: group.session?.name,
            range: group.range,
            parts: (group.parts || []).map((part) => ({ index: part.index, status: part.status, attempts: part.attempts, error: part.error || null })),
          })),
          uploadedToday: groups.filter((group) => group.status === 'uploaded' && String(group.uploadedAt || '').startsWith(new Date().toISOString().slice(0, 10))).length,
          lastSync,
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/chats') {
        const config = await loadConfig(home)
        if (!config.engine.appDir && !config.engine.exe) return json(response, 400, { error: '还没有配置 Weport 程序位置，请先在命令行执行 setup' })
        const query = String(url.searchParams.get('q') || '').toLowerCase()
        const result = await serialize(async () => {
          const active = await getEngine(config)
          return await loadSessions(active, home, { force: url.searchParams.get('refresh') === '1' })
        })
        const sessions = result.sessions
          .filter((session) => !query || `${session.name} ${session.id}`.toLowerCase().includes(query))
          .slice(0, 200)
          .map((session) => ({ id: session.id, name: session.name, type: session.type, messageCount: session.messageCount }))
        json(response, 200, { sessions, cachedAt: result.cachedAt })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/targets') {
        const body = await readBody(request)
        const config = await loadConfig(home)
        const add = Array.isArray(body.add) ? body.add : []
        const remove = Array.isArray(body.remove) ? body.remove : []
        const known = new Map(config.targets.map((target) => [target.id, target]))
        for (const item of add) {
          if (!item?.id) continue
          known.set(String(item.id), { id: String(item.id), name: String(item.name || item.id), addedAt: new Date().toISOString() })
        }
        for (const id of remove) known.delete(String(id))
        config.targets = [...known.values()]
        await saveConfig(config, home)
        json(response, 200, { targets: config.targets })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/config') {
        const body = await readBody(request)
        const config = await loadConfig(home)
        if (body.serverUrl !== undefined) config.server.baseUrl = String(body.serverUrl || '').replace(/\/+$/, '')
        if (body.token) config.upload.token = String(body.token)
        if (body.intervalSeconds) config.schedule.intervalSeconds = Number(body.intervalSeconds)
        if (body.initialLookbackHours) config.initialLookbackHours = Number(body.initialLookbackHours)
        if (body.images !== undefined) config.export.images = Boolean(body.images)
        if (body.files !== undefined) config.export.files = Boolean(body.files)
        if (body.maxFileMb) config.export.maxFileMb = Number(body.maxFileMb)
        await saveConfig(normalize(config), home)
        json(response, 200, { ok: true, config: publicConfig(await loadConfig(home)) })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/sync') {
        const config = await loadConfig(home)
        const problems = validateForSync(config)
        if (problems.length) return json(response, 400, { error: problems.join('；') })
        const lock = acquireLock(home)
        if (!lock.ok) return json(response, 409, { error: `已有同步进程在运行（pid ${lock.holder?.pid}）` })
        serialize(async () => {
          try {
            const fresh = await loadConfig(home)
            const active = await getEngine(fresh)
            lastSync = { startedAt: new Date().toISOString(), running: true }
            const summary = await runOnce(createContext({ home, config: fresh, engine: active, log }))
            lastSync = { ...summary, running: false }
            return summary
          } catch (error) {
            lastSync = { startedAt: new Date().toISOString(), running: false, error: error.message }
            throw error
          } finally {
            lock.release()
          }
        }).catch((error) => log(`手动同步失败：${error.message}`))
        json(response, 202, { started: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/flush') {
        const config = await loadConfig(home)
        const result = await serialize(async () => flushPending(createContext({ home, config, engine: await getEngine(config), log }), { ignoreBackoff: true }))
        json(response, 200, result)
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/log') {
        const lines = Math.min(500, Number(url.searchParams.get('lines') || 100))
        try {
          const text = await readFile(path.join(layout(home).logs, 'sync.log'), 'utf8')
          json(response, 200, { lines: text.trimEnd().split('\n').slice(-lines) })
        } catch {
          json(response, 200, { lines: [] })
        }
        return
      }
      json(response, 404, { error: 'not_found' })
    } catch (error) {
      json(response, 500, { error: String(error.message || error) })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  console.log(`本地控制台已启动：http://127.0.0.1:${port}`)
  console.log('关闭窗口即可停止；数据只在本机读写。')

  const shutdown = async () => {
    server.close()
    if (engine) await engine.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  return server
}
