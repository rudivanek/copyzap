/**
 * Canonical LLM Model Registry for CopyZap
 *
 * This registry defines:
 * - Available AI engines exposed to users (Claude, OpenAI)
 * - Internal model IDs and provider configurations
 * - Fallback chains for reliability
 * - Model presets (temperature, top_p, max_tokens)
 *
 * DeepSeek is an internal fallback only - never shown in UI.
 */

export type Provider = 'anthropic' | 'openai' | 'deepseek';

export type AiEngine = 'claude' | 'openai';

export interface ModelConfig {
  provider: Provider;
  modelId: string;
  label: string;
  description: string;
  temperature: number;
  top_p?: number;
  maxTokens: number;
}

export interface EngineDefinition {
  engine: AiEngine;
  label: string;
  description: string;
  helperText: string;
  primary: ModelConfig;
  fallbackChain: ModelConfig[];
}

/**
 * Model configurations by provider
 */
const MODELS: Record<string, ModelConfig> = {
  // Claude - Pinned to 4.6 for stability
  'claude-sonnet-4-6': {
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-20250514',
    label: 'Claude Sonnet 4.6',
    description: 'Best for persuasive, long-form, and premium copy',
    temperature: 0.3,
    top_p: 1.0,
    maxTokens: 64000,
  },

  // OpenAI - Stable GPT-4o
  'gpt-4o': {
    provider: 'openai',
    modelId: 'gpt-4o',
    label: 'GPT-4o',
    description: 'Best for structured and precise output',
    temperature: 0.45,
    top_p: 0.9,
    maxTokens: 16000,
  },

  // DeepSeek - Internal fallback only
  'deepseek-chat': {
    provider: 'deepseek',
    modelId: 'deepseek-chat',
    label: 'DeepSeek V3',
    description: 'Internal fallback model',
    temperature: 0.65,
    top_p: 0.9,
    maxTokens: 8192,
  },
};

/**
 * Engine definitions exposed to UI
 */
export const ENGINES: Record<AiEngine, EngineDefinition> = {
  claude: {
    engine: 'claude',
    label: 'Claude',
    description: 'Anthropic Claude Sonnet 4.6',
    helperText: 'Best for persuasive, long-form, and premium copy.',
    primary: MODELS['claude-sonnet-4-6'],
    fallbackChain: [
      MODELS['claude-sonnet-4-6'],
      MODELS['gpt-4o'],
      MODELS['deepseek-chat'],
    ],
  },

  openai: {
    engine: 'openai',
    label: 'OpenAI',
    description: 'OpenAI GPT-4o',
    helperText: 'Best for structured and precise output.',
    primary: MODELS['gpt-4o'],
    fallbackChain: [
      MODELS['gpt-4o'],
      MODELS['claude-sonnet-4-6'],
      MODELS['deepseek-chat'],
    ],
  },
};

/**
 * Default engine for all new sessions
 */
export const DEFAULT_ENGINE: AiEngine = 'claude';

/**
 * Get engine configuration
 */
export function getEngineConfig(engine: AiEngine): EngineDefinition {
  return ENGINES[engine];
}

/**
 * Get model configuration by internal key
 */
export function getModelConfig(key: string): ModelConfig | undefined {
  return MODELS[key];
}

/**
 * Get primary model config for an engine
 */
export function getPrimaryModel(engine: AiEngine): ModelConfig {
  return ENGINES[engine].primary;
}

/**
 * Get fallback chain for an engine
 */
export function getFallbackChain(engine: AiEngine): ModelConfig[] {
  return ENGINES[engine].fallbackChain;
}

/**
 * Get all engines available in UI
 */
export function getAvailableEngines(): EngineDefinition[] {
  return Object.values(ENGINES);
}

/**
 * Map legacy model strings to new engine selection
 * Used for migration of persisted user settings
 */
export function migrateModelToEngine(legacyModel: string): AiEngine {
  const modelLower = legacyModel.toLowerCase();

  // Claude variants
  if (modelLower.includes('claude') || modelLower.includes('anthropic')) {
    return 'claude';
  }

  // OpenAI variants (including deprecated ones)
  if (
    modelLower.includes('gpt') ||
    modelLower.includes('openai') ||
    modelLower.includes('chatgpt')
  ) {
    return 'openai';
  }

  // DeepSeek or unknown -> default to Claude
  return DEFAULT_ENGINE;
}

/**
 * Check if a provider is available (API key exists)
 */
export function isProviderAvailable(provider: Provider): boolean {
  switch (provider) {
    case 'anthropic':
      return !!import.meta.env.VITE_ANTHROPIC_API_KEY;
    case 'openai':
      return !!import.meta.env.VITE_OPENAI_API_KEY;
    case 'deepseek':
      return !!import.meta.env.VITE_DEEPSEEK_API_KEY;
    default:
      return false;
  }
}

/**
 * Check if an engine is available
 */
export function isEngineAvailable(engine: AiEngine): boolean {
  const config = getEngineConfig(engine);
  return isProviderAvailable(config.primary.provider);
}

/**
 * Get API configuration for a provider
 */
export function getProviderApiConfig(provider: Provider): {
  apiKey: string;
  baseUrl: string;
  headers: HeadersInit;
} {
  switch (provider) {
    case 'anthropic': {
      const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error('Claude API key not available. Please add VITE_ANTHROPIC_API_KEY to your .env file.');
      }
      return {
        apiKey,
        baseUrl: 'https://api.anthropic.com/v1',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      };
    }

    case 'openai': {
      const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OpenAI API key not available. Please add VITE_OPENAI_API_KEY to your .env file.');
      }
      return {
        apiKey,
        baseUrl: 'https://api.openai.com/v1',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
      };
    }

    case 'deepseek': {
      const apiKey = import.meta.env.VITE_DEEPSEEK_API_KEY;
      if (!apiKey) {
        throw new Error('DeepSeek API key not available. Please add VITE_DEEPSEEK_API_KEY to your .env file.');
      }
      return {
        apiKey,
        baseUrl: 'https://api.deepseek.com/v1',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
      };
    }

    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Error codes that should trigger fallback
 */
export const RETRIABLE_ERROR_CODES = [
  401, // Unauthorized
  403, // Forbidden
  429, // Rate limit
  503, // Service unavailable
  529, // Overload
];

/**
 * Check if an error should trigger fallback
 */
export function isRetriableError(error: any): boolean {
  // Network errors
  if (error.name === 'NetworkError' || error.message?.includes('network')) {
    return true;
  }

  // HTTP status codes
  if (error.status && RETRIABLE_ERROR_CODES.includes(error.status)) {
    return true;
  }

  // Timeout errors
  if (error.name === 'TimeoutError' || error.message?.includes('timeout')) {
    return true;
  }

  return false;
}
