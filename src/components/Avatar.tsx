import { proxied } from '../utils'

export default function Avatar({ url, name }: { url?: string | null; name?: string }) {
  if (url) return <img className="avatar" src={proxied(url)} alt="" loading="lazy" />
  return <div className="avatar avatar-fallback">{(name || '?').slice(0, 1)}</div>
}
