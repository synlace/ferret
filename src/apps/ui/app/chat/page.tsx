// Redirected to /workspaces — kept for backwards compat with bookmarks/links
"use client"
import { useEffect } from "react"
import { useRouter } from "next/navigation"

export default function ChatRedirect() {
  const router = useRouter()
  useEffect(() => { router.replace("/workspaces") }, [router])
  return null
}
