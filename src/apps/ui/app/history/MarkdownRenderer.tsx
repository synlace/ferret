"use client"

import React, { useState } from "react"
import { Check, Copy } from "lucide-react"

// ---------------------------------------------------------------------------
// Lightweight markdown renderer (no external deps)
// ---------------------------------------------------------------------------

export function renderInline(text: string): React.ReactNode[] {
  const tokens = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g)
  return tokens.map((tok, i) => {
    if (tok.startsWith("**") && tok.endsWith("**"))
      return <strong key={i} className="font-semibold text-white">{tok.slice(2, -2)}</strong>
    if (tok.startsWith("*") && tok.endsWith("*"))
      return <em key={i} className="italic text-neutral-300">{tok.slice(1, -1)}</em>
    if (tok.startsWith("`") && tok.endsWith("`"))
      return <code key={i} className="bg-neutral-800 text-emerald-300 font-mono text-xs px-1 py-0.5 rounded">{tok.slice(1, -1)}</code>
    return tok
  })
}

export function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }
  return (
    <div className="relative my-2 group">
      <pre className="bg-neutral-950 text-green-300 font-mono text-xs p-3 rounded overflow-auto max-h-72 whitespace-pre-wrap">
        {lang && <span className="text-neutral-500 text-xs block mb-1"># {lang}</span>}
        {code}
      </pre>
      <button
        onClick={copy}
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-neutral-700 hover:bg-neutral-600 text-neutral-300 hover:text-white rounded px-1.5 py-0.5 text-xs font-mono flex items-center gap-1"
        title="Copy code"
      >
        {copied ? <><Check className="w-3 h-3" /> Copied</> : <><Copy className="w-3 h-3" /> Copy</>}
      </button>
    </div>
  )
}

export function MessageContent({ content }: { content: string }) {
  const segments = content.split(/(```[\s\S]*?```)/g)
  const nodes: React.ReactNode[] = []

  segments.forEach((seg, si) => {
    if (seg.startsWith("```")) {
      const firstNl = seg.indexOf("\n")
      const lang = firstNl > 3 ? seg.slice(3, firstNl).trim() : ""
      const code = seg.slice(firstNl + 1, -3).trimEnd()
      nodes.push(<CodeBlock key={`code-${si}`} lang={lang} code={code} />)
      return
    }

    const lines = seg.split("\n")
    let listItems: React.ReactNode[] = []

    const flushList = (key: string) => {
      if (listItems.length) {
        nodes.push(<ul key={key} className="list-disc list-inside space-y-0.5 my-1 text-sm text-neutral-200">{listItems}</ul>)
        listItems = []
      }
    }

    lines.forEach((line, li) => {
      const key = `${si}-${li}`
      const hMatch = line.match(/^(#{1,3})\s+(.+)/)
      if (hMatch) {
        flushList(`flush-${key}`)
        const level = hMatch[1].length
        const cls = level === 1
          ? "text-base font-bold text-white mt-3 mb-1"
          : level === 2
          ? "text-sm font-semibold text-white mt-2 mb-0.5"
          : "text-sm font-medium text-neutral-200 mt-1"
        nodes.push(<p key={key} className={cls}>{renderInline(hMatch[2])}</p>)
        return
      }
      const bulletMatch = line.match(/^[-*•]\s+(.+)/)
      if (bulletMatch) {
        listItems.push(<li key={key}>{renderInline(bulletMatch[1])}</li>)
        return
      }
      const numMatch = line.match(/^\d+\.\s+(.+)/)
      if (numMatch) {
        listItems.push(<li key={key}>{renderInline(numMatch[1])}</li>)
        return
      }
      if (!line.trim()) {
        flushList(`flush-${key}`)
        return
      }
      flushList(`flush-${key}`)
      nodes.push(<p key={key} className="text-sm text-neutral-200 leading-relaxed">{renderInline(line)}</p>)
    })
    flushList(`flush-end-${si}`)
  })

  return <div className="space-y-1">{nodes}</div>
}
