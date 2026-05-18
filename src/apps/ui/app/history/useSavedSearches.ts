"use client"

import { useState, useCallback, useEffect } from "react"

const STORAGE_KEY = "ferret:savedSearches"
const MAX_ENTRIES = 50

export interface SavedSearch {
  name: string
  query: string
}

function load(): SavedSearch[] {
  if (typeof window === "undefined") return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as SavedSearch[]) : []
  } catch {
    return []
  }
}

function save(entries: SavedSearch[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // quota exceeded — silently ignore
  }
}

export function useSavedSearches() {
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([])

  // Hydrate from localStorage on mount (avoids SSR mismatch)
  useEffect(() => {
    setSavedSearches(load())
  }, [])

  /** Add or update a saved search by name. */
  const add = useCallback((name: string, query: string) => {
    const trimmedName = name.trim()
    const trimmedQuery = query.trim()
    if (!trimmedName || !trimmedQuery) return
    setSavedSearches(prev => {
      const deduped = [
        { name: trimmedName, query: trimmedQuery },
        ...prev.filter(s => s.name.toLowerCase() !== trimmedName.toLowerCase()),
      ].slice(0, MAX_ENTRIES)
      save(deduped)
      return deduped
    })
  }, [])

  /** Remove a saved search by name. */
  const remove = useCallback((name: string) => {
    setSavedSearches(prev => {
      const next = prev.filter(s => s.name !== name)
      save(next)
      return next
    })
  }, [])

  return { savedSearches, add, remove }
}
