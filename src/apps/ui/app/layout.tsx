import type React from "react"
import type { Metadata } from "next"
import { JetBrains_Mono as JetBrainsMono, Geist_Mono as GeistMono } from "next/font/google"
import "@xterm/xterm/css/xterm.css"
import "./globals.css"
import { ProjectProvider } from "./context/project-context"
import { AuthProvider } from "./context/auth-context"
import AppShell from "@/components/app-shell"

const jetbrainsMono = JetBrainsMono({ subsets: ["latin"], variable: "--font-jetbrains-mono" })
const geistMono = GeistMono({ subsets: ["latin"], variable: "--font-geist-mono" })

export const metadata: Metadata = {
  title: "Ferret by Synlace — A modern HTTP proxy for security testers",
  description: "A modern HTTP proxy for security testers by Synlace.ai",
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
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* Blocking script: reads persisted sidebar width before first paint to avoid flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var w=parseInt(localStorage.getItem('ferret:sidebarWidth')||'',10);if(!isNaN(w)&&w>=48&&w<=320)document.documentElement.style.setProperty('--sidebar-w',w+'px');}catch(e){}})();`,
          }}
        />
        {/* Preload provider icons so they are in the HTTP cache before the setup
            provider-selection step renders — eliminates the loading flash. */}
        <link rel="preload" as="image" href="/providers/openrouter.png" />
        <link rel="preload" as="image" href="/providers/openai.png" />
        <link rel="preload" as="image" href="/providers/claude-color.png" />
        <link rel="preload" as="image" href="/providers/gemini-color.png" />
        <link rel="preload" as="image" href="/providers/deepseek-color.png" />
        <link rel="preload" as="image" href="/providers/mistral-color.png" />
        <link rel="preload" as="image" href="/providers/ollama.png" />
        <link rel="preload" as="image" href="/providers/lmstudio.png" />
      </head>
      <body className={`${jetbrainsMono.variable} ${geistMono.variable} font-mono bg-neutral-950 text-white antialiased`}>
        <AuthProvider>
          <ProjectProvider>
            <AppShell>{children}</AppShell>
          </ProjectProvider>
        </AuthProvider>
      </body>
    </html>
  )
}
