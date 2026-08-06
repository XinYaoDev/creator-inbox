import { useCallback, useEffect, useState } from 'react'

type PlatformInfo = { name: string; cookieValid: boolean | null; hasCookie: boolean }
type Status = {
  lastCollect: number | null
  collecting: boolean
  platforms: Record<string, PlatformInfo>
  lastError: string | null
  counts: {
    videos: number
    comments: number
    sessions: number
    messages: number
    byPlatform: Record<string, { videos: number; comments: number }>
  }
}
type CommentItem = {
  platform: string
  commentId: string
  exportId: string
  nickname: string
  content: string
  headUrl: string
  createTime: number
  likeCount: number
  rootCommentId: string
  replies?: CommentItem[]
}
type VideoCard = {
  platform: string
  objectId: string
  title: string
  thumbUrl: string
  createTime: number
  commentCount: number
  latestCommentTs: number
  comments: CommentItem[]
}
type SessionItem = {
  platform: string
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
const proxied = (url?: string | null) =>
  url ? `/api/avatar?url=${encodeURIComponent(url)}` : ''

function Avatar({ url, name }: { url?: string | null; name?: string }) {
  if (url) return <img className="avatar" src={proxied(url)} alt="" loading="lazy" />
  return <div className="avatar avatar-fallback">{(name || '?').slice(0, 1)}</div>
}

function ReplyBox({ commentId, platform, onSent }: { commentId: string; platform: string; onSent: () => void }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState('')
  const send = async () => {
    if (!text.trim() || sending) return
    setSending(true)
    setErr('')
    try {
      const r = await fetch(`/api/comments/${encodeURIComponent(commentId)}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text.trim(), platform }),
      }).then((x) => x.json())
      if (r.ok) {
        setText('')
        onSent()
      } else {
        setErr(r.error || '发送失败')
      }
    } catch (e) {
      setErr(String(e))
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="replybox">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && send()}
        placeholder="友善回复…"
        disabled={sending}
      />
      <button className="btn" onClick={send} disabled={sending || !text.trim()}>
        {sending ? '发送中…' : '发送'}
      </button>
      {err && <span className="send-err">{err}</span>}
    </div>
  )
}

function CommentRow({ c, indent, onSent }: { c: CommentItem; indent?: boolean; onSent: () => void }) {
  const [open, setOpen] = useState(false)
  const canReply = c.platform === 'wechat' // 抖音回复暂未接入
  return (
    <div className={indent ? 'comment indent' : 'comment'}>
      <Avatar url={c.headUrl} name={c.nickname} />
      <div className="row-main">
        <div className="row-head">
          <span className="nick">{c.nickname || '匿名'}</span>
          <span className="time mono">{fmtTime(c.createTime)}</span>
        </div>
        <div className="content">{c.content}</div>
        <div className="meta">
          <span className="mono">赞 {c.likeCount}</span>
          {canReply && (
            <button className="linkbtn" onClick={() => setOpen(!open)}>
              {open ? '收起' : '回复'}
            </button>
          )}
        </div>
        {open && canReply && <ReplyBox commentId={c.commentId} platform={c.platform} onSent={onSent} />}
      </div>
    </div>
  )
}

export default function App() {
  const [tab, setTab] = useState<'comments' | 'dm'>('comments')
  const [platform, setPlatform] = useState<'all' | 'wechat' | 'douyin'>('all')
  const [status, setStatus] = useState<Status | null>(null)
  const [videos, setVideos] = useState<VideoCard[]>([])
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [cur, setCur] = useState<string | null>(null)
  const [msgs, setMsgs] = useState<MsgItem[]>([])
  const [busy, setBusy] = useState(false)
  const [dmInput, setDmInput] = useState('')
  const [dmSending, setDmSending] = useState(false)
  const [dmErr, setDmErr] = useState('')

  const load = useCallback(async () => {
    const st: Status = await fetch('/api/status').then((r) => r.json())
    setStatus(st)
    const q = platform === 'all' ? '' : `?platform=${platform}`
    const vs = await fetch(`/api/videos/with-comments${q}`).then((r) => r.json())
    setVideos(vs.list || [])
    const ss = await fetch('/api/dm/sessions').then((r) => r.json())
    setSessions(ss.list || [])
  }, [platform])

  const loadMsgs = useCallback(async (sid: string) => {
    const d = await fetch(`/api/dm/sessions/${encodeURIComponent(sid)}/messages`).then((r) => r.json())
    setMsgs(d.list || [])
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 60 * 1000)
    return () => clearInterval(t)
  }, [load])

  useEffect(() => {
    if (cur) loadMsgs(cur)
    else setMsgs([])
  }, [cur, loadMsgs])

  const refresh = async () => {
    setBusy(true)
    try {
      await fetch('/api/collect', { method: 'POST' })
      await load()
    } finally {
      setBusy(false)
    }
  }

  const sendDm = async () => {
    if (!cur || !dmInput.trim() || dmSending) return
    setDmSending(true)
    setDmErr('')
    try {
      const r = await fetch(`/api/dm/sessions/${encodeURIComponent(cur)}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: dmInput.trim() }),
      }).then((x) => x.json())
      if (r.ok) {
        setDmInput('')
        await loadMsgs(cur)
      } else {
        setDmErr(r.error || '发送失败')
      }
    } catch (e) {
      setDmErr(String(e))
    } finally {
      setDmSending(false)
    }
  }

  const curSession = sessions.find((s) => s.sessionId === cur)
  const platformName = (k: string) => status?.platforms?.[k]?.name || k
  const cookieBadge = (k: string) => {
    const p = status?.platforms?.[k]
    if (!p) return null
    if (!p.hasCookie) return <b className="bad">未配置</b>
    if (p.cookieValid == null) return <b>未知</b>
    return p.cookieValid ? <b className="ok">有效</b> : <b className="bad">已失效</b>
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">聚合收件箱</div>
        <div className="status">
          <span>最后采集 {fmtTime(status?.lastCollect)}</span>
          <span>视频号 Cookie {cookieBadge('wechat')}</span>
          <span>抖音 Cookie {cookieBadge('douyin')}</span>
          <span className="mono">
            评论 {status?.counts.comments ?? '—'}（视频号 {status?.counts.byPlatform?.wechat?.comments ?? 0} / 抖音{' '}
            {status?.counts.byPlatform?.douyin?.comments ?? 0}） / 会话 {status?.counts.sessions ?? '—'} / 私信{' '}
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
        <>
          <div className="pfilters">
            {(['all', 'wechat', 'douyin'] as const).map((p) => (
              <button
                key={p}
                className={platform === p ? 'pfilter active' : 'pfilter'}
                onClick={() => setPlatform(p)}
              >
                {p === 'all' ? '全部平台' : platformName(p)}
              </button>
            ))}
          </div>
          <main className="videolist">
            {videos.length === 0 && <div className="empty">暂无评论</div>}
            {videos.map((v) => (
              <section className="vcard" key={`${v.platform}:${v.objectId}`}>
                <header className="vcard-head">
                  {v.thumbUrl ? (
                    <img className="vthumb" src={proxied(v.thumbUrl)} alt="" loading="lazy" />
                  ) : (
                    <div className="vthumb avatar-fallback">视频</div>
                  )}
                  <div className="vcard-info">
                    <div className="vcard-title">
                      <span className={`ptag ptag-${v.platform}`}>{platformName(v.platform)}</span>
                      {v.title || '（无文案视频）'}
                    </div>
                    <div className="vcard-meta mono">
                      发布 {fmtTime(v.createTime)} · 评论 {v.commentCount}
                    </div>
                  </div>
                </header>
                <div className="vcomments">
                  {v.comments.map((c) => (
                    <div key={c.commentId}>
                      <CommentRow c={c} onSent={load} />
                      {(c.replies || []).map((r) => (
                        <CommentRow key={r.commentId} c={r} indent onSent={load} />
                      ))}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </main>
        </>
      )}

      {tab === 'dm' && (
        <main className="dm">
          <aside className="sessions">
            {sessions.length === 0 && <div className="empty">暂无私信会话</div>}
            {sessions.map((s) => (
              <button
                key={`${s.platform}:${s.sessionId}`}
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
                <div className="msgs-flow">
                  {msgs.map((m) => {
                    const self = curSession
                      ? m.fromUsername !== curSession.username
                      : m.fromUsername.startsWith('v2_')
                    return (
                      <div key={m.svrMsgId} className={self ? 'msg self' : 'msg'}>
                        <div className="bubble">
                          <div className="content">{m.content}</div>
                          <div className="time mono">{fmtTime(m.ts)}</div>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div className="sendbox">
                  <input
                    value={dmInput}
                    onChange={(e) => setDmInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && sendDm()}
                    placeholder="输入私信，Enter 发送"
                    disabled={dmSending}
                  />
                  <button className="btn" onClick={sendDm} disabled={dmSending || !dmInput.trim()}>
                    {dmSending ? '发送中…' : '发送'}
                  </button>
                </div>
                {dmErr && <div className="send-err">{dmErr}</div>}
              </>
            )}
          </section>
        </main>
      )}
    </div>
  )
}
