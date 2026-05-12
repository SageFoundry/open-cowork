import { getModel, type Api, type Model } from '@mariozechner/pi-ai';
import { isOfficialOpenAIBaseUrl } from '../config/auth-utils';

const COMMON_FALLBACK_PROVIDERS = ['openai', 'anthropic', 'google'] as const;
const INVALID_REGISTRY_PROVIDERS = new Set(['', 'custom']);
const REASONING_MODEL_PATTERN =
  /\bthinking\b|\breasoner\b|deepseek-r1|kimi-k2|qwen3(?:\.5)?(?=[:/-]|$)/i;
type PiRegistryProvider = Parameters<typeof getModel>[0];

export interface PiModelStringInput {
  provider?: string;
  customProtocol?: string;
  model?: string;
  defaultModel?: string;
}

export interface PiModelLookupOptions {
  configProvider?: string;
  rawProvider?: string;
  customBaseUrl?: string;
  customProtocol?: string;
  requestedModelString?: string;
}

export interface PiModelLookupCandidate {
  provider: string;
  model: string;
}

export interface SyntheticPiModelFallbackInput {
  rawModel?: string;
  resolvedModelString: string;
  rawProvider?: string;
  routeProtocol: string;
  baseUrl?: string;
}

export interface SyntheticPiModelFallback {
  provider: string;
  modelId: string;
}

export function resolvePiRouteProtocol(provider?: string, customProtocol?: string): string {
  if (provider === 'custom') {
    if (customProtocol === 'openai' || customProtocol === 'gemini') {
      return customProtocol;
    }
    return 'anthropic';
  }
  if (provider === 'ollama') return 'openai';
  if (provider === 'openai') return 'openai';
  if (provider === 'lingerai' || provider === 'deepseek') return 'openai';
  if (provider === 'openrouter') return 'openai';
  if (provider === 'gemini') return 'gemini';
  return provider || 'anthropic';
}

function shouldDisableDeveloperRoleForEndpoint(
  model: Model<Api>,
  options: PiModelLookupOptions
): boolean {
  if (model.api !== 'openai-completions' && model.api !== 'openai-responses') {
    return false;
  }

  const endpoint = options.customBaseUrl?.trim() || model.baseUrl?.trim();
  if (!endpoint || isOfficialOpenAIBaseUrl(endpoint)) {
    return false;
  }

  return true;
}

export function inferPiApi(protocol: string): string {
  switch (protocol) {
    case 'anthropic':
      return 'anthropic-messages';
    case 'gemini':
    case 'google':
      return 'google-generative-ai';
    case 'openai':
    default:
      return 'openai-completions';
  }
}

interface KnownModelSpecs {
  contextWindow: number;
  maxTokens: number;
  /** Input types the model supports. Undefined means text-only by default. */
  input?: ('text' | 'image')[];
}

interface KnownModelSpecEntry extends KnownModelSpecs {
  aliases: string[];
}

/**
 * OpenRouter model specs refreshed from /api/v1/models on 2026-04-25.
 * Scope: text-output language and multimodal models created since 2025-10-25.
 */
const RECENT_OPENROUTER_MODEL_SPECS: KnownModelSpecEntry[] = [
  {
    aliases: ["inclusionai/ring-2.6-1t:free"],
    contextWindow: 262144,
    maxTokens: 65536
  },
  {
    aliases: ["google/gemini-3.1-flash-lite"],
    contextWindow: 1048576,
    maxTokens: 65536, input: ["text", "image"]
  },
  {
    aliases: ["baidu/cobuddy:free"],
    contextWindow: 131072,
    maxTokens: 65536
  },
  {
    aliases: ["openai/gpt-chat-latest"],
    contextWindow: 400000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["x-ai/grok-4.3"],
    contextWindow: 1000000,
    maxTokens: 0, input: ["text", "image"]
  },
  {
    aliases: ["ibm-granite/granite-4.1-8b"],
    contextWindow: 131072,
    maxTokens: 131072
  },
  {
    aliases: ["mistralai/mistral-medium-3-5"],
    contextWindow: 262144,
    maxTokens: 0, input: ["text", "image"]
  },
  {
    aliases: ["openrouter/owl-alpha"],
    contextWindow: 1048756,
    maxTokens: 262144
  },
  {
    aliases: ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"],
    contextWindow: 256000,
    maxTokens: 65536, input: ["text", "image"]
  },
  {
    aliases: ["poolside/laguna-xs.2:free"],
    contextWindow: 131072,
    maxTokens: 8192
  },
  {
    aliases: ["poolside/laguna-m.1:free"],
    contextWindow: 131072,
    maxTokens: 8192
  },
  {
    aliases: ["~anthropic/claude-haiku-latest", "anthropic/claude-haiku-latest"],
    contextWindow: 200000,
    maxTokens: 64000, input: ["text", "image"]
  },
  {
    aliases: ["~openai/gpt-mini-latest", "openai/gpt-mini-latest"],
    contextWindow: 400000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["~google/gemini-pro-latest", "google/gemini-pro-latest"],
    contextWindow: 1048576,
    maxTokens: 65536, input: ["text", "image"]
  },
  {
    aliases: ["~moonshotai/kimi-latest", "moonshotai/kimi-latest"],
    contextWindow: 32768,
    maxTokens: 32768, input: ["text", "image"]
  },
  {
    aliases: ["~google/gemini-flash-latest", "google/gemini-flash-latest"],
    contextWindow: 1048576,
    maxTokens: 65536, input: ["text", "image"]
  },
  {
    aliases: ["~anthropic/claude-sonnet-latest", "anthropic/claude-sonnet-latest"],
    contextWindow: 1000000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["~openai/gpt-latest", "openai/gpt-latest"],
    contextWindow: 1050000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["qwen/qwen3.5-plus-20260420", "qwen/qwen3.5-plus"],
    contextWindow: 1000000,
    maxTokens: 65536, input: ["text", "image"]
  },
  {
    aliases: ["qwen/qwen3.6-flash"],
    contextWindow: 1000000,
    maxTokens: 65536, input: ["text", "image"]
  },
  {
    aliases: ["qwen/qwen3.6-35b-a3b"],
    contextWindow: 262144,
    maxTokens: 262144, input: ["text", "image"]
  },
  {
    aliases: ["qwen/qwen3.6-max-preview"],
    contextWindow: 262144,
    maxTokens: 65536
  },
  {
    aliases: ["qwen/qwen3.6-27b"],
    contextWindow: 262144,
    maxTokens: 81920, input: ["text", "image"]
  },
  {
    aliases: ["openai/gpt-5.5-pro"],
    contextWindow: 1050000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["openai/gpt-5.5"],
    contextWindow: 1050000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["deepseek/deepseek-v4-pro"],
    contextWindow: 1048576,
    maxTokens: 384000
  },
  {
    aliases: ["deepseek/deepseek-v4-flash"],
    contextWindow: 1048576,
    maxTokens: 384000
  },
  {
    aliases: ["inclusionai/ling-2.6-1t"],
    contextWindow: 262144,
    maxTokens: 32768
  },
  {
    aliases: ["tencent/hy3-preview"],
    contextWindow: 262144,
    maxTokens: 262144
  },
  {
    aliases: ["xiaomi/mimo-v2.5-pro"],
    contextWindow: 1048576,
    maxTokens: 16384
  },
  {
    aliases: ["xiaomi/mimo-v2.5"],
    contextWindow: 1048576,
    maxTokens: 131072, input: ["text", "image"]
  },
  {
    aliases: ["openai/gpt-5.4-image-2"],
    contextWindow: 272000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["inclusionai/ling-2.6-flash"],
    contextWindow: 262144,
    maxTokens: 32768
  },
  {
    aliases: ["~anthropic/claude-opus-latest", "anthropic/claude-opus-latest"],
    contextWindow: 1000000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["openrouter/pareto-code"],
    contextWindow: 2000000,
    maxTokens: 0
  },
  {
    aliases: ["baidu/qianfan-ocr-fast:free"],
    contextWindow: 65536,
    maxTokens: 28672, input: ["text", "image"]
  },
  {
    aliases: ["moonshotai/kimi-k2.6"],
    contextWindow: 256000,
    maxTokens: 32768, input: ["text", "image"]
  },
  {
    aliases: ["anthropic/claude-opus-4.7"],
    contextWindow: 1000000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["anthropic/claude-opus-4.6-fast"],
    contextWindow: 1000000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["z-ai/glm-5.1"],
    contextWindow: 202752,
    maxTokens: 0
  },
  {
    aliases: ["google/gemma-4-26b-a4b-it:free"],
    contextWindow: 262144,
    maxTokens: 32768, input: ["text", "image"]
  },
  {
    aliases: ["google/gemma-4-26b-a4b-it"],
    contextWindow: 262144,
    maxTokens: 0, input: ["text", "image"]
  },
  {
    aliases: ["google/gemma-4-31b-it:free"],
    contextWindow: 262144,
    maxTokens: 32768, input: ["text", "image"]
  },
  {
    aliases: ["google/gemma-4-31b-it"],
    contextWindow: 262144,
    maxTokens: 16384, input: ["text", "image"]
  },
  {
    aliases: ["qwen/qwen3.6-plus"],
    contextWindow: 1000000,
    maxTokens: 65536, input: ["text", "image"]
  },
  {
    aliases: ["z-ai/glm-5v-turbo"],
    contextWindow: 202752,
    maxTokens: 131072, input: ["text", "image"]
  },
  {
    aliases: ["arcee-ai/trinity-large-thinking:free"],
    contextWindow: 262144,
    maxTokens: 80000
  },
  {
    aliases: ["arcee-ai/trinity-large-thinking"],
    contextWindow: 262144,
    maxTokens: 262144
  },
  {
    aliases: ["x-ai/grok-4.20-multi-agent"],
    contextWindow: 2000000,
    maxTokens: 0, input: ["text", "image"]
  },
  {
    aliases: ["x-ai/grok-4.20"],
    contextWindow: 2000000,
    maxTokens: 0, input: ["text", "image"]
  },
  {
    aliases: ["google/lyria-3-pro-preview"],
    contextWindow: 1048576,
    maxTokens: 65536, input: ["text", "image"]
  },
  {
    aliases: ["google/lyria-3-clip-preview"],
    contextWindow: 1048576,
    maxTokens: 65536, input: ["text", "image"]
  },
  {
    aliases: ["kwaipilot/kat-coder-pro-v2"],
    contextWindow: 256000,
    maxTokens: 80000
  },
  {
    aliases: ["rekaai/reka-edge"],
    contextWindow: 16384,
    maxTokens: 16384, input: ["text", "image"]
  },
  {
    aliases: ["xiaomi/mimo-v2-omni"],
    contextWindow: 262144,
    maxTokens: 65536, input: ["text", "image"]
  },
  {
    aliases: ["xiaomi/mimo-v2-pro"],
    contextWindow: 1048576,
    maxTokens: 131072
  },
  {
    aliases: ["minimax/minimax-m2.7"],
    contextWindow: 196608,
    maxTokens: 0
  },
  {
    aliases: ["openai/gpt-5.4-nano"],
    contextWindow: 400000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["openai/gpt-5.4-mini"],
    contextWindow: 400000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["mistralai/mistral-small-2603"],
    contextWindow: 262144,
    maxTokens: 0, input: ["text", "image"]
  },
  {
    aliases: ["z-ai/glm-5-turbo"],
    contextWindow: 202752,
    maxTokens: 131072
  },
  {
    aliases: ["nvidia/nemotron-3-super-120b-a12b:free"],
    contextWindow: 262144,
    maxTokens: 262144
  },
  {
    aliases: ["nvidia/nemotron-3-super-120b-a12b"],
    contextWindow: 262144,
    maxTokens: 0
  },
  {
    aliases: ["bytedance-seed/seed-2.0-lite"],
    contextWindow: 262144,
    maxTokens: 131072, input: ["text", "image"]
  },
  {
    aliases: ["qwen/qwen3.5-9b"],
    contextWindow: 262144,
    maxTokens: 81920, input: ["text", "image"]
  },
  {
    aliases: ["openai/gpt-5.4-pro"],
    contextWindow: 1050000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["openai/gpt-5.4"],
    contextWindow: 1050000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["inception/mercury-2"],
    contextWindow: 128000,
    maxTokens: 50000
  },
  {
    aliases: ["openai/gpt-5.3-chat"],
    contextWindow: 128000,
    maxTokens: 16384, input: ["text", "image"]
  },
  {
    aliases: ["google/gemini-3.1-flash-lite-preview"],
    contextWindow: 1048576,
    maxTokens: 65536, input: ["text", "image"]
  },
  {
    aliases: ["bytedance-seed/seed-2.0-mini"],
    contextWindow: 262144,
    maxTokens: 131072, input: ["text", "image"]
  },
  {
    aliases: ["google/gemini-3.1-flash-image-preview"],
    contextWindow: 65536,
    maxTokens: 65536, input: ["text", "image"]
  },
  {
    aliases: ["qwen/qwen3.5-35b-a3b"],
    contextWindow: 262144,
    maxTokens: 81920, input: ["text", "image"]
  },
  {
    aliases: ["qwen/qwen3.5-27b"],
    contextWindow: 262144,
    maxTokens: 65536, input: ["text", "image"]
  },
  {
    aliases: ["qwen/qwen3.5-122b-a10b"],
    contextWindow: 262144,
    maxTokens: 65536, input: ["text", "image"]
  },
  {
    aliases: ["qwen/qwen3.5-flash-02-23"],
    contextWindow: 1000000,
    maxTokens: 65536, input: ["text", "image"]
  },
  {
    aliases: ["liquid/lfm-2-24b-a2b"],
    contextWindow: 32768,
    maxTokens: 0
  },
  {
    aliases: ["google/gemini-3.1-pro-preview-customtools"],
    contextWindow: 1048576,
    maxTokens: 65536, input: ["text", "image"]
  },
  {
    aliases: ["openai/gpt-5.3-codex"],
    contextWindow: 400000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["aion-labs/aion-2.0"],
    contextWindow: 131072,
    maxTokens: 32768
  },
  {
    aliases: ["google/gemini-3.1-pro-preview"],
    contextWindow: 1048576,
    maxTokens: 65536, input: ["text", "image"]
  },
  {
    aliases: ["anthropic/claude-sonnet-4.6"],
    contextWindow: 1000000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["qwen/qwen3.5-plus-02-15"],
    contextWindow: 1000000,
    maxTokens: 65536, input: ["text", "image"]
  },
  {
    aliases: ["qwen/qwen3.5-397b-a17b"],
    contextWindow: 262144,
    maxTokens: 65536, input: ["text", "image"]
  },
  {
    aliases: ["minimax/minimax-m2.5:free"],
    contextWindow: 196608,
    maxTokens: 8192
  },
  {
    aliases: ["minimax/minimax-m2.5"],
    contextWindow: 196608,
    maxTokens: 196608
  },
  {
    aliases: ["z-ai/glm-5"],
    contextWindow: 202752,
    maxTokens: 0
  },
  {
    aliases: ["qwen/qwen3-max-thinking"],
    contextWindow: 262144,
    maxTokens: 32768
  },
  {
    aliases: ["anthropic/claude-opus-4.6"],
    contextWindow: 1000000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["qwen/qwen3-coder-next"],
    contextWindow: 262144,
    maxTokens: 262144
  },
  {
    aliases: ["openrouter/free"],
    contextWindow: 200000,
    maxTokens: 0, input: ["text", "image"]
  },
  {
    aliases: ["stepfun/step-3.5-flash"],
    contextWindow: 262144,
    maxTokens: 65536
  },
  {
    aliases: ["arcee-ai/trinity-large-preview"],
    contextWindow: 131000,
    maxTokens: 0
  },
  {
    aliases: ["moonshotai/kimi-k2.5"],
    contextWindow: 262144,
    maxTokens: 262144, input: ["text", "image"]
  },
  {
    aliases: ["upstage/solar-pro-3"],
    contextWindow: 128000,
    maxTokens: 0
  },
  {
    aliases: ["minimax/minimax-m2-her"],
    contextWindow: 65536,
    maxTokens: 2048
  },
  {
    aliases: ["writer/palmyra-x5"],
    contextWindow: 1040000,
    maxTokens: 8192
  },
  {
    aliases: ["liquid/lfm-2.5-1.2b-thinking:free"],
    contextWindow: 32768,
    maxTokens: 0
  },
  {
    aliases: ["liquid/lfm-2.5-1.2b-instruct:free"],
    contextWindow: 32768,
    maxTokens: 0
  },
  {
    aliases: ["openai/gpt-audio"],
    contextWindow: 128000,
    maxTokens: 16384
  },
  {
    aliases: ["openai/gpt-audio-mini"],
    contextWindow: 128000,
    maxTokens: 16384
  },
  {
    aliases: ["z-ai/glm-4.7-flash"],
    contextWindow: 202752,
    maxTokens: 16384
  },
  {
    aliases: ["openai/gpt-5.2-codex"],
    contextWindow: 400000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["bytedance-seed/seed-1.6-flash"],
    contextWindow: 262144,
    maxTokens: 32768, input: ["text", "image"]
  },
  {
    aliases: ["bytedance-seed/seed-1.6"],
    contextWindow: 262144,
    maxTokens: 32768, input: ["text", "image"]
  },
  {
    aliases: ["minimax/minimax-m2.1"],
    contextWindow: 196608,
    maxTokens: 196608
  },
  {
    aliases: ["z-ai/glm-4.7"],
    contextWindow: 202752,
    maxTokens: 131072
  },
  {
    aliases: ["google/gemini-3-flash-preview"],
    contextWindow: 1048576,
    maxTokens: 65536, input: ["text", "image"]
  },
  {
    aliases: ["xiaomi/mimo-v2-flash"],
    contextWindow: 262144,
    maxTokens: 65536
  },
  {
    aliases: ["nvidia/nemotron-3-nano-30b-a3b:free"],
    contextWindow: 256000,
    maxTokens: 0
  },
  {
    aliases: ["nvidia/nemotron-3-nano-30b-a3b"],
    contextWindow: 262144,
    maxTokens: 228000
  },
  {
    aliases: ["openai/gpt-5.2-chat"],
    contextWindow: 128000,
    maxTokens: 32000, input: ["text", "image"]
  },
  {
    aliases: ["openai/gpt-5.2-pro"],
    contextWindow: 400000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["openai/gpt-5.2"],
    contextWindow: 400000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["mistralai/devstral-2512"],
    contextWindow: 262144,
    maxTokens: 0
  },
  {
    aliases: ["relace/relace-search"],
    contextWindow: 256000,
    maxTokens: 128000
  },
  {
    aliases: ["z-ai/glm-4.6v"],
    contextWindow: 131072,
    maxTokens: 24000, input: ["text", "image"]
  },
  {
    aliases: ["nex-agi/deepseek-v3.1-nex-n1"],
    contextWindow: 131072,
    maxTokens: 131072
  },
  {
    aliases: ["essentialai/rnj-1-instruct"],
    contextWindow: 32768,
    maxTokens: 0
  },
  {
    aliases: ["openrouter/bodybuilder"],
    contextWindow: 128000,
    maxTokens: 0
  },
  {
    aliases: ["openai/gpt-5.1-codex-max"],
    contextWindow: 400000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["amazon/nova-2-lite-v1"],
    contextWindow: 1000000,
    maxTokens: 65535, input: ["text", "image"]
  },
  {
    aliases: ["mistralai/ministral-14b-2512"],
    contextWindow: 262144,
    maxTokens: 0, input: ["text", "image"]
  },
  {
    aliases: ["mistralai/ministral-8b-2512"],
    contextWindow: 262144,
    maxTokens: 0, input: ["text", "image"]
  },
  {
    aliases: ["mistralai/ministral-3b-2512"],
    contextWindow: 131072,
    maxTokens: 0, input: ["text", "image"]
  },
  {
    aliases: ["mistralai/mistral-large-2512"],
    contextWindow: 262144,
    maxTokens: 0, input: ["text", "image"]
  },
  {
    aliases: ["arcee-ai/trinity-mini"],
    contextWindow: 131072,
    maxTokens: 131072
  },
  {
    aliases: ["deepseek/deepseek-v3.2-speciale"],
    contextWindow: 163840,
    maxTokens: 163840
  },
  {
    aliases: ["deepseek/deepseek-v3.2"],
    contextWindow: 131072,
    maxTokens: 65536
  },
  {
    aliases: ["prime-intellect/intellect-3"],
    contextWindow: 131072,
    maxTokens: 131072
  },
  {
    aliases: ["anthropic/claude-opus-4.5"],
    contextWindow: 200000,
    maxTokens: 64000, input: ["text", "image"]
  },
  {
    aliases: ["allenai/olmo-3-32b-think"],
    contextWindow: 65536,
    maxTokens: 65536
  },
  {
    aliases: ["google/gemini-3-pro-image-preview"],
    contextWindow: 65536,
    maxTokens: 32768, input: ["text", "image"]
  },
  {
    aliases: ["x-ai/grok-4.1-fast"],
    contextWindow: 2000000,
    maxTokens: 30000, input: ["text", "image"]
  },
  {
    aliases: ["deepcogito/cogito-v2.1-671b"],
    contextWindow: 128000,
    maxTokens: 0
  },
  {
    aliases: ["openai/gpt-5.1"],
    contextWindow: 400000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["openai/gpt-5.1-chat"],
    contextWindow: 128000,
    maxTokens: 16384, input: ["text", "image"]
  },
  {
    aliases: ["openai/gpt-5.1-codex"],
    contextWindow: 400000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["openai/gpt-5.1-codex-mini"],
    contextWindow: 400000,
    maxTokens: 128000, input: ["text", "image"]
  },
  {
    aliases: ["moonshotai/kimi-k2-thinking"],
    contextWindow: 262144,
    maxTokens: 262144
  },
  {
    aliases: ["amazon/nova-premier-v1"],
    contextWindow: 1000000,
    maxTokens: 32000, input: ["text", "image"]
  },
  {
    aliases: ["perplexity/sonar-pro-search"],
    contextWindow: 200000,
    maxTokens: 8000, input: ["text", "image"]
  },
  {
    aliases: ["mistralai/voxtral-small-24b-2507"],
    contextWindow: 32000,
    maxTokens: 0
  },
  {
    aliases: ["openai/gpt-oss-safeguard-20b"],
    contextWindow: 131072,
    maxTokens: 65536
  },
  {
    aliases: ["nvidia/nemotron-nano-12b-v2-vl:free"],
    contextWindow: 128000,
    maxTokens: 128000, input: ["text", "image"]
  },
];

/**
 * Older broad family specs kept for local Ollama-style names.
 * Recent provider models above are exact/alias matched first to avoid prefix collisions.
 */
const KNOWN_FAMILY_MODEL_SPECS: Record<string, KnownModelSpecs> = {
  'qwen3.5': { contextWindow: 258048, maxTokens: 32768 },
  qwen3: { contextWindow: 40960, maxTokens: 8192 },
  'qwen2.5': { contextWindow: 131072, maxTokens: 8192 },
  llama3: { contextWindow: 131072, maxTokens: 4096 },
  'llama3.1': { contextWindow: 131072, maxTokens: 4096 },
  'llama3.2': { contextWindow: 131072, maxTokens: 4096 },
  'llama3.3': { contextWindow: 131072, maxTokens: 4096 },
  'deepseek-r1': { contextWindow: 65536, maxTokens: 8192 },
  'deepseek-v3': { contextWindow: 65536, maxTokens: 8192 },
  gemma2: { contextWindow: 8192, maxTokens: 4096 },
  gemma3: { contextWindow: 131072, maxTokens: 8192 },
  phi3: { contextWindow: 131072, maxTokens: 4096 },
  phi4: { contextWindow: 16384, maxTokens: 4096 },
  mistral: { contextWindow: 32768, maxTokens: 4096 },
  mixtral: { contextWindow: 32768, maxTokens: 4096 },
  codellama: { contextWindow: 16384, maxTokens: 4096 },
  'command-r': { contextWindow: 131072, maxTokens: 4096 },
};

function stripDateSuffix(value: string): string {
  return value
    .replace(/-(?:20\d{2})(?:0[1-9]|1[0-2])(?:[0-2]\d|3[01])$/, '')
    .replace(/-(?:20\d{2})-(?:0[1-9]|1[0-2])-(?:[0-2]\d|3[01])$/, '')
    .replace(/-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/, '');
}

function normalizeModelLookupKey(value: string): string {
  const withoutDisplayProvider =
    value.includes(':') && !value.includes('/') ? value.split(':').slice(1).join(':') : value;
  return withoutDisplayProvider
    .trim()
    .toLowerCase()
    .replace(/^~/, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9./:+-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

function addModelLookupVariants(keys: Set<string>, value: string): void {
  const normalized = normalizeModelLookupKey(value);
  if (!normalized) return;

  const variants = new Set<string>([normalized, stripDateSuffix(normalized)]);
  for (const variant of Array.from(variants)) {
    if (variant.endsWith(':free')) variants.add(variant.slice(0, -':free'.length));
    if (variant.includes('/')) variants.add(variant.split('/').slice(1).join('/'));
  }
  for (const variant of Array.from(variants)) {
    if (variant.includes('/')) {
      const bare = variant.split('/').slice(1).join('/');
      variants.add(stripDateSuffix(bare));
      if (bare.endsWith(':free')) variants.add(bare.slice(0, -':free'.length));
    }
  }
  for (const variant of variants) {
    if (variant) keys.add(variant);
  }
}

function buildKnownModelSpecMap(): Map<string, KnownModelSpecs> {
  const specsByKey = new Map<string, KnownModelSpecs>();
  for (const entry of RECENT_OPENROUTER_MODEL_SPECS) {
    for (const alias of entry.aliases) {
      const keys = new Set<string>();
      addModelLookupVariants(keys, alias);
      for (const key of keys) {
        specsByKey.set(key, {
          contextWindow: entry.contextWindow,
          maxTokens: entry.maxTokens,
          ...(entry.input ? { input: entry.input } : {}),
        });
      }
    }
  }
  return specsByKey;
}

const KNOWN_MODEL_SPEC_MAP = buildKnownModelSpecMap();

function lookupModelSpecs(modelId: string): KnownModelSpecs | undefined {
  const exactKeys = new Set<string>();
  addModelLookupVariants(exactKeys, modelId);
  for (const key of exactKeys) {
    const specs = KNOWN_MODEL_SPEC_MAP.get(key);
    if (specs) return specs;
  }

  const lower = normalizeModelLookupKey(modelId);
  // Match by prefix: "qwen3.5:0.8b" → "qwen3.5", "deepseek-r1-distill" → "deepseek-r1"
  for (const [key, specs] of Object.entries(KNOWN_FAMILY_MODEL_SPECS)) {
    if (lower === key || lower.startsWith(key + ':') || lower.startsWith(key + '-')) {
      return specs;
    }
  }
  return undefined;
}

export function resolveKnownModelSpecs(modelId: string): KnownModelSpecs | undefined {
  return lookupModelSpecs(modelId);
}

function lookupModelSpecsForModel(
  model: Pick<Model<Api>, 'id' | 'name'>,
  requestedModelString?: string
): KnownModelSpecs | undefined {
  const candidates = [requestedModelString, model.id, model.name].filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0
  );
  for (const candidate of candidates) {
    const specs = lookupModelSpecs(candidate);
    if (specs) return specs;
  }
  return undefined;
}

const VISION_MODEL_PATTERN = /\b(vl|vision|image|omni|visual|image-gen)\b/i;

export function buildSyntheticPiModel(
  modelId: string,
  provider: string,
  protocol: string,
  baseUrl?: string,
  apiOverride?: string,
  reasoning?: boolean,
  contextWindow?: number,
  maxTokens?: number,
  input?: ('text' | 'image')[]
): Model<Api> {
  const api = apiOverride || inferPiApi(protocol);
  const autoReasoning = reasoning ?? REASONING_MODEL_PATTERN.test(modelId);
  const knownSpecs = lookupModelSpecs(modelId);
  const modelInput =
    input ??
    knownSpecs?.input ??
    (VISION_MODEL_PATTERN.test(modelId) ? ['text', 'image'] : ['text']);
  return {
    id: modelId,
    name: modelId,
    api,
    provider,
    baseUrl: baseUrl || '',
    reasoning: autoReasoning,
    input: modelInput,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contextWindow ?? knownSpecs?.contextWindow ?? 128000,
    maxTokens: maxTokens ?? knownSpecs?.maxTokens ?? 16384,
  } as Model<Api>;
}

export function resolveSyntheticPiModelFallback(
  input: SyntheticPiModelFallbackInput
): SyntheticPiModelFallback {
  const rawModel = input.rawModel?.trim() || '';
  const modelString = input.resolvedModelString.trim();
  const parts = modelString.split('/');
  const parsedProvider = parts.length >= 2 ? parts[0] : '';
  const strippedModelId = parts.length >= 2 ? parts.slice(1).join('/') : modelString;
  const baseUrl = input.baseUrl?.trim() || '';
  const preservesExplicitPrefixedId =
    rawModel.includes('/') &&
    (input.rawProvider === 'openrouter' ||
      input.rawProvider === 'custom' ||
      input.rawProvider === 'lingerai' ||
      input.rawProvider === 'deepseek' ||
      (input.rawProvider === 'openai' && !!baseUrl && !isOfficialOpenAIBaseUrl(baseUrl))) &&
    input.routeProtocol === 'openai';

  if (input.rawProvider === 'openrouter') {
    return {
      provider: 'openrouter',
      modelId: preservesExplicitPrefixedId ? modelString : strippedModelId,
    };
  }

  const fallbackProvider =
    input.rawProvider === 'custom' || input.rawProvider === 'ollama' || input.rawProvider === 'lingerai' || input.rawProvider === 'deepseek'
      ? input.routeProtocol || 'anthropic'
      : parsedProvider || input.rawProvider || input.routeProtocol || 'anthropic';

  return {
    provider: preservesExplicitPrefixedId ? parsedProvider || fallbackProvider : fallbackProvider,
    modelId: preservesExplicitPrefixedId ? modelString : strippedModelId,
  };
}

export function resolvePiModelString(input: PiModelStringInput): string {
  const model = input.model?.trim();
  if (!model) {
    return input.defaultModel || 'anthropic/claude-sonnet-4-6';
  }
  if (model.includes('/')) {
    return model;
  }
  const provider = input.provider || 'anthropic';
  const protocol = input.customProtocol || provider;
  return `${protocol}/${model}`;
}

function addLookupCandidate(
  candidates: PiModelLookupCandidate[],
  seen: Set<string>,
  provider: string | undefined,
  model: string | undefined
): void {
  const normalizedProvider = provider?.trim() || '';
  const normalizedModel = model?.trim() || '';
  if (
    !normalizedProvider ||
    !normalizedModel ||
    INVALID_REGISTRY_PROVIDERS.has(normalizedProvider)
  ) {
    return;
  }

  const key = `${normalizedProvider}\u0000${normalizedModel}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  candidates.push({ provider: normalizedProvider, model: normalizedModel });
}

export function buildPiModelLookupCandidates(
  modelString: string,
  options: Pick<PiModelLookupOptions, 'configProvider' | 'rawProvider'> = {}
): PiModelLookupCandidate[] {
  const keyProvider =
    options.configProvider === 'custom' ? 'anthropic' : options.configProvider || 'anthropic';
  const rawProvider = options.rawProvider?.trim() || '';
  const trimmedModel = modelString.trim();
  const parts = trimmedModel.split('/');
  const seen = new Set<string>();
  const candidates: PiModelLookupCandidate[] = [];

  if (parts.length >= 2) {
    const parsedProvider = parts[0];
    const parsedModelId = parts.slice(1).join('/');

    if (rawProvider && rawProvider !== keyProvider && rawProvider !== parsedProvider) {
      addLookupCandidate(candidates, seen, rawProvider, trimmedModel);
    }
    if (keyProvider !== parsedProvider) {
      addLookupCandidate(candidates, seen, keyProvider, trimmedModel);
    }
    addLookupCandidate(candidates, seen, parsedProvider, parsedModelId);
    for (const fallbackProvider of COMMON_FALLBACK_PROVIDERS) {
      addLookupCandidate(candidates, seen, fallbackProvider, parsedModelId);
    }
    return candidates;
  }

  addLookupCandidate(candidates, seen, keyProvider, trimmedModel);
  for (const fallbackProvider of COMMON_FALLBACK_PROVIDERS) {
    addLookupCandidate(candidates, seen, fallbackProvider, trimmedModel);
  }
  return candidates;
}

export function applyPiModelRuntimeOverrides(
  model: Model<Api>,
  options: PiModelLookupOptions = {}
): Model<Api> {
  let nextModel = model;
  const knownSpecs = lookupModelSpecsForModel(nextModel, options.requestedModelString);
  if (knownSpecs) {
    nextModel = {
      ...nextModel,
      contextWindow: knownSpecs.contextWindow,
      maxTokens: knownSpecs.maxTokens,
    } as typeof nextModel;
  }

  const isCustomProvider = options.rawProvider === 'custom' || options.configProvider === 'custom';
  const isCustomOpenAICompatibleProvider = isCustomProvider || options.rawProvider === 'lingerai' || options.rawProvider === 'deepseek';
  const shouldHonorConfiguredBaseUrl =
    options.rawProvider === 'openai' || isCustomOpenAICompatibleProvider;
  const modelHasBaseUrl = Boolean(nextModel.baseUrl);

  if (options.customBaseUrl && (shouldHonorConfiguredBaseUrl || !modelHasBaseUrl)) {
    nextModel = { ...nextModel, baseUrl: options.customBaseUrl } as typeof nextModel;
  }

  const effectiveProvider = options.rawProvider || options.configProvider;
  if (
    options.customBaseUrl &&
    isCustomOpenAICompatibleProvider &&
    nextModel.api === 'openai-responses'
  ) {
    // Most custom OpenAI-compatible relays only implement chat/completions.
    nextModel = { ...nextModel, api: 'openai-completions' } as typeof nextModel;
  }
  if (effectiveProvider === 'openrouter' && nextModel.api !== 'openai-completions') {
    nextModel = { ...nextModel, api: 'openai-completions' } as typeof nextModel;
  }
  if (shouldDisableDeveloperRoleForEndpoint(nextModel, options)) {
    nextModel = {
      ...nextModel,
      compat: {
        ...(nextModel.compat || {}),
        supportsDeveloperRole: false,
        supportsStore: false,
      },
    } as typeof nextModel;
  }

  if (
    options.rawProvider === 'ollama' &&
    nextModel.reasoning &&
    nextModel.api === 'openai-completions'
  ) {
    const currentCompat = (nextModel.compat || {}) as Record<string, unknown>;
    const currentReasoningEffortMap = (
      currentCompat.reasoningEffortMap && typeof currentCompat.reasoningEffortMap === 'object'
        ? currentCompat.reasoningEffortMap
        : {}
    ) as Record<string, string>;
    nextModel = {
      ...nextModel,
      compat: {
        ...currentCompat,
        supportsReasoningEffort: true,
        reasoningEffortMap: {
          ...currentReasoningEffortMap,
          off: 'none',
        },
      },
    } as typeof nextModel;
  }

  // Handle custom provider with explicit protocol override
  if (isCustomProvider && options.customProtocol) {
    const targetApi = inferPiApi(options.customProtocol);
    if (nextModel.api !== targetApi) {
      nextModel = { ...nextModel, api: targetApi } as typeof nextModel;
    }
  }

  return nextModel;
}

export function resolvePiRegistryModel(
  modelString: string,
  options: PiModelLookupOptions = {}
): Model<Api> | undefined {
  for (const candidate of buildPiModelLookupCandidates(modelString, options)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = (getModel as (...args: unknown[]) => Model<Api> | undefined)(
      candidate.provider as PiRegistryProvider,
      candidate.model
    );
    if (model) {
      return applyPiModelRuntimeOverrides(model, {
        ...options,
        requestedModelString: modelString,
      });
    }
  }
  return undefined;
}
