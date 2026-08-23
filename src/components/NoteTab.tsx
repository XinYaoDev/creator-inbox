import { useEffect, useState } from 'react'
import { api, withToken } from '../api'

type Slot = {
  id: string
  role: string
  want: string
  prompt: string
  imageId?: string
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
  materials: number
  notes: number
  cases: number
  recentNotes: RecentNote[]
  recentCases: RecentCase[]
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
  gates: boolean[]
}

const DRAFT_KEY = 'note_draft'
const MATERIAL_CHIPS = [
  '退潮后来的，挖到几只蛏子，回来桌上已经有菜',
  '下雨，院子里有人打牌，客房被窝是干的',
  '第一次看泥里那些小洞，挖了没有东西',
  '想去二号闸，施工进不去，有人指了另一条路',
  '以为赶海是夹大螃蟹，其实是拿耙子挖',
]
const GATES = [
  '删掉店名，还像住过的人写的',
  '封面和标题是同一句话',
  '看完能判断几个人去合不合适',
  '没有欢迎预订、私信、封神、天花板',
]
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
    variants: Array.isArray(s.variants) ? s.variants.map(String) : [],
  }
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
    gates: [false, false, false, false],
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
    const gates = Array.isArray(p.gates) ? p.gates.map(Boolean).slice(0, 4) : []
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
      gates: [...gates, false, false, false, false].slice(0, 4),
    }
  } catch {
    return emptyDraft()
  }
}

export default function NoteTab({ onBack }: { onBack?: () => void }) {
  const saved = readDraft()
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
  const [gates, setGates] = useState<boolean[]>(saved.gates)
  const [stage, setStage] = useState('')
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const [showPrompt, setShowPrompt] = useState<Record<string, boolean>>({})
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
          materials: Number(d.materials) || 0,
          notes: Number(d.notes) || 0,
          cases: Number(d.cases) || 0,
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
    loadAssets()
  }, [])

  useEffect(() => {
    const draft: Draft = {
      material, topic, body, tags, slots, openId, usedFallback, style, lint, rewritten, gates,
    }
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  }, [material, topic, body, tags, slots, openId, usedFallback, style, lint, rewritten, gates])

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
      setGates([false, false, false, false])
      loadAssets()
    })

  const lintCopy = () =>
    run('自检中…', async () => {
      const r = await api('/api/notes/lint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: topic, body, material, style, tags, rewrite: true }),
      }).then((x) => x.json())
      if (!r.ok) throw new Error(r.error || '自检失败')
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
      setSlots(r.slots || [])
      setOpenId(r.slots?.[0]?.id || null)
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
          body: JSON.stringify({ prompt: slot.prompt, n: 1 }),
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

  const genOne = (slot: Slot) =>
    run(`重出 ${slot.role}…`, async () => {
      const r = await api('/api/notes/generate-one', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: slot.prompt, n: 3 }),
      }).then((x) => x.json())
      if (!r.ok) throw new Error(r.error || '重出失败')
      const ids: string[] = r.imageIds || []
      setSlots((prev) =>
        prev.map((s) => (s.id === slot.id ? { ...s, variants: ids, imageId: ids[0] || s.imageId, error: undefined } : s)),
      )
    })

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
    setGates([false, false, false, false])
    setTagInput('')
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

  const copyText = async (label: string, text: string) => {
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
    setCopied(label)
    setTimeout(() => setCopied(''), 1600)
    if (label === '正文' && (topic.trim() || body.trim())) {
      api('/api/assets/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: topic, body, tags, style, material }),
      })
        .then(() => loadAssets())
        .catch(() => {})
    }
  }

  const learnOne = () =>
    run('学习中…', async () => {
      setLearnHint('')
      const r = await api('/api/assets/learn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: learnUrl.trim() }),
      }).then((x) => x.json())
      if (!r.ok) throw new Error('Mac 桥没开或链接失效')
      const c = r.case || {}
      setLearnHint(`${c.title || '已记下'} · ${c.style || ''} · 赞${c.likes ?? 0} 藏${c.favorites ?? 0}`)
      setLearnUrl('')
      loadAssets()
    })

  const doBackfill = () =>
    run('回填中…', async () => {
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
      if (!r.ok) throw new Error(r.error || '回填失败')
      setBackfillHint('已记下赞藏评')
      setBfLikes('')
      setBfFav('')
      setBfCmt('')
      loadAssets()
    })

  const addTag = () => {
    const t = tagInput.replace(/^#/, '').trim()
    if (!t || tags.includes(t)) {
      setTagInput('')
      return
    }
    setTags((prev) => [...prev, t].slice(0, 12))
    setTagInput('')
  }

  const hasMaterial = Boolean(material.trim())
  const hasTopic = Boolean(topic.trim())
  const hasSeed = hasMaterial || hasTopic
  const hasBody = Boolean(body.trim())
  const drafting = stage.startsWith('起草') || stage.startsWith('自检')
  const imaging = Boolean(stage) && !drafting
  const leftDisabled = Boolean(stage) || !hasSeed
  const leftLabel = drafting
    ? stage
    : !hasSeed
      ? '先写今日素材'
      : hasBody
        ? '按素材再写一版'
        : '按素材起草'
  const rightLabel = imaging
    ? stage
    : !slots.length
      ? '按正文拆成图组'
      : slots.some((s) => !s.imageId)
        ? (genTotal ? `出图 ${genDone}/${genTotal}` : '生这一组')
        : '再出这一组'

  return (
    <div>
      <div className="note-toolbar">
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
      {err && <div className="errbar">{err}</div>}

      <div className="note-layout">
        <div className="note-col">
          <label className="pub-label" htmlFor="note-material">1 今日素材</label>
          <textarea
            id="note-material"
            className="note-material"
            rows={4}
            value={material}
            onChange={(e) => setMaterial(e.target.value)}
            placeholder="几句现场事实就行，例如：退潮 14:30，挖到三只蛏子；厨房杀了跑山鸡；下雨，院子里打牌。"
          />
          <div className="note-chips">
            {MATERIAL_CHIPS.map((c) => (
              <button
                key={c}
                className={material === c ? 'pfilter active' : 'pfilter'}
                onClick={() => setMaterial(c)}
              >
                {c.slice(0, 16)}
              </button>
            ))}
          </div>

          <div className="note-label-row">
            <label className="pub-label" htmlFor="note-topic">标题</label>
            {style && <span className="note-meta">{style}{rewritten ? ' · 改过一稿' : ''}</span>}
          </div>
          <input
            id="note-topic"
            className="note-topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="起草后出现。也可先写一句方向。"
          />

          <div className="note-label-row">
            <label className="pub-label" htmlFor="note-body">2 分享正文</label>
            {hasBody && <span className="note-meta">{body.length} 字</span>}
          </div>
          <textarea
            id="note-body"
            className="note-body"
            rows={12}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="像刚住完的人在讲。素材里的事实会写进来，不要事后改成广告。"
          />
          {lint && hasBody && (
            <div className={lint.ok ? 'note-lint ok' : 'note-lint bad'}>
              {lint.ok ? '自检过了' : `自检未过：${lint.fail.join('；') || '再改一版'}`}
            </div>
          )}
          {usedFallback && hasBody && (
            <div className="note-meta">没走模型，这是本地底稿。接上文案模型后会按素材起草。</div>
          )}
          {hasLlm === false && !hasBody && (
            <div className="note-meta">文案模型还没接上，起草会用本地底稿。</div>
          )}

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
            <input
              className="tag-input"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addTag()
                }
              }}
              placeholder="加话题，回车"
            />
          </div>

          <div className="note-step-actions">
            <button className="btn note-main" onClick={draftCopy} disabled={leftDisabled}>
              {leftLabel}
            </button>
            {hasBody && (
              <>
                <button className="linkbtn" onClick={lintCopy} disabled={Boolean(stage)}>
                  过一遍自检
                </button>
                <button className="linkbtn" onClick={() => copyText('正文', [topic, body, tags.map((t) => `#${t}`).join(' ')].filter(Boolean).join('\n\n'))}>
                  复制全文
                </button>
                {tags.length > 0 && (
                  <button className="linkbtn" onClick={() => copyText('话题', tags.map((t) => `#${t}`).join(' '))}>
                    复制话题
                  </button>
                )}
              </>
            )}
            {copied && <span className="note-meta">已复制{copied}</span>}
          </div>

          {hasBody && (
            <div className="note-gate">
              <div className="pub-label">发布前四问</div>
              {GATES.map((g, i) => (
                <label key={g} className="note-gate-row">
                  <input
                    type="checkbox"
                    checked={Boolean(gates[i])}
                    onChange={() => setGates((prev) => prev.map((v, j) => (j === i ? !v : v)))}
                  />
                  <span>{g}</span>
                </label>
              ))}
              {gates.every(Boolean) && <div className="note-meta">可以复制去发了。自动发帖不做。</div>}
            </div>
          )}

          <div className="note-assets">
            <div className="pub-label">资产</div>
            <div className="note-asset-counts">
              素材 {assetSum?.materials ?? 0} · 成稿 {assetSum?.notes ?? 0} · 参考 {assetSum?.cases ?? 0}
            </div>
            <div className="note-asset-row">
              <input
                className="note-asset-url"
                value={learnUrl}
                onChange={(e) => setLearnUrl(e.target.value)}
                placeholder="贴一条小红书链接学习"
              />
              <button className="linkbtn" onClick={learnOne} disabled={Boolean(stage) || !learnUrl.trim()}>
                学一条参考
              </button>
            </div>
            {learnHint && <div className="note-meta">{learnHint}</div>}
            {(assetSum?.recentNotes?.length || 0) > 0 && (
              <>
                <div className="note-asset-row">
                  <select
                    className="note-asset-url"
                    value={backfillId}
                    onChange={(e) => setBackfillId(e.target.value)}
                  >
                    {assetSum?.recentNotes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.title.slice(0, 24) || n.id}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="note-asset-nums">
                  <input
                    inputMode="numeric"
                    placeholder="赞"
                    value={bfLikes}
                    onChange={(e) => setBfLikes(e.target.value)}
                  />
                  <input
                    inputMode="numeric"
                    placeholder="藏"
                    value={bfFav}
                    onChange={(e) => setBfFav(e.target.value)}
                  />
                  <input
                    inputMode="numeric"
                    placeholder="评"
                    value={bfCmt}
                    onChange={(e) => setBfCmt(e.target.value)}
                  />
                  <button
                    className="linkbtn"
                    onClick={doBackfill}
                    disabled={Boolean(stage) || !backfillId}
                  >
                    回填
                  </button>
                </div>
                {backfillHint && <div className="note-meta">{backfillHint}</div>}
              </>
            )}
            {assetSum?.recentCases?.[0] && (
              <div className="note-meta">
                最近参考：{assetSum.recentCases[0].title.slice(0, 28)} · {assetSum.recentCases[0].style} · 赞{assetSum.recentCases[0].likes}
              </div>
            )}
          </div>
        </div>

        <div className="note-col">
          <div className="note-label-row">
            <div className="pub-label">3 这一组图</div>
            {slots.length > 0 && (
              <span className="note-meta">{slots.filter((s) => s.imageId).length}/{slots.length}</span>
            )}
          </div>

          {!slots.length && GHOST_ROLES.map((role, i) => (
            <div key={role} className={`note-ghost${i === 0 ? ' on' : ''}`}>
              <b>{role}</b>
              <span>{hasBody ? '点下面拆成图组，每张都可以改' : '正文定了之后，这里会拆成一组图'}</span>
            </div>
          ))}

          {slots.map((s) => {
            const selected = openId === s.id
            const open = selected || Boolean(s.error)
            return (
              <div key={s.id} className={`note-slot${selected ? ' on' : ''}${s.error ? ' bad' : ''}`}>
                <button className="note-slot-head" onClick={() => setOpenId(s.id)}>
                  <b>{s.role}</b>
                  <span>{s.error || s.want.slice(0, 36) || '还没写这张要出什么'}</span>
                </button>
                {s.imageId && (
                  <button className="note-shot-btn" onClick={() => setOpenId(s.id)}>
                    <img className="note-shot" src={imgSrc(s.imageId)} alt={s.role} />
                  </button>
                )}
                {open && (
                  <div className="note-slot-body">
                    <textarea
                      className="note-mini"
                      rows={2}
                      value={s.want}
                      onChange={(e) => patchSlot(s.id, { want: e.target.value })}
                      placeholder="这张要出什么（中文，给人看）"
                    />
                    <button
                      className="linkbtn"
                      onClick={() => setShowPrompt((prev) => ({ ...prev, [s.id]: !prev[s.id] }))}
                    >
                      {showPrompt[s.id] ? '收起提示词' : '出图提示词'}
                    </button>
                    {showPrompt[s.id] && (
                      <textarea
                        className="note-mini"
                        rows={3}
                        value={s.prompt}
                        onChange={(e) => patchSlot(s.id, { prompt: e.target.value })}
                        placeholder="出图提示词，接模型后用"
                      />
                    )}
                    {(s.imageId || s.error) && (
                      <button className="btn" disabled={Boolean(stage)} onClick={() => genOne(s)}>
                        {s.error ? '这张重试' : '这张再出几张'}
                      </button>
                    )}
                    {s.variants && s.variants.length > 0 && (
                      <div className="note-vars">
                        {s.variants.map((id) => (
                          <button key={id} className={s.imageId === id ? 'note-var on' : 'note-var'} onClick={() => patchSlot(s.id, { imageId: id })}>
                            <img src={imgSrc(id)} alt="" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {hasBody && (
            <div className="note-step-actions">
              <button
                className="btn note-main"
                onClick={!slots.length ? splitBoard : genMissing}
                disabled={Boolean(stage)}
              >
                {rightLabel}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
