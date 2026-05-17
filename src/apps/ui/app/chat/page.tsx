// Redirected to /hunts — kept for backwards compat with bookmarks/links
"use client"
import { useEffect } from "react"
import { useRouter } from "next/navigation"

export default function ChatPage() {
  const router = useRouter()
  useEffect(() => { router.replace("/hunts") }, [router])
  return null
}
