import { useState, useRef, useEffect } from "react"
import { Eye, EyeOff } from "lucide-react"

interface Step4PasswordProps {
  password: string
  setPassword: (password: string) => void
  confirmPassword: string
  setConfirmPassword: (password: string) => void
  pwError: string
  saveError: string
  saving: boolean
  onBack: () => void
  onSubmit: () => void
}

export default function Step4Password({
  password,
  setPassword,
  confirmPassword,
  setConfirmPassword,
  pwError,
  saveError,
  saving,
  onBack,
  onSubmit,
}: Step4PasswordProps) {
  const [showPw, setShowPw] = useState(false)
  const [showConfirmPw, setShowConfirmPw] = useState(false)
  const pwInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (pwInputRef.current) {
      pwInputRef.current.focus()
    }
  }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit()
  }

  return (
    <form className="space-y-4 animate-fade-in" autoComplete="on" onSubmit={handleSubmit}>
      {/* Password */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-neutral-300">Password</label>
        <div className="relative">
          <input
            ref={pwInputRef}
            type={showPw ? "text" : "password"}
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Min. 8 characters"
            autoComplete="new-password"
            className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2
                       text-neutral-100 text-sm placeholder-neutral-600
                       focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500"
          />
          <button type="button" onClick={() => setShowPw(v => !v)} tabIndex={-1}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300">
            {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Confirm password */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-neutral-300">Confirm password</label>
        <div className="relative">
          <input
            type={showConfirmPw ? "text" : "password"}
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            placeholder="Re-enter password"
            autoComplete="new-password"
            className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2
                       text-neutral-100 text-sm placeholder-neutral-600
                       focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500"
          />
          <button type="button" onClick={() => setShowConfirmPw(v => !v)} tabIndex={-1}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300">
            {showConfirmPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {pwError && (
        <p className="text-red-400 text-xs bg-red-950/40 border border-red-900/50 rounded-lg px-3 py-2">
          {pwError}
        </p>
      )}

      {saveError && (
        <p className="text-red-400 text-xs bg-red-950/40 border border-red-900/50 rounded-lg px-3 py-2">
          {saveError}
        </p>
      )}

      <div className="flex justify-between pt-2 border-t border-neutral-800">
        <button
          type="button"
          onClick={onBack}
          disabled={saving}
          className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-400 hover:text-white transition-colors disabled:opacity-40"
        >
          Back
        </button>
        <button
          type="submit"
          disabled={saving || !password || !confirmPassword}
          className="rounded-md bg-brand-500 px-5 py-2 text-sm font-semibold text-neutral-900 hover:bg-brand-400 disabled:opacity-40 transition-colors"
        >
          {saving ? "Completing setup..." : "Finish Setup"}
        </button>
      </div>
    </form>
  )
}
