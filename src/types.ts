export type PlatformInfo = { name: string; cookieValid: boolean | null; hasCookie: boolean; accountCount: number }

export type Status = {
  lastCollect: number | null
  collecting: boolean
  platforms: Record<string, PlatformInfo>
  lastError: string | null
  counts: {
    videos: number
    comments: number
    sessions: number
    messages: number
    pendingComments: number
    pendingSessions: number
    byPlatform: Record<string, { videos: number; comments: number }>
  }
}

export type Group = { id: number; name: string; createdAt: number }

export type Account = {
  id: number
  groupId: number
  platform: string
  platformName: string
  label: string
  nickname: string
  headImgUrl: string
  followers: number | null
  hasCookie: boolean
  cookieValid: boolean | null
  lastError: string
  state: 'online' | 'error' | 'expired' | 'none'
}

export type CommentItem = {
  platform: string
  accountId: number
  commentId: string
  exportId: string
  nickname: string
  content: string
  headUrl: string
  createTime: number
  likeCount: number
  rootCommentId: string
  isAuthor?: number
  pending?: boolean
  replies?: CommentItem[]
}

export type VideoItem = {
  platform: string
  accountId: number
  objectId: string
  title: string
  thumbUrl: string
  createTime: number
  commentCount: number
  latestCommentTs: number | null
  collectedComments: number
  pendingCount: number
}

export type SessionItem = {
  platform: string
  accountId: number
  sessionId: string
  username: string
  nickname: string
  headImgUrl: string
  sessionType: number
  lastContent: string | null
  lastTs: number | null
  lastFrom: string | null
  msgCount: number
  unread: number
  pending: boolean
}

export type MsgItem = {
  platform: string
  accountId: number
  svrMsgId: string
  sessionId: string
  fromUsername: string
  toUsername: string
  content: string
  ts: number
  msgType: number
  self?: boolean
}

export type SearchResults = {
  comments: { platform: string; accountId: number; commentId: string; exportId: string; nickname: string; content: string; createTime: number; videoTitle: string | null }[]
  sessions: { platform: string; accountId: number; sessionId: string; nickname: string; headImgUrl: string }[]
}
