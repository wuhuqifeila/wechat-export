import { readFile } from 'node:fs/promises'

export class UploadError extends Error {
  constructor(message, { retryable = true, status = 0, code = '' } = {}) {
    super(message)
    this.name = 'UploadError'
    this.retryable = retryable
    this.status = status
    this.code = code
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

export function classifyStatus(status, body) {
  const code = String(body?.error || '')
  if (status >= 200 && status < 300) return { retryable: false, code, ok: true }
  if (status === 401 || status === 403) {
    return { retryable: false, code, ok: false, message: '上传令牌被拒绝，请核对 upload.token' }
  }
  if (status === 409) return { retryable: false, code, ok: false, message: '批次号冲突（同号不同内容），需要重新生成批次' }
  if (status === 413) return { retryable: false, code, ok: false, message: '批次超过服务器单批上限，请调小 upload.maxBatchBytes' }
  if (status === 422) return { retryable: true, code, ok: false, message: '服务器校验和不匹配，需要重传' }
  if (status === 507) return { retryable: false, code, ok: false, message: '服务器存储空间不足，需先扩容或清理' }
  if (RETRYABLE_STATUS.has(status)) return { retryable: true, code, ok: false, message: `服务器暂时不可用（HTTP ${status}）` }
  return { retryable: false, code, ok: false, message: `上传被拒绝（HTTP ${status}）` }
}

export async function uploadPart({ baseUrl, token, batchId, file, bytes, sha256, timeoutMs = 120000 }) {
  if (!/^[0-9a-f-]{36}$/.test(batchId)) throw new Error(`批次号格式不正确：${batchId}`)
  const body = await readFile(file)
  if (body.length !== bytes) throw new Error(`打包文件与记录不一致：${file}`)
  let response
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}/batches/${batchId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/gzip',
        'Content-Length': String(bytes),
        'X-Content-SHA256': sha256,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new UploadError(`网络不可用或超时：${error.message}`, { retryable: true })
  }
  let receipt = {}
  try {
    receipt = await response.json()
  } catch {
    receipt = {}
  }
  const verdict = classifyStatus(response.status, receipt)
  if (!verdict.ok) throw new UploadError(verdict.message, { retryable: verdict.retryable, status: response.status, code: verdict.code })
  if (receipt.sha256 !== sha256 || Number(receipt.bytes) !== bytes || receipt.batchId !== batchId) {
    throw new UploadError('服务器回执与本地上传不一致，按失败处理', { retryable: true, status: response.status })
  }
  return receipt
}

export async function checkHealth(baseUrl, timeoutMs = 15000) {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return { ok: false, message: `健康检查返回 HTTP ${response.status}` }
    const body = await response.json().catch(() => null)
    return { ok: body?.ok === true, message: body?.purpose || '' }
  } catch (error) {
    return { ok: false, message: error.message }
  }
}
