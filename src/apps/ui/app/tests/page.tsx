// Redirected to /workspaces — tests are now managed per-workspace
"use client"
import { useEffect } from "react"
import { useRouter } from "next/navigation"

export default function TestsRedirect() {
  const router = useRouter()
  useEffect(() => { router.replace("/workspaces") }, [router])
  return null
}
