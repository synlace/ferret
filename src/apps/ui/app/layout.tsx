import type React from "react"
import type { Metadata } from "next"
import { Geist_Mono as GeistMono } from "next/font/google"
import "./globals.css"
import { ProjectProvider } from "./context/project-context"
import AppShell from "@/components/app-shell"

const geistMono = GeistMono({ subsets: ["latin"] })

export const metadata: Metadata = {
  title: "FERRET by Synlace — Forensic Analysis & Request Tracker",
  description: "MITM proxy by Synlace.ai — forensic analysis and request tracking",
  generator: "v0.app",
  icons: {
    icon: "/ferret.png",
    shortcut: "/ferret.png",
    apple: "/ferret.png",
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        {/* Blocking script: reads persisted sidebar width before first paint to avoid flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var w=parseInt(localStorage.getItem('ferret:sidebarWidth')||'',10);if(!isNaN(w)&&w>=48&&w<=320)document.documentElement.style.setProperty('--sidebar-w',w+'px');}catch(e){}})();`,
          }}
        />
      </head>
      <body className={`${geistMono.className} bg-neutral-950 text-white antialiased`}>
        <ProjectProvider>
          <AppShell>{children}</AppShell>
        </ProjectProvider>
      </body>
    </html>
  )
}
