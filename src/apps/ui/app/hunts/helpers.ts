import { parseMeta } from "./tool-views"
import type { ChatMsg } from "./types"

export function formatToolArgs(toolName: string, argsJson: string): string {
  try {
    const args = JSON.parse(argsJson)
    if (toolName === "run_script" || toolName === "run_command") return args.command ?? args.script ?? argsJson
    if (toolName === "get_request_detail") return `request ${args.request_id ?? ""}`
    if (toolName === "search_requests") return args.query ?? argsJson
    if (toolName === "run_ffuf") return `ffuf ${args.url ?? ""}`
    if (toolName === "run_sqlmap") return `sqlmap ${args.url ?? ""}`
    if (toolName === "run_pytest") return args.test_file ?? argsJson
    if (toolName === "http_request") return `${args.method ?? "GET"} ${args.url ?? ""}`
    const { rationale: _r, ...rest } = args
    return Object.values(rest).slice(0, 2).join(", ") || argsJson
  } catch { return argsJson }
}

export function extractRationale(argsJson: string | undefined): string | undefined {
  if (!argsJson) return undefined
  try {
    const r = JSON.parse(argsJson).rationale
    return typeof r === "string" && r.trim() ? r.trim() : undefined
  } catch { return undefined }
}

export function annotateToolArgs(msgs: ChatMsg[]): ChatMsg[] {
  const fnMap: Record<string, { name: string; arguments: string }> = {}
  for (const m of msgs) {
    if (m.tool_calls) for (const tc of m.tool_calls) fnMap[tc.id] = tc.function
  }
  return msgs.map(msg => {
    if (msg.role === "tool" && msg.name) {
      const fn = (msg.tool_call_id && fnMap[msg.tool_call_id]) || Object.values(fnMap).find(f => f.name === msg.name)
      if (fn) {
        const { meta } = parseMeta(msg.content)
        return {
          ...msg,
          toolArgs: formatToolArgs(fn.name, fn.arguments),
          toolArgsRaw: fn.arguments,
          exitCode: meta.exit_code ?? null,
          runtimeMs: meta.runtime_ms ?? null,
          timestamp: (meta.timestamp ?? msg.timestamp) as string | undefined,
          rationale: extractRationale(fn.arguments),
        }
      }
    }
    return msg
  })
}
