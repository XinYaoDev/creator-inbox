import { useEffect, useState } from 'react'
import { api } from '../api'

type UpdateInfo = {
  running?: boolean
  stage?: string
  log?: string[]
  error?: string
  current?: string
  latest?: string
  available?: boolean
  reason?: string
  docker?: boolean
}

export default function UpdateBar() {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [open, setOpen] = useState(false)
  const [awaiting, setAwaiting] = useState(false)

  const loadCheck = async () => {
    const d: UpdateInfo = await api('/api/update/check').then((r) => r.json())
    setInfo(d)
  }

  useEffect(() => {
    loadCheck().catch(() => {})
    const t = setInterval(() => loadCheck().catch(() => {}), 6 * 60 * 60 * 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!open && !info?.running && !awaiting) return
    const t = setInterval(async () => {
      try {
        const d: UpdateInfo = await api('/api/update/status').then((r) => r.json())
        setInfo(d)
        if (d.stage === 'restarting') setAwaiting(true)
      } catch {
        setAwaiting(true)
      }
    }, 1000)
    return () => clearInterval(t)
  }, [open, info?.running, awaiting])

  useEffect(() => {
    if (!awaiting) return
    const t = setInterval(async () => {
      try {
        const r = await api('/api/status')
        if (r.ok) window.location.reload()
      } catch {
        /* still restarting */
      }
    }, 800)
    return () => clearInterval(t)
  }, [awaiting])

  const apply = async () => {
    setAwaiting(true)
    const r = await api('/api/update/apply', { method: 'POST' }).then((x) => x.json())
    setInfo(r)
    setOpen(true)
  }

  if (!info || info.docker) return null
  if (!info.available && !info.running && !open && !awaiting) return null

  const label = info.running || awaiting ? '更新中…' : `有新版本${info.latest ? ` ${String(info.latest).replace(/^v/, '')}` : ''}`

  return (
    <>
      <button className="iconbtn update-btn" onClick={() => setOpen(true)} disabled={Boolean(info.running) || awaiting}>
        {label}
      </button>
      {open && (
        <div className="modal-mask" onClick={() => !info.running && !awaiting && setOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">
              更新工作台
              <button className="linkbtn modal-x" onClick={() => !info.running && !awaiting && setOpen(false)} disabled={Boolean(info.running) || awaiting}>
                关闭
              </button>
            </div>
            <p className="qr-status">
              当前 {info.current || '—'}
              {info.latest ? ` → ${info.latest}` : ''}。会拉取代码、重新构建并重启本机服务，然后自动刷新。不替换 Mac App。数据库在 data/ 里，不会被动。
            </p>
            {info.error && <div className="errbar">{info.error}</div>}
            {info.log && info.log.length > 0 && (
              <pre className="update-log">{info.log.slice(-12).join('\n')}</pre>
            )}
            <div className="modal-foot">
              <button className="btn note-main" onClick={apply} disabled={Boolean(info.running) || awaiting || !info.available}>
                {info.running || awaiting ? '正在更新…' : '更新并重启'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
