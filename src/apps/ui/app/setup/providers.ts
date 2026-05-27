export type ProviderKey =
  | "openrouter" | "openai" | "anthropic" | "gemini"
  | "deepseek" | "mistral" | "ollama" | "lmstudio"

export interface Provider {
  key: ProviderKey
  name: string
  tag: string
  icon: string   // LobeHub CDN PNG (colour variant where available)
  local?: boolean
  defaultBaseUrl?: string
  defaultModel: string
  models: { id: string; label: string; note?: string }[]
}

export const PROVIDERS: Provider[] = [
  {
    key: "openrouter",
    name: "OpenRouter",
    tag: "200+ models",
    icon: "/providers/openrouter.png",
    defaultModel: "x-ai/grok-4.3",
    models: [
      { id: "x-ai/grok-4.3",                    label: "Grok 4.3", note: "Recommended" },
      { id: "google/gemini-3.5-flash",          label: "Gemini 3.5 Flash" },
      { id: "google/gemini-2.5-flash-preview",  label: "Gemini 2.5 Flash" },
      { id: "google/gemini-2.5-pro-preview",    label: "Gemini 2.5 Pro" },
      { id: "anthropic/claude-sonnet-4-5",      label: "Claude Sonnet 4.5" },
      { id: "openai/gpt-4o",                    label: "GPT-4o" },
      { id: "deepseek/deepseek-r1",             label: "DeepSeek R1" },
    ],
  },
  {
    key: "openai",
    name: "OpenAI",
    tag: "Direct API",
    icon: "/providers/openai.png",
    defaultModel: "gpt-4o",
    models: [
      { id: "gpt-4o",      label: "GPT-4o",      note: "Recommended" },
      { id: "gpt-4o-mini", label: "GPT-4o Mini" },
      { id: "o3-mini",     label: "o3 Mini" },
      { id: "o4-mini",     label: "o4 Mini" },
    ],
  },
  {
    key: "anthropic",
    name: "Anthropic",
    tag: "Direct API",
    icon: "/providers/claude-color.png",
    defaultModel: "claude-sonnet-4-5",
    models: [
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", note: "Recommended" },
      { id: "claude-opus-4",     label: "Claude Opus 4" },
      { id: "claude-haiku-3-5",  label: "Claude Haiku 3.5" },
    ],
  },
  {
    key: "gemini",
    name: "Gemini",
    tag: "Google AI",
    icon: "/providers/gemini-color.png",
    defaultModel: "gemini-2.5-flash-preview-05-20",
    models: [
      { id: "gemini-2.5-flash-preview-05-20", label: "Gemini 2.5 Flash", note: "Recommended" },
      { id: "gemini-2.5-pro-preview-05-06",   label: "Gemini 2.5 Pro" },
    ],
  },
  {
    key: "deepseek",
    name: "DeepSeek",
    tag: "Cost-effective",
    icon: "/providers/deepseek-color.png",
    defaultModel: "deepseek-reasoner",
    models: [
      { id: "deepseek-reasoner", label: "DeepSeek R1",  note: "Recommended" },
      { id: "deepseek-chat",     label: "DeepSeek V3" },
    ],
  },
  {
    key: "mistral",
    name: "Mistral",
    tag: "European AI",
    icon: "/providers/mistral-color.png",
    defaultModel: "mistral-large-latest",
    models: [
      { id: "mistral-large-latest", label: "Mistral Large", note: "Recommended" },
      { id: "mistral-small-latest", label: "Mistral Small" },
      { id: "codestral-latest",     label: "Codestral" },
    ],
  },
  {
    key: "ollama",
    name: "Ollama",
    tag: "host-gateway:11434",
    icon: "/providers/ollama.png",
    local: true,
    // host-gateway resolves to the Docker host IP inside containers (via extra_hosts).
    // Using localhost here would point at the container itself, not the host machine.
    defaultBaseUrl: "http://host-gateway:11434/v1",
    defaultModel: "llama3.3",
    models: [
      { id: "llama3.3",       label: "Llama 3.3",       note: "Recommended" },
      { id: "llama3.1:8b",    label: "Llama 3.1 8B" },
      { id: "mistral",        label: "Mistral 7B" },
      { id: "qwen2.5-coder",  label: "Qwen 2.5 Coder" },
    ],
  },
  {
    key: "lmstudio",
    name: "LM Studio",
    tag: "host-gateway:1234",
    icon: "/providers/lmstudio.png",
    local: true,
    // host-gateway resolves to the Docker host IP inside containers (via extra_hosts).
    // Using localhost here would point at the container itself, not the host machine.
    defaultBaseUrl: "http://host-gateway:1234/v1",
    defaultModel: "local-model",
    models: [
      { id: "local-model", label: "Active model in LM Studio", note: "Recommended" },
    ],
  },
]
