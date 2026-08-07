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
    pendingComments: number
    pendingSessions: number
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
  lastError: string
  state: 'online' | 'error' | 'expired' | 'none'
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
  pending?: boolean
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
  pendingCount: number
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
  lastFrom: string | null
  msgCount: number
  unread: number
  pending: boolean
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
type SearchResults = {
  comments: { platform: string; accountId: number; commentId: string; exportId: string; nickname: string; content: string; createTime: number; videoTitle: string | null }[]
  sessions: { platform: string; accountId: number; sessionId: string; nickname: string; headImgUrl: string }[]
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

function CommentRow({
  c,
  indent,
  onSent,
  onToggleDone,
}: {
  c: CommentItem
  indent?: boolean
  onSent: () => void
  onToggleDone: (c: CommentItem, done: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const canReply = c.platform === 'wechat' // 抖音回复暂未接入
  return (
    <div className={indent ? 'comment indent' : c.pending ? 'comment pending' : 'comment'}>
      <Avatar url={c.headUrl} name={c.nickname} />
      <div className="row-main">
        <div className="row-head">
          <span className="nick">{c.nickname || '匿名'}</span>
          <span className="time mono">{fmtTime(c.createTime)}</span>
        </div>
        <div className="content">{c.content}</div>
        <div className="meta">
          <span className="mono">赞 {c.likeCount}</span>
          <span className="meta-actions">
            {canReply && (
              <button className="linkbtn" onClick={() => setOpen(!open)}>
                {open ? '收起' : '回复'}
              </button>
            )}
            {!indent && (
              <button className="linkbtn" onClick={() => onToggleDone(c, !c.pending)}>
                {c.pending ? '完成' : '重做'}
              </button>
            )}
          </span>
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
                  {a.nickname || a.label || `账号${a.id}`}（{a.platformName}）
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
          {acc.hasCookie ? '重新登录' : '登录'} · {acc.nickname || acc.label || acc.platformName}
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
  lastCollect,
  onRecollect,
}: {
  groups: Group[]
  accounts: Account[]
  onChanged: () => void
  lastCollect: number | null
  onRecollect: () => void
}) {
  const [selGroup, setSelGroup] = useState<'all' | number>('all')
  const [newGroup, setNewGroup] = useState('')
  const [addingGroup, setAddingGroup] = useState(false)
  const [addForm, setAddForm] = useState(false) // 虚线卡展开
  const [newLabel, setNewLabel] = useState('')
  const [newPlatform, setNewPlatform] = useState('wechat')
  const [msg, setMsg] = useState('')
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [loginFor, setLoginFor] = useState<Account | null>(null)
  const [editingLabel, setEditingLabel] = useState<number | null>(null)
  const [labelText, setLabelText] = useState('')
  const [movingFor, setMovingFor] = useState<number | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameText, setRenameText] = useState('')

  const toast = (s: string) => {
    setMsg(s)
    setTimeout(() => setMsg(''), 3000)
  }
  const fmtFans = (n: number | null) =>
    n == null ? '粉丝 —' : n >= 10000 ? `粉丝 ${(n / 10000).toFixed(1)} 万` : `粉丝 ${n}`

  const curGroup = groups.find((g) => g.id === selGroup)
  const visible = selGroup === 'all' ? accounts : accounts.filter((a) => a.groupId === selGroup)
  const onlineCount = accounts.filter((a) => a.state === 'online').length
  const trouble = accounts.filter((a) => a.state === 'error' || a.state === 'expired')
  const stateText = (a: Account) =>
    a.state === 'online' ? '在线' : a.state === 'error' ? '异常' : a.state === 'expired' ? '需重新登录' : '未登录'

  const addGroup = async () => {
    if (!newGroup.trim()) return
    const r = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newGroup.trim() }),
    }).then((x) => x.json())
    if (r.ok) {
      setNewGroup('')
      setAddingGroup(false)
      onChanged()
    } else toast(r.error || '创建失败')
  }

  const addAccount = async () => {
    const groupId = selGroup === 'all' ? groups[0]?.id : Number(selGroup)
    if (!groupId) {
      toast('请先创建分组')
      return
    }
    const r = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId, platform: newPlatform, label: newLabel.trim() }),
    }).then((x) => x.json())
    if (r.ok) {
      setNewLabel('')
      setAddForm(false)
      onChanged()
      toast('账号已创建，点「登录」扫码完成登录')
    } else toast(r.error || '创建失败')
  }

  const saveLabel = async (a: Account) => {
    await fetch(`/api/accounts/${a.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: labelText.trim() }),
    })
    setEditingLabel(null)
    onChanged()
  }

  const moveGroup = async (a: Account, groupId: number) => {
    await fetch(`/api/accounts/${a.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId }),
    })
    setMovingFor(null)
    onChanged()
  }

  const renameGroup = async () => {
    if (!curGroup || !renameText.trim()) return
    await fetch(`/api/groups/${curGroup.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: renameText.trim() }),
    })
    setRenaming(false)
    onChanged()
  }

  const delAccount = async (acc: Account) => {
    const key = `acc:${acc.id}`
    if (confirmDel !== key) { setConfirmDel(key); return }
    setConfirmDel(null)
    await fetch(`/api/accounts/${acc.id}`, { method: 'DELETE' })
    onChanged()
  }

  const delGroup = async (g: Group) => {
    const key = `grp:${g.id}`
    if (confirmDel !== key) { setConfirmDel(key); return }
    setConfirmDel(null)
    const r = await fetch(`/api/groups/${g.id}`, { method: 'DELETE' }).then((x) => x.json())
    if (!r.ok) toast(r.error || '删除失败')
    if (selGroup === g.id) setSelGroup('all')
    onChanged()
  }

  return (
    <main className="acct2">
      <aside className="gnav">
        <div className="gnav-title">分组</div>
        <button className={selGroup === 'all' ? 'gnav-item active' : 'gnav-item'} onClick={() => setSelGroup('all')}>
          全部账号 <span className="mono">({accounts.length})</span>
        </button>
        {groups.map((g) => (
          <button
            key={g.id}
            className={selGroup === g.id ? 'gnav-item active' : 'gnav-item'}
            onClick={() => setSelGroup(g.id)}
          >
            {g.name} <span className="mono">({accounts.filter((a) => a.groupId === g.id).length})</span>
          </button>
        ))}
        {addingGroup ? (
          <div className="gnav-add">
            <input
              autoFocus
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              placeholder="如：妈妈账号"
              onKeyDown={(e) => e.key === 'Enter' && addGroup()}
            />
            <button className="linkbtn" onClick={addGroup}>创建</button>
          </div>
        ) : (
          <button className="gnav-item gnav-new" onClick={() => setAddingGroup(true)}>+ 新建分组</button>
        )}
      </aside>

      <section className="acct-main">
        <div className="acct-summary mono">
          已连接 {accounts.length} 个账号 · {onlineCount} 个在线 · 最近同步 {fmtTime(lastCollect)}
          {msg && <span className="pub-ok">{msg}</span>}
        </div>

        {trouble.map((a) => (
          <div className="errbar acct-err" key={a.id}>
            ⚠ {a.platformName}账号「{a.nickname || a.label || a.id}」
            {a.state === 'expired' ? '登录已失效，请重新登录' : `采集失败：${a.lastError.slice(0, 60)}`}
            <span className="acct-err-actions">
              {a.state === 'error' && <button className="linkbtn" onClick={onRecollect}>重新采集</button>}
              <button className="linkbtn" onClick={() => setLoginFor(a)}>重新登录</button>
            </span>
          </div>
        ))}

        <div className="acct-group-head">
          {renaming && curGroup ? (
            <span className="gnav-add">
              <input
                autoFocus
                value={renameText}
                onChange={(e) => setRenameText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && renameGroup()}
              />
              <button className="linkbtn" onClick={renameGroup}>保存</button>
            </span>
          ) : (
            <b>{curGroup ? curGroup.name : '全部账号'} <span className="mono">{visible.length} 个账号</span></b>
          )}
          {curGroup && (
            <span className="acct-group-ops">
              <button className="linkbtn" onClick={() => { setRenaming(true); setRenameText(curGroup.name) }}>重命名</button>
              <button
                className={confirmDel === `grp:${curGroup.id}` ? 'linkbtn danger' : 'linkbtn'}
                onClick={() => delGroup(curGroup)}
              >
                {confirmDel === `grp:${curGroup.id}` ? '确认删除分组？' : '删除分组'}
              </button>
            </span>
          )}
        </div>

        <div className="acards">
          {visible.map((a) => (
            <div className="acard" key={a.id}>
              <div className={`acard-badge st-${a.state}`}>{stateText(a)}</div>
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
                {fmtFans(a.followers)}
                {a.label && a.nickname ? ` · ${a.label}` : ''}
              </div>
              {editingLabel === a.id && (
                <div className="gnav-add">
                  <input
                    autoFocus
                    value={labelText}
                    onChange={(e) => setLabelText(e.target.value)}
                    placeholder="备注名"
                    onKeyDown={(e) => e.key === 'Enter' && saveLabel(a)}
                  />
                  <button className="linkbtn" onClick={() => saveLabel(a)}>保存</button>
                </div>
              )}
              {movingFor === a.id && (
                <select
                  autoFocus
                  defaultValue={a.groupId}
                  onChange={(e) => moveGroup(a, Number(e.target.value))}
                  onBlur={() => setMovingFor(null)}
                >
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              )}
              <div className="acard-actions">
                <button className="linkbtn" onClick={() => setLoginFor(a)}>
                  {a.hasCookie ? '重新登录' : '登录'}
                </button>
                <button className="linkbtn" onClick={() => { setEditingLabel(a.id); setLabelText(a.label) }}>备注</button>
                <button className="linkbtn" onClick={() => setMovingFor(a.id)}>移组</button>
                <button
                  className={confirmDel === `acc:${a.id}` ? 'linkbtn danger' : 'linkbtn'}
                  onClick={() => delAccount(a)}
                >
                  {confirmDel === `acc:${a.id}` ? '确认？' : '删除'}
                </button>
              </div>
            </div>
          ))}
          <div className="acard acard-add" onClick={() => setAddForm(!addForm)}>
            {addForm ? (
              <div className="acct-add" onClick={(e) => e.stopPropagation()}>
                <select value={newPlatform} onChange={(e) => setNewPlatform(e.target.value)}>
                  <option value="wechat">视频号</option>
                  <option value="douyin">抖音</option>
                </select>
                <input
                  autoFocus
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="账号备注名"
                />
                <button className="btn" onClick={addAccount}>添加</button>
              </div>
            ) : (
              <span className="acard-add-plus">+ 添加账号</span>
            )}
          </div>
        </div>
        <div className="pub-label">
          视频号点「登录」直接扫码；抖音扫码暂未接入，弹层里可切换手动粘贴 Cookie。
        </div>
      </section>

      {loginFor && (
        <LoginModal acc={loginFor} onClose={() => setLoginFor(null)} onDone={onChanged} />
      )}
    </main>
  )
}

export default function App() {
  const [view, setView] = useState<'inbox' | 'publish' | 'settings'>('inbox')
  const [inboxTab, setInboxTab] = useState<'comments' | 'dm'>('comments')
  const [platform, setPlatform] = useState<'all' | 'wechat' | 'douyin'>('all')
  const [groupFilter, setGroupFilter] = useState<'all' | number>('all')
  const [statusFilter, setStatusFilter] = useState<'pending' | 'done' | 'all'>('pending')
  const [videoSort, setVideoSort] = useState<'comment' | 'time'>('comment')
  const [status, setStatus] = useState<Status | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [videoList, setVideoList] = useState<VideoItem[]>([])
  const [curVideo, setCurVideo] = useState<string | null>(null) // "platform:accountId:objectId"
  const [videoComments, setVideoComments] = useState<CommentItem[]>([])
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [cur, setCur] = useState<string | null>(null) // "platform:accountId:sessionId"
  const [msgs, setMsgs] = useState<MsgItem[]>([])
  const [busy, setBusy] = useState(false)
  const [dmInput, setDmInput] = useState('')
  const [dmSending, setDmSending] = useState(false)
  const [dmErr, setDmErr] = useState('')
  const [searchQ, setSearchQ] = useState('')
  const [searchRes, setSearchRes] = useState<SearchResults | null>(null)
  const [toast, setToast] = useState('')

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
    params.set('status', statusFilter)
    params.set('sort', videoSort)
    const vs = await fetch(`/api/videos?${params}`).then((r) => r.json())
    const list: VideoItem[] = vs.list || []
    setVideoList(list)
    const sq = new URLSearchParams()
    if (groupFilter !== 'all') sq.set('groupId', String(groupFilter))
    sq.set('status', statusFilter)
    const ss = await fetch(`/api/dm/sessions?${sq}`).then((r) => r.json())
    setSessions(ss.list || [])
  }, [platform, groupFilter, statusFilter, videoSort])

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
    if (busy) return
    setBusy(true)
    try {
      await fetch('/api/collect', { method: 'POST' })
      // 异步采集：轮询 status 直到完成
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000))
        const st: Status = await fetch('/api/status').then((r) => r.json())
        setStatus(st)
        if (!st.collecting) break
      }
      await load()
      await loadAccounts()
      setToast('已同步 · 刚刚')
      setTimeout(() => setToast(''), 3000)
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
        load()
      } else {
        setDmErr(r.error || '发送失败')
      }
    } catch (e) {
      setDmErr(String(e))
    } finally {
      setDmSending(false)
    }
  }

  // 标记完成/重做
  const toggleDone = async (item: { platform: string; accountId: number }, kind: 'comment' | 'session', targetId: string, done: boolean) => {
    await fetch('/api/handled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: item.platform, accountId: item.accountId, kind, targetId, done }),
    })
    reloadCurrent()
  }

  // 搜索
  useEffect(() => {
    if (!searchQ.trim()) {
      setSearchRes(null)
      return
    }
    const t = setTimeout(async () => {
      const d = await fetch(`/api/search?q=${encodeURIComponent(searchQ.trim())}`).then((r) => r.json())
      setSearchRes(d)
    }, 300)
    return () => clearTimeout(t)
  }, [searchQ])

  const jumpToVideo = (platform2: string, accountId: number, objectId: string) => {
    setSearchRes(null)
    setSearchQ('')
    setView('inbox')
    setInboxTab('comments')
    setStatusFilter('all')
    setCurVideo(`${platform2}:${accountId}:${objectId}`)
    loadVideoComments(`${platform2}:${accountId}:${objectId}`)
  }
  const jumpToSession = (platform2: string, accountId: number, sessionId: string) => {
    setSearchRes(null)
    setSearchQ('')
    setView('inbox')
    setInboxTab('dm')
    setStatusFilter('all')
    setCur(`${platform2}:${accountId}:${sessionId}`)
  }

  const curSession = sessions.find((s) => `${s.platform}:${s.accountId}:${s.sessionId}` === cur)
  const platformName = (k: string) => status?.platforms?.[k]?.name || k
  const accountLabel = (id: number) => {
    const a = accounts.find((x) => x.id === id)
    return a ? a.nickname || a.label : ''
  }
  const pendingTotal = (status?.counts.pendingComments ?? 0) + (status?.counts.pendingSessions ?? 0)
  const brokenPlatforms = Object.entries(status?.platforms || {}).filter(([, p]) => p.hasCookie && p.cookieValid === false)

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">聚合收件箱</div>
        <div className="topbar-summary mono">
          {status
            ? `${status.counts.comments} 条评论 · ${status.counts.messages} 条私信 · ${pendingTotal} 待处理`
            : '载入中…'}
        </div>
        <div className="topbar-actions">
          <div className="searchwrap">
            <input
              className="searchbox"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              placeholder="搜索评论 / 私信"
            />
            {searchRes && (
              <div className="searchres">
                {searchRes.comments.length === 0 && searchRes.sessions.length === 0 && (
                  <div className="empty">无匹配结果</div>
                )}
                {searchRes.sessions.map((s) => (
                  <button
                    key={`s${s.accountId}:${s.sessionId}`}
                    className="searchrow"
                    onClick={() => jumpToSession(s.platform, s.accountId, s.sessionId)}
                  >
                    <span className="ptag">私信</span> {s.nickname || '未知用户'}
                  </button>
                ))}
                {searchRes.comments.map((c) => (
                  <button
                    key={`c${c.accountId}:${c.commentId}`}
                    className="searchrow"
                    onClick={() => jumpToVideo(c.platform, c.accountId, c.exportId)}
                  >
                    <span className="ptag">评论</span>
                    <span className="searchrow-main">
                      {c.nickname}：{c.content.slice(0, 30)}
                      <span className="time mono">{fmtTime(c.createTime)}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="iconbtn" title="刷新" onClick={refresh} disabled={busy || status?.collecting}>
            {busy || status?.collecting ? '…' : '↻'}
          </button>
          <button className="iconbtn publish-btn" onClick={() => setView('publish')}>+ 发布</button>
          <button className="iconbtn" title="设置" onClick={() => setView('settings')}>⚙</button>
          {toast && <span className="pub-ok">{toast}</span>}
        </div>
      </header>

      {brokenPlatforms.map(([k, p]) => (
        <div className="errbar" key={k}>
          ⚠ {p.name}登录已失效
          <button className="linkbtn" onClick={() => setView('settings')}>去重新登录</button>
        </div>
      ))}
      {status?.lastError && !brokenPlatforms.length && <div className="errbar">采集异常:{status.lastError}</div>}

      {view === 'publish' && (
        <>
          <nav className="tabs">
            <button className="tab active">发表</button>
            <button className="tab" onClick={() => setView('inbox')}>← 返回收件箱</button>
          </nav>
          <PublishTab groups={groups} accounts={accounts} />
        </>
      )}

      {view === 'settings' && (
        <>
          <nav className="tabs">
            <button className="tab active">设置</button>
            <button className="tab" onClick={() => setView('inbox')}>← 返回收件箱</button>
          </nav>
          <div className="sysinfo mono">
            最后采集 {fmtTime(status?.lastCollect)} · 评论 {status?.counts.comments ?? '—'}（视频号{' '}
            {status?.counts.byPlatform?.wechat?.comments ?? 0} / 抖音 {status?.counts.byPlatform?.douyin?.comments ?? 0}）
            · 会话 {status?.counts.sessions ?? '—'} · 私信 {status?.counts.messages ?? '—'}
          </div>
          <AccountsTab
            groups={groups}
            accounts={accounts}
            onChanged={loadAccounts}
            lastCollect={status?.lastCollect ?? null}
            onRecollect={refresh}
          />
        </>
      )}

      {view === 'inbox' && (
        <>
          <nav className="tabs">
            <button
              className={inboxTab === 'comments' ? 'tab active' : 'tab'}
              onClick={() => setInboxTab('comments')}
            >
              评论 {status?.counts.pendingComments ? <b className="tab-badge">{status.counts.pendingComments}</b> : null}
            </button>
            <button
              className={inboxTab === 'dm' ? 'tab active' : 'tab'}
              onClick={() => setInboxTab('dm')}
            >
              私信 {status?.counts.pendingSessions ? <b className="tab-badge">{status.counts.pendingSessions}</b> : null}
            </button>
          </nav>

          <div className="filterbar">
            <select value={platform} onChange={(e) => setPlatform(e.target.value as typeof platform)}>
              <option value="all">全部平台</option>
              <option value="wechat">视频号</option>
              <option value="douyin">抖音</option>
            </select>
            <select
              value={String(groupFilter)}
              onChange={(e) => setGroupFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            >
              <option value="all">全部分组</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
              <option value="pending">待处理</option>
              <option value="done">已处理</option>
              <option value="all">全部</option>
            </select>
            {inboxTab === 'comments' && (
              <select value={videoSort} onChange={(e) => setVideoSort(e.target.value as typeof videoSort)}>
                <option value="comment">按最新评论</option>
                <option value="time">按发布时间</option>
              </select>
            )}
          </div>

          {inboxTab === 'comments' && (
            <main className="comments-layout">
              <aside className="vlist">
                {videoList.length === 0 && (
                  <div className="empty">{statusFilter === 'pending' ? '没有待处理的评论 🎉' : '暂无视频'}</div>
                )}
                {videoList.map((v) => {
                  const key = `${v.platform}:${v.accountId}:${v.objectId}`
                  return (
                    <button
                      key={key}
                      className={`vrow${key === curVideo ? ' active' : ''}${v.pendingCount === 0 ? ' done' : ''}`}
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
                          {v.pendingCount > 0
                            ? <b className="pending-n">{v.pendingCount} 条待回复</b>
                            : <span>{v.commentCount} 条评论</span>}
                          {' · '}{accountLabel(v.accountId) || '—'}
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
                          <CommentRow c={c} onSent={reloadCurrent} onToggleDone={(cc, done) => toggleDone(cc, 'comment', cc.commentId, done)} />
                          {(c.replies || []).map((r) => (
                            <CommentRow key={r.commentId} c={r} indent onSent={reloadCurrent} onToggleDone={() => {}} />
                          ))}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </section>
            </main>
          )}

          {inboxTab === 'dm' && (
            <main className="dm">
              <aside className="sessions">
                {sessions.length === 0 && (
                  <div className="empty">{statusFilter === 'pending' ? '没有待回复的私信 🎉' : '暂无私信会话'}</div>
                )}
                {sessions.map((s) => {
                  const key = `${s.platform}:${s.accountId}:${s.sessionId}`
                  return (
                    <button
                      key={key}
                      className={`session${key === cur ? ' active' : ''}${!s.pending ? ' done' : ''}`}
                      onClick={() => setCur(key)}
                    >
                      <Avatar url={s.headImgUrl} name={s.nickname} />
                      <div className="session-main">
                        <div className="row-head">
                          <span className="nick">
                            {s.nickname || '未知用户'}
                            {s.pending && <b className="pending-dot" />}
                          </span>
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
                      {curSession && (
                        <button
                          className="linkbtn msgs-done"
                          onClick={() => toggleDone(curSession, 'session', curSession.sessionId, !curSession.pending)}
                        >
                          {curSession.pending ? '标记完成' : '重开'}
                        </button>
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
          )}
        </>
      )}
    </div>
  )
}
