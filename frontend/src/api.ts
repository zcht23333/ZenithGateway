import { reactive } from 'vue'

export const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
export const authState = reactive({ authenticated: false, ready: false, checking: false, error: '' })
let credential = ''
let credentialVersion = 0

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly field?: string, public readonly details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试'
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const version = credentialVersion
  const headers = new Headers(init.headers)
  if (init.body != null) headers.set('Content-Type', 'application/json')
  if (credential) headers.set('Authorization', `Bearer ${credential}`)
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init, headers, signal: init.signal ?? AbortSignal.timeout(10_000)
    })
  } catch (error) {
    if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) {
      throw new Error('请求已取消或超时，请重试')
    }
    throw new Error('无法连接网关，请检查服务地址和网络')
  }
  if (version !== credentialVersion) throw new Error('凭据已变更，请重试')
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    const message = response.status === 401
      ? '管理凭据无效或已失效，请重新输入'
      : body.message || body.detail || `请求失败（HTTP ${response.status}）`
    if (response.status === 401) {
      authState.authenticated = false
      authState.error = message
    }
    throw new ApiError(message, response.status, body.field, body)
  }
  return response.status === 204 ? undefined as T : response.json()
}

// Credentials live only in this page's memory, never in the bundle or browser storage.
export async function authenticate(token: string): Promise<void> {
  credential = token.trim()
  credentialVersion++
  authState.checking = true
  authState.error = ''
  try {
    await apiRequest('/settings/runtime/adopted')
    authState.authenticated = true
  } catch (error) {
    credential = ''
    authState.authenticated = false
    authState.error = errorMessage(error)
  } finally {
    authState.ready = true
    authState.checking = false
  }
}

export function logout() {
  credential = ''
  credentialVersion++
  authState.authenticated = false
  authState.error = ''
}
