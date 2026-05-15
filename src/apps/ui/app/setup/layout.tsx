import type React from "react"

/**
 * Setup route segment layout.
 *
 * Renders children WITHOUT the AppShell sidebar so the wizard gets a clean
 * full-screen canvas.  The root layout still provides the font, global CSS,
 * and ProjectProvider — we just skip the AppShell wrapper here.
 *
 * Note: AppShell (in the root layout) detects the /setup pathname and also
 * renders children directly, so the sidebar is never shown on this route.
 */
export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
