import { useEffect, useRef, useState } from 'react'
import { api, withToken } from '../api'
import PhotoPicker from './PhotoPicker'

type Slot = {
  id: string
  role: string
  want: string
  prompt: string
  imageId?: string
  photoId?: string
  variants?: string[]
  error?: string
}

type Lint = { ok: boolean; fail: string[] }

type RecentNote = {
  id: string
  ts: number
  title: string
  style: string
  stats?: { likes: number; favorites: number; comments: number }
}

type RecentCase = { noteId: string; title: string; style: string; likes: number; favorites: number }

type AssetSummary = {
  recentNotes: RecentNote[]
  recentCases: RecentCase[]
}

type SuggestHit = {
  id: string
  thumb_path: string
  file_path: string
  source?: string
  ai_caption?: string
}

type Draft = {
  material: string
  topic: string
  body: string
  tags: string[]
  slots: Slot[]
  openId: string | null
  usedFallback?: boolean
  style: string
  lint: Lint | null
  rewritten?: boolean
}

const DRAFT_KEY = 'note_draft'
const GHOST_ROLES = ['封面', '图2', '图3', '图4', '图5', '图6']

function imgSrc(id?: string) {
  return id ? withToken(`/api/notes/file?id=${id}`) : ''
}

function asSlot(raw: unknown): Slot | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  const id = String(s.id || '').trim()
  if (!id) return null
  return {
    id,
    role: String(s.role || ''),
    want: String(s.want || ''),
    prompt: String(s.prompt || ''),
    imageId: s.imageId ? String(s.imageId) : undefined,
    photoId: s.photoId ? String(s.photoId) : undefined,
    variants: Array.isArray(s.variants) ? s.variants.map(String) : [],
  }
}

function emptySlots(): Slot[] {
  return GHOST_ROLES.map((role, i) => ({ id: `s${i + 1}`, role, want: '', prompt: '' }))
}

function emptyDraft(): Draft {
  return {
    material: '',
    topic: '',
    body: '',
    tags: [],
    slots: [],
    openId: null,
    style: '',
    lint: null,
  }
}

function asLint(raw: unknown): Lint | null {
  if (!raw || typeof raw !== 'object') return null
  const l = raw as Record<string, unknown>
  return {
    ok: Boolean(l.ok),
    fail: Array.isArray(l.fail) ? l.fail.map(String).filter(Boolean) : [],
  }
}

function readDraft(): Draft {
  try {
    const p = JSON.parse(localStorage.getItem(DRAFT_KEY) || '')
    if (!p || typeof p !== 'object') return emptyDraft()
    return {
      material: String(p.material || ''),
      topic: String(p.topic || ''),
      body: String(p.body || ''),
      tags: Array.isArray(p.tags) ? p.tags.map(String).filter(Boolean).slice(0, 12) : [],
      slots: Array.isArray(p.slots) ? (p.slots as unknown[]).map(asSlot).filter((s): s is Slot => s !== null) : [],
      openId: p.openId ? String(p.openId) : null,
      usedFallback: Boolean(p.usedFallback),
      style: String(p.style || ''),
      lint: asLint(p.lint),
      rewritten: Boolean(p.rewritten),
    }
  } catch {
    return emptyDraft()
  }
}

export default function NoteTab({ onBack }: { onBack?: () => void }) {
  const saved = readDraft()
  const [room, setRoom] = useState<'write' | 'stock'>('write')
  const [material, setMaterial] = useState(saved.material)
  const [topic, setTopic] = useState(saved.topic)
  const [body, setBody] = useState(saved.body)
  const [tags, setTags] = useState<string[]>(saved.tags)
  const [slots, setSlots] = useState<Slot[]>(saved.slots)
  const [openId, setOpenId] = useState<string | null>(saved.openId)
  const [usedFallback, setUsedFallback] = useState(Boolean(saved.usedFallback))
  const [style, setStyle] = useState(saved.style)
  const [lint, setLint] = useState<Lint | null>(saved.lint)
  const [rewritten, setRewritten] = useState(Boolean(saved.rewritten))
  const [stage, setStage] = useState('')
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const [showPrompt, setShowPrompt] = useState<Record<string, boolean>>({})
  const pickRef = useRef<{ slotId?: string; ghostIndex?: number } | null>(null)
  const [picking, setPicking] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const [cands, setCands] = useState<SuggestHit[]>([])
  const [savedLib, setSavedLib] = useState<Record<string, boolean>>({})
  const [hasLlm, setHasLlm] = useState<boolean | null>(null)
  const [genDone, setGenDone] = useState(0)
  const [genTotal, setGenTotal] = useState(0)
  const [assetSum, setAssetSum] = useState<AssetSummary | null>(null)
  const [learnUrl, setLearnUrl] = useState('')
  const [learnHint, setLearnHint] = useState('')
  const [backfillId, setBackfillId] = useState('')
  const [bfLikes, setBfLikes] = useState('')
  const [bfFav, setBfFav] = useState('')
  const [bfCmt, setBfCmt] = useState('')
  const [backfillHint, setBackfillHint] = useState('')

  const loadAssets = () => {
    api('/api/assets/summary')
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) return
        setAssetSum({
          recentNotes: Array.isArray(d.recentNotes) ? d.recentNotes : [],
          recentCases: Array.isArray(d.recentCases) ? d.recentCases : [],
        })
        setBackfillId((prev) => prev || String(d.recentNotes?.[0]?.id || ''))
      })
      .catch(() => {})
  }

  useEffect(() => {
    api('/api/notes/status')
      .then((r) => r.json())
      .then((d) => setHasLlm(Boolean(d.llm)))
      .catch(() => setHasLlm(false))
  }, [])

  useEffect(() => {
    if (room !== 'stock') return
    loadAssets()
  }, [room])

  useEffect(() => {
    const draft: Draft = {
      material, topic, body, tags, slots, openId, usedFallback, style, lint, rewritten,
    }
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  }, [material, topic, body, tags, slots, openId, usedFallback, style, lint, rewritten])

  useEffect(() => {
    if (!confirmReset) return
    const t = setTimeout(() => setConfirmReset(false), 3000)
    return () => clearTimeout(t)
  }, [confirmReset])

  const dirty = Boolean(material.trim() || topic.trim() || body.trim() || tags.length || slots.length)

  const run = async (label: string, fn: () => Promise<void>) => {
    if (stage) return
    setErr('')
    setStage(label)
    try {
      await fn()
    } catch (e) {
      setErr(String(e))
    } finally {
      setStage('')
      setGenDone(0)
      setGenTotal(0)
    }
  }

  const draftCopy = () =>
    run('起草中…', async () => {
      const r = await api('/api/notes/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, material }),
      }).then((x) => x.json())
      if (!r.ok) throw new Error(r.error || '起草失败')
      if (r.title) setTopic(String(r.title))
      setBody(r.body || '')
      setTags(r.tags || [])
      setStyle(String(r.style || ''))
      setLint(asLint(r.lint))
      setRewritten(Boolean(r.rewritten))
      setUsedFallback(Boolean(r.fallback))
    })

  const lintCopy = () =>
    run('改一版…', async () => {
      const r = await api('/api/notes/lint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: topic, body, material, style, tags, rewrite: true }),
      }).then((x) => x.json())
      if (!r.ok) throw new Error(r.error || '没改成')
      setLint(asLint(r.lint))
      setRewritten(Boolean(r.rewritten))
      if (r.title) setTopic(String(r.title))
      if (r.body) setBody(String(r.body))
      if (Array.isArray(r.tags) && r.tags.length) setTags(r.tags.map(String))
    })

  const splitBoard = () =>
    run('拆图中…', async () => {
      const r = await api('/api/notes/storyboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, body }),
      }).then((x) => x.json())
      if (!r.ok) throw new Error(r.error || '拆图失败')
      const next = Array.isArray(r.slots) ? r.slots : []
      setSlots((prev) => next.map((ns: Slot, i: number) => {
        const old = prev[i] || prev.find((s) => s.role === ns.role)
        return {
          ...ns,
          imageId: old?.imageId,
          photoId: old?.photoId,
        }
      }))
      setOpenId(next[0]?.id || null)
      setUsedFallback((prev) => prev || Boolean(r.fallback))
    })

  const genMissing = () =>
    run('出图中…', async () => {
      const targets = slots.some((s) => !s.imageId) ? slots.filter((s) => !s.imageId) : slots
      setGenTotal(targets.length)
      setGenDone(0)
      let done = 0
      const failed: string[] = []
      for (const slot of targets) {
        setStage(`出图 ${done + 1}/${targets.length} · ${slot.role}`)
        const r = await api('/api/notes/generate-one', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: slot.prompt, want: slot.want, n: 1 }),
        }).then((x) => x.json())
        if (!r.ok || !r.imageIds?.[0]) {
          failed.push(slot.role)
          setSlots((prev) =>
            prev.map((s) => (s.id === slot.id ? { ...s, error: r.error || '这张没出成' } : s)),
          )
        } else {
          const id = r.imageIds[0] as string
          setSlots((prev) =>
            prev.map((s) => (s.id === slot.id ? { ...s, imageId: id, error: undefined, variants: [] } : s)),
          )
        }
        done += 1
        setGenDone(done)
      }
      if (failed.length) throw new Error(`${failed.join('、')} 没出成，可在卡上重试`)
    })

  const genOne = (slot: Slot, fromPhoto = false) =>
    run(fromPhoto ? `用这张生 ${slot.role}…` : `重出 ${slot.role}…`, async () => {
      const ref = fromPhoto ? (slot.photoId || slot.imageId) : slot.photoId
      const r = await api('/api/notes/generate-one', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: slot.prompt,
          want: slot.want,
          imageId: ref || undefined,
          n: fromPhoto || ref ? 1 : 3,
        }),
      }).then((x) => x.json())
      if (!r.ok) throw new Error(r.error || '没出成')
      const ids: string[] = r.imageIds || []
      setSlots((prev) =>
        prev.map((s) => (s.id === slot.id ? { ...s, variants: ids, imageId: ids[0] || s.imageId, error: undefined } : s)),
      )
    })

  const pickPhoto = (target: { slotId?: string; ghostIndex?: number }, query = '') => {
    pickRef.current = target
    setPickerQuery(query)
    setPicking(true)
  }

  const openSlot = slots.find((s) => s.id === openId)
  const wantKey = openSlot
    ? `${openSlot.id}|${openSlot.want.trim() || openSlot.role}`
    : ''
  useEffect(() => {
    if (!wantKey) {
      setCands([])
      return
    }
    const q = wantKey.split('|').slice(1).join('|')
    const t = setTimeout(() => {
      api(`/api/library/suggest?q=${encodeURIComponent(q)}&limit=3`)
        .then((r) => r.json())
        .then((d) => setCands(d.list || []))
        .catch(() => setCands([]))
    }, 500)
    return () => clearTimeout(t)
  }, [wantKey])

  const placeCandidate = (slotId: string, libId: string) => {
    pickRef.current = { slotId }
    setStage('放进图位…')
    api('/api/notes/from-library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: libId }),
    })
      .then((x) => x.json())
      .then((r) => {
        if (!r.ok || !r.imageId) throw new Error(r.error || '没放进去')
        placeFromLibrary(String(r.imageId))
      })
      .catch((e) => setErr(String(e && e.message || e)))
      .finally(() => setStage(''))
  }

  const saveToLib = (s: Slot) => {
    if (!s.imageId) return
    setStage('存进库…')
    api('/api/library/save-note-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageId: s.imageId, caption: s.want }),
    })
      .then((x) => x.json())
      .then((r) => {
        if (!r.ok) throw new Error(r.error || '没存进去')
        setSavedLib((p) => ({ ...p, [s.imageId!]: true }))
      })
      .catch((e) => setErr(String(e && e.message || e)))
      .finally(() => setStage(''))
  }

  const placeFromLibrary = (id: string) => {
    const pending = pickRef.current
    setPicking(false)
    setSlots((prev) => {
      const list = prev.length ? prev : emptySlots()
      const idx = pending?.slotId
        ? list.findIndex((s) => s.id === pending.slotId)
        : (pending?.ghostIndex ?? 0)
      const i = idx >= 0 ? idx : 0
      setOpenId(list[i].id)
      return list.map((s, j) => (j === i ? { ...s, imageId: id, photoId: id, error: undefined } : s))
    })
  }

  const patchSlot = (id: string, patch: Partial<Slot>) =>
    setSlots((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))

  const reset = () => {
    setMaterial('')
    setTopic('')
    setBody('')
    setTags([])
    setSlots([])
    setErr('')
    setOpenId(null)
    setUsedFallback(false)
    setStyle('')
    setLint(null)
    setRewritten(false)
    setShowPrompt({})
    setConfirmReset(false)
    localStorage.removeItem(DRAFT_KEY)
  }

  const tryReset = () => {
    if (!dirty) return
    if (confirmReset) {
      reset()
      return
    }
    setConfirmReset(true)
  }

  const copyFull = async () => {
    const text = [topic, body, tags.map((t) => `#${t}`).join(' ')].filter(Boolean).join('\n\n')
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setCopied('正文')
    setTimeout(() => setCopied(''), 1600)
    if (topic.trim() || body.trim()) {
      api('/api/assets/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: topic, body, tags, style, material }),
      }).catch(() => {})
    }
  }

  const learnOne = () =>
    run('记下…', async () => {
      setLearnHint('')
      const r = await api('/api/assets/learn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: learnUrl.trim() }),
      }).then((x) => x.json())
      if (!r.ok) throw new Error('Mac 桥没开或链接失效')
      const c = r.case || {}
      setLearnHint(`进了：${c.title || '已记下'}`)
      setLearnUrl('')
      loadAssets()
    })

  const doBackfill = () =>
    run('记下…', async () => {
      setBackfillHint('')
      if (!backfillId) throw new Error('先选一条成稿')
      const r = await api('/api/assets/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: backfillId,
          likes: bfLikes,
          favorites: bfFav,
          comments: bfCmt,
        }),
      }).then((x) => x.json())
      if (!r.ok) throw new Error(r.error || '没记下')
      setBackfillHint('已记下')
      setBfLikes('')
      setBfFav('')
      setBfCmt('')
      loadAssets()
    })

  const hasSeed = Boolean(material.trim() || topic.trim())
  const hasBody = Boolean(body.trim())
  const needImages = slots.some((s) => !s.imageId)
  const lintFail = Boolean(lint && !lint.ok && hasBody)

  const primary = (() => {
    if (stage) return { label: stage, disabled: true, go: () => {} }
    if (!hasSeed) return { label: '先写今日素材', disabled: true, go: () => {} }
    if (!hasBody) return { label: '起草', disabled: false, go: draftCopy }
    if (!slots.length) return { label: '拆成图组', disabled: false, go: splitBoard }
    if (needImages) return { label: genTotal ? `出图 ${genDone}/${genTotal}` : '出图', disabled: false, go: genMissing }
    return { label: copied === '正文' ? '已复制' : '复制全文', disabled: false, go: copyFull }
  })()

  return (
    <div>
      <div className="note-toolbar">
        {room === 'stock' ? (
          <button className="linkbtn" onClick={() => { setRoom('write'); setErr(''); setLearnHint(''); }}>
            回写笔记
          </button>
        ) : (
          <>
            <button className="linkbtn" onClick={() => { setRoom('stock'); setErr(''); }}>
              囤参考
            </button>
            <div className="note-toolbar-right">
              {onBack && (
                <button className="linkbtn" onClick={onBack}>← 收件箱</button>
              )}
              <button
                className={confirmReset ? 'linkbtn danger' : 'linkbtn'}
                onClick={tryReset}
                disabled={!dirty || Boolean(stage)}
              >
                {confirmReset ? '确定清空？' : '再做一条'}
              </button>
            </div>
          </>
        )}
      </div>
      {err && <div className="errbar">{err}</div>}
      {picking && (
        <PhotoPicker
          onPick={placeFromLibrary}
          onClose={() => { setPicking(false); setPickerQuery('') }}
          initialQuery={pickerQuery}
        />
      )}

      {room === 'stock' ? (
        <div className="note-stock">
          <div className="pub-label">贴一条小红书</div>
          <div className="note-asset-row">
            <input
              className="note-asset-url"
              value={learnUrl}
              onChange={(e) => setLearnUrl(e.target.value)}
              placeholder="https://www.xiaohongshu.com/explore/…"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && learnUrl.trim() && !stage) {
                  e.preventDefault()
                  learnOne()
                }
              }}
            />
            <button className="btn" onClick={learnOne} disabled={Boolean(stage) || !learnUrl.trim()}>
              {stage.startsWith('记下') ? stage : '进堆'}
            </button>
          </div>
          {learnHint && <div className="note-meta">{learnHint}</div>}

          <div className="note-stock-list">
            {(assetSum?.recentCases || []).length === 0 && (
              <div className="note-meta">还没有囤过。贴一条写得好的，下次起草会用上。</div>
            )}
            {(assetSum?.recentCases || []).map((c) => (
              <div key={c.noteId} className="note-case">
                <b>{c.title || c.noteId}</b>
                <span>{[c.style, `赞${c.likes ?? 0}`, `藏${c.favorites ?? 0}`].filter(Boolean).join(' · ')}</span>
              </div>
            ))}
          </div>

          {(assetSum?.recentNotes?.length || 0) > 0 && (
            <div className="note-stock-backfill">
              <div className="pub-label">自己发过的</div>
              <div className="note-asset-row">
                <select
                  className="note-asset-url"
                  value={backfillId}
                  onChange={(e) => setBackfillId(e.target.value)}
                >
                  {assetSum?.recentNotes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.title.slice(0, 28) || n.id}
                      {n.stats ? ` · 赞${n.stats.likes}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="note-asset-nums">
                <input inputMode="numeric" placeholder="赞" value={bfLikes} onChange={(e) => setBfLikes(e.target.value)} />
                <input inputMode="numeric" placeholder="藏" value={bfFav} onChange={(e) => setBfFav(e.target.value)} />
                <input inputMode="numeric" placeholder="评" value={bfCmt} onChange={(e) => setBfCmt(e.target.value)} />
                <button className="linkbtn" onClick={doBackfill} disabled={Boolean(stage) || !backfillId}>
                  记下
                </button>
              </div>
              {backfillHint && <div className="note-meta">{backfillHint}</div>}
            </div>
          )}
        </div>
      ) : (
        <div className="note-layout">
          <div className="note-col">
            <label className="pub-label" htmlFor="note-material">今日素材</label>
            <textarea
              id="note-material"
              className="note-material"
              rows={material.trim() ? 3 : 5}
              value={material}
              onChange={(e) => setMaterial(e.target.value)}
              placeholder="几句现场事实就行，例如：退潮 14:30，挖到三只蛏子；厨房杀了跑山鸡；下雨，院子里打牌。"
            />

            <div className="note-label-row">
              <label className="pub-label" htmlFor="note-topic">标题</label>
              {hasBody && <span className="note-meta">{body.length} 字{rewritten ? ' · 改过' : ''}</span>}
            </div>
            <input
              id="note-topic"
              className="note-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="起草后出现。也可先写一句方向。"
            />

            <label className="pub-label" htmlFor="note-body">正文</label>
            <textarea
              id="note-body"
              className="note-body"
              rows={12}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="像刚住完的人在讲。素材里的事实会写进来，不要事后改成广告。"
            />
            {lintFail && (
              <div className="note-lint bad">
                {lint?.fail.join('；') || '再改一版'}
                {' '}
                <button className="linkbtn" onClick={lintCopy} disabled={Boolean(stage)}>按这个改一版</button>
              </div>
            )}
            {usedFallback && hasBody && (
              <div className="note-meta">没走模型，这是本地底稿。</div>
            )}
            {hasLlm === false && !hasBody && (
              <div className="note-meta">文案模型还没接上，起草会用本地底稿。</div>
            )}

            {tags.length > 0 && (
              <div className="note-chips">
                {tags.map((t) => (
                  <button
                    key={t}
                    className="ptag facet-picked"
                    title="去掉这个话题"
                    onClick={() => setTags((prev) => prev.filter((x) => x !== t))}
                  >
                    #{t}
                  </button>
                ))}
              </div>
            )}

            <div className="note-step-actions">
              <button className="btn note-main" onClick={primary.go} disabled={primary.disabled}>
                {primary.label}
              </button>
              {hasBody && hasSeed && (
                <button className="linkbtn" onClick={draftCopy} disabled={Boolean(stage)}>
                  再写一版
                </button>
              )}
              {slots.length > 0 && !needImages && (
                <button className="linkbtn" onClick={genMissing} disabled={Boolean(stage)}>
                  再出这一组
                </button>
              )}
            </div>
          </div>

          <div className="note-col">
            <div className="note-label-row">
              <div className="pub-label">这一组图</div>
              {slots.length > 0 && (
                <span className="note-meta">{slots.filter((s) => s.imageId).length}/{Math.max(slots.length, 6)}</span>
              )}
            </div>

            {slots.length === 0 && (
              <div className="note-desk-hint">
                <span>{hasBody ? '正文定了，主按钮会拆成图组。' : '先写左边。也可先放一张实拍。'}</span>
                <button className="linkbtn" disabled={Boolean(stage)} onClick={() => pickPhoto({ ghostIndex: 0 })}>
                  先放一张
                </button>
              </div>
            )}

            {slots.length > 0 && (() => {
              const board = [...slots]
              while (board.length < 6) {
                const i = board.length
                board.push({ id: `s${i + 1}`, role: GHOST_ROLES[i] || `图${i + 1}`, want: '', prompt: '' })
              }
              const focus = board.find((s) => s.id === openId) || board.find((s) => s.error)
              return (
                <>
                  <div className="note-board">
                    {board.slice(0, 6).map((s) => {
                      const on = openId === s.id || Boolean(s.error)
                      return (
                        <button
                          key={s.id}
                          className={`note-cell${on ? ' on' : ''}${s.error ? ' bad' : ''}`}
                          onClick={() => setOpenId(s.id === openId ? null : s.id)}
                        >
                          {s.imageId ? (
                            <img src={imgSrc(s.imageId)} alt={s.role} />
                          ) : (
                            <span className="note-cell-empty">{s.role}</span>
                          )}
                          <i className="note-cell-role">{s.role}</i>
                        </button>
                      )
                    })}
                  </div>
                  {focus && (
                    <div className="note-cell-detail">
                      <div className="note-label-row">
                        <b>{focus.role}</b>
                        <span className="note-meta">{focus.error || focus.want.slice(0, 28) || (focus.imageId ? '已放图' : '还没写这张要出什么')}</span>
                      </div>
                      <textarea
                        className="note-mini"
                        rows={2}
                        value={focus.want}
                        onChange={(e) => patchSlot(focus.id, { want: e.target.value })}
                        placeholder="这张要出什么（中文，给人看）"
                      />
                      {cands.length > 0 && (
                        <div className="note-cands">
                          {cands.map((c) => (
                            <button
                              key={c.id}
                              className="note-cand"
                              disabled={Boolean(stage)}
                              onClick={() => placeCandidate(focus.id, c.id)}
                              title={c.ai_caption || c.file_path}
                            >
                              <img
                                src={withToken(c.thumb_path ? `/api/library/thumb?id=${c.id}` : `/api/library/file?id=${c.id}`)}
                                alt=""
                              />
                              {c.source === 'ai' && <i className="ai-badge">AI</i>}
                            </button>
                          ))}
                          <button className="linkbtn" onClick={() => pickPhoto({ slotId: focus.id }, focus.want)}>
                            更多
                          </button>
                        </div>
                      )}
                      <div className="note-slot-acts">
                        <button className="linkbtn" disabled={Boolean(stage)} onClick={() => pickPhoto({ slotId: focus.id })}>
                          {focus.photoId || focus.imageId ? '换一张' : '放一张'}
                        </button>
                        {(focus.photoId || focus.imageId) && (
                          <button className="linkbtn" disabled={Boolean(stage)} onClick={() => genOne(focus, true)}>
                            用这张生
                          </button>
                        )}
                        {focus.photoId && (
                          <button
                            className="linkbtn"
                            onClick={() => patchSlot(focus.id, { imageId: undefined, photoId: undefined, variants: [] })}
                          >
                            拿掉
                          </button>
                        )}
                      </div>
                      <div className="note-slot-more">
                        <button
                          className="linkbtn"
                          onClick={() => setShowPrompt((prev) => ({ ...prev, [focus.id]: !prev[focus.id] }))}
                        >
                          {showPrompt[focus.id] ? '收起提示词' : '出图提示词'}
                        </button>
                        {(focus.imageId || focus.error) && !focus.photoId && (
                          <button className="linkbtn" disabled={Boolean(stage)} onClick={() => genOne(focus)}>
                            {focus.error ? '这张重试' : '再出几张'}
                          </button>
                        )}
                        {focus.imageId && !focus.photoId && (
                          <button
                            className="linkbtn"
                            disabled={Boolean(stage) || savedLib[focus.imageId]}
                            onClick={() => saveToLib(focus)}
                          >
                            {savedLib[focus.imageId] ? '已在库' : '存进库'}
                          </button>
                        )}
                      </div>
                      {showPrompt[focus.id] && (
                        <textarea
                          className="note-mini"
                          rows={3}
                          value={focus.prompt}
                          onChange={(e) => patchSlot(focus.id, { prompt: e.target.value })}
                          placeholder="出图提示词，接模型后用"
                        />
                      )}
                      {focus.variants && focus.variants.length > 0 && (
                        <div className="note-vars">
                          {focus.variants.map((id) => (
                            <button key={id} className={focus.imageId === id ? 'note-var on' : 'note-var'} onClick={() => patchSlot(focus.id, { imageId: id })}>
                              <img src={imgSrc(id)} alt="" />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )
            })()}
          </div>
        </div>
      )}
    </div>
  )
}
