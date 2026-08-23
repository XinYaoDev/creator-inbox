import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import LibraryTab from './LibraryTab'
import PublishTab from './components/PublishTab'
import AccountsTab from './components/AccountsTab'
import NoteTab from './components/NoteTab'
import UpdateBar from './components/UpdateBar'
import CommentRow from './components/CommentRow'
import Avatar from './components/Avatar'
import { api, setToken } from './api'
import { fmtTime, proxied } from './utils'
import { formatWechatEmoji } from './wechatEmoji'
import type {
  Account, CommentItem, Group, MsgItem, SessionItem, Status, VideoItem,
} from './types'

const PREFS_KEY = 'inbox_prefs'
const VIEWS = ['inbox', 'publish', 'settings', 'library', 'note'] as const
type AppView = (typeof VIEWS)[number]

type InboxPrefs = {
  view?: AppView
  inboxTab?: 'comments' | 'dm'
  platform?: 'all' | 'wechat' | 'douyin'
  groupFilter?: 'all' | number
  statusFilter?: 'pending' | 'done' | 'all'
  videoSort?: 'comment' | 'time'
}

function readInboxPrefs(): InboxPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
    return p && typeof p === 'object' ? p : {}
  } catch {
    return {}
  }
}

function NotesConfigLine() {
  const [info, setInfo] = useState<{ llm: boolean; model: string; image: string } | null>(null)
  useEffect(() => {
    api('/api/notes/status')
      .then((r) => r.json())
      .then((d) => setInfo({ llm: Boolean(d.llm), model: String(d.model || ''), image: String(d.image || '') }))
      .catch(() => {})
  }, [])
  if (!info) return null
  const image =
    info.image === 'pollinations' ? '演示源（未接模型）'
      : info.image === 'hermes' ? 'Hermes'
        : info.image === 'siliconflow' ? '硅基流动'
          : info.image === 'fal' ? 'FAL'
            : info.image === 'openai' ? 'OpenAI'
              : info.image || '未接'
  const copy = !info.llm
    ? '未接，起草用本地底稿'
    : info.model
      ? `已接 ${info.model}`
      : '已接模型'
  return (
    <div className="sysinfo">
      做笔记 · 文案{copy} · 出图 {image}
    </div>
  )
}

export default function App() {
  const saved = readInboxPrefs()
  const [view, setView] = useState<AppView>(
    saved.view && (VIEWS as readonly string[]).includes(saved.view) ? saved.view : 'inbox',
  )
  const [inboxTab, setInboxTab] = useState<'comments' | 'dm'>(
    saved.inboxTab === 'dm' ? 'dm' : 'comments',
  )
  const [platform, setPlatform] = useState<'all' | 'wechat' | 'douyin'>(
    saved.platform === 'wechat' || saved.platform === 'douyin' ? saved.platform : 'all',
  )
  const [groupFilter, setGroupFilter] = useState<'all' | number>(
    saved.groupFilter === 'all' || saved.groupFilter == null ? 'all'
      : Number(saved.groupFilter) || 'all',
  )
  const [statusFilter, setStatusFilter] = useState<'pending' | 'done' | 'all'>(
    saved.statusFilter === 'done' || saved.statusFilter === 'all' ? saved.statusFilter : 'pending',
  )
  const [videoSort, setVideoSort] = useState<'comment' | 'time'>(
    saved.videoSort === 'time' ? 'time' : 'comment',
  )
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
  const [toast, setToast] = useState('')
  const [needAuth, setNeedAuth] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const appBodyRef = useRef<HTMLDivElement>(null)
  const vlistRef = useRef<HTMLElement>(null)
  const vdetailRef = useRef<HTMLElement>(null)
  const sessionsRef = useRef<HTMLElement>(null)
  const msgsRef = useRef<HTMLElement>(null)
  const msgsFlowRef = useRef<HTMLDivElement>(null)

  // 服务端开启 AUTH_TOKEN 后，任一请求 401 即弹出令牌输入框
  useEffect(() => {
    const on401 = () => setNeedAuth(true)
    window.addEventListener('inbox:unauthorized', on401)
    return () => window.removeEventListener('inbox:unauthorized', on401)
  }, [])

  // 桌面壳没有浏览器刷新；⌘R / Ctrl+R 重新拉页面，才能看到 NAS 上的新前端
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault()
        window.location.reload()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const loadAccounts = useCallback(async () => {
    const d = await api('/api/accounts').then((r) => r.json())
    setGroups(d.groups || [])
    setAccounts(d.accounts || [])
  }, [])

  const load = useCallback(async () => {
    const st: Status = await api('/api/status').then((r) => r.json())
    setStatus(st)
    const params = new URLSearchParams()
    if (platform !== 'all') params.set('platform', platform)
    if (groupFilter !== 'all') params.set('groupId', String(groupFilter))
    params.set('status', statusFilter)
    params.set('sort', videoSort)
    const vs = await api(`/api/videos?${params}`).then((r) => r.json())
    const list: VideoItem[] = vs.list || []
    setVideoList(list)
    const sq = new URLSearchParams()
    if (groupFilter !== 'all') sq.set('groupId', String(groupFilter))
    sq.set('status', statusFilter)
    const ss = await api(`/api/dm/sessions?${sq}`).then((r) => r.json())
    setSessions(ss.list || [])
  }, [platform, groupFilter, statusFilter, videoSort])

  // 列表变化后，保持/重选当前视频（仍在列表里就留着；处理完离开「待处理」则落到下一条）
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
    const d = await api(
      `/api/video/comments?platform=${encodeURIComponent(p)}&accountId=${encodeURIComponent(accId)}&objectId=${encodeURIComponent(objectId)}`,
    ).then((r) => r.json())
    setVideoComments(d.list || [])
  }, [])

  // 点进视频只选中；没回就切到下一条时，把上一条未回复标完成，「待回复」才消失。
  const selectVideo = useCallback(async (key: string) => {
    if (key === curVideo) return
    if (curVideo) {
      const prev = videoList.find((v) => `${v.platform}:${v.accountId}:${v.objectId}` === curVideo)
      if (prev && prev.pendingCount > 0) {
        const [p, accId, ...rest] = curVideo.split(':')
        await api('/api/handled', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            platform: p,
            accountId: Number(accId),
            kind: 'video',
            targetId: rest.join(':'),
            done: true,
          }),
        })
      }
    }
    setCurVideo(key)
    load()
  }, [curVideo, videoList, load])

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
    const d = await api(
      `/api/dm/sessions/${encodeURIComponent(sid)}/messages?platform=${encodeURIComponent(p)}&accountId=${encodeURIComponent(accId)}`,
    ).then((r) => r.json())
    setMsgs(d.list || [])
  }, [])

  // 点进会话只选中；没回就切到下一条时，上一条算已读。
  const selectSession = useCallback(async (key: string) => {
    if (key === cur) return
    if (cur) {
      const prev = sessions.find((s) => `${s.platform}:${s.accountId}:${s.sessionId}` === cur)
      if (prev && prev.pending) {
        await api('/api/handled', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            platform: prev.platform,
            accountId: prev.accountId,
            kind: 'session',
            targetId: prev.sessionId,
            done: true,
          }),
        })
      }
    }
    setCur(key)
    load()
  }, [cur, sessions, load])

  useEffect(() => {
    if (cur) loadMsgs(cur)
    else setMsgs([])
  }, [cur, loadMsgs])

  useEffect(() => {
    loadAccounts()
  }, [loadAccounts])

  useEffect(() => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      view, inboxTab, platform, groupFilter, statusFilter, videoSort,
    }))
  }, [view, inboxTab, platform, groupFilter, statusFilter, videoSort])

  useEffect(() => {
    if (groupFilter === 'all' || groups.length === 0) return
    if (!groups.some((g) => g.id === groupFilter)) setGroupFilter('all')
  }, [groups, groupFilter])

  useEffect(() => {
    load()
    const t = setInterval(load, 60 * 1000)
    return () => clearInterval(t)
  }, [load])

  const refresh = async () => {
    if (busy) return
    setBusy(true)
    try {
      await api('/api/collect', { method: 'POST' })
      // 异步采集：轮询 status 直到完成
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000))
        const st: Status = await api('/api/status').then((r) => r.json())
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
      const r = await api(`/api/dm/sessions/${encodeURIComponent(sid)}/send`, {
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
    await api('/api/handled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: item.platform, accountId: item.accountId, kind, targetId, done }),
    })
    reloadCurrent()
  }

  const saveToken = () => {
    setToken(tokenInput)
    setTokenInput('')
    setNeedAuth(false)
    load()
    loadAccounts()
  }

  const curSession = sessions.find((s) => `${s.platform}:${s.accountId}:${s.sessionId}` === cur)
  const platformName = (k: string) => status?.platforms?.[k]?.name || k
  const accountLabel = (id: number) => {
    const a = accounts.find((x) => x.id === id)
    return a ? a.nickname || a.label : ''
  }
  const pendingTotal = (status?.counts.pendingComments ?? 0) + (status?.counts.pendingSessions ?? 0)
  const brokenPlatforms = Object.entries(status?.platforms || {}).filter(([, p]) => p.hasCookie && p.cookieValid === false)

  const goView = (id: typeof view) => {
    if (id === 'inbox' && view === 'inbox') {
      for (const el of [appBodyRef.current, vlistRef.current, vdetailRef.current, sessionsRef.current, msgsRef.current, msgsFlowRef.current]) {
        if (el) el.scrollTop = 0
      }
    }
    setView(id)
  }

  const nav = (id: typeof view, label: string, extra?: ReactNode) => (
    <button className={view === id ? 'navitem active' : 'navitem'} onClick={() => goView(id)}>
      {label}
      {extra}
    </button>
  )

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">Creator Inbox</div>
        <nav className="sidebar-nav">
          {nav(
            'inbox',
            '收件箱',
            pendingTotal > 0 ? <b className="tab-badge">{pendingTotal}</b> : null,
          )}
          {nav('note', '做笔记')}
          {nav('library', '素材库')}
          {nav('publish', '发布')}
        </nav>
        <div className="sidebar-foot">
          <UpdateBar />
          {nav('settings', '设置')}
        </div>
      </aside>

      <div className="app-main">
      <div className="app-body" ref={appBodyRef}>
      {brokenPlatforms.map(([k, p]) => (
        <div className="errbar" key={k}>
          ⚠ {p.name}登录已失效
          <button className="linkbtn" onClick={() => setView('settings')}>去重新登录</button>
        </div>
      ))}
      {status?.lastError && !brokenPlatforms.length && <div className="errbar">采集异常:{status.lastError}</div>}

      {view === 'publish' && (
        <PublishTab groups={groups} accounts={accounts} />
      )}

      {view === 'settings' && (
        <>
          <div className="sysinfo mono">
            最后采集 {fmtTime(status?.lastCollect)} · 评论 {status?.counts.comments ?? '—'}（视频号{' '}
            {status?.counts.byPlatform?.wechat?.comments ?? 0} / 抖音 {status?.counts.byPlatform?.douyin?.comments ?? 0}）
            · 会话 {status?.counts.sessions ?? '—'} · 私信 {status?.counts.messages ?? '—'}
          </div>
          <NotesConfigLine />
          <AccountsTab
            groups={groups}
            accounts={accounts}
            onChanged={() => { loadAccounts(); load() }}
            lastCollect={status?.lastCollect ?? null}
            onRecollect={refresh}
          />
        </>
      )}

      {view === 'library' && (
        <LibraryTab />
      )}

      {view === 'note' && (
        <NoteTab />
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
            <span className="filterbar-actions">
              <button className="iconbtn" title="刷新" onClick={refresh} disabled={busy || status?.collecting}>
                {busy || status?.collecting ? '…' : '↻'}
              </button>
              {toast && <span className="pub-ok">{toast}</span>}
            </span>
          </div>

          {inboxTab === 'comments' && (
            <main className="comments-layout">
              <aside className="vlist" ref={vlistRef}>
                {videoList.length === 0 && (
                  <div className="empty">{statusFilter === 'pending' ? '没有待处理的评论 🎉' : '暂无视频'}</div>
                )}
                {videoList.map((v) => {
                  const key = `${v.platform}:${v.accountId}:${v.objectId}`
                  return (
                    <button
                      key={key}
                      className={`vrow${key === curVideo ? ' active' : ''}${v.pendingCount === 0 ? ' done' : ''}`}
                      onClick={() => selectVideo(key)}
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
              <section className="vdetail" ref={vdetailRef}>
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
                              {v.pendingCount > 0 ? <> · <b className="pending-n">{v.pendingCount} 条待回复</b></> : null}
                              {accountLabel(v.accountId) ? ` · ${accountLabel(v.accountId)}` : ''}
                            </div>
                          </div>
                        </header>
                      ) : null
                    })()}
                    <div className="vcomments">
                      {videoComments.length === 0 && <div className="empty">暂无评论</div>}
                      {[...videoComments].sort((a, b) => Number(b.pending) - Number(a.pending)).map((c) => (
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
              <aside className="sessions" ref={sessionsRef}>
                {sessions.length === 0 && (
                  <div className="empty">{statusFilter === 'pending' ? '没有待回复的私信 🎉' : '暂无私信会话'}</div>
                )}
                {sessions.map((s) => {
                  const key = `${s.platform}:${s.accountId}:${s.sessionId}`
                  return (
                    <button
                      key={key}
                      className={`session${key === cur ? ' active' : ''}${!s.pending ? ' done' : ''}`}
                      onClick={() => selectSession(key)}
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
                          {formatWechatEmoji(s.lastContent || '') || '（暂无消息）'} <span className="mono">· {s.msgCount} 条</span>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </aside>
              <section className="msgs" ref={msgsRef}>
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
                    <div className="msgs-flow" ref={msgsFlowRef}>
                      {msgs.map((m) => (
                        <div key={m.svrMsgId} className={m.self ? 'msg self' : 'msg'}>
                          <div className="bubble">
                            <div className="content">{formatWechatEmoji(m.content)}</div>
                            <div className="time mono">{fmtTime(m.ts)}</div>
                          </div>
                        </div>
                      ))}
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

      {needAuth && (
        <div className="modal-mask">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">需要访问令牌</div>
            <div className="acct-cookie">
              <div className="pub-label">服务端开启了 AUTH_TOKEN，请输入后重试：</div>
              <input
                autoFocus
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveToken()}
                placeholder="AUTH_TOKEN"
              />
              <div className="pub-actions">
                <button className="btn" onClick={saveToken} disabled={!tokenInput.trim()}>保存并重试</button>
              </div>
            </div>
          </div>
        </div>
      )}
      </div>
      </div>
    </div>
  )
}
