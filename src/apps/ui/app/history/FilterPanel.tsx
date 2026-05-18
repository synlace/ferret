"use client"

import React, { useRef } from "react"
import { Clock, X } from "lucide-react"
import { upsertToken, isTokenActive } from "./upsertToken"
import { type SavedSearch } from "./useSavedSearches"

interface FilterPanelProps {
  historyOpen: boolean
  filterOpen: boolean
  searchHistory: string[]
  historySuggestions: string[]
  historyIndex: number
  savedSearchSuggestions: SavedSearch[]
  searchQuery: string
  onSelectHistory: (entry: string) => void
  onRemoveHistory: (entry: string) => void
  onClearHistory: () => void
  onToggleFilter: (qualifier: string, value: string) => void
  onResetFilters: () => void
  onUpdateRawText: (updater: (q: string) => string) => void
  onAddPill: (s: SavedSearch) => void
  onRemoveSavedSearch: (name: string) => void
}

export function FilterPanel({
  historyOpen,
  filterOpen,
  searchHistory,
  historySuggestions,
  historyIndex,
  savedSearchSuggestions,
  searchQuery,
  onSelectHistory,
  onRemoveHistory,
  onClearHistory,
  onToggleFilter,
  onResetFilters,
  onUpdateRawText,
  onAddPill,
  onRemoveSavedSearch,
}: FilterPanelProps) {
  const historyPanelRef = useRef<HTMLDivElement>(null)

  const filterActive = (qualifier: string, value: string) =>
    isTokenActive(searchQuery, qualifier, value)

  const isRefActive = (example: string): boolean => {
    const stripped = example.startsWith("-") ? example.slice(1) : example
    const colonIdx = stripped.indexOf(":")
    if (colonIdx === -1) return searchQuery.includes(stripped)
    const qualifier = stripped.slice(0, colonIdx)
    const values = stripped.slice(colonIdx + 1).split(",").map(v => v.trim()).filter(Boolean)
    return values.every(v => isTokenActive(searchQuery, qualifier, v))
  }

  const handleRefClick = (example: string) => {
    const negated = example.startsWith("-")
    const stripped = negated ? example.slice(1) : example
    const colonIdx = stripped.indexOf(":")
    if (colonIdx === -1) {
      onUpdateRawText(q => {
        const term = stripped.trim()
        if (q.includes(term)) return q.replace(term, "").replace(/\s{2,}/g, " ").trim()
        return q.trim() ? `${q.trim()} ${term}` : term
      })
      return
    }
    const qualifier = stripped.slice(0, colonIdx)
    const values = stripped.slice(colonIdx + 1).split(",").map(v => v.trim()).filter(Boolean)
    onUpdateRawText(q => {
      let next = q
      for (const v of values) next = upsertToken(next, qualifier, v, negated)
      return next
    })
  }

  const renderCol = (items: [string, string][], onClick: (example: string) => void) => (
    <div className="flex flex-col gap-0.5">
      {items.map(([example, desc]) => {
        const active = isRefActive(example)
        return (
          <button
            key={example}
            onClick={() => onClick(example)}
            className="flex items-baseline gap-0 text-left group"
            title={`Toggle: ${example}`}
          >
            <span className={`font-mono text-[10px] transition-colors whitespace-nowrap w-36 shrink-0 ${active ? "text-brand-400" : "text-brand-400/50 group-hover:text-brand-400"}`}>{example}</span>
            <span className={`text-[10px] whitespace-nowrap ${active ? "text-neutral-400" : "text-neutral-600"}`}>{desc}</span>
          </button>
        )
      })}
    </div>
  )

  return (
    <div className="border-b border-neutral-800 bg-neutral-950 flex-shrink-0 overflow-y-auto" style={{ maxHeight: "45vh" }}>

      {/* ── History section ── */}
      {historyOpen && (
        <div className={filterOpen ? "border-b border-neutral-800" : ""}>
          {/* Saved searches */}
          {savedSearchSuggestions.length > 0 && (
            <div className="border-b border-neutral-800">
              <div className="flex items-center justify-between px-3 pt-2 pb-1">
                <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Saved Searches</div>
              </div>
              <div className="flex flex-wrap pb-2 px-3 gap-1.5">
                {savedSearchSuggestions.map(s => (
                  <div key={s.name} className="flex items-center gap-1 bg-brand-500/15 border border-brand-500/30 rounded px-2 py-0.5 group">
                    <button
                      className="text-[11px] font-mono text-brand-300 hover:text-white transition-colors"
                      title={s.query}
                      onClick={() => onAddPill(s)}
                    >
                      🔖 {s.name}
                    </button>
                    <button
                      className="opacity-0 group-hover:opacity-100 text-neutral-500 hover:text-red-400 transition-all ml-0.5"
                      title="Delete saved search"
                      onClick={(e) => { e.stopPropagation(); onRemoveSavedSearch(s.name) }}
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Search history */}
          <div className="flex items-center justify-between px-3 pt-2 pb-1">
            <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Search History</div>
            {searchHistory.length > 0 && (
              <button
                onClick={() => { searchHistory.forEach(e => onRemoveHistory(e)); onClearHistory() }}
                className="text-[10px] text-neutral-600 hover:text-brand-400 transition-colors"
              >
                Clear all
              </button>
            )}
          </div>
          {historySuggestions.length === 0 ? (
            <div className="px-3 pb-2.5 text-[10px] text-neutral-600 italic">No history yet — press Enter after a search to save it</div>
          ) : (
            <div ref={historyPanelRef} className="flex flex-wrap pb-2">
              {(() => {
                const ROWS = 4
                const cols: string[][] = []
                for (let i = 0; i < historySuggestions.length; i += ROWS) cols.push(historySuggestions.slice(i, i + ROWS))
                return cols.map((col, ci) => (
                  <div key={ci} className={`px-3 py-0.5 flex-shrink-0 ${ci < cols.length - 1 ? "border-r border-neutral-800" : ""}`}>
                    {col.map((entry, rowIdx) => {
                      const globalIdx = ci * ROWS + rowIdx
                      return (
                        <div
                          key={entry}
                          className={`flex items-center gap-2 py-0.5 cursor-pointer group rounded transition-colors ${globalIdx === historyIndex ? "bg-neutral-700/60" : ""}`}
                          onClick={() => onSelectHistory(entry)}
                        >
                          <Clock className="w-3 h-3 flex-shrink-0 text-neutral-600" />
                          <span className="text-[11px] font-mono text-neutral-300 group-hover:text-white transition-colors truncate max-w-[200px]">{entry}</span>
                          <button
                            className="opacity-0 group-hover:opacity-100 text-neutral-500 hover:text-white transition-all ml-auto p-0.5"
                            title="Remove"
                            onClick={(e) => { e.stopPropagation(); onRemoveHistory(entry) }}
                          >
                            <X className="w-2.5 h-2.5" />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                ))
              })()}
            </div>
          )}
        </div>
      )}

      {/* ── Filter section ── */}
      {filterOpen && (
        <div className="flex overflow-x-auto">

          {/* Method col A: GET POST PUT */}
          <div className="px-3 py-2.5 flex-shrink-0">
            <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">Method</div>
            <div className="">
              {["GET", "POST", "PUT"].map(m => (
                <button key={m} onClick={() => onToggleFilter("method", m)}
                  className={`block w-full text-left text-xs font-mono px-2 py-0.5 rounded transition-colors ${filterActive("method", m) ? "bg-brand-500/20 text-brand-400" : "text-neutral-400 hover:text-brand-400 hover:bg-neutral-800"}`}>
                  {m}
                </button>
              ))}
            </div>
          </div>

          {/* Method col B: DELETE PATCH */}
          <div className="px-3 py-2.5 flex-shrink-0 border-r border-neutral-800">
            <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2 invisible select-none">·</div>
            <div className="">
              {["DELETE", "PATCH"].map(m => (
                <button key={m} onClick={() => onToggleFilter("method", m)}
                  className={`block w-full text-left text-xs font-mono px-2 py-0.5 rounded transition-colors ${filterActive("method", m) ? "bg-brand-500/20 text-brand-400" : "text-neutral-400 hover:text-brand-400 hover:bg-neutral-800"}`}>
                  {m}
                </button>
              ))}
            </div>
          </div>

          {/* Status */}
          <div className="px-3 py-2.5 flex-shrink-0 border-r border-neutral-800">
            <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">Status</div>
            <div className="">
              {[
                { value: "2xx", label: "2xx success" },
                { value: "3xx", label: "3xx redirect" },
                { value: "4xx", label: "4xx client" },
                { value: "5xx", label: "5xx server" },
              ].map(s => (
                <button key={s.value} onClick={() => onToggleFilter("status", s.value)}
                  className={`block w-full text-left text-xs font-mono px-2 py-0.5 rounded transition-colors ${filterActive("status", s.value) ? "bg-brand-500/20 text-brand-400" : "text-neutral-400 hover:text-brand-400 hover:bg-neutral-800"}`}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* MIME col A */}
          <div className="px-3 py-2.5 flex-shrink-0">
            <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">MIME</div>
            <div className="">
              {[
                { value: "json", label: "JSON" },
                { value: "html", label: "HTML" },
                { value: "xml",  label: "XML" },
                { value: "css",  label: "CSS" },
              ].map(m => (
                <button key={m.value} onClick={() => onToggleFilter("mime", m.value)}
                  className={`block w-full text-left text-xs font-mono px-2 py-0.5 rounded transition-colors ${filterActive("mime", m.value) ? "bg-brand-500/20 text-brand-400" : "text-neutral-400 hover:text-brand-400 hover:bg-neutral-800"}`}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* MIME col B */}
          <div className="px-3 py-2.5 flex-shrink-0 border-r border-neutral-800">
            <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2 invisible select-none">·</div>
            <div className="">
              {[
                { value: "js",    label: "JS" },
                { value: "image", label: "Image" },
                { value: "plain", label: "Plain" },
              ].map(m => (
                <button key={m.value} onClick={() => onToggleFilter("mime", m.value)}
                  className={`block w-full text-left text-xs font-mono px-2 py-0.5 rounded transition-colors ${filterActive("mime", m.value) ? "bg-brand-500/20 text-brand-400" : "text-neutral-400 hover:text-brand-400 hover:bg-neutral-800"}`}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Extension col A */}
          <div className="px-3 py-2.5 flex-shrink-0">
            <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">Ext</div>
            <div className="">
              {[
                { value: "js",   label: ".js" },
                { value: "css",  label: ".css" },
                { value: "html", label: ".html" },
              ].map(e => (
                <button key={e.value} onClick={() => onToggleFilter("ext", e.value)}
                  className={`block w-full text-left text-xs font-mono px-2 py-0.5 rounded transition-colors ${filterActive("ext", e.value) ? "bg-brand-500/20 text-brand-400" : "text-neutral-400 hover:text-brand-400 hover:bg-neutral-800"}`}>
                  {e.label}
                </button>
              ))}
            </div>
          </div>

          {/* Extension col B */}
          <div className="px-3 py-2.5 flex-shrink-0">
            <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2 invisible select-none">·</div>
            <div className="">
              {[
                { value: "json", label: ".json" },
                { value: "php",  label: ".php" },
                { value: "png",  label: ".png" },
              ].map(e => (
                <button key={e.value} onClick={() => onToggleFilter("ext", e.value)}
                  className={`block w-full text-left text-xs font-mono px-2 py-0.5 rounded transition-colors ${filterActive("ext", e.value) ? "bg-brand-500/20 text-brand-400" : "text-neutral-400 hover:text-brand-400 hover:bg-neutral-800"}`}>
                  {e.label}
                </button>
              ))}
            </div>
          </div>

          {/* Extension col C */}
          <div className="px-3 py-2.5 flex-shrink-0 border-r border-neutral-800">
            <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2 invisible select-none">·</div>
            <div className="">
              {[
                { value: "jpg",  label: ".jpg" },
                { value: "svg",  label: ".svg" },
                { value: "none", label: "(none)" },
              ].map(e => (
                <button key={e.value} onClick={() => onToggleFilter("ext", e.value)}
                  className={`block w-full text-left text-xs font-mono px-2 py-0.5 rounded transition-colors ${filterActive("ext", e.value) ? "bg-brand-500/20 text-brand-400" : "text-neutral-400 hover:text-brand-400 hover:bg-neutral-800"}`}>
                  {e.label}
                </button>
              ))}
            </div>
          </div>

          {/* Source */}
          <div className="px-3 py-2.5 flex-shrink-0 border-r border-neutral-800">
            <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">Source</div>
            <div className="">
              {[
                { value: "proxy", label: "👤 Human" },
                { value: "test",  label: "🧪 Test" },
              ].map(s => (
                <button key={s.value} onClick={() => onToggleFilter("source", s.value)}
                  className={`block w-full text-left text-xs px-2 py-0.5 rounded transition-colors ${filterActive("source", s.value) ? "bg-brand-500/20 text-brand-400" : "text-neutral-400 hover:text-brand-400 hover:bg-neutral-800"}`}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Reset + Query Reference */}
          <div className="flex-1 flex flex-col px-3 py-2.5 min-w-[220px] border-l border-neutral-800">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Query Reference</div>
              <button
                onClick={onResetFilters}
                className="text-[10px] text-neutral-600 hover:text-brand-400 transition-colors"
              >
                Reset filters
              </button>
            </div>
            {(() => {
              const rows: [string, string][] = [
                ["method:GET,POST",  "HTTP method"],
                ["status:4xx,5xx",   "Status range"],
                ["host:*api*",       "Host glob"],
                ["path:/v2/*",       "Path glob"],
                ["mime:json",        "MIME type"],
                ["ext:js,css",       "File ext"],
                ["source:human",     "Traffic source"],
                ["has:annotation",   "Has AI note"],
                ["has:body",         "Has body"],
                ["size:>10kb",       "Response size"],
                ["time:>500",        "Response ms"],
                ["-ext:js,css",      "Negate with -"],
              ]
              const half = Math.ceil(rows.length / 2)
              return (
                <div className="flex gap-4">
                  {renderCol(rows.slice(0, half), handleRefClick)}
                  {renderCol(rows.slice(half), handleRefClick)}
                </div>
              )
            })()}
          </div>

        </div>
      )}

    </div>
  )
}
