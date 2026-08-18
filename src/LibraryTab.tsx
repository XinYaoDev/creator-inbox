import { useEffect, useRef, useState } from 'react'
import { api, withToken } from './api'

type FacetTag = { id: number; label: string; count: number }
type FacetNode = { name: string; tags: FacetTag[] }
type Asset = {
  id: string
  source: 'nas' | 'upload'
  file_type: 'video' | 'image'
  file_size: number
  duration: number
  width: number
  height: number
  fps: number
  orientation: string
  shoot_time: number
  original_tags: string
  thumb_path: string
  status: string
  file_path: string
  tags: string[]
}
type PickedTag = { id: number; facet: string; label: string }
type AssetDetail = Omit<Asset, 'tags'> & { tags: PickedTag[] }
type ScanStatus = {
  running: boolean
  total: number
  done: number
  errors: string[]
  startedAt: number
  finishedAt: number
}

const fmtDur = (s: number) =>
  s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`
const fmtSize = (n: number) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n >= 1024 ? `${(n / 1024).toFixed(0)}KB` : `${n}B`
const fmtDate = (s?: number | null) =>
  s ? new Date(s * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
const fmtFull = (s?: number | null) =>
  s ? new Date(s * 1000).toLocaleString('zh-CN') : '—'

export default function LibraryTab({ onBack }: { onBack: () => void }) {
  const [assets, setAssets] = useState<Asset[]>([])
  const [total, setTotal] = useState(0)
  const [facets, setFacets] = useState<FacetNode[]>([])
  const [cur, setCur] = useState<AssetDetail | null>(null)
  const [scan, setScan] = useState<ScanStatus | null>(null)
  const [type, setType] = useState('all')
  const [source, setSource] = useState('all')
  const [sort, setSort] = useState('time')
  const [q, setQ] = useState('')
  const [selTags, setSelTags] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [tagInput, setTagInput] = useState<Record<string, string>>({})
  const fileRef = useRef<HTMLInputElement>(null)

  const load = async () => {
    const params = new URLSearchParams({ limit: '300', sort })
    if (type !== 'all') params.set('type', type)
    if (source !== 'all') params.set('source', source)
    if (q.trim()) params.set('q', q.trim())
    for (const t of selTags) params.append('tag', t)
    const d = await api(`/api/library/assets?${params}`).then((r) => r.json())
    setAssets(d.list || [])
    setTotal(d.total || 0)
  }

  const loadTax = async () => {
    const d = await api('/api/library/taxonomy').then((r) => r.json())
    setFacets(d.facets || [])
  }

  // 搜索防抖
  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0)
    return () => clearTimeout(t)
  }, [type, source, sort, q, selTags])

  useEffect(() => {
    loadTax()
  }, [])

  // 扫描进度轮询
  useEffect(() => {
    let t: ReturnType<typeof setInterval> | null = null
    const poll = async () => {
      const s = await api('/api/library/scan/status').then((r) => r.json())
      setScan(s)
      if (!s.running) {
        if (t) clearInterval(t)
        load()
        loadTax()
      }
    }
    poll()
    if (scan?.running) t = setInterval(poll, 2000)
    return () => {
      if (t) clearInterval(t)
    }
  }, [scan?.running])

  const startScan = async () => {
    const r = await api('/api/library/scan', { method: 'POST' }).then((x) => x.json())
    if (r.started) {
      setToast(`开始扫描：共 ${r.total} 个，新增 ${r.new}`)
      setScan((s) => ({ ...(s || { errors: [], startedAt: 0, finishedAt: 0 }), running: true, total: r.total, done: 0 }))
      setTimeout(() => setToast(''), 4000)
    } else {
      setToast(r.msg || '扫描未启动')
      setTimeout(() => setToast(''), 4000)
    }
  }

  const openAsset = async (id: string) => {
    const d = await api(`/api/library/assets/${id}`).then((r) => r.json())
    setCur(d)
  }

  const addTag = async (facet: string, label: string) => {
    if (!cur || !label.trim()) return
    const r = await api(`/api/library/assets/${cur.id}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facet, label: label.trim() }),
    }).then((x) => x.json())
    if (r.ok) {
      openAsset(cur.id)
      load()
      loadTax()
      setTagInput((p) => ({ ...p, [facet]: '' }))
    } else {
      setToast(r.error || '打标签失败')
      setTimeout(() => setToast(''), 3000)
    }
  }

  const delTag = async (taxonomyId: number) => {
    if (!cur) return
    await api(`/api/library/assets/${cur.id}/tags/${taxonomyId}`, { method: 'DELETE' })
    openAsset(cur.id)
    load()
    loadTax()
  }

  const uploadFiles = async (files: FileList | null) => {
    if (!files || !files.length) return
    setBusy(true)
    try {
      for (const f of Array.from(files)) {
        await api(`/api/library/upload?filename=${encodeURIComponent(f.name)}`, {
          method: 'POST',
          body: f,
        })
      }
      setToast(`已上传 ${files.length} 个素材`)
      setTimeout(() => setToast(''), 3000)
      await load()
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const toggleTag = (label: string) =>
    setSelTags((prev) => (prev.includes(label) ? prev.filter((t) => t !== label) : [...prev, label]))

  return (
    <div>
      <nav className="tabs">
        <button className="tab active">
          素材库 <b className="tab-badge">{total}</b>
        </button>
        <button className="tab" onClick={onBack}>← 返回收件箱</button>
      </nav>

      <div className="libtoolbar">
        <button className="btn" onClick={startScan} disabled={scan?.running}>
          {scan?.running ? `扫描中 ${scan.done}/${scan.total}` : '↻ 扫描素材'}
        </button>
        <input
          className="searchbox"
          placeholder="搜索素材…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="all">全部类型</option>
          <option value="video">视频</option>
          <option value="image">图片</option>
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="all">全部来源</option>
          <option value="nas">NAS</option>
          <option value="upload">上传</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="time">按拍摄时间</option>
          <option value="duration">按时长</option>
          <option value="name">按文件名</option>
        </select>
        <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? '上传中…' : '+ 上传'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="video/*,image/*"
          multiple
          hidden
          onChange={(e) => uploadFiles(e.target.files)}
        />
        {toast && <span className="pub-ok">{toast}</span>}
      </div>

      {facets.some((f) => f.tags.some((t) => t.count > 0)) && (
        <div className="libtagbar">
          {facets.map((f) => (
            <span key={f.name} className="libtag-group">
              <span className="libtag-facet">{f.name}</span>
              {f.tags
                .filter((t) => t.count > 0)
                .map((t) => (
                  <button
                    key={t.id}
                    className={selTags.includes(t.label) ? 'pfilter active' : 'pfilter'}
                    onClick={() => toggleTag(t.label)}
                  >
                    {t.label}
                  </button>
                ))}
            </span>
          ))}
        </div>
      )}

      {scan?.running && (
        <div className="lib-scanbar">
          <div
            className="lib-scanfill"
            style={{ width: `${scan.total ? Math.round((scan.done / scan.total) * 100) : 0}%` }}
          />
          <span>
            扫描中 {scan.done}/{scan.total}
            {scan.errors.length ? ` · 失败 ${scan.errors.length}` : ''}
          </span>
        </div>
      )}

      <div className="liblayout">
        <div className="libgrid">
          {assets.map((a) => (
            <div
              key={a.id}
              className={`lcard ${cur?.id === a.id ? 'active' : ''}`}
              onClick={() => openAsset(a.id)}
            >
              {a.thumb_path ? (
                <img className="lthumb" src={withToken(`/api/library/thumb?id=${a.id}`)} loading="lazy" alt="" />
              ) : (
                <div className="lthumb lthumb-fallback">{a.file_type === 'video' ? '🎬' : '🖼'}</div>
              )}
              <div className="lcard-meta">
                <div className="lcard-name">{a.file_path.split('/').pop()}</div>
                <div className="lcard-sub mono">
                  {a.file_type === 'video' ? `${fmtDur(a.duration)} · ${a.orientation}` : '图片'}
                  {a.source === 'upload' ? ' · 上传' : ''}
                </div>
                {a.tags.length > 0 && (
                  <div className="lcard-tags">
                    {a.tags.slice(0, 3).map((t) => (
                      <span key={t} className="ptag">
                        {t.split(':')[1] || t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {cur && (
          <div className="libdetail">
            <div className="ld-head">
              <span className="ld-title">{cur.file_path.split('/').pop()}</span>
              <button className="linkbtn" onClick={() => setCur(null)}>✕</button>
            </div>
            {cur.file_type === 'video' ? (
              <video className="ld-video" src={withToken(`/api/library/file?id=${cur.id}`)} controls preload="metadata" />
            ) : (
              <img className="ld-video" src={withToken(`/api/library/file?id=${cur.id}`)} alt="" />
            )}
            <div className="ld-meta mono">
              <div className="ld-row">
                <span>类型</span>
                <b>{cur.file_type} · {cur.source}</b>
              </div>
              {cur.file_type === 'video' && (
                <>
                  <div className="ld-row">
                    <span>时长</span>
                    <b>{fmtDur(cur.duration)}</b>
                  </div>
                  <div className="ld-row">
                    <span>分辨率</span>
                    <b>
                      {cur.width}×{cur.height} · {cur.fps}fps · {cur.orientation}
                    </b>
                  </div>
                </>
              )}
              <div className="ld-row">
                <span>大小</span>
                <b>{fmtSize(cur.file_size)}</b>
              </div>
              <div className="ld-row">
                <span>拍摄</span>
                <b>{fmtFull(cur.shoot_time)}</b>
              </div>
              <div className="ld-row">
                <span>路径</span>
                <b className="ld-path">{cur.file_path}</b>
              </div>
              {cur.original_tags && (
                <div className="ld-row">
                  <span>线索</span>
                  <b>{cur.original_tags}</b>
                </div>
              )}
            </div>
            <div className="ld-tags">
              {facets.map((f) => {
                const picked = cur.tags.filter((t) => t.facet === f.name)
                return (
                  <div key={f.name} className="facet-row">
                    <div className="facet-name">{f.name}</div>
                    <div className="facet-tags">
                      {picked.map((t) => (
                        <span key={t.id} className="ptag facet-picked" title="点击删除" onClick={() => delTag(t.id)}>
                          {t.label} ✕
                        </span>
                      ))}
                      <input
                        className="tag-input"
                        placeholder="+ 添加"
                        value={tagInput[f.name] || ''}
                        onChange={(e) => setTagInput((p) => ({ ...p, [f.name]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') addTag(f.name, tagInput[f.name] || '')
                        }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {!assets.length && !scan?.running && (
        <div className="empty">暂无素材 —— 点「扫描素材」导入 NAS 存量，或「+ 上传」添加新素材</div>
      )}
    </div>
  )
}
