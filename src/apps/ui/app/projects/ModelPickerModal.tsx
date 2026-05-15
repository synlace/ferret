"use client"

import React, { useState, useEffect, useRef } from "react"
import { X, Star } from "lucide-react"
import { Input } from "@/components/ui/input"
import { OpenRouterModel } from "./types"

const FERRET_FAVOURITE_MODELS_KEY = "ferret_favourite_models"

function loadFavourites(): string[] {
  try { return JSON.parse(localStorage.getItem(FERRET_FAVOURITE_MODELS_KEY) ?? "[]") } catch { return [] }
}
function saveFavourites(ids: string[]) {
  try { localStorage.setItem(FERRET_FAVOURITE_MODELS_KEY, JSON.stringify(ids)) } catch { /* ignore */ }
}

async function fetchOpenRouterModels(): Promise<OpenRouterModel[]> {
  const r = await fetch("https://openrouter.ai/api/v1/models")
  if (!r.ok) throw new Error(`OpenRouter returned ${r.status}`)
  const d: { data?: OpenRouterModel[] } = await r.json()
  return d.data ?? []
}

export function ModelPickerModal({
  currentModel,
  onSelect,
  onClose,
  getModels,
}: {
  currentModel: string
  onSelect: (id: string) => void
  onClose: () => void
  /** Optional model-fetch override. When omitted, fetches from OpenRouter. */
  getModels?: () => Promise<{ id: string; name: string }[]>
}) {
  const [models, setModels] = useState<OpenRouterModel[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [favourites, setFavourites] = useState<string[]>(() => loadFavourites())
  const modalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLoading(true)
    setFetchError(null)

    const load = getModels
      ? () => getModels().then(ms => ms.map(m => ({
          id: m.id,
          name: m.name,
          context_length: 0,
        } as OpenRouterModel)))
      : fetchOpenRouterModels

    load()
      .then(ms => setModels(ms))
      .catch(err => setFetchError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [getModels])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    const handleClick = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener("keydown", handleKey)
    document.addEventListener("mousedown", handleClick)
    return () => {
      document.removeEventListener("keydown", handleKey)
      document.removeEventListener("mousedown", handleClick)
    }
  }, [onClose])

  const toggleFav = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const next = favourites.includes(id) ? favourites.filter((x: string) => x !== id) : [...favourites, id]
    setFavourites(next); saveFavourites(next)
  }

  const filtered = models.filter((m: OpenRouterModel) =>
    !search.trim() ||
    m.id.toLowerCase().includes(search.toLowerCase()) ||
    m.name.toLowerCase().includes(search.toLowerCase())
  )
  const favModels = filtered.filter((m: OpenRouterModel) => favourites.includes(m.id))
  const grouped: Record<string, OpenRouterModel[]> = {}
  for (const m of filtered.filter((m: OpenRouterModel) => !favourites.includes(m.id))) {
    const p = m.id.split("/")[0] ?? "other"
    if (!grouped[p]) grouped[p] = []
    grouped[p].push(m)
  }

  const fmt = (price: string) => {
    const n = parseFloat(price)
    return isNaN(n) ? "—" : `$${(n * 1_000_000).toFixed(2)}/M`
  }

  const ModelRow = ({ m }: { m: OpenRouterModel }) => (
    <button
      onClick={() => { onSelect(m.id); onClose() }}
      className={`w-full text-left px-3 py-2 hover:bg-neutral-700 transition-colors flex items-center gap-2 ${currentModel === m.id ? "bg-orange-500/10" : ""}`}
    >
      <button onClick={(e: React.MouseEvent) => toggleFav(m.id, e)} className="flex-shrink-0 text-neutral-500 hover:text-yellow-400">
        <Star className="w-3.5 h-3.5" fill={favourites.includes(m.id) ? "currentColor" : "none"} color={favourites.includes(m.id) ? "#facc15" : undefined} />
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-white truncate font-medium">{m.name}</div>
        <div className="text-[10px] text-neutral-500 font-mono truncate">{m.id}</div>
      </div>
      <div className="flex-shrink-0 text-right space-y-0.5">
        {m.context_length > 0 && <div className="text-[10px] text-neutral-400">{(m.context_length / 1000).toFixed(0)}K ctx</div>}
        {m.pricing && <div className="text-[10px] text-neutral-500">{fmt(m.pricing.prompt)}</div>}
      </div>
      {currentModel === m.id && <span className="text-[10px] text-orange-400 flex-shrink-0">✓</span>}
    </button>
  )

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]">
      <div ref={modalRef} className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[600px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700">
          <h2 className="text-sm font-semibold text-white">Select Default Model</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-4 py-2 border-b border-neutral-700">
          <Input value={search} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
            placeholder="Search models…" className="bg-neutral-800 border-neutral-600 text-white text-xs h-8" autoFocus />
        </div>
        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className="px-4 py-8 text-center text-neutral-500 text-xs">Loading models…</div>
          ) : fetchError ? (
            <div className="px-4 py-8 text-center space-y-1">
              <p className="text-red-400 text-xs font-medium">Failed to load models</p>
              <p className="text-neutral-500 text-[11px]">{fetchError}</p>
            </div>
          ) : (
            <>
              {favModels.length > 0 && (
                <div>
                  <div className="px-3 py-1.5 text-[10px] text-yellow-400 font-medium uppercase tracking-wider bg-neutral-800/50">⭐ Favourites</div>
                  {favModels.map((m: OpenRouterModel) => <ModelRow key={m.id} m={m} />)}
                </div>
              )}
              {Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([provider, ms]) => (
                <div key={provider}>
                  <div className="px-3 py-1.5 text-[10px] text-neutral-500 font-medium uppercase tracking-wider bg-neutral-800/30">{provider}</div>
                  {ms.map((m: OpenRouterModel) => <ModelRow key={m.id} m={m} />)}
                </div>
              ))}
              {filtered.length === 0 && (
                <div className="px-4 py-8 text-center text-neutral-500 text-xs">No models match</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
