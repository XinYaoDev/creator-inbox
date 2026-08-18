import { withToken } from './api'

export const fmtTime = (s?: number | null) =>
  s ? new Date(s * 1000).toLocaleString('zh-CN', { hour12: false }) : '—'

// 头像/封面走服务端代理（防盗链），带上访问令牌
export const proxied = (url?: string | null) =>
  url ? withToken(`/api/avatar?url=${encodeURIComponent(url)}`) : ''
