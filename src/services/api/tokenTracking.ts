/**
 * Bulletproof token tracking functionality (Phase 3: DB-Driven Pricing)
 */
import { User } from '../../types';
import { calculateTokenCost } from './utils';
import {
  calculateCostFromDbPricing,
  calculateCostFromDbPricingAverage
} from '../../utils/pricingResolver';

// Store failed tracking attempts for retry
let failedTrackingQueue: Array<{
  tracking_id: string; // Unique identifier for this tracking attempt
  user_id: string;
  operation_type: string;
  model: string;
  tokens_used: number;
  cost_usd: number;
  session_id?: string;
  attempts: number;
  lastAttempt: number;
  // Phase 3: Token breakdown
  input_tokens_used?: number;
  output_tokens_used?: number;
  reasoning_tokens_used?: number;
  cost_source?: string;
  pricing_row_id?: string | null;
}> = [];

/**
 * Track token usage with bulletproof reliability (Phase 3: Token Breakdown Support)
 * @param user - The user who consumed tokens
 * @param tokenUsage - Total number of tokens consumed
 * @param model - AI model used
 * @param operationType - Type of operation performed
 * @param sessionId - Optional session ID to group related API calls
 * @param retryCount - Current retry attempt (internal use)
 * @param trackingId - Unique tracking ID (internal use)
 * @param tokenBreakdown - Optional token breakdown (input, output, reasoning)
 */
export async function trackTokenUsage(
  user: User,
  tokenUsage: number,
  model: string,
  operationType: string,
  sessionId?: string,
  retryCount: number = 0,
  trackingId?: string,
  tokenBreakdown?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
  }
): Promise<void> {
  // session_id is preferred but not required for lightweight operations like suggestions
  if (!sessionId) {
    console.warn('⚠️ Token tracking skipped: no session_id (operation:', operationType, ')');
    return;
  }

  // Validate other inputs
  if (!user?.id || !tokenUsage || tokenUsage <= 0 || !model || !operationType) {
    console.error('Invalid token tracking parameters:', {
      userId: user?.id,
      tokenUsage,
      model,
      operationType,
      sessionId
    });
    throw new Error('Invalid parameters for token tracking');
  }

  // Generate unique tracking ID if not provided (for first call)
  const uniqueTrackingId = trackingId || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // =========================================================================
  // PHASE 3: DB-DRIVEN COST CALCULATION WITH FALLBACK
  // =========================================================================
  let cost = 0;
  let costSource = 'legacy';
  let pricingRowId: string | null = null;

  // Fixed-cost operations (Firecrawl, etc.)
  if (operationType === 'url-analysis-firecrawl' || operationType.includes('firecrawl')) {
    cost = 0.015; // Fixed cost for Firecrawl scraping
    costSource = 'fixed';
    console.log(`[Phase 3] Using fixed cost for ${operationType}: $${cost}`);
  }
  // Try DB pricing if token breakdown is available
  else if (tokenBreakdown?.inputTokens !== undefined && tokenBreakdown?.outputTokens !== undefined) {
    try {
      const dbPricing = await calculateCostFromDbPricing(
        model,
        tokenBreakdown.inputTokens,
        tokenBreakdown.outputTokens,
        tokenBreakdown.reasoningTokens || 0,
        'standard' // TODO: Get from user's subscription tier
      );

      if (dbPricing.cost_source) {
        // DB pricing found and used
        cost = dbPricing.cost_usd;
        costSource = dbPricing.cost_source;
        pricingRowId = dbPricing.pricing_row_id;
        console.log(`[Phase 3] Using DB pricing (${costSource}) for ${model}: $${cost.toFixed(6)}`);
      } else {
        // No DB pricing found, fall back to legacy
        cost = calculateTokenCost(tokenUsage, model);
        costSource = 'legacy';
        console.warn(`[Phase 3] No DB pricing found for ${model}, using legacy: $${cost.toFixed(6)}`);
      }
    } catch (err) {
      // DB lookup failed, fall back to legacy
      console.error(`[Phase 3] DB pricing lookup failed for ${model}, using legacy fallback:`, err);
      cost = calculateTokenCost(tokenUsage, model);
      costSource = 'legacy';
    }
  }
  // Try DB pricing with average (no token breakdown available)
  else {
    try {
      const dbPricing = await calculateCostFromDbPricingAverage(
        model,
        tokenUsage,
        'standard'
      );

      if (dbPricing.cost_source) {
        cost = dbPricing.cost_usd;
        costSource = dbPricing.cost_source;
        pricingRowId = dbPricing.pricing_row_id;
        console.log(`[Phase 3] Using DB pricing average (${costSource}) for ${model}: $${cost.toFixed(6)}`);
      } else {
        // No DB pricing found, fall back to legacy
        cost = calculateTokenCost(tokenUsage, model);
        costSource = 'legacy';
        console.warn(`[Phase 3] No DB pricing found for ${model}, using legacy: $${cost.toFixed(6)}`);
      }
    } catch (err) {
      console.error(`[Phase 3] DB pricing lookup failed for ${model}, using legacy fallback:`, err);
      cost = calculateTokenCost(tokenUsage, model);
      costSource = 'legacy';
    }
  }

  // STABILIZATION: Final safety guard against NaN/invalid cost
  if (!Number.isFinite(cost) || cost < 0) {
    console.error(`[TokenTracking] Invalid cost calculated: ${cost}, using 0`);
    cost = 0;
    costSource = 'error_fallback';
  }

  // Phase 4B-2: tokens_used column removed from database
  const trackingData: any = {
    user_id: user.id,
    operation_type: operationType,
    model,
    // tokens_used removed (Phase 4B-2) - edge function ignores it for backwards compatibility
    cost_usd: cost,
    cost_source: costSource,
    ...(sessionId && { session_id: sessionId }),
    ...(pricingRowId && { pricing_row_id: pricingRowId })
  };

  // Add token breakdown if available
  if (tokenBreakdown?.inputTokens !== undefined) {
    trackingData.input_tokens_used = tokenBreakdown.inputTokens;
  }
  if (tokenBreakdown?.outputTokens !== undefined) {
    trackingData.output_tokens_used = tokenBreakdown.outputTokens;
  }
  if (tokenBreakdown?.reasoningTokens !== undefined && tokenBreakdown.reasoningTokens > 0) {
    trackingData.reasoning_tokens_used = tokenBreakdown.reasoningTokens;
  }

  console.log(`📊 Tracking token usage [${uniqueTrackingId}]: ${tokenUsage} tokens for ${operationType} (${model})${sessionId ? ` [Session: ${sessionId}]` : ' [NO SESSION ID]'}`);

  if (!sessionId) {
    console.warn('⚠️ WARNING: Token tracking called without session ID!', {
      operationType,
      model,
      userId: user.id
    });
  }

  try {
    // Call Edge Function for token tracking
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error('Supabase configuration missing');
    }

    const response = await fetch(`${supabaseUrl}/functions/v1/track-tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify(trackingData)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Token tracking failed: ${response.status} - ${errorData.error || 'Unknown error'}`);
    }

    const result = await response.json();
    console.log(`✅ Token usage tracked successfully [${uniqueTrackingId}]:`, result);

    // Remove from failed queue if it was there (by tracking ID, not by data match)
    failedTrackingQueue = failedTrackingQueue.filter(
      item => item.tracking_id !== uniqueTrackingId
    );

  } catch (error: any) {
    console.error(`❌ Token tracking failed [${uniqueTrackingId}] (attempt ${retryCount + 1}):`, error);

    // Add to failed queue for retry if not already there (by tracking ID)
    const existingIndex = failedTrackingQueue.findIndex(
      item => item.tracking_id === uniqueTrackingId
    );

    if (existingIndex === -1) {
      failedTrackingQueue.push({
        tracking_id: uniqueTrackingId,
        ...trackingData,
        tokens_used: tokenUsage, // Keep for retry queue (edge function ignores)
        session_id: sessionId,
        attempts: 1,
        lastAttempt: Date.now()
      });
    } else {
      failedTrackingQueue[existingIndex].attempts++;
      failedTrackingQueue[existingIndex].lastAttempt = Date.now();
    }

    // Retry logic with exponential backoff
    if (retryCount < 3) {
      const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
      console.log(`⏰ Retrying token tracking [${uniqueTrackingId}] in ${delay}ms...`);

      setTimeout(async () => {
        try {
          await trackTokenUsage(user, tokenUsage, model, operationType, sessionId, retryCount + 1, uniqueTrackingId);
        } catch (retryError) {
          console.error(`❌ Token tracking retry ${retryCount + 1} failed [${uniqueTrackingId}]:`, retryError);
        }
      }, delay);
    } else {
      console.error(`❌ Token tracking failed after ${retryCount + 1} attempts [${uniqueTrackingId}]. Added to queue for background retry.`);
    }

    // CRITICAL: Make this mandatory - throw error if tracking fails completely
    if (retryCount >= 3) {
      throw new Error(`Failed to track token usage after ${retryCount + 1} attempts. API call aborted to prevent untracked usage.`);
    }
  }
}

/**
 * Retry failed tracking attempts from queue
 * Call this periodically (e.g., every 5 minutes)
 */
export async function retryFailedTracking(): Promise<void> {
  if (failedTrackingQueue.length === 0) return;

  console.log(`🔄 Retrying ${failedTrackingQueue.length} failed tracking attempts...`);

  const currentTime = Date.now();
  const itemsToRetry = failedTrackingQueue.filter(
    item => item.attempts < 5 && (currentTime - item.lastAttempt) > 60000 // Wait 1 minute between retries
  );

  for (const item of itemsToRetry) {
    try {
      await trackTokenUsage(
        { id: item.user_id } as User,
        item.tokens_used,
        item.model,
        item.operation_type,
        item.session_id,
        item.attempts,
        item.tracking_id
      );

      // Remove successful retry from queue
      failedTrackingQueue = failedTrackingQueue.filter(
        queueItem => queueItem.tracking_id !== item.tracking_id
      );

    } catch (error) {
      console.error('Background retry failed for token tracking:', error);
    }
  }

  // Remove items that have failed too many times (over 5 attempts)
  const removedItems = failedTrackingQueue.filter(item => item.attempts >= 5);
  if (removedItems.length > 0) {
    console.warn(`⚠️ Removing ${removedItems.length} token tracking attempts that failed over 5 times`);
    failedTrackingQueue = failedTrackingQueue.filter(item => item.attempts < 5);
  }
}

/**
 * Get failed tracking queue status (for admin monitoring)
 */
export function getTrackingQueueStatus(): {
  queueLength: number;
  oldestFailure: number | null;
  totalFailedTokens: number;
} {
  const totalFailedTokens = failedTrackingQueue.reduce((sum, item) => sum + item.tokens_used, 0);
  const oldestFailure = failedTrackingQueue.length > 0 
    ? Math.min(...failedTrackingQueue.map(item => item.lastAttempt))
    : null;

  return {
    queueLength: failedTrackingQueue.length,
    oldestFailure,
    totalFailedTokens
  };
}

/**
 * Estimate token count for text (rough approximation)
 * @param text - Text to estimate tokens for
 * @returns Estimated token count
 */
export function estimateTokenCount(text: string): number {
  // Rough approximation: 1 token ≈ 4 characters for English
  // This is just for estimation, actual tokens are returned by API
  return Math.ceil(text.length / 4);
}

/**
 * Extract token breakdown from API response usage object (Phase 3)
 *
 * Converts standard LLM API usage objects to our token breakdown format.
 * Supports OpenAI, Anthropic, and custom formats.
 *
 * @param usage - Usage object from API response
 * @returns Token breakdown or undefined if not available
 */
export function extractTokenBreakdown(usage: any): {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
} | undefined {
  if (!usage) return undefined;

  // Check for standard OpenAI format (prompt_tokens, completion_tokens)
  if (usage.prompt_tokens !== undefined && usage.completion_tokens !== undefined) {
    return {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      reasoningTokens: usage.reasoning_tokens || 0
    };
  }

  // Check for Anthropic format (input_tokens, output_tokens)
  if (usage.input_tokens !== undefined && usage.output_tokens !== undefined) {
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens
    };
  }

  // No breakdown available
  return undefined;
}