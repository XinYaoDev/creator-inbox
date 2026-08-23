import { useEffect, useMemo, useRef, useState } from 'react'
import { api, withToken } from '../api'

type LibAsset = {
  id: string
  thumb_path: string
  file_path: string
  source?: string
  ai_caption?: string
}

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

function folderHint(path: string) {
  const parts = path.split('/').filter(Boolean)
  if (/\.[a-z0-9]+$/i.test(parts[parts.length - 1] || '')) parts.pop()
  return parts.slice(-2).join(' / ')
}

function thumbSrc(a: LibAsset) {
  return withToken(a.thumb_path ? `/api/library/thumb?id=${a.id}` : `/api/library/file?id=${a.id}`)
}

export default function PhotoPicker({
  onPick,
  onClose,
  initialQuery = '',
}: {
  onPick: (imageId: string) => void
  onClose: () => void
  initialQuery?: string
}) {
  const [assets, setAssets] = useState<LibAsset[]>([])
  const [hits, setHits] = useState<LibAsset[] | null>(null)
  const [album, setAlbum] = useState('全部')
  const [query, setQuery] = useState(initialQuery)
  const [picked, setPicked] = useState<LibAsset | null>(null)
  const [busy, setBusy] = useState('')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const load = () => {
    setLoading(true)
    api('/api/library/assets?type=image&limit=500&sort=time')
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
      api(`/api/library/suggest?q=${encodeURIComponent(q)}&limit=24`)
        .then((r) => r.json())
        .then((d) => setHits(d.list || []))
        .catch(() => setHits([]))
    }, 300)
    return () => clearTimeout(t)
  }, [query])

  const albums = useMemo(() => {
    const counts = new Map<string, number>()
    for (const a of assets) {
      const name = albumOf(a.file_path)
      counts.set(name, (counts.get(name) || 0) + 1)
    }
    return [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], 'zh'))
  }, [assets])

  const shown = useMemo(() => {
    if (hits) return hits
    return album === '全部' ? assets : assets.filter((a) => albumOf(a.file_path) === album)
  }, [assets, album, hits])

  const useAsset = async (libId: string) => {
    setErr('')
    setBusy('放进图位…')
    try {
      const r = await api('/api/notes/from-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: libId }),
      }).then((x) => x.json())
      if (!r.ok || !r.imageId) throw new Error(r.error || '没放进去')
      onPick(String(r.imageId))
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
      let lastId = ''
      for (const f of Array.from(files)) {
        const r = await api(`/api/library/upload?filename=${encodeURIComponent(f.name)}`, {
          method: 'POST',
          body: f,
        }).then((x) => x.json())
        if (!r.ok || !r.asset?.id) throw new Error(r.error || '上传失败')
        lastId = String(r.asset.id)
      }
      load()
      if (lastId) await useAsset(lastId)
    } catch (e) {
      setErr(String(e))
      setBusy('')
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal note-picker" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">
          <span>从素材库放一张</span>
          <button className="linkbtn modal-x" onClick={onClose}>关闭</button>
        </div>
        <div className="note-picker-hint">搜一句话，或按文件夹挑。点一张就换到这个图位。</div>
        <input
          className="note-picker-q"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="院子晚上、餐桌俯拍…"
        />
        {err && <div className="errbar">{err}</div>}
        {busy && <div className="note-meta">{busy}</div>}
        {loading && !busy && <div className="note-meta">正在从素材库取图…</div>}

        <div className="note-picker-body">
          <div className="note-albums">
            <button
              className={album === '全部' ? 'note-album on' : 'note-album'}
              onClick={() => { setAlbum('全部'); setQuery(''); setPicked(null) }}
            >
              <span>全部</span>
              <b>{assets.length}</b>
            </button>
            {albums.map(([name, n]) => (
              <button
                key={name}
                className={album === name ? 'note-album on' : 'note-album'}
                onClick={() => { setAlbum(name); setQuery(''); setPicked(null) }}
              >
                <span>{name}</span>
                <b>{n}</b>
              </button>
            ))}
          </div>

          <div className="note-picker-main">
            <div className="note-picker-grid">
              {shown.map((a) => (
                <button
                  key={a.id}
                  className={picked?.id === a.id ? 'note-pick on' : 'note-pick'}
                  disabled={Boolean(busy)}
                  onClick={() => useAsset(a.id)}
                  title={fileName(a.file_path)}
                >
                  <img src={thumbSrc(a)} alt={fileName(a.file_path)} />
                  {a.source === 'ai' && <i className="ai-badge">AI</i>}
                </button>
              ))}
            </div>
            {!loading && shown.length === 0 && !busy && (
              <div className="note-meta">这叠还没有图。换一个文件夹，或去素材库扫描。</div>
            )}

            <div className="note-picker-preview">
              {picked ? (
                <>
                  <img src={thumbSrc(picked)} alt="" />
                  <div>
                    <b>{albumOf(picked.file_path)}</b>
                    <span>{folderHint(picked.file_path)}</span>
                  </div>
                  <button className="btn" disabled={Boolean(busy)} onClick={() => useAsset(picked.id)}>
                    放到这个图位
                  </button>
                </>
              ) : (
                <div className="note-meta">点一张就换上去。</div>
              )}
            </div>
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
