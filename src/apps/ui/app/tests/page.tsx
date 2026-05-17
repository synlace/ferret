// Redirected to /hunts — tests are now managed per-hunt
"use client"
import { useEffect } from "react"
import { useRouter } from "next/navigation"

export default function TestsPage() {
  const router = useRouter()
  useEffect(() => { router.replace("/hunts") }, [router])
  return null
}
