export type LibHit = {
  id: string
  thumb_path?: string
  file_path: string
  source?: string
  ai_caption?: string
}

const RECENT_KEY = 'note_lib_recent'
const USED_KEY = 'note_lib_used'
const MAX_RECENT = 40
const MAX_USED = 200

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '')
    return raw ?? fallback
  } catch {
    return fallback
  }
}

export function readRecent(): LibHit[] {
  const rows = readJson<unknown[]>(RECENT_KEY, [])
  if (!Array.isArray(rows)) return []
  const out: LibHit[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const id = String(o.id || '').trim()
    if (!id) continue
    out.push({
      id,
      thumb_path: o.thumb_path ? String(o.thumb_path) : '',
      file_path: String(o.file_path || ''),
      source: o.source ? String(o.source) : undefined,
      ai_caption: o.ai_caption ? String(o.ai_caption) : undefined,
    })
  }
  return out
}

export function pushRecent(hit: LibHit) {
  const id = String(hit.id || '').trim()
  if (!id) return
  const next = [hit, ...readRecent().filter((x) => x.id !== id)].slice(0, MAX_RECENT)
  localStorage.setItem(RECENT_KEY, JSON.stringify(next))
}

export function readUsed(): string[] {
  const rows = readJson<unknown[]>(USED_KEY, [])
  if (!Array.isArray(rows)) return []
  return rows.map(String).filter(Boolean)
}

export function markUsed(ids: string[]) {
  const add = ids.map(String).filter(Boolean)
  if (!add.length) return
  const next = [...add, ...readUsed().filter((id) => !add.includes(id))].slice(0, MAX_USED)
  localStorage.setItem(USED_KEY, JSON.stringify(next))
}

export function usedQuery() {
  return readUsed().join(',')
}
