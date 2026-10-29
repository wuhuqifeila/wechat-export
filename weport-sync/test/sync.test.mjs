import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'

import { defaultConfig, normalize, validateForSync } from '../src/config.mjs'
import { planParts } from '../src/archive.mjs'
import { classifyStatus, uploadPart } from '../src/upload.mjs'
import { advanceCursor, cleanup, listGroups, loadLedger, saveGroup, saveLedger } from '../src/queue.mjs'
import { createContext, runOnce, flushPending } from '../src/sync.mjs'

async function tempHome() {
  return await mkdtemp(path.join(os.tmpdir(), 'weport-sync-test-'))
}

async function receiver({ storage, token, respond } = {}) {
  const received = []
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: true, purpose: 'test' }))
      return
    }
    if (request.method === 'PUT') {
      if (respond) {
        const custom = respond(request)
        if (custom) {
          response.writeHead(custom.status, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify(custom.body || null))
          return
        }
      }
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      const sha = createHash('sha256').update(body).digest('hex')
      if (body.length !== Number(request.headers['content-length']) || sha !== request.headers['x-content-sha256']) {
        response.writeHead(422, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: 'checksum_mismatch' }))
        return
      }
      const batchId = request.url.split('/').pop()
      received.push({ batchId, bytes: body.length, sha256: sha })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: true, batchId, sha256: sha, bytes: body.length }))
      return
    }
    response.writeHead(404)
    response.end('')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(resolve)
    }),
  }
}

function fakeEngine({ messages = 2, withMedia = true } = {}) {
  const calls = []
  return {
    calls,
    async call(command, args) {
      calls.push({ command, args })
      if (command !== 'export.range') throw new Error(`unexpected command ${command}`)
      await mkdir(args.output, { recursive: true })
      const messagesBody = Array.from({ length: messages }, (_, index) => ({ localId: index + 1, createTime: args.start + index, content: `第${index + 1}条` }))
      const sessionDir = path.join(args.output, '群聊_测试群')
      await mkdir(sessionDir, { recursive: true })
      await writeFile(path.join(sessionDir, '群聊_测试群.json'), JSON.stringify({ session: { wxid: args.session }, messages: messagesBody }))
      if (withMedia) {
        await mkdir(path.join(sessionDir, 'images'), { recursive: true })
        await writeFile(path.join(sessionDir, 'images', 'a.jpg'), Buffer.alloc(2048, 7))
      }
      return {
        outputDir: args.output,
        dateRange: { start: args.start, end: args.end },
        stats: {
          messageCount: messages,
          firstMessageAt: args.start,
          lastMessageAt: args.start + messages - 1,
          mediaFiles: withMedia ? 1 : 0,
          mediaBytes: withMedia ? 2048 : 0,
          mediaByKind: withMedia ? { images: { files: 1, bytes: 2048 } } : {},
        },
      }
    },
    async start() {},
    async close() {},
  }
}

test('配置默认值、范围与校验', () => {
  const config = normalize({ schedule: { intervalSeconds: 5 }, initialLookbackHours: 0, targets: [{ id: 'a@chatroom', name: 'A' }, { name: '坏数据' }] })
  assert.equal(config.schedule.intervalSeconds, 60)
  assert.equal(config.initialLookbackHours, 24)
  assert.deepEqual(config.targets.map((target) => target.id), ['a@chatroom'])
  assert.equal(config.upload.token, '')
  const problems = validateForSync(defaultConfig())
  assert.ok(problems.some((item) => item.includes('服务器')))
  assert.ok(problems.some((item) => item.includes('聊天')))
})

test('历史 server.token 迁移到 upload.token', () => {
  const config = normalize({ server: { baseUrl: 'https://x/', token: 'abc' } })
  assert.equal(config.upload.token, 'abc')
  assert.equal(config.server.baseUrl, 'https://x')
  assert.equal(config.server.token, undefined)
})

test('分卷：不拆单个附件，超限附件被跳过', () => {
  const files = [
    { path: 'export/a.json', absolute: 'x', bytes: 10 },
    { path: 'export/images/1.jpg', absolute: 'x', bytes: 200 * 1024 },
    { path: 'export/images/2.jpg', absolute: 'x', bytes: 200 * 1024 },
    { path: 'export/files/huge.zip', absolute: 'x', bytes: 5 * 1024 * 1024 },
  ]
  const parts = planParts(files, 400 * 1024)
  const packed = parts.flat().map((file) => file.path)
  assert.ok(!packed.includes('export/files/huge.zip'))
  assert.ok(packed.includes('export/images/1.jpg'))
  assert.ok(parts.length >= 2)
  for (const part of parts) {
    const bytes = part.reduce((total, file) => total + file.bytes + 2048, 0)
    assert.ok(bytes <= 400 * 1024)
  }
})

test('上传状态分类：令牌错不重试、5xx 重试', () => {
  assert.equal(classifyStatus(401, { error: 'unauthorized' }).retryable, false)
  assert.equal(classifyStatus(413,).retryable, false)
  assert.equal(classifyStatus(507,).retryable, false)
  assert.equal(classifyStatus(503,).retryable, true)
  assert.equal(classifyStatus(200,).ok, true)
})

test('端到端：导出→分卷→上传→推进游标；服务器故障时保留待传', async () => {
  const home = await tempHome()
  const storage = await tempHome()
  const token = 'test-token'
  const server = await receiver({ token })
  const config = normalize({
    server: { baseUrl: server.url },
    upload: { token, maxBatchBytes: 512 * 1024 },
    targets: [{ id: '123@chatroom', name: '测试群' }],
    initialLookbackHours: 1,
    retention: { keepUploadedDays: 7, keepFailedDays: 14, maxLocalBytes: 1024 * 1024 * 1024 },
  })
  const engine = fakeEngine({ messages: 3 })
  const log = () => {}
  const ctx = createContext({ home, config, engine, log })

  const first = await runOnce(ctx)
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(server.received.length >= 1, true)
  const ledger = await loadLedger(home)
  assert.ok(ledger.targets['123@chatroom'].cursor > 0)

  // 把游标往回拨 60 秒，模拟"有新消息的时间窗"
  const rewound = await loadLedger(home)
  rewound.targets['123@chatroom'].cursor -= 60
  const rewoundCursor = rewound.targets['123@chatroom'].cursor
  await saveLedger(home, rewound)

  // 服务器改成 503：新消息应进入待传队列，游标不前进
  await server.close()
  const offline = await receiver({ token, respond: () => ({ status: 503, body: { error: 'unavailable' } }) })
  const offlineConfig = { ...config, server: { baseUrl: offline.url } }
  const offlineCtx = createContext({ home, config: offlineConfig, engine: fakeEngine({ messages: 2 }), log })
  const second = await runOnce(offlineCtx)
  assert.equal(second.ok, false)
  const pending = (await listGroups(home)).filter((group) => group.status !== 'uploaded')
  assert.equal(pending.length, 1)
  const cursorBefore = (await loadLedger(home)).targets['123@chatroom'].cursor
  assert.equal(cursorBefore, rewoundCursor)

  // 服务器恢复：补传成功，然后游标前进
  await offline.close()
  const restored = await receiver({ token })
  const restoreCtx = createContext({ home, config: { ...config, server: { baseUrl: restored.url } }, engine: fakeEngine({ messages: 2 }), log })
  const flush = await flushPending(restoreCtx, { ignoreBackoff: true })
  assert.equal(flush.failed, 0)
  assert.equal((await listGroups(home)).every((group) => group.status === 'uploaded'), true)
  await runOnce(restoreCtx)
  const cursorAfter = (await loadLedger(home)).targets['123@chatroom'].cursor
  assert.ok(cursorAfter >= cursorBefore)
  await restored.close()
  await rm(home, { recursive: true, force: true })
  await rm(storage, { recursive: true, force: true })
})

test('没有新消息时推进游标但不产生批次', async () => {
  const home = await tempHome()
  const config = normalize({ server: { baseUrl: 'http://127.0.0.1:1' }, upload: { token: 'x' }, targets: [{ id: 'g@chatroom', name: '空群' }] })
  const ctx = createContext({ home, config, engine: fakeEngine({ messages: 0, withMedia: false }), log: () => undefined })
  const summary = await runOnce(ctx)
  assert.equal(summary.targets[0].empty, true)
  assert.equal((await listGroups(home)).length, 0)
  assert.ok((await loadLedger(home)).targets['g@chatroom'].cursor > 0)
  await rm(home, { recursive: true, force: true })
})

test('本地保留：超过天数或总量时清理已上传批次', async () => {
  const home = await tempHome()
  const config = normalize({})
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
  const groupId = randomUUID()
  const dir = path.join(home, 'batches', groupId)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'part-1.tar.gz'), Buffer.alloc(4096))
  await saveGroup(home, { groupId, session: { id: 'x', name: 'X' }, range: { start: 1, end: 2 }, createdAt: old, status: 'uploaded', parts: [] })
  await cleanup(home, config.retention, () => {})
  assert.equal((await listGroups(home)).length, 0)
  await rm(home, { recursive: true, force: true })
})
