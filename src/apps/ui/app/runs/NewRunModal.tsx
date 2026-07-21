"use client"

import { apiFetch } from "@/lib/api-fetch"
import React, { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { X, Loader2, Clipboard, Check, ChevronDown, ChevronRight } from "lucide-react"

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

interface Plan {
  id: string
  name: string
  description: string
  tool: string
  interpreter: string
  max_runtime_seconds: number
  discovers_hosts?: boolean
  discovers_paths?: boolean
  runs_on_hosts?: boolean
  runs_on_paths?: boolean
}

interface Workspace {
  id: string
  name: string
  run_count: number
  hunt_count: number
  file_counts: Record<string, number>
}

interface NewRunModalProps {
  activeProjectId: string
  onClose: () => void
  onCreated: (run: { id: string; workspace_id: string; plan_id: string; target_url: string; status: string }) => void
  /** Pre-fill workspace when opening from a workspace detail view */
  initialWorkspaceId?: string
  /** Pre-fill target URL */
  initialTargetUrl?: string
}

export function NewRunModal({
  activeProjectId,
  onClose,
  onCreated,
  initialWorkspaceId,
  initialTargetUrl = "",
}: NewRunModalProps) {
  // Input states
  const [targetUrl, setTargetUrl] = useState(initialTargetUrl)
  const [selectedPlanIds, setSelectedPlanIds] = useState<string[]>([])
  
  // Follow-on toggle / script selection states
  const [runAgainstDiscoveredHosts, setRunAgainstDiscoveredHosts] = useState(true)
  const [runAgainstDiscoveredPaths, setRunAgainstDiscoveredPaths] = useState(true)
  const [hostFollowOnIds, setHostFollowOnIds] = useState<string[]>([])
  const [pathFollowOnIds, setPathFollowOnIds] = useState<string[]>([])

  // Dens selection (multi-den sharding)
  const [dens, setDens] = useState<{ id: string; name: string }[]>([])
  const [selectedDenIds, setSelectedDenIds] = useState<string[]>(["local"])
  const [shardingStrategy, setShardingStrategy] = useState("round_robin")
  const [maxConcurrency, setMaxConcurrency] = useState(5)

  // Nmap Scan Profile
  const [nmapProfile, setNmapProfile] = useState("service_intel")

  // Auto report state
  const [autoReport, setAutoReport] = useState(true)
  const [synthesisBlueprint, setSynthesisBlueprint] = useState("web_pentest_executive_report")

  // Collapsible groups & search states
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    recon: true,
    active: true,
  })
  const [searchQuery, setSearchQuery] = useState("")

  // Fetch / Loading states
  const [plans, setPlans] = useState<Plan[]>([])
  const [plansLoading, setPlansLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [validationError, setValidationError] = useState("")
  const [copied, setCopied] = useState(false)

  // Workspace picker
  const [workspaceMode, setWorkspaceMode] = useState<"new" | "existing">(
    initialWorkspaceId ? "existing" : "new"
  )
  const [workspaceName, setWorkspaceName] = useState("")
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId ?? "")
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspacesLoading, setWorkspacesLoading] = useState(false)

  const modalRef = useRef<HTMLDivElement>(null)
  const reconRef = useRef<HTMLInputElement>(null)
  const activeRef = useRef<HTMLInputElement>(null)

  // Fetch Dens
  useEffect(() => {
    apiFetch(`${API_BASE}/api/settings/dens`)
      .then(r => r.ok ? r.json() : [])
      .then(data => {
        setDens(Array.isArray(data) ? data : [])
      })
      .catch(() => {})
  }, [])

  // Fetch script plans only
  useEffect(() => {
    if (!activeProjectId) return
    setPlansLoading(true)
    apiFetch(`${API_BASE}/api/plans?project_id=${activeProjectId}`)
      .then(r => r.ok ? r.json() : [])
      .then((data: Plan[]) => {
        if (!Array.isArray(data)) { setPlans([]); return }
        const scripts = data.filter(p => p.tool === "script")
        // discovers_hosts first, then discovers_paths, then alphabetical
        scripts.sort((a, b) => {
          const aScore = (a.discovers_hosts ? 0 : a.discovers_paths ? 1 : 2)
          const bScore = (b.discovers_hosts ? 0 : b.discovers_paths ? 1 : 2)
          if (aScore !== bScore) return aScore - bScore
          return a.name.localeCompare(b.name)
        })
        setPlans(scripts)
      })
      .catch(() => setPlans([]))
      .finally(() => setPlansLoading(false))
  }, [activeProjectId])

  // Fetch existing workspaces
  useEffect(() => {
    if (!activeProjectId) return
    setWorkspacesLoading(true)
    apiFetch(`${API_BASE}/api/workspaces?project_id=${activeProjectId}`)
      .then(r => r.ok ? r.json() : [])
      .then((data: Workspace[]) => setWorkspaces(Array.isArray(data) ? data : []))
      .catch(() => setWorkspaces([]))
      .finally(() => setWorkspacesLoading(false))
  }, [activeProjectId])

  // Esc key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  // Group plans into Recon & Discovery vs Vulnerability & Services
  const reconPlans = plans.filter(p => p.discovers_hosts || p.discovers_paths)
  const activePlans = plans.filter(p => !p.discovers_hosts && !p.discovers_paths)

  // Filter plans based on primary search query
  const filteredReconPlans = reconPlans.filter(p => 
    p.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    (p.description && p.description.toLowerCase().includes(searchQuery.toLowerCase()))
  )
  const filteredActivePlans = activePlans.filter(p => 
    p.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    (p.description && p.description.toLowerCase().includes(searchQuery.toLowerCase()))
  )

  // Sync group header checkbox indeterminate states
  useEffect(() => {
    const reconIds = reconPlans.map(p => p.id)
    const activeIds = activePlans.map(p => p.id)
    
    const checkedReconCount = reconIds.filter(id => selectedPlanIds.includes(id)).length
    const checkedActiveCount = activeIds.filter(id => selectedPlanIds.includes(id)).length
    
    if (reconRef.current) {
      reconRef.current.indeterminate = checkedReconCount > 0 && checkedReconCount < reconIds.length
    }
    if (activeRef.current) {
      activeRef.current.indeterminate = checkedActiveCount > 0 && checkedActiveCount < activeIds.length
    }
  }, [selectedPlanIds, reconPlans, activePlans])

  // Auto pre-select WhatWeb/Nuclei as default leaf scripts once discovered
  useEffect(() => {
    if (plans.length > 0 && hostFollowOnIds.length === 0) {
      const defaults = plans.filter(p => p.runs_on_hosts && (p.id.includes("whatweb") || p.id.includes("nuclei"))).map(p => p.id)
      setHostFollowOnIds(defaults)
    }
    if (plans.length > 0 && pathFollowOnIds.length === 0) {
      const defaults = plans.filter(p => p.runs_on_paths && p.id.includes("arjun")).map(p => p.id)
      setPathFollowOnIds(defaults)
    }
  }, [plans])

  // Derived: is a plan checked that discovers hosts / paths
  const discoversHostsPlanSelected = plans.some(p => selectedPlanIds.includes(p.id) && p.discovers_hosts)
  const discoversPathsPlanSelected = plans.some(p => selectedPlanIds.includes(p.id) && p.discovers_paths)

  // Plans eligible for host / path follow-on
  const hostEligible = plans.filter(p => p.runs_on_hosts)
  const pathEligible = plans.filter(p => p.runs_on_paths)

  const togglePlan = (id: string) => {
    setSelectedPlanIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
  }

  const toggleDen = (id: string) => {
    setSelectedDenIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
  }

  const toggleGroupCheck = (groupKey: "recon" | "active") => {
    const groupPlans = groupKey === "recon" ? reconPlans : activePlans
    const groupPlanIds = groupPlans.map(p => p.id)
    const allChecked = groupPlanIds.length > 0 && groupPlanIds.every(id => selectedPlanIds.includes(id))

    if (allChecked) {
      setSelectedPlanIds(prev => prev.filter(id => !groupPlanIds.includes(id)))
    } else {
      setSelectedPlanIds(prev => {
        const otherIds = prev.filter(id => !groupPlanIds.includes(id))
        return [...otherIds, ...groupPlanIds]
      })
    }
  }

  // Live Clipboard Copy
  const copyToClipboard = () => {
    const rawYaml = generateYamlText()
    navigator.clipboard.writeText(rawYaml).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  // Declarative RunSpec Builder (String output)
  const generateYamlText = () => {
    const target = targetUrl.trim() || "https://example.com"
    let yamlStr = `# Declarative Ferret RunSpec Definition\n`
    yamlStr += `target_url: ${target}\n`

    if (workspaceMode === "existing" && workspaceId) {
      yamlStr += `workspace_id: ${workspaceId}\n`
    } else if (workspaceName.trim()) {
      yamlStr += `workspace_name: ${workspaceName.trim()}\n`
    }

    if (selectedDenIds.length === 1) {
      yamlStr += `runner_den: ${selectedDenIds[0]}\n\n`
    } else if (selectedDenIds.length > 1) {
      yamlStr += `runner_den: multi\n\n`
      yamlStr += `target_sharding:\n`
      yamlStr += `  strategy: ${shardingStrategy}\n`
      yamlStr += `  dens:\n`
      selectedDenIds.forEach(d => {
        yamlStr += `    - ${d}\n`
      })
      yamlStr += `  max_concurrency_per_den: ${maxConcurrency}\n\n`
    } else {
      yamlStr += `runner_den: local\n\n`
    }

    yamlStr += `pipeline:\n`

    // Subdomain step (if selected)
    const subdomainPlan = plans.find(p => selectedPlanIds.includes(p.id) && p.id.includes("subdomain"))
    if (subdomainPlan) {
      yamlStr += `  - step: subdomain_enumeration\n`
      yamlStr += `    plan: ${subdomainPlan.id}\n`
      if (runAgainstDiscoveredHosts && hostFollowOnIds.length > 0) {
        yamlStr += `    leaf_scripts:\n`
        hostFollowOnIds.forEach(id => {
          yamlStr += `      - ${id}\n`
        })
      }
    }

    // Nmap Port Scanning (if selected)
    const nmapPlan = plans.find(p => selectedPlanIds.includes(p.id) && p.id.includes("nmap"))
    if (nmapPlan) {
      yamlStr += `  - step: port_scanning\n`
      yamlStr += `    plan: ${nmapPlan.id}\n`
      yamlStr += `    params:\n`
      yamlStr += `      profile: ${nmapProfile}\n`
    }

    // WhatWeb (if selected)
    const whatwebPlan = plans.find(p => selectedPlanIds.includes(p.id) && p.id.includes("whatweb"))
    if (whatwebPlan) {
      yamlStr += `  - step: technology_fingerprint\n`
      yamlStr += `    plan: ${whatwebPlan.id}\n`
    }

    // Katana (if selected)
    const katanaPlan = plans.find(p => selectedPlanIds.includes(p.id) && p.id.includes("katana"))
    if (katanaPlan) {
      yamlStr += `  - step: spider_endpoints\n`
      yamlStr += `    plan: ${katanaPlan.id}\n`
      if (runAgainstDiscoveredPaths && pathFollowOnIds.length > 0) {
        yamlStr += `    leaf_scripts:\n`
        pathFollowOnIds.forEach(id => {
          yamlStr += `      - ${id}\n`
        })
      }
    }

    // Nuclei (if selected)
    const nucleiPlan = plans.find(p => selectedPlanIds.includes(p.id) && p.id.includes("nuclei"))
    if (nucleiPlan) {
      yamlStr += `  - step: vulnerability_scan\n`
      yamlStr += `    plan: ${nucleiPlan.id}\n`
    }

    // Custom steps
    const standardPlanStems = ["subdomain", "nmap", "whatweb", "katana", "nuclei"]
    const customSelectedPlans = plans.filter(p => 
      selectedPlanIds.includes(p.id) && 
      !standardPlanStems.some(stem => p.id.toLowerCase().includes(stem))
    )
    customSelectedPlans.forEach(p => {
      yamlStr += `  - step: custom_step_${p.id.replace("builtin:", "")}\n`
      yamlStr += `    plan: ${p.id}\n`
    })

    if (autoReport) {
      yamlStr += `\nsynthesis:\n`
      yamlStr += `  trigger_on_completion: true\n`
      yamlStr += `  blueprint: ${synthesisBlueprint}.yaml\n`
      yamlStr += `  write_directory: reports/\n`
    }

    return yamlStr
  }

  // Live HTML generation for syntax coloring
  const generateYamlHtml = () => {
    const target = targetUrl.trim() || "https://example.com"
    let html = `<span class="text-neutral-500"># Declarative Ferret RunSpec Definition</span>\n`
    html += `<span class="text-orange-400">target_url</span>: <span class="text-green-400">${target}</span>\n`

    if (workspaceMode === "existing" && workspaceId) {
      html += `<span class="text-orange-400">workspace_id</span>: <span class="text-green-400">${workspaceId}</span>\n`
    } else if (workspaceName.trim()) {
      html += `<span class="text-orange-400">workspace_name</span>: <span class="text-green-400">${workspaceName.trim()}</span>\n`
    }

    if (selectedDenIds.length === 1) {
      html += `<span class="text-orange-400">runner_den</span>: <span class="text-green-400">${selectedDenIds[0]}</span>\n\n`
    } else if (selectedDenIds.length > 1) {
      html += `<span class="text-orange-400">runner_den</span>: <span class="text-green-400">multi</span>\n\n`
      html += `<span class="text-orange-400">target_sharding</span>:\n`
      html += `  <span class="text-orange-400">strategy</span>: <span class="text-green-400">${shardingStrategy}</span>\n`
      html += `  <span class="text-orange-400">dens</span>:\n`
      selectedDenIds.forEach(d => {
        html += `    <span class="text-sky-400">-</span> <span class="text-green-400">${d}</span>\n`
      })
      html += `  <span class="text-orange-400">max_concurrency_per_den</span>: <span class="text-green-400">${maxConcurrency}</span>\n\n`
    } else {
      html += `<span class="text-orange-400">runner_den</span>: <span class="text-green-400">local</span>\n\n`
    }

    html += `<span class="text-orange-400">pipeline</span>:\n`

    // Step 1: subdomain_enumeration
    const subdomainPlan = plans.find(p => selectedPlanIds.includes(p.id) && p.id.includes("subdomain"))
    if (subdomainPlan) {
      html += `  <span class="text-sky-400">-</span> <span class="text-orange-400">step</span>: <span class="text-green-400">subdomain_enumeration</span>\n`
      html += `    <span class="text-orange-400">plan</span>: <span class="text-green-400">${subdomainPlan.id}</span>\n`
      if (runAgainstDiscoveredHosts && hostFollowOnIds.length > 0) {
        html += `    <span class="text-orange-400">leaf_scripts</span>:\n`
        hostFollowOnIds.forEach(id => {
          html += `      <span class="text-sky-400">-</span> <span class="text-green-400">${id}</span>\n`
        })
      }
    }

    // Step 2: port_scanning
    const nmapPlan = plans.find(p => selectedPlanIds.includes(p.id) && p.id.includes("nmap"))
    if (nmapPlan) {
      html += `  <span class="text-sky-400">-</span> <span class="text-orange-400">step</span>: <span class="text-green-400">port_scanning</span>\n`
      html += `    <span class="text-orange-400">plan</span>: <span class="text-green-400">${nmapPlan.id}</span>\n`
      html += `    <span class="text-orange-400">params</span>:\n`
      html += `      <span class="text-orange-400">profile</span>: <span class="text-green-400">${nmapProfile}</span>\n`
    }

    // Step 3: technology_fingerprint
    const whatwebPlan = plans.find(p => selectedPlanIds.includes(p.id) && p.id.includes("whatweb"))
    if (whatwebPlan) {
      html += `  <span class="text-sky-400">-</span> <span class="text-orange-400">step</span>: <span class="text-green-400">technology_fingerprint</span>\n`
      html += `    <span class="text-orange-400">plan</span>: <span class="text-green-400">${whatwebPlan.id}</span>\n`
    }

    // Step 4: spider_endpoints
    const katanaPlan = plans.find(p => selectedPlanIds.includes(p.id) && p.id.includes("katana"))
    if (katanaPlan) {
      html += `  <span class="text-sky-400">-</span> <span class="text-orange-400">step</span>: <span class="text-green-400">spider_endpoints</span>\n`
      html += `    <span class="text-orange-400">plan</span>: <span class="text-green-400">${katanaPlan.id}</span>\n`
      if (runAgainstDiscoveredPaths && pathFollowOnIds.length > 0) {
        html += `    <span class="text-orange-400">leaf_scripts</span>:\n`
        pathFollowOnIds.forEach(id => {
          html += `      <span class="text-sky-400">-</span> <span class="text-green-400">${id}</span>\n`
        })
      }
    }

    // Step 5: vulnerability_scan
    const nucleiPlan = plans.find(p => selectedPlanIds.includes(p.id) && p.id.includes("nuclei"))
    if (nucleiPlan) {
      html += `  <span class="text-sky-400">-</span> <span class="text-orange-400">step</span>: <span class="text-green-400">vulnerability_scan</span>\n`
      html += `    <span class="text-orange-400">plan</span>: <span class="text-green-400">${nucleiPlan.id}</span>\n`
    }

    // Custom steps
    const standardPlanStems = ["subdomain", "nmap", "whatweb", "katana", "nuclei"]
    const customSelectedPlans = plans.filter(p => 
      selectedPlanIds.includes(p.id) && 
      !standardPlanStems.some(stem => p.id.toLowerCase().includes(stem))
    )
    customSelectedPlans.forEach(p => {
      html += `  <span class="text-sky-400">-</span> <span class="text-orange-400">step</span>: <span class="text-green-400">custom_step_${p.id.replace("builtin:", "")}</span>\n`
      html += `    <span class="text-orange-400">plan</span>: <span class="text-green-400">${p.id}</span>\n`
    })

    if (autoReport) {
      html += `\n<span class="text-neutral-500"># Downstream RunSpec Synthesis upon scan completion</span>\n`
      html += `<span class="text-orange-400">synthesis</span>:\n`
      html += `  <span class="text-orange-400">trigger_on_completion</span>: <span class="text-green-400">true</span>\n`
      html += `  <span class="text-orange-400">blueprint</span>: <span class="text-green-400">${synthesisBlueprint}.yaml</span>\n`
      html += `  <span class="text-orange-400">write_directory</span>: <span class="text-green-400">reports/</span>\n`
    }

    return html
  }

  // Create Run / Submit Action
  const handleCreate = async () => {
    setValidationError("")
    if (selectedPlanIds.length === 0) {
      setValidationError("Select at least one script to run.")
      return
    }
    if (!targetUrl.trim()) {
      setValidationError("Target URL / Domain is required.")
      return
    }
    if (workspaceMode === "existing" && !workspaceId) {
      setValidationError("Please select an existing workspace.")
      return
    }
    if (selectedDenIds.length === 0) {
      setValidationError("Please select at least one execution Den.")
      return
    }
    setCreating(true)

    // Build the raw YAML payload string matching RunSpecSchema
    const yamlPayloadText = generateYamlText()

    try {
      const res = await apiFetch(`${API_BASE}/api/runs?project_id=${activeProjectId}`, {
        method: "POST",
        headers: { "Content-Type": "text/yaml" },
        body: yamlPayloadText,
      })
      if (res.ok) {
        const run = await res.json()
        onCreated(run)
      } else {
        const d = await res.json().catch(() => ({}))
        setValidationError(d.detail ?? "Failed to create run pipeline")
      }
    } catch {
      setValidationError("Network communication error")
    } finally {
      setCreating(false)
    }
  }

  const totalFiles = (ws: Workspace) =>
    Object.values(ws.file_counts).reduce((a, b) => a + b, 0)

  const activeCount = selectedPlanIds.length

  return (
    <div className="fixed inset-0 bg-neutral-900 z-50 flex flex-col h-screen w-screen" data-modal ref={modalRef}>
      {/* HEADER */}
      <header className="bg-neutral-950 border-b border-neutral-800/80 px-6 py-2 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-brand-500 font-bold text-base">⚡</span>
          <h2 className="text-xs font-semibold text-neutral-100 uppercase tracking-wider">New Run Pipeline</h2>
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6 text-neutral-400 hover:text-white" onClick={onClose}>
          <X className="w-3.5 h-3.5" />
        </Button>
      </header>

      {/* 3-COLUMN BODY GRID */}
      <div className="grid grid-cols-3 gap-6 p-6 bg-neutral-900 flex-1 overflow-hidden min-h-0">
        
        {/* COLUMN 1: SCOPE & PRIMARY SCRIPTS */}
        <div className="flex flex-col gap-4 min-w-0 h-full overflow-y-auto pr-4 border-r border-neutral-800/80">
          {/* Target URL */}
          <div className="flex flex-col gap-1.5 flex-shrink-0">
            <label className="text-[11px] font-bold text-neutral-400 uppercase tracking-wider">Target URL / Domain</label>
            <Input
              value={targetUrl}
              onChange={e => setTargetUrl(e.target.value)}
              placeholder="*.example.com"
              className="bg-neutral-950 border-neutral-800 text-white text-xs placeholder:text-neutral-700 h-9 font-mono focus:border-brand-500"
            />
          </div>

          {/* Workspace Selection */}
          <div className="flex flex-col gap-1.5 flex-shrink-0">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-neutral-400 uppercase tracking-wider">Workspace</span>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1 cursor-pointer select-none">
                  <input
                    type="radio"
                    name="runWorkspaceMode"
                    value="new"
                    checked={workspaceMode === "new"}
                    onChange={() => setWorkspaceMode("new")}
                    className="accent-brand-500"
                  />
                  <span className="text-[11px] text-neutral-300">New</span>
                </label>
                <label className="flex items-center gap-1 cursor-pointer select-none">
                  <input
                    type="radio"
                    name="runWorkspaceMode"
                    value="existing"
                    checked={workspaceMode === "existing"}
                    onChange={() => setWorkspaceMode("existing")}
                    className="accent-brand-500"
                    disabled={workspaces.length === 0}
                  />
                  <span className={`text-[11px] ${workspaces.length === 0 ? "text-neutral-600" : "text-neutral-300"}`}>
                    Existing ({workspaces.length})
                  </span>
                </label>
              </div>
            </div>

            {workspaceMode === "new" ? (
              <Input
                value={workspaceName}
                onChange={e => setWorkspaceName(e.target.value)}
                placeholder="Name (defaults to target)"
                className="bg-neutral-950 border-neutral-800 text-white text-xs placeholder:text-neutral-700 h-9 focus:border-brand-500"
              />
            ) : (
              <select
                value={workspaceId}
                onChange={e => setWorkspaceId(e.target.value)}
                disabled={workspacesLoading}
                className="w-full bg-neutral-950 border border-neutral-800 rounded text-xs text-white px-2 py-2 focus:outline-none focus:border-brand-500 disabled:opacity-50 h-9"
              >
                <option value="">Select workspace…</option>
                {workspaces.map(ws => (
                  <option key={ws.id} value={ws.id}>
                    {ws.name} ({totalFiles(ws)} files, {ws.run_count} runs)
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Target Execution Dens */}
          <div className="flex flex-col gap-1.5 flex-shrink-0">
            <label className="text-[11px] font-bold text-neutral-400 uppercase tracking-wider">Target Execution Dens</label>
            <span className="text-[10px] text-neutral-500 leading-normal">
              Select one or more Dens to distribute workloads. Selecting multiple enables multi-den sharding automatically.
            </span>
            <div className="bg-neutral-950 border border-neutral-800/80 rounded p-2.5 flex flex-col gap-2">
              <label className="flex items-center gap-2 text-xs text-neutral-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={selectedDenIds.includes("local")}
                  onChange={() => toggleDen("local")}
                  className="accent-brand-500"
                />
                <span>local (Default Docker Sandbox)</span>
              </label>
              {dens.filter(d => d.id !== "local").map(d => (
                <label key={d.id} className="flex items-center gap-2 text-xs text-neutral-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={selectedDenIds.includes(d.id)}
                    onChange={() => toggleDen(d.id)}
                    className="accent-brand-500"
                  />
                  <span>{d.name} (AWS)</span>
                </label>
              ))}
            </div>
          </div>

          {/* Multi-Den Sharding sub-panel */}
          {selectedDenIds.length > 1 && (
            <div className="border border-brand-500/15 bg-brand-500/[0.02] rounded p-3 flex flex-col gap-3 flex-shrink-0">
              <div className="flex flex-col gap-1">
                <label className="text-[9px] font-bold text-brand-400 uppercase tracking-wider">Sharding Strategy</label>
                <select
                  value={shardingStrategy}
                  onChange={e => setShardingStrategy(e.target.value)}
                  className="w-full bg-neutral-900 border border-neutral-800 rounded text-xs text-white px-2 py-1.5 focus:outline-none focus:border-brand-500"
                >
                  <option value="round_robin">Round Robin (Split targets evenly)</option>
                  <option value="geo_proximity">Geo-Proximity (Route by target location)</option>
                  <option value="failover">Failover / Fallback (Ordered backup dens)</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] font-bold text-brand-400 uppercase tracking-wider">Max Concurrency Per Den</label>
                <Input
                  type="number"
                  value={maxConcurrency}
                  onChange={e => setMaxConcurrency(Math.max(1, parseInt(e.target.value) || 1))}
                  className="bg-neutral-900 border-neutral-800 text-white text-xs h-8 focus:border-brand-500"
                />
              </div>
            </div>
          )}

          {/* Primary Scripts Checklist */}
          <div className="flex flex-col gap-1.5 mt-1 flex-1">
            <label className="text-[11px] font-bold text-neutral-400 uppercase tracking-wider">Primary Scripts to Execute</label>
            <Input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="🔍 Filter primary scripts..."
              className="bg-neutral-950 border-neutral-800 text-white text-xs h-8 focus:border-brand-500"
            />

            <div className="flex flex-col gap-2.5 mt-1.5">
              {/* Recon & Discovery group */}
              {filteredReconPlans.length > 0 && (
                <div className="flex flex-col">
                  <div className="flex items-center justify-between bg-neutral-950 border border-neutral-800 rounded px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <button
                        onClick={() => setExpandedGroups(prev => ({ ...prev, recon: !prev.recon }))}
                        className="text-neutral-400 hover:text-white transition-colors"
                      >
                        {expandedGroups.recon ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      </button>
                      <input
                        ref={reconRef}
                        type="checkbox"
                        checked={reconPlans.every(p => selectedPlanIds.includes(p.id))}
                        onChange={() => toggleGroupCheck("recon")}
                        className="accent-brand-500 h-3.5 w-3.5 cursor-pointer"
                      />
                      <span className="text-[11.5px] font-semibold text-neutral-200 truncate">Recon & Discovery</span>
                    </div>
                    <span className="text-[9px] bg-sky-500/10 text-sky-400 border border-sky-500/20 rounded px-1.5 py-0.5 font-mono">
                      {reconPlans.filter(p => selectedPlanIds.includes(p.id)).length}/{reconPlans.length} checked
                    </span>
                  </div>

                  {expandedGroups.recon && (
                    <div className="flex flex-col mt-1.5 gap-1.5">
                      {filteredReconPlans.map(p => {
                        const isChecked = selectedPlanIds.includes(p.id)
                        return (
                          <label
                            key={p.id}
                            className="flex items-start gap-2.5 bg-neutral-950 border border-neutral-800/40 rounded p-2.5 cursor-pointer hover:bg-neutral-800/30 select-none transition-colors"
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => togglePlan(p.id)}
                              className="accent-brand-500 h-3.5 w-3.5 mt-0.5"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-[11px] font-medium text-neutral-200">{p.name}</span>
                                {p.discovers_hosts && (
                                  <span className="text-[8.5px] font-mono text-brand-500 bg-brand-500/10 border border-brand-500/20 px-1 py-px rounded whitespace-nowrap">discovers hosts</span>
                                )}
                                {p.discovers_paths && (
                                  <span className="text-[8.5px] font-mono text-sky-400 bg-sky-500/10 border border-sky-500/20 px-1 py-px rounded whitespace-nowrap">discovers paths</span>
                                )}
                              </div>
                              {p.description && (
                                <span className="text-[10px] text-neutral-500 mt-0.5 block leading-normal line-clamp-2">{p.description}</span>
                              )}
                            </div>
                          </label>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Vulnerability & Services group */}
              {filteredActivePlans.length > 0 && (
                <div className="flex flex-col">
                  <div className="flex items-center justify-between bg-neutral-950 border border-neutral-800 rounded px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <button
                        onClick={() => setExpandedGroups(prev => ({ ...prev, active: !prev.active }))}
                        className="text-neutral-400 hover:text-white transition-colors"
                      >
                        {expandedGroups.active ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      </button>
                      <input
                        ref={activeRef}
                        type="checkbox"
                        checked={activePlans.every(p => selectedPlanIds.includes(p.id))}
                        onChange={() => toggleGroupCheck("active")}
                        className="accent-brand-500 h-3.5 w-3.5 cursor-pointer"
                      />
                      <span className="text-[11.5px] font-semibold text-neutral-200 truncate">Vulnerability & Services</span>
                    </div>
                    <span className="text-[9px] bg-brand-500/10 text-brand-400 border border-brand-500/20 rounded px-1.5 py-0.5 font-mono">
                      {activePlans.filter(p => selectedPlanIds.includes(p.id)).length}/{activePlans.length} checked
                    </span>
                  </div>

                  {expandedGroups.active && (
                    <div className="flex flex-col mt-1.5 gap-1.5">
                      {filteredActivePlans.map(p => {
                        const isChecked = selectedPlanIds.includes(p.id)
                        const isNmap = p.id.toLowerCase().includes("nmap")
                        return (
                          <div
                            key={p.id}
                            className="flex flex-col bg-neutral-950 border border-neutral-800/40 rounded hover:bg-neutral-800/30 transition-colors"
                          >
                            <label className="flex items-start gap-2.5 p-2.5 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => togglePlan(p.id)}
                                className="accent-brand-500 h-3.5 w-3.5 mt-0.5"
                              />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="text-[11px] font-medium text-neutral-200">{p.name}</span>
                                  {isNmap && (
                                    <span className="text-[8.5px] font-mono text-brand-500 bg-brand-500/10 border border-brand-500/20 px-1 py-px rounded whitespace-nowrap">discovers services</span>
                                  )}
                                </div>
                                {p.description && (
                                  <span className="text-[10px] text-neutral-500 mt-0.5 block leading-normal line-clamp-2">{p.description}</span>
                                )}
                              </div>
                            </label>

                            {/* Nmap Inline Profile Sub-Panel */}
                            {isNmap && isChecked && (
                              <div className="mx-2.5 mb-2.5 border-t border-neutral-800/80 pt-2 flex flex-col gap-1">
                                <label className="text-[9px] font-bold text-brand-400 uppercase tracking-wider">Scan Profile / Intensity</label>
                                <select
                                  value={nmapProfile}
                                  onChange={e => setNmapProfile(e.target.value)}
                                  className="w-full bg-neutral-900 border border-neutral-800 rounded text-[11px] text-white px-2 py-1 focus:outline-none focus:border-brand-500"
                                >
                                  <option value="service_intel">Service Discovery (-sV -sC) (Recommended)</option>
                                  <option value="fast">Fast Scan (-F)</option>
                                  <option value="full">Full Port Scan (-p-)</option>
                                </select>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* COLUMN 2: LEAF/FOLLOW-ON SCRIPTS & REPORTS */}
        <div className="flex flex-col gap-4 min-w-0 h-full overflow-y-auto pr-4 border-r border-neutral-800/80">
          {/* Host Discovery Leaf Section */}
          {discoversHostsPlanSelected && (
            <div className="border border-neutral-800 rounded p-3 bg-neutral-950 flex flex-col gap-2.5 flex-shrink-0">
              <label className="flex items-start gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={runAgainstDiscoveredHosts}
                  onChange={e => setRunAgainstDiscoveredHosts(e.target.checked)}
                  className="accent-brand-500 h-3.5 w-3.5 mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-semibold text-neutral-100 block">Run Leaf Scripts against Discovered Hosts</span>
                  <span className="text-[10px] text-neutral-500 leading-normal block mt-0.5">
                    Automatically execute target security tests on each distinct hostname resolved by the subdomain enumeration step.
                  </span>
                </div>
              </label>

              {runAgainstDiscoveredHosts && hostEligible.length > 0 && (
                <div className="flex flex-col gap-1.5 border-t border-neutral-800/60 pt-2">
                  {hostEligible.map(p => (
                    <label key={p.id} className="flex items-start gap-2 bg-neutral-900 border border-neutral-800/40 rounded p-2.5 cursor-pointer hover:bg-neutral-800/40 select-none">
                      <input
                        type="checkbox"
                        checked={hostFollowOnIds.includes(p.id)}
                        onChange={() => setHostFollowOnIds(prev => prev.includes(p.id) ? prev.filter(id => id !== p.id) : [...prev, p.id])}
                        className="accent-brand-500 h-3.5 w-3.5 mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-[11px] font-medium text-neutral-200 block">{p.name}</span>
                        {p.description && (
                          <span className="text-[9.5px] text-neutral-500 block leading-normal line-clamp-1">{p.description}</span>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Path Discovery Leaf Section */}
          {discoversPathsPlanSelected && (
            <div className="border border-neutral-800 rounded p-3 bg-neutral-950 flex flex-col gap-2.5 flex-shrink-0">
              <label className="flex items-start gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={runAgainstDiscoveredPaths}
                  onChange={e => setRunAgainstDiscoveredPaths(e.target.checked)}
                  className="accent-brand-500 h-3.5 w-3.5 mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-semibold text-neutral-100 block">Run Leaf Scripts against Discovered Paths</span>
                  <span className="text-[10px] text-neutral-500 leading-normal block mt-0.5">
                    Automatically audit and inspect each crawled endpoint path dynamically discovered by the web spider.
                  </span>
                </div>
              </label>

              {runAgainstDiscoveredPaths && pathEligible.length > 0 && (
                <div className="flex flex-col gap-1.5 border-t border-neutral-800/60 pt-2">
                  {pathEligible.map(p => (
                    <label key={p.id} className="flex items-start gap-2 bg-neutral-900 border border-neutral-800/40 rounded p-2.5 cursor-pointer hover:bg-neutral-800/40 select-none">
                      <input
                        type="checkbox"
                        checked={pathFollowOnIds.includes(p.id)}
                        onChange={() => setPathFollowOnIds(prev => prev.includes(p.id) ? prev.filter(id => id !== p.id) : [...prev, p.id])}
                        className="accent-brand-500 h-3.5 w-3.5 mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-[11px] font-medium text-neutral-200 block">{p.name}</span>
                        {p.description && (
                          <span className="text-[9.5px] text-neutral-500 block leading-normal line-clamp-1">{p.description}</span>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Auto Report Section */}
          <div className={`border border-neutral-800 rounded p-3 transition-colors flex-shrink-0 ${autoReport ? "border-brand-500/20 bg-brand-500/[0.01]" : "bg-neutral-950"}`}>
            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoReport}
                onChange={e => setAutoReport(e.target.checked)}
                className="accent-brand-500 h-3.5 w-3.5 mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <span className="text-xs font-semibold text-neutral-100 block">Auto-Generate Executive Report</span>
                <span className="text-[10px] text-neutral-500 leading-normal block mt-0.5">
                  Trigger the LLM synthesis engine upon successful completion to compile and write a report document straight to the workspace.
                </span>
              </div>
            </label>

            {autoReport && (
              <div className="flex flex-col gap-3 border-t border-neutral-800/60 pt-3 mt-3">
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[9px] font-bold text-brand-400 uppercase tracking-wider">Synthesis Blueprint</label>
                    <select
                      value={synthesisBlueprint}
                      onChange={e => setSynthesisBlueprint(e.target.value)}
                      className="w-full bg-neutral-900 border border-neutral-800 rounded text-xs text-white px-2 py-1.5 focus:outline-none focus:border-brand-500"
                    >
                      <option value="web_pentest_executive_report">Web Pentest Executive Report (Ingests Subdomains, Nmap, WhatWeb)</option>
                      <option value="pci_dss_compliance">PCI-DSS v4.0 Compliance Checklist (Checks SSL/TLS configurations)</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[9px] font-bold text-brand-400 uppercase tracking-wider">Output Location</label>
                    <div className="bg-brand-500/10 border border-brand-500/20 text-brand-500 font-mono text-[10px] px-2.5 py-1.5 rounded flex items-center gap-1.5 self-start">
                      📂 reports/{synthesisBlueprint}.md
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* COLUMN 3: LIVE RUNSPEC PREVIEW */}
        <div className="flex flex-col min-w-0 h-full overflow-hidden">
          <div className="bg-[#070707] border border-neutral-800 rounded-lg flex flex-col h-full overflow-hidden">
            <div className="bg-neutral-950 border-b border-neutral-800/80 px-4 py-2.5 flex items-center justify-between flex-shrink-0">
              <span className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">Live Pipeline View: runspec.yaml</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={copyToClipboard}
                  className="bg-transparent text-brand-500 border border-brand-500/20 font-mono text-[9px] font-medium px-2 py-0.5 rounded flex items-center gap-1 hover:bg-brand-500/10 transition-colors"
                  title="Copy RunSpec to clipboard"
                >
                  {copied ? <Check className="w-2.5 h-2.5 text-green-400" /> : <Clipboard className="w-2.5 h-2.5" />}
                  {copied ? "Copied" : "Copy"}
                </button>
                <span className="text-[9px] text-brand-500 border border-brand-500/10 bg-brand-500/5 px-1.5 py-0.5 rounded uppercase font-bold tracking-wider leading-none">Declarative DAG</span>
              </div>
            </div>
            <div 
              className="flex-1 p-4 font-mono text-[11px] leading-relaxed text-neutral-200 overflow-y-auto whitespace-pre select-text"
              dangerouslySetInnerHTML={{ __html: generateYamlHtml() }}
            />
          </div>
        </div>

      </div>

      {/* VALIDATION ERROR */}
      {validationError && (
        <div className="mx-6 mb-1 text-xs text-red-400 bg-red-500/10 border border-red-500/30 px-3 py-2 rounded flex-shrink-0">
          {validationError}
        </div>
      )}

      {/* FOOTER */}
      <footer className="bg-neutral-950 border-t border-neutral-800/80 px-6 py-4 flex items-center justify-between flex-shrink-0">
        <span className="text-[11px] text-neutral-500">
          RunSpec pipeline will execute sequentially across active runners on your selected Den topography.
        </span>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            onClick={onClose}
            className="border-neutral-800 hover:bg-neutral-800 text-neutral-300 text-xs h-9"
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={creating || selectedPlanIds.length === 0}
            className="bg-brand-500 hover:bg-brand-600 text-neutral-900 font-semibold text-xs h-9 px-5 flex items-center gap-1.5"
          >
            {creating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {creating ? "Launching..." : activeCount === 0 ? "Launch Run" : `Launch Run (${activeCount} Primary)`}
          </Button>
        </div>
      </footer>
    </div>
  )
}
