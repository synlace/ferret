"use client"

import { useState, useCallback, useEffect } from "react"

const STORAGE_KEY = "ferret:searchHistory"
const MAX_ENTRIES = 20

function load(): string[] {
  if (typeof window === "undefined") return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

function save(entries: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // quota exceeded — silently ignore
  }
}

export function useSearchHistory() {
  const [history, setHistory] = useState<string[]>([])

  // Hydrate from localStorage on mount (avoids SSR mismatch)
  useEffect(() => {
    setHistory(load())
  }, [])

  /** Push a query into history. Deduplicates and caps at MAX_ENTRIES. */
  const push = useCallback((query: string) => {
    const trimmed = query.trim()
    if (!trimmed) return
    setHistory(prev => {
      const deduped = [trimmed, ...prev.filter(q => q !== trimmed)].slice(0, MAX_ENTRIES)
      save(deduped)
      return deduped
    })
  }, [])

  /** Remove a single entry by value. */
  const remove = useCallback((query: string) => {
    setHistory(prev => {
      const next = prev.filter(q => q !== query)
      save(next)
      return next
    })
  }, [])

  /** Clear all history. */
  const clear = useCallback(() => {
    save([])
    setHistory([])
  }, [])

  return { history, push, remove, clear }
}
