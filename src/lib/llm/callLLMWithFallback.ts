/**
 * Centralized LLM API caller with automatic fallback chain
 *
 * All calls route through the Supabase `ai-completion` edge function.
 * Provider API keys are NEVER used in the browser.
 */

import { AiEngine } from '../../types';
import {
  getFallbackChain,
  isRetriableError,
  type ModelConfig,
} from './modelRegistry';

export interface LLMCallOptions {
  engine: AiEngine;
  messages: { role: string; content: string }[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: string };
  featureName?: string; // For logging/tracking
  userEmail?: string; // For token tracking
}

export interface LLMResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  modelUsed: string;
  provider: string;
}

/**
 * Call LLM with automatic fallback on retriable errors
 */
export async function callLLMWithFallback(
  options: LLMCallOptions
): Promise<LLMResponse> {
  const {
    engine,
    messages,
    temperature,
    maxTokens,
    responseFormat,
    featureName = 'unknown',
    userEmail,
  } = options;

  const fallbackChain = getFallbackChain(engine);
  const errors: Array<{ model: string; error: any }> = [];

  for (let i = 0; i < fallbackChain.length; i++) {
    const modelConfig = fallbackChain[i];
    const isLastAttempt = i === fallbackChain.length - 1;

    try {
      console.log(
        `[${featureName}] Attempting with ${modelConfig.provider}/${modelConfig.modelId} (attempt ${i + 1}/${fallbackChain.length})`
      );

      const response = await callModel(modelConfig, {
        messages,
        temperature: temperature ?? modelConfig.temperature,
        maxTokens: maxTokens ?? modelConfig.maxTokens,
        responseFormat,
      });

      // Success - track token usage if available
      if (response.usage && userEmail) {
        await trackTokenUsage({
          userEmail,
          modelUsed: modelConfig.modelId,
          provider: modelConfig.provider,
          usage: response.usage,
          featureName,
        }).catch((err) => {
          console.error('[Token Tracking] Failed to track usage:', err);
          // Don't block on tracking failure
        });
      }

      console.log(
        `[${featureName}] Success with ${modelConfig.provider}/${modelConfig.modelId}`
      );

      return {
        content: response.content,
        usage: response.usage,
        modelUsed: modelConfig.modelId,
        provider: modelConfig.provider,
      };
    } catch (error: any) {
      console.error(
        `[${featureName}] Error with ${modelConfig.provider}/${modelConfig.modelId}:`,
        error
      );

      errors.push({
        model: `${modelConfig.provider}/${modelConfig.modelId}`,
        error,
      });

      // If this is the last attempt or error is not retriable, throw
      if (isLastAttempt || !isRetriableError(error)) {
        const errorSummary = errors
          .map((e) => `${e.model}: ${e.error.message || e.error}`)
          .join('; ');

        throw new Error(
          `All models failed. Last error: ${error.message || error}. Full chain: ${errorSummary}`
        );
      }

      // Otherwise, continue to next model in fallback chain
      console.log(
        `[${featureName}] Retriable error detected, trying next model in fallback chain...`
      );
    }
  }

  // Should never reach here, but TypeScript needs it
  throw new Error('Fallback chain exhausted with no successful response');
}

/**
 * Call a specific model (no fallback) via the Supabase edge function only.
 */
async function callModel(
  modelConfig: ModelConfig,
  callOptions: {
    messages: { role: string; content: string }[];
    temperature: number;
    maxTokens: number;
    responseFormat?: { type: string };
  }
): Promise<{ content: string; usage?: any }> {
  const { provider, modelId } = modelConfig;
  const { messages, temperature, maxTokens, responseFormat } = callOptions;

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'Supabase is not configured. All LLM calls require the Supabase ai-completion edge function.'
    );
  }

  return await callViaSupabaseEdgeFunction({
    provider,
    modelId,
    messages,
    temperature,
    maxTokens,
    responseFormat,
  });
}

/**
 * Call via Supabase edge function
 */
async function callViaSupabaseEdgeFunction(params: {
  provider: string;
  modelId: string;
  messages: { role: string; content: string }[];
  temperature: number;
  maxTokens: number;
  responseFormat?: { type: string };
}): Promise<{ content: string; usage?: any }> {
  const { provider, modelId, messages, temperature, maxTokens, responseFormat } = params;

  // Get user session for auth
  const { supabase } = await import('../../services/supabaseClient');
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const apiUrl = `${supabaseUrl}/functions/v1/ai-completion`;

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session?.access_token || import.meta.env.VITE_SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({
      provider,
      model: modelId,
      messages,
      temperature,
      max_tokens: maxTokens,
      response_format: responseFormat,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Edge function error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  // Standardize response format
  if (provider === 'anthropic') {
    return {
      content: data.content?.[0]?.text || data.content || '',
      usage: data.usage
        ? {
            promptTokens: data.usage.input_tokens,
            completionTokens: data.usage.output_tokens,
            totalTokens: data.usage.input_tokens + data.usage.output_tokens,
          }
        : undefined,
    };
  } else {
    // OpenAI format
    return {
      content: data.choices?.[0]?.message?.content || '',
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
    };
  }
}

/**
 * Track token usage via Supabase edge function
 */
async function trackTokenUsage(params: {
  userEmail: string;
  modelUsed: string;
  provider: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  featureName: string;
}): Promise<void> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn('[Token Tracking] Supabase not configured, skipping tracking');
    return;
  }

  const { supabase } = await import('../../services/supabaseClient');
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const apiUrl = `${supabaseUrl}/functions/v1/track-tokens`;

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session?.access_token || supabaseAnonKey}`,
    },
    body: JSON.stringify({
      user_email: params.userEmail,
      model_used: params.modelUsed,
      provider: params.provider,
      input_tokens: params.usage.promptTokens,
      output_tokens: params.usage.completionTokens,
      total_tokens: params.usage.totalTokens,
      operation_type: params.featureName,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Token Tracking] Error: ${errorText}`);
  }
}