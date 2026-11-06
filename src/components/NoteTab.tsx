import { useEffect, useMemo, useRef, useState } from 'react'
import { api, withToken } from '../api'
import { markUsed, pushRecent, usedQuery } from '../noteLibrary'
import PhotoPicker from './PhotoPicker'

type Slot = {
  id: string
  role: string
  want: string
  prompt: string
  imageId?: string
  photoId?: string
  libId?: string
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
  shotsLocked: boolean
  openId: string | null
  usedFallback?: boolean
  style: string
  lint: Lint | null
  rewritten?: boolean
}

type Undo = {
  slotId: string
  role: string
  prev: Pick<Slot, 'imageId' | 'photoId' | 'libId' | 'variants' | 'error'>
}

const DRAFT_KEY = 'note_draft'

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
    libId: s.libId ? String(s.libId) : undefined,
    variants: Array.isArray(s.variants) ? s.variants.map(String) : [],
  }
}

function roleOf(i: number) {
  return i === 0 ? '封面' : `图${i + 1}`
}

function buildImagePrompt(want: string) {
  const w = String(want || '').trim() || 'Chinese coastal homestay, candid guest photo'
  return [
    'Photorealistic candid photo, Xiaohongshu lifestyle snapshot,',
    'Ninghai Zhejiang seaside village homestay, natural light, real textures,',
    w,
    ', no text, no watermark, no logo, no poster layout, 3:4 portrait',
  ].join(' ')
}

function renumber(list: Slot[]): Slot[] {
  return list.map((s, i) => ({ ...s, role: roleOf(i) }))
}

function emptyDraft(): Draft {
  return {
    material: '',
    topic: '',
    body: '',
    tags: [],
    slots: [],
    shotsLocked: false,
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
    const slots = Array.isArray(p.slots) ? (p.slots as unknown[]).map(asSlot).filter((s): s is Slot => s !== null) : []
    return {
      material: String(p.material || ''),
      topic: String(p.topic || ''),
      body: String(p.body || ''),
      tags: Array.isArray(p.tags) ? p.tags.map(String).filter(Boolean).slice(0, 12) : [],
      slots,
      shotsLocked: typeof p.shotsLocked === 'boolean' ? p.shotsLocked : slots.some((s) => Boolean(s.imageId)),
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

function slotKind(s: Slot): 'photo' | 'ai' | 'empty' | 'error' {
  if (s.error) return 'error'
  if (s.photoId) return 'photo'
  if (s.imageId) return 'ai'
  return 'empty'
}

function kindLabel(k: ReturnType<typeof slotKind>) {
  return k === 'photo' ? '实拍' : k === 'ai' ? 'AI' : k === 'error' ? '出错' : '待补'
}

export default function NoteTab({ onBack }: { onBack?: () => void }) {
  const saved = readDraft()
  const [room, setRoom] = useState<'write' | 'stock'>('write')
  const [material, setMaterial] = useState(saved.material)
  const [topic, setTopic] = useState(saved.topic)
  const [body, setBody] = useState(saved.body)
  const [tags, setTags] = useState<string[]>(saved.tags)
  const [slots, setSlots] = useState<Slot[]>(saved.slots)
  const [shotsLocked, setShotsLocked] = useState(saved.shotsLocked)
  const [openId, setOpenId] = useState<string | null>(saved.openId)
  const [usedFallback, setUsedFallback] = useState(Boolean(saved.usedFallback))
  const [style, setStyle] = useState(saved.style)
  const [lint, setLint] = useState<Lint | null>(saved.lint)
  const [rewritten, setRewritten] = useState(Boolean(saved.rewritten))
  const [stage, setStage] = useState('')
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmResplit, setConfirmResplit] = useState(false)
  const [showPrompt, setShowPrompt] = useState<Record<string, boolean>>({})
  const [showDirection, setShowDirection] = useState(Boolean(saved.topic) && !saved.body)
  const [seedOpen, setSeedOpen] = useState(!saved.body)
  const [moreOpen, setMoreOpen] = useState(false)
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
  const [undo, setUndo] = useState<Undo | null>(null)

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
      material, topic, body, tags, slots, shotsLocked, openId, usedFallback, style, lint, rewritten,
    }
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  }, [material, topic, body, tags, slots, shotsLocked, openId, usedFallback, style, lint, rewritten])

  useEffect(() => {
    if (!confirmReset) return
    const t = setTimeout(() => setConfirmReset(false), 3000)
    return () => clearTimeout(t)
  }, [confirmReset])

  useEffect(() => {
    if (!confirmResplit) return
    const t = setTimeout(() => setConfirmResplit(false), 3000)
    return () => clearTimeout(t)
  }, [confirmResplit])

  useEffect(() => {
    if (!undo) return
    const t = setTimeout(() => setUndo(null), 5000)
    return () => clearTimeout(t)
  }, [undo])

  const dirty = Boolean(material.trim() || topic.trim() || body.trim() || tags.length || slots.length)
  const usedInNote = useMemo(
    () => slots.map((s) => s.libId).filter((id): id is string => Boolean(id)),
    [slots],
  )

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
      setSeedOpen(false)
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
    run('拆镜头…', async () => {
      const r = await api('/api/notes/storyboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, body }),
      }).then((x) => x.json())
      if (!r.ok) throw new Error(r.error || '拆镜头失败')
      const next = Array.isArray(r.slots) ? r.slots : []
      setSlots(renumber(next.slice(0, 6).map((ns: Slot) => ({
        id: ns.id,
        role: ns.role,
        want: ns.want,
        prompt: ns.prompt || buildImagePrompt(ns.want),
      }))))
      setShotsLocked(false)
      setOpenId(null)
      setUsedFallback((prev) => prev || Boolean(r.fallback))
      setConfirmResplit(false)
      setMoreOpen(false)
    })

  const tryResplit = () => {
    if (slots.some((s) => s.imageId) && !confirmResplit) {
      setConfirmResplit(true)
      return
    }
    splitBoard()
  }

  const lockShots = () => {
    if (!slots.length) return
    const next = renumber(slots.map((s) => ({
      ...s,
      prompt: buildImagePrompt(s.want || s.role),
    })))
    setSlots(next)
    setShotsLocked(true)
    setOpenId(next[0]?.id || null)
    setMoreOpen(false)
  }

  const unlockShots = () => {
    setShotsLocked(false)
    setOpenId(null)
    setMoreOpen(false)
  }

  const moveShot = (i: number, dir: -1 | 1) => {
    setSlots((prev) => {
      const j = i + dir
      if (j < 0 || j >= prev.length) return prev
      const next = [...prev]
      const a = next[i]
      next[i] = next[j]
      next[j] = a
      return renumber(next)
    })
  }

  const addShot = () => {
    if (slots.length >= 6) return
    setSlots((prev) => renumber([
      ...prev,
      { id: `s${Date.now().toString(36)}`, role: '', want: '', prompt: '' },
    ]))
  }

  const removeShot = (id: string) => {
    setSlots((prev) => prev.length <= 1 ? prev : renumber(prev.filter((s) => s.id !== id)))
  }

  const genMissing = () =>
    run('补图中…', async () => {
      const targets = slots.filter((s) => !s.imageId)
      if (!targets.length) return
      setGenTotal(targets.length)
      setGenDone(0)
      let done = 0
      const failed: string[] = []
      for (const slot of targets) {
        setStage(`补图 ${done + 1}/${targets.length} · ${slot.role}`)
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
      if (failed.length) throw new Error(`${failed.join('、')} 没出成，可在格子上重试`)
    })

  const genAll = () =>
    run('重出整组…', async () => {
      setMoreOpen(false)
      setGenTotal(slots.length)
      setGenDone(0)
      let done = 0
      const failed: string[] = []
      for (const slot of slots) {
        setStage(`出图 ${done + 1}/${slots.length} · ${slot.role}`)
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
      if (failed.length) throw new Error(`${failed.join('、')} 没出成`)
    })

  const genOne = (slot: Slot, fromPhoto = false) =>
    run(fromPhoto ? `用这张生 ${slot.role}…` : `出图 ${slot.role}…`, async () => {
      const ref = fromPhoto ? (slot.photoId || slot.imageId) : slot.photoId
      const r = await api('/api/notes/generate-one', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: slot.prompt,
          want: slot.want,
          imageId: ref || undefined,
          n: fromPhoto || ref ? 1 : (slot.imageId ? 3 : 1),
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
    if (!shotsLocked || !wantKey) {
      setCands([])
      return
    }
    const q = wantKey.split('|').slice(1).join('|')
    const t = setTimeout(() => {
      const ex = usedInNote.filter((id) => id !== openSlot?.libId).join(',')
      const used = usedQuery()
      const qs = [
        `q=${encodeURIComponent(q)}`,
        'limit=3',
        ex ? `exclude=${encodeURIComponent(ex)}` : '',
        used ? `used=${encodeURIComponent(used)}` : '',
      ].filter(Boolean).join('&')
      api(`/api/library/suggest?${qs}`)
        .then((r) => r.json())
        .then((d) => setCands(d.list || []))
        .catch(() => setCands([]))
    }, 500)
    return () => clearTimeout(t)
  }, [shotsLocked, wantKey, usedInNote.join(',')])

  const snapshot = (s: Slot): Undo['prev'] => ({
    imageId: s.imageId,
    photoId: s.photoId,
    libId: s.libId,
    variants: s.variants,
    error: s.error,
  })

  const applyPlace = (imageId: string, libId?: string) => {
    const pending = pickRef.current
    setPicking(false)
    const list = slots
    if (!list.length) return
    const idx = pending?.slotId
      ? list.findIndex((s) => s.id === pending.slotId)
      : (pending?.ghostIndex ?? 0)
    const i = idx >= 0 ? idx : 0
    const old = list[i]
    if (old) {
      setUndo({ slotId: old.id, role: old.role, prev: snapshot(old) })
      setOpenId(old.id)
    }
    setSlots(list.map((s, j) => (
      j === i ? { ...s, imageId, photoId: imageId, libId, error: undefined } : s
    )))
  }

  const placeCandidate = (slotId: string, hit: SuggestHit) => {
    pickRef.current = { slotId }
    setStage('放进图位…')
    api('/api/notes/from-library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: hit.id }),
    })
      .then((x) => x.json())
      .then((r) => {
        if (!r.ok || !r.imageId) throw new Error(r.error || '没放进去')
        pushRecent(hit)
        markUsed([hit.id])
        applyPlace(String(r.imageId), hit.id)
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

  const patchSlot = (id: string, patch: Partial<Slot>) =>
    setSlots((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))

  const undoPlace = () => {
    if (!undo) return
    const u = undo
    setSlots((prev) => prev.map((s) => (s.id === u.slotId ? { ...s, ...u.prev } : s)))
    setUndo(null)
  }

  const reset = () => {
    setMaterial('')
    setTopic('')
    setBody('')
    setTags([])
    setSlots([])
    setShotsLocked(false)
    setErr('')
    setOpenId(null)
    setUsedFallback(false)
    setStyle('')
    setLint(null)
    setRewritten(false)
    setShowPrompt({})
    setConfirmReset(false)
    setSeedOpen(true)
    setShowDirection(false)
    setMoreOpen(false)
    setConfirmResplit(false)
    setUndo(null)
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
    markUsed(usedInNote)
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
  const missing = slots.filter((s) => !s.imageId).length
  const lintFail = Boolean(lint && !lint.ok && hasBody)

  const primary = (() => {
    if (stage) return { label: stage, disabled: true, go: () => {} }
    if (!hasSeed) return { label: '起草笔记', disabled: true, go: () => {} }
    if (!hasBody) return { label: '起草笔记', disabled: false, go: draftCopy }
    if (!slots.length) return { label: '拆镜头', disabled: false, go: splitBoard }
    if (!shotsLocked) return { label: '定这组镜头', disabled: !slots.some((s) => s.want.trim()), go: lockShots }
    if (missing) return { label: genTotal ? `补齐 ${genDone}/${genTotal}` : `补齐 ${missing} 张图`, disabled: false, go: genMissing }
    return { label: copied === '正文' ? '已复制' : '复制全文', disabled: false, go: copyFull }
  })()

  const secondary = (() => {
    if (stage || !hasBody || !hasSeed) return null
    return { label: '再写一版', go: draftCopy }
  })()

  const seedLine = material.trim().split(/\n/)[0] || '今日素材'

  return (
    <div className="note-page">
      {err && <div className="errbar">{err}</div>}
      {picking && (
        <PhotoPicker
          onPick={applyPlace}
          onClose={() => { setPicking(false); setPickerQuery('') }}
          initialQuery={pickerQuery}
          exclude={usedInNote}
        />
      )}

      {room === 'stock' ? (
        <div className="note-stock">
          <div className="note-toolbar">
            <button className="linkbtn" onClick={() => { setRoom('write'); setErr(''); setLearnHint(''); }}>
              回写笔记
            </button>
          </div>
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
        <>
          <div className="note-toolbar">
            <button className="linkbtn" onClick={() => { setRoom('stock'); setErr(''); }}>
              囤参考
            </button>
            <div className="note-toolbar-right">
              {dirty && <span className="note-meta">草稿已保存</span>}
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
          </div>

          <div className="note-steps" aria-hidden>
            <span className={hasSeed ? 'on' : ''}>素材</span>
            <i />
            <span className={hasBody ? 'on' : ''}>文案</span>
            <i />
            <span className={slots.length ? 'on' : ''}>镜头</span>
            <i />
            <span className={shotsLocked ? 'on' : ''}>配图</span>
          </div>

          <div className="note-work">
            <div className="note-editor">
              {!hasBody || seedOpen ? (
                <div className="note-seed-box">
                  <label className="note-quiet" htmlFor="note-material">今天发生了什么？</label>
                  <textarea
                    id="note-material"
                    className="note-seed"
                    rows={3}
                    value={material}
                    onChange={(e) => setMaterial(e.target.value)}
                    placeholder="退潮的时候挖到蛏子，小朋友第一次赶海特别兴奋，晚上回来吃白蟹。"
                  />
                  {!hasBody && (showDirection || topic.trim()) && (
                    <div className="note-dir">
                      <label className="note-quiet" htmlFor="note-topic-dir">写作方向（可选）</label>
                      <input
                        id="note-topic-dir"
                        className="note-dir-input"
                        value={topic}
                        onChange={(e) => setTopic(e.target.value)}
                        placeholder="例如：第一次带小朋友赶海"
                      />
                    </div>
                  )}
                  {!hasBody && !showDirection && !topic.trim() && (
                    <button className="linkbtn" onClick={() => setShowDirection(true)}>＋ 给 AI 一个写作方向</button>
                  )}
                  {hasBody && (
                    <button className="linkbtn" onClick={() => setSeedOpen(false)}>收起素材</button>
                  )}
                </div>
              ) : (
                <button className="note-seed-fold" onClick={() => setSeedOpen(true)} title="改今日素材">
                  {seedLine}
                </button>
              )}

              {hasBody && (
                <div className="note-doc">
                  <input
                    className="note-doc-title"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="标题"
                  />
                  <div className="note-doc-meta">
                    <span>{body.length} 字{rewritten ? ' · 改过' : ''}</span>
                  </div>
                  <textarea
                    className="note-doc-body"
                    rows={14}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder="像刚住完的人在讲。"
                  />
                  {lintFail && (
                    <div className="note-lint bad">
                      {lint?.fail.join('；') || '再改一版'}
                      {' '}
                      <button className="linkbtn" onClick={lintCopy} disabled={Boolean(stage)}>按这个改一版</button>
                    </div>
                  )}
                  {usedFallback && (
                    <div className="note-meta">没走模型，这是本地底稿。</div>
                  )}
                  {tags.length > 0 && (
                    <div className="note-chips">
                      {tags.map((t) => (
                        <button
                          key={t}
                          className="note-chip"
                          title="去掉这个话题"
                          onClick={() => setTags((prev) => prev.filter((x) => x !== t))}
                        >
                          #{t}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {!hasBody && hasLlm === false && (
                <div className="note-meta">文案模型还没接上，起草会用本地底稿。</div>
              )}
            </div>

            <div className="note-story">
              <div className="note-label-row">
                <div className="note-quiet">{shotsLocked ? '配图' : '镜头'}</div>
                {shotsLocked && slots.length > 0 && (
                  <span className="note-meta">{slots.filter((s) => s.imageId).length} / {slots.length}</span>
                )}
                {!shotsLocked && slots.length > 0 && (
                  <button
                    className={confirmResplit ? 'linkbtn danger' : 'linkbtn'}
                    disabled={Boolean(stage)}
                    onClick={tryResplit}
                  >
                    {confirmResplit ? '确定重拆？已放入的图会丢掉' : '重新拆镜头'}
                  </button>
                )}
                {shotsLocked && (
                  <div className="note-more">
                    <button className="linkbtn" onClick={() => setMoreOpen((v) => !v)}>⋯</button>
                    {moreOpen && (
                      <div className="note-more-menu">
                        <button className="linkbtn" disabled={Boolean(stage)} onClick={unlockShots}>改镜头</button>
                        <button
                          className={confirmResplit ? 'linkbtn danger' : 'linkbtn'}
                          disabled={Boolean(stage)}
                          onClick={tryResplit}
                        >
                          {confirmResplit ? '确定重拆？' : '重新拆镜头'}
                        </button>
                        <button className="linkbtn" disabled={Boolean(stage)} onClick={genAll}>再出这一组</button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {slots.length === 0 && (
                <div className="note-desk-hint">
                  <span>{hasBody ? '正文定了，右下角拆成镜头。先谈要哪些图，再填格子。' : '先写左边两句。'}</span>
                </div>
              )}

              {slots.length > 0 && !shotsLocked && (
                <div className="note-shots">
                  {slots.map((s, i) => (
                    <div key={s.id} className="note-shot">
                      <div className="note-shot-head">
                        <b>{s.role}</b>
                        <div className="note-shot-ops">
                          <button className="linkbtn" disabled={i === 0} onClick={() => moveShot(i, -1)}>上移</button>
                          <button className="linkbtn" disabled={i === slots.length - 1} onClick={() => moveShot(i, 1)}>下移</button>
                          <button className="linkbtn" disabled={slots.length <= 1} onClick={() => removeShot(s.id)}>删</button>
                        </div>
                      </div>
                      <textarea
                        className="note-want"
                        rows={2}
                        value={s.want}
                        onChange={(e) => patchSlot(s.id, { want: e.target.value })}
                        placeholder="这张要看见什么"
                      />
                    </div>
                  ))}
                  {slots.length < 6 && (
                    <button className="linkbtn" onClick={addShot}>＋ 加一张</button>
                  )}
                </div>
              )}

              {slots.length > 0 && shotsLocked && (() => {
                const board = slots.slice(0, 6)
                const focus = board.find((s) => s.id === openId) || board.find((s) => s.error) || board[0]
                const kind = focus ? slotKind(focus) : 'empty'
                return (
                  <>
                    <div className="note-board">
                      {board.slice(0, 6).map((s) => {
                        const on = openId === s.id || Boolean(s.error)
                        const k = slotKind(s)
                        return (
                          <button
                            key={s.id}
                            className={`note-cell${on ? ' on' : ''}${k === 'error' ? ' bad' : ''}${k === 'empty' ? ' vacant' : ''}`}
                            onClick={() => setOpenId(s.id === openId ? null : s.id)}
                          >
                            {s.imageId ? (
                              <img src={imgSrc(s.imageId)} alt={s.role} />
                            ) : (
                              <span className="note-cell-empty">{k === 'empty' ? '+' : s.role}</span>
                            )}
                            <i className="note-cell-role">{s.role}</i>
                            <b className={`note-cell-kind ${k}`}>{kindLabel(k)}</b>
                          </button>
                        )
                      })}
                    </div>
                    {focus && openId && (
                      <div className="note-inspect">
                        <div className="note-label-row">
                          <b>当前：{focus.role}</b>
                          <span className="note-meta">{focus.error || kindLabel(kind)}</span>
                        </div>
                        <label className="note-quiet" htmlFor="note-want">想要的画面</label>
                        <textarea
                          id="note-want"
                          className="note-want"
                          rows={2}
                          value={focus.want}
                          onChange={(e) => patchSlot(focus.id, { want: e.target.value })}
                          placeholder="这张要看见什么"
                        />
                        <div className="note-cands-head">
                          <span className="note-quiet">推荐实拍</span>
                          <button className="linkbtn" onClick={() => pickPhoto({ slotId: focus.id }, focus.want)}>
                            更多
                          </button>
                        </div>
                        {cands.length > 0 ? (
                          <div className="note-cands">
                            {cands.map((c) => (
                              <button
                                key={c.id}
                                className="note-cand"
                                disabled={Boolean(stage)}
                                onClick={() => placeCandidate(focus.id, c)}
                                title={c.ai_caption || c.file_path}
                              >
                                <img
                                  src={withToken(c.thumb_path ? `/api/library/thumb?id=${c.id}` : `/api/library/file?id=${c.id}`)}
                                  alt=""
                                />
                                {c.source === 'ai' && <i className="ai-badge">AI</i>}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div className="note-meta">库里暂时没有贴这句的。找实拍，或让 AI 补。</div>
                        )}
                        <div className="note-slot-acts">
                          {kind === 'empty' || kind === 'error' ? (
                            <>
                              <button className="linkbtn" disabled={Boolean(stage)} onClick={() => pickPhoto({ slotId: focus.id }, focus.want)}>
                                找实拍
                              </button>
                              <button className="linkbtn" disabled={Boolean(stage)} onClick={() => genOne(focus)}>
                                {focus.error ? '再试一次' : 'AI 生成'}
                              </button>
                            </>
                          ) : kind === 'photo' ? (
                            <>
                              <button className="linkbtn" disabled={Boolean(stage)} onClick={() => pickPhoto({ slotId: focus.id }, focus.want)}>
                                换实拍
                              </button>
                              <button className="linkbtn" disabled={Boolean(stage)} onClick={() => genOne(focus, true)}>
                                用这张生
                              </button>
                              <button
                                className="linkbtn"
                                onClick={() => patchSlot(focus.id, { imageId: undefined, photoId: undefined, libId: undefined, variants: [] })}
                              >
                                拿掉
                              </button>
                            </>
                          ) : (
                            <>
                              <button className="linkbtn" disabled={Boolean(stage)} onClick={() => pickPhoto({ slotId: focus.id }, focus.want)}>
                                找实拍
                              </button>
                              <button className="linkbtn" disabled={Boolean(stage)} onClick={() => genOne(focus)}>
                                再出几张
                              </button>
                              {focus.imageId && (
                                <button
                                  className="linkbtn"
                                  disabled={Boolean(stage) || savedLib[focus.imageId]}
                                  onClick={() => saveToLib(focus)}
                                >
                                  {savedLib[focus.imageId] ? '已在库' : '存进库'}
                                </button>
                              )}
                            </>
                          )}
                        </div>
                        <button
                          className="linkbtn"
                          onClick={() => setShowPrompt((prev) => ({ ...prev, [focus.id]: !prev[focus.id] }))}
                        >
                          {showPrompt[focus.id] ? '收起提示词' : '出图提示词'}
                        </button>
                        {showPrompt[focus.id] && (
                          <textarea
                            className="note-want"
                            rows={3}
                            value={focus.prompt}
                            onChange={(e) => patchSlot(focus.id, { prompt: e.target.value })}
                            placeholder="出图提示词"
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

          <div className="note-dock">
            {secondary && (
              <button className="linkbtn" onClick={secondary.go} disabled={Boolean(stage)}>
                {secondary.label}
              </button>
            )}
            <button className="btn note-main" onClick={primary.go} disabled={primary.disabled}>
              {primary.label}
            </button>
          </div>
        </>
      )}

      {undo && room === 'write' && (
        <div className="note-toast" role="status">
          已换掉「{undo.role}」
          <button className="linkbtn" onClick={undoPlace}>撤销</button>
        </div>
      )}
    </div>
  )
}
