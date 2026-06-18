export type ImageInputMode = 'auto' | 'enabled' | 'disabled';
export type CapabilityMode = 'auto' | 'enabled' | 'disabled';
export type ModelCapabilityId =
  | 'textInput'
  | 'imageInput'
  | 'audioInput'
  | 'videoInput'
  | 'fileInput'
  | 'tools'
  | 'reasoning'
  | 'embedding'
  | 'rerank'
  | 'imageOutput'
  | 'audioOutput';

export type ModelCapabilityModes = Partial<Record<ModelCapabilityId, CapabilityMode>>;
export type ResolvedModelCapabilities = Record<ModelCapabilityId, boolean>;

export const VISION_MODEL_PATTERN = /\b(vl|vision|image|omni|visual|image-gen)\b/i;
const AUDIO_MODEL_PATTERN = /\b(audio|speech|voice|tts|transcrib|whisper)\b/i;
const VIDEO_MODEL_PATTERN = /\b(video|vision-video)\b/i;
const FILE_MODEL_PATTERN = /\b(file|document|pdf)\b/i;
const TOOL_MODEL_PATTERN = /\b(tool|function|agent|computer-use)\b/i;
const REASONING_MODEL_PATTERN = /\b(r1|reason|reasoning|think|thinking|o[1-9]|qwen3)\b/i;
const EMBEDDING_MODEL_PATTERN = /\b(embed|embedding|text-embedding)\b/i;
const RERANK_MODEL_PATTERN = /\b(rerank|reranker|ranker)\b/i;

export function normalizeImageInputMode(value: unknown): ImageInputMode {
  return value === 'enabled' || value === 'disabled' ? value : 'auto';
}

export function normalizeCapabilityMode(value: unknown): CapabilityMode {
  return value === 'enabled' || value === 'disabled' ? value : 'auto';
}

export function normalizeModelCapabilityModes(value: unknown): ModelCapabilityModes | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const result: ModelCapabilityModes = {};
  for (const capability of MODEL_CAPABILITIES) {
    const mode = normalizeCapabilityMode((value as Record<string, unknown>)[capability.id]);
    if (mode !== 'auto') {
      result[capability.id] = mode;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function inferAutoImageInputMode(modelId: string): Exclude<ImageInputMode, 'auto'> {
  return VISION_MODEL_PATTERN.test(modelId) ? 'enabled' : 'disabled';
}

export function resolveImageInputMode(mode: ImageInputMode | undefined, modelId: string): Exclude<ImageInputMode, 'auto'> {
  return mode === 'enabled' || mode === 'disabled' ? mode : inferAutoImageInputMode(modelId);
}

function inferCapability(capability: ModelCapabilityId, modelId: string): boolean {
  switch (capability) {
    case 'textInput':
      return !EMBEDDING_MODEL_PATTERN.test(modelId) && !RERANK_MODEL_PATTERN.test(modelId);
    case 'imageInput':
      return VISION_MODEL_PATTERN.test(modelId);
    case 'audioInput':
      return AUDIO_MODEL_PATTERN.test(modelId);
    case 'videoInput':
      return VIDEO_MODEL_PATTERN.test(modelId);
    case 'fileInput':
      return FILE_MODEL_PATTERN.test(modelId);
    case 'tools':
      return TOOL_MODEL_PATTERN.test(modelId);
    case 'reasoning':
      return REASONING_MODEL_PATTERN.test(modelId);
    case 'embedding':
      return EMBEDDING_MODEL_PATTERN.test(modelId);
    case 'rerank':
      return RERANK_MODEL_PATTERN.test(modelId);
    case 'imageOutput':
      return /\b(image-gen|image|dall-e|flux|sdxl|stable-diffusion)\b/i.test(modelId);
    case 'audioOutput':
      return /\b(audio|speech|voice|tts)\b/i.test(modelId);
  }
}

export function resolveModelCapabilities(
  modes: ModelCapabilityModes | undefined,
  modelId: string
): ResolvedModelCapabilities {
  const resolved = {} as ResolvedModelCapabilities;
  for (const capability of MODEL_CAPABILITIES) {
    const mode = modes?.[capability.id];
    resolved[capability.id] = mode === 'enabled' ? true : mode === 'disabled' ? false : inferCapability(capability.id, modelId);
  }
  return resolved;
}

export const MODEL_CAPABILITIES: Array<{
  id: ModelCapabilityId;
  group: 'input' | 'feature' | 'output';
  labelKey: string;
}> = [
  { id: 'textInput', group: 'input', labelKey: 'api.capabilityText' },
  { id: 'imageInput', group: 'input', labelKey: 'api.capabilityVision' },
  { id: 'audioInput', group: 'input', labelKey: 'api.capabilityAudioInput' },
  { id: 'videoInput', group: 'input', labelKey: 'api.capabilityVideoInput' },
  { id: 'fileInput', group: 'input', labelKey: 'api.capabilityFileInput' },
  { id: 'reasoning', group: 'feature', labelKey: 'api.capabilityReasoning' },
  { id: 'tools', group: 'feature', labelKey: 'api.capabilityTools' },
  { id: 'embedding', group: 'feature', labelKey: 'api.capabilityEmbedding' },
  { id: 'rerank', group: 'feature', labelKey: 'api.capabilityRerank' },
  { id: 'imageOutput', group: 'output', labelKey: 'api.capabilityImageOutput' },
  { id: 'audioOutput', group: 'output', labelKey: 'api.capabilityAudioOutput' },
];
