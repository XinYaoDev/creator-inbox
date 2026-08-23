import { useState } from 'react'
import { api } from '../api'
import { fmtTime } from '../utils'
import { formatWechatEmoji } from '../wechatEmoji'
import Avatar from './Avatar'
import type { CommentItem } from '../types'

function ReplyBox({
  commentId,
  platform,
  accountId,
  onSent,
}: {
  commentId: string
  platform: string
  accountId: number
  onSent: () => void
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState('')
  const send = async () => {
    if (!text.trim() || sending) return
    setSending(true)
    setErr('')
    try {
      const r = await api(`/api/comments/${encodeURIComponent(commentId)}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // accountId 必传：commentId 跨账号不保证唯一，服务端按复合键定位
        body: JSON.stringify({ content: text.trim(), platform, accountId }),
      }).then((x) => x.json())
      if (r.ok) {
        setText('')
        onSent()
      } else {
        setErr(r.error || '发送失败')
      }
    } catch (e) {
      setErr(String(e))
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="replybox">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && send()}
        placeholder="友善回复…"
        disabled={sending}
      />
      <button className="btn" onClick={send} disabled={sending || !text.trim()}>
        {sending ? '发送中…' : '发送'}
      </button>
      {err && <span className="send-err">{err}</span>}
    </div>
  )
}

export default function CommentRow({
  c,
  indent,
  onSent,
  onToggleDone,
}: {
  c: CommentItem
  indent?: boolean
  onSent: () => void
  onToggleDone: (c: CommentItem, done: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const canReply = c.platform === 'wechat' // 抖音回复暂未接入
  return (
    <div className={indent ? 'comment indent' : c.pending ? 'comment pending' : 'comment'}>
      <Avatar url={c.headUrl} name={c.nickname} />
      <div className="row-main">
        <div className="row-head">
          <span>
            <span className="nick">{c.nickname || '匿名'}</span>
            {!indent && c.pending && <b className="pending-n">待回复</b>}
          </span>
          <span className="time mono">{fmtTime(c.createTime)}</span>
        </div>
        <div className="content">{formatWechatEmoji(c.content)}</div>
        <div className="meta">
          <span className="mono">赞 {c.likeCount}</span>
          <span className="meta-actions">
            {canReply && (
              <button className="linkbtn" onClick={() => setOpen(!open)}>
                {open ? '收起' : '回复'}
              </button>
            )}
            {!indent && (
              <button className="linkbtn" onClick={() => onToggleDone(c, !c.pending)}>
                {c.pending ? '完成' : '重做'}
              </button>
            )}
          </span>
        </div>
        {open && canReply && (
          <ReplyBox commentId={c.commentId} platform={c.platform} accountId={c.accountId} onSent={onSent} />
        )}
      </div>
    </div>
  )
}
