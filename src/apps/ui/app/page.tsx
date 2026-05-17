"use client"

import { apiFetch } from "@/lib/api-fetch"

/**
 * Root page — performs setup and auth checks before redirecting.
 *
 * Renders nothing visible while the checks run, so there is no flash of
 * content before the redirect.  The sequence is:
 *
 *   1. GET /api/setup  → if not complete, go to /setup
 *   2. GET /api/auth/me → if 401, go to /login
 *   3. Otherwise go to /history (the default landing page)
 *
 * AppShell also performs these checks, but it only runs after the page has
 * already mounted.  Doing the check here means the very first navigation
 * decision is made before any shell UI is painted.
 */

import { useEffect } from "react"
import { useRouter } from "next/navigation"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? ""

export default function RootPage() {
  const router = useRouter()

  useEffect(() => {
    const redirect = async () => {
      try {
        // 1. Check setup completion.
        const setupRes = await apiFetch(`${API_BASE}/api/setup`)
        if (setupRes.ok) {
          const data = await setupRes.json()
          if (!data.setup_complete) {
            router.replace("/setup")
            return
          }
        }

        // 2. Check authentication.
        const authRes = await apiFetch(`${API_BASE}/api/auth/me`, {
          })
        if (authRes.status === 401) {
          router.replace("/login")
          return
        }
      } catch {
        // Backend unreachable — fall through to /history and let AppShell retry.
      }

      // 3. All good — go to the default landing page.
      router.replace("/history")
    }

    redirect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Render nothing while the async check runs — no flash of content.
  return null
}
