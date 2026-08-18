import { useState } from 'react'
import { api } from '../api'
import { fmtTime, proxied } from '../utils'
import type { Account, Group } from '../types'
import LoginModal from './LoginModal'

export default function AccountsTab({
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
    const r = await api('/api/groups', {
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
    const r = await api('/api/accounts', {
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
    await api(`/api/accounts/${a.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: labelText.trim() }),
    })
    setEditingLabel(null)
    onChanged()
  }

  const moveGroup = async (a: Account, groupId: number) => {
    await api(`/api/accounts/${a.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId }),
    })
    setMovingFor(null)
    onChanged()
  }

  const renameGroup = async () => {
    if (!curGroup || !renameText.trim()) return
    await api(`/api/groups/${curGroup.id}`, {
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
    await api(`/api/accounts/${acc.id}`, { method: 'DELETE' })
    onChanged()
  }

  const delGroup = async (g: Group) => {
    const key = `grp:${g.id}`
    if (confirmDel !== key) { setConfirmDel(key); return }
    setConfirmDel(null)
    const r = await api(`/api/groups/${g.id}`, { method: 'DELETE' }).then((x) => x.json())
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
