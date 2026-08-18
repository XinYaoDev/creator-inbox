import { useCallback, useEffect, useRef, useState } from 'react'
import { api, withToken } from '../api'
import type { Account } from '../types'

// ---------- 扫码登录弹层 ----------
export default function LoginModal({ acc, onClose, onDone }: { acc: Account; onClose: () => void; onDone: () => void }) {
  const [sessionId, setSessionId] = useState('')
  const [status, setStatus] = useState('starting') // starting|waiting|scanned|choose|done|expired|error|manual
  const [error, setError] = useState('')
  const [finderList, setFinderList] = useState<{ finderUsername: string; nickname: string; headImgUrl: string }[]>([])
  const [cookieText, setCookieText] = useState('')
  const sidRef = useRef('')

  const start = useCallback(async () => {
    setStatus('starting')
    setError('')
    const r = await api('/api/login/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: acc.id }),
    }).then((x) => x.json())
    if (r.ok) {
      setSessionId(r.sessionId)
      sidRef.current = r.sessionId
      setStatus('waiting')
    } else {
      setStatus('error')
      setError(r.error || '出码失败')
    }
  }, [acc.id])

  useEffect(() => { start() }, [start])

  // 轮询登录状态
  useEffect(() => {
    if (!sessionId || ['done', 'error', 'expired', 'manual'].includes(status)) return
    const t = setInterval(async () => {
      const r = await api(`/api/login/status?sessionId=${sessionId}`).then((x) => x.json()).catch(() => null)
      if (!r || !r.ok) return
      setStatus(r.status)
      setError(r.error || '')
      if (r.finderList) setFinderList(r.finderList)
      if (r.status === 'done') {
        onDone()
        setTimeout(onClose, 1200)
      }
    }, 2000)
    return () => clearInterval(t)
  }, [sessionId, status, onClose, onDone])

  // 关闭时取消会话
  useEffect(() => () => {
    if (sidRef.current) {
      api('/api/login/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sidRef.current }),
      })
    }
  }, [])

  const choose = async (finderUsername: string) => {
    const r = await api('/api/login/choose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, finderUsername }),
    }).then((x) => x.json())
    if (r.ok) {
      setStatus('done')
      onDone()
      setTimeout(onClose, 1200)
    } else {
      setStatus('error')
      setError(r.error || '选号失败')
    }
  }

  const saveManual = async () => {
    const cookie = cookieText.trim()
    if (!cookie) return
    const r = await api(`/api/accounts/${acc.id}/cookie`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie }),
    }).then((x) => x.json())
    if (r.ok) {
      onDone()
      onClose()
    } else setError(r.error || '保存失败')
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">
          {acc.hasCookie ? '重新登录' : '登录'} · {acc.nickname || acc.label || acc.platformName}
          <button className="linkbtn modal-x" onClick={onClose}>关闭</button>
        </div>
        {status !== 'manual' && (
          <div className="modal-qr">
            {sessionId && status !== 'starting' && status !== 'error' ? (
              <img className="qrimg" src={withToken(`/api/login/qr?sessionId=${sessionId}`)} alt="登录二维码" />
            ) : (
              <div className="qrimg qr-loading">{status === 'starting' ? '出码中…' : '出码失败'}</div>
            )}
            <div className="qr-status">
              {status === 'waiting' && '用微信扫一扫，手机上确认登录'}
              {status === 'scanned' && '已扫码，请在手机上确认…'}
              {status === 'confirmed' && '已确认，正在登录…'}
              {status === 'done' && '✓ 登录成功'}
              {status === 'expired' && '二维码已过期'}
              {status === 'error' && (error || '登录失败')}
            </div>
            {status === 'choose' && (
              <div className="qr-choose">
                <div className="pub-label">这个微信下有多个视频号，选择要登录的：</div>
                {finderList.map((f) => (
                  <button key={f.finderUsername} className="btn qr-choice" onClick={() => choose(f.finderUsername)}>
                    {f.nickname || f.finderUsername}
                  </button>
                ))}
              </div>
            )}
            {(status === 'expired' || status === 'error') && (
              <button className="btn" onClick={start}>重新出码</button>
            )}
          </div>
        )}
        {status === 'manual' && (
          <div className="acct-cookie">
            <textarea
              rows={4}
              value={cookieText}
              onChange={(e) => setCookieText(e.target.value)}
              placeholder="粘贴 Cookie 请求头整行（DevTools → Network → 任意请求 → Cookie）"
            />
            <div className="pub-actions">
              <button className="btn" onClick={saveManual} disabled={!cookieText.trim()}>保存</button>
            </div>
            {error && <div className="send-err">{error}</div>}
          </div>
        )}
        <div className="modal-foot">
          {status === 'manual' ? (
            <button className="linkbtn" onClick={() => setStatus('waiting')}>← 返回扫码登录</button>
          ) : (
            <button className="linkbtn" onClick={() => setStatus('manual')}>扫码不方便？手动粘贴 Cookie</button>
          )}
        </div>
      </div>
    </div>
  )
}
