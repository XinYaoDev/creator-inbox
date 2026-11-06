// 统一 fetch 封装：自动携带 AUTH_TOKEN（localStorage 持久化）；
// 收到 401 时广播事件，由 App 弹出令牌输入框
let token = localStorage.getItem('inbox_token') || ''
let workspace = sessionStorage.getItem('laike_workspace') || 'default'
export function setWorkspace(id: string) {
  workspace = id || 'default'
  sessionStorage.setItem('laike_workspace', workspace)
}

export const getToken = () => token

export function setToken(t: string) {
  token = t.trim()
  if (token) localStorage.setItem('inbox_token', token)
  else localStorage.removeItem('inbox_token')
}

export async function api(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  headers.set('X-Workspace-ID', workspace)
  headers.set('X-Requested-With', 'LaikeAI')
  const res = await fetch(input, { ...init, headers })
  if (res.status === 401) window.dispatchEvent(new Event('inbox:unauthorized'))
  return res
}

// <img>/<video> 直链无法带请求头，改用 ?token= 查询参数（服务端同样认可）
export function withToken(url: string): string {
  return token ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url
}
