"use client"

import React from "react"
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import ReactMarkdown from "react-markdown"
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import remarkGfm from "remark-gfm"
import { CopyButton } from "./tool-views"

interface MdProps { className?: string; children?: React.ReactNode; href?: string }

export function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      code({ className, children, ...props }: any) {
        const match = /language-(\w+)/.exec(className || "")
        if (match) {
          const text = typeof children === "string" ? children : String(children ?? "")
          return (
            <div className="relative group my-2">
              <pre className="bg-neutral-900 border border-neutral-700 p-3 overflow-x-auto whitespace-pre-wrap break-all pr-10">
                <code className={className} {...props}>{children}</code>
              </pre>
              <span className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <CopyButton text={text} />
              </span>
            </div>
          )
        }
        return <code className="bg-neutral-800 px-1 text-orange-300 text-xs" {...props}>{children}</code>
      },
      blockquote({ children }: MdProps) {
        return <blockquote className="border-l-2 border-orange-500 pl-3 my-2 text-neutral-400 italic">{children}</blockquote>
      },
      a({ href, children }: MdProps) {
        return <a href={href} target="_blank" rel="noopener noreferrer" className="text-orange-400 underline hover:text-orange-300">{children}</a>
      },
      table({ children }: MdProps) {
        return <div className="overflow-x-auto my-2"><table className="text-xs border-collapse w-full">{children}</table></div>
      },
    }}>{content}</ReactMarkdown>
  )
}
