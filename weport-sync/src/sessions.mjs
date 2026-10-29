import { readFile, writeFile } from 'node:fs/promises'
import { layout } from './paths.mjs'

/**
 * 会话名在 sessions.list 里经常是 wxid 或群 id，必须再用 contacts.info 换成备注名，
 * 否则客户在界面上根本认不出要同步哪个聊天。
 */
export async function listAllSessions(engine, { limit = 2000 } = {}) {
  const sessions = await engine.call('sessions.list', { type: 'all', limit }, 180000)
  if (!Array.isArray(sessions)) throw new Error('会话列表格式异常')
  return sessions
}

export async function resolveDisplayNames(engine, sessions, { chunk = 50 } = {}) {
  const resolved = []
  for (let index = 0; index < sessions.length; index += chunk) {
    const slice = sessions.slice(index, index + chunk)
    let contacts = null
    try {
      contacts = await engine.call('contacts.info', { usernames: slice.map((item) => item.id).join(',') }, 120000)
    } catch {
      // 通讯录读取失败不该让整轮同步失败：保留原始名字，下次再解析。
      contacts = null
    }
    for (const session of slice) {
      const contact = contacts?.[session.id]
      const name = contact?.displayName || contact?.remark || contact?.nickname || session.name
      resolved.push({ ...session, name: String(name || session.id) })
    }
  }
  return resolved
}

export async function loadSessions(engine, home, { maxAgeMs = 5 * 60 * 1000, force = false } = {}) {
  const cacheFile = layout(home).sessionsCache
  if (!force) {
    try {
      const cached = JSON.parse(await readFile(cacheFile, 'utf8'))
      if (cached?.cachedAt && Date.now() - cached.cachedAt < maxAgeMs && Array.isArray(cached.sessions)) {
        return { sessions: cached.sessions, cachedAt: cached.cachedAt, fromCache: true }
      }
    } catch {
      /* 没有缓存就走实时读取 */
    }
  }
  const sessions = await resolveDisplayNames(engine, await listAllSessions(engine))
  const cachedAt = Date.now()
  await writeFile(cacheFile, JSON.stringify({ cachedAt, sessions }, null, 2)).catch(() => {})
  return { sessions, cachedAt, fromCache: false }
}

export function matchSessions(sessions, query) {
  const text = String(query || '').trim()
  if (!text) return { exact: [], candidates: [] }
  const byId = sessions.filter((session) => session.id === text)
  if (byId.length === 1) return { exact: byId, candidates: [] }
  const byName = sessions.filter((session) => session.name === text)
  if (byName.length > 0) return { exact: byName, candidates: [] }
  const lowered = text.toLowerCase()
  const candidates = sessions.filter((session) => String(session.name || '').toLowerCase().includes(lowered) || String(session.id).toLowerCase().includes(lowered))
  return { exact: [], candidates }
}
