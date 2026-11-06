import { useEffect, useMemo, useRef, useState } from 'react'
import { api, withToken } from '../api'
import { markUsed, pushRecent, readRecent, usedQuery, type LibHit } from '../noteLibrary'

type Tab = 'recommend' | 'recent' | 'album'

const SKIP_LEAF = /^(?:\d{2}_)?(?:精选照片|人物照片|预览图)$/
const LEADING_NUM = /^\d{2}_/

export function albumOf(filePath: string): string {
  const parts = filePath.split('/').filter(Boolean)
  const last = parts[parts.length - 1] || ''
  if (/\.[a-z0-9]+$/i.test(last)) parts.pop()
  while (parts.length && SKIP_LEAF.test(parts[parts.length - 1])) parts.pop()
  const leaf = parts[parts.length - 1] || '未分类'
  return leaf.replace(LEADING_NUM, '') || '未分类'
}

function fileName(path: string) {
  return path.split('/').pop() || path
}

function thumbSrc(a: LibHit) {
  return withToken(a.thumb_path ? `/api/library/thumb?id=${a.id}` : `/api/library/file?id=${a.id}`)
}

export default function PhotoPicker({
  onPick,
  onClose,
  initialQuery = '',
  exclude = [],
}: {
  onPick: (imageId: string, libId: string) => void
  onClose: () => void
  initialQuery?: string
  exclude?: string[]
}) {
  const [assets, setAssets] = useState<LibHit[]>([])
  const [hits, setHits] = useState<LibHit[] | null>(null)
  const [album, setAlbum] = useState('全部')
  const [query, setQuery] = useState(initialQuery)
  const [tab, setTab] = useState<Tab>('recommend')
  const [busy, setBusy] = useState('')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const skip = new Set(exclude)

  const load = () => {
    setLoading(true)
    api('/api/library/assets?type=image&limit=300&sort=time')
      .then((r) => r.json())
      .then((d) => setAssets(d.list || []))
      .catch(() => setAssets([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setHits(null)
      return
    }
    const t = setTimeout(() => {
      const used = usedQuery()
      const ex = exclude.join(',')
      const qs = [
        `q=${encodeURIComponent(q)}`,
        'limit=24',
        ex ? `exclude=${encodeURIComponent(ex)}` : '',
        used ? `used=${encodeURIComponent(used)}` : '',
      ].filter(Boolean).join('&')
      api(`/api/library/suggest?${qs}`)
        .then((r) => r.json())
        .then((d) => setHits(d.list || []))
        .catch(() => setHits([]))
    }, 300)
    return () => clearTimeout(t)
  }, [query, exclude.join(',')])

  const albums = useMemo(() => {
    const counts = new Map<string, number>()
    for (const a of assets) {
      const name = albumOf(a.file_path)
      counts.set(name, (counts.get(name) || 0) + 1)
    }
    return [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], 'zh'))
  }, [assets])

  const recent = useMemo(() => readRecent().filter((a) => !skip.has(a.id)), [assets, busy, exclude.join(',')])

  const shown = useMemo(() => {
    const drop = (list: LibHit[]) => list.filter((a) => !skip.has(a.id))
    if (tab === 'recent') return recent
    if (tab === 'recommend') {
      if (hits) return drop(hits)
      return recent.length ? recent : drop(assets).slice(0, 24)
    }
    const pool = album === '全部' ? assets : assets.filter((a) => albumOf(a.file_path) === album)
    return drop(pool)
  }, [assets, album, hits, tab, recent, exclude.join(',')])

  const useAsset = async (libId: string, meta?: LibHit) => {
    setErr('')
    setBusy('放进图位…')
    try {
      const r = await api('/api/notes/from-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: libId }),
      }).then((x) => x.json())
      if (!r.ok || !r.imageId) throw new Error(r.error || '没放进去')
      const hit = meta || assets.find((a) => a.id === libId) || recent.find((a) => a.id === libId)
      if (hit) pushRecent(hit)
      markUsed([libId])
      onPick(String(r.imageId), libId)
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy('')
    }
  }

  const uploadToLib = async (files: FileList | null) => {
    if (!files?.length) return
    setErr('')
    setBusy('上传到素材库…')
    try {
      let last: LibHit | null = null
      for (const f of Array.from(files)) {
        const r = await api(`/api/library/upload?filename=${encodeURIComponent(f.name)}`, {
          method: 'POST',
          body: f,
        }).then((x) => x.json())
        if (!r.ok || !r.asset?.id) throw new Error(r.error || '上传失败')
        last = {
          id: String(r.asset.id),
          file_path: String(r.asset.file_path || f.name),
          thumb_path: r.asset.thumb_path ? String(r.asset.thumb_path) : '',
          source: 'upload',
        }
      }
      load()
      if (last) await useAsset(last.id, last)
    } catch (e) {
      setErr(String(e))
      setBusy('')
    }
  }

  const emptyHint =
    tab === 'recent' ? '还没有从库里放过图。'
      : tab === 'recommend' && query.trim() ? '这句话暂时对不上。换个说法，或去专辑里翻。'
        : tab === 'recommend' ? '搜一句话，或从这台上传。'
          : '这叠还没有图。换一个文件夹，或去素材库扫描。'

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal note-picker" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">
          <span>放一张实拍</span>
          <button className="linkbtn modal-x" onClick={onClose}>关闭</button>
        </div>
        <input
          className="note-picker-q"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            if (e.target.value.trim()) setTab('recommend')
          }}
          placeholder="小朋友赶海、海鲜晚餐、房间窗户…"
        />
        <div className="note-picker-tabs">
          {([
            ['recommend', '推荐'],
            ['recent', '最近'],
            ['album', '专辑'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              className={tab === id ? 'note-ptab on' : 'note-ptab'}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {err && <div className="errbar">{err}</div>}
        {busy && <div className="note-meta">{busy}</div>}
        {loading && !busy && <div className="note-meta">正在从素材库取图…</div>}

        <div className={tab === 'album' ? 'note-picker-body' : 'note-picker-body single'}>
          {tab === 'album' && (
            <div className="note-albums">
              <button
                className={album === '全部' ? 'note-album on' : 'note-album'}
                onClick={() => setAlbum('全部')}
              >
                <span>全部</span>
                <b>{assets.length}</b>
              </button>
              {albums.map(([name, n]) => (
                <button
                  key={name}
                  className={album === name ? 'note-album on' : 'note-album'}
                  onClick={() => setAlbum(name)}
                >
                  <span>{name}</span>
                  <b>{n}</b>
                </button>
              ))}
            </div>
          )}

          <div className="note-picker-main">
            <div className="note-picker-grid">
              {shown.map((a) => (
                <button
                  key={a.id}
                  className="note-pick"
                  disabled={Boolean(busy)}
                  onClick={() => useAsset(a.id, a)}
                  title={a.ai_caption || fileName(a.file_path)}
                >
                  <img src={thumbSrc(a)} alt={fileName(a.file_path)} />
                  {a.source === 'ai' && <i className="ai-badge">AI</i>}
                </button>
              ))}
            </div>
            {!loading && shown.length === 0 && !busy && (
              <div className="note-meta">{emptyHint}</div>
            )}
          </div>
        </div>

        <div className="note-picker-foot">
          <button className="linkbtn" disabled={Boolean(busy)} onClick={() => fileRef.current?.click()}>
            从这台上传到库
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              uploadToLib(e.target.files)
              e.target.value = ''
            }}
          />
        </div>
      </div>
    </div>
  )
}
