import { useRef, useState } from 'react'
import { api } from '../api'
import type { Account, Group } from '../types'

export default function PublishTab({ groups, accounts }: { groups: Group[]; accounts: Account[] }) {
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
      const up = await api(`/api/upload/file?kind=video&filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        body: file,
      }).then((r) => r.json())
      if (!up.ok) throw new Error(up.error || '视频上传失败')
      let coverId = ''
      if (cover) {
        setStage('上传封面…')
        const cu = await api('/api/upload/file?kind=cover&filename=cover.jpg', {
          method: 'POST',
          body: cover,
        }).then((r) => r.json())
        if (cu.ok) coverId = cu.id
      }
      setStage('分片上传到视频号 CDN 并存草稿（多账号逐个执行，需几分钟）…')
      const dr = await api('/api/upload/draft', {
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
