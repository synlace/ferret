"use client"

import { apiFetch } from "@/lib/api-fetch"

import React, { createContext, useContext, useCallback } from "react"
import { useRouter } from "next/navigation"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

interface AuthContextValue {
  /** Call to POST /api/auth/logout and redirect to /login. */
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>({
  logout: async () => {},
})

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()

  const logout = useCallback(async () => {
    try {
      await apiFetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
      })
    } catch {
      // Ignore network errors — we still want to redirect to /login.
    }
    router.replace("/login")
  }, [router])

  return (
    <AuthContext.Provider value={{ logout }}>
      {children}
    </AuthContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAuth(): AuthContextValue {
  return useContext(AuthContext)
}
