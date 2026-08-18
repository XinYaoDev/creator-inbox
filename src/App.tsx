import { useCallback, useEffect, useState } from 'react'
import LibraryTab from './LibraryTab'
import PublishTab from './components/PublishTab'
import AccountsTab from './components/AccountsTab'
import CommentRow from './components/CommentRow'
import Avatar from './components/Avatar'
import { api, setToken } from './api'
import { fmtTime, proxied } from './utils'
import type {
  Account, CommentItem, Group, MsgItem, SearchResults, SessionItem, Status, VideoItem,
} from './types'

export default function App() {
  const [view, setView] = useState<'inbox' | 'publish' | 'settings' | 'library'>('inbox')
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
  const [needAuth, setNeedAuth] = useState(false)
  const [tokenInput, setTokenInput] = useState('')

  // 服务端开启 AUTH_TOKEN 后，任一请求 401 即弹出令牌输入框
  useEffect(() => {
    const on401 = () => setNeedAuth(true)
    window.addEventListener('inbox:unauthorized', on401)
    return () => window.removeEventListener('inbox:unauthorized', on401)
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
    const d = await api(
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
    const d = await api(
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

  // 搜索
  useEffect(() => {
    if (!searchQ.trim()) {
      setSearchRes(null)
      return
    }
    const t = setTimeout(async () => {
      const d = await api(`/api/search?q=${encodeURIComponent(searchQ.trim())}`).then((r) => r.json())
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

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">Creator Inbox</div>
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
          <button className="iconbtn" title="素材库" onClick={() => setView('library')}>素材库</button>
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

      {view === 'library' && (
        <>
          <LibraryTab onBack={() => setView('inbox')} />
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
                      {msgs.map((m) => (
                        <div key={m.svrMsgId} className={m.self ? 'msg self' : 'msg'}>
                          <div className="bubble">
                            <div className="content">{m.content}</div>
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
  )
}
