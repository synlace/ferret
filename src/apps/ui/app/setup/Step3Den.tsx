import Image from "next/image"
import { Loader2, Check } from "lucide-react"

interface Step3DenProps {
  denType: "local" | "aws"
  setDenType: (type: "local" | "aws") => void
  denMaxRunners: number
  setDenMaxRunners: (count: number) => void
  denAwsKey: string
  setDenAwsKey: (key: string) => void
  denAwsSecret: string
  setDenAwsSecret: (secret: string) => void
  denAwsRegion: string
  setDenAwsRegion: (region: string) => void
  denRunnerImage: string
  setDenRunnerImage: (image: string) => void
  denWarmRunners: number
  setDenWarmRunners: (count: number) => void
  denKillIfUnreachable: boolean
  setDenKillIfUnreachable: (kill: boolean) => void
  saving: boolean
  verifying: boolean
  checkingExisting: boolean
  existingSetup: {
    exists: boolean
    working: boolean
    instance_id?: string
    public_ip?: string
    detail?: string
  } | null
  setVerified: (v: boolean) => void
  verified: boolean
  corrupted?: boolean
  teardownAwsDen?: () => Promise<void>
  saveError: string
  verifyLogs: string[]
  setShowLogsModal: (show: boolean) => void
  verifyAwsDen: (forceFresh?: boolean) => void
  saveDenConfig: () => Promise<boolean>
  onBack: () => void
  onContinue: () => void
}

export default function Step3Den({
  denType,
  setDenType,
  denMaxRunners,
  setDenMaxRunners,
  denAwsKey,
  setDenAwsKey,
  denAwsSecret,
  setDenAwsSecret,
  denAwsRegion,
  setDenAwsRegion,
  denRunnerImage,
  setDenRunnerImage,
  denWarmRunners,
  setDenWarmRunners,
  denKillIfUnreachable,
  setDenKillIfUnreachable,
  saving,
  verifying,
  checkingExisting,
  existingSetup,
  setVerified,
  verified,
  corrupted = false,
  teardownAwsDen,
  saveError,
  verifyLogs,
  setShowLogsModal,
  verifyAwsDen,
  saveDenConfig,
  onBack,
  onContinue,
}: Step3DenProps) {
  // High-level AWS Den verification tracking helpers
  const hasCallbackSuccess = verifyLogs.some((l) =>
    l.toLowerCase().includes("verification callback success") ||
    l.toLowerCase().includes("connection established") ||
    l.toLowerCase().includes("ready to proceed")
  )

  const hasRunnerStarted =
    hasCallbackSuccess ||
    verifyLogs.some((l) =>
      l.toLowerCase().includes("starting ferret") ||
      l.toLowerCase().includes("outbound runner daemon") ||
      l.toLowerCase().includes("polled") ||
      l.toLowerCase().includes("starting runner verification") ||
      l.toLowerCase().includes("[ferret-diagnostic]") ||
      l.toLowerCase().includes("runner verification completed")
    )

  const hasTriggeredRun =
    hasRunnerStarted ||
    verifyLogs.some((l) =>
      l.toLowerCase().includes("triggered run") ||
      l.toLowerCase().includes("fargate task spawned") ||
      l.toLowerCase().includes("provisioning aws fargate") ||
      l.toLowerCase().includes("connecting to stream logs")
    )

  const hasWgSuccess =
    hasTriggeredRun ||
    verifyLogs.some((l) =>
      l.toLowerCase().includes("wireguard hub deployed") ||
      l.toLowerCase().includes("gateway public ip") ||
      l.toLowerCase().includes("client tunnel is active")
    )

  const getStep1Status = () => {
    if (hasWgSuccess) return "success"
    if (verifying) return "active"
    return "pending"
  }

  const getStep2Status = () => {
    if (!hasWgSuccess) return "pending"
    if (hasTriggeredRun) return "success"
    if (verifying) return "active"
    return "pending"
  }

  const getStep3Status = () => {
    if (!hasTriggeredRun) return "pending"
    if (hasRunnerStarted) return "success"
    if (verifying) return "active"
    return "pending"
  }

  const getStep4Status = () => {
    if (!hasRunnerStarted) return "pending"
    if (hasCallbackSuccess) return "success"
    if (verifying) return "active"
    return "pending"
  }

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => setDenType("local")}
          className={`flex items-center gap-3 rounded-lg border p-3 text-left transition-all w-full
            ${denType === "local"
              ? "border-brand-500 bg-brand-500/10 text-white"
              : "border-neutral-700 bg-neutral-800/50 text-neutral-300 hover:border-neutral-500 hover:bg-neutral-800"
            }`}
        >
          <Image src="/providers/docker.svg" alt="Local Den" width={28} height={28} className="flex-shrink-0" />
          <div className="min-w-0">
            <span className="block text-sm font-semibold text-white leading-tight">Local Den</span>
            <span className="block text-[10px] text-neutral-500 leading-normal mt-0.5">Runs tasks directly on your local sandbox (Default)</span>
          </div>
        </button>

        <button
          type="button"
          onClick={() => setDenType("aws")}
          className={`flex items-center gap-3 rounded-lg border p-3 text-left transition-all w-full
            ${denType === "aws"
              ? "border-brand-500 bg-brand-500/10 text-white"
              : "border-neutral-700 bg-neutral-800/50 text-neutral-300 hover:border-neutral-500 hover:bg-neutral-800"
            }`}
        >
          <Image src="/providers/aws.svg" alt="AWS Fargate Den" width={28} height={28} className="flex-shrink-0" />
          <div className="min-w-0">
            <span className="block text-sm font-semibold text-white leading-tight">AWS Fargate Den</span>
            <span className="block text-[10px] text-neutral-500 leading-normal mt-0.5">Dynamically spins up unprivileged cloud-native tasks</span>
          </div>
        </button>
      </div>

      {denType === "local" ? (
        <div className="space-y-4">
          <div className="space-y-2 border-t border-neutral-800 pt-4">
            <label className="block text-xs font-semibold text-neutral-300">Global Max Concurrent Runners</label>
            <input
              type="number"
              value={denMaxRunners}
              onChange={e => setDenMaxRunners(Math.max(1, parseInt(e.target.value) || 1))}
              className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-brand-500 focus:outline-none"
            />
            <p className="text-[10px] text-neutral-500">
              Caps the maximum number of concurrent running tasks to protect your system performance.
            </p>
          </div>

          <div className="flex justify-between pt-1 border-t border-neutral-800">
            <button
              type="button"
              onClick={onBack}
              className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-400 hover:text-white transition-colors"
            >
              Back
            </button>
            <button
              type="button"
              onClick={async () => {
                const ok = await saveDenConfig()
                if (ok) onContinue()
              }}
              disabled={saving}
              className="rounded-md bg-brand-500 px-5 py-2 text-sm font-semibold text-neutral-900 hover:bg-brand-400 disabled:opacity-40 transition-colors"
            >
              {saving ? "Saving..." : "Continue"}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-col md:flex-row gap-6 border-t border-neutral-800 pt-4">
            {/* Left Column: Form Settings */}
            <div className="flex-1 space-y-4">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500">AWS Credentials</p>
              
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-neutral-300">AWS Access Key ID</label>
                <input
                  type="text"
                  value={denAwsKey}
                  onChange={e => setDenAwsKey(e.target.value)}
                  placeholder="AKIAIOSFODNN7EXAMPLE"
                  className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-brand-500 focus:outline-none"
                />
              </div>
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-neutral-300">AWS Secret Access Key</label>
                <input
                  type="password"
                  value={denAwsSecret}
                  onChange={e => setDenAwsSecret(e.target.value)}
                  placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
                  className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-brand-500 focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="block text-xs font-semibold text-neutral-300">AWS Region</label>
                  <input
                    type="text"
                    value={denAwsRegion}
                    onChange={e => setDenAwsRegion(e.target.value)}
                    placeholder="eu-west-1"
                    className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-brand-500 focus:outline-none"
                  />
                </div>
                <div className="space-y-2">
                  <label className="block text-xs font-semibold text-neutral-300">Max Runners</label>
                  <input
                    type="number"
                    value={denMaxRunners}
                    onChange={e => setDenMaxRunners(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-brand-500 focus:outline-none"
                  />
                </div>
              </div>
              <p className="text-[10px] text-neutral-500 leading-normal">
                Caps active cloud task counts concurrently to manage AWS compute budgets.
              </p>

              <div className="space-y-2">
                <label className="block text-xs font-semibold text-neutral-300">Custom ECR/Docker Runner Image (Optional)</label>
                <input
                  type="text"
                  value={denRunnerImage}
                  onChange={e => setDenRunnerImage(e.target.value)}
                  placeholder="e.g. 1234567890.dkr.ecr.eu-west-1.amazonaws.com/ferret-runner:latest"
                  className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-brand-500 focus:outline-none"
                />
                <p className="text-[10px] text-neutral-500 leading-normal">
                  Use a pre-cached ECR image inside your AWS account to eliminate internet pull latency.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="block text-xs font-semibold text-neutral-300">Warm Idle Runners Count</label>
                  <input
                    type="number"
                    value={denWarmRunners}
                    onChange={e => setDenWarmRunners(Math.max(0, parseInt(e.target.value) || 0))}
                    className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-brand-500 focus:outline-none"
                  />
                  <p className="text-[10px] text-neutral-500 leading-normal">
                    Keep these running/connected to eliminate scan start delays.
                  </p>
                </div>
                <div className="flex items-center gap-2 pt-6">
                  <input
                    type="checkbox"
                    id="setup_kill_if_unreachable"
                    checked={denKillIfUnreachable}
                    onChange={e => setDenKillIfUnreachable(e.target.checked)}
                    className="rounded border-neutral-700 bg-neutral-900 text-brand-500 focus:ring-brand-500"
                  />
                  <div className="space-y-0.5">
                    <label htmlFor="setup_kill_if_unreachable" className="block text-xs font-semibold text-neutral-300 cursor-pointer">
                      Kill on API loss
                    </label>
                    <p className="text-[10px] text-neutral-500 leading-normal">
                      Auto-terminate if offline &gt; 3m.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Right Column: Verification & Checklist */}
            <div className="flex-1 border-t md:border-t-0 md:border-l border-neutral-800 pt-6 md:pt-0 md:pl-6 space-y-4">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500">Verification Progress</p>
              
              {checkingExisting ? (
                <div className="flex flex-col items-center justify-center py-12 text-center space-y-3">
                  <Loader2 className="w-8 h-8 text-brand-500 animate-spin" />
                  <p className="text-xs font-semibold text-neutral-300">Checking for existing Fargate infrastructure...</p>
                  <p className="text-[10px] text-neutral-500">Checking EC2 instance status and local WireGuard tunnel</p>
                </div>
              ) : corrupted ? (
                <div className="p-4 rounded-lg border border-red-500/20 bg-red-950/10 text-left space-y-3">
                  <div className="flex items-center gap-2 text-red-400">
                    <span className="text-red-400 font-bold text-xs">⚠</span>
                    <span className="font-semibold text-xs uppercase tracking-wider">Deployment Corrupted</span>
                  </div>
                  <p className="text-xs text-neutral-300 leading-normal">
                    The active deployment connection was lost or corrupted (likely due to an API restart or network failure).
                  </p>
                  <p className="text-[10px] text-neutral-500">
                    We must tear down the interrupted resources on AWS before you can redeploy, to avoid dangling resource charges.
                  </p>
                  <button
                    type="button"
                    onClick={teardownAwsDen}
                    disabled={saving || verifying}
                    className="w-full py-2 px-3 text-xs bg-red-500 hover:bg-red-600 disabled:opacity-40 text-white rounded font-semibold transition-colors flex items-center justify-center gap-2"
                  >
                    {(saving || verifying) ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Tearing down...
                      </>
                    ) : (
                      "Clean Up & Redeploy"
                    )}
                  </button>
                </div>
              ) : existingSetup && existingSetup.exists && existingSetup.working ? (
                <div className="p-4 rounded-lg border border-brand-500/20 bg-brand-950/20 text-left space-y-3">
                  <div className="flex items-center gap-2 text-brand-400">
                    <Check className="h-4 w-4 text-brand-400" />
                    <span className="font-semibold text-xs uppercase tracking-wider">Active Setup Found</span>
                  </div>
                  <p className="text-xs text-neutral-300 leading-normal">
                    We detected a running WireGuard VM (<code className="text-xs bg-neutral-900 px-1 py-0.5 rounded text-white">{existingSetup.instance_id}</code>) with an active secure tunnel connection.
                  </p>
                  <p className="text-[10px] text-neutral-500">
                    You can reuse this existing infrastructure safely to avoid duplicate AWS resource charges.
                  </p>
                  <div className="flex gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => {
                        setVerified(true)
                        onContinue()
                      }}
                      className="flex-1 py-2 px-3 text-xs bg-brand-500 hover:bg-brand-400 text-neutral-900 rounded font-semibold transition-colors"
                    >
                      Reuse Setup (Recommended)
                    </button>
                    <button
                      type="button"
                      onClick={() => verifyAwsDen(true)}
                      className="py-2 px-3 text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded font-semibold transition-colors"
                    >
                      Deploy Fresh VM
                    </button>
                  </div>
                </div>
              ) : existingSetup && existingSetup.exists && !existingSetup.working && !verifying ? (
                <div className="p-4 rounded-lg border border-yellow-500/20 bg-yellow-950/10 text-left space-y-3">
                  <div className="flex items-center gap-2 text-yellow-400">
                    <span className="text-yellow-400 font-bold text-xs">⚠</span>
                    <span className="font-semibold text-xs uppercase tracking-wider">Offline VM Detected</span>
                  </div>
                  <p className="text-xs text-neutral-300 leading-normal">
                    We detected an existing WireGuard VM (<code className="text-xs bg-neutral-900 px-1 py-0.5 rounded text-white">{existingSetup.instance_id}</code>) in your AWS account, but the secure connection tunnel is currently offline.
                  </p>
                  <p className="text-[10px] text-neutral-500">
                    We need to sync your local configurations and trigger a handshake run to restore connection.
                  </p>
                  <div className="flex gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => verifyAwsDen(false)}
                      className="flex-1 py-2 px-3 text-xs bg-brand-500 hover:bg-brand-400 text-neutral-900 rounded font-semibold transition-colors"
                    >
                      Sync & Restore Connection
                    </button>
                    <button
                      type="button"
                      onClick={() => verifyAwsDen(true)}
                      className="py-2 px-3 text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded font-semibold transition-colors"
                    >
                      Deploy Fresh VM
                    </button>
                  </div>
                </div>
              ) : existingSetup && !existingSetup.exists && !verifying ? (
                <div className="p-4 rounded-lg border border-brand-500/10 bg-neutral-900/50 text-left space-y-3">
                  <div className="flex items-center gap-2 text-brand-400">
                    <span className="text-brand-400 font-bold text-xs">ℹ</span>
                    <span className="font-semibold text-xs uppercase tracking-wider">Ready for Deployment</span>
                  </div>
                  <p className="text-xs text-neutral-300 leading-normal">
                    No active cloud-native VM was found for these credentials on AWS.
                  </p>
                  <p className="text-[10px] text-neutral-500">
                    Click below to deploy a persistent EC2 WireGuard Hub and configure unprivileged scanning environments on AWS Fargate.
                  </p>
                  <button
                    type="button"
                    onClick={() => verifyAwsDen(false)}
                    className="w-full py-2 px-3 text-xs bg-brand-500 hover:bg-brand-400 text-neutral-900 rounded font-semibold transition-colors"
                  >
                    Deploy AWS Den
                  </button>
                </div>
              ) : (
                <>
                  {/* Interactive checklist block */}
                  <div className="space-y-4">
                    {/* High-level Step 1 */}
                    <div className={`flex items-start gap-3 transition-opacity duration-200 ${getStep1Status() === "pending" ? "opacity-35" : "opacity-100"}`}>
                      <div className="flex h-5 w-5 items-center justify-center flex-shrink-0">
                        {getStep1Status() === "success" ? (
                          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-green-500/10 border border-green-500 text-green-400">
                            <Check className="w-3 h-3" />
                          </div>
                        ) : getStep1Status() === "active" ? (
                          <Loader2 className="w-4 h-4 text-brand-500 animate-spin" />
                        ) : (
                          <div className="flex h-5 w-5 items-center justify-center rounded-full border border-neutral-700 text-[10px] font-bold text-neutral-500">
                            1
                          </div>
                        )}
                      </div>
                      <div className="space-y-0.5">
                        <p className={`text-xs font-semibold ${getStep1Status() === "active" ? "text-brand-400" : "text-neutral-200"}`}>Deploy WireGuard EC2 VPN Hub</p>
                        <p className="text-[10px] text-neutral-500 leading-tight">Provisioning gateway instance and tunnel interface</p>
                      </div>
                    </div>

                    {/* High-level Step 2 */}
                    <div className={`flex items-start gap-3 transition-opacity duration-200 ${getStep2Status() === "pending" ? "opacity-35" : "opacity-100"}`}>
                      <div className="flex h-5 w-5 items-center justify-center flex-shrink-0">
                        {getStep2Status() === "success" ? (
                          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-green-500/10 border border-green-500 text-green-400">
                            <Check className="w-3 h-3" />
                          </div>
                        ) : getStep2Status() === "active" ? (
                          <Loader2 className="w-4 h-4 text-brand-500 animate-spin" />
                        ) : (
                          <div className="flex h-5 w-5 items-center justify-center rounded-full border border-neutral-700 text-[10px] font-bold text-neutral-500">
                            2
                          </div>
                        )}
                      </div>
                      <div className="space-y-0.5">
                        <p className={`text-xs font-semibold ${getStep2Status() === "active" ? "text-brand-400" : "text-neutral-200"}`}>Configure Network Security & Roles</p>
                        <p className="text-[10px] text-neutral-500 leading-tight">Setting up secure outbound runner isolation policies</p>
                      </div>
                    </div>

                    {/* High-level Step 3 */}
                    <div className={`flex items-start gap-3 transition-opacity duration-200 ${getStep3Status() === "pending" ? "opacity-35" : "opacity-100"}`}>
                      <div className="flex h-5 w-5 items-center justify-center flex-shrink-0">
                        {getStep3Status() === "success" ? (
                          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-green-500/10 border border-green-500 text-green-400">
                            <Check className="w-3 h-3" />
                          </div>
                        ) : getStep3Status() === "active" ? (
                          <Loader2 className="w-4 h-4 text-brand-500 animate-spin" />
                        ) : (
                          <div className="flex h-5 w-5 items-center justify-center rounded-full border border-neutral-700 text-[10px] font-bold text-neutral-500">
                            3
                          </div>
                        )}
                      </div>
                      <div className="space-y-0.5">
                        <p className={`text-xs font-semibold ${getStep3Status() === "active" ? "text-brand-400" : "text-neutral-200"}`}>Launch Serverless Fargate Task</p>
                        <p className="text-[10px] text-neutral-500 leading-tight">Spawning runner container client task on ECS</p>
                      </div>
                    </div>

                    {/* High-level Step 4 */}
                    <div className={`flex items-start gap-3 transition-opacity duration-200 ${getStep4Status() === "pending" ? "opacity-35" : "opacity-100"}`}>
                      <div className="flex h-5 w-5 items-center justify-center flex-shrink-0">
                        {getStep4Status() === "success" ? (
                          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-green-500/10 border border-green-500 text-green-400">
                            <Check className="w-3 h-3" />
                          </div>
                        ) : getStep4Status() === "active" ? (
                          <Loader2 className="w-4 h-4 text-brand-500 animate-spin" />
                        ) : (
                          <div className="flex h-5 w-5 items-center justify-center rounded-full border border-neutral-700 text-[10px] font-bold text-neutral-500">
                            4
                          </div>
                        )}
                      </div>
                      <div className="space-y-0.5">
                        <p className={`text-xs font-semibold ${getStep4Status() === "active" ? "text-brand-400" : "text-neutral-200"}`}>Verify Tunnel Connection Callback</p>
                        <p className="text-[10px] text-neutral-500 leading-tight">Awaiting runner daemon polling handshake via VPN</p>
                      </div>
                    </div>
                  </div>

                  {/* Trigger button for raw logs popup modal */}
                  {(verifying || verifyLogs.length > 0) && (
                    <div className="border-t border-neutral-800 pt-3 flex items-center justify-between">
                      <span className="text-[11px] text-neutral-500 font-medium">Deployment & runner logs</span>
                      <button
                        type="button"
                        onClick={() => setShowLogsModal(true)}
                        className="rounded border border-neutral-700 bg-neutral-800/40 px-2.5 py-1 text-[11px] font-medium text-neutral-300 hover:border-neutral-500 hover:text-white transition-colors"
                      >
                        View Logs ({verifyLogs.length})
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {saveError && (
            <p className="rounded-md border border-red-800 bg-red-900/30 px-3 py-2 text-xs text-red-400 mt-4">
              {saveError}
            </p>
          )}

          <div className="flex justify-between pt-4 border-t border-neutral-800 mt-4">
            <button
              type="button"
              onClick={onBack}
              disabled={verifying}
              className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-400 hover:text-white transition-colors disabled:opacity-40"
            >
              Back
            </button>
            {verified ? (
              <button
                type="button"
                onClick={onContinue}
                className="rounded-md bg-brand-500 px-5 py-2 text-sm font-semibold text-neutral-900 hover:bg-brand-400 transition-colors animate-pulse"
              >
                Continue to Password
              </button>
            ) : (
              <button
                type="button"
                onClick={() => verifyAwsDen()}
                disabled={saving || verifying}
                className="rounded-md bg-brand-500 px-5 py-2 text-sm font-semibold text-neutral-900 hover:bg-brand-400 disabled:opacity-40 transition-colors"
              >
                {verifying ? "Verifying..." : "Verify AWS Den"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
