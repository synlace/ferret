export interface ProjectStats {
  requests: number
  findings: number
}

export interface ApiKey {
  id: string
  project_id: string
  name: string
  key_hash: string
  key_preview: string
  limit_usd: number | null
  created_at: string
  usage_usd: number | null
}

export interface SpendData {
  total_usd: number
  keys: Array<{
    key_hash: string
    name: string
    usage_usd: number
    limit_usd: number | null
    remaining_usd: number | null
  }>
  snapshot_at: string
}

export interface OpenRouterModel {
  id: string
  name: string
  context_length: number
  pricing?: { prompt: string; completion: string }
}

export type SortKey = "name" | "created_at" | "requests" | "findings" | "spend"
export type SortDir = "asc" | "desc"

export const PRESET_COLORS = [
  "#f97316", "#3b82f6", "#22c55e", "#ef4444",
  "#a855f7", "#eab308", "#06b6d4", "#ec4899",
]

export const DEFAULT_MODEL = "google/gemini-3-flash-preview"
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

export async function fetchStats(projectId: string): Promise<ProjectStats> {
  try {
    const [reqRes, findRes] = await Promise.all([
      fetch(`${API_BASE}/api/requests?project_id=${projectId}&limit=1`),
      fetch(`${API_BASE}/api/findings?project_id=${projectId}`),
    ])
    const requests = reqRes.ok ? parseInt(reqRes.headers.get("X-Total-Count") ?? "0", 10) : 0
    const findings = findRes.ok ? (await findRes.json()).length : 0
    return { requests, findings }
  } catch {
    return { requests: 0, findings: 0 }
  }
}

export async function fetchSpend(projectId: string): Promise<SpendData | null> {
  try {
    const res = await fetch(`${API_BASE}/api/projects/${projectId}/spend`)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

export async function fetchKeys(projectId: string): Promise<ApiKey[]> {
  try {
    const res = await fetch(`${API_BASE}/api/projects/${projectId}/keys`)
    if (!res.ok) return []
    return await res.json()
  } catch {
    return []
  }
}
