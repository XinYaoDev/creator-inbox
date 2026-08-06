import { useCallback, useEffect, useRef, useState } from 'react'

type PlatformInfo = { name: string; cookieValid: boolean | null; hasCookie: boolean; accountCount: number }
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
type Group = { id: number; name: string; createdAt: number }
type Account = {
  id: number
  groupId: number
  platform: string
  platformName: string
  label: string
  nickname: string
  headImgUrl: string
  followers: number | null
  hasCookie: boolean
  cookieValid: boolean | null
}
type CommentItem = {
  platform: string
  accountId: number
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
type VideoItem = {
  platform: string
  accountId: number
  objectId: string
  title: string
  thumbUrl: string
  createTime: number
  commentCount: number
  latestCommentTs: number | null
  collectedComments: number
}
type SessionItem = {
  platform: string
  accountId: number
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
  platform: string
  accountId: number
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

function PublishTab({ groups, accounts }: { groups: Group[]; accounts: Account[] }) {
  const [file, setFile] = useState<File | null>(null)
  const [videoUrl, setVideoUrl] = useState('')
  const [meta, setMeta] = useState<{ width: number; height: number; duration: number } | null>(null)
  const [cover, setCover] = useState<Blob | null>(null)
  const [coverUrl, setCoverUrl] = useState('')
  const [desc, setDesc] = useState('')
  const [targetMode, setTargetMode] = useState<'group' | 'account'>('group')
  const [targetId, setTargetId] = useState<number>(0)
  const [stage, setStage] = useState('')
  const [results, setResults] = useState<{ label: string; platform: string; ok: boolean; error?: string; objectId?: string }[]>([])
  const [err, setErr] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)

  const reset = () => {
    setMeta(null)
    setCover(null)
    setCoverUrl('')
    setResults([])
    setErr('')
  }

  const pickFile = (f: File | null) => {
    reset()
    setFile(f)
    setVideoUrl(f ? URL.createObjectURL(f) : '')
  }

  // 视频加载出元数据后定位到 1s 处抽封面
  const onLoadedMeta = () => {
    const v = videoRef.current
    if (!v) return
    setMeta({ width: v.videoWidth, height: v.videoHeight, duration: Math.round(v.duration) })
    v.currentTime = Math.min(1, (v.duration || 2) / 2)
  }
  const onSeeked = () => {
    const v = videoRef.current
    if (!v || cover) return
    const c = document.createElement('canvas')
    c.width = v.videoWidth
    c.height = v.videoHeight
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.drawImage(v, 0, 0)
    c.toBlob(
      (b) => {
        if (b) {
          setCover(b)
          setCoverUrl(URL.createObjectURL(b))
        }
      },
      'image/jpeg',
      0.85,
    )
  }
  const pickCover = (f: File | null) => {
    if (!f) return
    setCover(f)
    setCoverUrl(URL.createObjectURL(f))
  }

  const submit = async () => {
    if (!file || !meta || stage) return
    if (!targetId) {
      setErr(targetMode === 'group' ? '请选择分组' : '请选择账号')
      return
    }
    setErr('')
    setResults([])
    try {
      setStage('上传视频到服务器…')
      const up = await fetch(`/api/upload/file?kind=video&filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        body: file,
      }).then((r) => r.json())
      if (!up.ok) throw new Error(up.error || '视频上传失败')
      let coverId = ''
      if (cover) {
        setStage('上传封面…')
        const cu = await fetch('/api/upload/file?kind=cover&filename=cover.jpg', {
          method: 'POST',
          body: cover,
        }).then((r) => r.json())
        if (cu.ok) coverId = cu.id
      }
      setStage('分片上传到视频号 CDN 并存草稿（多账号逐个执行，需几分钟）…')
      const dr = await fetch('/api/upload/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId: up.id,
          coverId,
          description: desc.trim(),
          ...(targetMode === 'group' ? { groupId: targetId } : { accountId: targetId }),
          ...meta,
        }),
      }).then((r) => r.json())
      setResults(dr.results || [])
      setStage('')
    } catch (e) {
      setErr(String((e as Error)?.message || e))
      setStage('')
    }
  }

  const wxAccounts = accounts.filter((a) => a.platform === 'wechat')

  return (
    <main className="pubform">
      <div className="pub-block">
        <div className="pub-label">视频文件（只存草稿，不直接发表）</div>
        <input type="file" accept="video/*" onChange={(e) => pickFile(e.target.files?.[0] || null)} />
      </div>
      {videoUrl && (
        <div className="pub-preview">
          <video
            ref={videoRef}
            src={videoUrl}
            className="pub-video"
            muted
            playsInline
            onLoadedMetadata={onLoadedMeta}
            onSeeked={onSeeked}
          />
          <div className="pub-side">
            {meta && (
              <div className="mono pub-meta">
                {meta.width}×{meta.height} · {meta.duration}s ·{' '}
                {file ? (file.size / 1024 / 1024).toFixed(1) : '?'}MB
              </div>
            )}
            <div className="pub-label">
              封面（自动抽帧，可换）{' '}
              <label className="linkbtn">
                选择图片
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => pickCover(e.target.files?.[0] || null)}
                />
              </label>
            </div>
            {coverUrl && <img className="pub-cover" src={coverUrl} alt="封面" />}
          </div>
        </div>
      )}
      <div className="pub-block">
        <div className="pub-label">文案</div>
        <textarea
          className="pub-desc"
          rows={3}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="视频描述…"
        />
      </div>
      <div className="pub-block">
        <div className="pub-label">发表目标（仅视频号账号会执行，抖音上传暂未接入）</div>
        <div className="pub-target">
          <select value={targetMode} onChange={(e) => { setTargetMode(e.target.value as 'group' | 'account'); setTargetId(0) }}>
            <option value="group">整组</option>
            <option value="account">单个账号</option>
          </select>
          {targetMode === 'group' ? (
            <select value={targetId} onChange={(e) => setTargetId(Number(e.target.value))}>
              <option value={0}>选择分组…</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          ) : (
            <select value={targetId} onChange={(e) => setTargetId(Number(e.target.value))}>
              <option value={0}>选择账号…</option>
              {wxAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label || `账号${a.id}`}（{a.platformName}）
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div className="pub-actions">
        <button className="btn" onClick={submit} disabled={!file || !meta || Boolean(stage)}>
          {stage || '存为草稿'}
        </button>
      </div>
      {results.length > 0 && (
        <div className="pub-results">
          {results.map((r, i) => (
            <div key={i} className={r.ok ? 'pub-ok' : 'send-err'}>
              {r.label || `账号${i + 1}`}：{r.ok ? `草稿已创建（${(r.objectId || '').slice(0, 20)}…）` : r.error}
            </div>
          ))}
        </div>
      )}
      {err && <div className="send-err">{err}</div>}
    </main>
  )
}

// ---------- 扫码登录弹层 ----------
function LoginModal({ acc, onClose, onDone }: { acc: Account; onClose: () => void; onDone: () => void }) {
  const [sessionId, setSessionId] = useState('')
  const [status, setStatus] = useState('starting') // starting|waiting|scanned|choose|done|expired|error|manual
  const [error, setError] = useState('')
  const [finderList, setFinderList] = useState<{ finderUsername: string; nickname: string; headImgUrl: string }[]>([])
  const [cookieText, setCookieText] = useState('')
  const sidRef = useRef('')

  const start = useCallback(async () => {
    setStatus('starting')
    setError('')
    const r = await fetch('/api/login/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: acc.id }),
    }).then((x) => x.json())
    if (r.ok) {
      setSessionId(r.sessionId)
      sidRef.current = r.sessionId
      setStatus('waiting')
    } else {
      setStatus('error')
      setError(r.error || '出码失败')
    }
  }, [acc.id])

  useEffect(() => { start() }, [start])

  // 轮询登录状态
  useEffect(() => {
    if (!sessionId || ['done', 'error', 'expired', 'manual'].includes(status)) return
    const t = setInterval(async () => {
      const r = await fetch(`/api/login/status?sessionId=${sessionId}`).then((x) => x.json()).catch(() => null)
      if (!r || !r.ok) return
      setStatus(r.status)
      setError(r.error || '')
      if (r.finderList) setFinderList(r.finderList)
      if (r.status === 'done') {
        onDone()
        setTimeout(onClose, 1200)
      }
    }, 2000)
    return () => clearInterval(t)
  }, [sessionId, status, onClose, onDone])

  // 关闭时取消会话
  useEffect(() => () => {
    if (sidRef.current) {
      fetch('/api/login/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sidRef.current }),
      })
    }
  }, [])

  const choose = async (finderUsername: string) => {
    const r = await fetch('/api/login/choose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, finderUsername }),
    }).then((x) => x.json())
    if (r.ok) {
      setStatus('done')
      onDone()
      setTimeout(onClose, 1200)
    } else {
      setStatus('error')
      setError(r.error || '选号失败')
    }
  }

  const saveManual = async () => {
    const cookie = cookieText.trim()
    if (!cookie) return
    const r = await fetch(`/api/accounts/${acc.id}/cookie`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie }),
    }).then((x) => x.json())
    if (r.ok) {
      onDone()
      onClose()
    } else setError(r.error || '保存失败')
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">
          {acc.hasCookie ? '重新登录' : '登录'} · {acc.label || acc.platformName}
          <button className="linkbtn modal-x" onClick={onClose}>关闭</button>
        </div>
        {status !== 'manual' && (
          <div className="modal-qr">
            {sessionId && status !== 'starting' && status !== 'error' ? (
              <img className="qrimg" src={`/api/login/qr?sessionId=${sessionId}`} alt="登录二维码" />
            ) : (
              <div className="qrimg qr-loading">{status === 'starting' ? '出码中…' : '出码失败'}</div>
            )}
            <div className="qr-status">
              {status === 'waiting' && '用微信扫一扫，手机上确认登录'}
              {status === 'scanned' && '已扫码，请在手机上确认…'}
              {status === 'confirmed' && '已确认，正在登录…'}
              {status === 'done' && '✓ 登录成功'}
              {status === 'expired' && '二维码已过期'}
              {status === 'error' && (error || '登录失败')}
            </div>
            {status === 'choose' && (
              <div className="qr-choose">
                <div className="pub-label">这个微信下有多个视频号，选择要登录的：</div>
                {finderList.map((f) => (
                  <button key={f.finderUsername} className="btn qr-choice" onClick={() => choose(f.finderUsername)}>
                    {f.nickname || f.finderUsername}
                  </button>
                ))}
              </div>
            )}
            {(status === 'expired' || status === 'error') && (
              <button className="btn" onClick={start}>重新出码</button>
            )}
          </div>
        )}
        {status === 'manual' && (
          <div className="acct-cookie">
            <textarea
              rows={4}
              value={cookieText}
              onChange={(e) => setCookieText(e.target.value)}
              placeholder="粘贴 Cookie 请求头整行（DevTools → Network → 任意请求 → Cookie）"
            />
            <div className="pub-actions">
              <button className="btn" onClick={saveManual} disabled={!cookieText.trim()}>保存</button>
            </div>
            {error && <div className="send-err">{error}</div>}
          </div>
        )}
        <div className="modal-foot">
          {status === 'manual' ? (
            <button className="linkbtn" onClick={() => setStatus('waiting')}>← 返回扫码登录</button>
          ) : (
            <button className="linkbtn" onClick={() => setStatus('manual')}>扫码不方便？手动粘贴 Cookie</button>
          )}
        </div>
      </div>
    </div>
  )
}

function AccountsTab({
  groups,
  accounts,
  onChanged,
}: {
  groups: Group[]
  accounts: Account[]
  onChanged: () => void
}) {
  const [newGroup, setNewGroup] = useState('')
  const [newLabel, setNewLabel] = useState<Record<number, string>>({})
  const [newPlatform, setNewPlatform] = useState<Record<number, string>>({})
  const [msg, setMsg] = useState('')
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [loginFor, setLoginFor] = useState<Account | null>(null)

  const toast = (s: string) => {
    setMsg(s)
    setTimeout(() => setMsg(''), 3000)
  }

  const addGroup = async () => {
    if (!newGroup.trim()) return
    const r = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newGroup.trim() }),
    }).then((x) => x.json())
    if (r.ok) {
      setNewGroup('')
      onChanged()
    } else toast(r.error || '创建失败')
  }

  const addAccount = async (groupId: number) => {
    const platform = newPlatform[groupId] || 'wechat'
    const label = (newLabel[groupId] || '').trim()
    const r = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId, platform, label }),
    }).then((x) => x.json())
    if (r.ok) {
      setNewLabel({ ...newLabel, [groupId]: '' })
      onChanged()
      toast('账号已创建，点「登录」扫码完成登录')
    } else toast(r.error || '创建失败')
  }

  const delAccount = async (acc: Account) => {
    const key = `acc:${acc.id}`
    if (confirmDel !== key) {
      setConfirmDel(key)
      return
    }
    setConfirmDel(null)
    await fetch(`/api/accounts/${acc.id}`, { method: 'DELETE' })
    onChanged()
  }

  const delGroup = async (g: Group) => {
    const key = `grp:${g.id}`
    if (confirmDel !== key) {
      setConfirmDel(key)
      return
    }
    setConfirmDel(null)
    const r = await fetch(`/api/groups/${g.id}`, { method: 'DELETE' }).then((x) => x.json())
    if (!r.ok) toast(r.error || '删除失败')
    onChanged()
  }

  return (
    <main className="acct">
      <div className="acct-addgroup">
        <input
          value={newGroup}
          onChange={(e) => setNewGroup(e.target.value)}
          placeholder="新分组名，如：妈妈账号"
          onKeyDown={(e) => e.key === 'Enter' && addGroup()}
        />
        <button className="btn" onClick={addGroup} disabled={!newGroup.trim()}>
          创建分组
        </button>
        {msg && <span className="pub-ok">{msg}</span>}
      </div>
      {groups.map((g) => (
        <section className="acct-group" key={g.id}>
          <header className="acct-group-head">
            <b>{g.name}</b>
            <button
              className={confirmDel === `grp:${g.id}` ? 'linkbtn danger' : 'linkbtn'}
              onClick={() => delGroup(g)}
            >
              {confirmDel === `grp:${g.id}` ? '确认删除分组？' : '删除分组'}
            </button>
          </header>
          <div className="acards">
            {(accounts.filter((a) => a.groupId === g.id)).map((a) => (
              <div className="acard" key={a.id}>
                {a.hasCookie && a.cookieValid === false && <div className="acard-badge">已失效</div>}
                {a.hasCookie && a.cookieValid === true && <div className="acard-badge ok">在线</div>}
                {!a.hasCookie && <div className="acard-badge off">未登录</div>}
                <div className="acard-avatar">
                  {a.headImgUrl ? (
                    <img src={proxied(a.headImgUrl)} alt="" loading="lazy" />
                  ) : (
                    <div className="acard-avatar-fallback">{(a.nickname || a.label || '?').slice(0, 1)}</div>
                  )}
                  <span className={`acard-ptag ptag-${a.platform}`}>{a.platformName}</span>
                </div>
                <div className="acard-name">{a.nickname || a.label || `账号${a.id}`}</div>
                <div className="acard-meta mono">
                  {a.followers != null ? `粉丝 ${a.followers}` : '粉丝 —'}
                  {a.label && a.nickname ? ` · ${a.label}` : ''}
                </div>
                <div className="acard-actions">
                  <button className="linkbtn" onClick={() => setLoginFor(a)}>
                    {a.hasCookie ? '重新登录' : '登录'}
                  </button>
                  <button
                    className={confirmDel === `acc:${a.id}` ? 'linkbtn danger' : 'linkbtn'}
                    onClick={() => delAccount(a)}
                  >
                    {confirmDel === `acc:${a.id}` ? '确认删除？' : '删除'}
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="acct-add">
            <select
              value={newPlatform[g.id] || 'wechat'}
              onChange={(e) => setNewPlatform({ ...newPlatform, [g.id]: e.target.value })}
            >
              <option value="wechat">视频号</option>
              <option value="douyin">抖音</option>
            </select>
            <input
              value={newLabel[g.id] || ''}
              onChange={(e) => setNewLabel({ ...newLabel, [g.id]: e.target.value })}
              placeholder="账号备注名，如：妈妈的视频号"
            />
            <button className="btn" onClick={() => addAccount(g.id)}>添加账号</button>
          </div>
        </section>
      ))}
      <div className="pub-label">
        视频号点「登录」直接扫码；抖音扫码暂未接入，弹层里可切换手动粘贴 Cookie。
      </div>
      {loginFor && (
        <LoginModal acc={loginFor} onClose={() => setLoginFor(null)} onDone={onChanged} />
      )}
    </main>
  )
}

export default function App() {
  const [tab, setTab] = useState<'comments' | 'dm' | 'publish' | 'accounts'>('comments')
  const [platform, setPlatform] = useState<'all' | 'wechat' | 'douyin'>('all')
  const [groupFilter, setGroupFilter] = useState<'all' | number>('all')
  const [status, setStatus] = useState<Status | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [videoList, setVideoList] = useState<VideoItem[]>([])
  const [curVideo, setCurVideo] = useState<string | null>(null) // "platform:accountId:objectId"
  const [videoComments, setVideoComments] = useState<CommentItem[]>([])
  const [onlyWithComments, setOnlyWithComments] = useState(true)
  const [videoSort, setVideoSort] = useState<'comment' | 'time'>('comment')
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [cur, setCur] = useState<string | null>(null) // "platform:accountId:sessionId"
  const [msgs, setMsgs] = useState<MsgItem[]>([])
  const [busy, setBusy] = useState(false)
  const [dmInput, setDmInput] = useState('')
  const [dmSending, setDmSending] = useState(false)
  const [dmErr, setDmErr] = useState('')

  const loadAccounts = useCallback(async () => {
    const d = await fetch('/api/accounts').then((r) => r.json())
    setGroups(d.groups || [])
    setAccounts(d.accounts || [])
  }, [])

  const load = useCallback(async () => {
    const st: Status = await fetch('/api/status').then((r) => r.json())
    setStatus(st)
    const params = new URLSearchParams()
    if (platform !== 'all') params.set('platform', platform)
    if (groupFilter !== 'all') params.set('groupId', String(groupFilter))
    if (onlyWithComments) params.set('hasComments', '1')
    params.set('sort', videoSort)
    const vs = await fetch(`/api/videos?${params}`).then((r) => r.json())
    const list: VideoItem[] = vs.list || []
    setVideoList(list)
    const sq = groupFilter !== 'all' ? `?groupId=${groupFilter}` : ''
    const ss = await fetch(`/api/dm/sessions${sq}`).then((r) => r.json())
    setSessions(ss.list || [])
  }, [platform, groupFilter, onlyWithComments, videoSort])

  // 列表变化后，保持/重选当前视频
  useEffect(() => {
    if (!videoList.length) {
      setCurVideo(null)
      return
    }
    if (!curVideo || !videoList.some((v) => `${v.platform}:${v.accountId}:${v.objectId}` === curVideo)) {
      const v = videoList[0]
      setCurVideo(`${v.platform}:${v.accountId}:${v.objectId}`)
    }
  }, [videoList, curVideo])

  const loadVideoComments = useCallback(async (key: string) => {
    const [p, accId, ...rest] = key.split(':')
    const objectId = rest.join(':')
    const d = await fetch(
      `/api/video/comments?platform=${encodeURIComponent(p)}&accountId=${encodeURIComponent(accId)}&objectId=${encodeURIComponent(objectId)}`,
    ).then((r) => r.json())
    setVideoComments(d.list || [])
  }, [])

  useEffect(() => {
    if (curVideo) loadVideoComments(curVideo)
    else setVideoComments([])
  }, [curVideo, loadVideoComments])

  const reloadCurrent = useCallback(async () => {
    if (curVideo) await loadVideoComments(curVideo)
    load()
  }, [curVideo, loadVideoComments, load])

  const loadMsgs = useCallback(async (key: string) => {
    const [p, accId, ...rest] = key.split(':')
    const sid = rest.join(':')
    const d = await fetch(
      `/api/dm/sessions/${encodeURIComponent(sid)}/messages?platform=${encodeURIComponent(p)}&accountId=${encodeURIComponent(accId)}`,
    ).then((r) => r.json())
    setMsgs(d.list || [])
  }, [])

  useEffect(() => {
    if (cur) loadMsgs(cur)
    else setMsgs([])
  }, [cur, loadMsgs])

  useEffect(() => {
    loadAccounts()
  }, [loadAccounts])

  useEffect(() => {
    load()
    const t = setInterval(load, 60 * 1000)
    return () => clearInterval(t)
  }, [load])

  const refresh = async () => {
    setBusy(true)
    try {
      await fetch('/api/collect', { method: 'POST' })
      await load()
      await loadAccounts()
    } finally {
      setBusy(false)
    }
  }

  const sendDm = async () => {
    if (!cur || !dmInput.trim() || dmSending) return
    const [p, accId, ...rest] = cur.split(':')
    const sid = rest.join(':')
    setDmSending(true)
    setDmErr('')
    try {
      const r = await fetch(`/api/dm/sessions/${encodeURIComponent(sid)}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: dmInput.trim(), accountId: Number(accId) }),
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

  const curSession = sessions.find((s) => `${s.platform}:${s.accountId}:${s.sessionId}` === cur)
  const platformName = (k: string) => status?.platforms?.[k]?.name || k
  const accountLabel = (id: number) => accounts.find((a) => a.id === id)?.label || ''
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
        <button className={tab === 'publish' ? 'tab active' : 'tab'} onClick={() => setTab('publish')}>
          发表
        </button>
        <button className={tab === 'accounts' ? 'tab active' : 'tab'} onClick={() => setTab('accounts')}>
          账号
        </button>
      </nav>

      {tab === 'publish' && <PublishTab groups={groups} accounts={accounts} />}
      {tab === 'accounts' && <AccountsTab groups={groups} accounts={accounts} onChanged={loadAccounts} />}

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
            <span className="psep" />
            <button
              className={groupFilter === 'all' ? 'pfilter active' : 'pfilter'}
              onClick={() => setGroupFilter('all')}
            >
              全部分组
            </button>
            {groups.map((g) => (
              <button
                key={g.id}
                className={groupFilter === g.id ? 'pfilter active' : 'pfilter'}
                onClick={() => setGroupFilter(g.id)}
              >
                {g.name}
              </button>
            ))}
            <label className="ptoggle">
              <input
                type="checkbox"
                checked={onlyWithComments}
                onChange={(e) => setOnlyWithComments(e.target.checked)}
              />
              只看有评论的
            </label>
            <span className="psort">
              {(
                [
                  ['comment', '按最新评论'],
                  ['time', '按发布时间'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  className={videoSort === k ? 'pfilter active' : 'pfilter'}
                  onClick={() => setVideoSort(k)}
                >
                  {label}
                </button>
              ))}
            </span>
          </div>
          <main className="comments-layout">
            <aside className="vlist">
              {videoList.length === 0 && <div className="empty">暂无视频</div>}
              {videoList.map((v) => {
                const key = `${v.platform}:${v.accountId}:${v.objectId}`
                return (
                  <button
                    key={key}
                    className={key === curVideo ? 'vrow active' : 'vrow'}
                    onClick={() => setCurVideo(key)}
                  >
                    {v.thumbUrl ? (
                      <img className="vrow-thumb" src={proxied(v.thumbUrl)} alt="" loading="lazy" />
                    ) : (
                      <div className="vrow-thumb avatar-fallback">视频</div>
                    )}
                    <div className="vrow-main">
                      <div className="vrow-title">
                        <span className={`ptag ptag-${v.platform}`}>{platformName(v.platform)}</span>
                        {v.title || '（无文案视频）'}
                      </div>
                      <div className="vrow-meta mono">
                        {fmtTime(v.createTime)} · 评论 {v.commentCount}
                        {accountLabel(v.accountId) ? ` · ${accountLabel(v.accountId)}` : ''}
                      </div>
                    </div>
                  </button>
                )
              })}
            </aside>
            <section className="vdetail">
              {!curVideo && <div className="empty">选择左侧视频查看评论</div>}
              {curVideo && (
                <>
                  {(() => {
                    const v = videoList.find((x) => `${x.platform}:${x.accountId}:${x.objectId}` === curVideo)
                    return v ? (
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
                            {accountLabel(v.accountId) ? ` · ${accountLabel(v.accountId)}` : ''}
                          </div>
                        </div>
                      </header>
                    ) : null
                  })()}
                  <div className="vcomments">
                    {videoComments.length === 0 && <div className="empty">暂无评论</div>}
                    {videoComments.map((c) => (
                      <div key={c.commentId}>
                        <CommentRow c={c} onSent={reloadCurrent} />
                        {(c.replies || []).map((r) => (
                          <CommentRow key={r.commentId} c={r} indent onSent={reloadCurrent} />
                        ))}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
          </main>
        </>
      )}

      {tab === 'dm' && (
        <>
          <div className="pfilters">
            <button
              className={groupFilter === 'all' ? 'pfilter active' : 'pfilter'}
              onClick={() => setGroupFilter('all')}
            >
              全部分组
            </button>
            {groups.map((g) => (
              <button
                key={g.id}
                className={groupFilter === g.id ? 'pfilter active' : 'pfilter'}
                onClick={() => setGroupFilter(g.id)}
              >
                {g.name}
              </button>
            ))}
          </div>
          <main className="dm">
            <aside className="sessions">
              {sessions.length === 0 && <div className="empty">暂无私信会话</div>}
              {sessions.map((s) => {
                const key = `${s.platform}:${s.accountId}:${s.sessionId}`
                return (
                  <button
                    key={key}
                    className={key === cur ? 'session active' : 'session'}
                    onClick={() => setCur(key)}
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
                )
              })}
            </aside>
            <section className="msgs">
              {!cur && <div className="empty">选择左侧会话查看消息</div>}
              {cur && (
                <>
                  <div className="msgs-title">
                    {curSession?.nickname || '会话'}
                    {curSession && accountLabel(curSession.accountId) && (
                      <span className="time mono">（{accountLabel(curSession.accountId)}）</span>
                    )}
                  </div>
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
        </>
      )}
    </div>
  )
}
