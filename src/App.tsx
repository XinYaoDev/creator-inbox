import { useCallback, useEffect, useState } from 'react'

type Status = {
  lastCollect: number | null
  cookieValid: boolean | null
  collecting: boolean
  lastError: string | null
  counts: { videos: number; comments: number; sessions: number; messages: number }
}
type CommentItem = {
  commentId: string
  nickname: string
  content: string
  headUrl: string
  createTime: number
  likeCount: number
  videoTitle: string | null
}
type SessionItem = {
  sessionId: string
  username: string
  nickname: string
  headImgUrl: string
  sessionType: number
  lastContent: string | null
  lastTs: number | null
  msgCount: number
  unread: number
}
type MsgItem = {
  svrMsgId: string
  sessionId: string
  fromUsername: string
  toUsername: string
  content: string
  ts: number
  msgType: number
}

const fmtTime = (s?: number | null) =>
  s ? new Date(s * 1000).toLocaleString('zh-CN', { hour12: false }) : '—'

function Avatar({ url, name }: { url?: string; name?: string }) {
  if (url) return <img className="avatar" src={url} alt="" loading="lazy" />
  return <div className="avatar avatar-fallback">{(name || '?').slice(0, 1)}</div>
}

export default function App() {
  const [tab, setTab] = useState<'comments' | 'dm'>('comments')
  const [status, setStatus] = useState<Status | null>(null)
  const [comments, setComments] = useState<CommentItem[]>([])
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [cur, setCur] = useState<string | null>(null)
  const [msgs, setMsgs] = useState<MsgItem[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const st: Status = await fetch('/api/status').then((r) => r.json())
    setStatus(st)
    const cs = await fetch('/api/comments?limit=100').then((r) => r.json())
    setComments(cs.list || [])
    const ss = await fetch('/api/dm/sessions').then((r) => r.json())
    setSessions(ss.list || [])
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 60 * 1000)
    return () => clearInterval(t)
  }, [load])

  useEffect(() => {
    if (!cur) {
      setMsgs([])
      return
    }
    fetch(`/api/dm/sessions/${encodeURIComponent(cur)}/messages`)
      .then((r) => r.json())
      .then((d) => setMsgs(d.list || []))
  }, [cur])

  const refresh = async () => {
    setBusy(true)
    try {
      await fetch('/api/collect', { method: 'POST' })
      await load()
    } finally {
      setBusy(false)
    }
  }

  const curSession = sessions.find((s) => s.sessionId === cur)
  const cookieText =
    status?.cookieValid == null ? '未知' : status.cookieValid ? '有效' : '已失效'

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          聚合收件箱 <span className="brand-dot">·</span> 视频号
        </div>
        <div className="status">
          <span>最后采集 {fmtTime(status?.lastCollect)}</span>
          <span>
            Cookie{' '}
            <b className={status?.cookieValid === false ? 'bad' : 'ok'}>{cookieText}</b>
          </span>
          <span className="mono">
            评论 {status?.counts.comments ?? '—'} / 会话 {status?.counts.sessions ?? '—'} / 私信{' '}
            {status?.counts.messages ?? '—'}
          </span>
          <button className="btn" onClick={refresh} disabled={busy || status?.collecting}>
            {busy || status?.collecting ? '采集中…' : '手动刷新'}
          </button>
        </div>
      </header>
      {status?.lastError && <div className="errbar">采集异常：{status.lastError}</div>}

      <nav className="tabs">
        <button className={tab === 'comments' ? 'tab active' : 'tab'} onClick={() => setTab('comments')}>
          评论
        </button>
        <button className={tab === 'dm' ? 'tab active' : 'tab'} onClick={() => setTab('dm')}>
          私信
        </button>
      </nav>

      {tab === 'comments' && (
        <main className="list">
          {comments.length === 0 && <div className="empty">暂无评论</div>}
          {comments.map((c) => (
            <div className="row" key={c.commentId}>
              <Avatar url={c.headUrl} name={c.nickname} />
              <div className="row-main">
                <div className="row-head">
                  <span className="nick">{c.nickname || '匿名'}</span>
                  <span className="time mono">{fmtTime(c.createTime)}</span>
                </div>
                <div className="content">{c.content}</div>
                <div className="meta">
                  <span className="video">{c.videoTitle || '（无标题视频）'}</span>
                  <span className="mono">赞 {c.likeCount}</span>
                </div>
              </div>
            </div>
          ))}
        </main>
      )}

      {tab === 'dm' && (
        <main className="dm">
          <aside className="sessions">
            {sessions.length === 0 && <div className="empty">暂无私信会话</div>}
            {sessions.map((s) => (
              <button
                key={s.sessionId}
                className={s.sessionId === cur ? 'session active' : 'session'}
                onClick={() => setCur(s.sessionId)}
              >
                <Avatar url={s.headImgUrl} name={s.nickname} />
                <div className="session-main">
                  <div className="row-head">
                    <span className="nick">{s.nickname || '未知用户'}</span>
                    <span className="time mono">{fmtTime(s.lastTs)}</span>
                  </div>
                  <div className="preview">
                    {s.lastContent || '（暂无消息）'} <span className="mono">· {s.msgCount} 条</span>
                  </div>
                </div>
              </button>
            ))}
          </aside>
          <section className="msgs">
            {!cur && <div className="empty">选择左侧会话查看消息</div>}
            {cur && (
              <>
                <div className="msgs-title">{curSession?.nickname || '会话'}</div>
                {msgs.map((m) => {
                  const self = curSession ? m.fromUsername !== curSession.username : m.fromUsername.startsWith('v2_')
                  return (
                    <div key={m.svrMsgId} className={self ? 'msg self' : 'msg'}>
                      <div className="bubble">
                        <div className="content">{m.content}</div>
                        <div className="time mono">{fmtTime(m.ts)}</div>
                      </div>
                    </div>
                  )
                })}
              </>
            )}
          </section>
        </main>
      )}
    </div>
  )
}
