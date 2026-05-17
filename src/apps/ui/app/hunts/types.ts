export interface WorkspaceSession {
  id: string
  name: string
  scope: string
  scope_data: Record<string, unknown> | null
  workspace_dir: string | null
  created_at: string
  target_url?: string
  plan_id?: string
  hunt_status?: string
}

export interface ChatMsg {
  role: "user" | "assistant" | "tool" | "notice"
  content: string | null
  name?: string
  toolArgs?: string
  toolArgsRaw?: string
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
  timestamp?: string
  exitCode?: number | null
  runtimeMs?: number | null
  rationale?: string
}

export interface LiveToolCall {
  name: string
  toolArgsRaw?: string
  result: string | null
  exitCode?: number | null
  runtimeMs?: number | null
  startedAt: number
  /** Imperative callback — called with each raw chunk as it arrives.
   *  Replaces the old liveChunks array to avoid O(n) array copies per chunk. */
  onLiveChunk?: (chunk: string) => void
  rationale?: string
}
